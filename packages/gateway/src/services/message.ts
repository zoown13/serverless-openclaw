import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  TABLE_NAMES,
  KEY_PREFIX,
  BRIDGE_PORT,
  BRIDGE_HTTP_TIMEOUT_MS,
  PENDING_MESSAGE_TTL_SEC,
  PREWARM_USER_ID,
} from "@serverless-openclaw/shared";
import type {
  AgentCoreRuntimeResult,
  InvokeAgentCoreRuntimeParams,
} from "./agentcore.js";
import type {
  BridgeMessageRequest,
  Channel,
  EmailTokenBudgetPolicy,
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

type FetchFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; statusText: string }>;
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

export async function savePendingMessage(
  send: Send,
  item: PendingMessageItem,
): Promise<void> {
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
  agentRuntime?: "lambda" | "fargate" | "both";
  toolRuntimeProvider?: ToolRuntimeProvider;
  invokeLambdaAgent?: (params: InvokeLambdaAgentParams) => Promise<{ accepted: true }>;
  lambdaAgentFunctionArn?: string;
  invokeAgentCoreRuntime?: (params: InvokeAgentCoreRuntimeParams) => Promise<AgentCoreRuntimeResult>;
  agentCoreRuntimeArn?: string;
  agentCoreRuntimeQualifier?: string;
  agentCoreFallbackProvider?: ToolRuntimeProvider;
  sessionId?: string;
}

export type RouteResult =
  | "sent"
  | "queued"
  | "started"
  | "lambda"
  | "agentcore"
  | "clarify";

const TOOL_AFFINITY_TTL_MS = 5 * 60 * 1000;
const TOOL_AFFINITY_CANCEL_PATTERN = /^(?:취소|그만|끝|됐어|done|cancel|stop)$/i;
const TOOL_AFFINITY_OBVIOUS_TOPIC_SWITCH_PATTERN =
  /^(?:안녕|안녕하세요|hello|hi|hey|고마워|감사|thanks?|thank you|잘가|bye|날씨|weather|번역|translate|농담|joke)(?:$|[!?.,\s])/i;
const TOOL_AFFINITY_CONTEXTUAL_FOLLOW_UP_PATTERN =
  /(?:그거|이거|저거|그\s*내역|이\s*내역|앞(?:에서|서)|방금|아까|위(?:에|의)|다시|더\s*있|더\s*찾|관련(?:된)?\s*것만|것만|합계|총액|카드사별|결제처별|상세|본문|메일|지메일|gmail|결제|지출|카드|영수증|명세서|일본|여행|표(?:로)?|정리|보여|가져와|찾아)/i;
const TOOL_AFFINITY_INDEPENDENT_CHAT_SWITCH_PATTERN =
  /(?:리눅스|linux|파이썬|python|자바스크립트|javascript|타입스크립트|typescript|git|깃|docker|도커|kubernetes|쿠버네티스|aws|lambda|람다|수학|역사|영어|문법|코드|명령어|방법|개념|뜻|의미|차이|예시|추천|설명|작성)\b?.*(?:알려줘|설명해|가르쳐|어떻게|뭐야|무엇|추천해|작성해|번역해)|(?:알려줘|설명해|가르쳐|어떻게|뭐야|무엇|추천해|작성해|번역해).*(?:리눅스|linux|파이썬|python|자바스크립트|javascript|타입스크립트|typescript|git|깃|docker|도커|kubernetes|쿠버네티스|aws|lambda|람다|수학|역사|영어|문법|코드|명령어|방법|개념|뜻|의미|차이|예시|추천|설명|작성)/i;
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

function resolveEmailTokenBudgetPolicy(): EmailTokenBudgetPolicy {
  return {
    mode: "headers-first",
    maxMessages: parsePositiveInteger(process.env.GMAIL_TOOL_MAX_MESSAGES, 5),
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
): BridgeMessageRequest {
  return {
    userId: deps.userId,
    message,
    channel: deps.channel,
    connectionId: resolveBridgeConnectionId(deps),
    callbackUrl: deps.callbackUrl,
    traceId: deps.traceId,
    runtimeClass,
    routeDecision,
    emailTokenBudget:
      runtimeClass === "tool-enabled"
        ? resolveEmailTokenBudgetPolicy()
        : undefined,
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

  if (TOOL_AFFINITY_OBVIOUS_TOPIC_SWITCH_PATTERN.test(normalized)) {
    return false;
  }

  if (
    classifyRouteRuntimeClass(normalized) === "chat-only" &&
    !TOOL_AFFINITY_CONTEXTUAL_FOLLOW_UP_PATTERN.test(normalized) &&
    TOOL_AFFINITY_INDEPENDENT_CHAT_SWITCH_PATTERN.test(normalized)
  ) {
    return false;
  }

  return true;
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
): Promise<RouteResult> {
  const bridgeMessage = buildBridgeMessageRequest(
    deps,
    deps.message,
    runtimeClass,
    routeDecision,
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
  options: { activeToolAffinity?: boolean } = {},
): Promise<RouteResult> {
  if (!deps.invokeAgentCoreRuntime || !deps.agentCoreRuntimeArn) {
    throw new Error("AgentCore tool runtime is not configured");
  }

  validateLambdaDeliveryTarget(deps);
  const bridgeMessage = buildBridgeMessageRequest(
    deps,
    deps.message,
    "tool-enabled",
    "agentcore",
  );
  logRouteEvent("agentcore.invoke.started", {
    ...buildRouteLogPayload(deps, "tool-enabled", "agentcore", null, false),
    toolRuntimeProvider: "agentcore",
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
    callbackUrl: bridgeMessage.callbackUrl,
    runtimeClass: "tool-enabled",
    emailTokenBudget: bridgeMessage.emailTokenBudget,
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
      ...buildRouteLogPayload(deps, "tool-enabled", "agentcore", null, false),
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
    ...buildRouteLogPayload(deps, "tool-enabled", "agentcore", null, false),
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
  options: { activeToolAffinity?: boolean; providerOverride?: ToolRuntimeProvider } = {},
): Promise<RouteResult> {
  const provider = options.providerOverride ?? resolveToolRuntimeProvider(deps);
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
            "tool-enabled",
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
      return routeFargate(deps, taskState, "tool-enabled", fallbackDecision);
    }
  }

  return routeFargate(deps, taskState, "tool-enabled", routeDecision);
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
  options: { activeToolAffinity?: boolean; providerOverride?: ToolRuntimeProvider } = {},
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
      options,
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

  if (shouldKeepToolAffinity(deps.message)) {
    await deps.putRoutingContext(
      deps.userId,
      buildToolRuntimeAffinityState(
        deps,
        affinity.createdAt,
        affinity.fallbackProvider ?? affinity.provider ?? resolveToolRuntimeProvider(deps),
        affinity.fallbackProvider,
        affinity.providerLockedAt,
        affinity.providerLockReason,
      ),
    );
    logRouteEvent("route.affinity.reused", {
      traceId: deps.traceId,
      channel: deps.channel,
      runtimeClass: affinity.runtimeClass,
      provider: affinity.fallbackProvider ?? affinity.provider ?? resolveToolRuntimeProvider(deps),
    });
    logRouteEvent("gateway.harness.session.reused", {
      traceId: deps.traceId,
      channel: deps.channel,
      runtimeClass: affinity.runtimeClass,
      provider: affinity.fallbackProvider ?? affinity.provider ?? resolveToolRuntimeProvider(deps),
    });
    return {
      handled: false,
      replayMessage: deps.message,
      replayRuntimeClass: affinity.runtimeClass,
      replayProvider: affinity.fallbackProvider ?? affinity.provider,
    };
  }

  await deps.deleteRoutingContext(deps.userId, deps.channel);
  logRouteEvent("route.affinity.cleared", {
    traceId: deps.traceId,
    channel: deps.channel,
    runtimeClass: affinity.runtimeClass,
    reason: "topic_switched",
  });
  return { handled: false };
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
