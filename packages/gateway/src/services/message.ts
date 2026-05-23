import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  TABLE_NAMES,
  KEY_PREFIX,
  BRIDGE_PORT,
  BRIDGE_HTTP_TIMEOUT_MS,
  PENDING_MESSAGE_TTL_SEC,
  PREWARM_USER_ID,
  buildAssistantToolCapabilities,
  estimateCost,
} from "@serverless-openclaw/shared";
import type {
  AgentCoreRuntimeResult,
  InvokeAgentCoreRuntimeParams,
} from "./agentcore.js";
import type {
  AgentRuntimeMode,
  AssistantRuntimeCostSnapshot,
  AssistantRuntimeContext,
  BridgeMessageRequest,
  Channel,
  EmailTokenBudgetPolicy,
  LambdaAgentImageInput,
  PendingMessageItem,
  RouteDecision,
  RuntimeClass,
  TaskStateItem,
  ToolRuntimeProvider,
  ToolRuntimeAffinityState,
} from "@serverless-openclaw/shared";
import type { StartTaskParams } from "./container.js";
import type { InvokeLambdaAgentParams } from "./lambda-agent.js";
import {
  classifyRoute,
  classifyRouteRuntimeClass,
  getRouteClassificationSignals,
  stripRouteHint,
} from "./route-classifier.js";
import type { RouteClassificationSignals } from "./route-classifier.js";
import { publishGatewayCountMetric } from "./metrics.js";

type AssistantRuntimeProvider = "lambda" | "agentcore";
type FetchFn = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; statusText: string }>;
type Send = (command: unknown) => Promise<unknown>;

function logRouteEvent(
  event: string,
  payload: Record<string, unknown>,
  level: "info" | "warn" = "info",
): void {
  const entry = JSON.stringify({
    component: "gateway",
    event,
    ...payload,
  });

  if (level === "warn") {
    console.warn(entry);
    return;
  }

  console.info(entry);
}

export async function sendToBridge(
  fetchFn: FetchFn,
  publicIp: string,
  authToken: string,
  body: BridgeMessageRequest,
): Promise<void> {
  const resp = await fetchFn(`http://${publicIp}:${BRIDGE_PORT}/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(BRIDGE_HTTP_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`Bridge returned ${resp.status}`);
  }
}

export async function savePendingMessage(send: Send, item: PendingMessageItem): Promise<void> {
  await send(
    new PutCommand({
      TableName: TABLE_NAMES.PENDING_MESSAGES,
      Item: item,
    }),
  );
}

export interface RouteDeps {
  userId: string;
  message: string;
  traceId: string;
  channel: Channel;
  connectionId: string;
  telegramChatId?: string;
  callbackUrl: string;
  bridgeAuthToken: string;
  fetchFn: FetchFn;
  getTaskState: (userId: string) => Promise<TaskStateItem | null>;
  startTask: (params: StartTaskParams) => Promise<string>;
  putTaskState: (item: TaskStateItem) => Promise<void>;
  savePendingMessage: (item: PendingMessageItem) => Promise<void>;
  deleteTaskState: (userId: string) => Promise<void>;
  getRoutingContext: (
    userId: string,
    channel: Channel,
  ) => Promise<ToolRuntimeAffinityState | null>;
  putRoutingContext: (
    userId: string,
    state: ToolRuntimeAffinityState,
  ) => Promise<void>;
  deleteRoutingContext: (userId: string, channel: Channel) => Promise<void>;
  sendClarification: (text: string) => Promise<void>;
  startTaskParams: StartTaskParams;
  /** Lambda agent runtime support (Phase 2) */
  agentRuntime?: AgentRuntimeMode;
  toolRuntimeProvider?: ToolRuntimeProvider;
  invokeLambdaAgent?: (params: InvokeLambdaAgentParams) => Promise<{ accepted: true }>;
  lambdaAgentFunctionArn?: string;
  invokeAgentCoreRuntime?: (params: InvokeAgentCoreRuntimeParams) => Promise<AgentCoreRuntimeResult>;
  agentCoreRuntimeArn?: string;
  agentCoreRuntimeQualifier?: string;
  agentCoreFallbackProvider?: ToolRuntimeProvider;
  assistantRuntimeProvider?: AssistantRuntimeProvider;
  sessionId?: string;
  imageInput?: LambdaAgentImageInput;
  requestStartedAtMs?: number;
}

export type RouteResult =
  | "sent"
  | "queued"
  | "started"
  | "lambda"
  | "agentcore"
  | "clarify";

const TOOL_AFFINITY_TTL_MS = 30 * 60 * 1000;
const TOOL_AFFINITY_CANCEL_PATTERN = /^(?:취소|그만|끝|됐어|done|cancel|stop)$/i;
const TOOL_AFFINITY_EXPLICIT_CHAT_HANDOFF_PATTERN =
  /^(?:다른\s*질문(?:인데|으로)?|별개로|그건\s*(?:됐고|그만|괜찮고|말고)|그거\s*말고|이건\s*일반\s*(?:질문|대화|답변)(?:으로)?|이제\s*(?:일반|다른)\s*(?:질문|대화|답변)?|일반\s*(?:질문|대화|답변)(?:으로)?|툴\s*말고|도구\s*말고|지메일\s*말고|gmail\s*말고|메일\s*말고|결제\s*말고)/i;
const TOOL_AFFINITY_OBVIOUS_TOPIC_SWITCH_PATTERN =
  /^(?:안녕|안녕하세요|hello|hi|hey|고마워|감사|thanks?|thank you|잘가|bye|다른\s*질문|별개로|그건\s*(?:됐고|그만|말고)|그거\s*말고|일반\s*(?:질문|대화|답변)|날씨|weather|번역|translate|농담|joke)(?:$|[!?.,\s])/i;
const TOOL_AFFINITY_CONTEXTUAL_FOLLOW_UP_PATTERN =
  /(?:그거|이거|저거|그\s*내역|이\s*내역|앞(?:에서|서)|방금|아까|위(?:에|의)|다시|더\s*있|더\s*찾|관련(?:된)?\s*것만|것만|합계|총액|카드사별|결제처별|상세|본문|메일|지메일|gmail|결제|지출|카드|영수증|명세서|일본|여행|표(?:로)?|정리|보여|가져와|찾아)/i;
const TOOL_AFFINITY_INDEPENDENT_CHAT_SWITCH_PATTERN =
  /(?:리눅스|linux|파이썬|python|자바스크립트|javascript|타입스크립트|typescript|git|깃|docker|도커|kubernetes|쿠버네티스|aws|lambda|람다|수학|역사|영어|문법|코드|명령어|방법|개념|뜻|의미|차이|예시|추천|설명|작성).*(?:알려줘|설명해|가르쳐|어떻게|뭐야|무엇|추천해|작성해|번역해)|(?:알려줘|설명해|가르쳐|어떻게|뭐야|무엇|추천해|작성해|번역해).*(?:리눅스|linux|파이썬|python|자바스크립트|javascript|타입스크립트|typescript|git|깃|docker|도커|kubernetes|쿠버네티스|aws|lambda|람다|수학|역사|영어|문법|코드|명령어|방법|개념|뜻|의미|차이|예시|추천|설명|작성)/i;
const TOOL_AFFINITY_STANDALONE_CHAT_REQUEST_PATTERN =
  /(?:알려줘|설명해|가르쳐|추천해|추천해줘|작성해|작성해줘|번역해|번역해줘|만들어줘|짜줘|고쳐줘|뭐야|무엇|왜|어떻게|어때|할까|해야\s*할까|뭐\s*먹|메뉴|날씨|농담|recipe|menu|weather|joke|recommend|explain|write|translate|how\s+to|what\s+is)/i;
const TOOL_AFFINITY_END_MESSAGE = "알겠습니다. 현재 도구 작업 문맥을 종료할게요.";
const DEFAULT_AGENTCORE_FOLLOW_UP_TIMEOUT_MS = 8_000;

function assertLambdaInvokeAccepted(result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  const record = result as { success?: boolean; error?: string };
  if (record.success === false) {
    throw new Error(record.error ?? "Lambda agent invocation failed");
  }
}

function hasValue(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeMessage(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function getMessageCodePointSample(value: string): string[] {
  return Array.from(normalizeMessage(value))
    .slice(0, 8)
    .map((char) => {
      const codePoint = char.codePointAt(0);
      return codePoint === undefined ? "unknown" : `U+${codePoint.toString(16).toUpperCase()}`;
    });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveGatewayLambdaMemoryMb(): number {
  return parsePositiveInteger(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE, 256);
}

function resolveGatewayLambdaArchitecture(): "arm64" | "x86_64" {
  return process.env.LAMBDA_ARCHITECTURE === "x86_64" ? "x86_64" : "arm64";
}

function resolveGatewayElapsedMs(deps: RouteDeps): number {
  const startedAt = deps.requestStartedAtMs;
  if (typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0) {
    return Math.max(Date.now() - startedAt, 1);
  }

  return parsePositiveInteger(process.env.GATEWAY_FRONTDOOR_COST_ESTIMATE_MS, 1);
}

function resolveGatewayCompletionReserveMs(routeDecision: RouteDecision): number {
  const envKey = routeDecision === "agentcore"
    ? "GATEWAY_FRONTDOOR_AGENTCORE_RESERVE_MS"
    : routeDecision === "lambda"
      ? "GATEWAY_FRONTDOOR_LAMBDA_RESERVE_MS"
      : "GATEWAY_FRONTDOOR_FARGATE_RESERVE_MS";
  const fallback = routeDecision === "agentcore"
    ? 1200
    : routeDecision === "lambda"
      ? 350
      : 500;

  return parsePositiveInteger(process.env[envKey], fallback);
}

function buildGatewayCostSnapshot(
  deps: RouteDeps,
  runtimeClass: RuntimeClass,
  routeDecision: RouteDecision,
): AssistantRuntimeCostSnapshot {
  const measuredElapsedMs = resolveGatewayElapsedMs(deps);
  const reserveMs = resolveGatewayCompletionReserveMs(routeDecision);
  const estimatedRouteCompletionMs = measuredElapsedMs + reserveMs;
  const estimate = estimateCost({
    traceId: deps.traceId,
    userId: deps.userId,
    channel: deps.channel,
    runtimeClass,
    provider: "lambda",
    durationMs: estimatedRouteCompletionMs,
    memoryMb: resolveGatewayLambdaMemoryMb(),
    architecture: resolveGatewayLambdaArchitecture(),
  });

  return {
    name: "gateway-frontdoor-estimated-to-route-completion",
    provider: "lambda",
    estimatedUsd: estimate.estimatedUsd,
    durationMs: estimate.durationMs,
    confidence: estimate.confidence,
    breakdown: estimate.breakdown,
  };
}

function resolveEmailTokenBudgetPolicy(): EmailTokenBudgetPolicy {
  return {
    mode: "headers-first",
    maxMessages: parsePositiveInteger(process.env.GMAIL_TOOL_MAX_MESSAGES, 5),
    paymentScanMessages: parsePositiveInteger(
      process.env.GMAIL_PAYMENT_MAX_SCAN_MESSAGES,
      25,
    ),
    maxSnippetChars: parsePositiveInteger(
      process.env.GMAIL_TOOL_MAX_SNIPPET_CHARS,
      240,
    ),
    maxBodyChars: parsePositiveInteger(
      process.env.GMAIL_TOOL_MAX_BODY_CHARS,
      1600,
    ),
    requireExplicitBodyAccess: parseBooleanFlag(
      process.env.GMAIL_TOOL_REQUIRE_EXPLICIT_BODY,
      true,
    ),
  };
}

function resolveBridgeConnectionId(deps: RouteDeps): string {
  if (deps.channel === "telegram") {
    if (hasValue(deps.connectionId)) {
      return deps.connectionId;
    }
    if (hasValue(deps.telegramChatId)) {
      return `telegram:${deps.telegramChatId!.trim()}`;
    }
  }

  return deps.connectionId;
}

function buildBridgeMessageRequest(
  deps: RouteDeps,
  message: string,
  runtimeClass: RuntimeClass,
  routeDecision: RouteDecision,
  options: { activeToolAffinity?: boolean; providerOverride?: ToolRuntimeProvider } = {},
): BridgeMessageRequest {
  const emailTokenBudget = runtimeClass === "tool-enabled"
    ? resolveEmailTokenBudgetPolicy()
    : undefined;
  const assistantContext = buildAssistantRuntimeContext(
    deps,
    runtimeClass,
    routeDecision,
    emailTokenBudget,
    options,
  );
  return {
    userId: deps.userId,
    message,
    channel: deps.channel,
    connectionId: resolveBridgeConnectionId(deps),
    callbackUrl: deps.callbackUrl,
    traceId: deps.traceId,
    runtimeClass,
    routeDecision,
    ...(emailTokenBudget ? { emailTokenBudget } : {}),
    assistantContext,
  };
}

function resolveToolRuntimeProvider(deps: RouteDeps): ToolRuntimeProvider {
  return deps.toolRuntimeProvider ?? "agentcore";
}

function resolveAgentCoreFollowUpTimeoutMs(): number {
  return parsePositiveInteger(
    process.env.AGENTCORE_FOLLOW_UP_TIMEOUT_MS,
    DEFAULT_AGENTCORE_FOLLOW_UP_TIMEOUT_MS,
  );
}

function resolveAgentCoreFallbackProvider(deps: RouteDeps): ToolRuntimeProvider {
  const configured = deps.agentCoreFallbackProvider ??
    (process.env.AGENTCORE_FALLBACK_PROVIDER as ToolRuntimeProvider | undefined);
  return configured === "fargate" ? "fargate" : "fargate";
}

function resolveAssistantRuntimeProvider(deps: RouteDeps): AssistantRuntimeProvider {
  const configured = deps.assistantRuntimeProvider ?? process.env.ASSISTANT_RUNTIME_PROVIDER;
  return configured === "agentcore" ? "agentcore" : "lambda";
}

function shouldUseAgentCoreAssistantRuntime(deps: RouteDeps): boolean {
  return resolveAssistantRuntimeProvider(deps) === "agentcore" &&
    deps.agentRuntime === "both" &&
    resolveToolRuntimeProvider(deps) === "agentcore" &&
    Boolean(deps.invokeAgentCoreRuntime && deps.agentCoreRuntimeArn);
}

function buildRouteLogPayload(
  deps: RouteDeps,
  runtimeClass: RuntimeClass,
  routeDecision: RouteDecision,
  taskState: TaskStateItem | null,
  pendingQueued: boolean,
  classifierSignals?: RouteClassificationSignals,
): Record<string, unknown> {
  return {
    traceId: deps.traceId,
    channel: deps.channel,
    runtimeClass,
    routeDecision,
    taskStateStatus: taskState?.status ?? "none",
    hasPublicIp: Boolean(taskState?.publicIp),
    pendingQueued,
    sessionId: deps.sessionId ?? `session-${deps.userId}`,
    hasImageInput: Boolean(deps.imageInput),
    ...(process.env.AGENTCORE_SESSION_NAMESPACE
      ? { agentCoreSessionNamespace: process.env.AGENTCORE_SESSION_NAMESPACE }
      : {}),
    messageLength: deps.message.length,
    ...(classifierSignals ? { classifierSignals } : {}),
  };
}

function buildClassifierLogPayload(
  deps: RouteDeps,
  runtimeClass: RuntimeClass,
  routeDecision: RouteDecision,
  taskState: TaskStateItem | null,
  classifierSignals: RouteClassificationSignals,
): Record<string, unknown> {
  return {
    ...buildRouteLogPayload(
      deps,
      runtimeClass,
      routeDecision,
      taskState,
      false,
      classifierSignals,
    ),
    messageCodePointSample: getMessageCodePointSample(deps.message),
  };
}

function buildToolRuntimeAffinityState(
  deps: RouteDeps,
  createdAt?: string,
  provider: ToolRuntimeProvider = resolveToolRuntimeProvider(deps),
  fallbackProvider?: ToolRuntimeProvider,
  providerLockedAt?: string,
  providerLockReason?: ToolRuntimeAffinityState["providerLockReason"],
): ToolRuntimeAffinityState {
  const now = new Date();
  return {
    status: "active",
    channel: deps.channel,
    runtimeClass: "tool-enabled",
    provider,
    ...(fallbackProvider ? { fallbackProvider } : {}),
    ...(providerLockedAt ? { providerLockedAt } : {}),
    ...(providerLockReason ? { providerLockReason } : {}),
    connectionId: deps.connectionId,
    callbackUrl: deps.callbackUrl,
    ...(deps.telegramChatId ? { telegramChatId: deps.telegramChatId } : {}),
    createdAt: createdAt ?? now.toISOString(),
    lastActivityAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOOL_AFFINITY_TTL_MS).toISOString(),
  };
}

function buildAssistantRuntimeContext(
  deps: RouteDeps,
  runtimeClass: RuntimeClass,
  routeDecision: RouteDecision,
  emailTokenBudget?: EmailTokenBudgetPolicy,
  options: { activeToolAffinity?: boolean; providerOverride?: ToolRuntimeProvider } = {},
): AssistantRuntimeContext {
  const provider = options.providerOverride ?? resolveToolRuntimeProvider(deps);
  const fallbackProvider = provider === "agentcore"
    ? resolveAgentCoreFallbackProvider(deps)
    : provider;
  const providerLocked = options.providerOverride !== undefined &&
    options.providerOverride !== resolveToolRuntimeProvider(deps);
  const sessionId = runtimeClass === "chat-only"
    ? resolveLambdaSessionId(deps, runtimeClass)
    : deps.sessionId ?? `session-${deps.userId}`;
  const gatewayCost = buildGatewayCostSnapshot(deps, runtimeClass, routeDecision);
  const toolCapabilities = buildAssistantToolCapabilities({
    toolRuntimeProvider: provider,
    gmailAvailable: true,
    awsCostLookupAvailable: process.env.AWS_COST_LOOKUP_ENABLED === "true",
  });
  const context: AssistantRuntimeContext = {
    version: 1,
    userId: deps.userId,
    channel: deps.channel,
    sessionId,
    ...(deps.traceId ? { traceId: deps.traceId } : {}),
    generatedAt: new Date().toISOString(),
    runtime: {
      ...(deps.agentRuntime ? { agentRuntime: deps.agentRuntime } : {}),
      runtimeClass,
      routeDecision,
      lambdaRole: "chat-only-fast-path",
      toolRuntimeProvider: provider,
      fallbackProvider,
      providerLocked,
      ...(providerLocked ? { providerLockReason: "agentcore_fallback" } : {}),
    },
    capabilities: {
      tools: {
        available: true,
        executionRuntime: provider,
        note: "Tool and private-data tasks are owned by the tool runtime, not by Gateway semantic routing.",
        registry: toolCapabilities,
      },
      gmail: {
        status: "available_via_tool_runtime",
        executionRuntime: provider,
        safetyMode: "headers-first",
      },
    },
    toolAffinity: {
      active: options.activeToolAffinity === true || runtimeClass === "tool-enabled",
      provider,
      fallbackProvider,
      ...(providerLocked ? { providerLockReason: "agentcore_fallback" } : {}),
    },
    ...(emailTokenBudget ? { emailTokenBudget } : {}),
    cost: {
      upstream: [gatewayCost],
    },
    guidance: {
      selfAwareness: "The assistant should know that this system has a delegated tool runtime and a closed tool capability registry. Available capabilities may be executed by the tool runtime; planned capabilities are roadmap/self-awareness only.",
      lambda: "Lambda is the frontdoor, delivery layer, and emergency fallback. It should not be treated as a separate assistant brain when AgentCore is the assistant runtime.",
      toolRuntime: "AgentCore/Fargate owns semantic interpretation, normal chat, Gmail/payment context, follow-up handling, and controlled tool execution.",
    },
  };

  logRouteEvent("gateway.assistant_context.created", {
    traceId: deps.traceId,
    channel: deps.channel,
    runtimeClass,
    routeDecision,
    toolRuntimeProvider: provider,
    fallbackProvider,
    hasActiveToolAffinity: context.toolAffinity?.active ?? false,
    gmailCapability: context.capabilities.gmail.status,
    toolCapabilities: toolCapabilities.map((capability) => `${capability.id}:${capability.status}`),
    gatewayEstimatedUsd: gatewayCost.estimatedUsd,
    gatewayDurationMs: gatewayCost.durationMs,
    gatewayCostName: gatewayCost.name,
  });

  return context;
}

async function lockToolRuntimeProvider(
  deps: RouteDeps,
  provider: ToolRuntimeProvider,
  reason: ToolRuntimeAffinityState["providerLockReason"],
): Promise<void> {
  const current = await deps.getRoutingContext(deps.userId, deps.channel).catch(() => null);
  const lockedAt = new Date().toISOString();
  await deps.putRoutingContext(
    deps.userId,
    buildToolRuntimeAffinityState(
      deps,
      current?.createdAt,
      provider,
      provider,
      lockedAt,
      reason,
    ),
  );
  logRouteEvent("gateway.harness.session.provider_locked", {
    traceId: deps.traceId,
    channel: deps.channel,
    runtimeClass: "tool-enabled",
    provider,
    fallbackProvider: provider,
    reason,
  });
}

function isToolAffinityExpired(state: ToolRuntimeAffinityState): boolean {
  return Date.parse(state.expiresAt) <= Date.now();
}

function shouldKeepToolAffinity(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) {
    return false;
  }

  if (TOOL_AFFINITY_EXPLICIT_CHAT_HANDOFF_PATTERN.test(normalized)) {
    return false;
  }

  if (TOOL_AFFINITY_OBVIOUS_TOPIC_SWITCH_PATTERN.test(normalized)) {
    return false;
  }

  if (classifyRouteRuntimeClass(normalized) === "chat-only") {
    const isContextualToolFollowUp = TOOL_AFFINITY_CONTEXTUAL_FOLLOW_UP_PATTERN.test(normalized);
    const isIndependentGeneralChat =
      TOOL_AFFINITY_INDEPENDENT_CHAT_SWITCH_PATTERN.test(normalized) ||
      TOOL_AFFINITY_STANDALONE_CHAT_REQUEST_PATTERN.test(normalized);

    if (!isContextualToolFollowUp && isIndependentGeneralChat) {
      return false;
    }
  }

  return true;
}

function shouldDelegateToolAffinityDecisionToRuntime(
  deps: RouteDeps,
  affinity: ToolRuntimeAffinityState,
): boolean {
  const provider = affinity.fallbackProvider ??
    affinity.provider ??
    resolveToolRuntimeProvider(deps);

  return provider === "agentcore" &&
    Boolean(deps.invokeAgentCoreRuntime && deps.agentCoreRuntimeArn);
}

function validateLambdaDeliveryTarget(deps: RouteDeps): void {
  if (deps.channel === "web") {
    if (!hasValue(deps.connectionId) || !hasValue(deps.callbackUrl)) {
      throw new Error("Web Lambda delivery requires both connectionId and callbackUrl");
    }
    return;
  }

  if (!hasValue(deps.telegramChatId) && !hasValue(deps.connectionId)) {
    throw new Error("Telegram Lambda delivery requires telegramChatId or connectionId");
  }
}

function resolveLambdaSessionId(deps: RouteDeps, runtimeClass: RuntimeClass): string {
  const baseSessionId = deps.sessionId ?? `session-${deps.userId}`;
  return runtimeClass === "chat-only" ? `${baseSessionId}:chat` : baseSessionId;
}

async function routeFargate(
  deps: RouteDeps,
  taskState: TaskStateItem | null,
  runtimeClass: RuntimeClass,
  routeDecision: RouteDecision,
  options: { activeToolAffinity?: boolean; providerOverride?: ToolRuntimeProvider } = {},
): Promise<RouteResult> {
  const bridgeMessage = buildBridgeMessageRequest(
    deps,
    deps.message,
    runtimeClass,
    routeDecision,
    options,
  );

  if (taskState?.status === "Running" && taskState.publicIp) {
    try {
      await sendToBridge(
        deps.fetchFn,
        taskState.publicIp,
        deps.bridgeAuthToken,
        bridgeMessage,
      );
      logRouteEvent(
        "route.fargate.reused",
        buildRouteLogPayload(deps, runtimeClass, routeDecision, taskState, false),
      );
      void publishGatewayCountMetric("RouteToFargate", {
        channel: deps.channel,
        runtime: "fargate",
      });
      return "sent";
    } catch (err) {
      logRouteEvent(
        "route.fargate.reused",
        {
          ...buildRouteLogPayload(deps, runtimeClass, routeDecision, taskState, false),
          error: err instanceof Error ? err.message : String(err),
        },
        "warn",
      );
    }
  }

  // Try to claim a pre-warmed container
  if (!taskState) {
    const prewarm = await deps.getTaskState(PREWARM_USER_ID);
    if (prewarm?.status === "Running" && prewarm.publicIp) {
      try {
        await sendToBridge(
          deps.fetchFn,
          prewarm.publicIp,
          deps.bridgeAuthToken,
          bridgeMessage,
        );
        // Transfer ownership: delete prewarm, create user entry
        await deps.deleteTaskState(PREWARM_USER_ID);
        await deps.putTaskState({
          PK: `${KEY_PREFIX.USER}${deps.userId}`,
          taskArn: prewarm.taskArn,
          status: "Running",
          publicIp: prewarm.publicIp,
          startedAt: prewarm.startedAt,
          lastActivity: new Date().toISOString(),
        });
        logRouteEvent(
          "route.fargate.reused",
          buildRouteLogPayload(deps, runtimeClass, routeDecision, prewarm, false),
        );
        void publishGatewayCountMetric("RouteToFargate", {
          channel: deps.channel,
          runtime: "fargate",
        });
        return "sent";
      } catch {
        // Bridge unreachable — fall through to normal path
      }
    }
  }

  // Save to pending messages
  const now = Date.now();
  const uuid = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  await deps.savePendingMessage({
    PK: `${KEY_PREFIX.USER}${deps.userId}`,
    SK: `${KEY_PREFIX.MSG}${now}#${uuid}`,
    message: deps.message,
    channel: deps.channel,
    connectionId: bridgeMessage.connectionId,
    traceId: deps.traceId,
    runtimeClass: bridgeMessage.runtimeClass,
    routeDecision: bridgeMessage.routeDecision,
    emailTokenBudget: bridgeMessage.emailTokenBudget,
    assistantContext: bridgeMessage.assistantContext,
    createdAt: new Date(now).toISOString(),
    ttl: Math.floor(now / 1000) + PENDING_MESSAGE_TTL_SEC,
  });
  logRouteEvent(
    "route.pending.queued",
    buildRouteLogPayload(deps, runtimeClass, routeDecision, taskState, true),
  );
  void publishGatewayCountMetric("PendingMessagesQueued", {
    channel: deps.channel,
    runtime: "fargate",
  });
  void publishGatewayCountMetric("RouteToFargate", {
    channel: deps.channel,
    runtime: "fargate",
  });

  // If no task or stale Running state, clear stale state and start a new one
  if (!taskState || (taskState.status === "Running" && taskState.publicIp)) {
    if (taskState) {
      await deps.deleteTaskState(deps.userId);
    }
    const taskArn = await deps.startTask(deps.startTaskParams);
    await deps.putTaskState({
      PK: `${KEY_PREFIX.USER}${deps.userId}`,
      taskArn,
      status: "Starting",
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });
    logRouteEvent(
      "route.fargate.started",
      buildRouteLogPayload(deps, runtimeClass, routeDecision, taskState, true),
    );
    return "started";
  }

  return "queued";
}

async function routeAgentCore(
  deps: RouteDeps,
  options: {
    activeToolAffinity?: boolean;
    runtimeClass?: RuntimeClass;
    preferCallbackDelivery?: boolean;
  } = {},
): Promise<RouteResult> {
  if (!deps.invokeAgentCoreRuntime || !deps.agentCoreRuntimeArn) {
    throw new Error("AgentCore tool runtime is not configured");
  }

  validateLambdaDeliveryTarget(deps);
  const runtimeClass = options.runtimeClass ?? "tool-enabled";
  const bridgeMessage = buildBridgeMessageRequest(
    deps,
    deps.message,
    runtimeClass,
    "agentcore",
    options,
  );
  logRouteEvent("agentcore.invoke.started", {
    ...buildRouteLogPayload(deps, runtimeClass, "agentcore", null, false),
    toolRuntimeProvider: "agentcore",
    assistantRuntimeProvider: resolveAssistantRuntimeProvider(deps),
  });
  const result = await deps.invokeAgentCoreRuntime({
    runtimeArn: deps.agentCoreRuntimeArn,
    qualifier: deps.agentCoreRuntimeQualifier,
    userId: bridgeMessage.userId,
    sessionId: deps.sessionId ?? `session-${deps.userId}`,
    traceId: bridgeMessage.traceId,
    message: bridgeMessage.message,
    channel: bridgeMessage.channel,
    connectionId: bridgeMessage.connectionId,
    callbackUrl: options.activeToolAffinity && !options.preferCallbackDelivery
      ? ""
      : bridgeMessage.callbackUrl,
    runtimeClass,
    emailTokenBudget: bridgeMessage.emailTokenBudget,
    assistantContext: bridgeMessage.assistantContext,
    timeoutMs: options.activeToolAffinity
      ? resolveAgentCoreFollowUpTimeoutMs()
      : undefined,
  });

  if (result.handoffRuntimeClass === "chat-only") {
    if (result.clearToolAffinity !== false) {
      await deps.deleteRoutingContext(deps.userId, deps.channel);
      logRouteEvent("route.affinity.cleared", {
        traceId: deps.traceId,
        channel: deps.channel,
        runtimeClass: "tool-enabled",
        reason: "runtime_handoff_chat_only",
      });
    }
    logRouteEvent("agentcore.invoke.handoff", {
      ...buildRouteLogPayload(deps, runtimeClass, "agentcore", null, false),
      toolRuntimeProvider: "agentcore",
      handoffRuntimeClass: result.handoffRuntimeClass,
      source: result.source,
    });
    return invokeLambdaRoute(
      deps,
      result.handoffMessage ?? deps.message,
      "chat-only",
      "lambda",
      null,
    );
  }

  if (result.content) {
    await deps.sendClarification(result.content);
  }
  logRouteEvent("agentcore.invoke.completed", {
    ...buildRouteLogPayload(deps, runtimeClass, "agentcore", null, false),
    toolRuntimeProvider: "agentcore",
    hasContent: Boolean(result.content),
  });
  void publishGatewayCountMetric("RouteToAgentCore", {
    channel: deps.channel,
    runtime: "agentcore",
  });
  return "agentcore";
}

function resolveFargateRouteDecision(taskState: TaskStateItem | null): RouteDecision {
  return taskState?.status === "Running" && taskState.publicIp
    ? "fargate-reuse"
    : "fargate-new";
}

function hasActiveFargateTask(taskState: TaskStateItem | null): boolean {
  return taskState?.status === "Starting" ||
    (taskState?.status === "Running" && Boolean(taskState.publicIp));
}

function resolveToolRuntimeRouteDecision(
  deps: RouteDeps,
  taskState: TaskStateItem | null,
  providerOverride?: ToolRuntimeProvider,
): RouteDecision {
  if (
    (providerOverride ?? resolveToolRuntimeProvider(deps)) === "agentcore" &&
    !hasActiveFargateTask(taskState)
  ) {
    return "agentcore";
  }

  return resolveFargateRouteDecision(taskState);
}

async function routeToolRuntime(
  deps: RouteDeps,
  taskState: TaskStateItem | null,
  routeDecision: RouteDecision,
  options: {
    activeToolAffinity?: boolean;
    providerOverride?: ToolRuntimeProvider;
    runtimeClass?: RuntimeClass;
    preferCallbackDelivery?: boolean;
  } = {},
): Promise<RouteResult> {
  const provider = options.providerOverride ?? resolveToolRuntimeProvider(deps);
  const runtimeClass = options.runtimeClass ?? "tool-enabled";
  if (provider === "agentcore" && routeDecision === "agentcore") {
    try {
      return await routeAgentCore(deps, options);
    } catch (err) {
      const fallbackProvider = resolveAgentCoreFallbackProvider(deps);
      await lockToolRuntimeProvider(deps, fallbackProvider, "agentcore_fallback");
      const fallbackDecision = resolveFargateRouteDecision(taskState);
      logRouteEvent(
        "agentcore.invoke.fallback",
        {
          ...buildRouteLogPayload(
            deps,
            runtimeClass,
            fallbackDecision,
            taskState,
            false,
          ),
          toolRuntimeProvider: "agentcore",
          fallbackProvider,
          error: err instanceof Error ? err.message : String(err),
        },
        "warn",
      );
      void publishGatewayCountMetric("RouteFallbackToFargate", {
        channel: deps.channel,
        runtime: "fargate",
      });
      return routeFargate(
        deps,
        taskState,
        runtimeClass,
        fallbackDecision,
        { ...options, providerOverride: fallbackProvider },
      );
    }
  }

  return routeFargate(deps, taskState, runtimeClass, routeDecision, options);
}

async function invokeLambdaRoute(
  deps: RouteDeps,
  message: string,
  runtimeClass: RuntimeClass,
  routeDecision: RouteDecision,
  taskState: TaskStateItem | null,
): Promise<RouteResult> {
  if (!deps.invokeLambdaAgent || !deps.lambdaAgentFunctionArn) {
    throw new Error("Lambda agent runtime is not configured");
  }

  validateLambdaDeliveryTarget(deps);
  const emailTokenBudget = runtimeClass === "tool-enabled"
    ? resolveEmailTokenBudgetPolicy()
    : undefined;
  const assistantContext = buildAssistantRuntimeContext(
    deps,
    runtimeClass,
    routeDecision,
    emailTokenBudget,
  );
  const invokeResult = await deps.invokeLambdaAgent({
    functionArn: deps.lambdaAgentFunctionArn,
    userId: deps.userId,
    sessionId: resolveLambdaSessionId(deps, runtimeClass),
    traceId: deps.traceId,
    message,
    channel: deps.channel,
    connectionId: deps.connectionId,
    telegramChatId: deps.telegramChatId,
    callbackUrl: deps.callbackUrl,
    assistantContext,
    imageInput: deps.imageInput,
  });
  assertLambdaInvokeAccepted(invokeResult);
  logRouteEvent(
    "route.lambda.invoked",
    buildRouteLogPayload(deps, runtimeClass, routeDecision, taskState, false),
  );
  void publishGatewayCountMetric("RouteToLambda", {
    channel: deps.channel,
    runtime: "lambda",
  });
  return "lambda";
}

async function routeForcedRuntimeClass(
  deps: RouteDeps,
  message: string,
  runtimeClass: RuntimeClass,
  options: {
    activeToolAffinity?: boolean;
    providerOverride?: ToolRuntimeProvider;
    preferCallbackDelivery?: boolean;
  } = {},
): Promise<RouteResult> {
  const taskState = await deps.getTaskState(deps.userId);

  if (runtimeClass === "tool-enabled") {
    const routeDecision = resolveToolRuntimeRouteDecision(
      deps,
      taskState,
      options.providerOverride,
    );
    logRouteEvent(
      "route.classified",
      buildRouteLogPayload(deps, runtimeClass, routeDecision, taskState, false),
    );
    return routeToolRuntime(
      { ...deps, message },
      taskState,
      routeDecision,
      { ...options, runtimeClass },
    );
  }

  if (
    deps.agentRuntime !== "fargate" &&
    deps.invokeLambdaAgent &&
    deps.lambdaAgentFunctionArn
  ) {
    logRouteEvent(
      "route.classified",
      buildRouteLogPayload(deps, runtimeClass, "lambda", taskState, false),
    );
    return invokeLambdaRoute(deps, message, runtimeClass, "lambda", taskState);
  }

  const routeDecision: RouteDecision =
    taskState?.status === "Running" && taskState.publicIp
      ? "fargate-reuse"
      : "fargate-new";
  logRouteEvent(
    "route.classified",
    buildRouteLogPayload(deps, runtimeClass, routeDecision, taskState, false),
  );
  return routeFargate(
    { ...deps, message },
    taskState,
    runtimeClass,
    routeDecision,
  );
}

async function maybeHandleToolRuntimeAffinity(
  deps: RouteDeps,
): Promise<{
  handled: boolean;
  result?: RouteResult;
  replayMessage?: string;
  replayRuntimeClass?: RuntimeClass;
  replayProvider?: ToolRuntimeProvider;
}> {
  const affinity = await deps.getRoutingContext(deps.userId, deps.channel);
  if (!affinity) {
    return { handled: false };
  }

  if (isToolAffinityExpired(affinity)) {
    await deps.deleteRoutingContext(deps.userId, deps.channel);
    logRouteEvent("route.affinity.expired", {
      traceId: deps.traceId,
      channel: deps.channel,
      runtimeClass: affinity.runtimeClass,
    });
    return { handled: false };
  }

  const normalized = normalizeMessage(deps.message);
  if (deps.imageInput) {
    await deps.deleteRoutingContext(deps.userId, deps.channel);
    logRouteEvent("route.affinity.cleared", {
      traceId: deps.traceId,
      channel: deps.channel,
      runtimeClass: affinity.runtimeClass,
      reason: "image_handoff_chat_only",
    });
    return { handled: false };
  }

  if (TOOL_AFFINITY_CANCEL_PATTERN.test(normalized)) {
    await deps.deleteRoutingContext(deps.userId, deps.channel);
    await deps.sendClarification(TOOL_AFFINITY_END_MESSAGE);
    logRouteEvent("route.affinity.cleared", {
      traceId: deps.traceId,
      channel: deps.channel,
      runtimeClass: affinity.runtimeClass,
      reason: "explicit_cancel",
    });
    return { handled: true, result: "clarify" };
  }

  const affinityProvider = affinity.fallbackProvider ??
    affinity.provider ??
    resolveToolRuntimeProvider(deps);
  if (!shouldKeepToolAffinity(deps.message)) {
    await deps.deleteRoutingContext(deps.userId, deps.channel);
    logRouteEvent("route.affinity.cleared", {
      traceId: deps.traceId,
      channel: deps.channel,
      runtimeClass: affinity.runtimeClass,
      reason: "topic_switched",
    });
    return { handled: false };
  }

  const delegatedSemanticDecision = shouldDelegateToolAffinityDecisionToRuntime(
    deps,
    affinity,
  );
  await deps.putRoutingContext(
    deps.userId,
    buildToolRuntimeAffinityState(
      deps,
      affinity.createdAt,
      affinityProvider,
      affinity.fallbackProvider,
      affinity.providerLockedAt,
      affinity.providerLockReason,
    ),
  );
  logRouteEvent("route.affinity.reused", {
    traceId: deps.traceId,
    channel: deps.channel,
    runtimeClass: affinity.runtimeClass,
    provider: affinityProvider,
    delegatedSemanticDecision,
  });
  logRouteEvent("gateway.harness.session.reused", {
    traceId: deps.traceId,
    channel: deps.channel,
    runtimeClass: affinity.runtimeClass,
    provider: affinityProvider,
  });
  return {
    handled: false,
    replayMessage: deps.message,
    replayRuntimeClass: affinity.runtimeClass,
    replayProvider: affinityProvider,
  };
}

export async function routeMessage(deps: RouteDeps): Promise<RouteResult> {
  const affinityResolution = await maybeHandleToolRuntimeAffinity(deps);
  if (affinityResolution.handled) {
    return affinityResolution.result ?? "clarify";
  }
  if (
    affinityResolution.replayMessage &&
    affinityResolution.replayRuntimeClass
  ) {
    return routeForcedRuntimeClass(
      deps,
      affinityResolution.replayMessage,
      affinityResolution.replayRuntimeClass,
      {
        activeToolAffinity: true,
        providerOverride: affinityResolution.replayProvider,
        preferCallbackDelivery: shouldUseAgentCoreAssistantRuntime(deps),
      },
    );
  }

  if (deps.imageInput) {
    if (
      deps.agentRuntime === "fargate" ||
      !deps.invokeLambdaAgent ||
      !deps.lambdaAgentFunctionArn
    ) {
      await deps.sendClarification(
        "현재 사진 분석은 Lambda/Bedrock chat runtime에서만 지원합니다. 잠시 후 다시 시도하거나 텍스트로 질문해 주세요.",
      );
      logRouteEvent("route.image.unsupported_runtime", {
        traceId: deps.traceId,
        channel: deps.channel,
        agentRuntime: deps.agentRuntime,
      }, "warn");
      return "clarify";
    }

    logRouteEvent("route.image.chat_only", {
      traceId: deps.traceId,
      channel: deps.channel,
      runtimeClass: "chat-only",
    });
    return routeForcedRuntimeClass(deps, deps.message, "chat-only");
  }

  if (shouldUseAgentCoreAssistantRuntime(deps)) {
    const taskState = await deps.getTaskState(deps.userId);
    const runtimeClass = classifyRouteRuntimeClass(deps.message);
    const classifierSignals = getRouteClassificationSignals(deps.message);
    const routedMessage = stripRouteHint(deps.message);
    logRouteEvent(
      "route.classified",
      buildClassifierLogPayload(
        deps,
        runtimeClass,
        "agentcore",
        taskState,
        classifierSignals,
      ),
    );
    logRouteEvent("route.agentcore_assistant.selected", {
      traceId: deps.traceId,
      channel: deps.channel,
      runtimeClass,
      routeDecision: "agentcore",
      assistantRuntimeProvider: "agentcore",
      toolRuntimeProvider: resolveToolRuntimeProvider(deps),
    });

    if (runtimeClass === "tool-enabled") {
      await deps.putRoutingContext(
        deps.userId,
        buildToolRuntimeAffinityState(deps),
      );
      logRouteEvent("route.affinity.created", {
        traceId: deps.traceId,
        channel: deps.channel,
        runtimeClass,
        toolRuntimeProvider: resolveToolRuntimeProvider(deps),
      });
      logRouteEvent("gateway.harness.session.created", {
        traceId: deps.traceId,
        channel: deps.channel,
        runtimeClass,
        provider: resolveToolRuntimeProvider(deps),
      });
    }

    return routeToolRuntime(
      { ...deps, message: routedMessage },
      taskState,
      "agentcore",
      {
        runtimeClass,
        preferCallbackDelivery: true,
      },
    );
  }

  // Phase 2: Lambda agent path
  if (
    deps.agentRuntime === "lambda" &&
    deps.invokeLambdaAgent &&
    deps.lambdaAgentFunctionArn
  ) {
    const runtimeClass = classifyRouteRuntimeClass(deps.message);
    const classifierSignals = getRouteClassificationSignals(deps.message);
    logRouteEvent(
      "route.classified",
      buildClassifierLogPayload(deps, runtimeClass, "lambda", null, classifierSignals),
    );
    return invokeLambdaRoute(deps, deps.message, runtimeClass, "lambda", null);
  }

  // Smart routing: when agentRuntime=both, classify based on runtime class
  if (
    deps.agentRuntime === "both" &&
    deps.invokeLambdaAgent &&
    deps.lambdaAgentFunctionArn
  ) {
    const taskState = await deps.getTaskState(deps.userId);
    const runtimeClass = classifyRouteRuntimeClass(deps.message);
    const classifierSignals = getRouteClassificationSignals(deps.message);
    const decision = classifyRoute({ message: deps.message, taskState });
    const toolDecision: RouteDecision = runtimeClass === "tool-enabled"
      ? resolveToolRuntimeRouteDecision(deps, taskState)
      : decision;
    const routedMessage = stripRouteHint(deps.message);
    logRouteEvent(
      "route.classified",
      buildClassifierLogPayload(
        deps,
        runtimeClass,
        toolDecision,
        taskState,
        classifierSignals,
      ),
    );

    if (runtimeClass === "tool-enabled") {
      await deps.putRoutingContext(
        deps.userId,
        buildToolRuntimeAffinityState(deps),
      );
      logRouteEvent("route.affinity.created", {
        traceId: deps.traceId,
        channel: deps.channel,
        runtimeClass,
        toolRuntimeProvider: resolveToolRuntimeProvider(deps),
      });
      logRouteEvent("gateway.harness.session.created", {
        traceId: deps.traceId,
        channel: deps.channel,
        runtimeClass,
        provider: resolveToolRuntimeProvider(deps),
      });
      return routeToolRuntime(
        { ...deps, message: routedMessage },
        taskState,
        toolDecision,
      );
    }

    try {
      return await invokeLambdaRoute(deps, deps.message, runtimeClass, decision, taskState);
    } catch (err) {
      // Lambda failed — fall back to Fargate
      const fallbackDecision: RouteDecision =
        taskState?.status === "Running" && taskState.publicIp
          ? "fargate-reuse"
          : "fargate-new";
      logRouteEvent(
        "route.lambda.fallback_to_fargate",
        {
          ...buildRouteLogPayload(
            deps,
            runtimeClass,
            fallbackDecision,
            taskState,
            false,
          ),
          error: err instanceof Error ? err.message : String(err),
        },
        "warn",
      );
      void publishGatewayCountMetric("RouteFallbackToFargate", {
        channel: deps.channel,
        runtime: "fargate",
      });
      return routeFargate(
        { ...deps, message: routedMessage },
        taskState,
        runtimeClass,
        fallbackDecision,
      );
    }
  }

  // Fargate path (default)
  const taskState = await deps.getTaskState(deps.userId);
  const runtimeClass: RuntimeClass = "tool-enabled";
  const routeDecision = resolveToolRuntimeRouteDecision(deps, taskState);
  const classifierSignals = getRouteClassificationSignals(deps.message);
  await deps.putRoutingContext(
    deps.userId,
    buildToolRuntimeAffinityState(deps),
  );
  logRouteEvent("route.affinity.created", {
    traceId: deps.traceId,
    channel: deps.channel,
    runtimeClass,
    toolRuntimeProvider: resolveToolRuntimeProvider(deps),
  });
  logRouteEvent("gateway.harness.session.created", {
    traceId: deps.traceId,
    channel: deps.channel,
    runtimeClass,
    provider: resolveToolRuntimeProvider(deps),
  });
  logRouteEvent(
    "route.classified",
    buildClassifierLogPayload(
      deps,
      runtimeClass,
      routeDecision,
      taskState,
      classifierSignals,
    ),
  );
  return routeToolRuntime(deps, taskState, routeDecision);
}
