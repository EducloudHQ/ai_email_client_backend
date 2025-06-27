import { Construct } from "constructs";
import {
  Table,
  AttributeType,
  BillingMode,
  ProjectionType,
  StreamViewType,
} from "aws-cdk-lib/aws-dynamodb";
import { RemovalPolicy } from "aws-cdk-lib";

export class DatabaseConstruct extends Construct {
  public readonly aiEmailClientTable: Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Create the DynamoDB table
    this.aiEmailClientTable = new Table(this, "AiEmailClientTable", {
      tableName: "ai-email-client-db",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      stream: StreamViewType.NEW_IMAGE,
    });

    // Add GSI1: emailsByCategory
    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "listEmailsByCategory",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Add GSI2: emailsBySentiment
    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "listEmailsBySentiment",
      partitionKey: { name: "GSI2PK", type: AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "listEmailsPerUser",
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // Add GSI3: getAllUsers
    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "getAllUsers",
      partitionKey: { name: "GSI3PK", type: AttributeType.STRING },
      sortKey: { name: "GSI3SK", type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ["userId", "emailId", "firstName", "lastName", "email"],
    });

    // Add GSI4: emailsByUser
    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "emailsByUser",
      partitionKey: { name: "GSI4PK", type: AttributeType.STRING },
      sortKey: { name: "GSI4SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
  }
}
