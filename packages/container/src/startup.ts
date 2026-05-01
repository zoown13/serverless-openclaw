import { BRIDGE_PORT } from "@serverless-openclaw/shared";
import { createApp } from "./bridge.js";
import { CallbackSender } from "./callback-sender.js";
import { OpenClawClient } from "./openclaw-client.js";
import { LifecycleManager } from "./lifecycle.js";
import { consumePendingMessages } from "./pending-messages.js";
import {
  isGmailReady,
  maybeHandleCustomGmailRequest,
  type ToolEvent,
} from "./gmail-tool.js";
import { restoreFromS3 } from "./s3-sync.js";
import { discoverPublicIp } from "./discover-public-ip.js";
import {
  saveMessagePair,
  loadRecentHistory,
  formatHistoryContext,
} from "./conversation-store.js";
import type {
  PendingMessageItem,
  Channel,
  EmailTokenBudgetPolicy,
} from "@serverless-openclaw/shared";
import {
  publishCountMetric,
  publishStartupMetrics,
  publishMessageMetrics,
} from "./metrics.js";
import { waitForPort, notifyTelegram, getTelegramChatId } from "./utils.js";

type Send = (command: unknown) => Promise<unknown>;

export interface StartContainerOptions {
  env: {
    BRIDGE_AUTH_TOKEN?: string;
    OPENCLAW_GATEWAY_TOKEN: string;
    USER_ID: string;
    DATA_BUCKET: string;
    CALLBACK_URL?: string;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_CHAT_ID?: string;
    CONTAINER_RUNTIME_MODE?: string;
    AGENTCORE_HTTP_ENABLED?: string;
  };
  taskMetadata: { taskArn: string; cluster: string };
  dynamoSend: Send;
  ecsSend: Send;
  ec2Send: Send;
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

export async function startContainer(opts: StartContainerOptions): Promise<void> {
  const t0 = Date.now();
  const { env, taskMetadata, dynamoSend, ecsSend, ec2Send } = opts;
  const { taskArn, cluster } = taskMetadata;
  const userId = env.USER_ID;
  const agentCoreMode =
    env.CONTAINER_RUNTIME_MODE === "agentcore" ||
    env.AGENTCORE_HTTP_ENABLED === "true";
  const telegramChatId = env.TELEGRAM_CHAT_ID ?? getTelegramChatId(userId);
  const channel: Channel = telegramChatId ? "telegram" : "web";
  const gatewayUrl = `ws://localhost:${18789}`;

  // Phase 1: Parallel — S3 restore and history load are independent
  const [, history] = await Promise.all([
    restoreFromS3({
      bucket: env.DATA_BUCKET,
      prefix: `workspaces/${userId}`,
      localPath: "/data/workspace",
    }),
    loadRecentHistory(dynamoSend, userId),
  ]);
  const tS3 = Date.now();

  let historyPrefix = formatHistoryContext(history);
  if (historyPrefix) {
    console.log(`Loaded ${history.length} previous messages for context`);
  }

  // Telegram startup notification (best-effort, non-blocking)
  if (telegramChatId && env.TELEGRAM_BOT_TOKEN) {
    void notifyTelegram(
      env.TELEGRAM_BOT_TOKEN,
      telegramChatId,
      "⚡ Container started. Connecting to AI engine...",
    );
  }

  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  const callbackSender = new CallbackSender(env.CALLBACK_URL ?? "", telegramBotToken);
  const lifecycle = new LifecycleManager({
    dynamoSend,
    userId,
    taskArn,
    s3Bucket: env.DATA_BUCKET,
    s3Prefix: `workspaces/${userId}`,
    workspacePath: "/data/workspace",
    taskStateEnabled: !agentCoreMode,
  });
  const openclawClientRef: { current?: OpenClawClient } = {};
  let openclawReady = false;

  const openclawClientProxy = {
    sendMessage(targetUserId: string, message: string): AsyncGenerator<string> {
      if (!openclawReady || !openclawClientRef.current) {
        throw new Error("OpenClaw runtime is still starting");
      }

      return openclawClientRef.current.sendMessage(targetUserId, message);
    },
    close(): void {
      openclawClientRef.current?.close();
    },
  };

  const createBridgeApp = () => createApp({
    authToken: env.BRIDGE_AUTH_TOKEN ?? "agentcore-runtime-disabled-token",
    openclawClient: openclawClientProxy,
    callbackSender,
    lifecycle,
    processStartTime: t0,
    channel,
    agentCoreHttpEnabled: agentCoreMode,
    runtimeLabel: agentCoreMode ? "agentcore" : "fargate",
    onMessageComplete: async (uid: string, userMsg: string, assistantMsg: string, ch: Channel) => {
      await saveMessagePair(dynamoSend, uid, userMsg, assistantMsg, ch);
    },
    getAndClearHistoryPrefix: () => {
      const prefix = historyPrefix;
      historyPrefix = "";
      return prefix;
    },
  });

  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  const startBridgeServer = (): void => {
    if (server) return;

    const app = createBridgeApp();
    server = app.listen(BRIDGE_PORT, "0.0.0.0", () => {
    console.log(`Bridge server listening on port ${BRIDGE_PORT}`);
  });
  };

  if (agentCoreMode) {
    // AgentCore invokes POST /invocations on port 8080. Start the HTTP
    // surface as soon as secrets, workspace, and Gmail state are restored so
    // tool fast-path requests can complete without waiting for OpenClaw's full
    // gateway/client startup path.
    startBridgeServer();
  }

  let tGateway = tS3;
  let tClient = tS3;

  const initializeOpenClaw = async (): Promise<void> => {
    // Phase 2: Sequential — wait for gateway, then client
    await waitForPort(18789, 120000);
    tGateway = Date.now();

    openclawClientRef.current = new OpenClawClient(gatewayUrl, env.OPENCLAW_GATEWAY_TOKEN);
    await openclawClientRef.current.waitForReady();
    openclawReady = true;
    tClient = Date.now();

    if (telegramChatId && env.TELEGRAM_BOT_TOKEN) {
      void notifyTelegram(
        env.TELEGRAM_BOT_TOKEN,
        telegramChatId,
        "✅ Ready! Processing messages...",
      );
    }
  };

  if (agentCoreMode) {
    logBridgeEvent("bridge.openclaw_fallback.starting", {
      runtime: "agentcore",
      directToolFastPathAvailable: true,
      timeoutMs: 120000,
    });
    void initializeOpenClaw()
      .then(() => {
        logBridgeEvent("bridge.openclaw_fallback.ready", {
          runtime: "agentcore",
          durationMs: tClient - tS3,
        });
      })
      .catch((err) => {
        logBridgeEvent("bridge.openclaw_fallback.unavailable", {
          runtime: "agentcore",
          directToolFastPathAvailable: true,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  } else {
    await initializeOpenClaw();
  }

  if (!agentCoreMode) {
    // Phase 3: Bridge server start. Fargate keeps the original behavior so
    // pending messages are consumed only after OpenClaw is ready.
    startBridgeServer();
  }

  let consumed = 0;

  if (!agentCoreMode) {
    // Update state to Running immediately (without IP — IP discovered in background)
    await lifecycle.updateTaskState("Running");

    // Phase 4: IP discovery — fire-and-forget (non-blocking)
    void (async () => {
      try {
        const publicIp = await discoverPublicIp(ecsSend, ec2Send, cluster, taskArn);
        console.log(`Public IP: ${publicIp ?? "not available"}`);
        if (publicIp) {
          await lifecycle.updateTaskState("Running", publicIp);
        }
      } catch (err) {
        console.warn("IP discovery failed (non-fatal):", err);
      }
    })();

    // Phase 5: Consume pending messages
    consumed = await consumePendingMessages({
      dynamoSend,
      userId,
      processMessage: async (msg: PendingMessageItem) => {
      const msgStart = new Date(msg.createdAt).getTime();
      const traceId = msg.traceId ?? `pending-${msg.SK}`;
      const deliveryType = msg.channel === "telegram" ? "telegram" : "websocket";
      const logContext = {
        traceId,
        channel: msg.channel,
        runtimeClass: msg.runtimeClass ?? "tool-enabled",
        routeDecision: msg.routeDecision ?? "fargate-new",
        messageLength: msg.message.length,
        deliveryType,
        pendingMessage: true,
      };

      logBridgeEvent("bridge.message.accepted", logContext);
      try {
        const gmailReady = await isGmailReady();
        const gmailResponse = await maybeHandleCustomGmailRequest({
          userId,
          sessionKey: msg.connectionId,
          message: msg.message,
          gmailReady,
          emailTokenBudget: msg.emailTokenBudget ?? defaultEmailTokenBudget(),
          onToolEvent: (event: ToolEvent) => {
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
                logBridgeEvent(
                  `bridge.tool.context.${event.type.replace("context", "").toLowerCase()}`,
                  {
                    ...logContext,
                    taskFamily: event.taskFamily,
                    sourceChoice: event.sourceChoice,
                    reason: event.reason,
                  },
                );
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
            }
          },
        });
        if (gmailResponse !== undefined) {
          historyPrefix = "";
          if (gmailResponse.kind === "direct") {
            await callbackSender.send(msg.connectionId, {
              type: "stream_chunk",
              content: gmailResponse.message,
            });
            await callbackSender.send(msg.connectionId, {
              type: "stream_end",
            });

            void publishMessageMetrics({
              latency: Date.now() - msgStart,
              responseLength: gmailResponse.message.length,
              channel: msg.channel,
            });

            await saveMessagePair(
              dynamoSend,
              userId,
              msg.message,
              gmailResponse.message,
              msg.channel,
            ).catch(() => {});
            logBridgeEvent("bridge.delivery.success", {
              ...logContext,
              source: gmailResponse.source,
            });
            void publishCountMetric("DeliverySuccess", {
              channel: msg.channel,
              runtime: "fargate",
              deliveryType,
            });
            void publishCountMetric("PendingMessagesDrained", {
              channel: msg.channel,
              runtime: "fargate",
            });
            return;
          }

          msg.message = gmailResponse.message;
        }

        const messageToSend = historyPrefix
          ? historyPrefix + msg.message
          : msg.message;
        historyPrefix = "";
        logBridgeEvent("bridge.openclaw.forwarded", logContext);

        const generator = openclawClientProxy.sendMessage(userId, messageToSend);
        let fullResponse = "";
        for await (const chunk of generator) {
          fullResponse += chunk;
          await callbackSender.send(msg.connectionId, {
            type: "stream_chunk",
            content: chunk,
          });
        }
        await callbackSender.send(msg.connectionId, {
          type: "stream_end",
        });

        void publishMessageMetrics({
          latency: Date.now() - msgStart,
          responseLength: fullResponse.length,
          channel: msg.channel,
        });

        if (fullResponse) {
          await saveMessagePair(dynamoSend, userId, msg.message, fullResponse, msg.channel).catch(() => {});
        }
        logBridgeEvent("bridge.delivery.success", {
          ...logContext,
          source: "openclaw",
        });
        void publishCountMetric("DeliverySuccess", {
          channel: msg.channel,
          runtime: "fargate",
          deliveryType,
        });
        void publishCountMetric("PendingMessagesDrained", {
          channel: msg.channel,
          runtime: "fargate",
        });
      } catch (err) {
        logBridgeEvent("bridge.delivery.failure", {
          ...logContext,
          error: err instanceof Error ? err.message : String(err),
        }, "error");
        void publishCountMetric("DeliveryFailure", {
          channel: msg.channel,
          runtime: "fargate",
          deliveryType,
        });
        throw err;
      }
      },
    });
  }

  if (consumed > 0) {
    console.log(`Processed ${consumed} pending message(s)`);
  }

  const tRunning = Date.now();
  console.log(`Startup complete in ${tRunning - t0}ms (S3+History: ${tS3 - t0}ms, Gateway: ${tGateway - tS3}ms, Client: ${tClient - tGateway}ms)`);

  void publishStartupMetrics({
    total: tRunning - t0,
    s3Restore: tS3 - t0,
    gatewayWait: tGateway - tS3,
    clientReady: tClient - tGateway,
    pendingMessages: consumed,
    userId,
    channel,
  });

  lifecycle.startPeriodicBackup();

  // SIGTERM handler
  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully...");
    server?.close(async () => {
      await lifecycle.gracefulShutdown();
      openclawClientRef.current?.close();
      process.exit(0);
    });
  });

}
