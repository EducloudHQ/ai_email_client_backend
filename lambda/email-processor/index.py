import os
import json
import boto3
import uuid
import time
import re
from ksuid import Ksuid
from email import policy, utils
from email.parser import BytesParser
from urllib.parse import unquote_plus
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.utilities.data_classes import event_source, S3Event
from aws_lambda_powertools.utilities.typing import LambdaContext


# Initialize AWS Lambda Powertools
logger = Logger(service="email_parser")
tracer = Tracer(service="email_parser")
metrics = Metrics(namespace="AiEmailApp")

# Initialize AWS clients with tracing
RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-east-1:132260253285:runtime/email_agent-SBj8UMELez"

def _region_from_runtime_arn(arn: str) -> str:
    # arn:aws:bedrock-agentcore:<region>:<acct>:runtime/<name>
    return arn.split(":")[3]

def _agentcore_client_for_runtime(arn: str):
    region = _region_from_runtime_arn(arn)
    return boto3.client("bedrock-agentcore", region_name=region)

agent_core = _agentcore_client_for_runtime(RUNTIME_ARN)

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

# Get environment variables
table = dynamodb.Table(os.environ["TABLE_NAME"])
ATTACH_BUCKET = os.environ["ATTACH_BUCKET"]
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")  # Get environment for multitenancy

# Generate a unique ID for this email
unique_email_id = str(Ksuid())

# Regular expression to extract environment from S3 key
EMAIL_PATH_PATTERN = re.compile(r"emails/([^/]+)/")


@tracer.capture_method
def _get(part):
    """Extract content from an email part."""
    if part.is_multipart():
        return b""  # or None
    return getattr(part, "get_content", lambda: part.get_payload(decode=True))()


@tracer.capture_method
def extract_tenant_from_key(object_key: str) -> str:
    """Extract tenant/environment from the S3 object key."""
    match = EMAIL_PATH_PATTERN.search(object_key)
    if match:
        return match.group(1)
    return ENVIRONMENT  # Default to the Lambda's environment


@event_source(data_class=S3Event)
@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: S3Event, context: LambdaContext):
    """Process emails from S3 and store in DynamoDB with tenant isolation."""
    logger.info(f"Raw S3 event {event}")
    trace_id = f"Root=1-{uuid.uuid4().hex[:8]}-{uuid.uuid4().hex[:24]}"
    logger.info(f"Using traceId={trace_id}")

   

    for record in event.records:
        try:
            process_email_record(record)
        except Exception as e:
            logger.exception(f"Error processing record: {e}")
            metrics.add_metric(name="EmailProcessingErrors", unit="Count", value=1)
            # Continue processing other records
            continue

    return {"statusCode": 200, "body": "Email processing completed"}


@tracer.capture_method
def process_email_record(record):
    """Process a single email record."""
    logger.info(f"Processing record: {record}")
    bucket_name = record.s3.bucket.name
    object_key = unquote_plus(record.s3.get_object.key)

    logger.info(f"S3 event bucket={bucket_name}, key={object_key}")

    # Extract tenant/environment from the object key
    tenant = extract_tenant_from_key(object_key)
    logger.info(f"Processing email for tenant: {tenant}")

    # Fetch the raw email from S3
    raw_email = s3.get_object(Bucket=bucket_name, Key=object_key)["Body"].read()

    # Parse the email
    msg = BytesParser(policy=policy.default).parsebytes(raw_email)

    # Extract basic email metadata
    out = {
        "from": msg.get("from", ""),
        "to": msg.get("to", ""),
        "cc": msg.get("cc", ""),
        "bcc": msg.get("bcc", ""),
        "subject": msg.get("subject"),
        "date": msg.get("date", ""),
        "messageId": msg.get("message-id"),
        "plainBody": "",
        "htmlBody": "",
        "attachments": [],
        "environment": tenant,  # Add tenant/environment for multitenancy
    }

    logger.info("Email metadata", email_metadata=out)

    # Process email parts
    for part in msg.walk():
        if part.is_multipart():
            continue

        cdisp = part.get_content_disposition()
        ctype = part.get_content_type()
        data = _get(part)

        if cdisp == "attachment":
            # Store attachments with tenant isolation
            fname = part.get_filename() or "unknown"
            s3_key = f"attachments/{tenant}/{msg['message-id'].strip('<>')}/{fname}"
            s3.put_object(
                Body=data,
                Bucket=ATTACH_BUCKET,
                Key=s3_key,
                Tagging=f"Environment={tenant}",  # Add tenant tag for cost allocation
            )
            out["attachments"].append({"filename": fname, "s3_key": s3_key})

            # Add metrics for attachment processing
            metrics.add_metric(name="AttachmentsProcessed", unit="Count", value=1)

        elif ctype == "text/plain" and not out["plainBody"]:
            out["plainBody"] = data
        elif ctype == "text/html" and not out["htmlBody"]:
            out["htmlBody"] = data

    # Extract email addresses
    addrs = [addr for _name, addr in utils.getaddresses([out["to"] or ""])]
    to_addr = addrs[0] if addrs else "unknown@example.com"

    name, addr = utils.parseaddr(msg.get("from"))
    out["fromName"] = name
    out["from"] = addr

    logger.info("Parsed email", email_metadata=out)

    # Create DynamoDB item with tenant isolation
    item = {
        "PK": f"TENANT#{tenant}#USER#{to_addr}",
        "SK": f"EMAIL#{unique_email_id}#{out['messageId'].strip('<>')}",
        "entity": "EMAIL",
        "userId": to_addr,
        "tenantId": tenant,  # Add tenant ID for isolation
        "environment": tenant,  # Add environment for filtering
        "direction": "INBOUND",
        **out,
    }

    # Process with Bedrock agent
    try:
        # Remove HTML body to reduce payload size
        api_payload = out.copy()
        api_payload.pop("htmlBody", None)
        payload_bytes = json.dumps(api_payload).encode("utf-8")
        '''
                # Add tracing metadata
                request_metadata = {
                    "tenantId": tenant,
                    "environment": tenant,
                    "traceId": trace_id,
                }
        '''
        # Invoke Bedrock agent with tenant context
        with tracer.provider.in_subsegment("invoke_bedrock_agent") as subsegment:
            subsegment.put_annotation("tenant", tenant)

            rsp = agent_core.invoke_agent_runtime(
                agentRuntimeArn=RUNTIME_ARN,
                payload=payload_bytes,
                traceId="Root=1-6893d561-0d48800a0aeffdf26f20c129",
               
            )

            body_bytes = rsp["response"].read()

        # Parse agent response
        json_response = json.loads(body_bytes.decode("utf-8"))
        logger.info("Agent response", agent_response=json_response)

        # Handle string response (sometimes Bedrock returns JSON as string)
        if isinstance(json_response, str):
            json_response = json.loads(json_response)

        # Add AI insights to the item
        item["aiInsights"] = json_response

        # Update GSI keys for tenant isolation and efficient querying
        item["GSI1PK"] = f"TENANT#{tenant}"
        item["GSI1SK"] = f"CATEGORY#{json_response['category']}#USER#{to_addr}"
        item["GSI2PK"] = f"TENANT#{tenant}"
        item["GSI2SK"] = f"SENTIMENT#{json_response['sentiment']}#USER#{to_addr}"
        item["GSI3PK"] = f"TENANT#{tenant}#USER#{to_addr}"
        item["GSI3SK"] = f"DATE#{out['date']}"
        item["GSI4PK"] = f"TENANT#{tenant}"
        item["GSI4SK"] = f"USER#{to_addr}"

        # Add TTL if needed (90 days from now)
        if tenant != "prod":  # Only add TTL for non-production environments
            item["TTL"] = int(time.time()) + (90 * 24 * 60 * 60)

        logger.info("Final DynamoDB item", item=item)

        # Store in DynamoDB
        with tracer.provider.in_subsegment("store_in_dynamodb") as subsegment:
            subsegment.put_annotation("tenant", tenant)
            dynamodb_response = table.put_item(Item=item)

        logger.info("DynamoDB response", dynamodb_response=dynamodb_response)

        # Add success metric
        metrics.add_metric(name="EmailsProcessedSuccessfully", unit="Count", value=1)

        return item

    except Exception as e:
        logger.exception(f"Error processing email: {e}")
        metrics.add_metric(name="EmailProcessingErrors", unit="Count", value=1)
        raise e
