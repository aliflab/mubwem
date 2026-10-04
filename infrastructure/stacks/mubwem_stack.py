"""MuBWeM - Multi-Brand Website Monitor.

Single CDK stack containing the whole Phase 1 (free tier) system:

  EventBridge Scheduler (1 min) -> Checker Lambda -> DynamoDB (4 tables)
                                         |
                                         +-> SES -> HTML alert email
                                         |    +-> bounce/complaint -> SNS topic
                                         +-> SNS topic (fallback, plain text)

  CloudFront -> S3 (static dashboard), which fetches
  API Gateway HTTP API -> API Lambda -> DynamoDB

The dashboard is login-gated by a Cognito user pool (admin-created users
only, no self-signup). Every route on the HTTP API sits behind the JWT
authorizer - there is no unauthenticated route anywhere in the system.

Access is role based, via three Cognito groups - Admins, Editors, Viewers.
A second Lambda (AdminFunction) serves /admin/* behind the same JWT
authorizer; the authorizer only proves the token is valid, so which group the
caller is in is decided inside that function, never here.

Every environment-specific value (alert email, failure threshold, retention)
arrives as CDK context, so this stack can be redeployed into any account
without editing code.
"""

import json
import os
import re

from aws_cdk import (
    ArnFormat,
    Aws,
    CfnOutput,
    Duration,
    Fn,
    RemovalPolicy,
    Stack,
)
from aws_cdk import aws_apigatewayv2 as apigwv2
from aws_cdk import aws_apigatewayv2_integrations as apigw_integrations
from aws_cdk import aws_apigatewayv2_authorizers as apigw_authorizers
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
from aws_cdk import aws_cognito as cognito
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_iam as iam
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_deployment as s3_deploy
from aws_cdk import aws_scheduler as scheduler
from aws_cdk import aws_ses as ses
from aws_cdk import aws_sns as sns
from aws_cdk import aws_sns_subscriptions as sns_subs
from constructs import Construct

# Repo root, relative to this file (infrastructure/stacks/mubwem_stack.py)
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

_RATE_RE = re.compile(
    r"^\s*rate\(\s*(\d+)\s+(minutes?|hours?|days?)\s*\)\s*$", re.IGNORECASE
)
_RATE_UNITS = {"minute": 60, "hour": 3600, "day": 86400}


def schedule_interval_seconds(expression, default=60):
    """Seconds between checker runs, derived from the schedule expression.

    The dashboard's countdown ring needs a number, and the schedule is the
    only place that number exists. Only rate(...) is derivable; a cron
    schedule falls back to the default, which `-c scheduleIntervalSec=<n>`
    overrides.
    """
    match = _RATE_RE.match(expression or "")
    if not match:
        return default
    return int(match.group(1)) * _RATE_UNITS[match.group(2).lower().rstrip("s")]


class MubwemStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # ------------------------------------------------------------------
        # Configuration (all from CDK context - see cdk.json / .env)
        # ------------------------------------------------------------------
        alert_email = self.node.try_get_context("alertEmail")
        if not alert_email or "CHANGE_ME" in str(alert_email):
            raise ValueError(
                "Context value 'alertEmail' must be set to a real address, e.g. "
                "cdk deploy -c alertEmail=you@yourdomain.com"
            )

        # The From address on the HTML alert. Defaults to the alert address,
        # which is the useful default rather than a lazy one: while the account
        # is in the SES sandbox both From and To have to be verified
        # identities, and one address satisfies both.
        sender_email = self.node.try_get_context("senderEmail")
        if not sender_email or "CHANGE_ME" in str(sender_email):
            sender_email = alert_email

        # Where SES bounce/complaint notifications land. Same address as the
        # incident alerts by default - it is the same person's problem - but
        # separable, because raw delivery-failure JSON is a different audience
        # from "your site is down" once someone else is on call.
        bounce_alert_email = self.node.try_get_context("bounceAlertEmail")
        if not bounce_alert_email or "CHANGE_ME" in str(bounce_alert_email):
            bounce_alert_email = alert_email

        failure_threshold = int(self.node.try_get_context("failureThreshold") or 3)
        check_timeout_sec = int(self.node.try_get_context("checkTimeoutSec") or 8)
        checks_ttl_days = int(self.node.try_get_context("checksTtlDays") or 30)
        schedule_expression = (
            self.node.try_get_context("scheduleExpression") or "rate(1 minute)"
        )
        schedule_timezone = (
            self.node.try_get_context("scheduleTimezone") or "Australia/Sydney"
        )
        # The zone the dashboard renders timestamps in by default. Falls back to
        # the schedule timezone rather than being configured twice: a deployment
        # that runs its checks on Sydney time is being watched from Sydney. This
        # is only a display default - the browser can override it per-user, and
        # every timestamp on the wire stays ISO8601 UTC regardless. Alert emails
        # use it too; the browser override lives in localStorage, which the
        # checker cannot see.
        display_timezone = (
            self.node.try_get_context("displayTimezone") or schedule_timezone
        )
        # Published to the frontend so the dashboard can draw a countdown to
        # the next check. Derived from the schedule rather than configured
        # twice, so the two cannot drift apart.
        schedule_interval_sec = int(
            self.node.try_get_context("scheduleIntervalSec")
            or schedule_interval_seconds(schedule_expression)
        )

        # ------------------------------------------------------------------
        # DynamoDB tables (all on-demand)
        # ------------------------------------------------------------------
        common_table_kwargs = dict(
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            # Test build: tear down cleanly. Switch to RETAIN for anything real.
            removal_policy=RemovalPolicy.DESTROY,
        )

        sites_table = dynamodb.Table(
            self,
            "SitesTable",
            partition_key=dynamodb.Attribute(
                name="siteId", type=dynamodb.AttributeType.STRING
            ),
            **common_table_kwargs,
        )

        uptime_checks_table = dynamodb.Table(
            self,
            "UptimeChecksTable",
            partition_key=dynamodb.Attribute(
                name="siteId", type=dynamodb.AttributeType.STRING
            ),
            sort_key=dynamodb.Attribute(
                name="checkedAt", type=dynamodb.AttributeType.STRING
            ),
            time_to_live_attribute="ttl",
            **common_table_kwargs,
        )

        current_status_table = dynamodb.Table(
            self,
            "CurrentStatusTable",
            partition_key=dynamodb.Attribute(
                name="siteId", type=dynamodb.AttributeType.STRING
            ),
            **common_table_kwargs,
        )

        incidents_table = dynamodb.Table(
            self,
            "IncidentsTable",
            partition_key=dynamodb.Attribute(
                name="siteId", type=dynamodb.AttributeType.STRING
            ),
            sort_key=dynamodb.Attribute(
                name="startedAt", type=dynamodb.AttributeType.STRING
            ),
            **common_table_kwargs,
        )

        # Runtime settings changed from the dashboard. One row today
        # (settingKey="notifications": the alert-email mute), written by the
        # admin API and read by the checker once per sweep.
        settings_table = dynamodb.Table(
            self,
            "SettingsTable",
            partition_key=dynamodb.Attribute(
                name="settingKey", type=dynamodb.AttributeType.STRING
            ),
            **common_table_kwargs,
        )

        # ------------------------------------------------------------------
        # Alert delivery
        #
        # SES carries the real mail - SNS's email protocol is plain text only,
        # so a designed alert with a "View details" button cannot go through
        # it. The SNS topic stays as the fallback path: if SES refuses (an
        # identity that was never verified, a sending cap), the checker still
        # gets a plain-text alert out rather than losing it.
        #
        # Creating the identity only asks AWS to send the verification mail.
        # Nobody is verified until someone clicks the link in it.
        # ------------------------------------------------------------------
        # Delivery failures are asynchronous: SES returns a MessageId as soon
        # as it accepts a mail, so a send to a valid-looking but undeliverable
        # address "succeeds" and hard-bounces minutes later. Nothing in the
        # checker can see that. The configuration set below is what makes it
        # visible - it tags outgoing mail so SES has somewhere to report the
        # bounce to.
        #
        # This is detection only. Nothing retries, re-alerts, or suppresses a
        # bouncing address; the notification is raw SES event JSON and its job
        # is purely to make a human look.
        bounce_topic = sns.Topic(
            self,
            "DeliveryFailureTopic",
            display_name="MuBWeM Alert Delivery Failures",
        )

        alert_config_set = ses.ConfigurationSet(self, "AlertConfigurationSet")

        # SES publishes as a service principal, so the topic needs a resource
        # policy to accept it. add_event_destination writes that policy itself,
        # already scoped both ways - aws:SourceAccount to this account (the
        # confused-deputy guard, without which any account's SES could publish
        # here) and aws:SourceArn to this one configuration set rather than all
        # SES activity in the account. Adding a second statement by hand only
        # duplicated it, so this relies on the generated one; the shape it
        # produces is worth re-checking in `cdk synth` after a CDK upgrade.
        #
        # BOUNCE and COMPLAINT only. DELIVERY would fire on every successful
        # send - an inbox that mails itself every minute is one nobody reads.
        # The same call also emits DependsOn from the destination to that topic
        # policy, which matters: SES validates it can publish when the
        # destination is created.
        alert_config_set.add_event_destination(
            "DeliveryFailureDestination",
            destination=ses.EventDestination.sns_topic(bounce_topic),
            events=[
                ses.EmailSendingEvent.BOUNCE,
                ses.EmailSendingEvent.COMPLAINT,
            ],
        )

        bounce_topic.add_subscription(sns_subs.EmailSubscription(bounce_alert_email))

        # Attaching the configuration set to the identity makes it the default
        # for anything sent from this address. The checker also names it
        # explicitly on each send; either alone would work, and both together
        # mean a mail cannot slip out untracked.
        sender_identity = ses.EmailIdentity(
            self,
            "AlertSenderIdentity",
            identity=ses.Identity.email(sender_email),
            configuration_set=alert_config_set,
        )
        if sender_email != alert_email:
            # In the SES sandbox the recipient needs verifying too; when the
            # two addresses match the identity above already covers it.
            ses.EmailIdentity(
                self,
                "AlertRecipientIdentity",
                identity=ses.Identity.email(alert_email),
            )

        alert_topic = sns.Topic(self, "AlertTopic", display_name="MuBWeM Alerts")
        alert_topic.add_subscription(sns_subs.EmailSubscription(alert_email))

        # ------------------------------------------------------------------
        # Checker Lambda
        # ------------------------------------------------------------------
        checker_fn = lambda_.Function(
            self,
            "CheckerFunction",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="handler.lambda_handler",
            code=lambda_.Code.from_asset(os.path.join(REPO_ROOT, "lambda", "checker")),
            # Room for a threaded sweep of a handful of sites at 1-minute cadence.
            timeout=Duration.seconds(60),
            memory_size=512,
            environment={
                "SITES_TABLE": sites_table.table_name,
                "UPTIME_CHECKS_TABLE": uptime_checks_table.table_name,
                "CURRENT_STATUS_TABLE": current_status_table.table_name,
                "INCIDENTS_TABLE": incidents_table.table_name,
                "SETTINGS_TABLE": settings_table.table_name,
                "ALERT_TOPIC_ARN": alert_topic.topic_arn,
                "ALERT_EMAIL": alert_email,
                "SENDER_EMAIL": sender_email,
                "SES_CONFIGURATION_SET": alert_config_set.configuration_set_name,
                "FAILURE_THRESHOLD": str(failure_threshold),
                "CHECK_TIMEOUT_SEC": str(check_timeout_sec),
                "CHECKS_TTL_DAYS": str(checks_ttl_days),
                "CHECK_REGION": Aws.REGION,
                "DISPLAY_TIMEZONE": display_timezone,
            },
        )

        sites_table.grant_read_data(checker_fn)
        uptime_checks_table.grant(checker_fn, "dynamodb:PutItem")
        current_status_table.grant_read_write_data(checker_fn)
        incidents_table.grant_read_write_data(checker_fn)
        settings_table.grant_read_data(checker_fn)
        alert_topic.grant_publish(checker_fn)

        # One SendEmail call, two resources to authorise. SES evaluates the
        # request against every resource it names: the identity the mail claims
        # to come from, and - because the checker passes ConfigurationSetName -
        # the configuration set it is sent through. Granting only the identity
        # gets an AccessDenied naming the configuration set, which is what
        # happened when ConfigurationSetName was added without touching this.
        #
        # Both go in one statement rather than two: same action, same effect,
        # and a single list is harder to extend by half. Anything else the send
        # starts naming later - a dedicated IP pool, a MAIL FROM identity -
        # belongs in this list too.
        checker_fn.add_to_role_policy(
            iam.PolicyStatement(
                actions=["ses:SendEmail"],
                resources=[
                    sender_identity.email_identity_arn,
                    self.format_arn(
                        service="ses",
                        resource="configuration-set",
                        resource_name=alert_config_set.configuration_set_name,
                        arn_format=ArnFormat.SLASH_RESOURCE_NAME,
                    ),
                ],
            )
        )

        # ------------------------------------------------------------------
        # EventBridge Scheduler - invoke the checker every minute
        # ------------------------------------------------------------------
        scheduler_role = iam.Role(
            self,
            "CheckerScheduleRole",
            assumed_by=iam.ServicePrincipal("scheduler.amazonaws.com"),
        )
        checker_fn.grant_invoke(scheduler_role)

        scheduler.CfnSchedule(
            self,
            "CheckerSchedule",
            flexible_time_window=scheduler.CfnSchedule.FlexibleTimeWindowProperty(
                mode="OFF"
            ),
            schedule_expression=schedule_expression,
            schedule_expression_timezone=schedule_timezone,
            target=scheduler.CfnSchedule.TargetProperty(
                arn=checker_fn.function_arn,
                role_arn=scheduler_role.role_arn,
                # A missed minute is cheaper than a duplicated sweep.
                retry_policy=scheduler.CfnSchedule.RetryPolicyProperty(
                    maximum_retry_attempts=0,
                ),
            ),
            description="MuBWeM uptime sweep",
        )

        # ------------------------------------------------------------------
        # Cognito user pool - the dashboard login
        # ------------------------------------------------------------------
        # No self-signup: users are created by an operator with
        # `aws cognito-idp admin-create-user` (see the README).
        #
        # Passkeys (Face ID, Touch ID, Windows Hello, a phone) are offered as a
        # first sign-in factor alongside the password. That needs the
        # Essentials feature plan and the newer managed login below - both
        # still free at this scale (Essentials includes 10k MAU). The password
        # stays: it is how an admin-created user signs in the first time, and
        # the fallback on a device with no passkey.

        # A Cognito-managed domain - no custom domain, no certificate to manage.
        # The prefix has to be globally unique, so it defaults to the first
        # segment of this stack's CloudFormation id: unique per deployment and,
        # unlike the account id, nothing anyone needs to keep quiet. Override
        # with `-c cognitoDomainPrefix=something-unique`.
        cognito_domain_prefix = self.node.try_get_context("cognitoDomainPrefix") or (
            "mubwem-"
            + Fn.select(0, Fn.split("-", Fn.select(2, Fn.split("/", self.stack_id))))
        )

        # Passkeys are bound to the relying party ID, which has to be the
        # domain that serves the login page - here the prefix domain. Changing
        # cognitoDomainPrefix after users have registered passkeys orphans
        # every one of them; they fall back to their password and re-register.
        passkey_relying_party_id = Fn.join(
            "", [cognito_domain_prefix, ".auth.", Aws.REGION, ".amazoncognito.com"]
        )

        user_pool = cognito.UserPool(
            self,
            "UserPool",
            user_pool_name="mubwem-users",
            self_sign_up_enabled=False,
            sign_in_aliases=cognito.SignInAliases(email=True),
            sign_in_case_sensitive=False,
            standard_attributes=cognito.StandardAttributes(
                email=cognito.StandardAttribute(required=True, mutable=True)
            ),
            auto_verify=cognito.AutoVerifiedAttrs(email=True),
            password_policy=cognito.PasswordPolicy(
                min_length=8,
                require_lowercase=True,
                require_uppercase=True,
                require_digits=True,
                require_symbols=False,
            ),
            account_recovery=cognito.AccountRecovery.EMAIL_ONLY,
            feature_plan=cognito.FeaturePlan.ESSENTIALS,
            sign_in_policy=cognito.SignInPolicy(
                allowed_first_auth_factors=cognito.AllowedFirstAuthFactors(
                    password=True, passkey=True
                )
            ),
            passkey_relying_party_id=passkey_relying_party_id,
            # Preferred, not required: the managed login nudges users to
            # register a passkey after a password sign-in, but never blocks
            # someone on a device that cannot hold one.
            passkey_user_verification=cognito.PasskeyUserVerification.PREFERRED,
            # Same teardown stance as the tables: users go with the stack.
            removal_policy=RemovalPolicy.DESTROY,
        )

        user_pool_domain = user_pool.add_domain(
            "UserPoolDomain",
            cognito_domain=cognito.CognitoDomainOptions(
                domain_prefix=cognito_domain_prefix
            ),
            # The newer managed login is what renders the passkey options; the
            # classic hosted UI has none.
            managed_login_version=cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
        )

        # ------------------------------------------------------------------
        # Cognito groups - the three roles
        # ------------------------------------------------------------------
        # Membership arrives in the id token as the `cognito:groups` claim,
        # which lambda/admin/handler.py reads to authorize each route. The API
        # Gateway authorizer only checks that the token is valid; it knows
        # nothing about groups.
        #
        # Precedence is Cognito's tie-breaker when a user is in more than one
        # group (lower number wins), so a user who somehow ends up in both
        # Admins and Viewers resolves to Admins rather than to whichever group
        # happens to sort first.
        #
        # Chicken and egg: the very first user cannot be put in Admins through
        # the admin panel, because reaching the admin panel requires already
        # being in Admins. That one assignment is a manual CLI step, documented
        # in the README:
        #
        #   aws cognito-idp admin-add-user-to-group --group-name Admins
        #     --user-pool-id <CognitoUserPoolId> --username <email>
        #     --region <region>
        for group_name, precedence, group_description in (
            ("Admins", 1, "Full access: manage users and sites"),
            ("Editors", 10, "Create and edit sites; no user management, no delete"),
            ("Viewers", 20, "Read-only access to the dashboard"),
        ):
            cognito.CfnUserPoolGroup(
                self,
                group_name + "Group",
                user_pool_id=user_pool.user_pool_id,
                group_name=group_name,
                precedence=precedence,
                description=group_description,
            )

        # ------------------------------------------------------------------
        # Frontend: private S3 bucket behind CloudFront (origin access control)
        # ------------------------------------------------------------------
        # Built before the user pool client, whose callback URL is the
        # CloudFront domain. The distribution knows nothing about Cognito, so
        # the dependency only runs one way and there is no cycle.
        site_bucket = s3.Bucket(
            self,
            "FrontendBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        # Extensionless URLs. The bucket still holds monitor.html; this only
        # rewrites the path on the way to the origin, so the address bar keeps
        # showing /monitor. Runs on viewer-request, before the cache lookup.
        #
        # A segment is treated as a file when it contains a dot, which is what
        # keeps style.css and docs/mubwem.drawio.svg untouched - the test is on
        # the last segment only, so a dot earlier in the path cannot exempt an
        # extensionless page. Nothing here reads or writes request.querystring,
        # so ?site=X rides along untouched.
        rewrite_function = cloudfront.Function(
            self,
            "ExtensionlessUrlFunction",
            runtime=cloudfront.FunctionRuntime.JS_2_0,
            comment="Append .html to extensionless paths",
            code=cloudfront.FunctionCode.from_inline(
                """
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // "/" and any directory-style path: default_root_object already resolves
  // these, and appending .html to "/" would ask the origin for "/.html".
  if (uri.endsWith('/')) {
    return request;
  }

  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);

  // A dot in the last segment means it names a file - .css, .js, .svg, and
  // the .drawio.svg diagrams - so it goes to the origin as written.
  if (lastSegment.indexOf('.') === -1) {
    request.uri = uri + '.html';
  }

  return request;
}
"""
            ),
        )

        distribution = cloudfront.Distribution(
            self,
            "FrontendDistribution",
            default_root_object="index.html",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(site_bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
                function_associations=[
                    cloudfront.FunctionAssociation(
                        function=rewrite_function,
                        event_type=cloudfront.FunctionEventType.VIEWER_REQUEST,
                    )
                ],
            ),
            comment="MuBWeM dashboard",
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
        )

        dashboard_url = "https://" + distribution.domain_name

        # The checker is defined long before the distribution exists, so the
        # dashboard URL it puts in the "View details" button has to be added
        # here. No cycle: the distribution depends on the bucket, the checker
        # on the tables and the topic.
        checker_fn.add_environment("DASHBOARD_URL", dashboard_url)

        # Trailing slash: CloudFront serves index.html at "/", and the redirect
        # URI the browser sends has to match a callback URL character for
        # character.
        redirect_uri = dashboard_url + "/"
        # Every authenticated page is its own registered callback. The hosted
        # UI has to return the user to the page they were on, and the redirect
        # URI it is given must match a callback URL character for character -
        # so signing in from /incidents and landing back on "/" is not an
        # option. Every page in the frontend needs a login, so every page that
        # is not the root is listed here.
        #
        # These are the extensionless paths the CloudFront Function above
        # serves, not the S3 object names: what the browser puts in the address
        # bar is what Cognito has to match, and the browser never sees .html.
        # Adding a page to the frontend means adding it here too - miss one and
        # a cold sign-in from it silently lands on the dashboard instead.
        AUTHENTICATED_PAGES = (
            "monitor",
            "incidents",
            "team",
            "sites",
            "settings",
            "integrations",
            "add-monitor",
        )
        page_redirect_uris = [dashboard_url + "/" + page for page in AUTHENTICATED_PAGES]
        all_redirect_uris = [redirect_uri] + page_redirect_uris

        # Public client - a static page cannot keep a secret, so there is none.
        # Authorization code + PKCE is what the frontend actually runs.
        user_pool_client = user_pool.add_client(
            "DashboardClient",
            user_pool_client_name="mubwem-dashboard",
            generate_secret=False,
            prevent_user_existence_errors=True,
            # `user` is ALLOW_USER_AUTH, the choice-based flow the managed login
            # uses to offer a passkey or a password.
            auth_flows=cognito.AuthFlow(user_srp=True, user=True),
            supported_identity_providers=[
                cognito.UserPoolClientIdentityProvider.COGNITO
            ],
            o_auth=cognito.OAuthSettings(
                flows=cognito.OAuthFlows(
                    authorization_code_grant=True,
                    implicit_code_grant=False,
                ),
                # COGNITO_ADMIN (aws.cognito.signin.user.admin) lets a signed-in
                # user manage their own passkeys on the managed login's
                # /passkeys/add page. It grants nothing over other users.
                scopes=[
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.COGNITO_ADMIN,
                ],
                callback_urls=all_redirect_uris,
                # Sign-out always lands on the dashboard root, never on one of
                # the inner pages - logging out only to bounce straight back
                # into the hosted UI is not a logout.
                logout_urls=[redirect_uri],
            ),
            id_token_validity=Duration.hours(1),
            access_token_validity=Duration.hours(1),
            # No refresh token is kept in the browser; the hosted UI session
            # cookie is what makes re-login silent when the id token expires.
            refresh_token_validity=Duration.days(1),
        )

        # The newer managed login renders nothing until the app client has a
        # branding style. Cognito's defaults are fine - no assets to manage.
        cognito.CfnManagedLoginBranding(
            self,
            "ManagedLoginBranding",
            user_pool_id=user_pool.user_pool_id,
            client_id=user_pool_client.user_pool_client_id,
            use_cognito_provided_values=True,
        )

        # ------------------------------------------------------------------
        # API Lambda + HTTP API
        # ------------------------------------------------------------------
        api_fn = lambda_.Function(
            self,
            "ApiFunction",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="handler.lambda_handler",
            code=lambda_.Code.from_asset(os.path.join(REPO_ROOT, "lambda", "api")),
            timeout=Duration.seconds(15),
            memory_size=256,
            environment={
                "SITES_TABLE": sites_table.table_name,
                "UPTIME_CHECKS_TABLE": uptime_checks_table.table_name,
                "CURRENT_STATUS_TABLE": current_status_table.table_name,
                "INCIDENTS_TABLE": incidents_table.table_name,
                "FAILURE_THRESHOLD": str(failure_threshold),
            },
        )

        sites_table.grant_read_data(api_fn)
        uptime_checks_table.grant_read_data(api_fn)
        current_status_table.grant_read_data(api_fn)
        incidents_table.grant_read_data(api_fn)

        http_api = apigwv2.HttpApi(
            self,
            "StatusApi",
            api_name="mubwem-status-api",
            cors_preflight=apigwv2.CorsPreflightOptions(
                # The dashboard is served from a CloudFront domain that only
                # exists after this stack deploys, so the origin cannot be
                # pinned here. Every route is protected by the JWT authorizer
                # rather than by CORS, which was never doing that job.
                allow_origins=["*"],
                allow_methods=[
                    apigwv2.CorsHttpMethod.GET,
                    # The /admin/* routes write; every one of them is behind
                    # the JWT authorizer and a group check in the Lambda.
                    apigwv2.CorsHttpMethod.POST,
                    apigwv2.CorsHttpMethod.PATCH,
                    apigwv2.CorsHttpMethod.DELETE,
                    apigwv2.CorsHttpMethod.OPTIONS,
                ],
                allow_headers=["content-type", "authorization"],
            ),
        )

        # Validates the Cognito id token in the Authorization header against
        # this user pool's issuer URL and this client id.
        dashboard_authorizer = apigw_authorizers.HttpUserPoolAuthorizer(
            "DashboardAuthorizer",
            user_pool,
            user_pool_clients=[user_pool_client],
            identity_source=["$request.header.Authorization"],
        )

        # Authenticated: every site, full detail.
        http_api.add_routes(
            path="/status",
            methods=[apigwv2.HttpMethod.GET],
            integration=apigw_integrations.HttpLambdaIntegration(
                "StatusIntegration", api_fn
            ),
            authorizer=dashboard_authorizer,
        )

        # Authenticated: one site, with its full check series and incident
        # history, for the monitor detail page.
        http_api.add_routes(
            path="/status/{siteId}",
            methods=[apigwv2.HttpMethod.GET],
            integration=apigw_integrations.HttpLambdaIntegration(
                "SiteDetailIntegration", api_fn
            ),
            authorizer=dashboard_authorizer,
        )

        # ------------------------------------------------------------------
        # Admin Lambda + /admin/* routes
        # ------------------------------------------------------------------
        # Deliberately a second function with its own role rather than more
        # routes on ApiFunction: the status API reads four tables, this one can
        # administer the user pool. Keeping them apart means a bug in the
        # read-only status path cannot reach the user pool.
        admin_fn_role = iam.Role(
            self,
            "AdminFunctionRole",
            assumed_by=iam.ServicePrincipal("lambda.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name(
                    "service-role/AWSLambdaBasicExecutionRole"
                )
            ],
            description="MuBWeM admin API - Cognito user admin + Sites CRUD",
        )

        admin_fn = lambda_.Function(
            self,
            "AdminFunction",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="handler.lambda_handler",
            code=lambda_.Code.from_asset(os.path.join(REPO_ROOT, "lambda", "admin")),
            timeout=Duration.seconds(15),
            memory_size=256,
            role=admin_fn_role,
            environment={
                "SITES_TABLE": sites_table.table_name,
                "SETTINGS_TABLE": settings_table.table_name,
                "USER_POOL_ID": user_pool.user_pool_id,
            },
        )

        # Sites and Settings only. This function has no reason to read or
        # write UptimeChecks, CurrentStatus or Incidents, so it cannot.
        sites_table.grant_read_write_data(admin_fn)
        settings_table.grant_read_write_data(admin_fn)

        # Scoped to this pool's ARN, not "*": these actions on some other pool
        # in the account are not something this function should ever be able
        # to do, even by accident.
        admin_fn.add_to_role_policy(
            iam.PolicyStatement(
                actions=[
                    "cognito-idp:AdminCreateUser",
                    "cognito-idp:AdminAddUserToGroup",
                    "cognito-idp:AdminRemoveUserFromGroup",
                    "cognito-idp:AdminDeleteUser",
                    "cognito-idp:AdminDisableUser",
                    "cognito-idp:AdminEnableUser",
                    "cognito-idp:AdminListGroupsForUser",
                    "cognito-idp:ListUsers",
                    # Counting the Admins group, so the handler can refuse to
                    # let the last remaining admin demote themselves.
                    "cognito-idp:ListUsersInGroup",
                ],
                resources=[user_pool.user_pool_arn],
            )
        )

        admin_integration = apigw_integrations.HttpLambdaIntegration(
            "AdminIntegration", admin_fn
        )

        # Every /admin/* route sits behind the same JWT authorizer as /status,
        # so a valid token is required to reach the function at all. That is
        # all the authorizer establishes: *which group* the caller is in is
        # checked inside lambda/admin/handler.py, per route, and the failure
        # mode there is always deny.
        for admin_path, admin_methods in (
            ("/admin/users", [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST]),
            (
                "/admin/users/{username}",
                [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
            ),
            ("/admin/sites", [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST]),
            # Static path, so it wins over /admin/sites/{siteId} - which in
            # any case has no POST. No new IAM: this route only makes an
            # outbound HTTPS call, and touches neither DynamoDB nor Cognito.
            ("/admin/sites/preview", [apigwv2.HttpMethod.POST]),
            (
                "/admin/sites/{siteId}",
                [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
            ),
            ("/admin/settings", [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH]),
        ):
            http_api.add_routes(
                path=admin_path,
                methods=admin_methods,
                integration=admin_integration,
                authorizer=dashboard_authorizer,
            )

        # ------------------------------------------------------------------
        # Frontend deployment
        # ------------------------------------------------------------------
        # Ship the static dashboard, plus a generated config.js carrying the API
        # URLs and Cognito client details, so no endpoint, domain or client id is
        # ever hardcoded in committed frontend code.
        config_js = "\n".join(
            [
                'window.MUBWEM_API_URL = "%s/status";' % http_api.api_endpoint,
                'window.MUBWEM_ADMIN_API_URL = "%s/admin";' % http_api.api_endpoint,
                'window.MUBWEM_COGNITO_DOMAIN = "%s";' % user_pool_domain.base_url(),
                'window.MUBWEM_COGNITO_CLIENT_ID = "%s";'
                % user_pool_client.user_pool_client_id,
                'window.MUBWEM_REDIRECT_URI = "%s";' % redirect_uri,
                # Every registered callback, so auth.js can return the user to
                # the page they signed in from instead of the dashboard root.
                "window.MUBWEM_REDIRECT_URIS = %s;"
                % json.dumps(all_redirect_uris),
                # How often the checker actually runs, so the dashboard can
                # draw a countdown ring towards the next check.
                "window.MUBWEM_SCHEDULE_INTERVAL_SEC = %d;" % schedule_interval_sec,
                # Read-only operational facts for the Settings page. These are
                # already public in effect (the checker's behaviour is visible
                # from the outside); nothing secret goes in this file.
                "window.MUBWEM_FAILURE_THRESHOLD = %d;" % failure_threshold,
                "window.MUBWEM_CHECK_TIMEOUT_SEC = %d;" % check_timeout_sec,
                "window.MUBWEM_CHECKS_TTL_DAYS = %d;" % checks_ttl_days,
                'window.MUBWEM_CHECK_REGION = "%s";' % Aws.REGION,
                # The default display timezone for the dashboard. Not a secret
                # and not load-bearing: the frontend falls back to the browser's
                # own zone if this is absent or unrecognised.
                'window.MUBWEM_DISPLAY_TIMEZONE = "%s";' % display_timezone,
                "",
            ]
        )

        s3_deploy.BucketDeployment(
            self,
            "FrontendDeployment",
            sources=[
                s3_deploy.Source.asset(os.path.join(REPO_ROOT, "frontend")),
                s3_deploy.Source.data("config.js", config_js),
            ],
            destination_bucket=site_bucket,
            distribution=distribution,
            distribution_paths=["/*"],
            # Without an explicit header, browsers guess a freshness lifetime
            # from Last-Modified - days, for a file that has not changed in
            # weeks. A deploy that touches settings.js but not auth.js then
            # runs new settings.js against a stale auth.js. max-age=0 makes
            # the browser revalidate every load (a 304 when unchanged);
            # s-maxage lets CloudFront keep caching, since every deploy
            # invalidates /* above.
            cache_control=[
                s3_deploy.CacheControl.max_age(Duration.seconds(0)),
                s3_deploy.CacheControl.must_revalidate(),
                s3_deploy.CacheControl.s_max_age(Duration.days(365)),
            ],
        )

        # ------------------------------------------------------------------
        # Outputs
        # ------------------------------------------------------------------
        CfnOutput(self, "DashboardUrl", value=dashboard_url)
        CfnOutput(self, "ApiUrl", value=http_api.api_endpoint + "/status")
        CfnOutput(
            self,
            "AdminApiUrl",
            value=http_api.api_endpoint + "/admin",
            description="Base path for /admin/users and /admin/sites (JWT required)",
        )
        CfnOutput(self, "SitesAdminUrl", value=dashboard_url + "/sites")
        CfnOutput(self, "TeamAdminUrl", value=dashboard_url + "/team")
        CfnOutput(self, "SitesTableName", value=sites_table.table_name)
        CfnOutput(self, "AlertTopicArn", value=alert_topic.topic_arn)
        CfnOutput(
            self,
            "DeliveryFailureTopicArn",
            value=bounce_topic.topic_arn,
            description="SES bounce/complaint notifications for alert email",
        )
        CfnOutput(
            self,
            "CognitoLoginUrl",
            value=user_pool_domain.sign_in_url(
                user_pool_client, redirect_uri=redirect_uri
            ),
            description="Hosted UI login URL for the dashboard",
        )
        CfnOutput(
            self,
            "CognitoUserPoolId",
            value=user_pool.user_pool_id,
            description=(
                "Pass to `aws cognito-idp admin-create-user` and, for the first "
                "user only, `admin-add-user-to-group --group-name Admins`"
            ),
        )
