import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LambdaAgentEvent, LambdaAgentResponse } from "../src/types.js";

// Use vi.hoisted to ensure mock references are stable across vi.resetModules()
const { mockInitConfig, mockDownload, mockUpload, mockResolveSecrets, mockRunAgent, mockAcquire, mockRelease } = vi.hoisted(() => ({
  mockInitConfig: vi.fn().mockResolvedValue({
    configDir: "/tmp/.openclaw",
    sessionsDir: "/tmp/.openclaw/agents/default/sessions",
    config: { gateway: { mode: "local" } },
    runtimeConfig: {
      provider: "anthropic",
      openclawProvider: "anthropic",
      openclawApi: "anthropic",
      openclawAuth: "api-key",
      defaultModel: "claude-sonnet-4-20250514",
      capability: "tool-enabled",
      sessionNamespace: "anthropic-tools",
      readiness: {
        chatReady: true,
        toolRuntimeReady: true,
        gmailReady: true,
      },
      emailTokenBudget: {
        mode: "headers-first",
        maxMessages: 5,
        maxSnippetChars: 240,
        maxBodyChars: 1600,
        requireExplicitBodyAccess: true,
      },
      secretContract: {
        requiresAnthropicApiKey: true,
        supportsOpenclawAuthProfiles: true,
        supportsOpenclawOauth: true,
        supportsGoogleOauthClient: true,
      },
    },
    gmailReady: true,
    toolRuntimeReady: true,
    sessionNamespace: "anthropic-tools",
  }),
  mockDownload: vi.fn().mockResolvedValue("/tmp/.openclaw/agents/default/sessions/test.jsonl"),
  mockUpload: vi.fn().mockResolvedValue(undefined),
  mockResolveSecrets: vi.fn().mockResolvedValue(new Map([
    ["/serverless-openclaw/secrets/anthropic-api-key", "test-api-key"],
  ])),
  mockRunAgent: vi.fn(),
  mockAcquire: vi.fn().mockResolvedValue(true),
  mockRelease: vi.fn().mockResolvedValue(undefined),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("../src/config-init.js", () => ({
  initConfig: (...args: unknown[]) => mockInitConfig(...args),
}));

vi.mock("../src/session-sync.js", () => ({
  SessionSync: vi.fn().mockImplementation(() => ({
    download: mockDownload,
    upload: mockUpload,
    getLocalPath: (sid: string) => `/tmp/.openclaw/agents/default/sessions/${sid}.jsonl`,
  })),
}));

vi.mock("../src/secrets.js", () => ({
  resolveSecrets: (...args: unknown[]) => mockResolveSecrets(...args),
}));

vi.mock("../src/agent-runner.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

vi.mock("../src/session-lock.js", () => ({
  SessionLock: vi.fn().mockImplementation(() => ({
    acquire: mockAcquire,
    release: mockRelease,
  })),
}));

describe("handler", () => {
  let originalBucket: string | undefined;
  let originalProvider: string | undefined;
  let originalAnthropicPath: string | undefined;
  let originalTelegramTokenPath: string | undefined;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mockInitConfig.mockClear();
    mockDownload.mockClear();
    mockUpload.mockClear();
    mockResolveSecrets.mockClear();
    mockRunAgent.mockClear();
    mockAcquire.mockClear();
    mockRelease.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("ok"),
    });
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Set required env var
    originalBucket = process.env.SESSION_BUCKET;
    originalProvider = process.env.AI_PROVIDER;
    originalAnthropicPath = process.env.SSM_ANTHROPIC_API_KEY;
    originalTelegramTokenPath = process.env.SSM_TELEGRAM_BOT_TOKEN;
    process.env.SESSION_BUCKET = "test-session-bucket";
    process.env.AI_PROVIDER = "anthropic";
    delete process.env.SSM_ANTHROPIC_API_KEY;
    delete process.env.SSM_TELEGRAM_BOT_TOKEN;

    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "Hello from agent!" }],
      meta: { durationMs: 1000, agentMeta: { provider: "anthropic", model: "claude-sonnet-4-20250514" } },
    });
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();

    if (originalBucket !== undefined) {
      process.env.SESSION_BUCKET = originalBucket;
    } else {
      delete process.env.SESSION_BUCKET;
    }

    if (originalProvider !== undefined) {
      process.env.AI_PROVIDER = originalProvider;
    } else {
      delete process.env.AI_PROVIDER;
    }

    if (originalAnthropicPath !== undefined) {
      process.env.SSM_ANTHROPIC_API_KEY = originalAnthropicPath;
    } else {
      delete process.env.SSM_ANTHROPIC_API_KEY;
    }

    if (originalTelegramTokenPath !== undefined) {
      process.env.SSM_TELEGRAM_BOT_TOKEN = originalTelegramTokenPath;
    } else {
      delete process.env.SSM_TELEGRAM_BOT_TOKEN;
    }
  });

  async function loadHandler() {
    const mod = await import("../src/handler.js");
    return mod.handler;
  }

  function createEvent(overrides: Partial<LambdaAgentEvent> = {}): LambdaAgentEvent {
    return {
      userId: "user-123",
      sessionId: "session-456",
      message: "Hello",
      channel: "web",
      connectionId: "conn-123",
      callbackUrl: "https://cb.example.com",
      ...overrides,
    };
  }

  it("should return error when SESSION_BUCKET is not set", async () => {
    delete process.env.SESSION_BUCKET;
    const handler = await loadHandler();
    const result = await handler(createEvent()) as LambdaAgentResponse;

    expect(result.success).toBe(false);
    expect(result.error).toContain("SESSION_BUCKET");
  });

  it("should resolve secrets on first invocation", async () => {
    const handler = await loadHandler();
    await handler(createEvent());

    expect(mockResolveSecrets).toHaveBeenCalled();
  });

  it("should initialize config with resolved API key", async () => {
    const handler = await loadHandler();
    await handler(createEvent());

    expect(mockInitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        anthropicApiKey: "test-api-key",
        runtimeConfig: expect.objectContaining({
          provider: "anthropic",
        }),
      }),
    );
  });

  it("should download session from S3", async () => {
    const handler = await loadHandler();
    await handler(createEvent());

    expect(mockDownload).toHaveBeenCalledWith("user-123", "anthropic-tools:web:session-456");
  });

  it("should call agent runner with correct params", async () => {
    const handler = await loadHandler();
    await handler(createEvent({ message: "What is 2+2?" }));

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "anthropic-tools:web:session-456",
        message: "What is 2+2?",
        channel: "web",
      }),
    );
  });

  it("should upload session to S3 after agent run", async () => {
    const handler = await loadHandler();
    await handler(createEvent());

    expect(mockUpload).toHaveBeenCalledWith("user-123", "anthropic-tools:web:session-456");
  });

  it("should return agent response", async () => {
    const handler = await loadHandler();
    const result = await handler(createEvent()) as LambdaAgentResponse;

    expect(result.success).toBe(true);
    expect(result.payloads).toEqual([{ text: "Hello from agent!" }]);
  });

  it("should upload session even when agent errors", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("Agent failed"));

    const handler = await loadHandler();
    const result = await handler(createEvent()) as LambdaAgentResponse;

    expect(result.success).toBe(false);
    expect(result.error).toBe("Agent failed");
    expect(mockUpload).toHaveBeenCalledWith("user-123", "anthropic-tools:web:session-456");
  });

  it("should pass model override when provided", async () => {
    const handler = await loadHandler();
    await handler(createEvent({ model: "claude-opus-4-20250514" }));

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-4-20250514",
      }),
    );
  });

  it("should pass disableTools flag", async () => {
    const handler = await loadHandler();
    await handler(createEvent({ disableTools: true }));

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        disableTools: true,
      }),
    );
  });

  it("should not request anthropic secret when AI_PROVIDER is bedrock", async () => {
    process.env.AI_PROVIDER = "bedrock";
    mockResolveSecrets.mockResolvedValueOnce(new Map());
    mockInitConfig.mockResolvedValueOnce({
      configDir: "/tmp/.openclaw",
      sessionsDir: "/tmp/.openclaw/agents/default/sessions",
      config: { gateway: { mode: "local" } },
      runtimeConfig: {
        provider: "bedrock",
        openclawProvider: "amazon-bedrock",
        openclawApi: "bedrock-converse-stream",
        openclawAuth: "aws-sdk",
        defaultModel: "apac.anthropic.claude-sonnet-4-20250514-v1:0",
        capability: "chat-only",
        sessionNamespace: "bedrock-chat",
        readiness: {
          chatReady: true,
          toolRuntimeReady: false,
          gmailReady: false,
        },
        emailTokenBudget: {
          mode: "headers-first",
          maxMessages: 5,
          maxSnippetChars: 240,
          maxBodyChars: 1600,
          requireExplicitBodyAccess: true,
        },
        secretContract: {
          requiresAnthropicApiKey: false,
          supportsOpenclawAuthProfiles: true,
          supportsOpenclawOauth: true,
          supportsGoogleOauthClient: true,
        },
      },
      gmailReady: false,
      toolRuntimeReady: false,
      sessionNamespace: "bedrock-chat",
    });

    const handler = await loadHandler();
    await handler(createEvent());

    expect(mockResolveSecrets).not.toHaveBeenCalled();
  });

  it("should return a clear message for Gmail requests when runtime is chat-only", async () => {
    process.env.AI_PROVIDER = "bedrock";
    mockInitConfig.mockResolvedValueOnce({
      configDir: "/tmp/.openclaw",
      sessionsDir: "/tmp/.openclaw/agents/default/sessions",
      config: { gateway: { mode: "local" } },
      runtimeConfig: {
        provider: "bedrock",
        openclawProvider: "amazon-bedrock",
        openclawApi: "bedrock-converse-stream",
        openclawAuth: "aws-sdk",
        defaultModel: "apac.anthropic.claude-sonnet-4-20250514-v1:0",
        capability: "chat-only",
        sessionNamespace: "bedrock-chat",
        readiness: {
          chatReady: true,
          toolRuntimeReady: false,
          gmailReady: false,
        },
        emailTokenBudget: {
          mode: "headers-first",
          maxMessages: 5,
          maxSnippetChars: 240,
          maxBodyChars: 1600,
          requireExplicitBodyAccess: true,
        },
        secretContract: {
          requiresAnthropicApiKey: false,
          supportsOpenclawAuthProfiles: true,
          supportsOpenclawOauth: true,
          supportsGoogleOauthClient: true,
        },
      },
      gmailReady: false,
      toolRuntimeReady: false,
      sessionNamespace: "bedrock-chat",
    });

    const handler = await loadHandler();
    const result = await handler(createEvent({ message: "Please check my Gmail inbox" }));

    expect(result.success).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Gmail is not connected");
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("should fail fast when web delivery metadata is incomplete", async () => {
    const handler = await loadHandler();
    const result = await handler(
      createEvent({ callbackUrl: "https://cb", connectionId: undefined }),
    ) as LambdaAgentResponse;

    expect(result.success).toBe(false);
    expect(result.error).toBe("Web delivery requires both connectionId and callbackUrl");
  });

  it("should add Gmail token budget guidance when tool runtime is ready", async () => {
    const handler = await loadHandler();
    await handler(createEvent({ message: "Summarize my recent Gmail messages" }));

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining("Inspect at most 5 messages"),
      }),
    );
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining("Do not read full message bodies"),
      }),
    );
  });

  it("should log Telegram delivery success", async () => {
    process.env.SSM_TELEGRAM_BOT_TOKEN = "/serverless-openclaw/secrets/telegram-bot-token";
    mockResolveSecrets.mockResolvedValue(
      new Map([
        ["/serverless-openclaw/secrets/anthropic-api-key", "test-api-key"],
        ["/serverless-openclaw/secrets/telegram-bot-token", "telegram-token"],
      ]),
    );

    const handler = await loadHandler();
    const result = await handler(
      createEvent({
        channel: "telegram",
        connectionId: undefined,
        callbackUrl: undefined,
        telegramChatId: "8585874705",
      }),
    ) as LambdaAgentResponse;

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "[telegram] delivered message",
      expect.objectContaining({
        chatId: "8585874705",
        status: 200,
      }),
    );
  });

  it("should log Telegram delivery failures for non-ok responses", async () => {
    process.env.SSM_TELEGRAM_BOT_TOKEN = "/serverless-openclaw/secrets/telegram-bot-token";
    mockResolveSecrets.mockResolvedValue(
      new Map([
        ["/serverless-openclaw/secrets/anthropic-api-key", "test-api-key"],
        ["/serverless-openclaw/secrets/telegram-bot-token", "telegram-token"],
      ]),
    );
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue("Bad Request: chat not found"),
    });

    const handler = await loadHandler();
    const result = await handler(
      createEvent({
        channel: "telegram",
        connectionId: undefined,
        callbackUrl: undefined,
        telegramChatId: "8585874705",
      }),
    ) as LambdaAgentResponse;

    expect(result.success).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      "[telegram] failed to deliver message",
      expect.objectContaining({
        chatId: "8585874705",
        status: 400,
        body: "Bad Request: chat not found",
      }),
    );
  });
});
