import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export interface DirectBedrockChatParams {
  message: string;
  model: string;
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface DirectBedrockChatResult {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

let cachedClient: BedrockRuntimeClient | undefined;

function client(): BedrockRuntimeClient {
  cachedClient ??= new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
  });
  return cachedClient;
}

export async function runDirectBedrockChat(
  params: DirectBedrockChatParams,
): Promise<DirectBedrockChatResult> {
  const response = await client().send(
    new ConverseCommand({
      modelId: params.model,
      system: [{ text: params.systemPrompt }],
      messages: [
        {
          role: "user",
          content: [{ text: params.message }],
        },
      ],
      inferenceConfig: {
        maxTokens: params.maxTokens ?? 512,
        temperature: params.temperature ?? 0.2,
      },
    }),
  );

  const text = response.output?.message?.content
    ?.map((item) => item.text)
    .filter((item): item is string => typeof item === "string")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Direct Bedrock chat returned an empty response");
  }

  return {
    text,
    usage: {
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      totalTokens: response.usage?.totalTokens,
    },
  };
}
