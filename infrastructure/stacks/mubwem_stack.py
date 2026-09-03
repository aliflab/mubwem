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

Every environment-specific value (alert email, failure threshold, retention)
arrives as CDK context, so this stack can be redeployed into any account
without editing code.
"""

import os

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
                callback_urls=[redirect_uri],
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
                allow_methods=[apigwv2.CorsHttpMethod.GET],
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
                'window.MUBWEM_COGNITO_DOMAIN = "%s";' % user_pool_domain.base_url(),
                'window.MUBWEM_COGNITO_CLIENT_ID = "%s";'
                % user_pool_client.user_pool_client_id,
                'window.MUBWEM_REDIRECT_URI = "%s";' % redirect_uri,
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
            description="Pass to `aws cognito-idp admin-create-user --user-pool-id`",
        )
