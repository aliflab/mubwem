# MuBWeM — Multi-Brand Website Monitor

**MuBWeM** = **Mu**lti-**B**rand **We**bsite **M**onitor: one uptime monitor watching the websites of several brands from a single dashboard.

An UptimeRobot-style uptime monitor built on AWS with CDK (Python). It checks a list of sites every minute, records every check, opens and closes incidents, emails you when something goes down or recovers, and serves a static status dashboard from CloudFront.

The dashboard is behind a Cognito login. Individual sites can be flagged `isPublic` to also appear on a shareable status page that needs no login — the UptimeRobot public-status-page idea, opt-in per site.

This repo is **Phase 1: the free tier test build**. It is a portfolio project — no real company data, no hardcoded secrets, no hardcoded email addresses or ARNs anywhere in committed code.

---

## Architecture

![MuBWeM architecture diagram](docs/mubwem.drawio.svg)

*Diagram source: `docs/mubwem.drawio` — open with [draw.io](https://app.diagrams.net) or the draw.io desktop app to edit.*

> **TODO — the diagram is out of date.** It still shows the pre-authentication
> topology: the warning markers on the CloudFront and `/status` edges, and no
> Cognito at all. It needs a user pool feeding a JWT authorizer in front of
> `GET /status`, and the second unauthenticated `GET /public/status` edge.
> Edit `docs/mubwem.drawio` and re-export `docs/mubwem.drawio.svg` over the top.

### The four tables

All four are **on-demand (PAY_PER_REQUEST)**.

`isPublic` is an application-level field, not a DynamoDB constraint — the table is schemaless past its keys. It defaults to `false`, and only `true` puts a site on the unauthenticated public page.

| Table | Keys | What it holds |
|---|---|---|
| **Sites** | PK `siteId` | `name`, `url`, `brand`, `checkIntervalSec`, `enabled`, `isPublic`, `createdAt` — the monitoring list, seeded from `config/config.json` |
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

`lambda/api/handler.py` serves two routes from one function, returning every site's current status, 24-hour uptime percentage, and its five most recent incidents in a single JSON document — the exact shape is documented in a comment at the top of that file:

| Route | Auth | Sites returned | Page |
|---|---|---|---|
| `GET /status` | Cognito JWT (API Gateway authorizer) | all of them | `index.html` |
| `GET /public/status` | none | only `isPublic: true` | `public.html` |

Both responses have the same shape, so one renderer (`frontend/dashboard.js`) serves both pages; `public.html` is styled distinctly so it is obvious which view you are looking at. The filter runs before any per-site work, so a site the caller will not see costs no `UptimeChecks` or `Incidents` read. `isPublic` itself is never echoed back on either route.

`frontend/` is plain HTML/CSS/JS with no build step; both pages poll every 20 seconds and render one card per site, down sites first.

The frontend never has the API URL or the Cognito client details committed to git: the CDK stack generates a `config.js` at deploy time and uploads it alongside the static files.

### Login

`frontend/auth.js` runs the OAuth 2.0 authorization code flow with PKCE against the Cognito hosted UI. The app client is public — a static page cannot keep a secret — so PKCE is what stops an intercepted code from being redeemed by anyone else.

The id token is kept in `sessionStorage`, never `localStorage`, and no refresh token is stored at all. A `localStorage` token survives every tab and outlives the browsing session, which turns any XSS on a page showing real internal hostnames into a durable credential leak; `sessionStorage` dies with the tab. The cost is re-authenticating on a new tab and once an hour when the id token expires, which the hosted UI's own session cookie usually makes invisible.

---

## Tradeoffs (the honest version)

- **Single region for checking.** Every check runs from `ap-southeast-2` (Sydney). The target audience is Australian, so this measures what those users actually experience. The cost is that a network problem between AWS Sydney and a site looks identical to that site being down — a real multi-region monitor would check from several regions and require a quorum before alerting.
- **1-minute check interval.** That is the floor for EventBridge Scheduler. Sub-minute checking would need a different trigger (a Step Functions loop, or a long-running container), which is more moving parts than a free tier test build justifies. It also means the `checkIntervalSec` field on each site is recorded but not yet honoured — every enabled site is checked every minute.
- **On-demand DynamoDB billing.** At a handful of sites and one check per minute, the write volume is trivial and on-demand costs cents. Provisioned capacity would be marginally cheaper at steady state but adds capacity planning and autoscaling config for no real benefit at this scale.
- **A DynamoDB `Scan` on the Sites table each run.** Correct at tens of rows, where every row is needed anyway. At thousands of sites this becomes the first thing to fix — a GSI on `enabled`, or sharded scheduling.
- **Uptime % is computed on read** from up to 24 hours of check rows. Simple and always accurate, but the API's cost grows with the retention window; a rollup table would be the next step.
- **Public exposure is opt-in per site, not per deployment.** The dashboard and `GET /status` both require a Cognito login; `GET /public/status` and `public.html` are deliberately open, and show only sites flagged `isPublic`. See [Access control](#access-control-authenticated-dashboard-opt-in-public-page) for what that does and does not protect.
- **`removalPolicy: DESTROY`** on the tables, the bucket and the Cognito user pool. This is a test build meant to be torn down cleanly, dashboard accounts included. Anything real should use `RETAIN`.

---

## Access control: authenticated dashboard, opt-in public page

This started as a known Phase 1 gap — the dashboard URL and `/status` were both reachable by anyone holding the URL, with no authentication — identified during Phase 1 testing rather than discovered later. It is now closed as follows.

**The dashboard is login-gated by default.** A Cognito user pool with **self-signup disabled** fronts it: accounts exist only because an operator created them (see [Creating a user](#creating-a-user)). Login goes through the Cognito hosted UI, and `GET /status` sits behind an API Gateway JWT authorizer validating the id token against that pool and app client. There is no way to reach a private site's status without a token.

**Public sharing is an explicit per-site opt-in.** A site with `isPublic: true` also appears on `GET /public/status`, which has no authorizer, and on `public.html`, which is the URL to hand out. Everything else stays behind the login. The default is `false`, so a site is private unless someone says otherwise.

Of the three fixes weighed earlier, this is the third — real authentication rather than a shared credential:

1. **A CloudFront Function doing HTTP Basic Auth at the edge** was the fastest to add and the weakest as access control: one shared credential, sent on every request, with no per-user identity or revocation. Not used.
2. **AWS WAF with an IP allowlist in front of CloudFront** is stronger where access should be limited to known office or VPN ranges, but needs a second stack in `us-east-1` — a WAF web ACL attached to CloudFront must live there regardless of which region the distribution is configured from. Not used; still the right addition if you want network-level restriction *as well*.
3. **Identity-based auth** — the option taken. Cognito gives per-user identity, revocation (disable or delete the user) and password policy, and the same JWT authorizer swaps to an organizational IdP later: federate the user pool to your SSO provider and neither the API nor the frontend changes.

### What this still does not do

- **CloudFront itself is not access-controlled.** The static HTML, CSS and JS are downloadable by anyone with the URL. There is nothing sensitive in them — the site list, statuses and incidents all arrive from the authenticated API — but the distribution is not private, and `config.js` publishes the API URL, the Cognito domain and the public client id. That is by design for a public OAuth client, not an oversight.
- **CORS on the API is still `*`.** The JWT authorizer, not the origin header, is what protects `/status`; CORS was never doing that job. `/public/status` is meant to be open.
- **No MFA, and no logging of who looked at what.** Adequate for a portfolio build, not for anything with a compliance story.
- **`removalPolicy: DESTROY` covers the user pool too**, so `cdk destroy` takes the accounts with it.

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
| Cognito domain prefix | — | `cognitoDomainPrefix` | derived from the stack id |

The Cognito hosted-UI domain prefix has to be globally unique across all AWS accounts, so it defaults to `mubwem-` plus the first segment of this stack's CloudFormation id. Override it with `-c cognitoDomainPrefix=something-unique` if you want a friendlier login URL.

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

Deploy prints seven outputs:

| Output | What it is for |
|---|---|
| `DashboardUrl` | the CloudFront dashboard (login required); the public page is `<DashboardUrl>/public.html` |
| `ApiUrl` | `GET /status` — needs a Cognito id token |
| `PublicApiUrl` | `GET /public/status` — open, `isPublic` sites only |
| `CognitoLoginUrl` | the hosted UI login page |
| `CognitoUserPoolId` | needed to create users (below) |
| `SitesTableName` | used by `scripts/seed_sites.py` |
| `AlertTopicArn` | the SNS topic behind the email alerts |

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

Add `"isPublic": true` to a site to put it on the public status page. It defaults to `false`, and a re-seed from a config that does not mention `isPublic` leaves whatever the table already says alone — the same treatment `createdAt` gets — so a site does not quietly stop being public because someone trimmed the config. Spelling the flag out explicitly always wins, including `"isPublic": false` to un-publish.

The checker picks up the new sites on its next run, within a minute.

### 6. Open the dashboard

Visit the `DashboardUrl` output and sign in with a user you created (see [Creating a user](#creating-a-user) — there is no self-signup, so do this first). CloudFront can take a few minutes to finish deploying on first launch.

The shareable public page is `<DashboardUrl>/public.html`. It needs no login and lists only the sites flagged `isPublic`.

Running the frontend locally is only useful for the public page now, because the Cognito app client's callback URL is the CloudFront domain:

```bash
cd frontend && python -m http.server 8000
# then open http://localhost:8000/public.html?api=<PublicApiUrl output>
```

To develop the authenticated page locally as well, add `http://localhost:8000/` to the app client's callback **and** sign-out URLs in the Cognito console — or to `callback_urls` / `logout_urls` in the stack, if you would rather it be code.

### Tearing down

```bash
cd infrastructure && cdk destroy
```

Tables, the frontend bucket and the user pool are set to `DESTROY`, so this leaves nothing behind — including the dashboard accounts.

---

## Creating a user

Self-signup is deliberately off: nobody gets a dashboard account except by an operator creating one. There is no console step in the deploy, so this is manual and intentional.

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <CognitoUserPoolId output> \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --temporary-password "TempPass123!" \
  --region ap-southeast-2
```

Cognito emails the temporary password to that address. On the first hosted-UI login the user is prompted to set a permanent one, which must satisfy the pool's policy: at least 8 characters with an uppercase letter, a lowercase letter and a digit.

Add `--message-action SUPPRESS` if you would rather hand the temporary password over yourself instead of having Cognito email it.

To revoke access later:

```bash
aws cognito-idp admin-disable-user --user-pool-id <id> --username you@example.com --region ap-southeast-2
```

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
├── frontend/               static pages (no framework, no build step)
│   ├── index.html          authenticated dashboard
│   ├── public.html         shareable public status page
│   ├── auth.js             Cognito hosted UI login (auth code + PKCE)
│   ├── dashboard.js        rendering and polling, shared by both pages
│   ├── app.js              authenticated bootstrap
│   └── public.js           public bootstrap
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
- Federating the Cognito pool to organizational SSO, and WAF/IP restriction in front of CloudFront
- Honouring per-site `checkIntervalSec` instead of a fixed one-minute sweep
