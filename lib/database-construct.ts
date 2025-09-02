import { Construct } from "constructs";
import {
  Table,
  AttributeType,
  BillingMode,
  ProjectionType,
  StreamViewType,
  TableEncryption,
  CfnTable,
} from "aws-cdk-lib/aws-dynamodb";
import { RemovalPolicy, Duration, Tags } from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import { PointInTimeRecoveryStatus } from "@aws-sdk/client-dynamodb";

export interface DatabaseConstructProps {
  /**
   * Environment name (e.g., dev, test, prod)
   */
  environment: string;
}

export class DatabaseConstruct extends Construct {
  public readonly aiEmailClientTable: Table;
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: DatabaseConstructProps) {
    super(scope, id);

    // Create KMS key for table encryption
    this.encryptionKey = new kms.Key(this, "TableEncryptionKey", {
      enableKeyRotation: true,
      description: "KMS key for DynamoDB table encryption",
      alias: `alias/ai-email-client-${props.environment}`,
      removalPolicy: RemovalPolicy.DESTROY, // Change to RETAIN for production
    });

    // Add tags to the KMS key
    Tags.of(this.encryptionKey).add("Environment", props.environment);
    Tags.of(this.encryptionKey).add("Service", "ai-email-client");
    Tags.of(this.encryptionKey).add("CostCenter", "email-processing");

    // Create the DynamoDB table with multitenancy support
    this.aiEmailClientTable = new Table(this, "AiEmailClientTable", {
      tableName: `ai-email-client-${props.environment}`,
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST, // On-demand capacity for unpredictable workloads
      removalPolicy: RemovalPolicy.DESTROY, // Change to RETAIN for production
      stream: StreamViewType.NEW_AND_OLD_IMAGES, // Capture both old and new images for better event processing

      encryption: TableEncryption.CUSTOMER_MANAGED, // Use customer-managed KMS key
      encryptionKey: this.encryptionKey,
      timeToLiveAttribute: "TTL", // Enable TTL for data lifecycle management
    });

    // Add tags to the table
    Tags.of(this.aiEmailClientTable).add("Environment", props.environment);
    Tags.of(this.aiEmailClientTable).add("Service", "ai-email-client");
    Tags.of(this.aiEmailClientTable).add("CostCenter", "email-processing");

    // Add GSI1: emailsByCategory - Optimized for tenant isolation
    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "byTenantAndCategory",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING }, // TENANT#<tenantId>
      sortKey: { name: "GSI1SK", type: AttributeType.STRING }, // CATEGORY#<category>#USER#<userId>
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "messageId",
        "subject",
        "from",
        "fromName",
        "date",
        "aiInsights",
        "direction",
      ],
    });

    // Add GSI2: emailsBySentiment - Optimized for tenant isolation
    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "byTenantAndSentiment",
      partitionKey: { name: "GSI2PK", type: AttributeType.STRING }, // TENANT#<tenantId>
      sortKey: { name: "GSI2SK", type: AttributeType.STRING }, // SENTIMENT#<sentiment>#USER#<userId>
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "messageId",
        "subject",
        "from",
        "fromName",
        "date",
        "aiInsights",
        "direction",
      ],
    });

    // Add GSI3: emailsByUser - Optimized for tenant isolation
    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "byTenantAndUser",
      partitionKey: { name: "GSI3PK", type: AttributeType.STRING }, // TENANT#<tenantId>#USER#<userId>
      sortKey: { name: "GSI3SK", type: AttributeType.STRING }, // DATE#<ISO-date>
      projectionType: ProjectionType.ALL,
    });

    // Add GSI4: getAllUsers - For admin access within a tenant
    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "allUsersByTenant",
      partitionKey: { name: "GSI4PK", type: AttributeType.STRING }, // TENANT#<tenantId>
      sortKey: { name: "GSI4SK", type: AttributeType.STRING }, // USER#<userId>
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ["userId", "firstName", "lastName", "email", "status"],
    });

    // Add GSI5: For tenant management
    this.aiEmailClientTable.addGlobalSecondaryIndex({
      indexName: "tenantManagement",
      partitionKey: { name: "GSI5PK", type: AttributeType.STRING }, // TENANT
      sortKey: { name: "GSI5SK", type: AttributeType.STRING }, // TENANT#<tenantId>
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "tenantName",
        "plan",
        "status",
        "createdAt",
        "updatedAt",
      ],
    });

    // Set up auto-scaling for GSIs if needed in the future
    const cfnTable = this.aiEmailClientTable.node.defaultChild as CfnTable;

    // Add DynamoDB Contributor Insights for monitoring hot keys and access patterns
    cfnTable.contributorInsightsSpecification = {
      enabled: true,
    };
  }
}
