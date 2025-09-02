import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as pipes from "aws-cdk-lib/aws-pipes";
import * as events from "aws-cdk-lib/aws-events";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
// Import all appsync functionality through the namespace
import path from "path";
import { AccountRecovery, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Duration, Tags, RemovalPolicy } from "aws-cdk-lib";

export interface ApiConstructProps {
  database: cdk.aws_dynamodb.Table;
  sendEmailLambdaFunction: NodejsFunction;
  environment: string;
  adminEmail: string;
}

export class ApiConstruct extends Construct {
  public readonly api: appsync.GraphqlApi;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly eventBus: events.EventBus;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    const { database, sendEmailLambdaFunction, environment, adminEmail } =
      props;

    // Create SNS topic for alarms
    // Using a unique name with timestamp to avoid conflicts with existing topics
    const timestamp = new Date().getTime();
    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: `AI-Email-Client-Alarms-${environment}`,
      topicName: `ai-email-client-alarms-${environment}-${timestamp}`,
    });

    // Add subscription for admin email
    this.alarmTopic.addSubscription(
      new subscriptions.EmailSubscription(adminEmail)
    );

    // Tag the SNS topic
    Tags.of(this.alarmTopic).add("Environment", environment);
    Tags.of(this.alarmTopic).add("Service", "ai-email-client");
    Tags.of(this.alarmTopic).add("CostCenter", "email-processing");

    // Create Cognito User Pool with enhanced security
    this.userPool = new cognito.UserPool(this, "EmailClientUserPool", {
      userPoolName: `ai-email-client-user-pool-${environment}`,
      selfSignUpEnabled: true,
      accountRecovery: AccountRecovery.PHONE_AND_EMAIL,
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      autoVerify: {
        email: true,
      },
      signInAliases: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 12, // Increased from 8 for better security
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },

      removalPolicy: RemovalPolicy.DESTROY, // Change to RETAIN for production
    });

    // Add tags to the user pool
    Tags.of(this.userPool).add("Environment", environment);
    Tags.of(this.userPool).add("Service", "ai-email-client");
    Tags.of(this.userPool).add("CostCenter", "email-processing");

    // Create user pool client with enhanced security
    const userPoolClient: UserPoolClient = new UserPoolClient(
      this,
      "AiEmailUserPoolClient",
      {
        userPool: this.userPool,
        authFlows: {
          userPassword: true,
          userSrp: true,
          adminUserPassword: true,
        },
        preventUserExistenceErrors: true,
        refreshTokenValidity: Duration.days(30),
        accessTokenValidity: Duration.hours(1),
        idTokenValidity: Duration.hours(1),
        enableTokenRevocation: true,
      }
    );

    // Add tags to the user pool client
    Tags.of(userPoolClient).add("Environment", environment);
    Tags.of(userPoolClient).add("Service", "ai-email-client");
    Tags.of(userPoolClient).add("CostCenter", "email-processing");

    // Create the EventBridge event bus with improved naming for multitenancy
    this.eventBus = new events.EventBus(this, "AiEmailEventBus", {
      eventBusName: `ai-email-client-bus-${environment}`,
    });

    // Add tags to the event bus
    Tags.of(this.eventBus).add("Environment", environment);
    Tags.of(this.eventBus).add("Service", "ai-email-client");
    Tags.of(this.eventBus).add("CostCenter", "email-processing");

    // Create AppSync API with enhanced security and multitenancy support
    this.api = new appsync.GraphqlApi(this, "EmailClientApi", {
      name: `email-client-api-${environment}`,
      definition: appsync.Definition.fromFile("schema/schema.graphql"),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: {
            userPool: this.userPool,
          },
        },
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.API_KEY,
            apiKeyConfig: {
              name: `api-key-${environment}`,
              description: `API Key for ${environment} environment`,
              expires: cdk.Expiration.after(cdk.Duration.days(90)), // Reduced from 365 days for better security
            },
          },
          {
            authorizationType: appsync.AuthorizationType.IAM,
          },
        ],
      },
      xrayEnabled: true,
      environmentVariables: {
        AI_EMAIL_CLIENT: database.tableName,
        ENVIRONMENT: environment,
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ERROR, // Reduced from ALL to ERROR for cost optimization in production
        excludeVerboseContent: false, // Include request/response for debugging
        retention: logs.RetentionDays.ONE_WEEK, // Set retention period
      },
    });

    // Add tags to the API
    Tags.of(this.api).add("Environment", environment);
    Tags.of(this.api).add("Service", "ai-email-client");
    Tags.of(this.api).add("CostCenter", "email-processing");

    // Create WAF Web ACL for AppSync API
    const webAcl = new wafv2.CfnWebACL(this, "ApiWebAcl", {
      name: `ai-email-client-api-waf-${environment}`,
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `ai-email-client-api-waf-${environment}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "RateLimit",
          priority: 1,
          action: {
            block: {},
          },
          statement: {
            rateBasedStatement: {
              limit: 1000, // Requests per 5 minutes per IP
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimit",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesCommonRuleSet",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSet",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate WAF Web ACL with AppSync API
    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: this.api.arn,
      webAclArn: webAcl.attrArn,
    });

    // Create CloudWatch alarms for API errors
    const apiErrorsMetric = new cloudwatch.Metric({
      namespace: "AWS/AppSync",
      metricName: "5XXError",
      dimensionsMap: {
        GraphQLAPIId: this.api.apiId,
      },
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    const apiErrorsAlarm = new cloudwatch.Alarm(this, "ApiErrorsAlarm", {
      metric: apiErrorsMetric,
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      alarmDescription: `AppSync API 5XX errors in ${environment} environment`,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS action to the alarm
    apiErrorsAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));
    const noneDs = this.api.addNoneDataSource("None");
    // Create DynamoDB Data Source
    const aiEmailClientTableDS = this.api.addDynamoDbDataSource(
      "EmailTable",
      database
    );

    // Create CloudWatch dashboard for monitoring
    const dashboard = new cloudwatch.Dashboard(this, "AiEmailClientDashboard", {
      dashboardName: `ai-email-client-${environment}`,
    });

    // Add API metrics to dashboard
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "API Errors",
        left: [apiErrorsMetric],
      }),
      new cloudwatch.GraphWidget({
        title: "API Latency",
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/AppSync",
            metricName: "Latency",
            dimensionsMap: {
              GraphQLAPIId: this.api.apiId,
            },
            statistic: "Average",
            period: Duration.minutes(5),
          }),
        ],
      })
    );

    // Add DynamoDB metrics to dashboard
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "DynamoDB Read Capacity",
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/DynamoDB",
            metricName: "ConsumedReadCapacityUnits",
            dimensionsMap: {
              TableName: database.tableName,
            },
            statistic: "Sum",
            period: Duration.minutes(5),
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "DynamoDB Write Capacity",
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/DynamoDB",
            metricName: "ConsumedWriteCapacityUnits",
            dimensionsMap: {
              TableName: database.tableName,
            },
            statistic: "Sum",
            period: Duration.minutes(5),
          }),
        ],
      })
    );

    // Add tags to the dashboard
    Tags.of(dashboard).add("Environment", environment);
    Tags.of(dashboard).add("Service", "ai-email-client");
    Tags.of(dashboard).add("CostCenter", "email-processing");

    this.api
      .addLambdaDataSource(
        "invokeSendEmailLambdaDatasource",
        sendEmailLambdaFunction
      )
      .createResolver("sendEmailLambdaFunctionResolver", {
        typeName: "Mutation",
        fieldName: "sendEmail",
        code: appsync.Code.fromAsset(
          path.join(__dirname, "../resolvers/invoke/invoke.js")
        ),
        runtime: appsync.FunctionRuntime.JS_1_0_0,
      });

    this.api.createResolver(
      "listEmailsResolver",

      {
        typeName: "Query",
        fieldName: "listEmails",
        dataSource: aiEmailClientTableDS,
        runtime: appsync.FunctionRuntime.JS_1_0_0,
        code: appsync.Code.fromAsset(
          path.join(__dirname, "../resolvers/emails/listEmails.js")
        ),
      }
    );

    this.api.createResolver(
      "listEmailsBySentimentResolver",

      {
        typeName: "Query",
        fieldName: "listEmailsBySentiment",
        dataSource: aiEmailClientTableDS,
        runtime: appsync.FunctionRuntime.JS_1_0_0,
        code: appsync.Code.fromAsset(
          path.join(__dirname, "../resolvers/emails/listEmailsBySentiment.js")
        ),
      }
    );

    this.api.createResolver(
      "listEmailsByCategoryResolver",

      {
        typeName: "Query",
        fieldName: "listEmailsByCategory",
        dataSource: aiEmailClientTableDS,
        runtime: appsync.FunctionRuntime.JS_1_0_0,
        code: appsync.Code.fromAsset(
          path.join(__dirname, "../resolvers/emails/listEmailsByCategory.js")
        ),
      }
    );

    this.api.createResolver(
      "getEmailResolver",

      {
        typeName: "Query",
        fieldName: "getEmail",
        dataSource: aiEmailClientTableDS,
        runtime: appsync.FunctionRuntime.JS_1_0_0,
        code: appsync.Code.fromAsset(
          path.join(__dirname, "../resolvers/emails/getEmail.js")
        ),
      }
    );

    // Output the API endpoint and authentication details
    new cdk.CfnOutput(this, "GraphQLAPIURL", {
      value: this.api.graphqlUrl,
      description: "GraphQL API URL",
    });

    new cdk.CfnOutput(this, "GraphQLAPIKey", {
      value: this.api.apiKey || "No API Key",
      description: "GraphQL API Key",
    });

    new cdk.CfnOutput(this, "UserPoolId", {
      value: this.userPool.userPoolId,
      description: "Cognito User Pool ID",
    });
  }
}
