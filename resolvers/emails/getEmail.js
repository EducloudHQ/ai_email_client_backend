import { util } from "@aws-appsync/utils";
import { get } from "@aws-appsync/utils/dynamodb";
export const request = (ctx) => {
  //userId here is the email
  const { emailId, messageId } = ctx.args;

  const key = {
    PK: `USER#${emailId}`,
    SK: `EMAIL#${messageId}`,
  };

  return get({
    key: key,
  });
};

export const response = (ctx) => {
  return ctx.result;
};
