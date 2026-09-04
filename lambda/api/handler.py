"""MuBWeM status API Lambda.

Behind an API Gateway HTTP API, serving four routes from one function:

  GET /status                  authenticated (Cognito JWT authorizer) - every site
  GET /status/{siteId}         authenticated - one site, with full detail
  GET /public/status           unauthenticated - only sites with isPublic = true
  GET /public/status/{siteId}  unauthenticated - one site, only if isPublic

The list routes return everything the dashboard needs in one call, so the
frontend does no joining of its own. The two list responses have an identical
shape; the public one simply carries fewer sites. Same for the two detail
routes.

LIST RESPONSE (GET /status, GET /public/status)

{
  "generatedAt": "2026-08-27T09:15:00.000Z",   # ISO8601 UTC, server time
  "failureThreshold": 3,
  "summary": {
    "upCount":                      4,
    "downCount":                    1,
    "pausedCount":                  2,
    "totalMonitors":                7,
    "overallUptime24h":             99.31 | null,  # weighted, non-paused sites
    "mtbfSeconds":                  18042.5 | null,
    "timeSinceLastIncidentSeconds": 5120.0 | null,
    "incidentCount24h":             2
  },
  "sites": [
    {
      "siteId":              "example-home",
      "name":                "Example Home",
      "url":                 "https://example.com",
      "brand":               "Example Brand",
      "status":              "up" | "down" | "paused" | "unknown",
      "enabled":             true,
      "checkIntervalSec":    60,
      "lastCheckedAt":       "2026-08-27T09:14:03.221Z" | null,
      "lastResponseTimeMs":  312 | null,
      "consecutiveFailures": 0,
      "lastStatusChangeAt":  "2026-08-26T22:01:10.004Z" | null,
      "uptime24h":           99.86 | null,   # percent of checks up, 2dp
      "checks24h":           1437,           # sample size behind uptime24h
      "hourlyBuckets":       ["up", "up", "none", ...],   # exactly 24, oldest first
      "incidents": [                          # newest first, max 5
        {
          "startedAt":     "2026-08-26T21:58:10.004Z",
          "endedAt":       "2026-08-26T22:01:10.004Z" | null,   # null = ongoing
          "durationSec":   180 | null,
          "triggerReason": "3 consecutive failures - Timeout after 8s",
          "resolved":      true
        }
      ]
    }
  ]
}

`status` is "paused" whenever the site's `enabled` flag is off, which takes
precedence over whatever CurrentStatus last recorded - a site nobody is
checking is not "up", it is switched off. Paused sites are listed like any
other, counted in `pausedCount`, and excluded from `overallUptime24h`.

DETAIL RESPONSE (GET /status/{siteId}, GET /public/status/{siteId})

Everything a list entry carries, plus:

{
  "site": { ...one list entry..., "checks": [...], "incidents": [...max 50] },
  "generatedAt": "...",
  "failureThreshold": 3
}

On the *authenticated* detail route only, `site` additionally carries
`isPublic`, which the monitor page's edit form needs to pre-fill. The public
detail route never returns it.

where `checks` is the raw 24h time series for the response-time graph:

  [{"checkedAt": "...", "responseTimeMs": 312 | null, "isUp": true}, ...]

thinned by regular-interval sampling (never truncation) to at most 500 points,
so the graph still spans the whole window.

Sites are sorted down-first, then by name, so the dashboard can render in
order without sorting.

The per-site `isPublic` flag is never echoed back on either public route, nor
on either list route: there it decides which sites are returned and says
nothing else. The one exception is the authenticated detail route, noted
above, where the edit form needs it. A private site and a site that does not
exist are indistinguishable on the public detail route - both are the same
404, with the same body.

`checkIntervalSec` is deliberately *not* treated that way. It is returned on
every entry from every route, including both public ones. It was once gated
to the authenticated detail route alongside isPublic, which was a mistake by
association: isPublic is gated because it governs visibility, while
checkIntervalSec is a check frequency that governs nothing and reveals
nothing a caller could not infer from watching the status change. The
dashboard needs it per site to draw an honest countdown ring.
"""

import json
import logging
import math
import os
import urllib.parse
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SITES_TABLE = os.environ["SITES_TABLE"]
UPTIME_CHECKS_TABLE = os.environ["UPTIME_CHECKS_TABLE"]
CURRENT_STATUS_TABLE = os.environ["CURRENT_STATUS_TABLE"]
INCIDENTS_TABLE = os.environ["INCIDENTS_TABLE"]

FAILURE_THRESHOLD = int(os.environ.get("FAILURE_THRESHOLD", "3"))
INCIDENTS_PER_SITE = 5
# The detail page shows a real history rather than a teaser.
INCIDENTS_DETAIL_LIMIT = 50
UPTIME_WINDOW_HOURS = 24
HOURLY_BUCKETS = 24
# 24h at a 1-minute cadence is ~1440 rows; cap the paging so one wedged site
# cannot stall the whole response.
MAX_CHECK_PAGES = 4
# Enough points for a smooth line at 1440 samples without shipping every row.
MAX_DETAIL_POINTS = 500

# Route paths as API Gateway reports them in routeKey. The two private ones
# are the only paths that ever unlock the full site list.
PRIVATE_PATH = "/status"
PRIVATE_DETAIL_PATH = "/status/{siteId}"
PUBLIC_PATH = "/public/status"
PUBLIC_DETAIL_PATH = "/public/status/{siteId}"

_dynamodb = boto3.resource(
    "dynamodb", config=Config(retries={"max_attempts": 3, "mode": "standard"})
)
sites_table = _dynamodb.Table(SITES_TABLE)
checks_table = _dynamodb.Table(UPTIME_CHECKS_TABLE)
status_table = _dynamodb.Table(CURRENT_STATUS_TABLE)
incidents_table = _dynamodb.Table(INCIDENTS_TABLE)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _parse_iso(value):
    """Parse one of our own ISO8601 timestamps, or None if it is not one.

    Only ever used for arithmetic (bucketing, MTBF), never for ordering -
    ordering is done on the raw strings, which sort lexicographically because
    the format is fixed-width UTC.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        pass
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def _plain(value):
    """Convert DynamoDB Decimals to JSON-friendly ints/floats."""
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


def _scan_all(table):
    items = []
    kwargs = {}
    while True:
        page = table.scan(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return items


def _is_paused(site):
    """A site nobody is checking. Mirrors the checker's own default exactly:
    load_enabled_sites() reads `enabled` with a default of True, so a row that
    never mentions the flag is running, not paused."""
    return not site.get("enabled", True)


def recent_incidents(site_id, limit=INCIDENTS_PER_SITE):
    response = incidents_table.query(
        KeyConditionExpression=Key("siteId").eq(site_id),
        ScanIndexForward=False,  # newest first
        Limit=limit,
    )
    return [
        {
            "startedAt": item.get("startedAt"),
            "endedAt": item.get("endedAt"),
            "durationSec": _plain(item.get("durationSec")),
            "triggerReason": item.get("triggerReason"),
            "resolved": bool(item.get("resolved", False)),
        }
        for item in response.get("Items", [])
    ]


def check_history(site_id, include_response_time=False):
    """Every recorded check for this site in the last 24 hours, oldest first.

    One query per site, and everything downstream - the uptime percentage, the
    hourly buckets, and the detail page's time series - is derived from this
    one result. Adding a second query per site to build the buckets would
    double the read cost of the dashboard for data we already have in hand.
    """
    since = _iso(datetime.now(timezone.utc) - timedelta(hours=UPTIME_WINDOW_HOURS))
    projection = "isUp, checkedAt"
    if include_response_time:
        projection += ", responseTimeMs"

    items = []
    kwargs = {
        "KeyConditionExpression": Key("siteId").eq(site_id)
        & Key("checkedAt").gte(since),
        "ProjectionExpression": projection,
        # checkedAt is the sort key, so this comes back in time order.
        "ScanIndexForward": True,
    }
    for _ in range(MAX_CHECK_PAGES):
        page = checks_table.query(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return items


def uptime_from(checks):
    """(percent up, sample size, up count) over an already-fetched check list."""
    total = len(checks)
    if total == 0:
        return None, 0, 0
    up = sum(1 for item in checks if item.get("isUp"))
    return round(up * 100.0 / total, 2), total, up


def hourly_buckets(checks, now):
    """24 one-hour buckets over the last 24 hours, oldest first.

    The buckets are *rolling*, anchored on `now` rather than aligned to clock
    hours: bucket 23 covers the hour ending right now, bucket 0 the hour that
    started 24 hours ago. That matches the uptime window the percentage is
    computed over, so the bar and the percentage always describe the same span.

    A bucket is "down" if any check in it failed - one failure inside an hour
    is what the operator needs to see, and averaging it away would hide short
    outages entirely. "none" means no check was recorded in that hour at all,
    which is what a paused or newly added site looks like.
    """
    buckets = ["none"] * HOURLY_BUCKETS
    for item in checks:
        checked = _parse_iso(item.get("checkedAt"))
        if checked is None:
            continue
        age_hours = (now - checked).total_seconds() / 3600.0
        # Clock skew can put a check marginally in the future; clamp it into
        # the newest bucket rather than dropping a real result.
        index = HOURLY_BUCKETS - 1 - int(math.floor(max(age_hours, 0.0)))
        if not 0 <= index < HOURLY_BUCKETS:
            continue
        if buckets[index] == "down":
            continue
        buckets[index] = "up" if item.get("isUp") else "down"
    return buckets


def site_entry(site, status, checks, now, incident_limit=INCIDENTS_PER_SITE):
    """One site's list entry, assembled from data already fetched."""
    site_id = site["siteId"]
    pct, sample, up_count = uptime_from(checks)
    paused = _is_paused(site)

    return {
        "siteId": site_id,
        "name": site.get("name", site_id),
        "url": site.get("url"),
        "brand": site.get("brand", "Unassigned"),
        # On every route, not just the detail one. The dashboard draws each
        # card's countdown ring from this; without it every ring fell back to
        # the global schedule interval and a 30s site counted down from 60.
        "checkIntervalSec": _plain(site.get("checkIntervalSec", 60)),
        # Paused wins over whatever CurrentStatus last recorded: a site that
        # is not being checked has no current status worth reporting.
        "status": "paused" if paused else status.get("currentStatus", "unknown"),
        "enabled": not paused,
        "lastCheckedAt": status.get("lastCheckedAt"),
        "lastResponseTimeMs": _plain(status.get("lastResponseTimeMs")),
        "consecutiveFailures": _plain(status.get("consecutiveFailures", 0)),
        "lastStatusChangeAt": status.get("lastStatusChangeAt"),
        "uptime24h": pct,
        "checks24h": sample,
        "hourlyBuckets": hourly_buckets(checks, now),
        "incidents": recent_incidents(site_id, limit=incident_limit),
        # Not part of the response - stripped by the callers below, after the
        # summary has used it.
        "_upCount": up_count,
        "_paused": paused,
    }


def build_summary(entries, now):
    """Dashboard-level analytics, from data already assembled per site.

    Every number here is derived from `entries`; nothing in this function
    issues a query. MTBF and the incident counts therefore see only the
    incidents each site's list entry carries, which the list routes cap at 5
    per site - so they describe recent history, not all of it.
    """
    up_count = sum(1 for e in entries if e["status"] == "up")
    down_count = sum(1 for e in entries if e["status"] == "down")
    paused_count = sum(1 for e in entries if e["_paused"])

    # Weighted by sample size rather than a mean of percentages, so a site
    # with 3 checks does not count as much as one with 1400.
    graded = [e for e in entries if not e["_paused"] and e["checks24h"] > 0]
    total_checks = sum(e["checks24h"] for e in graded)
    total_up = sum(e["_upCount"] for e in graded)
    overall = round(total_up * 100.0 / total_checks, 2) if total_checks else None

    starts = []
    for entry in entries:
        for incident in entry["incidents"]:
            started = _parse_iso(incident.get("startedAt"))
            if started is not None:
                starts.append(started)
    starts.sort()

    # Mean time between failures: the average gap between consecutive incident
    # starts. Two incidents give one interval, which is the minimum that means
    # anything; below that it is null, not zero.
    mtbf = None
    if len(starts) >= 2:
        gaps = [
            (later - earlier).total_seconds()
            for earlier, later in zip(starts, starts[1:])
        ]
        mtbf = round(sum(gaps) / len(gaps), 1)

    since_last = round((now - starts[-1]).total_seconds(), 1) if starts else None
    day_ago = now - timedelta(hours=UPTIME_WINDOW_HOURS)
    incidents_24h = sum(1 for started in starts if started >= day_ago)

    return {
        "upCount": up_count,
        "downCount": down_count,
        "pausedCount": paused_count,
        "totalMonitors": len(entries),
        "overallUptime24h": overall,
        "mtbfSeconds": mtbf,
        "timeSinceLastIncidentSeconds": since_last,
        "incidentCount24h": incidents_24h,
    }


def _strip_internal(entry):
    entry.pop("_upCount", None)
    entry.pop("_paused", None)
    return entry


def build_payload(public_only=False):
    """Assemble the whole status document.

    public_only filters the site list *before* any per-site work, so a site the
    caller will never see costs no UptimeChecks query and no Incidents query.
    """
    now = datetime.now(timezone.utc)
    sites = _scan_all(sites_table)
    if public_only:
        sites = [s for s in sites if s.get("isPublic") is True]
    statuses = {s["siteId"]: s for s in _scan_all(status_table)}

    entries = []
    for site in sites:
        site_id = site["siteId"]
        entries.append(
            site_entry(site, statuses.get(site_id, {}), check_history(site_id), now)
        )

    summary = build_summary(entries, now)

    # Down first, then never checked, then up, then paused - each group by
    # name. Paused sits last because it is the one group nobody needs to act
    # on.
    rank = {"down": 0, "unknown": 1, "up": 2, "paused": 3}
    entries.sort(key=lambda e: (rank.get(e["status"], 4), e["name"].lower()))

    return {
        "generatedAt": _iso(now),
        "failureThreshold": FAILURE_THRESHOLD,
        "summary": summary,
        "sites": [_strip_internal(e) for e in entries],
    }


def thin_series(points, limit=MAX_DETAIL_POINTS):
    """Sample `points` down to `limit`, keeping the span.

    Regular-interval sampling, not truncation: taking the first 500 of 1440
    checks would silently turn a 24-hour graph into an 8-hour one, which looks
    identical and is wrong. The final point is always kept so the line reaches
    the present.
    """
    total = len(points)
    if total <= limit or limit <= 0:
        return points
    step = total / float(limit)
    sampled = [points[min(int(i * step), total - 1)] for i in range(limit)]
    sampled[-1] = points[-1]
    return sampled


def build_site_payload(site_id, public_only=False):
    """One site with full detail, or None if the caller may not see it.

    None covers both "no such site" and "that site is private and this is the
    public route". The caller turns both into the same 404 with the same body,
    so the public route cannot be used to probe which site ids exist.
    """
    now = datetime.now(timezone.utc)

    record = sites_table.get_item(Key={"siteId": site_id}).get("Item")
    if not record:
        return None
    if public_only and record.get("isPublic") is not True:
        return None

    status = status_table.get_item(Key={"siteId": site_id}).get("Item") or {}
    checks = check_history(site_id, include_response_time=True)

    entry = site_entry(
        record, status, checks, now, incident_limit=INCIDENTS_DETAIL_LIMIT
    )

    if not public_only:
        # Only on the authenticated detail route, and only here. The monitor
        # page's edit form has to pre-fill it, and an authenticated caller can
        # already read it from GET /admin/sites. The public routes still never
        # echo isPublic: there it decides which sites are returned at all, and
        # says nothing else.
        #
        # checkIntervalSec used to be gated alongside it. It no longer is - it
        # is on every entry from site_entry() - because it is a check
        # frequency and nothing more. Nothing is decided by keeping it secret.
        entry["isPublic"] = record.get("isPublic") is True

    entry["checks"] = [
        {
            "checkedAt": item.get("checkedAt"),
            "responseTimeMs": _plain(item.get("responseTimeMs")),
            "isUp": bool(item.get("isUp")),
        }
        for item in thin_series(checks)
    ]

    return {
        "generatedAt": _iso(now),
        "failureThreshold": FAILURE_THRESHOLD,
        "site": _strip_internal(entry),
    }


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json",
            # Dashboard polls every 20s; a short cache absorbs refresh bursts.
            "cache-control": "public, max-age=10",
        },
        "body": json.dumps(body, default=str),
    }


def _resolve_route(event):
    """(public_only, site_id) for this request.

    Fail-closed in exactly the way the old _is_public_request was: a request is
    treated as authenticated only when it is *confidently* identified as one of
    the two private routes. Every ambiguity - no routeKey, an unfamiliar path,
    an event shaped differently than expected - resolves to public, the
    restrictive, less-data branch. The failure mode must never expose more than
    an unauthenticated caller is entitled to.

    site_id is None for the two list routes.
    """
    event = event if isinstance(event, dict) else {}

    params = event.get("pathParameters")
    site_id = params.get("siteId") if isinstance(params, dict) else None
    site_id = str(site_id).strip() if site_id else None

    route_key = event.get("routeKey")
    route_path = None
    if isinstance(route_key, str) and " " in route_key:
        route_path = route_key.split(" ", 1)[1].strip()

    if route_path == PRIVATE_PATH:
        return False, None
    if route_path == PRIVATE_DETAIL_PATH:
        return False, site_id
    if route_path in (PUBLIC_PATH, PUBLIC_DETAIL_PATH):
        return True, site_id if route_path == PUBLIC_DETAIL_PATH else None

    # No usable routeKey. Fall back to the raw path, and only ever conclude
    # "private" from an exact match on a private path.
    raw = event.get("rawPath")
    if not isinstance(raw, str) or not raw:
        http = (event.get("requestContext") or {}).get("http")
        raw = http.get("path") if isinstance(http, dict) else ""
    raw = (raw or "").rstrip("/")

    if raw == PRIVATE_PATH:
        return False, None
    if raw.startswith(PRIVATE_PATH + "/"):
        return False, urllib.parse.unquote(raw[len(PRIVATE_PATH) + 1 :]) or None
    if raw.startswith(PUBLIC_PATH + "/"):
        return True, urllib.parse.unquote(raw[len(PUBLIC_PATH) + 1 :]) or None
    return True, None


def lambda_handler(event, context):  # noqa: ARG001 - signature fixed by Lambda
    public_only, site_id = _resolve_route(event)
    try:
        if site_id is None:
            return _response(200, build_payload(public_only=public_only))

        payload = build_site_payload(site_id, public_only=public_only)
        if payload is None:
            # Deliberately the same answer for "no such site" and "that site
            # is private": one shape, one status code, nothing to probe with.
            return _response(404, {"error": "no such site"})
        return _response(200, payload)
    except Exception:  # noqa: BLE001 - always answer the dashboard with JSON
        logger.exception(
            "Failed to build status payload (public_only=%s, siteId=%s)",
            public_only,
            site_id,
        )
        return _response(500, {"error": "internal error building status payload"})
