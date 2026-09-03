# MuBWeM — Multi-Brand Website Monitor

**MuBWeM** = **Mu**lti-**B**rand **We**bsite **M**onitor: one uptime monitor watching the websites of several brands from a single dashboard.

An UptimeRobot-style uptime monitor built on AWS with CDK (Python). It checks a list of sites every minute, records every check, opens and closes incidents, emails you when something goes down or recovers, and serves a static status dashboard from CloudFront.

This repo is **Phase 1: the free tier test build**. It is a portfolio project — no real company data, no hardcoded secrets, no hardcoded email addresses or ARNs anywhere in committed code.

---

## Architecture

![MuBWeM architecture diagram](docs/mubwem.drawio.svg)

*Diagram source: `docs/mubwem.drawio` — open with [draw.io](https://app.diagrams.net) or the draw.io desktop app to edit.*

### The four tables

All four are **on-demand (PAY_PER_REQUEST)**.

| Table | Keys | What it holds |
|---|---|---|
| **Sites** | PK `siteId` | `name`, `url`, `brand`, `checkIntervalSec`, `enabled`, `createdAt` — the monitoring list, seeded from `config/config.json` |
| **UptimeChecks** | PK `siteId`, SK `checkedAt` (ISO8601) | `statusCode`, `isUp`, `responseTimeMs`, `region`, `ttl` — the raw history, auto-expired after 30 days by DynamoDB TTL |
| **CurrentStatus** | PK `siteId` | `currentStatus` (`up`/`down`), `lastCheckedAt`, `lastResponseTimeMs`, `consecutiveFailures`, `lastStatusChangeAt` — the one row the dashboard reads per site |
| **Incidents** | PK `siteId`, SK `startedAt` (ISO8601) | `endedAt` (null while ongoing), `durationSec`, `triggerReason`, `resolved` |

### Checker flow

`lambda/checker/handler.py` runs once a minute:

1. Scans **Sites** and keeps the enabled ones.
2. Checks each site in parallel (up to 10 at a time) with an HTTPS GET, timeout from `checkTimeoutSec`. `2xx`/`3xx` is up; anything else — including a timeout, DNS failure, or TLS error — is down.
3. Writes a row to **UptimeChecks** with a 30-day TTL.
4. Updates **CurrentStatus** with a single atomic DynamoDB expression: `consecutiveFailures + 1` on failure, `0` on success.

### Alert flow

5. When `consecutiveFailures` reaches the threshold (default **3**, i.e. ~3 minutes down) **and** no incident is already open, it opens an **Incident** and publishes a `DOWN` alert to SNS.
6. On the first success after an open incident, it sets `endedAt` and `durationSec`, marks the incident `resolved`, and publishes a `RECOVERED` alert.

Requiring three consecutive failures is what keeps a single flaky check from paging you. Requiring "no incident already open" is what keeps a two-hour outage from sending an email every minute.

### Dashboard

`lambda/api/handler.py` serves one `GET /status` endpoint returning every site's current status, 24-hour uptime percentage, and its five most recent incidents in a single JSON document — the exact shape is documented in a comment at the top of that file. `frontend/` is plain HTML/CSS/JS with no build step; it polls that endpoint every 20 seconds and renders one card per site, down sites first.

The frontend never has the API URL committed to git: the CDK stack generates a `config.js` at deploy time and uploads it alongside the static files.

---

## Tradeoffs (the honest version)

- **Single region for checking.** Every check runs from `ap-southeast-2` (Sydney). The target audience is Australian, so this measures what those users actually experience. The cost is that a network problem between AWS Sydney and a site looks identical to that site being down — a real multi-region monitor would check from several regions and require a quorum before alerting.
- **1-minute check interval.** That is the floor for EventBridge Scheduler. Sub-minute checking would need a different trigger (a Step Functions loop, or a long-running container), which is more moving parts than a free tier test build justifies. It also means the `checkIntervalSec` field on each site is recorded but not yet honoured — every enabled site is checked every minute.
- **On-demand DynamoDB billing.** At a handful of sites and one check per minute, the write volume is trivial and on-demand costs cents. Provisioned capacity would be marginally cheaper at steady state but adds capacity planning and autoscaling config for no real benefit at this scale.
- **A DynamoDB `Scan` on the Sites table each run.** Correct at tens of rows, where every row is needed anyway. At thousands of sites this becomes the first thing to fix — a GSI on `enabled`, or sharded scheduling.
- **Uptime % is computed on read** from up to 24 hours of check rows. Simple and always accurate, but the API's cost grows with the retention window; a rollup table would be the next step.
- **The API is public and unauthenticated,** with CORS open, and the CloudFront dashboard is equally open to anyone holding its URL. See [Known security gap: dashboard and API are public](#known-security-gap-dashboard-and-api-are-public) below for the exposure and the options for closing it.
- **`removalPolicy: DESTROY`** on the tables and bucket. This is a test build meant to be torn down cleanly. Anything real should use `RETAIN`.

---

## Known security gap: dashboard and API are public

Both the CloudFront dashboard URL and the `GET /status` API endpoint are reachable by anyone who has the URL. There is no authentication on either one — no login, no token, no IP restriction. The architecture diagram above marks both of these edges with a warning indicator.

This was identified during Phase 1 testing, as a known property of the build, not discovered afterwards.

Three fixes were considered. None is committed to yet:

1. **A CloudFront Function doing HTTP Basic Auth at the edge.** Fastest to add — a few lines of JavaScript on the viewer-request event. Also the weakest as real access control: a shared credential, sent on every request, with no per-user identity or revocation.
2. **AWS WAF with an IP allowlist in front of CloudFront.** Stronger, and appropriate if access should be limited to known office or VPN ranges. It requires a second stack in `us-east-1`, because a WAF web ACL attached to CloudFront must live there regardless of which region the distribution itself is configured from.
3. **Putting it behind existing organizational SSO.** The correct answer for any real internal deployment, and the only one that gives per-user identity and revocation. It is also real implementation work — an authorizer at API Gateway, or at CloudFront — rather than a configuration change.

The **Tradeoffs** bullet above about the API being public should be read together with this section rather than as a separate, lesser concern: the dashboard has exactly the same exposure, and closing one without the other closes nothing.

---

## Deploy

### Prerequisites

- An AWS account and credentials configured (`aws configure`, or `AWS_PROFILE`)
- Node.js (for the CDK CLI) and Python 3.11+
- `npm install -g aws-cdk`

### 1. Install dependencies

```bash
python -m venv .venv
source .venv/bin/activate          # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r infrastructure/requirements.txt
pip install -r scripts/requirements.txt
```

### 2. Set your configuration

Nothing environment-specific is committed. Copy the env template and fill it in:

```bash
cp .env.example .env               # .env is gitignored
```

| Setting | Env var | Context key | Default |
|---|---|---|---|
| Alert email (**required**) | `MUBWEM_ALERT_EMAIL` | `alertEmail` | none — deploy fails without it |
| Failure threshold | `MUBWEM_FAILURE_THRESHOLD` | `failureThreshold` | `3` |
| HTTP timeout (sec) | `MUBWEM_CHECK_TIMEOUT_SEC` | `checkTimeoutSec` | `8` |
| Check retention (days) | `MUBWEM_CHECKS_TTL_DAYS` | `checksTtlDays` | `30` |
| Schedule | `MUBWEM_SCHEDULE_EXPRESSION` | `scheduleExpression` | `rate(1 minute)` |
| Region | `MUBWEM_REGION` | `region` | `ap-southeast-2` |

Any of these can also be passed on the command line, which wins over both `.env` and `cdk.json`:

```bash
cdk deploy -c alertEmail=you@yourdomain.com -c failureThreshold=3
```

### 3. Bootstrap and deploy

```bash
cd infrastructure
cdk bootstrap aws://<YOUR_ACCOUNT_ID>/ap-southeast-2
cdk synth                          # sanity check, writes nothing to AWS
cdk deploy
```

Deploy prints four outputs: `DashboardUrl`, `ApiUrl`, `SitesTableName`, and `AlertTopicArn`.

### 4. Confirm the SNS email subscription

AWS sends a "Subscription Confirmation" email to the address you configured. **Click the confirmation link** — until you do, no alerts are delivered. Check spam if it does not arrive within a minute.

### 5. Seed your sites

```bash
cp config/config.example.json config/config.json     # config.json is gitignored
# edit config/config.json with your real test sites
python scripts/seed_sites.py --dry-run              # check what will be written
python scripts/seed_sites.py                        # write to the Sites table
```

The script finds the table name from the stack's `SitesTableName` output, so no table name or ARN is ever hardcoded. Re-running it updates existing sites while preserving their original `createdAt`; `--prune` also deletes sites that are no longer in the config.

The checker picks up the new sites on its next run, within a minute.

### 6. Open the dashboard

Visit the `DashboardUrl` output. CloudFront can take a few minutes to finish deploying on first launch.

To run the frontend locally against the deployed API:

```bash
cd frontend && python -m http.server 8000
# then open http://localhost:8000/?api=<ApiUrl output>
```

### Tearing down

```bash
cd infrastructure && cdk destroy
```

Tables and the frontend bucket are set to `DESTROY`, so this leaves nothing behind.

---

## Repository layout

```
mubwem/
├── infrastructure/         CDK app (Python)
│   ├── app.py              entrypoint; resolves config from CLI / .env / cdk.json
│   ├── stacks/mubwem_stack.py
│   ├── cdk.json            context block with placeholder values
│   └── requirements.txt
├── lambda/
│   ├── checker/handler.py  runs every minute, checks all sites, alerts
│   └── api/handler.py      GET /status for the dashboard
├── frontend/               static dashboard (no framework, no build step)
├── config/
│   ├── config.example.json committed placeholders
│   └── config.json         gitignored — your real sites
├── scripts/seed_sites.py   seeds the Sites table from config.json
└── LICENSE                 MIT
```

## Roadmap (later phases)

- Multi-region checks with quorum before alerting
- Historical uptime rollups instead of computing 24h uptime on every read
- SSL certificate expiry and keyword-match checks
- Per-site alert routing (Slack, SMS) and maintenance windows
- Honouring per-site `checkIntervalSec` instead of a fixed one-minute sweep
