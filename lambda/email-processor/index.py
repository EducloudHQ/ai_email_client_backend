import os
import json
import boto3
import uuid,time
from ksuid import Ksuid
from email import policy, utils
from email.parser import BytesParser
from urllib.parse import unquote_plus
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.utilities.data_classes import event_source, S3Event


logger = Logger(service="ai_email_parser")
tracer = Tracer(service="ai_email_parser")
metrics = Metrics(namespace="ai_email_parser")


agent_core = boto3.client("bedrock-agentcore", region_name='us-east-1')

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])
ATTACH_BUCKET = os.environ["ATTACH_BUCKET"]

unique_email_id = str(Ksuid())



def _get(part):
    if part.is_multipart():
        return b""  # or None
    return getattr(part, "get_content", lambda: part.get_payload(decode=True))()


@event_source(data_class=S3Event)
@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: S3Event, context):
    logger.info(f"Raw S3 event {event}")
    session_id = f"Root=1-{uuid.uuid4().hex[:8]}-{uuid.uuid4().hex[:24]}"
   

    for record in event.records:
        logger.info(f"Record: {record}")
        bucket_name = record.s3.bucket.name
        object_key = unquote_plus(record.s3.get_object.key)

        logger.info(
            f"S3 event bucket={bucket_name}, key={object_key}"
        )  # structured log

        raw_email = s3.get_object(Bucket=bucket_name, Key=object_key)["Body"].read()

        logger.info(f"E-mail {raw_email}")

        msg = BytesParser(policy=policy.default).parsebytes(raw_email)

        out = {
            "from": msg.get("from",""),
            "to": msg.get("to",""),
            "cc": msg.get("cc",""),
            "bcc": msg.get("bcc",""),
            "subject": msg.get("subject"),
            "date": msg.get("date",""),
            "messageId": msg.get("message-id"),
            "plainBody": "",
            "htmlBody": "",
            "attachments": [],
        }
        print(f"E-mail metadata  email_metadata={out}")
        logger.info(f"E-mail metadata  email_metadata={out}")

        for part in msg.walk():
            if part.is_multipart():
                continue
            cdisp = part.get_content_disposition()
            ctype = part.get_content_type()
            data = _get(part)

            if cdisp == "attachment":
                fname = part.get_filename() or "unknown"
                s3_key = f"attachments/{msg['message-id'].strip('<>')}/{fname}"
                s3.put_object(Body=data, Bucket=ATTACH_BUCKET, Key=s3_key)
                out["attachments"].append({"filename": fname, "s3_key": s3_key})

            elif ctype == "text/plain" and not out["plainBody"]:
                out["plainBody"] = data
            elif ctype == "text/html" and not out["htmlBody"]:
                out["htmlBody"] = data

        addrs = [addr for _name, addr in utils.getaddresses([out["to"] or ""])]
        to_addr = addrs[0] if addrs else "unknown@example.com"

        name, addr = utils.parseaddr(msg.get("from"))
        out["fromName"] = name
        out["from"] = addr

        logger.info("Parsed e-mail", email_metadata=out)
        item = {
            "PK": f"USER#{to_addr}",
            "SK": f"EMAIL#{unique_email_id}#{out['messageId'].strip('<>')}",
            "entity": "EMAIL",
            "userId": to_addr,
            "direction": "INBOUND",
            **out,
        }

        try:
             # Remove HTML body to reduce payload size
            api_payload = out.copy()
            api_payload.pop("htmlBody", None)
            payload_bytes = json.dumps(api_payload).encode("utf-8")

            rsp = agent_core.invoke_agent_runtime(
                agentRuntimeArn="arn:aws:bedrock-agentcore:us-east-1:132260253285:runtime/email_agent-SBj8UMELez",
                payload=payload_bytes,
                runtimeSessionId=session_id,
            )

            body_bytes = rsp["response"].read()
            logger.info(f"Agent response {body_bytes}")


            json_response = json.loads(body_bytes.decode("utf-8"))
              
            logger.info(f"Agent response is {json_response}")

            if isinstance(json_response, str):
                json_response = json.loads(json_response)
    

            item["aiInsights"] = json_response
            item["GSI1PK"] = f"USER#{to_addr}"
            item["GSI1SK"] = f"CATEGORY#{json_response['category']}"
            item["GSI2PK"] = f"USER#{to_addr}"
            item["GSI2SK"] = f"SENTIMENT#{json_response['sentiment']}"
            logger.info(f"Agent response item {item}")

            dynamodb_response = table.put_item(Item=item)
            logger.info(f"DynamoDB response {dynamodb_response}")
        except Exception as e:
            logger.error(f"Error processing e-mail agent {e}")
            # logger.error(f"DynamoDB error {e}")
            raise e


