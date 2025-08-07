import { util } from "@aws-appsync/utils";
import { query } from "@aws-appsync/utils/dynamodb";
export const request = (ctx) => {
  const { limit = 10, nextToken, emailId } = ctx.args;
  const index = "listEmailsPerUser";
  const key = {
    PK: { eq: `USER#${emailId}` },
    SK: { beginsWith: "EMAIL#" },
  };

  return query({
    query: key,
    index,
    limit,
    nextToken,
    scanIndexForward: false,
  });
};

export const response = (ctx) => {
  return {
    items: ctx.result.items,
    nextToken: ctx.result.nextToken,
  };
};
