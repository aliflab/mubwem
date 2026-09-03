"""MuBWeM status API Lambda.

Behind an API Gateway HTTP API, serving two routes from one function:

  GET /status         authenticated (Cognito JWT authorizer) - every site
  GET /public/status  unauthenticated - only sites with isPublic = true

Both return everything the dashboard needs in one call, so the frontend does
no joining of its own. The two responses have an identical shape; the public
one simply carries fewer sites.

Response shape (this is the contract the frontend consumes directly):

{
  "generatedAt": "2026-08-27T09:15:00.000Z",   # ISO8601 UTC, server time
  "failureThreshold": 3,
  "sites": [
    {
      "siteId":              "example-home",
      "name":                "Example Home",
      "url":                 "https://example.com",
      "brand":               "Example Brand",
      "status":              "up" | "down" | "unknown",   # unknown = never checked
      "lastCheckedAt":       "2026-08-27T09:14:03.221Z" | null,
      "lastResponseTimeMs":  312 | null,
      "consecutiveFailures": 0,
      "lastStatusChangeAt":  "2026-08-26T22:01:10.004Z" | null,
      "uptime24h":           99.86 | null,   # percent of checks up, 2dp
      "checks24h":           1437,           # sample size behind uptime24h
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

Sites are sorted down-first, then by name, so the dashboard can render in
order without sorting.

The per-site `isPublic` flag is never echoed back on either route: it decides
which sites /public/status includes, and nothing else.
"""

import json
import logging
import os
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
UPTIME_WINDOW_HOURS = 24
# 24h at a 1-minute cadence is ~1440 rows; cap the paging so one wedged site
# cannot stall the whole response.
MAX_CHECK_PAGES = 4
# Route path of the unauthenticated feed, as it arrives in the HTTP API
# payload (rawPath / routeKey).
PUBLIC_PATH = "/public/status"

_dynamodb = boto3.resource(
    "dynamodb", config=Config(retries={"max_attempts": 3, "mode": "standard"})
)
sites_table = _dynamodb.Table(SITES_TABLE)
checks_table = _dynamodb.Table(UPTIME_CHECKS_TABLE)
status_table = _dynamodb.Table(CURRENT_STATUS_TABLE)
incidents_table = _dynamodb.Table(INCIDENTS_TABLE)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


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


def recent_incidents(site_id):
    response = incidents_table.query(
        KeyConditionExpression=Key("siteId").eq(site_id),
        ScanIndexForward=False,  # newest first
        Limit=INCIDENTS_PER_SITE,
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


def uptime_percent(site_id):
    """Share of checks in the last 24h that were up, as (percent, sample size)."""
    since = _iso(datetime.now(timezone.utc) - timedelta(hours=UPTIME_WINDOW_HOURS))
    total = 0
    up = 0
    kwargs = {
        "KeyConditionExpression": Key("siteId").eq(site_id)
        & Key("checkedAt").gte(since),
        "ProjectionExpression": "isUp",
    }
    for _ in range(MAX_CHECK_PAGES):
        page = checks_table.query(**kwargs)
        for item in page.get("Items", []):
            total += 1
            if item.get("isUp"):
                up += 1
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    if total == 0:
        return None, 0
    return round(up * 100.0 / total, 2), total


def build_payload(public_only=False):
    """Assemble the whole status document.

    public_only filters the site list *before* any per-site work, so a site the
    caller will never see costs no UptimeChecks query and no Incidents query.
    """
    sites = _scan_all(sites_table)
    if public_only:
        sites = [s for s in sites if s.get("isPublic") is True]
    statuses = {s["siteId"]: s for s in _scan_all(status_table)}

    entries = []
    for site in sites:
        site_id = site["siteId"]
        status = statuses.get(site_id, {})
        pct, sample = uptime_percent(site_id)

        entries.append(
            {
                "siteId": site_id,
                "name": site.get("name", site_id),
                "url": site.get("url"),
                "brand": site.get("brand", "Unassigned"),
                "status": status.get("currentStatus", "unknown"),
                "lastCheckedAt": status.get("lastCheckedAt"),
                "lastResponseTimeMs": _plain(status.get("lastResponseTimeMs")),
                "consecutiveFailures": _plain(status.get("consecutiveFailures", 0)),
                "lastStatusChangeAt": status.get("lastStatusChangeAt"),
                "uptime24h": pct,
                "checks24h": sample,
                "incidents": recent_incidents(site_id),
            }
        )

    # Down first, then anything never checked, then up - each group by name.
    rank = {"down": 0, "unknown": 1, "up": 2}
    entries.sort(key=lambda e: (rank.get(e["status"], 3), e["name"].lower()))

    return {
        "generatedAt": _iso(datetime.now(timezone.utc)),
        "failureThreshold": FAILURE_THRESHOLD,
        "sites": entries,
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


def _is_public_request(event):
    """True for GET /public/status, on either payload shape API Gateway sends.

    Both routes hit this one function, and the authorizer - not this code - is
    what keeps /status private. Getting this wrong can only ever show *less*
    than the caller is entitled to, never more.
    """
    route_key = (event or {}).get("routeKey") or ""
    if route_key.endswith(" " + PUBLIC_PATH):
        return True

    path = (event or {}).get("rawPath") or ""
    if not path:
        path = (
            (event or {}).get("requestContext", {}).get("http", {}).get("path", "")
        )
    # Tolerates a stage prefix, e.g. /$default/public/status.
    return path.rstrip("/").endswith(PUBLIC_PATH)


def lambda_handler(event, context):  # noqa: ARG001 - signature fixed by Lambda
    public_only = _is_public_request(event)
    try:
        return _response(200, build_payload(public_only=public_only))
    except Exception:  # noqa: BLE001 - always answer the dashboard with JSON
        logger.exception(
            "Failed to build status payload (public_only=%s)", public_only
        )
        return _response(500, {"error": "internal error building status payload"})
