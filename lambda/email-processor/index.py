import os
import json
import boto3
from email import policy, utils
from email.parser import BytesParser
from urllib.parse import unquote_plus
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.data_classes import event_source, S3Event
from strands import Agent

from strands.models import BedrockModel

logger = Logger(service="email_parser")
tracer = Tracer(service="email_parser")  # uses env LOG_LEVEL / POWERTOOLS_SERVICE_NAME
bedrock_model = BedrockModel(
    model_id="us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    region_name="us-east-1",
    temperature=0.3,
)
s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])
ATTACH_BUCKET = os.environ["ATTACH_BUCKET"]

EMAIL_SYSTEM_PROMPT = """
You are an **AI Email Intelligence Assistant**. You can:

1. Parse RFC-822 e-mail objects that have already been converted to JSON
   (headers, plain_body, html_body, attachments, etc.).
2. Produce **succinct, user-friendly summaries** of the message body.
3. Assign the message to one **category**:
   “Work”, “Personal”, “Finance”, “Marketing / Promotions”,
   “Social”, “Spam”, “Travel”, “Receipts”, or “Other”.
4. Perform **sentiment analysis** of the sender’s tone
   (Positive, Neutral, Negative, or Mixed).
5. Extract and surface **key information**:
   • dates & times
   • monetary amounts & currencies
   • action items / requests
   • named people & organisations
   • links & attachment filenames
   • reply-by / due-by hints
6. Flag messages that are **urgent** (requesting immediate action,
   containing deadlines < 48 h, critical alert words, etc.).
7. Return a single JSON object that the calling service can store in DynamoDB.

────────────────────
### Input
You receive a JSON payload with at least these keys:

{
  "from":        "<display name & email>",
  "to":          "<comma-separated list>",
  "cc":          "<nullable>",
  "subject":     "<string>",
  "date":        "<RFC-2822 timestamp>",
  "plain_body":  "<string>",        // canonical source for NLP
  "html_body":   "<string|null>",
  "attachments": [
    { "filename": "...", "s3_key": "..." }
  ]
}

────────────────────
### Output
Respond **only** with valid JSON using this schema:

{
  "summary":        "<≤ 60 words>",
  "category":       "<one term from list above>",
  "sentiment":      "<Positive|Neutral|Negative|Mixed>",
  "is_urgent":      <true|false>,
  "key_dates":      ["<ISO-8601>", ...],
  "amounts":        ["<100 USD>", ...],
  "action_items":   ["<string>", ...],
  "entities":       ["<Acme Corp>", "<John Doe>", ...],
  "links":          ["https://...", ...],
  "attachments":    ["invoice.pdf", "photo.jpg"]
}

────────────────────
### Processing guidelines
1. **Prefer `plain_body`** for analysis; fall back to stripped `html_body`
   if needed.
2. When multiple addresses appear in *To* or *Cc*, list them all in extracted
   entities but pick the first address as the primary “user”.
3. Redact PII in the summary if the message is obviously spam or phishing.
4. For monetary amounts, capture the **original currency symbol or code**.
5. Treat emoji or casual language as sentiment clues (🙂 → positive, 😡 → negative).
6. If no meaningful items exist for a field (`key_dates`, `amounts`, …)
   return an **empty array**, not `null`.
7. Never hallucinate facts; base every extraction on explicit text in the e-mail.

────────────────────
### Error handling
If the body is empty or unparsable, return:

{ "error": "EmptyMessage" }

Always strive for precise, context-aware extractions and compact, actionable summaries.
"""


def _get(part):
    if part.is_multipart():
        return b""  # or None
    return getattr(part, "get_content", lambda: part.get_payload(decode=True))()


@event_source(data_class=S3Event)
@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: S3Event, context):
    logger.info(f"Raw S3 event {event}")

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
            "from": msg.get("from"),
            "to": msg.get("to"),
            "cc": msg.get("cc"),
            "bcc": msg.get("bcc"),
            "subject": msg.get("subject"),
            "date": msg.get("date"),
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
            "SK": f"EMAIL#{out['messageId'].strip('<>')}",
            "userId": to_addr,
            **out,
        }

        try:
            email_agent = Agent(
                model=bedrock_model,
                system_prompt=EMAIL_SYSTEM_PROMPT,
            )
            email_str = json.dumps(out, ensure_ascii=False)

            response = email_agent(email_str)

            logger.info(f"Agent response {response}")
            logger.info(f"Agent response {response.message['content'][0]['text']}")
            json_response = json.loads(response.message["content"][0]["text"])
            logger.info(f"Agent response {json_response}")
            item["aiInsights"] = json_response
            logger.info(f"Agent response item {item}")

            dynamodb_response = table.put_item(Item=item)
            logger.info(f"DynamoDB response {dynamodb_response}")
        except Exception as e:
            logger.error(f"Error processing e-mail agent {e}")
            # logger.error(f"DynamoDB error {e}")
            raise e
