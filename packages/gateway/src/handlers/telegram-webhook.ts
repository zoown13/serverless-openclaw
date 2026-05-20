import type { APIGatewayProxyResultV2, Context } from "aws-lambda";
import { timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import type { LambdaAgentImageInput } from "@serverless-openclaw/shared";

import { getTaskState, putTaskState, deleteTaskState } from "../services/task-state.js";
import { routeMessage, savePendingMessage } from "../services/message.js";
import { startTask } from "../services/container.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { resolveUserId, verifyOtpAndLink } from "../services/identity.js";
import {
  deleteRoutingContext,
  getRoutingContext,
  putRoutingContext,
} from "../services/routing-context.js";
import { resolveSecrets } from "../services/secrets.js";
import { invokeLambdaAgent } from "../services/lambda-agent.js";
import { invokeAgentCoreRuntime } from "../services/agentcore.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ecs = new ECSClient({});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamoSend = ddb.send.bind(ddb) as (cmd: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ecsSend = ecs.send.bind(ecs) as (cmd: any) => Promise<any>;

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_unique_id?: string; file_size?: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    video?: { file_id: string; file_size?: number };
    animation?: { file_id: string; file_size?: number };
    voice?: { file_id: string; file_size?: number };
    audio?: { file_id: string; file_size?: number };
  };
}

interface TelegramDeliveryRequest {
  connectionId?: string;
  text?: string;
}

type TelegramPhotoSize = NonNullable<NonNullable<TelegramUpdate["message"]>["photo"]>[number];

const TELEGRAM_UNSUPPORTED_MEDIA_MESSAGE =
  "현재 이 Telegram 파일 형식은 아직 지원하지 않습니다. 지금은 텍스트 질문, Gmail/tool 조회, 작은 사진 분석을 처리할 수 있어요.";

const TELEGRAM_IMAGE_TOO_LARGE_MESSAGE =
  "사진을 받았는데 현재 Telegram 경로에서는 작은 이미지만 안전하게 분석할 수 있어요. 스크린샷을 조금 작게 다시 보내거나, 핵심 내용을 텍스트로 함께 적어 주세요.";
const DEFAULT_TELEGRAM_IMAGE_MAX_BYTES = 160_000;

function normalizeDiagnosticText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function getMessageCodePointSample(value: string): string[] {
  return Array.from(normalizeDiagnosticText(value))
    .slice(0, 8)
    .map((char) => {
      const codePoint = char.codePointAt(0);
      return codePoint === undefined ? "unknown" : `U+${codePoint.toString(16).toUpperCase()}`;
    });
}

function hasHangulCharacters(value: string): boolean {
  return /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(
    normalizeDiagnosticText(value),
  );
}

function getTelegramMediaTypes(
  message: NonNullable<TelegramUpdate["message"]>,
): string[] {
  const types: string[] = [];
  if (message.photo?.length) types.push("photo");
  if (message.document) types.push("document");
  if (message.video) types.push("video");
  if (message.animation) types.push("animation");
  if (message.voice) types.push("voice");
  if (message.audio) types.push("audio");
  return types;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTelegramImageMaxBytes(): number {
  return parsePositiveInteger(
    process.env.TELEGRAM_IMAGE_MAX_BYTES,
    DEFAULT_TELEGRAM_IMAGE_MAX_BYTES,
  );
}

function selectTelegramPhoto(
  photos: TelegramPhotoSize[] | undefined,
  maxBytes: number,
): TelegramPhotoSize | undefined {
  if (!photos?.length) return undefined;
  const knownSafe = photos
    .filter((photo) => typeof photo.file_size === "number" && photo.file_size <= maxBytes)
    .sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
  if (knownSafe[0]) return knownSafe[0];

  const knownSmallest = photos
    .filter((photo) => typeof photo.file_size === "number")
    .sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))[0];
  return knownSmallest ?? photos[0];
}

function resolveTelegramImageMediaType(filePath: string): LambdaAgentImageInput["mediaType"] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function timingSafeTokenEqual(actual: string | undefined, expected: string): boolean {
  return Boolean(
    actual &&
    expected &&
    actual.length === expected.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected)),
  );
}

function getBearerToken(headers: Record<string, string | undefined>): string | undefined {
  const authorization = headers.authorization ?? headers.Authorization;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? headers["x-bridge-auth-token"] ?? headers["X-Bridge-Auth-Token"];
}

function isTelegramDeliveryRoute(event: { rawPath?: string; routeKey?: string }): boolean {
  return event.rawPath === "/telegram/deliver" || event.routeKey === "POST /telegram/deliver";
}

async function buildTelegramImageInput(
  botToken: string,
  message: NonNullable<TelegramUpdate["message"]>,
): Promise<{ imageInput?: LambdaAgentImageInput; tooLarge?: boolean }> {
  const maxBytes = resolveTelegramImageMaxBytes();
  const selected = selectTelegramPhoto(message.photo, maxBytes);
  if (!selected) return {};
  if (typeof selected.file_size === "number" && selected.file_size > maxBytes) {
    return { tooLarge: true };
  }

  const fileResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(selected.file_id)}`,
  );
  if (!fileResponse.ok) {
    throw new Error(`Telegram getFile failed with ${fileResponse.status}`);
  }

  const filePayload = await fileResponse.json() as {
    ok?: boolean;
    result?: { file_path?: string; file_size?: number };
  };
  const filePath = filePayload.result?.file_path;
  if (!filePayload.ok || !filePath) {
    throw new Error("Telegram getFile returned no file_path");
  }
  if (typeof filePayload.result?.file_size === "number" && filePayload.result.file_size > maxBytes) {
    return { tooLarge: true };
  }

  const downloadResponse = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`,
  );
  if (!downloadResponse.ok) {
    throw new Error(`Telegram file download failed with ${downloadResponse.status}`);
  }

  const bytes = Buffer.from(await downloadResponse.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    return { tooLarge: true };
  }

  return {
    imageInput: {
      source: "telegram",
      mediaType: resolveTelegramImageMediaType(filePath),
      dataBase64: bytes.toString("base64"),
      fileId: selected.file_id,
      ...(selected.file_unique_id ? { fileUniqueId: selected.file_unique_id } : {}),
      fileSize: bytes.byteLength,
      ...(message.caption ? { caption: message.caption } : {}),
    },
  };
}

export async function handler(event: {
  headers: Record<string, string | undefined>;
  body?: string;
  rawPath?: string;
  routeKey?: string;
}, context?: Pick<Context, "awsRequestId">): Promise<APIGatewayProxyResultV2> {
  const requestStartedAtMs = Date.now();
  const secrets = await resolveSecrets([
    process.env.SSM_BRIDGE_AUTH_TOKEN!,
    process.env.SSM_TELEGRAM_BOT_TOKEN!,
    process.env.SSM_TELEGRAM_SECRET_TOKEN!,
  ]);

  if (isTelegramDeliveryRoute(event)) {
    const bridgeAuthToken = secrets.get(process.env.SSM_BRIDGE_AUTH_TOKEN!) ?? "";
    if (!timingSafeTokenEqual(getBearerToken(event.headers), bridgeAuthToken)) {
      console.warn("[telegram] delivery relay auth failed");
      return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
    }

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing body" }) };
    }

    let delivery: TelegramDeliveryRequest;
    try {
      delivery = JSON.parse(event.body) as TelegramDeliveryRequest;
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    if (!delivery.connectionId?.startsWith("telegram:") || !delivery.text) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid delivery request" }) };
    }

    const botToken = secrets.get(process.env.SSM_TELEGRAM_BOT_TOKEN!) ?? "";
    if (!botToken) {
      return { statusCode: 503, body: JSON.stringify({ error: "Telegram bot token unavailable" }) };
    }

    await sendTelegramMessage(fetch as never, botToken, delivery.connectionId, delivery.text);
    console.log("[telegram] delivery relay sent", {
      connectionId: delivery.connectionId,
      textLength: delivery.text.length,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const secretToken = event.headers["x-telegram-bot-api-secret-token"];
  const expectedToken = secrets.get(process.env.SSM_TELEGRAM_SECRET_TOKEN!) ?? "";

  if (!timingSafeTokenEqual(secretToken, expectedToken)) {
    console.warn("[telegram] auth failed: secret token mismatch");
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }

  if (!event.body) {
    console.log("[telegram] received empty body, ignoring");
    return { statusCode: 200, body: "OK" };
  }

  let update: TelegramUpdate;
  try {
    update = JSON.parse(event.body) as TelegramUpdate;
  } catch {
    console.error("[telegram] failed to parse request body as JSON");
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  if (!update.message) {
    console.log("[telegram] update has no message text, ignoring");
    return { statusCode: 200, body: "OK" };
  }

  const chatId = update.message.chat.id;
  const telegramId = String(update.message.from?.id ?? chatId);
  const rawUserId = `telegram:${telegramId}`;
  const connectionId = `telegram:${chatId}`;
  const botToken = secrets.get(process.env.SSM_TELEGRAM_BOT_TOKEN!) ?? "";
  const mediaTypes = getTelegramMediaTypes(update.message);
  let imageInput: LambdaAgentImageInput | undefined;
  if (update.message.photo?.length) {
    try {
      const result = await buildTelegramImageInput(botToken, update.message);
      if (result.tooLarge) {
        if (botToken) {
          await sendTelegramMessage(
            fetch as never,
            botToken,
            connectionId,
            TELEGRAM_IMAGE_TOO_LARGE_MESSAGE,
          );
        }
        return { statusCode: 200, body: "OK" };
      }
      imageInput = result.imageInput;
      if (imageInput) {
        console.log("[telegram] photo downloaded for image analysis", {
          chatId,
          telegramId,
          mediaType: imageInput.mediaType,
          fileSize: imageInput.fileSize,
          hasCaption: Boolean(imageInput.caption),
        });
      }
    } catch (err) {
      console.warn("[telegram] photo download failed", {
        chatId,
        telegramId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (botToken) {
        await sendTelegramMessage(
          fetch as never,
          botToken,
          connectionId,
          "사진을 받았지만 Telegram에서 이미지를 가져오지 못했어요. 잠시 후 다시 보내 주세요.",
        );
      }
      return { statusCode: 200, body: "OK" };
    }
  }

  const unsupportedMediaTypes = mediaTypes.filter((type) => type !== "photo");
  if (unsupportedMediaTypes.length > 0) {
    console.log("[telegram] unsupported media message", {
      chatId,
      telegramId,
      mediaTypes: unsupportedMediaTypes,
      hasCaption: Boolean(update.message.caption),
    });
    if (botToken) {
      await sendTelegramMessage(
        fetch as never,
        botToken,
        connectionId,
        TELEGRAM_UNSUPPORTED_MEDIA_MESSAGE,
      );
    }
    return { statusCode: 200, body: "OK" };
  }

  if (!update.message.text && !imageInput) {
    console.log("[telegram] update has no message text, ignoring");
    return { statusCode: 200, body: "OK" };
  }

  const text = update.message.text ?? update.message.caption ?? "이 사진을 분석해줘.";

  console.log("[telegram] received message", {
    chatId,
    telegramId,
    textLength: text.length,
    hasHangul: hasHangulCharacters(text),
    messageCodePointSample: getMessageCodePointSample(text),
  });

  // Handle /link command
  if (text.startsWith("/link ")) {
    const code = text.slice(6).trim();
    console.log("[telegram] /link command received", { telegramId });
    if (!/^\d{6}$/.test(code)) {
      console.warn("[telegram] /link invalid code format", { telegramId });
      if (botToken) {
        await sendTelegramMessage(
          fetch as never,
          botToken,
          connectionId,
          "Usage: /link {6-digit code}",
        );
      }
      return { statusCode: 200, body: "OK" };
    }
    const result = await verifyOtpAndLink(dynamoSend, telegramId, code, {
      agentRuntime: process.env.AGENT_RUNTIME,
    });
    console.log("[telegram] /link result", { telegramId, success: !("error" in result) });
    if (botToken) {
      const msg =
        "error" in result
          ? `❌ ${result.error}`
          : "✅ Account linked! Web and Telegram now share the same container.";
      await sendTelegramMessage(fetch as never, botToken, connectionId, msg);
    }
    return { statusCode: 200, body: "OK" };
  }

  // Handle /unlink command
  if (text === "/unlink") {
    console.log("[telegram] /unlink command received", { telegramId });
    if (botToken) {
      await sendTelegramMessage(
        fetch as never,
        botToken,
        connectionId,
        "Unlinking is only available from the Web UI settings.",
      );
    }
    return { statusCode: 200, body: "OK" };
  }

  // Resolve telegram userId to linked cognito userId if available
  const userId = await resolveUserId(dynamoSend, rawUserId);
  console.log("[telegram] resolved userId", { rawUserId, userId, linked: userId !== rawUserId });

  const agentRuntime = (process.env.AGENT_RUNTIME as "lambda" | "fargate" | "both") ?? "fargate";
  const taskState = agentRuntime !== "lambda"
    ? await getTaskState(dynamoSend, userId)
    : null;
  console.log("[telegram] fargate task state", {
    userId,
    taskStatus: taskState?.status ?? "none",
    needsColdStart: !taskState || taskState.status === "Starting",
  });

  // Build environment for RunTask — include TELEGRAM_CHAT_ID when using resolved userId
  const taskEnv = [
    { name: "USER_ID", value: userId },
    { name: "CALLBACK_URL", value: process.env.WEBSOCKET_CALLBACK_URL ?? "" },
  ];
  if (process.env.TELEGRAM_DELIVERY_URL) {
    taskEnv.push({ name: "TELEGRAM_DELIVERY_URL", value: process.env.TELEGRAM_DELIVERY_URL });
  }
  if (userId !== rawUserId) {
    // Linked user: container needs to know the telegram chat ID for notifications
    taskEnv.push({ name: "TELEGRAM_CHAT_ID", value: String(chatId) });
  }

  console.log("[telegram] routing message", { userId, channel: "telegram", agentRuntime });
  const lambdaAgentFunctionArn = process.env.LAMBDA_AGENT_FUNCTION_ARN ?? "";
  const routeResult = await routeMessage({
    userId,
    message: text,
    traceId: context?.awsRequestId ?? `telegram-${chatId}`,
    channel: "telegram",
    connectionId,
    telegramChatId: String(chatId),
    callbackUrl: process.env.WEBSOCKET_CALLBACK_URL ?? "",
    bridgeAuthToken: secrets.get(process.env.SSM_BRIDGE_AUTH_TOKEN!) ?? "",
    imageInput,
    fetchFn: fetch as never,
    getTaskState: (uid) => getTaskState(dynamoSend, uid),
    startTask: (params) => startTask(ecsSend, params),
    putTaskState: (item) => putTaskState(dynamoSend, item),
    savePendingMessage: (item) => savePendingMessage(dynamoSend, item),
    deleteTaskState: (uid) => deleteTaskState(dynamoSend, uid),
    getRoutingContext: (uid, channel) => getRoutingContext(dynamoSend, uid, channel),
    putRoutingContext: (uid, state) => putRoutingContext(dynamoSend, uid, state),
    deleteRoutingContext: (uid, channel) => deleteRoutingContext(dynamoSend, uid, channel),
    sendClarification: (clarification) => sendTelegramMessage(
      fetch as never,
      botToken,
      connectionId,
      clarification,
    ),
    startTaskParams: {
      cluster: process.env.ECS_CLUSTER_ARN ?? "",
      taskDefinition: process.env.TASK_DEFINITION_ARN ?? "",
      subnets: (process.env.SUBNET_IDS ?? "").split(","),
      securityGroups: (process.env.SECURITY_GROUP_IDS ?? "").split(","),
      containerName: "openclaw",
      environment: taskEnv,
    },
    agentRuntime,
    toolRuntimeProvider: (process.env.TOOL_RUNTIME_PROVIDER as "fargate" | "agentcore" | undefined) ?? "agentcore",
    invokeLambdaAgent: lambdaAgentFunctionArn ? invokeLambdaAgent : undefined,
    lambdaAgentFunctionArn: lambdaAgentFunctionArn || undefined,
    invokeAgentCoreRuntime,
    agentCoreRuntimeArn: process.env.AGENTCORE_RUNTIME_ARN ?? "",
    agentCoreRuntimeQualifier: process.env.AGENTCORE_RUNTIME_QUALIFIER,
    agentCoreFallbackProvider: (process.env.AGENTCORE_FALLBACK_PROVIDER as "fargate" | undefined) ?? "fargate",
    requestStartedAtMs,
  });

  if ((routeResult === "started" || routeResult === "queued") && botToken) {
    await sendTelegramMessage(
      fetch as never,
      botToken,
      connectionId,
      "🔄 Waking up the agent... please wait.",
    );
  }

  console.log("[telegram] message routed successfully", { userId });
  return { statusCode: 200, body: "OK" };
}
