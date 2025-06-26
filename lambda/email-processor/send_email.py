import os
import json
import boto3


REGION = os.getenv("AWS_REGION", "us-east-2")
SENDER_EMAIL = os.environ["SENDER_EMAIL"]
RECIPIENT_EMAIL = os.environ["RECIPIENT_EMAIL"]

ses = boto3.client("ses", region_name=REGION)


def handler(event, context):
    """
    Expected event shape:
    {
      "subject": "Subject line",
      "body":    "Plain-text email body"
    }
    """

    subject = event.get("subject", "Hello from Lambda")
    body = event.get("body", "This email was sent via Amazon SES!")

    try:
        resp = ses.send_email(
            Source=SENDER_EMAIL,
            Destination={"ToAddresses": [RECIPIENT_EMAIL]},
            Message={
                "Subject": {"Data": subject, "Charset": "UTF-8"},
                "Body": {
                    "Text": {"Data": body, "Charset": "UTF-8"},
                    # uncomment to send HTML, too:
                    # "Html": {"Data": f"<p>{body}</p>", "Charset": "UTF-8"},
                },
            },
        )

        return {
            "statusCode": 200,
            "body": json.dumps(
                {"message": "Email sent", "messageId": resp["MessageId"]}
            ),
        }

    except ses.exceptions.MessageRejected as err:
        # Most common sandbox / verification error
        return {"statusCode": 400, "body": json.dumps({"error": str(err)})}

    except Exception as err:
        return {"statusCode": 500, "body": json.dumps({"error": str(err)})}
