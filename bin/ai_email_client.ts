import * as cdk from "aws-cdk-lib";
import { AiEmailClientStack } from "../lib/ai-email-client-stack";

const app = new cdk.App();

// Define environment type
type Environment = "dev" | "staging" | "prod";

// Get environment from context or default to 'dev'
const environment = (app.node.tryGetContext("environment") ||
  "dev") as Environment;

// Configuration for different environments
interface EnvConfig {
  account: string;
  region: string;
  adminEmail: string;
  domainName: string;
  enableBackup: boolean;
}

const envConfigs: Record<Environment, EnvConfig> = {
  dev: {
    account: "132260253285",
    region: "us-east-2",
    adminEmail: "treyrosius@gmail.com", // Replace with actual admin email
    domainName: "846agents.com", // Replace with actual domain for dev
    enableBackup: false, // Disable backups for dev environment
  },
  staging: {
    account: "132260253285",
    region: "us-east-2",
    adminEmail: "treyrosius@gmail.com", // Replace with actual admin email
    domainName: "846agents.com", // Replace with actual domain for staging
    enableBackup: true,
  },
  prod: {
    account: "132260253285",
    region: "us-east-2",
    adminEmail: "treyrosius@gmail.com", // Replace with actual admin email
    domainName: "846agents.com", // Replace with actual domain for production
    enableBackup: true,
  },
};

// Get config for the current environment
const envConfig = envConfigs[environment];

// Create the stack with environment-specific configuration
new AiEmailClientStack(app, `AiEmailClientStack-${environment}`, {
  env: {
    account: envConfig.account,
    region: envConfig.region,
  },
  environment: environment,
  adminEmail: envConfig.adminEmail,
  domainName: envConfig.domainName,
  enableBackup: envConfig.enableBackup,

  // Add stack tags for better organization and cost tracking
  tags: {
    Environment: environment,
    Service: "ai-email-client",
    CostCenter: "email-processing",
    Owner: "email-team",
  },
});

// Log deployment information
console.log(`Deploying AI Email Client for environment: ${environment}`);
console.log(`Region: ${envConfig.region}`);
console.log(`Domain: ${envConfig.domainName}`);
