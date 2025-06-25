import * as cdk from "aws-cdk-lib";
import { AiEmailClientStack } from "../lib/ai_email_client-stack";

const app = new cdk.App();
new AiEmailClientStack(app, "AiEmailClientStack", {
  env: { account: "132260253285", region: "us-east-2" },
});
