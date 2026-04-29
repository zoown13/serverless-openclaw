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
import type {
  BridgeMessageRequest,
  ServerMessage,
  Channel,
  EmailTokenBudgetPolicy,
} from "@serverless-openclaw/shared";

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

  return `[System: Operate in headers-first safe mode to control Gmail and browser token usage. Inspect at most ${budget.maxMessages} items per step. Prefer sender, subject, date, and snippet previews truncated to ${budget.maxSnippetChars} characters. ${bodyAccessInstruction} If the user clearly identifies one Gmail result, open only that single message body. Never inspect attachments in this runtime. If body access is needed, read at most ${budget.maxBodyChars} characters from one item at a time and summarize incrementally before reading more.]`;
}

function defaultEmailTokenBudget(): EmailTokenBudgetPolicy {
  return {
    mode: "headers-first",
    maxMessages: 5,
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
  }
}

export function createApp(deps: BridgeDeps): express.Express {
  const app = express();
  let firstResponseSent = false;
  const runtimeLabel = deps.runtimeLabel ?? "fargate";

  async function processAcceptedMessage(
    body: Partial<BridgeMessageRequest>,
    deliveryMode: "callback" | "response",
  ): Promise<ProcessedMessageResult> {
    const msgStart = Date.now();
    const logContext = buildBridgeLogContext(body);
    const deliveryType = resolveDeliveryType(body.channel);
    logBridgeEvent("bridge.message.accepted", logContext);

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

          const latency = Date.now() - msgStart;
          void publishMessageMetrics({
            latency,
            responseLength: gmailResponse.message.length,
            channel: deps.channel,
          });

          if (!firstResponseSent) {
            firstResponseSent = true;
            void publishFirstResponseTime(Date.now() - deps.processStartTime, deps.channel);
          }

          if (deps.onMessageComplete) {
            await deps.onMessageComplete(
              body.userId!,
              body.message!,
              gmailResponse.message,
              body.channel! as "web" | "telegram",
            ).catch(() => {});
          }

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

        body.message = gmailResponse.message;
      }

      const prefixes: string[] = [];
      const historyPrefix = deps.getAndClearHistoryPrefix?.();
      if (historyPrefix) {
        prefixes.push(historyPrefix.trimEnd());
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

      const latency = Date.now() - msgStart;
      void publishMessageMetrics({
        latency,
        responseLength: fullResponse.length,
        channel: deps.channel,
      });

      if (!firstResponseSent) {
        firstResponseSent = true;
        void publishFirstResponseTime(Date.now() - deps.processStartTime, deps.channel);
      }

      if (deps.onMessageComplete && fullResponse) {
        await deps.onMessageComplete(
          body.userId!,
          body.message!,
          fullResponse,
          body.channel! as "web" | "telegram",
        ).catch(() => {});
      }

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
    const updateAgentCorePingStatus = (nextStatus: "Healthy" | "HealthyBusy"): void => {
      if (agentCorePingStatus === nextStatus) return;
      agentCorePingStatus = nextStatus;
      agentCorePingStatusUpdatedAt = Math.floor(Date.now() / 1000);
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

      try {
        const result = await processAcceptedMessage(body, "response");
        res.json({
          content: result.message,
          source: result.source,
        });
      } catch {
        res.status(500).json({
          error: "AgentCore runtime failed to process the request",
        });
      } finally {
        activeAgentCoreInvocations = Math.max(0, activeAgentCoreInvocations - 1);
        if (activeAgentCoreInvocations === 0) {
          updateAgentCorePingStatus("Healthy");
        }
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
