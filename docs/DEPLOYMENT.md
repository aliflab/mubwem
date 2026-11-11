# Deploying MuBWeM to an AWS account

A step-by-step runbook for deploying MuBWeM from the GitHub repo into **any** AWS account, using **AWS CloudShell** in the browser — nothing to install on your own computer and no access keys to manage. It ends with how to roll back a change and how to remove the app completely.

The README's [Deploy](../README.md#deploy) section covers the same deploy from a local terminal. This document is the browser-only path, with every problem hit along the way and its fix.

**Contents** — [Before you start](#before-you-start) · [1. Open CloudShell](#1-open-cloudshell-in-the-target-account) · [2. Prepare CloudShell](#2-prepare-cloudshell-once-per-account) · [3. Get the code](#3-get-the-code) · [4. Bootstrap](#4-bootstrap-cdk-once-per-account-and-region) · [5. Deploy](#5-deploy-two-passes-on-a-new-account) · [6. Confirm emails](#6-confirm-the-emails) · [7. Sign in](#7-sign-in-and-set-up) · [8. Find resources and costs](#8-find-every-mubwem-resource-and-its-cost) · [Updating](#updating-to-new-code) · [CloudShell was reset](#cloudshell-was-reset) · [Troubleshooting](#troubleshooting) · [Rollback](#rollback) · [Deleting the app](#deleting-the-app)

---

## Before you start

You need:

- **Console access to the target AWS account** with administrator-level permissions. The deploy creates IAM roles, Cognito, CloudFront, Lambda, DynamoDB, SES, SNS and S3.
- **Read access to the GitHub repo** (`github.com/aliflab/mubwem`). If it is private, also a GitHub **personal access token** with read access to it (GitHub → Settings → Developer settings → Fine-grained tokens) — git asks for it in place of a password.
- **An alert email address** whose inbox you can read. It receives the verification mails and every alert.
- **An owner email address** for the first dashboard account. Usually the same address.

Placeholders used below — replace them with your own values:

| Placeholder | Meaning | Example |
|---|---|---|
| `<ALERT_EMAIL>` | where alerts are sent (and sent from, while SES is in its sandbox) | `itsupport@yourcompany.com` |
| `<OWNER_EMAIL>` | the first dashboard user, created in the `Owners` group | `itsupport@yourcompany.com` |
| `<REGION>` | the AWS region to deploy to | `ap-southeast-2` (the default) |

> **What the app costs.** Mostly free-tier at this scale. The once-a-minute checker and its stored history run all the time, so expect a small monthly charge. Set a budget alert under **Billing → Budgets** in a new account.

---

## 1. Open CloudShell in the target account

1. Sign in to the **target** AWS account in the browser.
2. Set the region selector (top right) to `<REGION>`. **CloudShell deploys to whichever region it is opened in.**
3. Open CloudShell: the `>_` icon in the top bar, or search "CloudShell".
4. Confirm you are in the right account:

   ```bash
   aws sts get-caller-identity
   ```

   Note the `Account` number. Every later step acts on this account.

---

## 2. Prepare CloudShell (once per account)

Three CloudShell facts shape this section:

- **Only your home folder survives between sessions.** Anything installed system-wide — a `dnf` package, a global `npm` package — is gone the next time CloudShell starts. So every tool is either installed into the home folder or reinstalled automatically from `~/.bashrc`.
- **The home folder is 1 GB.** The Python dependencies alone take 350–450 MB, so keep one copy of the code and no download caches.
- **The home folder is deleted after 120 days without being opened.** If that happens, repeat sections 2 and 3. The deployed app itself is unaffected.

### 2.1 Fix the home folder permissions

CloudShell's home folder is world-writable, and the CDK Python library refuses to use its package cache there (`Cannot use the jsii package cache ... mode 0777`). Lock it down, and disable that cache as a backstop:

```bash
chmod 755 ~
echo 'export JSII_RUNTIME_PACKAGE_CACHE=disabled' >> ~/.bashrc
echo 'export JSII_SILENCE_WARNING_DEPRECATED_NODE_VERSION=1' >> ~/.bashrc
```

The second line only hides a "Node 20 is end-of-life" banner. It is a warning, not an error.

### 2.2 Save your configuration

Settings are read from `MUBWEM_*` environment variables, so saving them in `~/.bashrc` means every later command picks them up with no flags:

```bash
echo 'export MUBWEM_ALERT_EMAIL=<ALERT_EMAIL>' >> ~/.bashrc
# Optional - only if not ap-southeast-2. Must match the region CloudShell is open in.
# echo 'export MUBWEM_REGION=<REGION>' >> ~/.bashrc
```

`MUBWEM_ALERT_EMAIL` is **required by every CDK command**, `cdk bootstrap` included — without it the stack refuses to load (`Context value 'alertEmail' must be set to a real address`).

Other optional settings (failure threshold, timeouts, timezone, separate sender or bounce address) are listed in the README's [configuration table](../README.md#2-set-your-configuration). Add them the same way.

**Do not** put `MUBWEM_OWNER_EMAIL` in `.bashrc`. The owner is created once, on the first deploy, with a flag — see step 5.

### 2.3 Install the tools

**Python 3.11.** CloudShell's default `python3` is older than the project needs, and a `dnf` install does not survive a restart — so `.bashrc` reinstalls it whenever it is missing:

```bash
echo 'command -v python3.11 >/dev/null || sudo dnf install -y -q python3.11' >> ~/.bashrc
```

**The CDK CLI.** CloudShell ships a `cdk`, but it lags behind the CDK library pip installs, and then every command fails with `Cloud assembly schema version mismatch`. Updating the built-in one fails (`EACCES`) and would not survive a restart anyway. Install a current one into the home folder instead, and point `cdk` at it:

```bash
npm config set prefix ~/.npm-global
npm install -g aws-cdk
npm cache clean --force
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc
echo 'alias cdk="$HOME/.npm-global/bin/cdk"' >> ~/.bashrc
```

The alias matters: activating the Python venv reorders `PATH`, and without it `cdk` can silently fall back to the old built-in CLI even though `cdk --version` showed the new one a moment earlier.

**Load it all:**

```bash
source ~/.bashrc
cdk --version
```

`cdk --version` should print `2.1148.0` or newer.

---

## 3. Get the code

Clone the repo into the home folder. With git, an update is one `git pull`, and files deleted from the repo are deleted here too — re-uploading a zip leaves them behind, so a removed page would still be deployed.

```bash
cd ~
git clone https://github.com/aliflab/mubwem.git
cd mubwem
```

For a private repo, git asks for a username and password: give your GitHub username and the **personal access token** as the password. Your GitHub account password is not accepted.

> The steps below need a version of the repo that has the `passkeys` context flag (see [step 5](#5-deploy-two-passes-on-a-new-account)). Older versions cannot be deployed to a fresh account in one go.

Then install the Python dependencies into a venv inside the clone:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install --no-cache-dir -r infrastructure/requirements.txt -r scripts/requirements.txt
```

`--no-cache-dir` stops pip keeping a second copy of every download, which the 1 GB home folder has no room for.

**No git access from the account?** On GitHub choose **Code → Download ZIP**, then in CloudShell **Actions → Upload file**, `unzip mubwem-main.zip`, and use `~/mubwem-main` wherever this document says `~/mubwem`. Delete the zip afterwards to save space.

---

## 4. Bootstrap CDK (once per account and region)

```bash
cd ~/mubwem/infrastructure
cdk bootstrap
```

This creates a `CDKToolkit` CloudFormation stack: an S3 bucket CDK uploads the Lambda code and website files to, and the IAM roles it deploys with. Success ends with `✅ Environment aws://<account>/<region> bootstrapped.`

---

## 5. Deploy (two passes on a new account)

A **brand-new** account needs **two** deploys. Cognito only accepts the login domain as the passkey "relying party" once that domain is attached to the user pool, and the domain can only be created after the pool. Deploying with passkeys on straight away fails with:

```
RelyingPartyId cannot be reserved domain other than User Pool's prefix domain
```

So the first deploy goes out with passkeys off, and the second switches them on.

### 5.1 First deploy — passkeys off, create the owner

```bash
cdk deploy -c passkeys=false -c ownerEmail=<OWNER_EMAIL>
```

CDK prints a table of IAM changes and asks `Do you wish to deploy these changes? (y/n)`. What it lists is expected for this stack:

- API Gateway may invoke `ApiFunction` / `AdminFunction`, only on their own routes.
- Each Lambda reads or writes only its own DynamoDB tables; the status API is read-only.
- `AdminFunction` manages users in **this** user pool only.
- SES sending is limited to the configured sender and configuration set; SES may publish bounces only from this account.
- The frontend bucket is HTTPS-only and readable only by this CloudFront distribution.
- `cloudfront:CreateInvalidation` on `*` — the one broad grant. It comes from CDK's standard frontend-upload helper.

Check the account number in the table is the one you meant, then type `y`. The first deploy takes **5–10 minutes**, mostly CloudFront. Keep the CloudShell tab active — it disconnects after about 20 minutes idle.

### 5.2 Second deploy — passkeys on

```bash
cdk deploy
```

No flags. This one takes under a minute.

Leaving `ownerEmail` out from now on is **safe**: the Owner's Cognito resources are set to `RETAIN`, so dropping them from the template leaves the user in place.

### 5.3 Save the outputs

The deploy ends with `✅ MubwemStack` and ten outputs. The ones you will use:

| Output | Use |
|---|---|
| `DashboardUrl` | the app — bookmark this |
| `TeamAdminUrl` | add users |
| `SitesAdminUrl` | manage monitors |
| `CognitoUserPoolId` | only needed for CLI user management |

They are always available later under **CloudFormation → Stacks → MubwemStack → Outputs**.

To confirm passkeys are on: **Cognito → User pools → mubwem-users → Authentication methods** should show passkey enabled, with relying party `mubwem-<id>.auth.<REGION>.amazoncognito.com`.

---

## 6. Confirm the emails

`<ALERT_EMAIL>` receives three mails. Click the link in all three, and check spam:

1. **"Amazon Web Services – Email Address Verification Request"** — SES. Until clicked, every alert arrives as a plain-text fallback instead of the designed HTML email.
2. **"AWS Notification – Subscription Confirmation"** for the **AlertTopic** — the fallback alert path.
3. **"AWS Notification – Subscription Confirmation"** for the **DeliveryFailureTopic** — bounce and complaint reports.

Mails 2 and 3 look identical; the topic name in the body tells them apart. Ignore any that arrived from an earlier failed deploy — they point at deleted resources.

Check the result under **SES → Identities**: the address should be *Verified*.

> **SES sandbox.** A new account can only send to *verified* addresses. That is fine while all alerts go to `<ALERT_EMAIL>`. To alert other addresses, request production access under **SES → Account dashboard**.

---

## 7. Sign in and set up

1. Open `DashboardUrl`. If it does not load, CloudFront is still propagating — wait a few minutes.
2. Sign in as `<OWNER_EMAIL>` with the **temporary password Cognito emailed**, and set a real password. The managed login then offers to register a passkey.
3. **Add monitors:** Monitors → Add monitor. The checker picks a new site up within a minute.
4. **Add your team:** Team Members (`TeamAdminUrl`). Each new user is emailed a temporary password.

No password email? **Cognito → User pools → mubwem-users → Users** — confirm the user exists, then **Reset password**.

From here, the app runs entirely on AWS. **CloudShell can be closed** — it is only needed to deploy changes.

---

## 8. Find every MuBWeM resource and its cost

### Everything the stack owns

**CloudFormation → Stacks → MubwemStack → Resources** is the authoritative list, with links to each resource.

For a single cross-service view: **Resource Groups & Tag Editor → Create resource group** → *CloudFormation stack based* → stack `MubwemStack` → name it `mubwem`. It stays current as the stack changes.

### The `project=mubwem` tag

Every taggable resource in the stack carries `project=mubwem`. List them from CloudShell:

```bash
aws resourcegroupstaggingapi get-resources --tag-filters Key=project,Values=mubwem \
  --query 'ResourceTagMappingList[].ResourceARN' --output table
```

To see MuBWeM's cost on its own: **Billing and Cost Management → Cost allocation tags** → tick `project` under *User-defined tags* → **Activate**. The tag can take up to 24 hours to appear there after the first deploy, and costs are labelled from activation onwards only. Then in **Cost Explorer**, *Group by → Tag → project*.

### Not in the stack, but created because of it

| What | Where | Note |
|---|---|---|
| Lambda log groups | CloudWatch → Log groups, prefix `/aws/lambda/MubwemStack` | Created by Lambda on first run, untagged, and **left behind when the stack is deleted** |
| CDK bootstrap stack `CDKToolkit` | CloudFormation → Stacks | Shared by every CDK app in this account and region |

Resources that cannot carry tags at all (the EventBridge schedule, the CloudFront Function, Cognito users and groups) are still in the stack's Resources tab.

---

## Updating to new code

Every change — Lambda code, frontend pages, infrastructure or settings — goes live the same way: get the new code into CloudShell, then `cdk deploy`. CDK works out what changed and updates only that.

1. **On your computer:** make the change, commit, and push to GitHub.
2. **In CloudShell:**

   ```bash
   cd ~/mubwem && source .venv/bin/activate
   git pull
   pip install --no-cache-dir -r infrastructure/requirements.txt -r scripts/requirements.txt
   cd infrastructure
   cdk diff        # optional: shows what will change, writes nothing
   cdk deploy
   ```

The `pip install` is a no-op unless the requirements changed. Plain `cdk deploy` — never `ownerEmail` or `passkeys=false` again.

| You changed | What happens | Live |
|---|---|---|
| `lambda/*` | new code uploaded to the Lambda | immediately — the checker uses it on its next minute |
| `frontend/*` | files re-uploaded to S3, CloudFront cache invalidated | 1–2 minutes; hard-refresh the browser (Ctrl+F5) |
| `infrastructure/*` | CloudFormation updates those resources | when the deploy finishes — **read `cdk diff` first** |
| a setting | edit it in `~/.bashrc`, `source ~/.bashrc`, deploy | when the deploy finishes |

Before an infrastructure deploy, check `cdk diff` for any DynamoDB table, the user pool or the frontend bucket marked **replace** or **destroy**. All three are set to `DESTROY`, so replacing one deletes its data. Back up first ([below](#back-up-the-data-first)).

`cdk.out` (CDK's build folder) is rebuilt on every deploy. If the home folder runs low, `rm -rf ~/mubwem/infrastructure/cdk.out` is always safe.

If `cdk` fails with `Cloud assembly schema version mismatch` after a `pip install`, the library has moved ahead of the CLI again: `npm install -g aws-cdk && npm cache clean --force`.

---

## CloudShell was reset

CloudShell deletes the home folder after 120 days without being opened, and **Actions → Delete** wipes it on demand. Either way, **the app is not affected.** CloudShell only ever held a copy of the code and the deploy tools; the running app, its monitors, history and users all live in AWS.

What is gone: the `~/mubwem` clone, `.venv`, the CDK CLI, and **the settings saved in `~/.bashrc`**. The settings are the only part that needs care: if `.bashrc` disagrees with what is deployed, the next `cdk deploy` changes the live app to match `.bashrc`.

### 1. Recover the deployed settings

**Lambda → Functions →** the `MubwemStack-CheckerFunction…` function **→ Configuration → Environment variables** shows the live values. Map them back:

| Lambda shows | Set in `.bashrc` as | Needed when |
|---|---|---|
| `ALERT_EMAIL` | `MUBWEM_ALERT_EMAIL` | always |
| `SENDER_EMAIL` | `MUBWEM_SENDER_EMAIL` | it differs from `ALERT_EMAIL` |
| `FAILURE_THRESHOLD` | `MUBWEM_FAILURE_THRESHOLD` | it is not `3` |
| `CHECK_TIMEOUT_SEC` | `MUBWEM_CHECK_TIMEOUT_SEC` | it is not `8` |
| `CHECKS_TTL_DAYS` | `MUBWEM_CHECKS_TTL_DAYS` | it is not `30` |
| `NOTIFICATIONS_TTL_DAYS` | `MUBWEM_NOTIFICATIONS_TTL_DAYS` | it is not `90` |
| `DISPLAY_TIMEZONE` | `MUBWEM_DISPLAY_TIMEZONE` | it is not `Australia/Sydney` |
| `CHECK_REGION` | `MUBWEM_REGION` | it is not `ap-southeast-2` |

Settings the Lambda does not show:

- **Bounce address** (`MUBWEM_BOUNCE_ALERT_EMAIL`) — **SNS → Topics →** `MubwemStack-DeliveryFailureTopic…` **→ Subscriptions** shows the endpoint. Set it only if it differs from the alert email.
- **Schedule** (`MUBWEM_SCHEDULE_EXPRESSION`, `MUBWEM_SCHEDULE_TIMEZONE`) — **EventBridge → Scheduler → Schedules →** the MuBWeM schedule. Set them only if not `rate(1 minute)` and `Australia/Sydney`.
- **Login domain** (`cognitoDomainPrefix`) — only if one was set by hand: it is the part before `.auth.` in the `CognitoLoginUrl` output. Pass it as `-c cognitoDomainPrefix=...` on every deploy. Getting this wrong moves the login URL and orphans every passkey.

### 2. Rebuild CloudShell

Follow [section 2](#2-prepare-cloudshell-once-per-account) with the values from step 1, then [section 3](#3-get-the-code). About ten minutes.

**Skip** `cdk bootstrap` — the `CDKToolkit` stack is still in the account — and never pass `-c ownerEmail` or `-c passkeys=false`. Both were for the first deploy only.

### 3. Prove nothing will change

Before deploying any code change:

```bash
cd ~/mubwem && source .venv/bin/activate && cd infrastructure
git checkout <commit-sha-last-deployed>    # only if main has moved on since the last deploy
cdk diff
```

On the code that is already live, this must say **"There were no differences"**. Anything else means a setting is wrong: fix `.bashrc`, `source ~/.bashrc`, and diff again. Only then `git checkout main` (if you moved off it) and carry on with [Updating to new code](#updating-to-new-code).

If you do not know which commit is live, skip the checkout and read the diff instead: changes that come from new commits are expected; a changed environment variable, email or schedule that no commit touched is a wrong setting.

### Avoiding it

- **Open CloudShell now and then.** Any session resets the 120-day count.
- **Keep a private copy of the settings** — a password manager or an internal wiki, never this repo, which carries no real email addresses. Print them with:

  ```bash
  grep MUBWEM ~/.bashrc
  ```

- **Or deploy from a computer instead.** The README's [Deploy](../README.md#deploy) section does the same thing from a local terminal, with settings kept in a gitignored `.env`.

---

## Troubleshooting

Every error below was hit on a real deployment.

| Error | Cause | Fix |
|---|---|---|
| `npm error code EACCES ... /usr/lib/nodejs20/lib/node_modules/aws-cdk` | CloudShell's global npm folder is root-owned | Install the CLI into the home folder instead ([step 2.3](#23-install-the-tools)) |
| `This CDK CLI is not compatible with the CDK library` / `Cloud assembly schema version mismatch` | The CLI is older than the CDK library pip installed | [Step 2.3](#23-install-the-tools). If `cdk --version` is new but the error persists, the alias is missing and `cdk` is the old built-in one — `which -a cdk` shows both |
| `python3.11: command not found` | A new CloudShell session reset system packages | `sudo dnf install -y python3.11`; the `.bashrc` line in [step 2.3](#23-install-the-tools) does this automatically from then on |
| `OSError: [Errno 28] No space left on device` | The 1 GB home folder is full — usually a second copy of the code, pip's cache or `cdk.out` | `du -sh ~/* ~/.[!.]*` to find it; `rm -rf ~/.cache/pip ~/mubwem/infrastructure/cdk.out` and any old copy; reinstall with `--no-cache-dir` |
| `git clone` asks for a password and rejects it | Private repo, account password given | Use a GitHub personal access token as the password |
| `Node 20 is end-of-life and not supported anymore` | CloudShell ships Node 20 | Warning only. Hidden by `JSII_SILENCE_WARNING_DEPRECATED_NODE_VERSION=1` |
| `Cannot use the jsii package cache ... has a parent directory /home/cloudshell-user that is writable by group or others (mode 0777)` | CloudShell home is world-writable | [Step 2.1](#21-fix-the-home-folder-permissions) |
| `Context value 'alertEmail' must be set to a real address` | `MUBWEM_ALERT_EMAIL` not set in this shell | [Step 2.2](#22-save-your-configuration), then `source ~/.bashrc` |
| `RelyingPartyId cannot be reserved domain other than User Pool's prefix domain` | First deploy to a new account with passkeys on | Deploy with `-c passkeys=false` first ([step 5](#5-deploy-two-passes-on-a-new-account)) |
| Deploy fails creating `PrimaryOwnerUser` — user already exists | `ownerEmail` passed for a user already in the pool (e.g. created by hand) | Deploy without `ownerEmail` |
| Stack is in `ROLLBACK_COMPLETE` | The very first deploy failed | Just run `cdk deploy` again — CDK deletes the empty stack and recreates it. Or delete it in the CloudFormation console |
| Dashboard URL does not load straight after deploy | CloudFront still propagating | Wait a few minutes |
| Alerts arrive as plain text | SES identity not verified | Click the SES verification email ([step 6](#6-confirm-the-emails)) |

---

## Rollback

CloudFormation rolls a **failed** deploy back automatically, so a failed update leaves the previous working version running. The cases below are for undoing a deploy that **succeeded** but should not have.

### Roll back to an earlier version of the code

CDK has no "undo"; you roll back by deploying the older code.

**The normal way — revert in git.** On your computer, `git revert <commit-sha>` the bad commit (or commits) and push. Then deploy exactly as in [Updating to new code](#updating-to-new-code). The history keeps both the change and its undo, and the next `git pull` cannot bring the bad code back.

**The emergency way — deploy an old commit directly from CloudShell:**

```bash
cd ~/mubwem && source .venv/bin/activate
git log --oneline -15          # find the last good commit
git checkout <commit-sha>
cd infrastructure
cdk diff
cdk deploy
```

This leaves CloudShell on that old commit. Once a fix is pushed to GitHub, return with `git checkout main && git pull` and deploy again. Until then, do not `git pull` and deploy — that puts the bad code straight back.

Either way, **read `cdk diff` before deploying.** Look for any DynamoDB table, the user pool or the frontend bucket marked **replace** or **destroy**. All three are set to `DESTROY`, so replacing one **deletes its data** — monitors, history, incidents or user accounts. Do not deploy a rollback that replaces them without a backup ([below](#back-up-the-data-first)).

Rolling back code does **not** roll back data. Rows written by the newer version stay in the tables.

### Undo a configuration change

Change the value back in `~/.bashrc` (or pass the old value with `-c`), `source ~/.bashrc`, then `cdk deploy`.

Two settings deserve care:

- **`cognitoDomainPrefix`** — changing it moves the login URL and orphans every registered passkey; users fall back to their password and re-register.
- **`passkeys=false`** on an existing deployment — switches passkey sign-in off for everyone. Their passkeys still exist and work again once it is switched back on.

### A stuck stack

If an update fails *and* its rollback fails, the stack shows `UPDATE_ROLLBACK_FAILED`. In **CloudFormation → MubwemStack → Stack actions → Continue update rollback**. If a resource blocks it, the console lets you skip that resource; fix it by hand afterwards.

### Pause monitoring without deleting anything

- **Stop alert emails only:** Settings page → Email → off. Checks and incidents carry on.
- **Stop checking altogether:** **EventBridge → Scheduler → Schedules** → the MuBWeM schedule → **Disable**. The dashboard stays up with frozen data. The next `cdk deploy` re-enables it.

---

## Deleting the app

This removes MuBWeM from the account completely. **It cannot be undone.** The tables, the frontend bucket and the user pool are set to `DESTROY`: every monitor, check, incident, notification and **dashboard user account** is deleted with the stack.

### Back up the data first

Skip this if nothing needs keeping.

- **Tables:** **DynamoDB → Tables** → each `MubwemStack-*` table → **Backups → Create backup**. On-demand backups outlive the table and can be restored into a new table later. Alternatively **Exports to S3**, which needs point-in-time recovery switched on.
- **Monitor list only:** the Monitors page shows them all; or keep a `config/config.json` for `scripts/seed_sites.py` to reload later.
- **Users:** cannot be backed up with their passwords or passkeys. Note who had access and their roles, from the Team Members page.

### 1. Delete the stack

From CloudShell:

```bash
cd ~/mubwem && source .venv/bin/activate && cd infrastructure
cdk destroy
```

Confirm with `y`. Or, without CloudShell: **CloudFormation → Stacks → MubwemStack → Delete**.

Deletion takes 5–15 minutes; disabling the CloudFront distribution is the slow part. The stack disappears from the list when done. If it ends in `DELETE_FAILED`, the **Events** tab names the resource — usually something edited by hand outside the stack. Remove or fix it, then delete again.

This removes the DynamoDB tables, Lambdas, API, schedule, Cognito user pool (and every user in it), the S3 frontend bucket and its files, the CloudFront distribution, SNS topics and their subscriptions, and the SES identity and configuration set.

### 2. Delete the leftovers

These survive the stack deletion:

1. **Lambda log groups** — **CloudWatch → Log groups**, filter `/aws/lambda/MubwemStack`, select all → **Delete**. Or from CloudShell:

   ```bash
   for g in $(aws logs describe-log-groups --log-group-name-prefix /aws/lambda/MubwemStack \
                --query 'logGroups[].logGroupName' --output text); do
     aws logs delete-log-group --log-group-name "$g"
   done
   ```

2. **DynamoDB backups** you made above — keep or delete under **DynamoDB → Backups**. They are billed while they exist.
3. **The resource group** — **Resource Groups → mubwem → Delete**, if you created one.
4. **The cost allocation tag** — **Billing → Cost allocation tags** → `project` → **Deactivate**, if nothing else uses it.

### 3. Remove the CDK bootstrap (only if nothing else uses CDK here)

`CDKToolkit` is shared by **every** CDK app in this account and region. Delete it only if MuBWeM was the only one — check **CloudFormation → Stacks** for other CDK-deployed stacks first.

1. **CloudFormation → Stacks → CDKToolkit → Delete.**
2. The staging bucket is retained on purpose and survives that. **S3 → `cdk-hnb659fds-assets-<account>-<region>`** → **Empty** (it is versioned; *Empty* removes every version) → **Delete**.
3. If **ECR** still shows `cdk-hnb659fds-container-assets-<account>-<region>`, delete it too.

### 4. Clean up CloudShell

**CloudShell → Actions → Delete** wipes the home folder: the code, `.venv`, the CDK CLI and the saved settings in `.bashrc`.

### 5. Confirm nothing is left

```bash
aws resourcegroupstaggingapi get-resources --tag-filters Key=project,Values=mubwem \
  --query 'ResourceTagMappingList[].ResourceARN' --output table
aws cloudformation describe-stacks --stack-name MubwemStack
```

The first should print an empty table; the second should fail with `Stack with id MubwemStack does not exist`. Tag listings can lag deleted resources by a while, so an ARN that lingers in the first is worth checking in its console before worrying about it.
