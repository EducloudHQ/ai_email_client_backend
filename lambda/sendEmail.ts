import { AppSyncResolverHandler } from "aws-lambda";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { logger, metrics, tracer } from "../powertools/utilities";
import { SendEmailInput } from "../appsync";

export const handler: AppSyncResolverHandler<
  { input: SendEmailInput },
  Boolean
> = async (event, _context) => {
  const REGION = process.env.AWS_REGION ?? "us-east-2";
  const ses = new SESClient({ region: REGION });

  logger.info(`received event is ${event.arguments.input}`);

  try {
    const { MessageId } = await ses.send(
      new SendEmailCommand({
        Source: event.arguments.input.from,
        Destination: { ToAddresses: event.arguments.input.to },
        Message: {
          Subject: { Data: event.arguments.input.subject!, Charset: "UTF-8" },
          Body: {
            Text: { Data: event.arguments.input.plainBody!, Charset: "UTF-8" },
            // Html: { Data: `<p>${body}</p>`, Charset: "UTF-8" }, // optional
          },
        },
      })
    );

    logger.info(`Email sent with messageId: ${MessageId}`);

    return true;
  } catch (err: any) {
    logger.info(`Email failed to send with err: ${err}`);
    return false;
  }
};
