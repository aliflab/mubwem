#!/usr/bin/env python3
"""CDK entrypoint for MuBWeM.

Configuration precedence, highest first:
  1. -c / --context flags on the CLI          (cdk deploy -c alertEmail=...)
  2. environment variables / a gitignored .env at the repo root
  3. the "context" block in cdk.json          (placeholders only)

Nothing environment-specific is hardcoded here, so the same code deploys to a
different AWS account by changing configuration alone.
"""

import os

import aws_cdk as cdk

from stacks.mubwem_stack import MubwemStack

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Context keys that may also be supplied as MUBWEM_-prefixed env vars / .env
# entries, e.g. MUBWEM_ALERT_EMAIL -> alertEmail.
ENV_OVERRIDES = {
    "MUBWEM_ALERT_EMAIL": "alertEmail",
    "MUBWEM_SENDER_EMAIL": "senderEmail",
    "MUBWEM_BOUNCE_ALERT_EMAIL": "bounceAlertEmail",
    "MUBWEM_FAILURE_THRESHOLD": "failureThreshold",
    "MUBWEM_CHECK_TIMEOUT_SEC": "checkTimeoutSec",
    "MUBWEM_CHECKS_TTL_DAYS": "checksTtlDays",
    "MUBWEM_SCHEDULE_EXPRESSION": "scheduleExpression",
    "MUBWEM_SCHEDULE_TIMEZONE": "scheduleTimezone",
    "MUBWEM_DISPLAY_TIMEZONE": "displayTimezone",
    "MUBWEM_REGION": "region",
    "MUBWEM_ACCOUNT": "account",
}


def load_dotenv(path: str) -> None:
    """Minimal .env loader - avoids a dependency for six optional values."""
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_dotenv(os.path.join(REPO_ROOT, ".env"))

app = cdk.App()

def is_placeholder(value) -> bool:
    """True for a cdk.json stand-in that an env var is allowed to replace.

    The sentinel is how this file tells a placeholder apart from an explicit
    -c flag - CDK merges both into the same context. cdk.json ships
    "CHANGE_ME@example.com", not a bare "CHANGE_ME", so this has to match the
    substring the way the stack's own guard does.
    """
    return value in (None, "") or "CHANGE_ME" in str(value)


# Env vars win over cdk.json placeholders, but never over an explicit -c flag.
for env_key, context_key in ENV_OVERRIDES.items():
    value = os.environ.get(env_key)
    if value and is_placeholder(app.node.try_get_context(context_key)):
        app.node.set_context(context_key, value)

region = app.node.try_get_context("region") or os.environ.get(
    "CDK_DEFAULT_REGION", "ap-southeast-2"
)
account = app.node.try_get_context("account") or os.environ.get("CDK_DEFAULT_ACCOUNT")

MubwemStack(
    app,
    "MubwemStack",
    env=cdk.Environment(account=account, region=region),
    description="MuBWeM - Multi-Brand Website Monitor (Phase 1 test build)",
)

app.synth()
