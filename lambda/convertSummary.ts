import {
  BatchProcessor,
  EventType,
  processPartialResponse,
} from "@aws-lambda-powertools/batch";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics } from "@aws-lambda-powertools/metrics";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  PollyClient,
  SynthesizeSpeechCommand,
  VoiceId,
} from "@aws-sdk/client-polly";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sdkStreamMixin } from "@smithy/util-stream";
import type {
  DynamoDBRecord,
  DynamoDBStreamHandler,
  Context,
} from "aws-lambda";
import { Readable } from "node:stream";
import { v4 as uuid } from "uuid";

// Initialize AWS Lambda Powertools
const processor = new BatchProcessor(EventType.DynamoDBStreams);
const logger = new Logger({
  serviceName: "email-summary-tts",
});
const tracer = new Tracer({ serviceName: "email-summary-tts" });
const metrics = new Metrics({ namespace: "AiEmailApp" });

// Initialize AWS clients with tracing
const ddb = tracer.captureAWSv3Client(new DynamoDBClient());
const docClient = DynamoDBDocumentClient.from(ddb);
const polly = tracer.captureAWSv3Client(new PollyClient());
const s3 = tracer.captureAWSv3Client(new S3Client());

// Get environment variables
const {
  TABLE_NAME = "",
  BUCKET_NAME = "",
  REGION = "",
  ENVIRONMENT = "dev", // Default environment for multitenancy
} = process.env;

// Define voice mapping for different environments/tenants
const VOICE_MAPPING: Record<string, VoiceId> = {
  dev: "Joanna",
  staging: "Matthew",
  prod: "Joanna",
};

/**
 * Process a single DynamoDB Stream record with tenant isolation
 */
const recordHandler = async (record: DynamoDBRecord): Promise<void> => {
  try {
    // Extract the new image from the DynamoDB Stream record
    const newImage = record.dynamodb?.NewImage;
    if (!newImage) {
      logger.warn("No new image in DynamoDB record");
      return;
    }

    // Extract key fields and tenant information
    const PK = newImage.PK.S!;
    const SK = newImage.SK.S!;
    const summaryText = newImage.aiInsights?.M?.summary?.S;
    const tenant =
      newImage.tenantId?.S || newImage.environment?.S || ENVIRONMENT;

    // Add tenant to the logger context
    logger.appendKeys({ tenant });

    // Validate required fields
    if (!summaryText) {
      logger.error("Missing summary text", { PK, SK, tenant });
      metrics.addMetric("MissingSummaryErrors", "Count", 1);
      throw new Error("Missing summary text");
    }

    logger.info("Synthesizing speech", { PK, SK, tenant });

    // Start tracing subsegment for Polly
    tracer.annotateColdStart();
    tracer.putAnnotation("tenant", tenant);

    // Select voice based on tenant/environment
    const voice = VOICE_MAPPING[tenant] || VOICE_MAPPING.dev;

    // Text-to-speech with Polly
    const { AudioStream } = await polly.send(
      new SynthesizeSpeechCommand({
        OutputFormat: "mp3",
        VoiceId: voice,
        Text: summaryText,
        //Engine: "neural", // Use neural engine for better quality
        TextType: "text", // Use ssml for more control if needed
      })
    );

    if (!AudioStream) {
      logger.error("Polly returned an empty AudioStream", { tenant });
      metrics.addMetric("PollyErrors", "Count", 1);
      throw new Error("Polly returned an empty AudioStream");
    }

    // Convert stream to buffer
    const uint8 = await sdkStreamMixin(
      AudioStream as Readable
    ).transformToByteArray();
    const audioBuffer = Buffer.from(uint8);

    // Create S3 key with tenant isolation
    const key = `audio/${tenant}/${uuid()}.mp3`;

    // Upload audio to S3 with tenant tags
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: audioBuffer,
        ContentType: "audio/mpeg",
        ContentLength: audioBuffer.length,
        Tagging: `Environment=${tenant}&Service=ai-email-client`, // Add tags for cost allocation
        Metadata: {
          tenant: tenant,
          "email-id": SK.split("#")[2] || "",
        },
      })
    );

    // Update DynamoDB with the audio URL
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK, SK },
        UpdateExpression: "SET aiInsights.summaryAudioUrl = :u",
        ExpressionAttributeValues: { ":u": `s3://${BUCKET_NAME}/${key}` },
        // Add condition expression to ensure the item still exists
        ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
      })
    );

    // Add success metrics
    metrics.addMetric("SummariesProcessed", "Count", 1);
    metrics.addMetric(`SummariesProcessed_${tenant}`, "Count", 1);

    logger.info("Record processed successfully", {
      PK,
      SK,
      tenant,
      audioUrl: `s3://${BUCKET_NAME}/${key}`,
    });
  } catch (error) {
    // Log error and add error metrics
    logger.error("Error processing record", {
      error: (error as Error).message,
    });
    metrics.addMetric("ProcessingErrors", "Count", 1);
    throw error; // Re-throw to let the batch processor handle it
  }
};

/**
 * Lambda handler for DynamoDB Stream events with enhanced monitoring and multitenancy support
 */
export const handler: DynamoDBStreamHandler = async (
  event,
  context: Context
) => {
  // Add Lambda context to logger
  logger.appendKeys({
    awsRequestId: context.awsRequestId,
    functionName: context.functionName,
    functionVersion: context.functionVersion,
  });

  // Log event information
  logger.info("Processing DynamoDB Stream event", {
    recordCount: event.Records.length,
    remainingTime: context.getRemainingTimeInMillis(),
    environment: ENVIRONMENT,
  });

  // Add batch metrics
  metrics.addMetric("BatchSize", "Count", event.Records.length);

  try {
    // Process the batch with partial response handling
    const result = await processPartialResponse(
      event,
      recordHandler,
      processor,
      {
        context,
      }
    );

    // Log success metrics
    const successCount = result.batchItemFailures.length
      ? event.Records.length - result.batchItemFailures.length
      : event.Records.length;

    metrics.addMetric("SuccessfullyProcessed", "Count", successCount);

    if (result.batchItemFailures.length) {
      logger.warn("Some records failed processing", {
        failureCount: result.batchItemFailures.length,
        failures: result.batchItemFailures,
      });
      metrics.addMetric(
        "FailedRecords",
        "Count",
        result.batchItemFailures.length
      );
    }

    return result;
  } catch (error) {
    // Log batch processing error
    logger.error("Error processing batch", { error: (error as Error).message });
    metrics.addMetric("BatchProcessingErrors", "Count", 1);
    throw error;
  } finally {
    // Publish metrics
    metrics.publishStoredMetrics();
  }
};
