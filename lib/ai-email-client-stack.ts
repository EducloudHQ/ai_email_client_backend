import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as backup from "aws-cdk-lib/aws-backup";
import { Duration, Tags, RemovalPolicy } from "aws-cdk-lib";
import { DatabaseConstruct } from "./database-construct";
import { ApiConstruct } from "./api-construct";
import * as actions from "aws-cdk-lib/aws-ses-actions";
import * as route53 from "aws-cdk-lib/aws-route53";

import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import path from "path";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { FilterCriteria, FilterRule } from "aws-cdk-lib/aws-lambda";

export interface AiEmailClientStackProps extends cdk.StackProps {
  /**
   * Environment name (e.g., dev, test, prod)
   */
  environment: string;

  /**
   * Admin email for notifications
   */
  adminEmail: string;

  /**
   * Domain name for email receiving
   */
  domainName: string;

  /**
   * Enable backup plan
   */
  enableBackup?: boolean;
}

export class AiEmailClientStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AiEmailClientStackProps) {
    super(scope, id, props);

    const { environment, adminEmail, domainName, enableBackup = true } = props;

    // Add stack-level tags
    Tags.of(this).add("Environment", environment);
    Tags.of(this).add("Service", "ai-email-client");
    Tags.of(this).add("CostCenter", "email-processing");

    // Create SNS topic for alarms
    // Using a unique name with timestamp to avoid conflicts with existing topics
    const timestamp = new Date().getTime();
    const alarmTopic = new sns.Topic(this, "AlarmTopicForAIEmail", {
      displayName: `AI-Email-Client-Alarms-${environment}`,
      topicName: `ai-email-client-alarms-${environment}-${timestamp}`,
    });

    // Add subscription for admin email
    alarmTopic.addSubscription(new subscriptions.EmailSubscription(adminEmail));

    // Create CloudTrail for auditing
    const trail = new cloudtrail.Trail(this, "AiEmailClientTrail", {
      trailName: `ai-email-client-trail-${environment}`,
      sendToCloudWatchLogs: true,
      cloudWatchLogGroup: new logs.LogGroup(this, "TrailLogGroup", {
        logGroupName: `/aws/cloudtrail/ai-email-client-${environment}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY, // Change to RETAIN for production
      }),
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: false,
      managementEvents: cloudtrail.ReadWriteType.ALL,
    });

    // Add tags to CloudTrail
    Tags.of(trail).add("Environment", environment);
    Tags.of(trail).add("Service", "ai-email-client");
    Tags.of(trail).add("CostCenter", "email-processing");

    // Create AWS Backup plan if enabled
    if (enableBackup) {
      const backupPlan = new backup.BackupPlan(
        this,
        "AiEmailClientBackupPlan",
        {
          backupPlanName: `ai-email-client-backup-${environment}`,
          backupPlanRules: [
            new backup.BackupPlanRule({
              ruleName: "DailyBackups",
              scheduleExpression: cdk.aws_events.Schedule.cron({
                hour: "3",
                minute: "0",
              }),
              startWindow: Duration.hours(1),
              completionWindow: Duration.hours(6),
              deleteAfter: Duration.days(30),
            }),
          ],
        }
      );

      // Add tags to backup plan
      Tags.of(backupPlan).add("Environment", environment);
      Tags.of(backupPlan).add("Service", "ai-email-client");
      Tags.of(backupPlan).add("CostCenter", "email-processing");
    }

    // Define environment variables with tenant context
    const envVariables = {
      POWERTOOLS_SERVICE_NAME: "ai-email-app",
      POWERTOOLS_LOGGER_LOG_LEVEL: "WARN",
      POWERTOOLS_LOGGER_SAMPLE_RATE: "0.01",
      POWERTOOLS_LOGGER_LOG_EVENT: "true",
      POWERTOOLS_METRICS_NAMESPACE: "AiEmailApp",
      ENVIRONMENT: environment,
    };

    // Create KMS key for email bucket encryption with permissions for SES
    const emailBucketKey = new kms.Key(this, "EmailBucketKey", {
      enableKeyRotation: true,
      description: "KMS key for email bucket encryption",
      alias: `alias/ai-email-bucket-${environment}`,
      removalPolicy: RemovalPolicy.DESTROY, // Change to RETAIN for production
    });

    // Add policy to allow SES to use the KMS key
    emailBucketKey.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*", "kms:Encrypt"],
        resources: ["*"],
      })
    );

    // Add tags to the KMS key
    Tags.of(emailBucketKey).add("Environment", environment);
    Tags.of(emailBucketKey).add("Service", "ai-email-client");
    Tags.of(emailBucketKey).add("CostCenter", "email-processing");

    // Create the send email function with enhanced security and multitenancy
    const sendEmailFunction = new NodejsFunction(this, "SendEmailFunction", {
      entry: "./lambda/sendEmail.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ...envVariables,
      },
      bundling: {
        minify: true,
        sourceMap: true, // Enable source maps for better debugging
      },
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0, // Enable Lambda Insights for enhanced monitoring
    });

    // Add tags to the Lambda function
    Tags.of(sendEmailFunction).add("Environment", environment);
    Tags.of(sendEmailFunction).add("Service", "ai-email-client");
    Tags.of(sendEmailFunction).add("CostCenter", "email-processing");

    // Create the database stack with multitenancy support
    const database = new DatabaseConstruct(this, "ai-email-Database", {
      environment,
    });

    // Create the API stack with multitenancy support
    const api = new ApiConstruct(this, "ai-email-api-construct", {
      database: database.aiEmailClientTable,
      sendEmailLambdaFunction: sendEmailFunction,
      environment,
      adminEmail,
    });

    // emails/
    // audio/
    //attachments/

    // Create S3 bucket for raw emails with enhanced security and multitenancy
    const emailBucket = new s3.Bucket(this, "AiEmailBucket", {
      bucketName: `${this.account}-${this.region}-email-bucket-${environment}`,
      removalPolicy: RemovalPolicy.DESTROY, // Change to RETAIN for production
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: emailBucketKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true, // Enable versioning for data protection
      serverAccessLogsPrefix: "access-logs/", // Enable server access logging
      enforceSSL: true, // Enforce SSL for all requests
      lifecycleRules: [
        {
          id: "ExpireOldEmails",
          enabled: true,
          expiration: Duration.days(90),
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        {
          id: "TransitionToInfrequentAccess",
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
          ],
        },
      ],
      intelligentTieringConfigurations: [
        {
          name: "OptimizeCosts",
          archiveAccessTierTime: Duration.days(90),
          deepArchiveAccessTierTime: Duration.days(180),
        },
      ],
    });

    // Add tags to the S3 bucket
    Tags.of(emailBucket).add("Environment", environment);
    Tags.of(emailBucket).add("Service", "ai-email-client");
    Tags.of(emailBucket).add("CostCenter", "email-processing");

    // Create CloudWatch alarms for S3 bucket
    const s3ErrorsMetric = new cloudwatch.Metric({
      namespace: "AWS/S3",
      metricName: "5xxErrors",
      dimensionsMap: {
        BucketName: emailBucket.bucketName,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    const s3ErrorsAlarm = new cloudwatch.Alarm(this, "S3ErrorsAlarm", {
      metric: s3ErrorsMetric,
      threshold: 10,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      alarmDescription: `S3 bucket 5XX errors in ${environment} environment`,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS action to the alarm
    s3ErrorsAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // Grant send email permissions with least privilege
    sendEmailFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/${domainName}`,
        ],
        conditions: {
          StringEquals: {
            "aws:RequestTag/Environment": environment,
          },
        },
      })
    );

    // Create email processor function with enhanced security and multitenancy
    const emailProcessor = new PythonFunction(this, "emailProcessingFunction", {
      entry: "./lambda/email-processor/",
      handler: "lambda_handler",
      runtime: lambda.Runtime.PYTHON_3_13,
      memorySize: 512, // Increased from 256 for better performance
      timeout: Duration.minutes(10),
      logRetention: logs.RetentionDays.ONE_WEEK,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ...envVariables,
        TABLE_NAME: database.aiEmailClientTable.tableName,
        ATTACH_BUCKET: emailBucket.bucketName,
      },
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0, // Enable Lambda Insights for enhanced monitoring
    });

    // Add tags to the Lambda function
    Tags.of(emailProcessor).add("Environment", environment);
    Tags.of(emailProcessor).add("Service", "ai-email-client");
    Tags.of(emailProcessor).add("CostCenter", "email-processing");

    // Create CloudWatch alarms for Lambda errors
    const lambdaErrorsMetric = new cloudwatch.Metric({
      namespace: "AWS/Lambda",
      metricName: "Errors",
      dimensionsMap: {
        FunctionName: emailProcessor.functionName,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    const lambdaErrorsAlarm = new cloudwatch.Alarm(this, "LambdaErrorsAlarm", {
      metric: lambdaErrorsMetric,
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      alarmDescription: `Lambda errors in ${environment} environment`,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS action to the alarm
    lambdaErrorsAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));

    // Lambda converts the email *summary* → speech and updates item with enhanced security and multitenancy
    const convertFn = new NodejsFunction(this, "EmailSummaryTTSFn", {
      entry: path.join(__dirname, "../lambda/convertSummary.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.minutes(2),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ...envVariables,
        TABLE_NAME: database.aiEmailClientTable.tableName,
        BUCKET_NAME: emailBucket.bucketName,
      },
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0, // Enable Lambda Insights for enhanced monitoring
      bundling: {
        minify: true,
        sourceMap: true, // Enable source maps for better debugging
      },
    });

    // Add tags to the Lambda function
    Tags.of(convertFn).add("Environment", environment);
    Tags.of(convertFn).add("Service", "ai-email-client");
    Tags.of(convertFn).add("CostCenter", "email-processing");

    // Add DynamoDB event source with tenant filtering
    convertFn.addEventSource(
      new DynamoEventSource(database.aiEmailClientTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        reportBatchItemFailures: true,
        batchSize: 10, // Increased from default for better throughput
        retryAttempts: 3, // Add retry for resilience
        filters: [
          FilterCriteria.filter({
            eventName: ["INSERT"],
            dynamodb: {
              NewImage: {
                environment: {
                  S: [environment], // Filter by environment for tenant isolation
                },
              },
            },
          }),
        ],
      })
    );

    // Grant Bedrock permissions with least privilege
    emailProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: ["*"],
      })
    );

    // Grant DynamoDB permissions with least privilege
    database.aiEmailClientTable.grantReadWriteData(convertFn);

    // Grant S3 permissions with least privilege
    emailBucket.grantPut(convertFn);

    // Grant Polly permissions with least privilege
    convertFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["polly:SynthesizeSpeech"],
        resources: ["*"], // Polly doesn't support resource‑level scoping for voices
      })
    );

    // Grant S3 permissions with least privilege
    emailBucket.grantReadWrite(emailProcessor);

    // Grant DynamoDB permissions with least privilege
    database.aiEmailClientTable.grantWriteData(emailProcessor);

    // Grant Bedrock model permissions with least privilege
    emailProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [`arn:aws:bedrock:${this.region}::foundation-model/*`],
        conditions: {
          StringEquals: {
            "aws:RequestTag/Environment": environment,
          },
        },
      })
    );

    // Add S3 event notification to trigger Lambda with tenant isolation
    emailBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(emailProcessor),
      {
        prefix: `emails/${environment}/`,
      }
    );

    // Look up the hosted zone for the domain
    const hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName,
    });

    // Create MX record for SES email receiving
    new route53.MxRecord(this, "EmailSesMx", {
      zone: hostedZone,
      values: [
        {
          priority: 10,
          hostName: `inbound-smtp.${this.region}.amazonaws.com`,
        },
      ],
      ttl: Duration.minutes(5),
    });

    // Create SES receipt rule set with tenant isolation
    const ruleSet = new ses.ReceiptRuleSet(this, "AIEmailRuleSet", {
      dropSpam: true,
      rules: [
        {
          recipients: [domainName],
          actions: [
            new actions.S3({
              bucket: emailBucket,
              objectKeyPrefix: `emails/${environment}/`,
              topic: new sns.Topic(this, "EmailReceivedTopic", {
                displayName: `ai-email-received-${environment}`,
                topicName: `ai-email-received-${environment}-${timestamp}`,
              }),
            }),
          ],
          enabled: true,
          scanEnabled: true, // Enable spam and virus scanning
          tlsPolicy: ses.TlsPolicy.REQUIRE, // Require TLS for enhanced security
        },
      ],
    });

    // Add tags to the rule set
    Tags.of(ruleSet).add("Environment", environment);
    Tags.of(ruleSet).add("Service", "ai-email-client");
    Tags.of(ruleSet).add("CostCenter", "email-processing");

    // Add bucket policy to allow SES to access the bucket with broader permissions
    emailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
        actions: ["s3:PutObject", "s3:GetBucketLocation", "s3:ListBucket"],
        resources: [emailBucket.bucketArn, emailBucket.arnForObjects("*")],
      })
    );

    // Output the bucket name and Lambda function ARN
    new cdk.CfnOutput(this, "EmailBucketName", {
      value: emailBucket.bucketName,
      description: "Name of the S3 bucket storing raw emails",
      exportName: `EmailBucketName-${environment}`,
    });

    new cdk.CfnOutput(this, "EmailProcessorFunctionArn", {
      value: emailProcessor.functionArn,
      description: "ARN of the email processing Lambda function",
      exportName: `EmailProcessorFunctionArn-${environment}`,
    });

    new cdk.CfnOutput(this, "Environment", {
      value: environment,
      description: "Deployment environment",
      exportName: `Environment-${environment}`,
    });

    new cdk.CfnOutput(this, "DynamoDBTableName", {
      value: database.aiEmailClientTable.tableName,
      description: "Name of the DynamoDB table",
      exportName: `DynamoDBTableName-${environment}`,
    });
  }
}
