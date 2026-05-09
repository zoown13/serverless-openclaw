import type {
  LambdaAgentEvent,
  LambdaAgentResponse,
  ServerMessage,
} from "./types.js";
import {
  buildRuntimeSessionId,
  estimateCost,
  resolveProviderConfig,
  type CostEstimate,
  type ResolvedRuntimeConfig,
  type TokenUsage,
  type UpstreamCostEstimate,
} from "@serverless-openclaw/shared";
import { initConfig } from "./config-init.js";
import { SessionSync } from "./session-sync.js";
import { SessionLock } from "./session-lock.js";
import { resolveSecrets } from "./secrets.js";
import { runAgent } from "./agent-runner.js";
import { runDirectBedrockChat } from "./direct-bedrock-chat.js";
import { publishLambdaDeliveryMetric } from "./metrics.js";
import { RecentImageContextStore } from "./recent-image-context.js";
import { RecentCostContextStore, type RecentCostContext } from "./recent-cost-context.js";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

// Resolved once at cold start
const providerConfig = resolveProviderConfig();

// Initialized once per Lambda cold start
let initializedConfig: Awaited<ReturnType<typeof initConfig>> | undefined;

interface DeliveryTelemetry {
  traceId: string;
  channel: "web" | "telegram";
  deliveryType: "websocket" | "telegram";
  deliveryTarget: Record<string, string>;
}

function logLambdaEvent(
  event: string,
  payload: Record<string, unknown>,
  level: "info" | "error" = "info",
): void {
  const entry = JSON.stringify({
    component: "lambda-agent",
    event,
    ...payload,
  });

  if (level === "error") {
    console.error(entry);
    return;
  }

  console.info(entry);
}

function logRuntimeSummary(runtimeConfig: ResolvedRuntimeConfig): void {
  console.info(
    `[runtime] provider=${runtimeConfig.provider} model=${runtimeConfig.defaultModel} capability=${runtimeConfig.capability} sessionNamespace=${runtimeConfig.sessionNamespace} gmailReady=${runtimeConfig.readiness.gmailReady} toolRuntimeReady=${runtimeConfig.readiness.toolRuntimeReady}`,
  );
}

/**
 * Push a message to a WebSocket connection via API Gateway Management API.
 */
async function pushToConnection(
  callbackUrl: string,
  connectionId: string,
  msg: ServerMessage,
  telemetry?: DeliveryTelemetry,
): Promise<void> {
  const apigw = new ApiGatewayManagementApiClient({ endpoint: callbackUrl });
  try {
    await apigw.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(msg),
      }),
    );

    if (telemetry) {
      logLambdaEvent("lambda.delivery.websocket.success", {
        traceId: telemetry.traceId,
        channel: telemetry.channel,
        deliveryType: telemetry.deliveryType,
        deliveryTarget: telemetry.deliveryTarget,
        messageType: msg.type,
      });
      void publishLambdaDeliveryMetric("DeliverySuccess", {
        channel: telemetry.channel,
        deliveryType: "websocket",
      });
    }
  } catch (err: unknown) {
    const errorName = err instanceof Error ? err.name : "UnknownError";
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (telemetry) {
      logLambdaEvent("lambda.delivery.websocket.failure", {
        traceId: telemetry.traceId,
        channel: telemetry.channel,
        deliveryType: telemetry.deliveryType,
        deliveryTarget: telemetry.deliveryTarget,
        messageType: msg.type,
        error: errorMessage,
        errorName,
      }, "error");
      void publishLambdaDeliveryMetric("DeliveryFailure", {
        channel: telemetry.channel,
        deliveryType: "websocket",
      });
    }

    // GoneException = client disconnected, not an error for control flow
    if (err instanceof Error && err.name === "GoneException") return;
    console.error("[push] Failed to push to connection:", err);
  }
}

function normalizeTelegramChatId(chatId?: string): string | undefined {
  if (!chatId) return undefined;
  return chatId.startsWith("telegram:") ? chatId.slice(9) : chatId;
}

function buildTelegramContentQuality(text: string): Record<string, boolean | number> {
  return {
    textLength: text.length,
    hasGeneralChatAnswer: text.trim().length >= 20 && !/답변을 생성하지 못했습니다/i.test(text),
    hasFindCommandAnswer:
      /(find\s|find\s*명령어|파일.*찾|찾을.*파일|grep|fd\s|locate|명령어)/i.test(text),
    hasFallbackFailureText:
      /(답변을 생성하지 못했습니다|missing scope:\s*operator\.write|TaskDefinition is inactive|Cannot read properties|TypeError|ReferenceError|An error occurred|접근 불가)/i.test(
        text,
      ),
    hasGmailCapabilityDeflection:
      /(도구 runtime|tool runtime|agentcore|지메일|Gmail)/i.test(text) &&
      /(확인|조회|처리|담당|위임|가능)/i.test(text),
  };
}

async function pushToTelegram(
  botToken: string,
  chatId: string,
  text: string,
  telemetry?: DeliveryTelemetry,
): Promise<void> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logLambdaEvent("lambda.delivery.telegram.failure", {
        traceId: telemetry?.traceId,
        channel: telemetry?.channel ?? "telegram",
        deliveryType: "telegram",
        deliveryTarget: telemetry?.deliveryTarget ?? { type: "telegram", chatId },
        status: response.status,
        error: body,
        textLength: text.length,
      }, "error");
      console.error("[telegram] failed to deliver message", {
        chatId,
        status: response.status,
        body,
        textLength: text.length,
      });
      void publishLambdaDeliveryMetric("DeliveryFailure", {
        channel: telemetry?.channel ?? "telegram",
        deliveryType: "telegram",
      });
      return;
    }

    logLambdaEvent("lambda.delivery.telegram.success", {
      traceId: telemetry?.traceId,
      channel: telemetry?.channel ?? "telegram",
      deliveryType: "telegram",
      deliveryTarget: telemetry?.deliveryTarget ?? { type: "telegram", chatId },
      status: response.status,
      textLength: text.length,
    });
    logLambdaEvent("lambda.delivery.content_quality", {
      traceId: telemetry?.traceId,
      channel: telemetry?.channel ?? "telegram",
      deliveryType: "telegram",
      ...buildTelegramContentQuality(text),
    });
    console.info("[telegram] delivered message", {
      chatId,
      status: response.status,
      textLength: text.length,
    });
    void publishLambdaDeliveryMetric("DeliverySuccess", {
      channel: telemetry?.channel ?? "telegram",
      deliveryType: "telegram",
    });
  } catch (err) {
    logLambdaEvent("lambda.delivery.telegram.failure", {
      traceId: telemetry?.traceId,
      channel: telemetry?.channel ?? "telegram",
      deliveryType: "telegram",
      deliveryTarget: telemetry?.deliveryTarget ?? { type: "telegram", chatId },
      error: err instanceof Error ? err.message : "network-error",
      textLength: text.length,
    }, "error");
    // Telegram failures should not block agent response.
    console.error("[telegram] failed to deliver message", {
      chatId,
      error: "network-error",
      textLength: text.length,
    });
    void publishLambdaDeliveryMetric("DeliveryFailure", {
      channel: telemetry?.channel ?? "telegram",
      deliveryType: "telegram",
    });
  }
}

async function pushPayloads(
  payloads: Array<{ text?: string; mediaUrl?: string; isError?: boolean }> | undefined,
  options: {
    canPush: boolean;
    callbackUrl?: string;
    connectionId?: string;
    isTelegram: boolean;
    telegramBotToken?: string;
    telegramChatId?: string;
    traceId: string;
    channel: "web" | "telegram";
  },
): Promise<void> {
  if (options.canPush && options.callbackUrl && options.connectionId) {
    for (const payload of payloads ?? []) {
      if (payload.text) {
        await pushToConnection(options.callbackUrl, options.connectionId, {
          type: "message",
          content: payload.text,
        }, {
          traceId: options.traceId,
          channel: options.channel,
          deliveryType: "websocket",
          deliveryTarget: { type: "websocket", connectionId: options.connectionId },
        });
      }
    }
    return;
  }

  if (options.isTelegram && options.telegramBotToken && options.telegramChatId) {
    for (const payload of payloads ?? []) {
      if (payload.text) {
        await pushToTelegram(options.telegramBotToken, options.telegramChatId, payload.text, {
          traceId: options.traceId,
          channel: options.channel,
          deliveryType: "telegram",
          deliveryTarget: { type: "telegram", chatId: options.telegramChatId },
        });
      }
    }
  }
}

function normalizeAgentPayloads(
  payloads: Array<{ text?: string; mediaUrl?: string; isError?: boolean }> | undefined,
  partialReplyChunks: string[],
  channel: "web" | "telegram",
): Array<{ text?: string; mediaUrl?: string; isError?: boolean }> {
  if (payloads?.some((payload) => payload.text && payload.text.trim().length > 0)) {
    return payloads;
  }

  const partialReply = partialReplyChunks.join("").trim();
  if (partialReply.length > 0) {
    return [{ text: partialReply }];
  }

  if (channel === "telegram") {
    return [{
      text: "답변을 생성하지 못했습니다. 한 번만 다시 물어봐 주세요.",
      isError: true,
    }];
  }

  return payloads ?? [];
}

async function pushIdleStatus(
  canPush: boolean,
  traceId: string,
  callbackUrl?: string,
  connectionId?: string,
): Promise<void> {
  if (!canPush || !callbackUrl || !connectionId) return;

  await pushToConnection(callbackUrl, connectionId, {
    type: "status",
    status: "Idle",
  }, {
    traceId,
    channel: "web",
    deliveryType: "websocket",
    deliveryTarget: { type: "websocket", connectionId },
  });
}

function resolveDeliveryError(
  event: LambdaAgentEvent,
  telegramBotTokenPath?: string,
): string | undefined {
  if (event.channel === "web") {
    if (!event.connectionId || !event.callbackUrl) {
      return "Web delivery requires both connectionId and callbackUrl";
    }
    return undefined;
  }

  if (!normalizeTelegramChatId(event.telegramChatId ?? event.connectionId)) {
    return "Telegram delivery requires telegramChatId or connectionId";
  }

  if (!telegramBotTokenPath) {
    return "SSM_TELEGRAM_BOT_TOKEN environment variable not set";
  }

  return undefined;
}

function isToolRequest(message: string): boolean {
  return [
    /(?:check|read|open|search|send).*(?:gmail|email|inbox)/i,
    /(?:gmail|email|inbox).*(?:check|read|open|search|send)/i,
    /(?:payment|transaction|spending|expense|card).*(?:history|records?|statement|total|summary|lookup|check)/i,
    /(?:history|records?|statement|total|summary).*(?:payment|transaction|spending|expense|card)/i,
    /(?:확인|읽|열|검색|보내).*(?:지메일|이메일|받은편지함)/,
    /(?:지메일|이메일|받은편지함).*(?:확인|읽|열|검색|보내)/,
    /(?:결제|지출|카드값|카드\s*사용|사용금액|거래|승인|영수증|명세서).*(?:이력|기록|내역|금액|합계|얼마|조회|확인|가져오|보여|정리|찾)/,
    /(?:이력|기록|내역|금액|합계|얼마).*(?:결제|지출|카드|거래|승인|영수증|명세서)/,
    /\buse\b.*\btool\b/i,
    /\btool\b.*\b(use|run)\b/i,
    /도구.*(?:사용|실행)/,
    /(?:사용|실행).*도구/,
  ].some((pattern) => pattern.test(message));
}

function isDirectBedrockChatEnabled(): boolean {
  return process.env.LAMBDA_DIRECT_BEDROCK_CHAT === "true";
}

function parseDirectChatMaxTokens(): number {
  const parsed = Number.parseInt(process.env.LAMBDA_DIRECT_CHAT_MAX_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 320;
}

function parseEverydayDirectChatMaxTokens(): number {
  const parsed = Number.parseInt(process.env.LAMBDA_DIRECT_CHAT_EVERYDAY_MAX_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
}

function parseDirectVisionMaxTokens(): number {
  const parsed = Number.parseInt(process.env.LAMBDA_DIRECT_VISION_MAX_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 420;
}

function parseOptionalPositiveFloat(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseLambdaMemoryMb(): number | undefined {
  const parsed = Number.parseInt(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveLambdaArchitecture(): "arm64" | "x86_64" {
  return process.env.LAMBDA_ARCHITECTURE === "x86_64" ? "x86_64" : "arm64";
}

function logCostEstimate(
  event: LambdaAgentEvent,
  basePayload: Record<string, unknown>,
  params: {
    model?: string;
    durationMs: number;
    tokenUsage?: TokenUsage;
    runtimeClass?: "chat-only" | "tool-enabled";
  },
): CostEstimate {
  const estimate = estimateCost({
    traceId: String(basePayload.traceId ?? event.traceId ?? `lambda-${event.sessionId}`),
    userId: event.userId,
    channel: event.channel,
    runtimeClass: params.runtimeClass ?? event.assistantContext?.runtime.runtimeClass ?? "chat-only",
    provider: "lambda",
    model: params.model,
    durationMs: params.durationMs,
    memoryMb: parseLambdaMemoryMb(),
    architecture: resolveLambdaArchitecture(),
    tokenUsage: params.tokenUsage,
    upstreamCosts: resolveUpstreamCosts(event),
    bedrockInputUsdPerMillionOverride: parseOptionalPositiveFloat(
      process.env.BEDROCK_INPUT_USD_PER_MILLION_TOKENS,
    ),
    bedrockOutputUsdPerMillionOverride: parseOptionalPositiveFloat(
      process.env.BEDROCK_OUTPUT_USD_PER_MILLION_TOKENS,
    ),
  });

  logLambdaEvent("lambda.cost.estimated", {
    ...basePayload,
    model: params.model,
    durationMs: params.durationMs,
    durationSource: "handler_measured_excludes_init",
    estimatedUsd: estimate.estimatedUsd,
    costConfidence: estimate.confidence,
    costBreakdown: estimate.breakdown,
    tokenUsage: estimate.tokenUsage,
    upstreamCosts: estimate.upstreamCosts,
    pricing: estimate.pricing,
  });
  return estimate;
}

function resolveUpstreamCosts(event: LambdaAgentEvent): UpstreamCostEstimate[] | undefined {
  const upstream = event.assistantContext?.cost?.upstream;
  if (!upstream?.length) return undefined;

  const safe = upstream
    .filter((item) =>
      item.name.trim().length > 0 &&
      Number.isFinite(item.estimatedUsd) &&
      item.estimatedUsd >= 0)
    .map((item) => ({
      name: item.name,
      provider: item.provider,
      estimatedUsd: item.estimatedUsd,
      ...(typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
        ? { durationMs: item.durationMs }
        : {}),
      ...(item.confidence ? { confidence: item.confidence } : {}),
      ...(item.breakdown ? { breakdown: item.breakdown } : {}),
    }));

  return safe.length > 0 ? safe : undefined;
}

async function saveRecentCostEstimate(
  store: RecentCostContextStore,
  event: LambdaAgentEvent,
  sessionId: string,
  estimate: CostEstimate,
  basePayload: Record<string, unknown>,
): Promise<void> {
  try {
    const saved = await store.save(event.userId, sessionId, estimate);
    logLambdaEvent("lambda.cost.saved", {
      ...basePayload,
      estimatedUsd: estimate.estimatedUsd,
      expiresAt: saved.expiresAt,
    });
  } catch (err: unknown) {
    logLambdaEvent("lambda.cost.save_failed", {
      ...basePayload,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isCostLookupRequest(message: string): boolean {
  const normalized = message.trim();
  if (!normalized || normalized.length > 120 || isToolRequest(normalized)) {
    return false;
  }

  return [
    /^\/(?:cost|usage|요금|비용)\b/i,
    /(?:이번|방금|직전|마지막|이전).*(?:질문|요청|응답|호출).*(?:비용|요금|얼마|cost)/i,
    /(?:비용|요금|cost).*(?:이번|방금|직전|마지막|이전|얼마)/i,
    /(?:얼마).*(?:썼|나왔|들었).*(?:이번|방금|직전|마지막|요청|질문|호출)/i,
  ].some((pattern) => pattern.test(normalized));
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) return "unknown";
  if (value > 0 && value < 0.000001) return "<$0.000001";
  return `$${value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function buildRecentCostMessage(context: RecentCostContext | undefined): string {
  if (!context) {
    return "아직 직전 질의 비용 추정 기록이 없어요. 일반 대화나 이미지 분석을 한 번 실행한 뒤 `/cost` 또는 `이번 질문 비용 얼마야?`라고 물어봐 주세요.";
  }

  const estimate = context.estimate;
  const parts = [
    `직전 질의 추정 비용은 약 ${formatUsd(estimate.estimatedUsd)} 입니다.`,
    "",
    `- Bedrock: ${formatUsd(estimate.breakdown.bedrockUsd)}`,
    `- Lambda 실행: ${formatUsd(estimate.breakdown.lambdaUsd)}`,
    `- Lambda 요청: ${formatUsd(estimate.breakdown.requestUsd)}`,
  ];
  if (estimate.breakdown.upstreamUsd !== undefined) {
    parts.push(`- Gateway/frontdoor: ${formatUsd(estimate.breakdown.upstreamUsd)}`);
    for (const upstream of estimate.upstreamCosts ?? []) {
      const durationSuffix = upstream.durationMs !== undefined
        ? ` (${upstream.durationMs} ms)`
        : "";
      parts.push(
        `  - ${upstream.name}: ${formatUsd(upstream.estimatedUsd)}${durationSuffix}`,
      );
    }
  }

  if (estimate.tokenUsage?.inputTokens !== undefined || estimate.tokenUsage?.outputTokens !== undefined) {
    parts.push(
      `- Tokens: input ${estimate.tokenUsage.inputTokens ?? 0}, output ${estimate.tokenUsage.outputTokens ?? 0}`,
    );
  }

  parts.push(
    `- Runtime: ${estimate.provider}${estimate.model ? ` / ${estimate.model}` : ""}`,
    "",
    "정확한 AWS 청구액은 Billing 반영 후 달라질 수 있고, 이 값은 질의 직후 추정치입니다.",
  );

  return parts.join("\n");
}

function resolveDirectChatModel(
  event: LambdaAgentEvent,
  runtimeConfig: ResolvedRuntimeConfig,
): string {
  return event.model ?? process.env.LAMBDA_DIRECT_CHAT_MODEL ?? runtimeConfig.defaultModel;
}

function resolveDirectVisionModel(
  event: LambdaAgentEvent,
  runtimeConfig: ResolvedRuntimeConfig,
): string {
  return event.model ??
    process.env.LAMBDA_DIRECT_VISION_MODEL ??
    runtimeConfig.defaultModel;
}

function isEverydayStatelessChatQuestion(message: string): boolean {
  return [
    /(?:메뉴|음식|저녁|점심|아침|간식|야식|레시피|recipe|menu|dinner|lunch|breakfast|snack).*(?:추천|골라|뭐\s*먹|어때|정해|알려줘|suggest|recommend|pick)/i,
    /(?:추천|골라|뭐\s*먹|어때|정해|알려줘|suggest|recommend|pick).*(?:메뉴|음식|저녁|점심|아침|간식|야식|레시피|recipe|menu|dinner|lunch|breakfast|snack)/i,
    /(?:날씨|weather|농담|joke).*(?:알려줘|어때|해줘|말해줘|tell|what)/i,
  ].some((pattern) => pattern.test(message));
}

function isStatelessChatQuestion(message: string): boolean {
  const normalized = message.trim();
  if (!normalized || normalized.length > 500 || isToolRequest(normalized)) {
    return false;
  }

  return [
    /(?:리눅스|linux|파이썬|python|자바스크립트|javascript|타입스크립트|typescript|git|깃|docker|도커|kubernetes|쿠버네티스|aws|lambda|람다|명령어|코드|개념|뜻|의미|차이|예시|방법|문법|영어).*(?:알려줘|설명해|가르쳐|어떻게|뭐야|무엇|작성해|번역해)/i,
    /(?:알려줘|설명해|가르쳐|어떻게|뭐야|무엇|작성해|번역해).*(?:리눅스|linux|파이썬|python|자바스크립트|javascript|타입스크립트|typescript|git|깃|docker|도커|kubernetes|쿠버네티스|aws|lambda|람다|명령어|코드|개념|뜻|의미|차이|예시|방법|문법|영어)/i,
    /^(?:what|how|why|explain|translate)\b/i,
  ].some((pattern) => pattern.test(normalized)) || isEverydayStatelessChatQuestion(normalized);
}

function resolveDirectChatMaxTokens(message: string): number {
  return isEverydayStatelessChatQuestion(message)
    ? parseEverydayDirectChatMaxTokens()
    : parseDirectChatMaxTokens();
}

function shouldUseDirectBedrockChat(
  event: LambdaAgentEvent,
  runtimeConfig: ResolvedRuntimeConfig,
): boolean {
  return (
    isDirectBedrockChatEnabled() &&
    runtimeConfig.provider === "bedrock" &&
    runtimeConfig.capability === "chat-only" &&
    isStatelessChatQuestion(event.message)
  );
}

function isRecentImageFollowUp(message: string): boolean {
  const normalized = message.trim();
  if (!normalized || normalized.length > 220 || isToolRequest(normalized)) {
    return false;
  }

  return [
    /(?:이거|이\s*사진|방금|아까|위(?:에|의)?|그\s*이미지|그\s*사진|사진|이미지).*(?:다시|분석|봐줘|읽어|추출|정리|표|자세히|설명|뭐야|무엇)/i,
    /(?:다시|분석|봐줘|읽어|추출|정리|표|자세히|설명).*(?:이거|이\s*사진|방금|아까|위(?:에|의)?|그\s*이미지|그\s*사진|사진|이미지)/i,
    /^(?:다시\s*)?(?:분석|읽어|추출|정리|요약|표로|테이블로|목록으로|자세히|설명)(?:해줘|해|해줄래)?$/i,
    /^(?:더\s*)?(?:자세히\s*)?(?:봐줘|분석해줘|설명해줘|알려줘)$/i,
    /^(?:표|테이블|목록|불릿|요약)(?:\s*(?:형태|형식|방식)?(?:로|으로))?\s*(?:정리|요약|변환|만들어|보여)(?:해줘|해|해줄래|줘)?$/i,
  ].some((pattern) => pattern.test(normalized));
}

function buildDirectChatSystemPrompt(
  event: LambdaAgentEvent,
  runtimeConfig: ResolvedRuntimeConfig,
): string {
  return [
    "You are Serverless OpenClaw's fast chat runtime.",
    "Answer in the user's language with concise, useful plain text.",
    "For straightforward how-to, concept, command, translation, or explanation questions, answer directly without mentioning routing internals, usually in three to five short bullets or sentences.",
    "Do not claim Gmail, payment history, or private tools are impossible when AssistantRuntimeContext says they are available through the delegated tool runtime.",
    buildAssistantContextPrompt(event),
    buildEmailTokenBudgetPrompt(runtimeConfig),
  ].filter((item): item is string => typeof item === "string" && item.length > 0).join(" ");
}

function buildDirectVisionSystemPrompt(
  event: LambdaAgentEvent,
  runtimeConfig: ResolvedRuntimeConfig,
): string {
  return [
    buildDirectChatSystemPrompt(event, runtimeConfig),
    "The user attached an image. Analyze only the visible image and the user's caption/message.",
    "If the image contains private data, summarize only what is needed for the user's request and avoid exposing unnecessary sensitive details.",
    "If the user asks for text extraction, transcribe visible text faithfully and mention uncertainty when the image is unclear.",
  ].join(" ");
}

function buildToolUnavailableMessage(runtimeConfig: ResolvedRuntimeConfig): string {
  if (!runtimeConfig.readiness.gmailReady) {
    return "Gmail is not connected in this serverless runtime yet. Chat is working, but email access needs a valid openclaw-oauth-json token secret. The OAuth client JSON alone is not enough.";
  }

  return "This serverless runtime is currently chat-only for stability. Gmail and other tool actions are disabled on the Bedrock Lambda path right now.";
}

function hasDelegatedToolRuntime(event: LambdaAgentEvent): boolean {
  return event.assistantContext?.capabilities.tools.available === true;
}

function buildDelegatedToolRuntimeMessage(event: LambdaAgentEvent): string {
  const provider = event.assistantContext?.runtime.toolRuntimeProvider ?? "tool runtime";
  if (event.channel === "telegram") {
    return `결제 이력은 지메일(Gmail) 기반 도구 런타임에서 확인할 수 있어요. 다만 현재 턴은 빠른 Lambda 채팅 경로로 들어와 실제 조회를 바로 실행하지 않았습니다. 실제 조회는 ${provider} 도구 런타임에서 처리해야 하며, 이 misroute는 관측 로그에 남겨 라우팅 개선 대상으로 추적합니다.`;
  }

  return `Payment history can be checked through the Gmail-backed delegated tool runtime. The current Lambda path is the fast chat runtime, while ${provider} owns actual Gmail/tool execution. This should be handled by the tool runtime path rather than answered as unavailable.`;
}

function buildAssistantContextPrompt(event: LambdaAgentEvent): string | undefined {
  const context = event.assistantContext;
  if (!context) return undefined;

  return [
    `AssistantRuntimeContext v${context.version}: current route=${context.runtime.runtimeClass}/${context.runtime.routeDecision ?? "unknown"}.`,
    `Tool runtime provider=${context.runtime.toolRuntimeProvider ?? "unknown"}, fallback=${context.runtime.fallbackProvider ?? "unknown"}, activeToolAffinity=${context.toolAffinity?.active === true}.`,
    `Gmail capability=${context.capabilities.gmail.status}, executionRuntime=${context.capabilities.gmail.executionRuntime}, safety=${context.capabilities.gmail.safetyMode}.`,
    "Payment history, card spending, receipts, statements, and transaction history are Gmail-backed tool-capable tasks when Gmail capability is available via the delegated tool runtime.",
    context.guidance.selfAwareness,
    context.guidance.lambda,
  ].join(" ");
}

function buildEmailTokenBudgetPrompt(runtimeConfig: ResolvedRuntimeConfig): string | undefined {
  if (!runtimeConfig.readiness.gmailReady || !runtimeConfig.readiness.toolRuntimeReady) {
    return undefined;
  }

  const budget = runtimeConfig.emailTokenBudget;
  const bodyAccessInstruction = budget.requireExplicitBodyAccess
    ? "Do not read full message bodies or attachments unless the user explicitly asks for a specific message."
    : "Only read a message body when the task truly needs it, and keep the scope narrow.";

  return [
    "When handling Gmail or email requests, operate in headers-first safe mode to control token usage.",
    `Show at most ${budget.maxMessages} detailed Gmail messages per step.`,
    `For payment summaries, scan up to ${budget.paymentScanMessages} headers/snippets for aggregation before showing a short evidence list.`,
    `Prefer sender, subject, date, and snippet previews truncated to ${budget.maxSnippetChars} characters.`,
    bodyAccessInstruction,
    `If body access is needed, read at most ${budget.maxBodyChars} characters from one message at a time and summarize incrementally before reading more.`,
  ].join(" ");
}

function buildExtraSystemPrompt(
  event: LambdaAgentEvent,
  runtimeConfig: ResolvedRuntimeConfig,
): string | undefined {
  const prompts: string[] = [];

  const assistantContextPrompt = buildAssistantContextPrompt(event);
  if (assistantContextPrompt) {
    prompts.push(assistantContextPrompt);
  }

  if (event.channel === "telegram" || !runtimeConfig.readiness.toolRuntimeReady) {
    prompts.push(
      "You are replying inside a serverless runtime. Respond with plain text only. Do not output function_calls blocks, XML tool tags, or shell commands. Do not ask the user to restart gateway/daemon/processes. If execution capabilities are unavailable in this Lambda invocation, explain briefly and continue with a normal assistant answer. If AssistantRuntimeContext says Gmail or tools are available through a delegated tool runtime, do not say the whole assistant cannot access them; say that the tool runtime must handle or verify the lookup. Otherwise do not claim Gmail or other tools are connected. For normal chat questions, answer in the user's language with enough context to be useful, usually two to five concise sentences or bullets. Do not reply with only an acknowledgement or a single command unless the user explicitly asks for only that.",
    );
  }

  const emailTokenBudgetPrompt = buildEmailTokenBudgetPrompt(runtimeConfig);
  if (emailTokenBudgetPrompt) {
    prompts.push(emailTokenBudgetPrompt);
  }

  return prompts.length > 0 ? prompts.join(" ") : undefined;
}

async function ensureInitialized(): Promise<Awaited<ReturnType<typeof initConfig>>> {
  if (initializedConfig) {
    return initializedConfig;
  }

  let apiKey: string | undefined;
  const secretPaths: string[] = [];
  let anthropicKeyPath: string | undefined;

  if (providerConfig.secretContract.requiresAnthropicApiKey) {
    anthropicKeyPath =
      process.env.SSM_ANTHROPIC_API_KEY ??
      "/serverless-openclaw/secrets/anthropic-api-key";
    secretPaths.push(anthropicKeyPath);
  }
  if (process.env.SSM_OPENCLAW_AUTH_PROFILES_JSON) {
    secretPaths.push(process.env.SSM_OPENCLAW_AUTH_PROFILES_JSON);
  }
  if (process.env.SSM_OPENCLAW_OAUTH_JSON) {
    secretPaths.push(process.env.SSM_OPENCLAW_OAUTH_JSON);
  }
  if (process.env.SSM_GOOGLE_OAUTH_CLIENT_JSON) {
    secretPaths.push(process.env.SSM_GOOGLE_OAUTH_CLIENT_JSON);
  }

  const secrets = secretPaths.length > 0 ? await resolveSecrets(secretPaths) : new Map();
  if (anthropicKeyPath) {
    apiKey = secrets.get(anthropicKeyPath);
  }

  initializedConfig = await initConfig({
    anthropicApiKey: apiKey,
    runtimeConfig: providerConfig,
    openclawAuthProfilesJson: process.env.SSM_OPENCLAW_AUTH_PROFILES_JSON
      ? secrets.get(process.env.SSM_OPENCLAW_AUTH_PROFILES_JSON)
      : undefined,
    openclawOauthJson: process.env.SSM_OPENCLAW_OAUTH_JSON
      ? secrets.get(process.env.SSM_OPENCLAW_OAUTH_JSON)
      : undefined,
    googleOauthClientJson: process.env.SSM_GOOGLE_OAUTH_CLIENT_JSON
      ? secrets.get(process.env.SSM_GOOGLE_OAUTH_CLIENT_JSON)
      : undefined,
  });
  process.env.OPENCLAW_CONFIG_PATH = "/tmp/.openclaw/openclaw.json";
  process.env.OPENCLAW_STATE_DIR = "/tmp/.openclaw";
  process.env.OPENCLAW_AGENT_DIR = "/tmp/.openclaw/agents/main/agent";
  (globalThis as { __OPENCLAW_EMBEDDED_CONFIG__?: Record<string, unknown> }).__OPENCLAW_EMBEDDED_CONFIG__ =
    initializedConfig.config;
  logRuntimeSummary(initializedConfig.runtimeConfig);
  return initializedConfig;
}

/**
 * Lambda handler that runs OpenClaw's agent runtime directly.
 *
 * Flow (async invocation):
 * 1. Resolve secrets from SSM (cached per instance)
 * 2. Initialize OpenClaw config in /tmp
 * 3. Download session file from S3
 * 4. Push "running" status to WebSocket
 * 5. Run agent via runEmbeddedPiAgent()
 * 6. Push each response payload to WebSocket
 * 7. Push "Idle" status to WebSocket
 * 8. Upload session file back to S3
 */
export async function handler(
  event: LambdaAgentEvent,
): Promise<LambdaAgentResponse> {
  const startTime = Date.now();
  const traceId = event.traceId ?? `lambda-${event.sessionId}`;

  // Ensure HOME points to /tmp for OpenClaw config resolution
  process.env.HOME = "/tmp";

  const bucket = process.env.SESSION_BUCKET;
  if (!bucket) {
    return {
      success: false,
      error: "SESSION_BUCKET environment variable not set",
    };
  }

  const telegramBotTokenPath = process.env.SSM_TELEGRAM_BOT_TOKEN;
  const deliveryError = resolveDeliveryError(event, telegramBotTokenPath);
  if (deliveryError) {
    return {
      success: false,
      error: deliveryError,
      durationMs: Date.now() - startTime,
    };
  }

  const canPush = event.channel === "web";
  const telegramChatId = normalizeTelegramChatId(
    event.telegramChatId ?? event.connectionId,
  );
  const isTelegram = event.channel === "telegram" && !!telegramChatId && !!telegramBotTokenPath;

  let telegramBotToken: string | undefined;

  const lock = new SessionLock(event.userId);
  const acquired = await lock.acquire();
  if (!acquired) {
    if (canPush) {
      await pushToConnection(event.callbackUrl!, event.connectionId!, {
        type: "error",
        error: "Session is already being processed",
      }, {
        traceId,
        channel: event.channel,
        deliveryType: "websocket",
        deliveryTarget: { type: "websocket", connectionId: event.connectionId! },
      });
    } else if (isTelegram && telegramBotTokenPath) {
      const secrets = await resolveSecrets([telegramBotTokenPath]);
      const busyTelegramBotToken = secrets.get(telegramBotTokenPath);
      if (busyTelegramBotToken && telegramChatId) {
        await pushToTelegram(
          busyTelegramBotToken,
          telegramChatId,
          "앞선 요청을 아직 처리 중이에요. 사진 분석은 조금만 기다렸다가 이어서 요청해 주세요.",
          {
            traceId,
            channel: event.channel,
            deliveryType: "telegram",
            deliveryTarget: { type: "telegram", chatId: telegramChatId },
          },
        );
      }
    }
    return {
      success: false,
      error: "Session is already being processed",
    };
  }

  const configInit = await ensureInitialized();
  const runtimeConfig = configInit.runtimeConfig;
  const sessionId = buildRuntimeSessionId(runtimeConfig, event.channel, event.sessionId);
  const recentImageStore = new RecentImageContextStore(bucket);
  const recentCostStore = new RecentCostContextStore(bucket);
  const deliveryTarget = event.channel === "web"
    ? { type: "websocket", connectionId: event.connectionId ?? "unknown" }
    : { type: "telegram", chatId: telegramChatId ?? "unknown" };
  const requestLogPayload = {
    traceId,
    channel: event.channel,
    provider: runtimeConfig.provider,
    model: event.model ?? runtimeConfig.defaultModel,
    capability: runtimeConfig.capability,
    sessionNamespace: runtimeConfig.sessionNamespace,
    deliveryTarget,
    sessionId,
    messageLength: event.message.length,
    hasImageInput: Boolean(event.imageInput),
  };
  logLambdaEvent("lambda.request.accepted", requestLogPayload);
  logLambdaEvent("lambda.runtime.summary", requestLogPayload);
  if (event.assistantContext) {
    logLambdaEvent("lambda.assistant_context.loaded", {
      ...requestLogPayload,
      runtimeClass: event.assistantContext.runtime.runtimeClass,
      routeDecision: event.assistantContext.runtime.routeDecision,
      toolRuntimeProvider: event.assistantContext.runtime.toolRuntimeProvider,
      hasActiveToolAffinity: event.assistantContext.toolAffinity?.active === true,
      gmailCapability: event.assistantContext.capabilities.gmail.status,
    });
  }

  // Push "running" status before starting
  if (canPush) {
    await pushToConnection(event.callbackUrl!, event.connectionId!, {
      type: "status",
      status: "running",
    }, {
      traceId,
      channel: event.channel,
      deliveryType: "websocket",
      deliveryTarget: { type: "websocket", connectionId: event.connectionId! },
    });
  } else if (isTelegram && telegramBotTokenPath) {
    const secrets = await resolveSecrets([telegramBotTokenPath]);
    telegramBotToken = secrets.get(telegramBotTokenPath);
  }

  if (isCostLookupRequest(event.message)) {
    let recentCostContext: RecentCostContext | undefined;
    try {
      recentCostContext = await recentCostStore.load(event.userId, sessionId);
      logLambdaEvent("lambda.cost.loaded", {
        ...requestLogPayload,
        hasRecentCost: Boolean(recentCostContext),
        estimatedUsd: recentCostContext?.estimate.estimatedUsd,
      });
    } catch (err: unknown) {
      logLambdaEvent("lambda.cost.load_failed", {
        ...requestLogPayload,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const payloads = [{ text: buildRecentCostMessage(recentCostContext) }];
    await pushPayloads(payloads, {
      canPush,
      callbackUrl: event.callbackUrl,
      connectionId: event.connectionId,
      isTelegram,
      telegramBotToken,
      telegramChatId,
      traceId,
      channel: event.channel,
    });
    await pushIdleStatus(canPush, traceId, event.callbackUrl, event.connectionId);
    await lock.release();

    return {
      success: true,
      payloads,
      durationMs: Date.now() - startTime,
      provider: runtimeConfig.openclawProvider,
      model: event.model ?? runtimeConfig.defaultModel,
    };
  }

  let effectiveImageInput = event.imageInput;
  let recentImageContextLoaded = false;
  if (!effectiveImageInput && isRecentImageFollowUp(event.message)) {
    try {
      const recentImageContext = await recentImageStore.load(event.userId, sessionId);
      if (recentImageContext) {
        effectiveImageInput = recentImageContext.imageInput;
        recentImageContextLoaded = true;
        logLambdaEvent("lambda.recent_image.loaded", {
          ...requestLogPayload,
          recentImageCreatedAt: recentImageContext.createdAt,
          recentImageExpiresAt: recentImageContext.expiresAt,
          mediaType: recentImageContext.imageInput.mediaType,
          imageBytes: recentImageContext.imageInput.fileSize,
        });
      }
    } catch (err: unknown) {
      logLambdaEvent("lambda.recent_image.load_failed", {
        ...requestLogPayload,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (effectiveImageInput) {
    const visionStartedAt = Date.now();
    const visionModel = resolveDirectVisionModel(event, runtimeConfig);
    const visionPayload = runtimeConfig.provider === "bedrock"
      ? undefined
      : [{
          text: "현재 사진 분석은 Bedrock 기반 Lambda chat runtime에서만 지원합니다. 텍스트 질문은 계속 처리할 수 있어요.",
          isError: true,
        }];

    if (visionPayload) {
      await pushPayloads(visionPayload, {
        canPush,
        callbackUrl: event.callbackUrl,
        connectionId: event.connectionId,
        isTelegram,
        telegramBotToken,
        telegramChatId,
        traceId,
        channel: event.channel,
      });
      await pushIdleStatus(canPush, traceId, event.callbackUrl, event.connectionId);
      await lock.release();
      return {
        success: true,
        payloads: visionPayload,
        durationMs: Date.now() - startTime,
        provider: runtimeConfig.openclawProvider,
        model: visionModel,
      };
    }

    if (event.imageInput) {
      try {
        const saved = await recentImageStore.save(
          event.userId,
          sessionId,
          event.imageInput,
          event.message,
        );
        logLambdaEvent("lambda.recent_image.saved", {
          ...requestLogPayload,
          expiresAt: saved.expiresAt,
          mediaType: event.imageInput.mediaType,
          imageBytes: event.imageInput.fileSize,
        });
      } catch (err: unknown) {
        logLambdaEvent("lambda.recent_image.save_failed", {
          ...requestLogPayload,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logLambdaEvent("lambda.direct_vision.started", {
      ...requestLogPayload,
      model: visionModel,
      mediaType: effectiveImageInput.mediaType,
      imageBytes: effectiveImageInput.fileSize,
      recentImageContextLoaded,
      maxTokens: parseDirectVisionMaxTokens(),
    });
    try {
      const directResult = await runDirectBedrockChat({
        message: recentImageContextLoaded
          ? `Use the recent Telegram image for this follow-up. User follow-up: ${event.message}`
          : event.message,
        model: visionModel,
        systemPrompt: buildDirectVisionSystemPrompt(event, runtimeConfig),
        maxTokens: parseDirectVisionMaxTokens(),
        temperature: 0.1,
        imageInput: effectiveImageInput,
      });
      const payloads = [{ text: directResult.text }];

      await pushPayloads(payloads, {
        canPush,
        callbackUrl: event.callbackUrl,
        connectionId: event.connectionId,
        isTelegram,
        telegramBotToken,
        telegramChatId,
        traceId,
        channel: event.channel,
      });
      await pushIdleStatus(canPush, traceId, event.callbackUrl, event.connectionId);
      await lock.release();

      const visionDurationMs = Date.now() - visionStartedAt;
      logLambdaEvent("lambda.direct_vision.completed", {
        ...requestLogPayload,
        model: visionModel,
        durationMs: visionDurationMs,
        inputTokens: directResult.usage?.inputTokens,
        outputTokens: directResult.usage?.outputTokens,
      });
      const costEstimate = logCostEstimate(event, requestLogPayload, {
        model: visionModel,
        durationMs: Date.now() - startTime,
        tokenUsage: directResult.usage,
      });
      await saveRecentCostEstimate(recentCostStore, event, sessionId, costEstimate, requestLogPayload);

      return {
        success: true,
        payloads,
        durationMs: Date.now() - startTime,
        provider: runtimeConfig.openclawProvider,
        model: visionModel,
      };
    } catch (err: unknown) {
      const payloads = [{
        text: "사진을 받았지만 현재 이미지 분석 경로에서 처리하지 못했어요. 이미지를 조금 작게 다시 보내거나, 핵심 내용을 텍스트로 적어 주세요.",
        isError: true,
      }];
      logLambdaEvent("lambda.direct_vision.failed", {
        ...requestLogPayload,
        model: visionModel,
        durationMs: Date.now() - visionStartedAt,
        error: err instanceof Error ? err.message : String(err),
      }, "error");
      await pushPayloads(payloads, {
        canPush,
        callbackUrl: event.callbackUrl,
        connectionId: event.connectionId,
        isTelegram,
        telegramBotToken,
        telegramChatId,
        traceId,
        channel: event.channel,
      });
      await pushIdleStatus(canPush, traceId, event.callbackUrl, event.connectionId);
      await lock.release();
      return {
        success: true,
        payloads,
        durationMs: Date.now() - startTime,
        provider: runtimeConfig.openclawProvider,
        model: visionModel,
      };
    }
  }

  if ((event.channel === "telegram" || !runtimeConfig.readiness.toolRuntimeReady) && isToolRequest(event.message)) {
    const delegatedToolRuntime = hasDelegatedToolRuntime(event);
    logLambdaEvent(delegatedToolRuntime ? "lambda.tool.misroute_detected" : "lambda.tool.blocked", {
      ...requestLogPayload,
      toolRuntimeProvider: event.assistantContext?.runtime.toolRuntimeProvider,
      gmailCapability: event.assistantContext?.capabilities.gmail.status,
    });
    const payloads = [{
      text: delegatedToolRuntime
        ? buildDelegatedToolRuntimeMessage(event)
        : buildToolUnavailableMessage(runtimeConfig),
    }];
    await pushPayloads(payloads, {
      canPush,
      callbackUrl: event.callbackUrl,
      connectionId: event.connectionId,
      isTelegram,
      telegramBotToken,
      telegramChatId,
      traceId,
      channel: event.channel,
    });
    await pushIdleStatus(canPush, traceId, event.callbackUrl, event.connectionId);
    await lock.release();

    return {
      success: true,
      payloads,
      durationMs: Date.now() - startTime,
      provider: runtimeConfig.openclawProvider,
      model: event.model ?? runtimeConfig.defaultModel,
    };
  }

  if (shouldUseDirectBedrockChat(event, runtimeConfig)) {
    const directStartedAt = Date.now();
    const directChatMaxTokens = resolveDirectChatMaxTokens(event.message);
    const directChatModel = resolveDirectChatModel(event, runtimeConfig);
    const directChatFallbackModel = runtimeConfig.defaultModel;
    const directChatModels = directChatModel === directChatFallbackModel
      ? [directChatModel]
      : [directChatModel, directChatFallbackModel];
    let lastDirectChatError: unknown;

    for (const [attemptIndex, model] of directChatModels.entries()) {
      logLambdaEvent("lambda.direct_chat.started", {
        ...requestLogPayload,
        model,
        maxTokens: directChatMaxTokens,
        attemptIndex,
        fallbackFromModel: attemptIndex > 0 ? directChatModel : undefined,
      });
      try {
        const directResult = await runDirectBedrockChat({
          message: event.message,
          model,
          systemPrompt: buildDirectChatSystemPrompt(event, runtimeConfig),
          maxTokens: directChatMaxTokens,
          temperature: 0.2,
        });
        const payloads = [{ text: directResult.text }];

        await pushPayloads(payloads, {
          canPush,
          callbackUrl: event.callbackUrl,
          connectionId: event.connectionId,
          isTelegram,
          telegramBotToken,
          telegramChatId,
          traceId,
          channel: event.channel,
        });
        await pushIdleStatus(canPush, traceId, event.callbackUrl, event.connectionId);
        await lock.release();

        const directChatDurationMs = Date.now() - directStartedAt;
        logLambdaEvent("lambda.direct_chat.completed", {
          ...requestLogPayload,
          model,
          durationMs: directChatDurationMs,
          inputTokens: directResult.usage?.inputTokens,
          outputTokens: directResult.usage?.outputTokens,
          attemptIndex,
          fallbackFromModel: attemptIndex > 0 ? directChatModel : undefined,
        });
        const costEstimate = logCostEstimate(event, requestLogPayload, {
          model,
          durationMs: Date.now() - startTime,
          tokenUsage: directResult.usage,
        });
        await saveRecentCostEstimate(recentCostStore, event, sessionId, costEstimate, requestLogPayload);

        return {
          success: true,
          payloads,
          durationMs: Date.now() - startTime,
          provider: runtimeConfig.openclawProvider,
          model,
        };
      } catch (err: unknown) {
        lastDirectChatError = err;
        logLambdaEvent("lambda.direct_chat.attempt_failed", {
          ...requestLogPayload,
          model,
          durationMs: Date.now() - directStartedAt,
          attemptIndex,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logLambdaEvent("lambda.direct_chat.fallback", {
        ...requestLogPayload,
        durationMs: Date.now() - directStartedAt,
        attemptedModels: directChatModels,
        error: lastDirectChatError instanceof Error
          ? lastDirectChatError.message
          : String(lastDirectChatError),
    });
  }

  const sync = new SessionSync(bucket, "/tmp/.openclaw");
  const sessionFile = await sync.download(event.userId, sessionId);

  try {
    try {
      const partialReplyChunks: string[] = [];
      const result = await runAgent({
        sessionId,
        sessionFile,
        workspaceDir: "/tmp/workspace",
        message: event.message,
        config: (globalThis as { __OPENCLAW_EMBEDDED_CONFIG__?: Record<string, unknown> })
          .__OPENCLAW_EMBEDDED_CONFIG__,
        model: event.model ?? runtimeConfig.defaultModel,
        provider: runtimeConfig.openclawProvider,
        api: runtimeConfig.openclawApi,
        disableTools:
          event.disableTools === true ||
          event.channel === "telegram" ||
          !runtimeConfig.readiness.toolRuntimeReady,
        disableMessageTool:
          event.channel === "telegram" ||
          !runtimeConfig.readiness.toolRuntimeReady,
        channel: event.channel,
        extraSystemPrompt: buildExtraSystemPrompt(event, runtimeConfig),
        onPartialReply:
          event.channel === "telegram"
            ? (delta: string) => {
                if (delta) partialReplyChunks.push(delta);
              }
            : undefined,
      });
      const payloads = normalizeAgentPayloads(
        result.payloads,
        partialReplyChunks,
        event.channel,
      );

      // Always upload session after run (even if no payloads)
      await sync.upload(event.userId, sessionId);

      await pushPayloads(payloads, {
        canPush,
        callbackUrl: event.callbackUrl,
        connectionId: event.connectionId,
        isTelegram,
        telegramBotToken,
        telegramChatId,
        traceId,
        channel: event.channel,
      });

      await pushIdleStatus(canPush, traceId, event.callbackUrl, event.connectionId);
      const costEstimate = logCostEstimate(event, requestLogPayload, {
        model: result.meta.agentMeta.model,
        durationMs: Date.now() - startTime,
      });
      await saveRecentCostEstimate(recentCostStore, event, sessionId, costEstimate, requestLogPayload);

      return {
        success: true,
        payloads,
        durationMs: Date.now() - startTime,
        provider: result.meta.agentMeta.provider,
        model: result.meta.agentMeta.model,
      };
    } catch (err: unknown) {
      // Upload session even on error (partial transcript may be valuable)
      await sync.upload(event.userId, sessionId);

      const errorMessage = err instanceof Error ? err.message : String(err);

      // Push error to WebSocket
      if (canPush) {
        await pushToConnection(event.callbackUrl!, event.connectionId!, {
          type: "error",
          error: errorMessage,
        }, {
          traceId,
          channel: event.channel,
          deliveryType: "websocket",
          deliveryTarget: { type: "websocket", connectionId: event.connectionId! },
        });
      } else if (isTelegram && telegramBotToken) {
        await pushToTelegram(telegramBotToken, telegramChatId!, `❌ ${errorMessage}`, {
          traceId,
          channel: event.channel,
          deliveryType: "telegram",
          deliveryTarget: { type: "telegram", chatId: telegramChatId! },
        });
      }

      await pushIdleStatus(canPush, traceId, event.callbackUrl, event.connectionId);

      return {
        success: false,
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };
    }
  } finally {
    await lock.release();
  }
}
