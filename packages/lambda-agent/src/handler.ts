import type {
  LambdaAgentEvent,
  LambdaAgentResponse,
  ServerMessage,
} from "./types.js";
import {
  buildRuntimeSessionId,
  resolveProviderConfig,
  type ResolvedRuntimeConfig,
} from "@serverless-openclaw/shared";
import { initConfig } from "./config-init.js";
import { SessionSync } from "./session-sync.js";
import { SessionLock } from "./session-lock.js";
import { resolveSecrets } from "./secrets.js";
import { runAgent } from "./agent-runner.js";
import { publishLambdaDeliveryMetric } from "./metrics.js";
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
    /(?:확인|읽|열|검색|보내).*(?:지메일|이메일|받은편지함)/,
    /(?:지메일|이메일|받은편지함).*(?:확인|읽|열|검색|보내)/,
    /\buse\b.*\btool\b/i,
    /\btool\b.*\b(use|run)\b/i,
    /도구.*(?:사용|실행)/,
    /(?:사용|실행).*도구/,
  ].some((pattern) => pattern.test(message));
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
    return `이 요청은 Gmail/도구 확인이 필요한 것으로 보여요. 현재 메시지는 빠른 Lambda 채팅 경로로 들어왔고, 실제 조회는 ${provider} 도구 런타임에서 처리해야 합니다. 지금 답변에서 접근 불가라고 단정하지 않고, 라우팅 개선 대상으로 기록해둘게요.`;
  }

  return `This looks like a Gmail/tool lookup request. The current Lambda path is the fast chat runtime, while ${provider} owns delegated tool execution. I will not claim the assistant cannot access Gmail; this should be handled by the tool runtime path.`;
}

function buildAssistantContextPrompt(event: LambdaAgentEvent): string | undefined {
  const context = event.assistantContext;
  if (!context) return undefined;

  return [
    `AssistantRuntimeContext v${context.version}: current route=${context.runtime.runtimeClass}/${context.runtime.routeDecision ?? "unknown"}.`,
    `Tool runtime provider=${context.runtime.toolRuntimeProvider ?? "unknown"}, fallback=${context.runtime.fallbackProvider ?? "unknown"}, activeToolAffinity=${context.toolAffinity?.active === true}.`,
    `Gmail capability=${context.capabilities.gmail.status}, executionRuntime=${context.capabilities.gmail.executionRuntime}, safety=${context.capabilities.gmail.safetyMode}.`,
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
    `Inspect at most ${budget.maxMessages} messages per step.`,
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
    }
    return {
      success: false,
      error: "Session is already being processed",
    };
  }

  const configInit = await ensureInitialized();
  const runtimeConfig = configInit.runtimeConfig;
  const sessionId = buildRuntimeSessionId(runtimeConfig, event.channel, event.sessionId);
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

    return {
      success: true,
      payloads,
      durationMs: Date.now() - startTime,
      provider: runtimeConfig.openclawProvider,
      model: event.model ?? runtimeConfig.defaultModel,
    };
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
