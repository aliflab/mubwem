# MuBWeM — Multi-Brand Website Monitor

**MuBWeM** = **Mu**lti-**B**rand **We**bsite **M**onitor: one uptime monitor watching the websites of several brands from a single dashboard.

An UptimeRobot-style uptime monitor built on AWS with CDK (Python). It checks a list of sites every minute, records every check, opens and closes incidents, emails you when something goes down or recovers, and serves a static dashboard from CloudFront.

Everything is behind a Cognito login — there is no public or unauthenticated route anywhere. Access is role based: **Admins**, **Editors** and **Viewers** are Cognito groups, and an admin panel manages users and sites from the browser instead of the AWS CLI.

This repo is **Phase 1: the free tier test build**. It is a portfolio project — no real company data, and no hardcoded secrets, email addresses or ARNs in committed code.

**Contents** — [Architecture](#architecture) · [Frontend](#frontend) · [Roles and access control](#roles-and-access-control) · [Deploy](#deploy) · [Creating a user](#creating-a-user) · [API guide](#api-guide) · [Repository layout](#repository-layout) · [Roadmap](#roadmap-later-phases)

### At a glance

| | |
|---|---|
| **Checks** | HTTPS GET of every enabled site, once a minute, from one AWS region |
| **Down means** | `failureThreshold` (default 3) consecutive failures — one blip never alerts |
| **Alerts** | HTML email via SES on `DOWN` and `RESOLVED`, plain-text SNS fallback, mutable from the UI |
| **Dashboard** | static pages on CloudFront, Cognito sign-in (password or passkey), polls every 20s |
| **API** | API Gateway HTTP API, every route behind a Cognito JWT authorizer — see [API guide](#api-guide) |
| **Stack** | one CDK (Python) stack: 5 DynamoDB tables, 3 Lambdas, EventBridge Scheduler, SES, SNS, Cognito, S3 + CloudFront |

---

## Architecture

![MuBWeM architecture diagram](docs/mubwem.drawio.svg)

*Diagram source: `docs/mubwem.drawio` — edit with [draw.io](https://app.diagrams.net) and re-export the SVG over the top.*

> **TODO — the diagram is out of date.** It still shows the pre-authentication
> topology: no Cognito, no JWT authorizer, no `AdminFunction`, and only three
> pages hanging off CloudFront instead of eight.

### The five tables

All five are on-demand (`PAY_PER_REQUEST`).

| Table | Keys | What it holds |
|---|---|---|
| **Sites** | PK `siteId` | `name`, `url`, `checkIntervalSec`, `enabled`, `createdAt` — the monitoring list |
| **UptimeChecks** | PK `siteId`, SK `checkedAt` (ISO8601) | `statusCode`, `isUp`, `responseTimeMs`, `region`, `ttl` — raw history, TTL-expired after 30 days |
| **CurrentStatus** | PK `siteId` | `currentStatus`, `lastCheckedAt`, `lastResponseTimeMs`, `consecutiveFailures`, `lastStatusChangeAt` |
| **Incidents** | PK `siteId`, SK `startedAt` (ISO8601) | `endedAt` (null while ongoing), `durationSec`, `triggerReason`, `resolved` |
| **Settings** | PK `settingKey` | one row, `notifications`: `emailAlertsEnabled`, `updatedAt`, `updatedBy` — the alert-email mute |

### Checker flow

`lambda/checker/handler.py` runs once a minute:

1. Scans **Sites** and keeps the enabled ones.
2. Checks each in parallel (up to 10 at a time) with an HTTPS GET, timeout from `checkTimeoutSec`. `2xx`/`3xx` is up; anything else — timeout, DNS failure, TLS error — is down.
3. Writes an **UptimeChecks** row with a 30-day TTL.
4. Updates **CurrentStatus** in one atomic expression: `consecutiveFailures + 1` on failure, `0` on success. A failure leaves `currentStatus` as it was; it flips to `down` only on the check that reaches the threshold (a second, idempotent write), so an isolated blip never shows the site as down.
5. When `consecutiveFailures` reaches the threshold (default **3**) **and** no incident is already open, opens an **Incident** and sends a `DOWN` alert.
6. On the first success after an open incident, closes it (`endedAt`, `durationSec`, `resolved`) and sends a `RESOLVED` alert.

Three consecutive failures is what stops a single flaky check from paging you. "No incident already open" is what stops a two-hour outage emailing every minute.

### Alerting

Both mails are HTML, rendered by `lambda/checker/email_templates.py` and sent through **SES**: a coloured status banner, a field table, and a **View details** button deep-linking to that monitor's page. The `DOWN` mail carries name, URL, root cause, start time and location; `RESOLVED` adds resolution time and outage duration. Location is the region the check ran from, shown as a friendly name (`Sydney, Australia (ap-southeast-2)`).

**SES first, SNS as the fallback.** SNS's `email` protocol is plain text only, so it cannot carry a designed mail. The topic is still wired up: if SES refuses a send, the checker publishes the plain-text version there rather than losing it. Every mail is rendered in both formats for that reason.

**Muting alert email.** Admins and Editors can switch alert email off from the Email row on `/settings` (`PATCH /admin/settings`). The checker reads the flag once per sweep, so a change applies within a minute. Muted means no `DOWN` or `RESOLVED` mail by **any** path — SES and the SNS fallback alike — but incidents still open and close and still show on the dashboard. Because the incident still opens while muted, unmuting mid-outage sends no late `DOWN` mail; the `RESOLVED` one does go out. The flag **fails open**: a missing row or a failed read means email is on.

**Bounce and complaint detection.** `send_email` returning a `MessageId` means SES accepted the mail, not that it was delivered — a typo'd domain is accepted and hard-bounces minutes later, with nothing to fall back on. A **SES configuration set**, attached to the sender identity and named on every send, forwards `bounce` and `complaint` events to a separate SNS topic (`DeliveryFailureTopicArn`). `delivery` events are deliberately not subscribed. The SNS topic policy scopes SES's publish rights by `aws:SourceAccount` and by this configuration set's ARN.

> This is **detection only, on purpose**. The notification arrives as raw SES event JSON, and nothing retries the send, re-alerts the incident, or suppresses a repeatedly bouncing address. The goal was to turn "a bad alert address is invisible" into "a bad alert address puts something ugly in your inbox".

### Status API

`lambda/api/handler.py` serves two routes from one function: `GET /status` (every site, used by `/`) and `GET /status/{siteId}` (one site in full detail, used by `/monitor`). The exact response shape is documented at the top of that file, and request/response examples are in the [API guide](#status-endpoints).

Both sit behind the Cognito JWT authorizer. The list route carries a top-level `summary` (up/down/paused counts, weighted 24h uptime, MTBF, time since last incident, incidents in 24h) and a 24-slot `hourlyBuckets` array per site, all computed from the same 24h `UptimeChecks` query the uptime percentage already needed.

| Bucket state | Colour | Means |
|---|---|---|
| `down` | red | a check in a run of `failureThreshold`+ consecutive failures — an incident by the checker's own rule |
| `warn` | amber | a check failed, but no failing run reached the threshold — an isolated blip |
| `up` | green | checks ran and all passed |
| `none` | grey | no check this hour (paused, or the site did not exist yet) |

Colouring *any* failure red made red mean "a blip happened", which is not what the rest of the system means by an incident. A run is marked from its **first** failure once it reaches the threshold, so the red span is the true outage length — which means the bar can go red slightly before the matching `Incidents` row's `startedAt`, that being the moment of confirmation. See `incident_level_checks()` for the algorithm and its one edge case (a run beginning before the 24h window). `uptime24h` uses the same marking: only checks inside a run that reached the threshold count as downtime, so an isolated failure (an amber hour) does not lower it. A run still below the threshold at the end of the window counts as up until it crosses the line, then counts as down from its first failure.

The detail route adds the raw 24h check series for the response-time graph — thinned by regular-interval sampling to at most 500 points, never truncated — plus up to 50 incidents.

A site with `enabled: false` reports `status: "paused"` rather than its last recorded status, and is excluded from the uptime roll-up.

### Admin API

`lambda/admin/handler.py` is a **separate** function behind the same authorizer, serving eleven `/admin/*` routes for sites, users and settings. The route list with the minimum role for each is in the [API guide](#endpoint-reference); Editors manage sites and the email mute, only Admins delete sites or touch users.

Two functions rather than more routes on one: giving the read-only status function the ability to administer the user pool would put that capability behind every `/status` request. `AdminFunction` has its own IAM role — read/write on **Sites and Settings only**, plus `cognito-idp` actions scoped to this user pool's ARN.

`POST /admin/sites/preview` is the only place in the codebase that makes an outbound request to a caller-supplied address, so it carries a full SSRF defence: `https://` only, every resolved address checked against reserved ranges, the socket pinned to the address that passed (SNI and certificate verification stay on the hostname, which is what defeats DNS rebinding), IPv4-mapped/6to4/Teredo unwrapping, per-socket timeouts plus a whole-request deadline, re-validation of every redirect hop, a hard read cap, and stdlib `html.parser` reading two tags. Every failure — blocked, refused, timed out, 404, no title — returns the same hostname fallback so the endpoint is not an oracle. **Read the SSRF notice at the top of that section before changing anything in it.**

`checkIntervalSec` below 60 is rejected with a 400: 60s is EventBridge Scheduler's floor, so a smaller value would be a lie. Existing rows are not migrated, and `scripts/seed_sites.py` does not apply the floor. The field is stored but not yet honoured — every enabled site is swept every minute.

---

## Frontend

`frontend/` is plain HTML/CSS/JS: **no framework and no build step**. The status pages poll every 20 seconds. The only external scripts are Chart.js (monitor detail) and the Google Fonts stylesheet; icons are hand-written inline SVG in `nav.js`, exposed as `MubwemNav.icon(name)`.

The dark design system lives entirely in `frontend/style.css` — surface/border/status tokens as CSS custom properties, Archivo for headings, Inter for body, JetBrains Mono for figures, a 4px status-coloured left border on cards, one switch component. Dark only; no light counterpart was invented.

### Pages

**URLs carry no `.html`.** A CloudFront Function (`ExtensionlessUrlFunction`) rewrites the path on viewer-request, so `/monitor` fetches `monitor.html` while the address bar keeps the clean URL. The rule is narrow: a URI ending in `/` is left alone, and one whose **last path segment** contains a dot is passed through as a file. The rewrite only ever adds `.html` — an old `/monitor.html` bookmark still works, though only the clean path is a registered Cognito callback.

A persistent side navigation (`nav.js`) is shared by every page. **Monitors** and **Team Members** are shown only to Admins and Editors — presentation, enforced server-side regardless.

| Page | Who | What |
|---|---|---|
| `/` | any signed-in user | Toolbar (search, status, density) over two summary cards and a monitor grid. Each card: status badge, countdown ring, 24-bar hourly history, 24h uptime. |
| `/monitor?site=<siteId>` | any signed-in user | One monitor: large hourly bar, detail stats, a Chart.js 24h response-time graph, up to 50 incidents. Admins and Editors also get an **Edit** form; a Viewer sees no edit control at all, not a disabled one. |
| `/incidents` | any signed-in user | Cross-site incident list, newest first, filterable by monitor. |
| `/sites` | Admins, Editors | Monitor management: enable toggle and (Admins only) delete. |
| `/add-monitor` | Admins, Editors | Full-page create form. "Detect name" calls `POST /admin/sites/preview`. |
| `/team` | Admins | User management. |
| `/settings` | any signed-in user | **Mostly a stub.** Read-only view of deploy-time configuration, plus a working display-timezone picker and (Admins, Editors) an alert-email mute switch. |
| `/integrations` | any signed-in user | **Stub.** The API URLs. No integrations exist. |

The dashboard toolbar filters the `/status` document the page is **already** polling — no request, no backend change, and so no `?q=` or `?status=` parameter on any route. Filtering never re-sorts: the API returns sites down-first then by name, and that ordering survives every filter. The summary cards always describe the whole deployment, with a "Showing 3 of 8 monitors" line making the filtered subset explicit. Status filter and density persist in `localStorage`; search text does not.

Each card's countdown ring is drawn from `lastCheckedAt` plus `scheduleIntervalSec` (published in the generated `config.js`) and ticks once a second. It is an **approximation** — the browser gets no live signal from EventBridge.

> **Every page is a registered Cognito callback, and that list is manual.** The
> `AUTHENTICATED_PAGES` tuple in `infrastructure/stacks/mubwem_stack.py` lists
> the paths the hosted UI may return to. A new page added without touching that
> tuple fails quietly: it works when reached with a live session, and only a
> *cold* load bounces through the hosted UI and lands on the dashboard instead.

`/settings` and `/integrations` are **placeholders, shipped as placeholders**, and say so on the page. There is nothing behind them yet: alerting is one SES sender and one recipient fixed at deploy time, and there are no webhooks, API keys or third-party targets.

The exceptions on `/settings` are the alert-email mute (see [Alerting](#alerting)) and the **display timezone** picker, which is a real control because it is purely local. It decides how the browser renders timestamps — the incident table, the dashboard's incident feed and hourly-bar tooltips, the monitor response-time chart, and the `Started` column of the incidents CSV export. Every absolute time is labelled with its zone, so the same incident never reads as two different times depending on which page you opened it from.

It changes nothing that is recorded. All three Lambdas write ISO8601 UTC with a trailing `Z` via an identical `_iso()` helper, and `UptimeChecks.checkedAt` and `Incidents.startedAt` are DynamoDB sort keys that depend on that fixed-width format sorting lexicographically. Alert emails are rendered in the deployment's `displayTimezone` (labelled with the zone), not the picker's choice — they are built by the checker Lambda, which cannot see a browser's `localStorage`. To get emails in your zone, set `MUBWEM_DISPLAY_TIMEZONE` and redeploy.

Resolution is three layers, highest first: the viewer's choice in `localStorage` (`mubwem.timeZone`, including an explicit "browser local"), then `displayTimezone` from the generated `config.js`, then the browser's own zone. An unknown zone name — a stale saved value, or a typo in CDK context — falls back to browser local rather than throwing.

### Login

`frontend/auth.js` runs OAuth 2.0 authorization code with PKCE against the Cognito hosted UI. The app client is public — a static page cannot keep a secret — so PKCE is what stops an intercepted code being redeemed by anyone else.

The id token is kept in `sessionStorage`, never `localStorage`, and no refresh token is stored. A `localStorage` token outlives the browsing session, turning any XSS on a page showing internal hostnames into a durable credential leak. The cost is re-authenticating in a new tab and hourly on expiry, which the hosted UI's session cookie usually makes invisible.

**Passkeys.** The login page is Cognito's newer *managed login* (the user pool is on the Essentials feature plan, still free up to 10k MAU), which offers a passkey — Face ID, Touch ID, Windows Hello, a phone — as the first sign-in factor, with the password as the fallback. A new user's first sign-in is still the emailed temporary password; after a password sign-in the managed login offers to register a passkey, and **Settings → Sign-in → Add a passkey** does the same on demand (it sends the user to the managed login's `/passkeys/add` page and back). A passkey is per device or password manager, so users add one on each device. No SES, no extra Lambda — Cognito holds the public keys.

Passkeys are bound to the relying party ID, which is the Cognito prefix domain (`<prefix>.auth.<region>.amazoncognito.com`). **Changing `cognitoDomainPrefix` after users have registered passkeys orphans all of them**; users fall back to their password and register again.

The app client allows the `aws.cognito.signin.user.admin` scope because `/passkeys/add` needs it. It only appears in the access token, which `auth.js` discards, and it lets a user manage their own account — never anyone else's.

The frontend never has the API URL or Cognito client details committed to git — the stack generates `config.js` at deploy time and uploads it with the static files.

---

## Roles and access control

Three Cognito **user pool groups**, created by the stack. A user's group arrives in their id token as the `cognito:groups` claim.

| Role | Sites | Alert-email mute | Users | Dashboard |
|---|---|---|---|---|
| **Admins** | create, edit, **delete** | read, change | create, change role, enable/disable, delete | yes |
| **Editors** | create, edit — **no delete** | read, change | no access | yes |
| **Viewers** | no access | no access | no access | yes, read-only |

An Editor who needs a site to stop being checked turns its `enabled` toggle off; deletion has a larger blast radius, so it stays with Admins. Group precedence is `Admins` 1, `Editors` 10, `Viewers` 20 (lower wins), so multiple memberships resolve predictably.

### Where the enforcement is

The JWT authorizer establishes exactly one thing: the caller holds a valid, unexpired id token from this user pool and app client. **It knows nothing about groups.**

Every group decision is made in `lambda/admin/handler.py`, in `_user_groups()` and `_require()`. `_user_groups()` reads `cognito:groups` and returns a `set`, handling the several shapes API Gateway can deliver that claim in. Anything it does not understand — missing, malformed, empty, an unexpected event shape, an exception anywhere — returns the **empty set**, which intersects nothing, so `_require()` answers 403. There is no path through that file where failing to determine the caller's groups grants access. Every route handler calls `_require()` first.

The frontend decodes the same claim to decide which controls to draw. That is **presentation, not security** — the backend refuses regardless; its only job is to avoid offering someone a button that will fail.

Two self-inflicted lockouts are blocked, both with a 409: an admin cannot disable or delete their own account (`_is_self()` compares against the caller's `sub`, `cognito:username` and `email` claims), and cannot demote themselves out of `Admins` if `_is_last_admin()` says they are the last one.

### Bootstrapping the first admin

Groups can only be assigned through the admin panel, and reaching it requires already being in `Admins`. The first user therefore has no group, and one manual CLI call is unavoidable:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <CognitoUserPoolId output> \
  --username you@example.com \
  --group-name Admins \
  --region ap-southeast-2
```

Then sign out and back in — the group lands in a **new** id token, not the one already in `sessionStorage`. Every user after that is created and assigned a role from **Team Members** at `<DashboardUrl>/team`.

### What authentication does not cover

- **CloudFront itself is not access-controlled.** The static HTML, CSS and JS are downloadable by anyone with the URL. Nothing sensitive is in them — sites, statuses and incidents all arrive from the authenticated API — but `config.js` publishes the API URL, Cognito domain and public client id. That is by design for a public OAuth client.
- **CORS is `*`.** The authorizer, not the origin header, protects every route. It stays open so the frontend can run from `localhost` against a deployed API without a redeploy.
- **No MFA, and no logging of who looked at what.**
- **`removalPolicy: DESTROY`** on the tables, the bucket and the user pool. `cdk destroy` takes the dashboard accounts with it. Anything real should use `RETAIN`.
- **Deleting a site does not delete its history.** UptimeChecks and Incidents rows are left orphaned; checks age out on their own TTL.

An earlier build had a per-site `isPublic` flag and an open `GET /public/status` route. Both were removed; nothing reads that flag any more.

---

## Deploy

### Prerequisites

- An AWS account and credentials (`aws configure`, or `AWS_PROFILE`)
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

Nothing environment-specific is committed. Copy the template and fill it in:

```bash
cp .env.example .env               # .env is gitignored
```

| Setting | Env var | Context key | Default |
|---|---|---|---|
| Alert email (**required**) | `MUBWEM_ALERT_EMAIL` | `alertEmail` | none — deploy fails without it |
| Alert *sender* address | `MUBWEM_SENDER_EMAIL` | `senderEmail` | the alert email |
| Bounce/complaint recipient | `MUBWEM_BOUNCE_ALERT_EMAIL` | `bounceAlertEmail` | the alert email |
| Failure threshold | `MUBWEM_FAILURE_THRESHOLD` | `failureThreshold` | `3` |
| HTTP timeout (sec) | `MUBWEM_CHECK_TIMEOUT_SEC` | `checkTimeoutSec` | `8` |
| Check retention (days) | `MUBWEM_CHECKS_TTL_DAYS` | `checksTtlDays` | `30` |
| Schedule | `MUBWEM_SCHEDULE_EXPRESSION` | `scheduleExpression` | `rate(1 minute)` |
| Schedule timezone | `MUBWEM_SCHEDULE_TIMEZONE` | `scheduleTimezone` | `Australia/Sydney` |
| Dashboard default + alert email timezone | `MUBWEM_DISPLAY_TIMEZONE` | `displayTimezone` | the schedule timezone |
| Region | `MUBWEM_REGION` | `region` | `ap-southeast-2` |
| Account | `MUBWEM_ACCOUNT` | `account` | `CDK_DEFAULT_ACCOUNT` |
| Cognito domain prefix | — | `cognitoDomainPrefix` | derived from the stack id |
| Check countdown (sec) | — | `scheduleIntervalSec` | derived from `scheduleExpression` |

The hosted-UI domain prefix must be globally unique across all AWS accounts, so it defaults to `mubwem-` plus the first segment of this stack's CloudFormation id. Override with `-c cognitoDomainPrefix=something-unique` for a friendlier login URL — but pick it before anyone registers a passkey, because passkeys are bound to this domain (see [Login](#login)).

Command-line context wins over both `.env` and `cdk.json`:

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

Deploy prints ten outputs:

| Output | What it is for |
|---|---|
| `DashboardUrl` | the CloudFront dashboard (login required) |
| `SitesAdminUrl` | monitor management — Admins and Editors |
| `TeamAdminUrl` | user management — Admins |
| `ApiUrl` | `GET /status` — needs a Cognito id token |
| `AdminApiUrl` | base path for `/admin/*` — needs a token *and* the right group |
| `CognitoLoginUrl` | the hosted UI login page |
| `CognitoUserPoolId` | needed to create the first user and put them in `Admins` |
| `SitesTableName` | used by `scripts/seed_sites.py` |
| `AlertTopicArn` | SNS topic used as the plain-text alert fallback |
| `DeliveryFailureTopicArn` | SNS topic SES reports bounces and complaints to |

### 4. Verify the email addresses

The deploy sends **three** mails to the configured address. Click all three; check spam.

1. **"Amazon Web Services – Email Address Verification Request"** — SES. Until verified, SES refuses to send and every alert arrives as the plain-text SNS fallback.
2. **"AWS Notification – Subscription Confirmation"** — SNS, for `AlertTopicArn` (the fallback path).
3. **"AWS Notification – Subscription Confirmation"** — SNS again, for `DeliveryFailureTopicArn` (the bounce path). The two look identical; the topic ARN in the body tells them apart, and you need both.

If `senderEmail` differs from `alertEmail`, both need SES verification. If `bounceAlertEmail` is a third address, mail (3) goes there.

> **SES sandbox.** A new account can only send *to* verified addresses. That is fine with one recipient, which is why `senderEmail` defaults to `alertEmail` — one verified address covers both ends. Request production access only if you later need to alert an address you cannot verify.

### 5. Seed your sites (optional)

```bash
cp config/config.example.json config/config.json     # config.json is gitignored
# edit config/config.json with your real test sites
python scripts/seed_sites.py --dry-run              # check what will be written
python scripts/seed_sites.py                        # write to the Sites table
```

The script resolves the table from the stack's `SitesTableName` output, so no table name or ARN is hardcoded. Re-running updates existing sites while preserving `createdAt`; `--prune` also deletes sites no longer in the config. The checker picks up new sites within a minute.

Once you have an Admin, sites are normally added from the **Monitors** page instead. `seed_sites.py` remains the way to load a list in bulk or keep a config file as the source of truth.

### 6. Open the dashboard

Visit `DashboardUrl` and sign in with a user you created (see [Creating a user](#creating-a-user) — there is no self-signup, so do that first). CloudFront can take a few minutes on first deploy.

Running the frontend locally still requires signing in:

```bash
cd frontend && python -m http.server 8000
# then open http://localhost:8000/?api=<ApiUrl output>
```

Add `http://localhost:8000/` to the app client's callback **and** sign-out URLs in the Cognito console, or to `callback_urls` / `logout_urls` in the stack. CORS already allows any origin, so no API change is needed.

### Tearing down

```bash
cd infrastructure && cdk destroy
```

Tables, the frontend bucket and the user pool are set to `DESTROY`, so nothing is left behind — dashboard accounts included.

---

## Creating a user

**The admin panel is the normal path.** Once at least one Admin exists, users are created and given a role on **Team Members** at `<DashboardUrl>/team`. Cognito emails a temporary password (generated server-side, never accepted from the browser) and the user sets a real one on first hosted-UI login.

The CLI below is **bootstrap only** — how the first account comes into existence before any admin panel is reachable. Self-signup is deliberately off.

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <CognitoUserPoolId output> \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --temporary-password "TempPass123!" \
  --region ap-southeast-2
```

Passwords must be at least 8 characters with an uppercase letter, a lowercase letter and a digit. Add `--message-action SUPPRESS` to hand the temporary password over yourself instead of having Cognito email it.

That user exists but is in **no group**, so they can sign in and see nothing else. Put them in `Admins` with the step in [Bootstrapping the first admin](#bootstrapping-the-first-admin).

**Revoking access:** disable or delete the user from the **Team Members** table, or:

```bash
aws cognito-idp admin-disable-user --user-pool-id <id> --username you@example.com --region ap-southeast-2
```

---

## API guide

Everything the dashboard shows comes from one API Gateway HTTP API, and you can call it directly — from `curl`, a script, or another tool. It was built for the dashboard rather than as a public machine API: there are no API keys, no versioning promise and no OpenAPI description, and every call needs a signed-in user's token.

### Base URLs

Both come from the deploy outputs (and from `<DashboardUrl>/config.js`):

| Output | Looks like | Routes under it |
|---|---|---|
| `ApiUrl` | `https://abc123.execute-api.ap-southeast-2.amazonaws.com/status` | `GET /status`, `GET /status/{siteId}` |
| `AdminApiUrl` | `https://abc123.execute-api.ap-southeast-2.amazonaws.com/admin` | everything under `/admin/*` |

The examples below assume:

```bash
export API=https://abc123.execute-api.ap-southeast-2.amazonaws.com   # ApiUrl without /status
export TOKEN=eyJraWQiOi...                                           # a Cognito id token
```

### Getting a token

Every route needs a Cognito **id token** (not the access token) in an `Authorization: Bearer <token>` header. It is valid for **one hour**; after that every call returns `401` and you need a new one.

**Option 1 — copy it from the dashboard (simplest).** Sign in at `DashboardUrl`, open the browser's developer console on any dashboard page and run:

```js
copy(sessionStorage.getItem("mubwem.idToken"))
```

The token is now on your clipboard. This works for passkey users too.

**Option 2 — the AWS CLI, with a password.** The app client allows Cognito's choice-based `USER_AUTH` flow, so a user with a password can get tokens without a browser. The app client id is not a stack output; read it from `<DashboardUrl>/config.js` (`MUBWEM_COGNITO_CLIENT_ID`).

```bash
aws cognito-idp initiate-auth \
  --auth-flow USER_AUTH \
  --client-id <MUBWEM_COGNITO_CLIENT_ID> \
  --auth-parameters USERNAME=you@example.com,PREFERRED_CHALLENGE=PASSWORD,PASSWORD='your-password' \
  --region ap-southeast-2 \
  --query AuthenticationResult.IdToken --output text
```

A brand-new user still holding the emailed temporary password gets a `NEW_PASSWORD_REQUIRED` challenge instead of tokens. Sign in once through the dashboard to set a real password first.

> A token carries the user's role (`cognito:groups`) **as it was at sign-in**. After someone's role changes they need a fresh token — sign out and in again, or re-run the CLI call.

### Conventions

- **Requests:** JSON bodies with `Content-Type: application/json`. Unknown fields are ignored. A body that is not valid JSON is treated as `{}`, which usually means a `400` for a missing field. Booleans must be real JSON `true`/`false` — the string `"false"` is rejected, not guessed at.
- **Responses:** always JSON. Errors are `{"error": "<message>"}` from the Lambdas, or `{"message": "..."}` when API Gateway itself rejects the call before it reaches one.
- **Timestamps:** ISO 8601 in UTC with milliseconds, e.g. `2026-08-27T09:14:03.221Z`. The API never converts to a local timezone.
- **Path parameters:** URL-encode them. A username that is an email address becomes `you%40example.com`.
- **Caching:** `/status` responses carry `cache-control: public, max-age=10`, so a browser may reuse one for up to 10 seconds; `/admin/*` responses are `no-store`.
- **CORS:** any origin is allowed. The token is what protects the API, not the origin.

| Status | Meaning |
|---|---|
| `200` / `201` | success (`201` for a created site or user) |
| `400` | the body or a parameter is invalid; `error` says which |
| `401` | missing, malformed or expired token — returned by API Gateway, `{"message":"Unauthorized"}` |
| `403` | valid token, but your role cannot use this route — `{"error":"forbidden"}` |
| `404` | no such site or user, or no such route |
| `409` | conflict: the site/user already exists, or you tried to delete, disable or demote yourself |
| `500` | something failed server-side; details are in the Lambda's CloudWatch logs, never in the response |

### Endpoint reference

| Method and path | Minimum role | What it does |
|---|---|---|
| `GET /status` | Viewer | every site with status, 24h uptime, hourly history and recent incidents |
| `GET /status/{siteId}` | Viewer | one site, plus its 24h check series and up to 50 incidents |
| `GET /admin/sites` | Editor | every site as stored, admin view |
| `POST /admin/sites` | Editor | create a site (starts disabled unless you say otherwise) |
| `POST /admin/sites/preview` | Editor | suggest a monitor name from a URL's page title |
| `PATCH /admin/sites/{siteId}` | Editor | edit `name`, `url`, `checkIntervalSec`, `enabled` |
| `DELETE /admin/sites/{siteId}` | **Admin** | delete a site |
| `GET /admin/settings` | Editor | read the alert-email mute |
| `PATCH /admin/settings` | Editor | mute or unmute alert email |
| `GET /admin/users` | **Admin** | list users and their role |
| `POST /admin/users` | **Admin** | create a user in a role |
| `PATCH /admin/users/{username}` | **Admin** | change a user's role and/or enable or disable them |
| `DELETE /admin/users/{username}` | **Admin** | delete a user |

"Viewer" means any signed-in user; "Editor" means Editors and Admins. A user in no group can call only the `/status` routes.

### Status endpoints

#### `GET /status` — all sites

```bash
curl -s "$API/status" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "generatedAt": "2026-08-27T09:15:00.000Z",
  "failureThreshold": 3,
  "summary": {
    "upCount": 4, "downCount": 1, "pausedCount": 2, "totalMonitors": 7,
    "overallUptime24h": 99.31,
    "mtbfSeconds": 18042.5,
    "timeSinceLastIncidentSeconds": 5120.0,
    "incidentCount24h": 2
  },
  "sites": [
    {
      "siteId": "example-home",
      "name": "Example Home",
      "url": "https://example.com",
      "status": "up",
      "enabled": true,
      "checkIntervalSec": 60,
      "lastCheckedAt": "2026-08-27T09:14:03.221Z",
      "lastResponseTimeMs": 312,
      "consecutiveFailures": 0,
      "lastStatusChangeAt": "2026-08-26T22:01:10.004Z",
      "uptime24h": 99.86,
      "checks24h": 1437,
      "hourlyBuckets": ["up", "up", "warn", "down", "...24 in total"],
      "incidents": [
        {
          "startedAt": "2026-08-26T21:58:10.004Z",
          "endedAt": "2026-08-26T22:01:10.004Z",
          "durationSec": 180,
          "triggerReason": "3 consecutive failures - Timeout after 8s",
          "resolved": true
        }
      ]
    }
  ]
}
```

Field notes:

- `status` is `up`, `down`, `paused` (the site's `enabled` is off) or `unknown` (never checked yet).
- `sites` is already sorted: down, then unknown, then up, then paused — each group by name.
- `uptime24h` is a percentage to 2dp, or `null` with no checks in the window. Only checks inside a confirmed outage count as down — see [Status API](#status-api).
- `hourlyBuckets` is exactly 24 entries, **oldest first**, one per rolling hour: `up`, `warn` (a failure that never reached the threshold), `down` (part of a confirmed outage) or `none` (no checks).
- `incidents` holds the newest 5 per site. `endedAt` and `durationSec` are `null` while an incident is ongoing.
- In `summary`, `overallUptime24h` is weighted by check count and leaves out paused sites; `mtbfSeconds` needs at least two incidents and is otherwise `null`. Both MTBF and `incidentCount24h` are computed from those 5-per-site incidents, so they describe recent history.

Handy one-liners with [`jq`](https://jqlang.github.io/jq/):

```bash
# Name and status of everything that is down
curl -s "$API/status" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.sites[] | select(.status == "down") | "\(.name)\t\(.url)"'

# Overall 24h uptime
curl -s "$API/status" -H "Authorization: Bearer $TOKEN" | jq '.summary.overallUptime24h'
```

#### `GET /status/{siteId}` — one site in detail

```bash
curl -s "$API/status/example-home" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "generatedAt": "2026-08-27T09:15:00.000Z",
  "failureThreshold": 3,
  "site": {
    "siteId": "example-home",
    "name": "Example Home",
    "...": "every field of a /status site entry, plus:",
    "checks": [
      { "checkedAt": "2026-08-26T09:15:41.118Z", "responseTimeMs": 298, "isUp": true },
      { "checkedAt": "2026-08-26T09:18:40.902Z", "responseTimeMs": null, "isUp": false }
    ],
    "incidents": ["...up to 50, newest first"]
  }
}
```

`checks` is the last 24 hours, oldest first, sampled evenly down to at most 500 points so it still spans the whole day. `responseTimeMs` is `null` for a check that got no response. An unknown `siteId` returns `404 {"error": "no such site"}`.

### Site endpoints

#### `GET /admin/sites` — list sites

```bash
curl -s "$API/admin/sites" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "sites": [
    {
      "siteId": "example-home",
      "name": "Example Home",
      "url": "https://example.com",
      "checkIntervalSec": 60,
      "enabled": true,
      "createdAt": "2026-08-01T02:11:45.120Z"
    }
  ]
}
```

The raw `Sites` rows, sorted by name — no status or uptime. Use `/status` for those.

#### `POST /admin/sites` — create a site

```bash
curl -s -X POST "$API/admin/sites" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Example Shop", "url": "https://shop.example.com", "enabled": true}'
```

| Field | Required | Rules |
|---|---|---|
| `name` | yes | non-empty string, trimmed, truncated to 200 characters |
| `url` | yes | must start with `https://`; truncated to 2000 characters |
| `siteId` | no | slugified (`My Site!` → `my-site`, max 64); derived from `name` if omitted |
| `checkIntervalSec` | no | integer, 60–86400, default `60` — stored but not yet honoured |
| `enabled` | no | `true`/`false`, default **`false`** — a new site is not checked until switched on |

Returns `201 {"site": {...}}` with the stored row. A `siteId` that already exists is `409` — sites are never silently overwritten. The checker picks up an enabled site within a minute.

#### `POST /admin/sites/preview` — suggest a name

```bash
curl -s -X POST "$API/admin/sites/preview" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url": "https://www.example.com/"}'
```

```json
{ "suggestedName": "Example Domain", "hostname": "www.example.com", "detected": true }
```

Fetches the page and reads its title. `detected` is `false` when the name was built from the hostname instead. Anything that stops the fetch — a private address, a timeout, an error page, no title — gives the same hostname-based `200` answer, by design, so the endpoint cannot be used to probe networks. Only a URL that is not `https://` or cannot be parsed is a `400`. Nothing is saved.

#### `PATCH /admin/sites/{siteId}` — edit a site

```bash
# Pause a site
curl -s -X PATCH "$API/admin/sites/example-shop" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

Send any subset of `name`, `url`, `checkIntervalSec`, `enabled` (same rules as create); `siteId` itself cannot change. Returns `200 {"site": {...}}` with the full updated row. An empty update is `400`; an unknown `siteId` is `404`.

#### `DELETE /admin/sites/{siteId}` — delete a site (Admin)

```bash
curl -s -X DELETE "$API/admin/sites/example-shop" -H "Authorization: Bearer $TOKEN"
```

Returns `200 {"deleted": "example-shop"}` — also when no such site existed. Only the `Sites` row is removed; its checks and incidents stay until the checks' TTL expires. To stop checking a site without losing it, `PATCH` it with `{"enabled": false}`.

### Settings endpoints

#### `GET /admin/settings` and `PATCH /admin/settings` — alert-email mute

```bash
curl -s "$API/admin/settings" -H "Authorization: Bearer $TOKEN"

curl -s -X PATCH "$API/admin/settings" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"emailAlertsEnabled": false}'
```

```json
{ "emailAlertsEnabled": false, "updatedAt": "2026-08-27T09:20:11.502Z", "updatedBy": "you@example.com" }
```

`emailAlertsEnabled` must be a JSON boolean. Before anyone has changed it, `GET` returns `true` with `updatedAt`/`updatedBy` as `null`. The checker reads the flag once per sweep, so a change takes effect within a minute. Muting stops `DOWN` and `RESOLVED` email only — incidents still open, close and show on the dashboard. See [Alerting](#alerting).

### User endpoints (Admin only)

#### `GET /admin/users` — list users

```bash
curl -s "$API/admin/users" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "users": [
    {
      "username": "you@example.com",
      "email": "you@example.com",
      "enabled": true,
      "status": "CONFIRMED",
      "createdAt": "2026-08-01 02:10:00.123000+00:00",
      "groups": ["Admins"],
      "role": "Admin"
    }
  ]
}
```

`role` is `Admin`, `Editor`, `Viewer` or `null` (in no group). `status` is Cognito's own user status — `FORCE_CHANGE_PASSWORD` until a new user first signs in. `createdAt` comes straight from Cognito, so unlike every other timestamp in the API it is not in the `...Z` format. Lists up to 300 users.

#### `POST /admin/users` — create a user

```bash
curl -s -X POST "$API/admin/users" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email": "teammate@example.com", "role": "Editor"}'
```

`email` is required and becomes the username (lowercased). `role` is `Admin`, `Editor` or `Viewer`, case-insensitive. Cognito emails the user a temporary password that is generated server-side and never returned to you. Returns `201 {"user": {"username", "email", "role", "enabled", "status"}}`; an existing email is `409`.

#### `PATCH /admin/users/{username}` — change role or enable/disable

```bash
curl -s -X PATCH "$API/admin/users/teammate%40example.com" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"role": "Viewer", "enabled": true}'
```

Send `role`, `enabled`, or both. Returns `200 {"user": {"username", "groups", "role"}}`. The change applies to the user's **next** sign-in — a token they already hold keeps its old role until it expires. `409` if you try to disable yourself, or to leave `Admins` while you are the last admin; `404` for an unknown user.

#### `DELETE /admin/users/{username}` — delete a user

```bash
curl -s -X DELETE "$API/admin/users/teammate%40example.com" -H "Authorization: Bearer $TOKEN"
```

Returns `200 {"deleted": "teammate@example.com"}`. You cannot delete your own account (`409`); an unknown user is `404`.

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
│   ├── checker/
│   │   ├── handler.py      runs every minute, checks all sites, alerts
│   │   └── email_templates.py   HTML + plain-text DOWN / RESOLVED mails
│   ├── api/handler.py      the two /status routes, list and detail
│   └── admin/handler.py    /admin/* — group checks, site CRUD, user management
├── frontend/               static pages (no framework, no build step)
│   ├── index.html          dashboard: summary cards + monitor grid
│   ├── monitor.html        one monitor: hourly bar, response graph, incidents, edit
│   ├── incidents.html      cross-site incident list
│   ├── sites.html          monitor management (Admins, Editors)
│   ├── add-monitor.html    full-page create form (Admins, Editors)
│   ├── team.html           user management (Admins)
│   ├── settings.html       deploy config (read-only), timezone, email mute, passkeys
│   ├── integrations.html   stub: API URLs, no integrations
│   ├── app.js              dashboard bootstrap: sign in, then poll GET /status
│   ├── auth.js             Cognito hosted UI login (auth code + PKCE)
│   ├── nav.js              shared side navigation and inline SVG icons
│   ├── shell.js            per-page bootstrap: auth, nav, fetch, formatting
│   ├── dashboard.js        monitor-card rendering
│   ├── style.css           the whole design system
│   └── *.js                one bootstrap module per page
├── config/
│   ├── config.example.json committed placeholders
│   └── config.json         gitignored — your real sites
├── docs/                   architecture diagram (draw.io source + SVG)
├── scripts/seed_sites.py   seeds the Sites table from config.json
└── LICENSE                 MIT
```

## Roadmap (later phases)

- Multi-region checks with quorum before alerting
- Historical uptime rollups instead of computing 24h uptime on every read
- Honouring per-site `checkIntervalSec` instead of a fixed one-minute sweep
- SSL certificate expiry and keyword-match checks
- Per-site alert routing (Slack, SMS), maintenance windows and per-site thresholds — everything `/settings` currently stands in for
- Webhooks, third-party targets, API keys and a published OpenAPI description — everything `/integrations` currently stands in for
- A real incident history. `/incidents` is assembled from the dashboard feed, which carries only the 5 most recent incidents per monitor, so it shows recent history rather than a complete log. A full view needs a paginated cross-site query over a table that only grows.
- Federating the Cognito pool to organizational SSO, and WAF/IP restriction in front of CloudFront
- An audit log of admin actions — who changed which site or role, and when
