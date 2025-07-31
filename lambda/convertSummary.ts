import {
  BatchProcessor,
  EventType,
  processPartialResponse,
} from "@aws-lambda-powertools/batch";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sdkStreamMixin } from "@smithy/util-stream"; // ✅ new helper
import type { DynamoDBRecord, DynamoDBStreamHandler } from "aws-lambda";
import { Readable } from "node:stream";
import { v4 as uuid } from "uuid";

const processor = new BatchProcessor(EventType.DynamoDBStreams);
const logger = new Logger();
const tracer = new Tracer();

const ddb = tracer.captureAWSv3Client(new DynamoDBClient());
const docClient = DynamoDBDocumentClient.from(ddb);
const polly = tracer.captureAWSv3Client(new PollyClient());
const s3 = tracer.captureAWSv3Client(new S3Client());

const { TABLE_NAME = "", BUCKET_NAME = "", REGION = "" } = process.env;

// Process each stream record

const recordHandler = async (record: DynamoDBRecord): Promise<void> => {
  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return; // nothing to do

  const PK = newImage.PK.S!;
  const SK = newImage.SK.S!;
  const summaryText = newImage.aiInsights?.M?.summary?.S;
  if (!summaryText) throw new Error("Missing summary text");

  logger.info("Synthesising speech", { PK, SK });

  //Text‑to‑speech (Polly)(create audio from summary)

  const { AudioStream } = await polly.send(
    new SynthesizeSpeechCommand({
      OutputFormat: "mp3",
      VoiceId: "Joanna",
      Text: summaryText,
    })
  );
  if (!AudioStream) throw new Error("Polly returned empty AudioStream");

  //Stream → Buffer with @smithy/util‑stream

  const uint8 = await sdkStreamMixin(
    AudioStream as Readable
  ).transformToByteArray();
  const audioBuffer = Buffer.from(uint8);
  const key = `audio/${uuid()}.mp3`;

  //upload audio stream to s3
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
      ContentLength: audioBuffer.length, // ✅ fixes invalid‑header bug
    })
  );

  // persist audio url back to dynamodb
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK, SK },
      UpdateExpression: "SET aiInsights.summaryAudioUrl = :u",
      ExpressionAttributeValues: { ":u": `s3://${BUCKET_NAME}/${key}` },
    })
  );

  logger.info("✓ Record processed", { PK, SK });
};

// stream‑processor Lambda handler
export const handler: DynamoDBStreamHandler = async (event, context) =>
  processPartialResponse(event, recordHandler, processor, { context });
