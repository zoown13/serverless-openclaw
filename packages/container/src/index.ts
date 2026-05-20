import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { startContainer } from "./startup.js";

const REQUIRED_ENV = [
  "BRIDGE_AUTH_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "USER_ID",
  "DATA_BUCKET",
  "CALLBACK_URL",
] as const;

const AGENTCORE_REQUIRED_ENV = [
  "OPENCLAW_GATEWAY_TOKEN",
  "USER_ID",
  "DATA_BUCKET",
] as const;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

interface TaskMetadata {
  taskArn: string;
  cluster: string;
}

function isAgentCoreMode(): boolean {
  return process.env.CONTAINER_RUNTIME_MODE === "agentcore" ||
    process.env.AGENTCORE_HTTP_ENABLED === "true";
}

async function getTaskMetadata(agentCoreMode: boolean): Promise<TaskMetadata> {
  if (agentCoreMode) {
    return { taskArn: "agentcore-runtime", cluster: "agentcore" };
  }

  // Prefer env vars if set, otherwise discover from ECS metadata
  if (process.env.TASK_ARN && process.env.CLUSTER_ARN) {
    return { taskArn: process.env.TASK_ARN, cluster: process.env.CLUSTER_ARN };
  }
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (metadataUri) {
    const resp = await fetch(`${metadataUri}/task`);
    const data = (await resp.json()) as { TaskARN?: string; Cluster?: string };
    if (data.TaskARN && data.Cluster) {
      return { taskArn: data.TaskARN, cluster: data.Cluster };
    }
  }
  throw new Error("Cannot determine task metadata from env or ECS metadata");
}

async function main(): Promise<void> {
  const agentCoreMode = isAgentCoreMode();
  const requiredEnv = agentCoreMode ? AGENTCORE_REQUIRED_ENV : REQUIRED_ENV;
  // Validate required env vars
  const env = Object.fromEntries(
    requiredEnv.map((name) => [name, requireEnv(name)]),
  ) as Record<string, string>;

  const taskMetadata = await getTaskMetadata(agentCoreMode);

  // Initialize AWS clients
  const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dynamoSend = dynamoClient.send.bind(dynamoClient) as (cmd: any) => Promise<any>;
  const ecsClient = new ECSClient({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ecsSend = ecsClient.send.bind(ecsClient) as (cmd: any) => Promise<any>;
  const ec2Client = new EC2Client({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ec2Send = ec2Client.send.bind(ec2Client) as (cmd: any) => Promise<any>;

  await startContainer({
    env: {
      BRIDGE_AUTH_TOKEN: env.BRIDGE_AUTH_TOKEN ?? process.env.BRIDGE_AUTH_TOKEN,
      OPENCLAW_GATEWAY_TOKEN: env.OPENCLAW_GATEWAY_TOKEN,
      USER_ID: env.USER_ID,
      DATA_BUCKET: env.DATA_BUCKET,
      CALLBACK_URL: env.CALLBACK_URL ?? process.env.CALLBACK_URL,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
      CONTAINER_RUNTIME_MODE: process.env.CONTAINER_RUNTIME_MODE,
      AGENTCORE_HTTP_ENABLED: process.env.AGENTCORE_HTTP_ENABLED,
    },
    taskMetadata,
    dynamoSend,
    ecsSend,
    ec2Send,
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
