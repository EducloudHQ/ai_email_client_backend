import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import { Duration } from "aws-cdk-lib";
import { DatabaseConstruct } from "./database-construct";
import { ApiConstruct } from "./api-construct";
import * as actions from "aws-cdk-lib/aws-ses-actions";
import * as route53 from "aws-cdk-lib/aws-route53";

import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import path from "path";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { FilterCriteria, FilterRule } from "aws-cdk-lib/aws-lambda";
export class AiEmailClientStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const envVariables = {
      // AWS_ACCOUNT_ID: Stack.of(this).account,
      POWERTOOLS_SERVICE_NAME: "ai-email-app",
      POWERTOOLS_LOGGER_LOG_LEVEL: "WARN",
      POWERTOOLS_LOGGER_SAMPLE_RATE: "0.01",
      POWERTOOLS_LOGGER_LOG_EVENT: "true",

      POWERTOOLS_METRICS_NAMESPACE: "AiEmailApp",
    };

    // Create the schedule posts function
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
      },
    });

    // Create the database stack
    const database = new DatabaseConstruct(this, "ai-email-Database");

    // Create the API stack
    const api = new ApiConstruct(this, "ai-email-api-construct", {
      database: database.aiEmailClientTable,
      sendEmailLambdaFunction: sendEmailFunction,
    });

    // Create S3 bucket for raw emails
    const emailBucket = new s3.Bucket(this, "AiEmailBucket", {
      bucketName: `${this.account}-${this.region}-email-bucket`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          expiration: Duration.days(90),
        },
      ],
    });

    sendEmailFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: ["*"],
      })
    );

    const emailProcessor = new PythonFunction(this, "emailProcessingFunction", {
      entry: "./lambda/email-processor/",
      handler: "lambda_handler",

      runtime: cdk.aws_lambda.Runtime.PYTHON_3_13,
      memorySize: 256,
      timeout: cdk.Duration.minutes(10),
      logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
      tracing: cdk.aws_lambda.Tracing.ACTIVE,
      environment: {
        ...envVariables,
        TABLE_NAME: database.aiEmailClientTable.tableName,
        ATTACH_BUCKET: emailBucket.bucketName,
      },
    });

    // Lambda converts the email *summary* → speech and updates item
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
    });

    convertFn.addEventSource(
      new DynamoEventSource(database.aiEmailClientTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        reportBatchItemFailures: true,
        filters: [
          FilterCriteria.filter({
            eventName: ["INSERT"],
          }),
        ],
      })
    );

    emailProcessor.role!.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonBedrockFullAccess")
    );
    emailProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          "arn:aws:bedrock-agentcore:us-east-1:132260253285:runtime/email_agent-SBj8UMELez",
          "arn:aws:bedrock-agentcore:us-east-1:132260253285:runtime/email_agent-SBj8UMELez/runtime-endpoint/DEFAULT",
        ],
      })
    );
    // Least‑privilege permissions
    database.aiEmailClientTable.grantReadWriteData(convertFn);
    emailBucket.grantReadWrite(convertFn);
    convertFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["polly:SynthesizeSpeech"],
        resources: ["*"], // Polly doesn’t support resource‑level scoping for voices
      })
    );

    // Grant permissions
    emailBucket.grantReadWrite(emailProcessor);
    database.aiEmailClientTable.grantWriteData(emailProcessor);
    emailProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:ListDataSources",
        ],
        resources: ["*"],
      })
    );

    // Add S3 event notification to trigger Lambda
    emailBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(emailProcessor),
      {
        prefix: "emails/",
      }
    );

    const hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: "846agents.com",
    });

    new route53.MxRecord(this, "EmailSesMx", {
      zone: hostedZone,
      values: [
        {
          priority: 10,
          hostName: `inbound-smtp.${this.region}.amazonaws.com`,
        },
      ],
    });

    // Create SES receipt rule set
    const ruleSet = new ses.ReceiptRuleSet(this, "AIEmailRuleSet", {
      dropSpam: true,

      rules: [
        {
          recipients: ["846agents.com"],
          actions: [
            new actions.S3({
              bucket: emailBucket,
              objectKeyPrefix: "emails/",
            }),
          ],
          enabled: true,
        },
      ],
    });

    // Add bucket policy to allow SES to access the bucket
    emailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
        actions: ["s3:PutObject", "s3:*"],
        resources: [emailBucket.arnForObjects("*")],
        conditions: {
          StringEquals: {
            "aws:SourceAccount": this.account,
          },
          StringLike: {
            "AWS:SourceArn": "arn:aws:ses:*",
          },
        },
      })
    );

    // Output the bucket name and Lambda function ARN
    new cdk.CfnOutput(this, "EmailBucketName", {
      value: emailBucket.bucketName,
      description: "Name of the S3 bucket storing raw emails",
    });

    new cdk.CfnOutput(this, "EmailProcessorFunctionArn", {
      value: emailProcessor.functionArn,
      description: "ARN of the email processing Lambda function",
    });
  }
}
