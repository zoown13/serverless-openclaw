import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LambdaAgentEvent, LambdaAgentResponse } from "../src/types.js";

// Use vi.hoisted to ensure mock references are stable across vi.resetModules()
const {
  mockInitConfig,
  mockDownload,
  mockUpload,
  mockResolveSecrets,
  mockRunAgent,
  mockRunDirectBedrockChat,
  mockAcquire,
  mockRelease,
  mockPublishLambdaDeliveryMetric,
} = vi.hoisted(() => ({
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
        paymentScanMessages: 25,
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
  mockRunDirectBedrockChat: vi.fn(),
  mockAcquire: vi.fn().mockResolvedValue(true),
  mockRelease: vi.fn().mockResolvedValue(undefined),
  mockPublishLambdaDeliveryMetric: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../src/direct-bedrock-chat.js", () => ({
  runDirectBedrockChat: (...args: unknown[]) => mockRunDirectBedrockChat(...args),
}));

vi.mock("../src/session-lock.js", () => ({
  SessionLock: vi.fn().mockImplementation(() => ({
    acquire: mockAcquire,
    release: mockRelease,
  })),
}));

vi.mock("../src/metrics.js", () => ({
  publishLambdaDeliveryMetric: (...args: unknown[]) => mockPublishLambdaDeliveryMetric(...args),
}));

describe("handler", () => {
  let originalBucket: string | undefined;
  let originalProvider: string | undefined;
  let originalAnthropicPath: string | undefined;
  let originalTelegramTokenPath: string | undefined;
  let originalDirectBedrockChat: string | undefined;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mockInitConfig.mockClear();
    mockDownload.mockClear();
    mockUpload.mockClear();
    mockResolveSecrets.mockClear();
    mockRunAgent.mockClear();
    mockRunDirectBedrockChat.mockClear();
    mockAcquire.mockClear();
    mockRelease.mockClear();
    mockPublishLambdaDeliveryMetric.mockClear();
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
    originalDirectBedrockChat = process.env.LAMBDA_DIRECT_BEDROCK_CHAT;
    process.env.SESSION_BUCKET = "test-session-bucket";
    process.env.AI_PROVIDER = "anthropic";
    delete process.env.SSM_ANTHROPIC_API_KEY;
    delete process.env.SSM_TELEGRAM_BOT_TOKEN;
    delete process.env.LAMBDA_DIRECT_BEDROCK_CHAT;

    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "Hello from agent!" }],
      meta: { durationMs: 1000, agentMeta: { provider: "anthropic", model: "claude-sonnet-4-20250514" } },
    });
    mockRunDirectBedrockChat.mockResolvedValue({
      text: "리눅스에서 파일을 찾을 때는 find 명령어를 쓰면 됩니다.",
      usage: { inputTokens: 10, outputTokens: 20 },
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

    if (originalDirectBedrockChat !== undefined) {
      process.env.LAMBDA_DIRECT_BEDROCK_CHAT = originalDirectBedrockChat;
    } else {
      delete process.env.LAMBDA_DIRECT_BEDROCK_CHAT;
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
      traceId: "trace-456",
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
          paymentScanMessages: 25,
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
          paymentScanMessages: 25,
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
        extraSystemPrompt: expect.stringContaining("Show at most 5 detailed Gmail messages"),
      }),
    );
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining("Do not read full message bodies"),
      }),
    );
  });

  it("should inject AssistantRuntimeContext into the Lambda system prompt", async () => {
    const handler = await loadHandler();
    await handler(createEvent({
      message: "hello",
      assistantContext: {
        version: 1,
        userId: "user-123",
        channel: "telegram",
        sessionId: "session-user-123:chat",
        traceId: "trace-ctx",
        generatedAt: "2026-05-04T00:00:00.000Z",
        runtime: {
          agentRuntime: "both",
          runtimeClass: "chat-only",
          routeDecision: "lambda",
          lambdaRole: "chat-only-fast-path",
          toolRuntimeProvider: "agentcore",
          fallbackProvider: "fargate",
        },
        capabilities: {
          tools: {
            available: true,
            executionRuntime: "agentcore",
            note: "Tool tasks are delegated.",
          },
          gmail: {
            status: "available_via_tool_runtime",
            executionRuntime: "agentcore",
            safetyMode: "headers-first",
          },
        },
        toolAffinity: {
          active: false,
          provider: "agentcore",
          fallbackProvider: "fargate",
        },
        guidance: {
          selfAwareness: "The assistant has delegated Gmail capability.",
          lambda: "Do not claim Gmail is impossible.",
          toolRuntime: "Tool runtime owns Gmail tasks.",
        },
      },
    }));

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining("AssistantRuntimeContext v1"),
      }),
    );
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining("available_via_tool_runtime"),
      }),
    );
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining("Payment history"),
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"event\":\"lambda.assistant_context.loaded\""),
    );
  });

  it("should preserve delegated Gmail payment capability on Lambda misroutes", async () => {
    process.env.SSM_TELEGRAM_BOT_TOKEN = "/serverless-openclaw/secrets/telegram-bot-token";
    mockResolveSecrets.mockResolvedValue(
      new Map([
        ["/serverless-openclaw/secrets/anthropic-api-key", "test-api-key"],
        ["/serverless-openclaw/secrets/telegram-bot-token", "telegram-token"],
      ]),
    );

    const handler = await loadHandler();
    const result = await handler(createEvent({
      message: "결제 이력 확인할 수 있어?",
      channel: "telegram",
      connectionId: undefined,
      callbackUrl: undefined,
      telegramChatId: "8585874705",
      assistantContext: {
        version: 1,
        userId: "user-123",
        channel: "telegram",
        sessionId: "session-user-123:chat",
        traceId: "trace-payment-capability",
        generatedAt: "2026-05-04T00:00:00.000Z",
        runtime: {
          agentRuntime: "both",
          runtimeClass: "chat-only",
          routeDecision: "lambda",
          lambdaRole: "chat-only-fast-path",
          toolRuntimeProvider: "agentcore",
          fallbackProvider: "fargate",
        },
        capabilities: {
          tools: {
            available: true,
            executionRuntime: "agentcore",
            note: "Tool tasks are delegated.",
          },
          gmail: {
            status: "available_via_tool_runtime",
            executionRuntime: "agentcore",
            safetyMode: "headers-first",
          },
        },
        toolAffinity: {
          active: false,
          provider: "agentcore",
          fallbackProvider: "fargate",
        },
        guidance: {
          selfAwareness: "The assistant has delegated Gmail capability.",
          lambda: "Do not claim Gmail is impossible.",
          toolRuntime: "Tool runtime owns Gmail tasks.",
        },
      },
    })) as LambdaAgentResponse;

    expect(result.success).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("결제 이력");
    expect(result.payloads?.[0]?.text).toContain("지메일");
    expect(result.payloads?.[0]?.text).toContain("agentcore");
    expect(result.payloads?.[0]?.text).not.toContain("접근 불가");
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"event\":\"lambda.tool.misroute_detected\""),
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
      expect.stringContaining("\"event\":\"lambda.delivery.telegram.success\""),
    );
    expect(mockPublishLambdaDeliveryMetric).toHaveBeenCalledWith("DeliverySuccess", {
      channel: "telegram",
      deliveryType: "telegram",
    });
  });

  it("should deliver partial replies instead of a done-only Telegram message", async () => {
    process.env.SSM_TELEGRAM_BOT_TOKEN = "/serverless-openclaw/secrets/telegram-bot-token";
    mockResolveSecrets.mockResolvedValue(
      new Map([
        ["/serverless-openclaw/secrets/anthropic-api-key", "test-api-key"],
        ["/serverless-openclaw/secrets/telegram-bot-token", "telegram-token"],
      ]),
    );
    mockRunAgent.mockImplementationOnce(async (params: unknown) => {
      (params as { onPartialReply?: (delta: string) => void }).onPartialReply?.(
        "리눅스에서 파일을 찾을 때는 find 명령어를 씁니다.",
      );
      return {
        payloads: [],
        meta: {
          durationMs: 1000,
          agentMeta: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        },
      };
    });

    const handler = await loadHandler();
    const result = await handler(
      createEvent({
        channel: "telegram",
        connectionId: undefined,
        callbackUrl: undefined,
        telegramChatId: "8585874705",
        message: "리눅스에서 파일 찾는 명령어 알려줘",
      }),
    ) as LambdaAgentResponse;

    expect(result.success).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("find 명령어");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("find 명령어");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain("✅ Done");
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"event\":\"lambda.delivery.content_quality\""),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"hasFindCommandAnswer\":true"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"hasFallbackFailureText\":false"),
    );
  });

  it("should use direct Bedrock chat for stateless Telegram how-to questions when enabled", async () => {
    process.env.AI_PROVIDER = "bedrock";
    process.env.LAMBDA_DIRECT_BEDROCK_CHAT = "true";
    process.env.SSM_TELEGRAM_BOT_TOKEN = "/serverless-openclaw/secrets/telegram-bot-token";
    mockResolveSecrets.mockResolvedValue(
      new Map([
        ["/serverless-openclaw/secrets/telegram-bot-token", "telegram-token"],
      ]),
    );
    mockInitConfig.mockResolvedValueOnce({
      configDir: "/tmp/.openclaw",
      sessionsDir: "/tmp/.openclaw/agents/default/sessions",
      config: { gateway: { mode: "local" } },
      runtimeConfig: {
        provider: "bedrock",
        openclawProvider: "amazon-bedrock",
        openclawApi: "bedrock-converse-stream",
        openclawAuth: "aws-sdk",
        defaultModel: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        capability: "chat-only",
        sessionNamespace: "bedrock-chat",
        readiness: {
          chatReady: true,
          toolRuntimeReady: false,
          gmailReady: true,
        },
        emailTokenBudget: {
          mode: "headers-first",
          maxMessages: 5,
          paymentScanMessages: 25,
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
      gmailReady: true,
      toolRuntimeReady: false,
      sessionNamespace: "bedrock-chat",
    });

    const handler = await loadHandler();
    const result = await handler(createEvent({
      channel: "telegram",
      connectionId: undefined,
      callbackUrl: undefined,
      telegramChatId: "8585874705",
      message: "리눅스에서 파일 찾는 명령어 알려줘",
    })) as LambdaAgentResponse;

    expect(result.success).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("find 명령어");
    expect(mockRunDirectBedrockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "리눅스에서 파일 찾는 명령어 알려줘",
        model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      }),
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"event\":\"lambda.direct_chat.completed\""),
    );
  });

  it("should fallback to OpenClaw when direct Bedrock chat fails", async () => {
    process.env.AI_PROVIDER = "bedrock";
    process.env.LAMBDA_DIRECT_BEDROCK_CHAT = "true";
    process.env.SSM_TELEGRAM_BOT_TOKEN = "/serverless-openclaw/secrets/telegram-bot-token";
    mockResolveSecrets.mockResolvedValue(
      new Map([
        ["/serverless-openclaw/secrets/telegram-bot-token", "telegram-token"],
      ]),
    );
    mockRunDirectBedrockChat.mockRejectedValueOnce(new Error("Bedrock throttled"));
    mockInitConfig.mockResolvedValueOnce({
      configDir: "/tmp/.openclaw",
      sessionsDir: "/tmp/.openclaw/agents/default/sessions",
      config: { gateway: { mode: "local" } },
      runtimeConfig: {
        provider: "bedrock",
        openclawProvider: "amazon-bedrock",
        openclawApi: "bedrock-converse-stream",
        openclawAuth: "aws-sdk",
        defaultModel: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        capability: "chat-only",
        sessionNamespace: "bedrock-chat",
        readiness: {
          chatReady: true,
          toolRuntimeReady: false,
          gmailReady: true,
        },
        emailTokenBudget: {
          mode: "headers-first",
          maxMessages: 5,
          paymentScanMessages: 25,
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
      gmailReady: true,
      toolRuntimeReady: false,
      sessionNamespace: "bedrock-chat",
    });

    const handler = await loadHandler();
    const result = await handler(createEvent({
      channel: "telegram",
      connectionId: undefined,
      callbackUrl: undefined,
      telegramChatId: "8585874705",
      message: "리눅스에서 파일 찾는 명령어 알려줘",
    })) as LambdaAgentResponse;

    expect(result.success).toBe(true);
    expect(mockRunAgent).toHaveBeenCalled();
    expect(mockDownload).toHaveBeenCalledWith(
      "user-123",
      "bedrock-chat:telegram:session-456",
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"event\":\"lambda.direct_chat.fallback\""),
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
      expect.stringContaining("\"event\":\"lambda.delivery.telegram.failure\""),
    );
    expect(mockPublishLambdaDeliveryMetric).toHaveBeenCalledWith("DeliveryFailure", {
      channel: "telegram",
      deliveryType: "telegram",
    });
  });

  it("should log request acceptance with traceId", async () => {
    const handler = await loadHandler();

    await handler(createEvent());

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"event\":\"lambda.request.accepted\""),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("\"traceId\":\"trace-456\""),
    );
  });
});
