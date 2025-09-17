import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";

import * as events from "aws-cdk-lib/aws-events";
import { FunctionRuntime } from "aws-cdk-lib/aws-appsync";
import path from "path";
import { AccountRecovery, UserPoolClient } from "aws-cdk-lib/aws-cognito";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export interface ApiConstructProps {
  database: cdk.aws_dynamodb.Table;
  sendEmailLambdaFunction: NodejsFunction;
}

export class ApiConstruct extends Construct {
  public readonly api: appsync.GraphqlApi;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(
    scope: Construct,
    id: string,

    props: ApiConstructProps
  ) {
    super(scope, id);

    const { database, sendEmailLambdaFunction } = props;

    // Create Cognito User Pool
    this.userPool = new cognito.UserPool(this, "EmailClientUserPool", {
      userPoolName: "ai-email-client-user-pool",
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
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
    });

    const userPoolClient: UserPoolClient = new UserPoolClient(
      this,
      "AiEmailUserPoolClient",
      {
        userPool: this.userPool,
      }
    );

    // Create AppSync API
    this.api = new appsync.GraphqlApi(this, "EmailClientApi", {
      name: "email-client-api",
      definition: appsync.Definition.fromFile("schema/schema.graphql"),

      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.API_KEY,
          apiKeyConfig: {
            expires: cdk.Expiration.after(cdk.Duration.days(365)),
          },
        },
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.USER_POOL,
            userPoolConfig: {
              userPool: this.userPool,
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
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ALL,
      },
    });
    const noneDs = this.api.addNoneDataSource("None");
    // Create DynamoDB Data Source
    const aiEmailClientTableDS = this.api.addDynamoDbDataSource(
      "EmailTable",
      database
    );

    new iam.Role(this, "AppSyncRole", {
      assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
    });

    // Create resolvers for mutations
    this.api.createResolver("notifyNewEmailResponse", {
      typeName: "Mutation",
      fieldName: "notifyNewEmail",
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      dataSource: noneDs,
      code: appsync.Code.fromAsset("./resolvers/emails/notifyNewEmail.js"),
    });

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
        runtime: FunctionRuntime.JS_1_0_0,
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
        runtime: FunctionRuntime.JS_1_0_0,
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
        runtime: FunctionRuntime.JS_1_0_0,
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
        runtime: FunctionRuntime.JS_1_0_0,
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
