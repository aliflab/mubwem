# Deploying MuBWeM to an AWS account

A step-by-step runbook for deploying MuBWeM from the GitHub repo into **any** AWS account, using **AWS CloudShell** in the browser — nothing to install on your own computer and no access keys to manage. It ends with how to roll back a change and how to remove the app completely.

The README's [Deploy](../README.md#deploy) section covers the same deploy from a local terminal. This document is the browser-only path, with every problem hit along the way and its fix.

**Contents** — [Before you start](#before-you-start) · [1. Get the code](#1-get-the-code) · [2. Open CloudShell](#2-open-cloudshell-in-the-target-account) · [3. Prepare CloudShell](#3-prepare-cloudshell-once-per-account) · [4. Bootstrap](#4-bootstrap-cdk-once-per-account-and-region) · [5. Deploy](#5-deploy-two-passes-on-a-new-account) · [6. Confirm emails](#6-confirm-the-emails) · [7. Sign in](#7-sign-in-and-set-up) · [8. Find resources and costs](#8-find-every-mubwem-resource-and-its-cost) · [Updating](#updating-to-new-code) · [Troubleshooting](#troubleshooting) · [Rollback](#rollback) · [Deleting the app](#deleting-the-app)

---

## Before you start

You need:

- **Console access to the target AWS account** with administrator-level permissions. The deploy creates IAM roles, Cognito, CloudFront, Lambda, DynamoDB, SES, SNS and S3.
- **Access to the GitHub repo** (`github.com/aliflab/mubwem`) to download it as a zip.
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

## 1. Get the code

On GitHub, open the repo and choose **Code → Download ZIP**. You get `mubwem-main.zip`.

Use the GitHub zip rather than zipping your local folder: it has no `.venv`, no `cdk.out` and, most importantly, no `.env` with someone else's settings.

> The steps below assume a version of the repo that has the `passkeys` context flag (see [step 5](#5-deploy-two-passes-on-a-new-account)). Older versions cannot be deployed to a fresh account in one go.

---

## 2. Open CloudShell in the target account

1. Sign in to the **target** AWS account in the browser.
2. Set the region selector (top right) to `<REGION>`. **CloudShell deploys to whichever region it is opened in.**
3. Open CloudShell: the `>_` icon in the top bar, or search "CloudShell".
4. Confirm you are in the right account:

   ```bash
   aws sts get-caller-identity
   ```

   Note the `Account` number. Every later step acts on this account.

---

## 3. Prepare CloudShell (once per account)

CloudShell keeps your home folder between sessions, so this section is done once. CloudShell deletes the home folder after **120 days without being opened** — if that happens, repeat this section. The deployed app itself is unaffected.

### 3.1 Upload and unzip the code

**Actions → Upload file** → pick `mubwem-main.zip`, then:

```bash
unzip mubwem-main.zip
cd mubwem-main
```

### 3.2 Fix the home folder permissions

CloudShell's home folder is world-writable, and the CDK Python library refuses to use its package cache there (`Cannot use the jsii package cache ... mode 0777`). Lock it down, and disable that cache as a backstop:

```bash
chmod 755 ~
echo 'export JSII_RUNTIME_PACKAGE_CACHE=disabled' >> ~/.bashrc
echo 'export JSII_SILENCE_WARNING_DEPRECATED_NODE_VERSION=1' >> ~/.bashrc
```

The second line only hides a "Node 20 is end-of-life" banner. It is a warning, not an error.

### 3.3 Save your configuration

Settings are read from `MUBWEM_*` environment variables, so saving them in `~/.bashrc` means every later command picks them up with no flags:

```bash
echo 'export MUBWEM_ALERT_EMAIL=<ALERT_EMAIL>' >> ~/.bashrc
# Optional - only if not ap-southeast-2. Must match the region CloudShell is open in.
# echo 'export MUBWEM_REGION=<REGION>' >> ~/.bashrc
source ~/.bashrc
```

`MUBWEM_ALERT_EMAIL` is **required by every CDK command**, `cdk bootstrap` included — without it the stack refuses to load (`Context value 'alertEmail' must be set to a real address`).

Other optional settings (failure threshold, timeouts, timezone, separate sender or bounce address) are listed in the README's [configuration table](../README.md#2-set-your-configuration). Add them the same way.

**Do not** put `MUBWEM_OWNER_EMAIL` in `.bashrc`. The owner is created once, on the first deploy, with a flag — see step 5.

### 3.4 Install the tools

```bash
sudo dnf install -y python3.11
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r infrastructure/requirements.txt -r scripts/requirements.txt
```

CloudShell's default `python3` is older than the 3.11 the project needs, hence the explicit install.

The CDK CLI (`cdk`) is **already installed** in CloudShell. `npm install -g aws-cdk` fails there with `EACCES` — that is harmless. To update it anyway, use `sudo npm install -g aws-cdk`.

---

## 4. Bootstrap CDK (once per account and region)

```bash
cd ~/mubwem-main/infrastructure
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

1. Download a fresh zip from GitHub.
2. In CloudShell:

   ```bash
   rm -f ~/mubwem-main.zip
   ```

3. **Actions → Upload file** → the new zip, then:

   ```bash
   cd ~ && unzip -o mubwem-main.zip
   cd mubwem-main && source .venv/bin/activate
   pip install -r infrastructure/requirements.txt -r scripts/requirements.txt
   cd infrastructure
   cdk diff        # optional: shows what will change, writes nothing
   cdk deploy
   ```

`unzip -o` overwrites the code but keeps `.venv`. The `pip install` is a no-op unless the requirements changed.

To change a setting, edit it in `~/.bashrc` (or pass `-c key=value` once), `source ~/.bashrc`, and `cdk deploy`.

---

## Troubleshooting

Every error below was hit on a real deployment.

| Error | Cause | Fix |
|---|---|---|
| `npm error code EACCES ... /usr/lib/nodejs20/lib/node_modules/aws-cdk` | CloudShell's global npm folder is root-owned | Ignore — `cdk` is preinstalled. Or `sudo npm install -g aws-cdk` |
| `Node 20 is end-of-life and not supported anymore` | CloudShell ships Node 20 | Warning only. Hidden by `JSII_SILENCE_WARNING_DEPRECATED_NODE_VERSION=1` |
| `Cannot use the jsii package cache ... has a parent directory /home/cloudshell-user that is writable by group or others (mode 0777)` | CloudShell home is world-writable | [Step 3.2](#32-fix-the-home-folder-permissions) |
| `Context value 'alertEmail' must be set to a real address` | `MUBWEM_ALERT_EMAIL` not set in this shell | [Step 3.3](#33-save-your-configuration), then `source ~/.bashrc` |
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

1. On GitHub, open the commit or release you want to go back to. Download its zip: **Browse files → Code → Download ZIP**, or `https://github.com/aliflab/mubwem/archive/<commit-sha>.zip`.
2. Upload it to CloudShell and unzip it as in [Updating to new code](#updating-to-new-code). A commit zip unpacks to `mubwem-<commit-sha>` instead of `mubwem-main`. Create a venv inside it ([step 3.4](#34-install-the-tools)), or move the files over `mubwem-main`.
3. Before deploying, check what will change:

   ```bash
   cdk diff
   ```

   Look for any DynamoDB table, the user pool or the frontend bucket marked **replace** or **destroy**. All three are set to `DESTROY`, so replacing one **deletes its data** — monitors, history, incidents or user accounts. Do not deploy a rollback that replaces them without a backup ([below](#back-up-the-data-first)).
4. `cdk deploy`.

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
cd ~/mubwem-main && source .venv/bin/activate && cd infrastructure
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

**CloudShell → Actions → Delete** wipes the home folder: the code, `.venv` and the saved settings in `.bashrc`.

### 5. Confirm nothing is left

```bash
aws resourcegroupstaggingapi get-resources --tag-filters Key=project,Values=mubwem \
  --query 'ResourceTagMappingList[].ResourceARN' --output table
aws cloudformation describe-stacks --stack-name MubwemStack
```

The first should print an empty table; the second should fail with `Stack with id MubwemStack does not exist`. Tag listings can lag deleted resources by a while, so an ARN that lingers in the first is worth checking in its console before worrying about it.
