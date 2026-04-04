import express from "express";
import { createAuthMiddleware } from "./auth-middleware.js";
import {
  publishCountMetric,
  publishMessageMetrics,
  publishFirstResponseTime,
} from "./metrics.js";
import {
  maybeHandleCustomGmailRequest,
  type GmailTelemetryEvent,
} from "./gmail-tool.js";
import type {
  BridgeMessageRequest,
  ServerMessage,
  Channel,
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
  onMessageComplete?: (userId: string, userMsg: string, assistantMsg: string, channel: Channel) => Promise<void>;
  getAndClearHistoryPrefix?: () => string;
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

  return `[System: Operate in headers-first safe mode to control Gmail and browser token usage. Inspect at most ${budget.maxMessages} items per step. Prefer sender, subject, date, and snippet previews truncated to ${budget.maxSnippetChars} characters. ${bodyAccessInstruction} If body access is needed, read at most ${budget.maxBodyChars} characters from one item at a time and summarize incrementally before reading more.]`;
}

export function createApp(deps: BridgeDeps): express.Express {
  const app = express();
  let firstResponseSent = false;

  app.use(express.json());
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
      const msgStart = Date.now();
      const logContext = buildBridgeLogContext(body);
      const deliveryType = resolveDeliveryType(body.channel);
      const gmailTelemetry = (event: GmailTelemetryEvent) => {
        switch (event.event) {
          case "matched":
            logBridgeEvent("bridge.gmail.matched", logContext);
            void publishCountMetric("GmailToolMatched", {
              channel: body.channel!,
              runtime: "fargate",
            });
            return;
          case "queryBuilt":
            logBridgeEvent("bridge.gmail.query.built", {
              ...logContext,
              sanitizedQuery: event.sanitizedQuery,
              isUnread: event.isUnread,
              dateRange: event.dateRange,
              keywordCount: event.keywordCount,
            });
            return;
          case "result":
            logBridgeEvent("bridge.gmail.query.result", {
              ...logContext,
              sanitizedQuery: event.sanitizedQuery,
              outcome: event.outcome,
              isUnread: event.isUnread,
              dateRange: event.dateRange,
              keywordCount: event.keywordCount,
              matchedCount: event.matchedCount,
              inspectedCount: event.inspectedCount,
            });
            void publishCountMetric(
              event.outcome === "success" ? "GmailToolSuccess" : "GmailToolNoResults",
              {
                channel: body.channel!,
                runtime: "fargate",
              },
            );
            return;
          case "failure":
            logBridgeEvent("bridge.gmail.query.failure", {
              ...logContext,
              sanitizedQuery: event.sanitizedQuery,
              reason: event.reason,
              isUnread: event.isUnread,
              dateRange: event.dateRange,
              keywordCount: event.keywordCount,
            }, "error");
            void publishCountMetric("GmailToolFailure", {
              channel: body.channel!,
              runtime: "fargate",
            });
        }
      };

      logBridgeEvent("bridge.message.accepted", logContext);

      try {
        const gmailResponse = await maybeHandleCustomGmailRequest({
          message: body.message!,
          runtimeClass: body.runtimeClass,
          emailTokenBudget: body.emailTokenBudget,
          onTelemetry: gmailTelemetry,
        });
        if (gmailResponse !== undefined) {
          await deps.callbackSender.send(body.connectionId!, {
            type: "stream_chunk",
            content: gmailResponse,
            conversationId: undefined,
          });
          await deps.callbackSender.send(body.connectionId!, {
            type: "stream_end",
          });

          const latency = Date.now() - msgStart;
          void publishMessageMetrics({
            latency,
            responseLength: gmailResponse.length,
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
              gmailResponse,
              body.channel! as "web" | "telegram",
            ).catch(() => {});
          }

          logBridgeEvent("bridge.delivery.success", {
            ...logContext,
            deliveryType,
            source: "gmail-tool",
          });
          void publishCountMetric("DeliverySuccess", {
            channel: body.channel!,
            runtime: "fargate",
            deliveryType,
          });
          return;
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
          await deps.callbackSender.send(body.connectionId!, {
            type: "stream_chunk",
            content: chunk,
            conversationId: undefined,
          });
        }
        await deps.callbackSender.send(body.connectionId!, {
          type: "stream_end",
        });

        // Publish message metrics
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

        // Save conversation to DynamoDB
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
          runtime: "fargate",
          deliveryType,
        });
      } catch (err) {
        await deps.callbackSender.send(body.connectionId!, {
          type: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        }).catch(() => {});
        logBridgeEvent("bridge.delivery.failure", {
          ...logContext,
          deliveryType,
          error: err instanceof Error ? err.message : String(err),
        }, "error");
        void publishCountMetric("DeliveryFailure", {
          channel: body.channel!,
          runtime: "fargate",
          deliveryType,
        });
      }
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
