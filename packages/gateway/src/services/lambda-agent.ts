import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type {
  AssistantRuntimeContext,
  LambdaAgentImageInput,
} from "@serverless-openclaw/shared";

const lambda = new LambdaClient({});

export interface InvokeLambdaAgentParams {
  functionArn: string;
  userId: string;
  sessionId: string;
  traceId?: string;
  message: string;
  channel: "web" | "telegram";
  connectionId?: string;
  telegramChatId?: string;
  /** WebSocket callback URL — agent uses this to push responses directly */
  callbackUrl?: string;
  assistantContext?: AssistantRuntimeContext;
  imageInput?: LambdaAgentImageInput;
  disableTools?: boolean;
}

/**
 * Invoke the Lambda agent function **asynchronously** (fire-and-forget).
 *
 * The agent Lambda will push responses directly to the WebSocket connection
 * via API Gateway Management API using the provided callbackUrl.
 *
 * Returns immediately after the invoke request is accepted by AWS Lambda.
 */
export async function invokeLambdaAgent(
  params: InvokeLambdaAgentParams,
): Promise<{ accepted: true }> {
  const payload = {
    userId: params.userId,
    sessionId: params.sessionId,
    traceId: params.traceId,
    message: params.message,
    channel: params.channel,
    connectionId: params.connectionId,
    telegramChatId: params.telegramChatId,
    callbackUrl: params.callbackUrl,
    assistantContext: params.assistantContext,
    imageInput: params.imageInput,
    disableTools: params.disableTools,
  };

  await lambda.send(
    new InvokeCommand({
      FunctionName: params.functionArn,
      InvocationType: "Event", // Async — fire-and-forget
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );

  return { accepted: true };
}
