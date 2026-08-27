#!/usr/bin/env python3
"""Seed the MuBWeM Sites table from config/config.json.

The table name is discovered from the deployed CloudFormation stack output
(SitesTableName), so nothing about your account needs to live in this repo.

Usage:
    python scripts/seed_sites.py                       # seed from config/config.json
    python scripts/seed_sites.py --dry-run             # show what would be written
    python scripts/seed_sites.py --config other.json
    python scripts/seed_sites.py --table MubwemStack-SitesTableXXXX
    python scripts/seed_sites.py --prune               # also delete sites not in config

Requires: pip install -r scripts/requirements.txt, and AWS credentials with
read access to the stack plus write access to the Sites table.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_CONFIG = os.path.join(REPO_ROOT, "config", "config.json")
DEFAULT_STACK = "MubwemStack"
DEFAULT_REGION = "ap-southeast-2"

REQUIRED_FIELDS = ("siteId", "name", "url")


def parse_args():
    parser = argparse.ArgumentParser(description="Seed the MuBWeM Sites table.")
    parser.add_argument("--config", default=DEFAULT_CONFIG, help="path to config JSON")
    parser.add_argument("--stack", default=DEFAULT_STACK, help="CloudFormation stack")
    parser.add_argument(
        "--region",
        default=os.environ.get("AWS_REGION", DEFAULT_REGION),
        help="AWS region",
    )
    parser.add_argument("--table", help="Sites table name (skips stack lookup)")
    parser.add_argument(
        "--dry-run", action="store_true", help="print items instead of writing"
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="delete table items whose siteId is absent from the config",
    )
    return parser.parse_args()


def load_sites(path):
    if not os.path.isfile(path):
        sys.exit(
            "Config not found: %s\nCopy config/config.example.json to "
            "config/config.json and edit it." % path
        )

    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)

    sites = data.get("sites") if isinstance(data, dict) else data
    if not isinstance(sites, list) or not sites:
        sys.exit("Config must contain a non-empty 'sites' array.")

    seen = set()
    for site in sites:
        missing = [f for f in REQUIRED_FIELDS if not site.get(f)]
        if missing:
            sys.exit("Site %r is missing required field(s): %s" % (site, missing))
        if not str(site["url"]).startswith(("http://", "https://")):
            sys.exit("Site %s has a url without a scheme: %s" % (site["siteId"], site["url"]))
        if site["siteId"] in seen:
            sys.exit("Duplicate siteId in config: %s" % site["siteId"])
        seen.add(site["siteId"])

    return sites


def resolve_table_name(stack_name, region):
    cfn = boto3.client("cloudformation", region_name=region)
    try:
        stacks = cfn.describe_stacks(StackName=stack_name)["Stacks"]
    except ClientError as exc:
        sys.exit(
            "Could not read stack %s in %s (%s).\nDeploy first, or pass --table."
            % (stack_name, region, exc.response["Error"]["Code"])
        )

    for output in stacks[0].get("Outputs", []):
        if output["OutputKey"] == "SitesTableName":
            return output["OutputValue"]

    sys.exit("Stack %s has no SitesTableName output; pass --table." % stack_name)


def to_item(site, now_iso):
    return {
        "siteId": str(site["siteId"]),
        "name": str(site["name"]),
        "url": str(site["url"]),
        "brand": str(site.get("brand", "Unassigned")),
        "checkIntervalSec": int(site.get("checkIntervalSec", 60)),
        "enabled": bool(site.get("enabled", True)),
        # Preserved on re-seed by the conditional write below.
        "createdAt": now_iso,
    }


def put_site(table, item):
    """Write the site, keeping the original createdAt if the row already exists."""
    try:
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(siteId)",
        )
        return "created"
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise

    updatable = {k: v for k, v in item.items() if k not in ("siteId", "createdAt")}
    table.update_item(
        Key={"siteId": item["siteId"]},
        UpdateExpression="SET " + ", ".join("#%s = :%s" % (k, k) for k in updatable),
        ExpressionAttributeNames={"#%s" % k: k for k in updatable},
        ExpressionAttributeValues={":%s" % k: v for k, v in updatable.items()},
    )
    return "updated"


def existing_site_ids(table):
    ids = set()
    kwargs = {"ProjectionExpression": "siteId"}
    while True:
        page = table.scan(**kwargs)
        ids.update(i["siteId"] for i in page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    return ids


def main():
    args = parse_args()
    sites = load_sites(args.config)
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    items = [to_item(s, now_iso) for s in sites]

    if args.dry_run:
        print("Dry run — %d site(s) from %s:" % (len(items), args.config))
        print(json.dumps(items, indent=2))
        return

    table_name = args.table or resolve_table_name(args.stack, args.region)
    table = boto3.resource("dynamodb", region_name=args.region).Table(table_name)
    print("Seeding %d site(s) into %s (%s)" % (len(items), table_name, args.region))

    for item in items:
        action = put_site(table, item)
        print("  %-8s %-24s %s" % (action, item["siteId"], item["url"]))

    if args.prune:
        configured = {i["siteId"] for i in items}
        for stale in sorted(existing_site_ids(table) - configured):
            table.delete_item(Key={"siteId": stale})
            print("  %-8s %s" % ("deleted", stale))

    print("Done. The checker picks up changes on its next run (within a minute).")


if __name__ == "__main__":
    main()
