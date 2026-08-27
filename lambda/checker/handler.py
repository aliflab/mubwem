"""MuBWeM checker Lambda.

Runs once a minute from EventBridge Scheduler. For every enabled site it:

  1. issues an HTTPS GET and records status code + response time,
  2. appends a row to UptimeChecks (TTL'd after CHECKS_TTL_DAYS),
  3. updates CurrentStatus (consecutiveFailures up on failure, 0 on success),
  4. opens an Incident + publishes an SNS alert once consecutiveFailures
     reaches FAILURE_THRESHOLD, and closes the open Incident + publishes a
     recovery alert on the first success afterwards.

Only the stdlib and boto3 are used, so the function needs no bundled deps.
"""

import concurrent.futures
import json
import logging
import os
import socket
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SITES_TABLE = os.environ["SITES_TABLE"]
UPTIME_CHECKS_TABLE = os.environ["UPTIME_CHECKS_TABLE"]
CURRENT_STATUS_TABLE = os.environ["CURRENT_STATUS_TABLE"]
INCIDENTS_TABLE = os.environ["INCIDENTS_TABLE"]
ALERT_TOPIC_ARN = os.environ["ALERT_TOPIC_ARN"]

FAILURE_THRESHOLD = int(os.environ.get("FAILURE_THRESHOLD", "3"))
CHECK_TIMEOUT_SEC = int(os.environ.get("CHECK_TIMEOUT_SEC", "8"))
CHECKS_TTL_DAYS = int(os.environ.get("CHECKS_TTL_DAYS", "30"))
CHECK_REGION = os.environ.get("CHECK_REGION", "unknown")

USER_AGENT = "MuBWeM-Monitor/1.0 (+uptime check)"
MAX_PARALLEL_CHECKS = 10

_boto_config = Config(retries={"max_attempts": 3, "mode": "standard"})
_dynamodb = boto3.resource("dynamodb", config=_boto_config)
_sns = boto3.client("sns", config=_boto_config)

sites_table = _dynamodb.Table(SITES_TABLE)
checks_table = _dynamodb.Table(UPTIME_CHECKS_TABLE)
status_table = _dynamodb.Table(CURRENT_STATUS_TABLE)
incidents_table = _dynamodb.Table(INCIDENTS_TABLE)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    """ISO8601 in UTC with a trailing Z - the sort key format for all tables."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _parse_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def load_enabled_sites():
    """Scan Sites and return the enabled ones.

    A scan is the right call here: the table holds tens of rows at most, and
    every row is needed on every sweep.
    """
    sites = []
    kwargs = {}
    while True:
        page = sites_table.scan(**kwargs)
        sites.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    enabled = [s for s in sites if s.get("enabled", True)]
    logger.info("Loaded %d sites, %d enabled", len(sites), len(enabled))
    return enabled


def check_site(site):
    """Perform one HTTP GET. Never raises - failures become isUp=False."""
    url = site["url"]
    started = time.perf_counter()

    request = urllib.request.Request(
        url,
        method="GET",
        headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
    )

    status_code = None
    error = None
    try:
        with urllib.request.urlopen(
            request, timeout=CHECK_TIMEOUT_SEC, context=ssl.create_default_context()
        ) as response:
            status_code = response.status
            # Drain a little so the timing reflects a real response, not just
            # headers, without pulling down whole pages.
            response.read(2048)
    except urllib.error.HTTPError as exc:
        # The server answered - a 4xx/5xx is a real, timed response.
        status_code = exc.code
        error = "HTTP %s" % exc.code
    except urllib.error.URLError as exc:
        error = "URLError: %s" % (exc.reason,)
    except socket.timeout:
        error = "Timeout after %ss" % CHECK_TIMEOUT_SEC
    except Exception as exc:  # noqa: BLE001 - a check must never kill the sweep
        error = "%s: %s" % (type(exc).__name__, exc)

    response_time_ms = int((time.perf_counter() - started) * 1000)
    is_up = status_code is not None and 200 <= status_code < 400

    return {
        "siteId": site["siteId"],
        "name": site.get("name", site["siteId"]),
        "url": url,
        "statusCode": status_code,
        "isUp": is_up,
        "responseTimeMs": response_time_ms,
        "error": error,
    }


def record_check(result, checked_at):
    ttl = int((_now() + timedelta(days=CHECKS_TTL_DAYS)).timestamp())
    item = {
        "siteId": result["siteId"],
        "checkedAt": checked_at,
        "statusCode": result["statusCode"],
        "isUp": result["isUp"],
        "responseTimeMs": Decimal(result["responseTimeMs"]),
        "region": CHECK_REGION,
        "ttl": ttl,
    }
    if result["error"]:
        item["error"] = result["error"][:500]
    checks_table.put_item(Item=item)


def update_current_status(result, checked_at):
    """Atomically bump/reset consecutiveFailures and return the new state."""
    if result["isUp"]:
        update = (
            "SET currentStatus = :status, lastCheckedAt = :now, "
            "lastResponseTimeMs = :rt, consecutiveFailures = :zero, "
            "lastStatusChangeAt = if_not_exists(lastStatusChangeAt, :now), "
            "siteName = :name, siteUrl = :url"
        )
        values = {
            ":status": "up",
            ":now": checked_at,
            ":rt": Decimal(result["responseTimeMs"]),
            ":zero": 0,
            ":name": result["name"],
            ":url": result["url"],
        }
    else:
        update = (
            "SET currentStatus = :status, lastCheckedAt = :now, "
            "lastResponseTimeMs = :rt, "
            "consecutiveFailures = if_not_exists(consecutiveFailures, :zero) + :one, "
            "lastStatusChangeAt = if_not_exists(lastStatusChangeAt, :now), "
            "siteName = :name, siteUrl = :url"
        )
        values = {
            ":status": "down",
            ":now": checked_at,
            ":rt": Decimal(result["responseTimeMs"]),
            ":zero": 0,
            ":one": 1,
            ":name": result["name"],
            ":url": result["url"],
        }

    response = status_table.update_item(
        Key={"siteId": result["siteId"]},
        UpdateExpression=update,
        ExpressionAttributeValues=values,
        ReturnValues="ALL_NEW",
    )
    return response["Attributes"]


def find_open_incident(site_id):
    """Most recent unresolved incident for a site, if any."""
    response = incidents_table.query(
        KeyConditionExpression=Key("siteId").eq(site_id),
        ScanIndexForward=False,
        Limit=5,
    )
    for item in response.get("Items", []):
        if not item.get("resolved", False):
            return item
    return None


def open_incident(result, checked_at, consecutive_failures):
    reason = result["error"] or "HTTP %s" % result["statusCode"]
    item = {
        "siteId": result["siteId"],
        "startedAt": checked_at,
        "endedAt": None,
        "durationSec": None,
        "triggerReason": "%d consecutive failures - %s"
        % (consecutive_failures, reason),
        "resolved": False,
    }
    incidents_table.put_item(Item=item)
    logger.warning("Incident opened for %s: %s", result["siteId"], reason)
    return item


def close_incident(incident, result, checked_at):
    started = _parse_iso(incident["startedAt"])
    ended = _parse_iso(checked_at)
    duration = int((ended - started).total_seconds()) if started and ended else 0

    incidents_table.update_item(
        Key={"siteId": incident["siteId"], "startedAt": incident["startedAt"]},
        UpdateExpression=(
            "SET endedAt = :ended, durationSec = :dur, resolved = :true"
        ),
        ExpressionAttributeValues={
            ":ended": checked_at,
            ":dur": Decimal(duration),
            ":true": True,
        },
    )
    logger.info(
        "Incident closed for %s after %ds", incident["siteId"], duration
    )
    return duration


def publish_alert(subject, message):
    try:
        _sns.publish(
            TopicArn=ALERT_TOPIC_ARN,
            Subject=subject[:100],
            Message=message,
        )
    except ClientError:
        # An alert that fails to send must not abort the rest of the sweep.
        logger.exception("Failed to publish SNS alert")


def handle_transitions(result, status_item, checked_at):
    """Open or close incidents based on the freshly-written status row."""
    site_id = result["siteId"]
    name = result["name"]
    failures = int(status_item.get("consecutiveFailures", 0))
    open_inc = find_open_incident(site_id)

    if not result["isUp"]:
        if failures >= FAILURE_THRESHOLD and open_inc is None:
            reason = result["error"] or "HTTP %s" % result["statusCode"]
            open_incident(result, checked_at, failures)
            publish_alert(
                "[MuBWeM] DOWN: %s" % name,
                "\n".join(
                    [
                        "%s is DOWN." % name,
                        "",
                        "URL:            %s" % result["url"],
                        "Reason:         %s" % reason,
                        "Status code:    %s" % (result["statusCode"] or "n/a"),
                        "Consecutive failures: %d (threshold %d)"
                        % (failures, FAILURE_THRESHOLD),
                        "Detected at:    %s (checked from %s)"
                        % (checked_at, CHECK_REGION),
                    ]
                ),
            )
            return "incident_opened"
        return "failing" if failures else "down"

    if open_inc is not None:
        duration = close_incident(open_inc, result, checked_at)
        publish_alert(
            "[MuBWeM] RECOVERED: %s" % name,
            "\n".join(
                [
                    "%s is back UP." % name,
                    "",
                    "URL:            %s" % result["url"],
                    "Status code:    %s" % result["statusCode"],
                    "Response time:  %dms" % result["responseTimeMs"],
                    "Downtime:       %ds (%s -> %s)"
                    % (duration, open_inc["startedAt"], checked_at),
                ]
            ),
        )
        return "incident_closed"

    return "up"


def process_site(site):
    checked_at = _iso(_now())
    result = check_site(site)
    record_check(result, checked_at)
    status_item = update_current_status(result, checked_at)
    outcome = handle_transitions(result, status_item, checked_at)
    return {
        "siteId": result["siteId"],
        "isUp": result["isUp"],
        "statusCode": result["statusCode"],
        "responseTimeMs": result["responseTimeMs"],
        "outcome": outcome,
    }


# ----------------------------------------------------------------------------
# Entrypoint
# ----------------------------------------------------------------------------
def lambda_handler(event, context):  # noqa: ARG001 - signature fixed by Lambda
    sites = load_enabled_sites()
    if not sites:
        logger.warning("No enabled sites found in %s", SITES_TABLE)
        return {"checked": 0, "results": []}

    results = []
    workers = min(MAX_PARALLEL_CHECKS, len(sites))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(process_site, s): s for s in sites}
        for future in concurrent.futures.as_completed(futures):
            site = futures[future]
            try:
                results.append(future.result())
            except Exception:  # noqa: BLE001 - one bad site must not fail the sweep
                logger.exception("Check failed for site %s", site.get("siteId"))
                results.append({"siteId": site.get("siteId"), "error": True})

    logger.info("Sweep complete: %s", json.dumps(results, default=str))
    return {"checked": len(results), "results": results}
