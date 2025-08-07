import { util } from "@aws-appsync/utils";
import { query } from "@aws-appsync/utils/dynamodb";
export const request = (ctx) => {
  const { limit = 10, nextToken, emailId } = ctx.args.input;
  const index = "listEmailsByCategory";
  const key = {
    GSI1PK: { eq: `USER#${emailId}` },
    GSI1SK: { beginsWith: "CATEGORY#" },
  };

  return query({
    query: key,
    index,
    limit,
    nextToken,
    scanIndexForward: true,
  });
};

export const response = (ctx) => {
  return {
    items: ctx.result.items,
    nextToken: ctx.result.nextToken,
  };
};
