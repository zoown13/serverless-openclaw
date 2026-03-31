import { createRequire } from "node:module";

// Cache the OpenClaw module across invocations (warm start optimization)
let cachedRunEmbeddedPiAgent: ((params: Record<string, unknown>) => Promise<unknown>) | null = null;

async function loadRunEmbeddedPiAgent(): Promise<(params: Record<string, unknown>) => Promise<unknown>> {
  if (cachedRunEmbeddedPiAgent) return cachedRunEmbeddedPiAgent;

  const req = createRequire(__filename);
  const mainPath = req.resolve("openclaw");
  const extensionApiPath = mainPath.replace(/index\.js$/, "extensionAPI.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(`file://${extensionApiPath}`);
  cachedRunEmbeddedPiAgent = mod.runEmbeddedPiAgent;
  return cachedRunEmbeddedPiAgent!;
}

/**
 * Wrapper around OpenClaw's runEmbeddedPiAgent().
 *
 * Isolates the dynamic import so the rest of the codebase can be tested
 * without requiring the full OpenClaw package.
 */

interface RunAgentParams {
  sessionId: string;
  sessionFile: string;
  workspaceDir: string;
  message: string;
  config?: Record<string, unknown>;
  model?: string;
  provider?: string;
  api?: string;
  disableTools?: boolean;
  disableMessageTool?: boolean;
  channel: "web" | "telegram";
  extraSystemPrompt?: string;
  onPartialReply?: (delta: string) => void;
}

interface AgentResult {
  payloads?: Array<{ text?: string; mediaUrl?: string; isError?: boolean }>;
  meta: {
    durationMs: number;
    agentMeta: {
      provider?: string;
      model?: string;
    };
    aborted?: boolean;
    error?: { kind: string; message: string };
  };
}

/**
 * Run the OpenClaw agent via dynamic import of extensionAPI.
 *
 * Uses dynamic import to:
 * 1. Avoid bundling OpenClaw at compile time
 * 2. Allow mocking in tests
 * 3. Defer the heavy import to runtime
 */
export async function runAgent(params: RunAgentParams): Promise<AgentResult> {
  const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();
  const channel = params.channel === "telegram" ? "web" : params.channel;
  const requestedModel = params.model ?? "claude-sonnet-4-20250514";
  const model = params.provider && requestedModel.startsWith(`${params.provider}/`)
    ? requestedModel.slice(params.provider.length + 1)
    : requestedModel;

  const callParams: Record<string, unknown> = {
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    prompt: params.message,
    provider: params.provider ?? "anthropic",
    model,
    disableTools: params.disableTools ?? false,
    disableMessageTool: params.disableMessageTool ?? false,
    messageChannel: "webchat",
    channel,
    senderIsOwner: true,
    timeoutMs: 10 * 60 * 1000, // 10 minutes
    runId: `lambda-${params.sessionId}-${Date.now()}`,
    onPartialReply: params.onPartialReply
      ? (text: string) => params.onPartialReply!(text)
      : undefined,
  };

  if (params.config) {
    callParams.config = params.config;
  }
  if (params.api) {
    callParams.api = params.api;
  }
  if (params.extraSystemPrompt) {
    callParams.extraSystemPrompt = params.extraSystemPrompt;
  }

  const result = await runEmbeddedPiAgent(callParams);

  return result as AgentResult;
}
