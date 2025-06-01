import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { DatabaseConstruct } from './database-stack';
import { FunctionRuntime } from 'aws-cdk-lib/aws-appsync';
import path from 'path';

export class ApiStack extends cdk.Stack {
  public readonly api: appsync.GraphqlApi;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, database: DatabaseConstruct, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'EmailClientUserPool', {
      userPoolName: 'email-client-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        givenName: {
          required: true,
          mutable: true,
        },
        familyName: {
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

    // Create Cognito User Pool Client
    this.userPoolClient = this.userPool.addClient('EmailClientApp', {
      userPoolClientName: 'email-client-app',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });

    // Create AppSync API
    this.api = new appsync.GraphqlApi(this, 'EmailClientApi', {
      name: 'email-client-api',
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
      xrayEnabled:true,
      environmentVariables:{
        AI_EMAIL_CLIENT: database.aiEmailClientTable.tableName,
      },
      logConfig:{
       fieldLogLevel: appsync.FieldLogLevel.ALL,


      }
    });

    // Create DynamoDB Data Source
    const aiEmailClientTableDS= this.api.addDynamoDbDataSource('EmailTable', database.aiEmailClientTable);

    // Create IAM role for AppSync
    const appsyncRole = new iam.Role(this, 'AppSyncRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });

      this.api.createResolver(
        "createUserResolver",

        {
          typeName: "Mutation",
          fieldName: "createUser",
          dataSource: aiEmailClientTableDS,
          runtime: FunctionRuntime.JS_1_0_0,
          code: appsync.Code.fromAsset(
            path.join(__dirname, "../resolvers/user/createUser.js")
          ),
        }
      );


    // Output the API endpoint and authentication details
    new cdk.CfnOutput(this, 'GraphQLAPIURL', {
      value: this.api.graphqlUrl,
      description: 'GraphQL API URL',
    });

    new cdk.CfnOutput(this, 'GraphQLAPIKey', {
      value: this.api.apiKey || 'No API Key',
      description: 'GraphQL API Key',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });
  }
}
