import type {
  LambdaAgentEvent,
  LambdaAgentResponse,
  ServerMessage,
} from "./types.js";
import { resolveProviderConfig } from "@serverless-openclaw/shared";
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
let initialized = false;

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
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // Telegram failures should not block agent response.
  }
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

  const canPush = event.channel === "web" && !!(event.callbackUrl && event.connectionId);
  const telegramBotTokenPath = process.env.SSM_TELEGRAM_BOT_TOKEN;
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

  // Cold start initialization
  if (!initialized) {
    let apiKey: string | undefined;

    // When using Anthropic, resolve the API key from SSM (existing behavior).
    // When using Bedrock, skip SSM — authentication is via IAM role credentials.
    if (providerConfig.provider === "anthropic") {
      const ssmKeyPath =
        process.env.SSM_ANTHROPIC_API_KEY ??
        "/serverless-openclaw/secrets/anthropic-api-key";

      const secrets = await resolveSecrets([ssmKeyPath]);
      apiKey = secrets.get(ssmKeyPath);
    }

    await initConfig({
      anthropicApiKey: apiKey,
      provider: providerConfig.provider,
      model: providerConfig.defaultModel,
      awsRegion: process.env.AWS_REGION,
    });
    initialized = true;
  }

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

  const sync = new SessionSync(bucket, "/tmp/.openclaw");
  const sessionFile = await sync.download(event.userId, event.sessionId);

  try {
    try {
      const result = await runAgent({
        sessionId: event.sessionId,
        sessionFile,
        workspaceDir: "/tmp/workspace",
        message: event.message,
        model: event.model ?? providerConfig.defaultModel,
        provider: providerConfig.openclawProvider,
        api: providerConfig.openclawApi,
        // Telegram channel plugin is not initialized in embedded Lambda runtime.
        // Force-disable tools for Telegram so model output is returned directly.
        disableTools: event.disableTools ?? (event.channel === "telegram"),
        disableMessageTool: event.channel === "telegram",
        channel: event.channel,
        extraSystemPrompt: event.channel === "telegram"
          ? "You are replying inside Telegram in a serverless runtime. Respond with plain text only. Do not output function_calls blocks, XML tool tags, or shell commands. Do not ask the user to restart gateway/daemon/processes. If execution capabilities are unavailable, explain briefly and continue with a normal assistant answer."
          : undefined,
      });

      // Always upload session after run (even if no payloads)
      await sync.upload(event.userId, event.sessionId);

      // Push response payloads
      if (canPush && result.payloads) {
        for (const payload of result.payloads) {
          if (payload.text) {
            await pushToConnection(event.callbackUrl!, event.connectionId!, {
              type: "message",
              content: payload.text,
            });
          }
        }
      } else if (isTelegram && telegramBotToken && result.payloads?.length) {
        for (const payload of result.payloads) {
          if (payload.text) {
            await pushToTelegram(telegramBotToken, telegramChatId!, payload.text);
          }
        }
      }

      if (isTelegram && telegramBotToken) {
        await pushToTelegram(telegramBotToken, telegramChatId!, "✅ Done");
      }

      // Push "Idle" status
      if (canPush) {
        await pushToConnection(event.callbackUrl!, event.connectionId!, {
          type: "status",
          status: "Idle",
        });
      }

      return {
        success: true,
        payloads: result.payloads,
        durationMs: Date.now() - startTime,
        provider: result.meta.agentMeta.provider,
        model: result.meta.agentMeta.model,
      };
    } catch (err: unknown) {
      // Upload session even on error (partial transcript may be valuable)
      await sync.upload(event.userId, event.sessionId);

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

      if (canPush) {
        await pushToConnection(event.callbackUrl!, event.connectionId!, {
          type: "status",
          status: "Idle",
        });
      }

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
