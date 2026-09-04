"""MuBWeM - Multi-Brand Website Monitor.

Single CDK stack containing the whole Phase 1 (free tier) system:

  EventBridge Scheduler (1 min) -> Checker Lambda -> DynamoDB (4 tables)
                                         |
                                         +-> SNS topic -> email alert

  CloudFront -> S3 (static dashboard), which fetches
  API Gateway HTTP API -> API Lambda -> DynamoDB

The dashboard is login-gated by a Cognito user pool (admin-created users
only, no self-signup) and GET /status sits behind a JWT authorizer. Sites
flagged isPublic are also served unauthenticated on GET /public/status, for
the shareable status page.

Access is role based, via three Cognito groups - Admins, Editors, Viewers.
A second Lambda (AdminFunction) serves /admin/* behind the same JWT
authorizer; the authorizer only proves the token is valid, so which group the
caller is in is decided inside that function, never here.

Every environment-specific value (alert email, failure threshold, retention)
arrives as CDK context, so this stack can be redeployed into any account
without editing code.
"""

import os
import re

from aws_cdk import (
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

        failure_threshold = int(self.node.try_get_context("failureThreshold") or 3)
        check_timeout_sec = int(self.node.try_get_context("checkTimeoutSec") or 8)
        checks_ttl_days = int(self.node.try_get_context("checksTtlDays") or 30)
        schedule_expression = (
            self.node.try_get_context("scheduleExpression") or "rate(1 minute)"
        )
        schedule_timezone = (
            self.node.try_get_context("scheduleTimezone") or "Australia/Sydney"
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

        # ------------------------------------------------------------------
        # SNS alert topic + email subscription
        # ------------------------------------------------------------------
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
                "ALERT_TOPIC_ARN": alert_topic.topic_arn,
                "FAILURE_THRESHOLD": str(failure_threshold),
                "CHECK_TIMEOUT_SEC": str(check_timeout_sec),
                "CHECKS_TTL_DAYS": str(checks_ttl_days),
                "CHECK_REGION": Aws.REGION,
            },
        )

        sites_table.grant_read_data(checker_fn)
        uptime_checks_table.grant(checker_fn, "dynamodb:PutItem")
        current_status_table.grant_read_write_data(checker_fn)
        incidents_table.grant_read_write_data(checker_fn)
        alert_topic.grant_publish(checker_fn)

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
            # Same teardown stance as the tables: users go with the stack.
            removal_policy=RemovalPolicy.DESTROY,
        )

        # A Cognito-managed domain - no custom domain, no certificate to manage.
        # The prefix has to be globally unique, so it defaults to the first
        # segment of this stack's CloudFormation id: unique per deployment and,
        # unlike the account id, nothing anyone needs to keep quiet. Override
        # with `-c cognitoDomainPrefix=something-unique`.
        cognito_domain_prefix = self.node.try_get_context("cognitoDomainPrefix") or (
            "mubwem-"
            + Fn.select(0, Fn.split("-", Fn.select(2, Fn.split("/", self.stack_id))))
        )
        user_pool_domain = user_pool.add_domain(
            "UserPoolDomain",
            cognito_domain=cognito.CognitoDomainOptions(
                domain_prefix=cognito_domain_prefix
            ),
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

        distribution = cloudfront.Distribution(
            self,
            "FrontendDistribution",
            default_root_object="index.html",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(site_bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cloudfront.CachePolicy.CACHING_OPTIMIZED,
            ),
            comment="MuBWeM dashboard",
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,
        )

        dashboard_url = "https://" + distribution.domain_name
        # Trailing slash: CloudFront serves index.html at "/", and the redirect
        # URI the browser sends has to match a callback URL character for
        # character.
        redirect_uri = dashboard_url + "/"
        # The admin panel is a separate page, so it needs its own registered
        # callback: landing back on "/" after signing in from /admin.html would
        # drop the user on the dashboard instead of where they were going.
        admin_redirect_uri = dashboard_url + "/admin.html"

        # Public client - a static page cannot keep a secret, so there is none.
        # Authorization code + PKCE is what the frontend actually runs.
        user_pool_client = user_pool.add_client(
            "DashboardClient",
            user_pool_client_name="mubwem-dashboard",
            generate_secret=False,
            prevent_user_existence_errors=True,
            auth_flows=cognito.AuthFlow(user_srp=True),
            supported_identity_providers=[
                cognito.UserPoolClientIdentityProvider.COGNITO
            ],
            o_auth=cognito.OAuthSettings(
                flows=cognito.OAuthFlows(
                    authorization_code_grant=True,
                    implicit_code_grant=False,
                ),
                scopes=[cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
                callback_urls=[redirect_uri, admin_redirect_uri],
                # Sign-out always lands on the dashboard root, never on
                # /admin.html - logging out only to bounce straight back into
                # the hosted UI is not a logout.
                logout_urls=[redirect_uri],
            ),
            id_token_validity=Duration.hours(1),
            access_token_validity=Duration.hours(1),
            # No refresh token is kept in the browser; the hosted UI session
            # cookie is what makes re-login silent when the id token expires.
            refresh_token_validity=Duration.days(1),
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
                # pinned here. /status is protected by the JWT authorizer
                # rather than by CORS; /public/status is deliberately open.
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

        # Unauthenticated: only sites flagged isPublic. Same Lambda, which
        # branches on the request path - one function, one set of grants.
        http_api.add_routes(
            path="/public/status",
            methods=[apigwv2.HttpMethod.GET],
            integration=apigw_integrations.HttpLambdaIntegration(
                "PublicStatusIntegration", api_fn
            ),
        )

        # ------------------------------------------------------------------
        # Admin Lambda + /admin/* routes
        # ------------------------------------------------------------------
        # Deliberately a second function with its own role rather than more
        # routes on ApiFunction: the status API is public-facing and reads four
        # tables, this one can administer the user pool. Keeping them apart
        # keeps that capability off the function anyone can reach anonymously.
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
                "USER_POOL_ID": user_pool.user_pool_id,
            },
        )

        # Sites only. This function has no reason to read or write
        # UptimeChecks, CurrentStatus or Incidents, so it cannot.
        sites_table.grant_read_write_data(admin_fn)

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
            (
                "/admin/sites/{siteId}",
                [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
            ),
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
                'window.MUBWEM_PUBLIC_API_URL = "%s/public/status";'
                % http_api.api_endpoint,
                'window.MUBWEM_ADMIN_API_URL = "%s/admin";' % http_api.api_endpoint,
                'window.MUBWEM_COGNITO_DOMAIN = "%s";' % user_pool_domain.base_url(),
                'window.MUBWEM_COGNITO_CLIENT_ID = "%s";'
                % user_pool_client.user_pool_client_id,
                'window.MUBWEM_REDIRECT_URI = "%s";' % redirect_uri,
                'window.MUBWEM_ADMIN_REDIRECT_URI = "%s";' % admin_redirect_uri,
                # How often the checker actually runs, so the dashboard can
                # draw a countdown ring towards the next check.
                "window.MUBWEM_SCHEDULE_INTERVAL_SEC = %d;" % schedule_interval_sec,
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
        )

        # ------------------------------------------------------------------
        # Outputs
        # ------------------------------------------------------------------
        CfnOutput(self, "DashboardUrl", value=dashboard_url)
        CfnOutput(self, "ApiUrl", value=http_api.api_endpoint + "/status")
        CfnOutput(self, "PublicApiUrl", value=http_api.api_endpoint + "/public/status")
        CfnOutput(
            self,
            "AdminApiUrl",
            value=http_api.api_endpoint + "/admin",
            description="Base path for /admin/users and /admin/sites (JWT required)",
        )
        CfnOutput(self, "AdminPanelUrl", value=admin_redirect_uri)
        CfnOutput(self, "SitesTableName", value=sites_table.table_name)
        CfnOutput(self, "AlertTopicArn", value=alert_topic.topic_arn)
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
