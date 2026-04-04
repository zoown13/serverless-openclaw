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
  BridgeMessageRequest,
  Channel,
  PendingClarificationState,
  EmailTokenBudgetPolicy,
  PendingMessageItem,
  RouteDecision,
  RuntimeClass,
  TaskStateItem,
} from "@serverless-openclaw/shared";
import type { StartTaskParams } from "./container.js";
import type { InvokeLambdaAgentParams } from "./lambda-agent.js";
import {
  classifyRoute,
  classifyRouteRuntimeClass,
  isAmbiguousPaymentSourceQuestion,
  stripRouteHint,
} from "./route-classifier.js";
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
  getPendingClarification: (
    userId: string,
    channel: Channel,
  ) => Promise<PendingClarificationState | null>;
  putPendingClarification: (
    userId: string,
    state: PendingClarificationState,
  ) => Promise<void>;
  deletePendingClarification: (userId: string, channel: Channel) => Promise<void>;
  sendClarification: (text: string) => Promise<void>;
  startTaskParams: StartTaskParams;
  /** Lambda agent runtime support (Phase 2) */
  agentRuntime?: "lambda" | "fargate" | "both";
  invokeLambdaAgent?: (params: InvokeLambdaAgentParams) => Promise<{ accepted: true }>;
  lambdaAgentFunctionArn?: string;
  sessionId?: string;
}

export type RouteResult = "sent" | "queued" | "started" | "lambda" | "clarify";

const CLARIFICATION_TTL_MS = 5 * 60 * 1000;
const PAYMENT_SOURCE_CLARIFICATION =
  "지메일에서 확인할까요, 아니면 일반 답변으로 도와드릴까요?";
const GMAIL_CONFIRMATION_PATTERNS = [
  /^(?:지메일|지메일에서|gmail|gmail에서)$/i,
  /^(?:메일에서|이메일에서|메일로|이메일로)$/i,
  /^(?:지메일에서|gmail에서)\s*확인해줘$/i,
  /^(?:지메일|지메일에서|gmail|gmail에서|메일에서|이메일에서)(?:\s*확인해줘(?:요)?|\s*봐줘|\s*해주세요)?$/i,
];
const GENERAL_CONFIRMATION_PATTERNS = [
  /^(?:일반|일반으로)$/i,
  /^(?:그냥 답변|일반 답변)$/i,
  /^(?:채팅으로|추론으로)$/i,
  /^(?:일반 답변으로 해줘|그냥 답변해줘)$/i,
  /^(?:일반|일반 답변|그냥 답변|채팅|추론)(?:으로)?(?:\s*해줘(?:요)?|\s*해주세요)?$/i,
];

type ClarificationChoice = "gmail" | "general";

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
  return value.replace(/\s+/g, " ").trim();
}

function normalizeClarificationReply(value: string): string {
  return normalizeMessage(value)
    .normalize("NFKC")
    .replace(/[.!?~。？！]+$/gu, "")
    .trim();
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

function buildRouteLogPayload(
  deps: RouteDeps,
  runtimeClass: RuntimeClass,
  routeDecision: RouteDecision,
  taskState: TaskStateItem | null,
  pendingQueued: boolean,
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
    messageLength: deps.message.length,
  };
}

function parseClarificationChoice(message: string): ClarificationChoice | null {
  const normalized = normalizeClarificationReply(message);

  if (GMAIL_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "gmail";
  }

  if (GENERAL_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "general";
  }

  return null;
}

function isExpiredClarification(state: PendingClarificationState): boolean {
  return Date.parse(state.expiresAt) <= Date.now();
}

function isShortAmbiguousReply(message: string): boolean {
  return normalizeMessage(message).length <= 20;
}

function buildPendingClarification(
  deps: RouteDeps,
  originalMessage: string,
  resendCount = 0,
): PendingClarificationState {
  const createdAt = new Date().toISOString();
  return {
    kind: "payment_source",
    channel: deps.channel,
    originalMessage,
    connectionId: deps.connectionId,
    callbackUrl: deps.callbackUrl,
    telegramChatId: deps.telegramChatId,
    resendCount,
    createdAt,
    expiresAt: new Date(Date.now() + CLARIFICATION_TTL_MS).toISOString(),
  };
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
    sessionId: deps.sessionId ?? `session-${deps.userId}`,
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
): Promise<RouteResult> {
  const taskState = await deps.getTaskState(deps.userId);

  if (runtimeClass === "tool-enabled") {
    const routeDecision: RouteDecision =
      taskState?.status === "Running" && taskState.publicIp
        ? "fargate-reuse"
        : "fargate-new";
    logRouteEvent(
      "route.classified",
      buildRouteLogPayload(deps, runtimeClass, routeDecision, taskState, false),
    );
    return routeFargate({ ...deps, message }, taskState, runtimeClass, routeDecision);
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
  return routeFargate({ ...deps, message }, taskState, runtimeClass, routeDecision);
}

async function maybeHandlePendingClarification(
  deps: RouteDeps,
): Promise<{
  handled: boolean;
  result?: RouteResult;
  replayMessage?: string;
  replayRuntimeClass?: RuntimeClass;
}> {
  const pending = await deps.getPendingClarification(deps.userId, deps.channel);
  if (!pending) {
    return { handled: false };
  }

  if (isExpiredClarification(pending)) {
    await deps.deletePendingClarification(deps.userId, deps.channel);
    return { handled: false };
  }

  const choice = parseClarificationChoice(deps.message);
  if (choice === "gmail") {
    await deps.deletePendingClarification(deps.userId, deps.channel);
    logRouteEvent("route.clarification.resolved", {
      traceId: deps.traceId,
      channel: deps.channel,
      choice,
      kind: pending.kind,
    });
    return {
      handled: false,
      replayMessage: pending.originalMessage,
      replayRuntimeClass: "tool-enabled",
    };
  }

  if (choice === "general") {
    await deps.deletePendingClarification(deps.userId, deps.channel);
    logRouteEvent("route.clarification.resolved", {
      traceId: deps.traceId,
      channel: deps.channel,
      choice,
      kind: pending.kind,
    });
    return {
      handled: false,
      replayMessage: pending.originalMessage,
      replayRuntimeClass: "chat-only",
    };
  }

  if (isShortAmbiguousReply(deps.message)) {
    const resendCount = pending.resendCount ?? 0;
    if (resendCount >= 1) {
      await deps.deletePendingClarification(deps.userId, deps.channel);
      return { handled: false };
    }
    await deps.putPendingClarification(
      deps.userId,
      buildPendingClarification(deps, pending.originalMessage, resendCount + 1),
    );
    await deps.sendClarification(PAYMENT_SOURCE_CLARIFICATION);
    logRouteEvent("route.clarification.sent", {
      traceId: deps.traceId,
      channel: deps.channel,
      kind: pending.kind,
      resendCount: resendCount + 1,
    });
    return { handled: true, result: "clarify" };
  }

  await deps.deletePendingClarification(deps.userId, deps.channel);
  return { handled: false };
}

export async function routeMessage(deps: RouteDeps): Promise<RouteResult> {
  const pendingResolution = await maybeHandlePendingClarification(deps);
  if (pendingResolution.handled) {
    return pendingResolution.result ?? "clarify";
  }
  if (pendingResolution.replayMessage && pendingResolution.replayRuntimeClass) {
    return routeForcedRuntimeClass(
      deps,
      pendingResolution.replayMessage,
      pendingResolution.replayRuntimeClass,
    );
  }

  if (isAmbiguousPaymentSourceQuestion(deps.message)) {
    await deps.putPendingClarification(
      deps.userId,
      buildPendingClarification(deps, deps.message),
    );
    await deps.sendClarification(PAYMENT_SOURCE_CLARIFICATION);
    logRouteEvent("route.clarification.sent", {
      traceId: deps.traceId,
      channel: deps.channel,
      kind: "payment_source",
    });
    return "clarify";
  }

  // Phase 2: Lambda agent path
  if (
    deps.agentRuntime === "lambda" &&
    deps.invokeLambdaAgent &&
    deps.lambdaAgentFunctionArn
  ) {
    const runtimeClass = classifyRouteRuntimeClass(deps.message);
    logRouteEvent(
      "route.classified",
      buildRouteLogPayload(deps, runtimeClass, "lambda", null, false),
    );
    return invokeLambdaRoute(deps, deps.message, runtimeClass, "lambda", null);
  }

  // Smart routing: when agentRuntime=both, classify based on task state and message hints
  if (
    deps.agentRuntime === "both" &&
    deps.invokeLambdaAgent &&
    deps.lambdaAgentFunctionArn
  ) {
    const taskState = await deps.getTaskState(deps.userId);
    const runtimeClass = classifyRouteRuntimeClass(deps.message);
    const decision = classifyRoute({ message: deps.message, taskState });
    const routedMessage = stripRouteHint(deps.message);
    logRouteEvent(
      "route.classified",
      buildRouteLogPayload(deps, runtimeClass, decision, taskState, false),
    );

    if (decision === "clarify") {
      await deps.putPendingClarification(
        deps.userId,
        buildPendingClarification(deps, routedMessage),
      );
      await deps.sendClarification(PAYMENT_SOURCE_CLARIFICATION);
      logRouteEvent("route.clarification.sent", {
        traceId: deps.traceId,
        channel: deps.channel,
        kind: "payment_source",
      });
      return "clarify";
    }

    if (decision === "fargate-reuse" || decision === "fargate-new") {
      return routeFargate(
        { ...deps, message: routedMessage },
        taskState,
        runtimeClass,
        decision,
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
  const routeDecision: RouteDecision =
    taskState?.status === "Running" && taskState.publicIp
      ? "fargate-reuse"
      : "fargate-new";
  logRouteEvent(
    "route.classified",
    buildRouteLogPayload(
      deps,
      "tool-enabled",
      routeDecision,
      taskState,
      false,
    ),
  );
  return routeFargate(deps, taskState, "tool-enabled", routeDecision);
}
