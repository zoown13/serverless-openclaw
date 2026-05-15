import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { BEDROCK_DEFAULT_MODEL } from "@serverless-openclaw/shared";
import { SSM_PARAMS, SSM_SECRETS } from "./ssm-params.js";

export interface LambdaAgentStackProps extends cdk.StackProps {
  dataBucket: s3.IBucket;
  taskStateTable: dynamodb.ITable;
  aiProvider?: string;
  aiModel?: string;
  lambdaAgentImageTag?: string;
}

export class LambdaAgentStack extends cdk.Stack {
  public readonly agentFunction: lambda.DockerImageFunction;
  public readonly ecrRepository: ecr.IRepository;

  constructor(scope: Construct, id: string, props: LambdaAgentStackProps) {
    super(scope, id, props);

    // ECR repository — created externally (pre-existing), imported by name.
    // This avoids chicken-and-egg: Lambda needs image in ECR, but CDK creates
    // both ECR and Lambda in the same deploy.
    const repoName = "serverless-openclaw-lambda-agent";
    this.ecrRepository = ecr.Repository.fromRepositoryName(this, "LambdaAgentRepo", repoName);

    // Log group
    const logGroup = new logs.LogGroup(this, "AgentLogs", {
      logGroupName: "/aws/lambda/serverless-openclaw-agent",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const resolvedAiProvider = props.aiProvider ?? "anthropic";
    const resolvedAiModel =
      props.aiModel ?? (resolvedAiProvider === "bedrock" ? BEDROCK_DEFAULT_MODEL : undefined);

    // Lambda function from container image
    this.agentFunction = new lambda.DockerImageFunction(this, "AgentFunction", {
      functionName: "serverless-openclaw-agent",
      code: lambda.DockerImageCode.fromEcr(this.ecrRepository, {
        tagOrDigest: props.lambdaAgentImageTag ?? "latest",
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 2048,
      timeout: cdk.Duration.minutes(15),
      ephemeralStorageSize: cdk.Size.gibibytes(2),
      logGroup,
      environment: {
        HOME: "/tmp",
        NODE_OPTIONS: "--no-deprecation",
        SSM_ANTHROPIC_API_KEY: SSM_SECRETS.ANTHROPIC_API_KEY,
        SSM_TELEGRAM_BOT_TOKEN: SSM_SECRETS.TELEGRAM_BOT_TOKEN,
        SSM_OPENCLAW_AUTH_PROFILES_JSON:
          "/serverless-openclaw/secrets/openclaw-auth-profiles-json",
        SSM_OPENCLAW_OAUTH_JSON:
          "/serverless-openclaw/secrets/openclaw-oauth-json",
        SSM_GOOGLE_OAUTH_CLIENT_JSON:
          "/serverless-openclaw/secrets/google-oauth-client-json",
        SESSION_BUCKET: props.dataBucket.bucketName,
        AI_PROVIDER: resolvedAiProvider,
        LAMBDA_DIRECT_BEDROCK_CHAT: resolvedAiProvider === "bedrock" ? "true" : "false",
        ...(resolvedAiProvider === "bedrock"
          ? { LAMBDA_DIRECT_CHAT_MODEL: "apac.amazon.nova-micro-v1:0" }
          : {}),
        LAMBDA_DIRECT_CHAT_MAX_TOKENS: "320",
        LAMBDA_DIRECT_CHAT_EVERYDAY_MAX_TOKENS: "180",
        AWS_COST_LOOKUP_ENABLED: process.env.AWS_COST_LOOKUP_ENABLED ?? "false",
        AWS_COST_EXPLORER_REGION: process.env.AWS_COST_EXPLORER_REGION ?? "us-east-1",
        ...(resolvedAiModel ? { AI_MODEL: resolvedAiModel } : {}),
      },
    });

    // IAM — S3 session read/write
    props.dataBucket.grantReadWrite(this.agentFunction, "sessions/*");

    // IAM — SSM SecureString resolution
    this.agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameters"],
        resources: [
          cdk.Arn.format(
            {
              service: "ssm",
              resource: "parameter",
              resourceName: "serverless-openclaw/secrets/*",
            },
            this,
          ),
        ],
      }),
    );

    // IAM — DynamoDB TaskState (SessionLock: acquire/release)
    props.taskStateTable.grantReadWriteData(this.agentFunction);

    // IAM — CloudWatch metrics
    this.agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );

    // IAM — AWS Cost Explorer read-only lookup. IAM policies cost nothing.
    this.agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ce:GetCostAndUsage"],
        resources: ["*"],
      }),
    );

    // IAM — Bedrock (always provisioned; IAM policies cost nothing)
    this.agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:ListFoundationModels",
        ],
        resources: ["*"],
      }),
    );

    // IAM — WebSocket push (async invocation: agent pushes responses directly)
    this.agentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [
          `arn:aws:execute-api:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*/*`,
        ],
      }),
    );

    // SSM Parameter for cross-stack consumption
    new ssm.StringParameter(this, "AgentFunctionArnParam", {
      parameterName: SSM_PARAMS.LAMBDA_AGENT_FUNCTION_ARN,
      stringValue: this.agentFunction.functionArn,
    });

    // Outputs
    new cdk.CfnOutput(this, "AgentFunctionArn", {
      value: this.agentFunction.functionArn,
    });
    new cdk.CfnOutput(this, "LambdaAgentRepoUri", {
      value: this.ecrRepository.repositoryUri,
    });
  }
}
