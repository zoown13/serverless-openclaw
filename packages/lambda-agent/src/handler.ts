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
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

// Resolved once at cold start
const providerConfig = resolveProviderConfig();

// Initialized once per Lambda cold start
let initializedConfig: Awaited<ReturnType<typeof initConfig>> | undefined;

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
): Promise<void> {
  const apigw = new ApiGatewayManagementApiClient({ endpoint: callbackUrl });
  try {
    await apigw.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(msg),
      }),
    );
  } catch (err: unknown) {
    // GoneException = client disconnected, not an error
    if (err instanceof Error && err.name === "GoneException") return;
    console.error("[push] Failed to push to connection:", err);
  }
}

function normalizeTelegramChatId(chatId?: string): string | undefined {
  if (!chatId) return undefined;
  return chatId.startsWith("telegram:") ? chatId.slice(9) : chatId;
}

async function pushToTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("[telegram] failed to deliver message", {
        chatId,
        status: response.status,
        body,
        textLength: text.length,
      });
      return;
    }

    console.info("[telegram] delivered message", {
      chatId,
      status: response.status,
      textLength: text.length,
    });
  } catch {
    // Telegram failures should not block agent response.
    console.error("[telegram] failed to deliver message", {
      chatId,
      error: "network-error",
      textLength: text.length,
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
  },
): Promise<void> {
  if (options.canPush && options.callbackUrl && options.connectionId) {
    for (const payload of payloads ?? []) {
      if (payload.text) {
        await pushToConnection(options.callbackUrl, options.connectionId, {
          type: "message",
          content: payload.text,
        });
      }
    }
    return;
  }

  if (options.isTelegram && options.telegramBotToken && options.telegramChatId) {
    for (const payload of payloads ?? []) {
      if (payload.text) {
        await pushToTelegram(options.telegramBotToken, options.telegramChatId, payload.text);
      }
    }
  }
}

async function pushIdleStatus(
  canPush: boolean,
  callbackUrl?: string,
  connectionId?: string,
): Promise<void> {
  if (!canPush || !callbackUrl || !connectionId) return;

  await pushToConnection(callbackUrl, connectionId, {
    type: "status",
    status: "Idle",
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

  // Push "running" status before starting
  if (canPush) {
    await pushToConnection(event.callbackUrl!, event.connectionId!, {
      type: "status",
      status: "running",
    });
  } else if (isTelegram && telegramBotTokenPath) {
    const secrets = await resolveSecrets([telegramBotTokenPath]);
    telegramBotToken = secrets.get(telegramBotTokenPath);
  }

  if (!runtimeConfig.readiness.toolRuntimeReady && isToolRequest(event.message)) {
    const payloads = [{ text: buildToolUnavailableMessage(runtimeConfig) }];
    await pushPayloads(payloads, {
      canPush,
      callbackUrl: event.callbackUrl,
      connectionId: event.connectionId,
      isTelegram,
      telegramBotToken,
      telegramChatId,
    });
    await pushIdleStatus(canPush, event.callbackUrl, event.connectionId);

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
        extraSystemPrompt:
          event.channel === "telegram" || !runtimeConfig.readiness.toolRuntimeReady
            ? "You are replying inside a serverless runtime. Respond with plain text only. Do not output function_calls blocks, XML tool tags, or shell commands. Do not ask the user to restart gateway/daemon/processes. If execution capabilities are unavailable, explain briefly and continue with a normal assistant answer. Do not claim Gmail or other tools are connected unless they are explicitly available."
          : undefined,
      });

      // Always upload session after run (even if no payloads)
      await sync.upload(event.userId, sessionId);

      await pushPayloads(result.payloads, {
        canPush,
        callbackUrl: event.callbackUrl,
        connectionId: event.connectionId,
        isTelegram,
        telegramBotToken,
        telegramChatId,
      });

      if (isTelegram && telegramBotToken) {
        await pushToTelegram(telegramBotToken, telegramChatId!, "✅ Done");
      }

      await pushIdleStatus(canPush, event.callbackUrl, event.connectionId);

      return {
        success: true,
        payloads: result.payloads,
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
        });
      } else if (isTelegram && telegramBotToken) {
        await pushToTelegram(telegramBotToken, telegramChatId!, `❌ ${errorMessage}`);
      }

      await pushIdleStatus(canPush, event.callbackUrl, event.connectionId);

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
