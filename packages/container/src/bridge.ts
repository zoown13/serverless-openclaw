import express from "express";
import { createAuthMiddleware } from "./auth-middleware.js";
import {
  publishCountMetric,
  publishMessageMetrics,
  publishFirstResponseTime,
} from "./metrics.js";
import {
  isGmailReady,
  maybeHandleCustomGmailRequest,
  type ToolEvent,
} from "./gmail-tool.js";
import { logTelegramContentQuality } from "./callback-sender.js";
import { RecentCostContextStore, type RecentCostContext } from "./recent-cost-context.js";
import type {
  BridgeMessageRequest,
  ServerMessage,
  Channel,
  EmailTokenBudgetPolicy,
  AssistantRuntimeContext,
  UpstreamCostEstimate,
} from "@serverless-openclaw/shared";
import { estimateCost, type CostEstimate } from "@serverless-openclaw/shared";

export interface BridgeDeps {
  authToken: string;
  openclawClient: {
    sendMessage(userId: string, message: string): AsyncGenerator<string>;
    close(): void;
  };
  callbackSender: {
    send(connectionId: string, data: ServerMessage): Promise<void>;
  };
  lifecycle: {
    updateTaskState(status: string, publicIp?: string): Promise<void>;
    gracefulShutdown(): Promise<void>;
    updateLastActivity(): void;
    lastActivityTime: Date;
  };
  processStartTime: number;
  channel: string;
  agentCoreHttpEnabled?: boolean;
  runtimeLabel?: string;
  onMessageComplete?: (userId: string, userMsg: string, assistantMsg: string, channel: Channel) => Promise<void>;
  getAndClearHistoryPrefix?: () => string;
}

interface ProcessedMessageResult {
  message: string;
  source: string;
  handoffRuntimeClass?: "chat-only" | "tool-enabled";
  handoffMessage?: string;
  clearToolAffinity?: boolean;
}

const startTime = Date.now();

function logBridgeEvent(
  event: string,
  payload: Record<string, unknown>,
  level: "info" | "error" = "info",
): void {
  const entry = JSON.stringify({
    component: "bridge",
    event,
    runtimeImageTag: process.env.IMAGE_TAG ?? "unknown",
    responseFormatVersion: process.env.RESPONSE_FORMAT_VERSION ?? "unknown",
    ...payload,
  });

  if (level === "error") {
    console.error(entry);
    return;
  }

  console.info(entry);
}

function resolveTraceId(body: Partial<BridgeMessageRequest>): string {
  return body.traceId ?? `bridge-${body.userId ?? "unknown"}`;
}

function resolveDeliveryType(
  channel: Partial<BridgeMessageRequest>["channel"],
): "websocket" | "telegram" {
  return channel === "telegram" ? "telegram" : "websocket";
}

function parseInvocationBody(value: unknown): Partial<BridgeMessageRequest> {
  if (Buffer.isBuffer(value)) {
    return parseInvocationBody(value.toString("utf8"));
  }

  if (typeof value === "object" && value !== null && !Buffer.isBuffer(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["payload", "body", "input", "request"]) {
      const nested = record[key];
      if (nested === undefined) continue;

      if (typeof nested === "object" && nested !== null && "bytes" in nested) {
        const bytes = (nested as Record<string, unknown>).bytes;
        if (typeof bytes === "string") {
          return parseInvocationBody(Buffer.from(bytes, "base64"));
        }
      }

      const parsedNested = parseInvocationBody(nested);
      if (Object.keys(parsedNested).length > 0) {
        return parsedNested;
      }
    }

    return record as Partial<BridgeMessageRequest>;
  }

  if (typeof value !== "string") {
    return {};
  }

  const raw = value.replace(/^\uFEFF/, "").trim();
  if (raw.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parseInvocationBody(parsed)
      : {};
  } catch {
    return {};
  }
}

function buildBridgeLogContext(
  body: Partial<BridgeMessageRequest>,
): Record<string, unknown> {
  return {
    traceId: resolveTraceId(body),
    channel: body.channel ?? "unknown",
    runtimeClass: body.runtimeClass ?? "chat-only",
    routeDecision: body.routeDecision ?? "lambda",
    messageLength: body.message?.length ?? 0,
    deliveryType: resolveDeliveryType(body.channel),
  };
}

function buildToolEnabledPrefix(
  body: Partial<BridgeMessageRequest>,
): string | undefined {
  if (body.runtimeClass !== "tool-enabled") {
    return undefined;
  }

  const budget = body.emailTokenBudget;
  if (!budget) {
    return "[System: Use tools incrementally. Prefer headers and summaries first, and avoid large email bodies unless explicitly requested.]";
  }

  const bodyAccessInstruction = budget.requireExplicitBodyAccess
    ? "Do not read full message bodies or attachments unless the user explicitly asks for a specific message."
    : "Only read a message body when the task truly needs it, and keep the scope narrow.";
  const paymentScanMessages = budget.paymentScanMessages ?? 25;

  return `[System: Operate in headers-first safe mode to control Gmail and browser token usage. Show at most ${budget.maxMessages} detailed Gmail items per step, but payment summaries may scan up to ${paymentScanMessages} headers/snippets for aggregation before showing a short evidence list. Prefer sender, subject, date, and snippet previews truncated to ${budget.maxSnippetChars} characters. ${bodyAccessInstruction} If the user clearly identifies one Gmail result, open only that single message body. Never inspect attachments in this runtime. If body access is needed, read at most ${budget.maxBodyChars} characters from one item at a time and summarize incrementally before reading more.]`;
}

export function buildAssistantContextPrefix(
  context?: AssistantRuntimeContext,
): string | undefined {
  if (!context) return undefined;

  return [
    `[System: AssistantRuntimeContext v${context.version}.`,
    `Current route is ${context.runtime.runtimeClass}/${context.runtime.routeDecision ?? "unknown"}.`,
    `Tool runtime provider is ${context.runtime.toolRuntimeProvider ?? "unknown"} with fallback ${context.runtime.fallbackProvider ?? "unknown"}.`,
    `Active tool affinity is ${context.toolAffinity?.active === true ? "true" : "false"}.`,
    `Gmail capability is ${context.capabilities.gmail.status} via ${context.capabilities.gmail.executionRuntime} in ${context.capabilities.gmail.safetyMode} mode.`,
    "Do not claim the assistant cannot access Gmail or payment data when this context says the delegated tool runtime can verify it.",
    `${context.guidance.toolRuntime}]`,
  ].join(" ");
}

function defaultEmailTokenBudget(): EmailTokenBudgetPolicy {
  return {
    mode: "headers-first",
    maxMessages: 5,
    paymentScanMessages: 25,
    maxSnippetChars: 240,
    maxBodyChars: 1600,
    requireExplicitBodyAccess: true,
  };
}

function logToolEvent(
  event: ToolEvent,
  logContext: Record<string, unknown>,
): void {
  switch (event.type) {
    case "intentDecided":
      logBridgeEvent("bridge.tool.intent.decided", {
        ...logContext,
        decisionSource: event.decisionSource,
        action: event.action,
        taskFamily: event.taskFamily,
        sourceChoice: event.sourceChoice,
        followUpIntent: event.followUpIntent,
        confidence: event.confidence,
        slmBackend: event.slmBackend,
      });
      if (event.decisionSource === "slm") {
        logBridgeEvent("bridge.slm.classified", {
          ...logContext,
          decisionSource: event.decisionSource,
          action: event.action,
          taskFamily: event.taskFamily,
          sourceChoice: event.sourceChoice,
          followUpIntent: event.followUpIntent,
          confidence: event.confidence,
          slmBackend: event.slmBackend,
        });
      }
      return;
    case "contextCreated":
    case "contextReused":
    case "contextCleared":
    case "contextExpired":
      logBridgeEvent(`bridge.tool.context.${event.type.replace("context", "").toLowerCase()}`, {
        ...logContext,
        taskFamily: event.taskFamily,
        sourceChoice: event.sourceChoice,
        reason: event.reason,
      });
      return;
    case "clarificationSent":
      logBridgeEvent("bridge.tool.clarification.sent", {
        ...logContext,
        taskFamily: event.taskFamily,
        reason: event.reason,
      });
      return;
    case "handlerFallback":
      logBridgeEvent("bridge.tool.handler.fallback", {
        ...logContext,
        taskFamily: event.taskFamily,
        reason: event.reason,
      });
      logBridgeEvent("bridge.slm.fallback", {
        ...logContext,
        taskFamily: event.taskFamily,
        reason: event.reason,
        slmBackend: event.slmBackend,
      });
      return;
    case "paymentRefineStarted":
      logBridgeEvent("bridge.tool.payment.refine.started", {
        ...logContext,
        taskFamily: event.taskFamily,
        topicKeywords: event.topicKeywords,
        candidateCount: event.candidateCount,
        filteredCount: event.filteredCount,
      });
      return;
    case "paymentRefineUsedBodyCheck":
      logBridgeEvent("bridge.tool.payment.refine.used_body_check", {
        ...logContext,
        taskFamily: event.taskFamily,
        topicKeywords: event.topicKeywords,
        candidateCount: event.candidateCount,
        filteredCount: event.filteredCount,
        bodyCheckedCount: event.bodyCheckedCount,
        queryMode: event.queryMode,
      });
      return;
    case "paymentRefineCompleted":
      logBridgeEvent("bridge.tool.payment.refine.completed", {
        ...logContext,
        taskFamily: event.taskFamily,
        topicKeywords: event.topicKeywords,
        matchedCount: event.matchedCount,
        candidateCount: event.candidateCount,
        filteredCount: event.filteredCount,
        bodyCheckedCount: event.bodyCheckedCount,
        queryMode: event.queryMode,
      });
      return;
    case "paymentRefineNoMatch":
      logBridgeEvent("bridge.tool.payment.refine.no_match", {
        ...logContext,
        taskFamily: event.taskFamily,
        topicKeywords: event.topicKeywords,
        candidateCount: event.candidateCount,
        filteredCount: event.filteredCount,
        bodyCheckedCount: event.bodyCheckedCount,
        queryMode: event.queryMode,
        reason: event.reason,
      });
      return;
    case "paymentScanCompleted":
      logBridgeEvent("bridge.tool.payment.scan.completed", {
        ...logContext,
        taskFamily: event.taskFamily,
        topicKeywords: event.topicKeywords,
        matchedCount: event.matchedCount,
        candidateCount: event.candidateCount,
        scanLimit: event.scanLimit,
        queryCount: event.queryCount,
        expandedScan: event.expandedScan,
        queryMode: event.queryMode,
      });
  }
}

function buildToolCostEstimate(
  body: Partial<BridgeMessageRequest>,
  logContext: Record<string, unknown>,
  runtimeLabel: string,
  durationMs: number,
): CostEstimate {
  return estimateCost({
    traceId: String(logContext.traceId ?? resolveTraceId(body)),
    userId: body.userId!,
    channel: body.channel!,
    runtimeClass: body.runtimeClass ?? "tool-enabled",
    provider: runtimeLabel === "agentcore" ? "agentcore" : "fargate",
    durationMs,
    memoryMb: resolveToolMemoryMb(),
    agentCoreVcpu: runtimeLabel === "agentcore" ? resolveAgentCoreVcpu() : undefined,
    upstreamCosts: resolveUpstreamCosts(body),
    bedrockInputUsdPerMillionOverride: parseOptionalPositiveFloat(
      process.env.BEDROCK_INPUT_USD_PER_MILLION_TOKENS,
    ),
    bedrockOutputUsdPerMillionOverride: parseOptionalPositiveFloat(
      process.env.BEDROCK_OUTPUT_USD_PER_MILLION_TOKENS,
    ),
  });
}

async function saveToolCostEstimate(
  costStore: RecentCostContextStore | undefined,
  body: Partial<BridgeMessageRequest>,
  logContext: Record<string, unknown>,
  estimate: CostEstimate,
): Promise<void> {
  logBridgeEvent("bridge.cost.estimated", {
    ...logContext,
    provider: estimate.provider,
    durationMs: estimate.durationMs,
    estimatedUsd: estimate.estimatedUsd,
    costConfidence: estimate.confidence,
    costBreakdown: estimate.breakdown,
    upstreamCosts: estimate.upstreamCosts,
    pricing: estimate.pricing,
  });

  if (!costStore) {
    logBridgeEvent("bridge.cost.save_skipped", {
      ...logContext,
      reason: "session-bucket-not-configured",
    });
    return;
  }

  try {
    const saved = await costStore.save(body.userId!, resolveToolCostSessionId(body), estimate);
    logBridgeEvent("bridge.cost.saved", {
      ...logContext,
      estimatedUsd: estimate.estimatedUsd,
      expiresAt: saved.expiresAt,
    });
  } catch (err: unknown) {
    logBridgeEvent("bridge.cost.save_failed", {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    }, "error");
  }
}

function parseOptionalPositiveFloat(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function resolveUpstreamCosts(
  body: Partial<BridgeMessageRequest>,
): UpstreamCostEstimate[] | undefined {
  const upstream = body.assistantContext?.cost?.upstream;
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

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveToolCostSessionId(body: Partial<BridgeMessageRequest>): string {
  return body.assistantContext?.sessionId ?? `${body.channel ?? "unknown"}:${body.connectionId ?? "unknown"}`;
}

function resolveToolMemoryMb(): number | undefined {
  return parseOptionalPositiveInt(
    process.env.AGENTCORE_MEMORY_MB ??
    process.env.TOOL_RUNTIME_MEMORY_MB ??
    process.env.ECS_MEMORY_MB ??
    "2048",
  );
}

function resolveAgentCoreVcpu(): number | undefined {
  return parseOptionalPositiveFloat(process.env.AGENTCORE_VCPU ?? process.env.TOOL_RUNTIME_VCPU ?? "1");
}

function isCostLookupRequest(message: string | undefined): boolean {
  const normalized = message?.trim() ?? "";
  if (!normalized || normalized.length > 120) {
    return false;
  }

  return [
    /^\/(?:cost|usage|요금|비용)\b/i,
    /(?:이번|방금|직전|마지막|이전).*(?:질문|요청|응답|호출|조회).*(?:비용|요금|얼마|cost)/i,
    /(?:비용|요금|cost).*(?:이번|방금|직전|마지막|이전|얼마)/i,
    /(?:얼마).*(?:썼|나왔|들었).*(?:이번|방금|직전|마지막|요청|질문|호출|조회)/i,
  ].some((pattern) => pattern.test(normalized));
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) return "unknown";
  if (value > 0 && value < 0.000001) return "<$0.000001";
  return `$${value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function buildRecentCostMessage(context: RecentCostContext | undefined): string {
  if (!context) {
    return "아직 직전 tool runtime 비용 추정 기록이 없어요. Gmail 조회나 도구 요청을 한 번 실행한 뒤 /cost 또는 이번 질문 비용 얼마야? 라고 물어봐 주세요.";
  }

  const estimate = context.estimate;
  const parts = [
    `직전 tool runtime 질의 추정 비용은 약 ${formatUsd(estimate.estimatedUsd)} 입니다.`,
    "",
  ];

  if (estimate.breakdown.agentCoreUsd !== undefined) {
    parts.push(`- AgentCore Runtime: ${formatUsd(estimate.breakdown.agentCoreUsd)}`);
  }
  if (estimate.breakdown.fargateUsd !== undefined) {
    parts.push(`- Fargate Runtime: ${formatUsd(estimate.breakdown.fargateUsd)}`);
  }
  if (estimate.breakdown.bedrockUsd !== undefined) {
    parts.push(`- Bedrock: ${formatUsd(estimate.breakdown.bedrockUsd)}`);
  }
  if (estimate.breakdown.upstreamUsd !== undefined) {
    parts.push(`- Gateway/frontdoor: ${formatUsd(estimate.breakdown.upstreamUsd)}`);
  }

  parts.push(
    `- Runtime: ${estimate.provider}${estimate.model ? ` / ${estimate.model}` : ""}`,
    `- Duration: ${estimate.durationMs} ms`,
    "",
    "정확한 AWS 청구액은 Billing 반영 후 달라질 수 있고, 이 값은 질의 직후 추정치입니다.",
  );

  return parts.join("\n");
}

export function createApp(deps: BridgeDeps): express.Express {
  const app = express();
  let firstResponseSent = false;
  const runtimeLabel = deps.runtimeLabel ?? "fargate";
  const recentCostBucket = process.env.SESSION_BUCKET ?? process.env.DATA_BUCKET;
  const costStore = recentCostBucket
    ? new RecentCostContextStore(recentCostBucket)
    : undefined;
  const shouldDeferCallbackPersistence =
    process.env.BRIDGE_DEFER_CALLBACK_PERSISTENCE !== "false";

  async function persistMessagePair(
    deliveryMode: "callback" | "response",
    logContext: Record<string, unknown>,
    deliveryType: "websocket" | "telegram",
    body: Partial<BridgeMessageRequest>,
    assistantMessage: string,
  ): Promise<void> {
    if (!deps.onMessageComplete || !assistantMessage) {
      return;
    }

    const persistence = deps.onMessageComplete(
      body.userId!,
      body.message!,
      assistantMessage,
      body.channel! as "web" | "telegram",
    ).catch(() => {});

    if (deliveryMode === "callback" && shouldDeferCallbackPersistence) {
      logBridgeEvent("bridge.message.persist.deferred", {
        ...logContext,
        deliveryType,
      });
      void persistence;
      return;
    }

    await persistence;
  }

  async function processAcceptedMessage(
    body: Partial<BridgeMessageRequest>,
    deliveryMode: "callback" | "response",
  ): Promise<ProcessedMessageResult> {
    const msgStart = Date.now();
    const logContext = buildBridgeLogContext(body);
    const deliveryType = resolveDeliveryType(body.channel);
    logBridgeEvent("bridge.message.accepted", logContext);
    if (body.assistantContext) {
      logBridgeEvent("bridge.assistant_context.loaded", {
        ...logContext,
        toolRuntimeProvider: body.assistantContext.runtime.toolRuntimeProvider,
        hasActiveToolAffinity: body.assistantContext.toolAffinity?.active === true,
        gmailCapability: body.assistantContext.capabilities.gmail.status,
      });
    }

    if (isCostLookupRequest(body.message)) {
      let recentCostContext: RecentCostContext | undefined;
      try {
        recentCostContext = costStore
          ? await costStore.load(body.userId!, resolveToolCostSessionId(body))
          : undefined;
        logBridgeEvent("bridge.cost.loaded", {
          ...logContext,
          hasRecentCost: Boolean(recentCostContext),
          estimatedUsd: recentCostContext?.estimate.estimatedUsd,
        });
      } catch (err: unknown) {
        logBridgeEvent("bridge.cost.load_failed", {
          ...logContext,
          error: err instanceof Error ? err.message : String(err),
        }, "error");
      }

      const message = buildRecentCostMessage(recentCostContext);
      if (deliveryMode === "callback") {
        await deps.callbackSender.send(body.connectionId!, {
          type: "stream_chunk",
          content: message,
          conversationId: undefined,
        });
        await deps.callbackSender.send(body.connectionId!, {
          type: "stream_end",
        });
      }

      return {
        message,
        source: "cost-context",
      };
    }

    try {
      const gmailReady = await isGmailReady();
      const gmailResponse = await maybeHandleCustomGmailRequest({
        userId: body.userId!,
        sessionKey: body.connectionId!,
        message: body.message!,
        gmailReady,
        emailTokenBudget: body.emailTokenBudget ?? defaultEmailTokenBudget(),
        onToolEvent: (event) => logToolEvent(event, logContext),
      });
      if (gmailResponse !== undefined) {
        if (gmailResponse.kind === "direct") {
          if (deliveryMode === "callback") {
            await deps.callbackSender.send(body.connectionId!, {
              type: "stream_chunk",
              content: gmailResponse.message,
              conversationId: undefined,
            });
            await deps.callbackSender.send(body.connectionId!, {
              type: "stream_end",
            });
          }
          if (body.channel === "telegram") {
            logTelegramContentQuality(gmailResponse.message);
          }

          const latency = Date.now() - msgStart;
          const costEstimate = buildToolCostEstimate(body, logContext, runtimeLabel, latency);
          await saveToolCostEstimate(costStore, body, logContext, costEstimate);
          void publishMessageMetrics({
            latency,
            responseLength: gmailResponse.message.length,
            channel: deps.channel,
          });

          if (!firstResponseSent) {
            firstResponseSent = true;
            void publishFirstResponseTime(Date.now() - deps.processStartTime, deps.channel);
          }

          await persistMessagePair(
            deliveryMode,
            logContext,
            deliveryType,
            body,
            gmailResponse.message,
          );

          logBridgeEvent("bridge.delivery.success", {
            ...logContext,
            deliveryType,
            source: gmailResponse.source,
          });
          void publishCountMetric("DeliverySuccess", {
            channel: body.channel!,
            runtime: runtimeLabel,
            deliveryType,
          });
          return {
            message: gmailResponse.message,
            source: gmailResponse.source,
          };
        }

        if (gmailResponse.kind === "handoff") {
          logBridgeEvent("bridge.tool.handoff.chat_only", {
            ...logContext,
            deliveryType,
            source: gmailResponse.source,
          });

          if (deliveryMode === "response") {
            return {
              message: gmailResponse.message,
              source: gmailResponse.source,
              handoffRuntimeClass: gmailResponse.runtimeClass,
              handoffMessage: gmailResponse.message,
              clearToolAffinity: gmailResponse.clearToolContext,
            };
          }

          body.message = gmailResponse.message;
          body.runtimeClass = gmailResponse.runtimeClass;
        } else {
          body.message = gmailResponse.message;
        }

      }

      const prefixes: string[] = [];
      const historyPrefix = deps.getAndClearHistoryPrefix?.();
      if (historyPrefix) {
        prefixes.push(historyPrefix.trimEnd());
      }
      const assistantContextPrefix = buildAssistantContextPrefix(body.assistantContext);
      if (assistantContextPrefix) {
        prefixes.push(assistantContextPrefix);
      }
      if (body.channel === "telegram") {
        prefixes.push("[System: Respond in plain text only. Do not use markdown formatting such as **bold**, *italic*, ```code```, etc.]");
      }
      const toolEnabledPrefix = buildToolEnabledPrefix(body);
      if (toolEnabledPrefix) {
        prefixes.push(toolEnabledPrefix);
      }
      const messageToSend = prefixes.length > 0
        ? `${prefixes.join("\n")}\n${body.message!}`
        : body.message!;
      logBridgeEvent("bridge.openclaw.forwarded", logContext);
      const generator = deps.openclawClient.sendMessage(
        body.userId!,
        messageToSend,
      );
      let fullResponse = "";
      for await (const chunk of generator) {
        fullResponse += chunk;
        if (deliveryMode === "callback") {
          await deps.callbackSender.send(body.connectionId!, {
            type: "stream_chunk",
            content: chunk,
            conversationId: undefined,
          });
        }
      }
      if (deliveryMode === "callback") {
        await deps.callbackSender.send(body.connectionId!, {
          type: "stream_end",
        });
      }
      if (body.channel === "telegram") {
        logTelegramContentQuality(fullResponse);
      }

      const latency = Date.now() - msgStart;
      const costEstimate = buildToolCostEstimate(body, logContext, runtimeLabel, latency);
      await saveToolCostEstimate(costStore, body, logContext, costEstimate);
      void publishMessageMetrics({
        latency,
        responseLength: fullResponse.length,
        channel: deps.channel,
      });

      if (!firstResponseSent) {
        firstResponseSent = true;
        void publishFirstResponseTime(Date.now() - deps.processStartTime, deps.channel);
      }

      await persistMessagePair(
        deliveryMode,
        logContext,
        deliveryType,
        body,
        fullResponse,
      );

      logBridgeEvent("bridge.delivery.success", {
        ...logContext,
        deliveryType,
        source: "openclaw",
      });
      void publishCountMetric("DeliverySuccess", {
        channel: body.channel!,
        runtime: runtimeLabel,
        deliveryType,
      });
      return {
        message: fullResponse,
        source: "openclaw",
      };
    } catch (err) {
      if (deliveryMode === "callback") {
        await deps.callbackSender.send(body.connectionId!, {
          type: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        }).catch(() => {});
      }
      logBridgeEvent("bridge.delivery.failure", {
        ...logContext,
        deliveryType,
        error: err instanceof Error ? err.message : String(err),
      }, "error");
      void publishCountMetric("DeliveryFailure", {
        channel: body.channel!,
        runtime: runtimeLabel,
        deliveryType,
      });
      throw err;
    }
  }

  if (deps.agentCoreHttpEnabled) {
    let activeAgentCoreInvocations = 0;
    let agentCorePingStatus: "Healthy" | "HealthyBusy" = "Healthy";
    let agentCorePingStatusUpdatedAt = Math.floor(Date.now() / 1000);
    const agentCoreCallbackDeliveryEnabled =
      process.env.AGENTCORE_HTTP_DELIVERY_MODE === "callback" ||
      process.env.AGENTCORE_ASYNC_CALLBACK_DELIVERY === "true";
    const updateAgentCorePingStatus = (nextStatus: "Healthy" | "HealthyBusy"): void => {
      if (agentCorePingStatus === nextStatus) return;
      agentCorePingStatus = nextStatus;
      agentCorePingStatusUpdatedAt = Math.floor(Date.now() / 1000);
    };
    const finishAgentCoreInvocation = (): void => {
      activeAgentCoreInvocations = Math.max(0, activeAgentCoreInvocations - 1);
      if (activeAgentCoreInvocations === 0) {
        updateAgentCorePingStatus("Healthy");
      }
    };

    app.get("/ping", (_req, res) => {
      res.json({
        status: agentCorePingStatus,
        time_of_last_update: agentCorePingStatusUpdatedAt,
      });
    });

    app.post("/invocations", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
      const body = parseInvocationBody(req.body);

      if (!body.userId || !body.message || !body.channel || !body.connectionId) {
        logBridgeEvent("agentcore.invocation.invalid", {
          contentType: req.headers["content-type"] ?? "unknown",
          rawBodyType: Buffer.isBuffer(req.body) ? "buffer" : typeof req.body,
          rawBodyLength: Buffer.isBuffer(req.body)
            ? req.body.length
            : typeof req.body === "string"
              ? req.body.length
              : 0,
          parsedKeys: Object.keys(body),
        }, "error");
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      deps.lifecycle.updateLastActivity();
      activeAgentCoreInvocations += 1;
      updateAgentCorePingStatus("HealthyBusy");

      if (agentCoreCallbackDeliveryEnabled && body.callbackUrl) {
        logBridgeEvent("agentcore.invocation.callback_delivery.accepted", {
          ...buildBridgeLogContext(body),
          deliveryMode: "callback",
        });
        res.status(202).json({
          status: "processing",
          source: "agentcore-callback",
        });

        void (async () => {
          try {
            await processAcceptedMessage(body, "callback");
          } catch {
            // processAcceptedMessage already emits a controlled callback error and failure log.
          } finally {
            finishAgentCoreInvocation();
          }
        })();
        return;
      }

      try {
        const result = await processAcceptedMessage(body, "response");
        res.json(
          result.handoffRuntimeClass
            ? {
                source: result.source,
                handoffRuntimeClass: result.handoffRuntimeClass,
                handoffMessage: result.handoffMessage,
                clearToolAffinity: result.clearToolAffinity,
              }
            : {
                content: result.message,
                source: result.source,
              },
        );
      } catch {
        res.status(500).json({
          error: "AgentCore runtime failed to process the request",
        });
      } finally {
        finishAgentCoreInvocation();
      }
    });
  }

  app.use(express.json({
    type: ["application/json", "application/*+json", "application/octet-stream", "text/plain"],
  }));

  app.use(createAuthMiddleware(deps.authToken));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/message", (req, res) => {
    const body = req.body as Partial<BridgeMessageRequest>;

    if (!body.userId || !body.message || !body.channel || !body.connectionId || !body.callbackUrl) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    deps.lifecycle.updateLastActivity();

    // Respond immediately, process asynchronously
    res.status(202).json({ status: "processing" });

    // Fire-and-forget async processing
    void (async () => {
      await processAcceptedMessage(body, "callback").catch(() => {});
    })();
  });

  app.get("/status", (_req, res) => {
    res.json({
      status: "running",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      lastActivity: deps.lifecycle.lastActivityTime.toISOString(),
    });
  });

  app.post("/shutdown", (_req, res) => {
    res.json({ status: "shutting_down" });
    void deps.lifecycle.gracefulShutdown();
  });

  return app;
}
