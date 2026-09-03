"""MuBWeM - Multi-Brand Website Monitor.

Single CDK stack containing the whole Phase 1 (free tier) system:

  EventBridge Scheduler (1 min) -> Checker Lambda -> DynamoDB (4 tables)
                                         |
                                         +-> SNS topic -> email alert

  CloudFront -> S3 (static dashboard), which fetches
  API Gateway HTTP API -> API Lambda -> DynamoDB

Every environment-specific value (alert email, failure threshold, retention)
arrives as CDK context, so this stack can be redeployed into any account
without editing code.
"""

import os

from aws_cdk import (
    Aws,
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
)
from aws_cdk import aws_apigatewayv2 as apigwv2
from aws_cdk import aws_apigatewayv2_integrations as apigw_integrations
from aws_cdk import aws_cloudfront as cloudfront
from aws_cdk import aws_cloudfront_origins as origins
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
                # exists after this stack deploys, and the endpoint is a
                # read-only public status feed, so any origin may read it.
                allow_origins=["*"],
                allow_methods=[apigwv2.CorsHttpMethod.GET],
                allow_headers=["content-type"],
            ),
        )
        http_api.add_routes(
            path="/status",
            methods=[apigwv2.HttpMethod.GET],
            integration=apigw_integrations.HttpLambdaIntegration(
                "StatusIntegration", api_fn
            ),
        )

        # ------------------------------------------------------------------
        # Frontend: private S3 bucket behind CloudFront (origin access control)
        # ------------------------------------------------------------------
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

        # Ship the static dashboard, plus a generated config.js carrying the API
        # URL, so no endpoint is ever hardcoded in committed frontend code.
        s3_deploy.BucketDeployment(
            self,
            "FrontendDeployment",
            sources=[
                s3_deploy.Source.asset(os.path.join(REPO_ROOT, "frontend")),
                s3_deploy.Source.data(
                    "config.js",
                    'window.MUBWEM_API_URL = "%s/status";\n' % http_api.api_endpoint,
                ),
            ],
            destination_bucket=site_bucket,
            distribution=distribution,
            distribution_paths=["/*"],
        )

        # ------------------------------------------------------------------
        # Outputs
        # ------------------------------------------------------------------
        CfnOutput(self, "DashboardUrl", value="https://" + distribution.domain_name)
        CfnOutput(self, "ApiUrl", value=http_api.api_endpoint + "/status")
        CfnOutput(self, "SitesTableName", value=sites_table.table_name)
        CfnOutput(self, "AlertTopicArn", value=alert_topic.topic_arn)
