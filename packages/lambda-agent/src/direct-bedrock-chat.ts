import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { LambdaAgentImageInput } from "@serverless-openclaw/shared";

export interface DirectBedrockChatParams {
  message: string;
  model: string;
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
  imageInput?: LambdaAgentImageInput;
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

function resolveBedrockImageFormat(
  mediaType: LambdaAgentImageInput["mediaType"],
): "jpeg" | "png" | "webp" {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/webp") return "webp";
  return "jpeg";
}

export async function runDirectBedrockChat(
  params: DirectBedrockChatParams,
): Promise<DirectBedrockChatResult> {
  const content = params.imageInput
    ? [
        {
          image: {
            format: resolveBedrockImageFormat(params.imageInput.mediaType),
            source: {
              bytes: Buffer.from(params.imageInput.dataBase64, "base64"),
            },
          },
        },
        { text: params.message },
      ]
    : [{ text: params.message }];

  const response = await client().send(
    new ConverseCommand({
      modelId: params.model,
      system: [{ text: params.systemPrompt }],
      messages: [
        {
          role: "user",
          content,
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
