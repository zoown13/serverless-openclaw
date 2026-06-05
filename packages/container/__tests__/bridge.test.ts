import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/bridge.js";
import type { BridgeDeps } from "../src/bridge.js";

const {
  gmailToolMock,
  publishCountMetricMock,
  isGmailReadyMock,
  recentCostLoadMock,
  recentCostSaveMock,
  awsCostLookupMock,
} = vi.hoisted(() => ({
  gmailToolMock: vi.fn(),
  publishCountMetricMock: vi.fn().mockResolvedValue(undefined),
  isGmailReadyMock: vi.fn().mockResolvedValue(true),
  recentCostLoadMock: vi.fn().mockResolvedValue(undefined),
  recentCostSaveMock: vi.fn().mockResolvedValue({
    expiresAt: "2099-01-01T00:00:00.000Z",
  }),
  awsCostLookupMock: vi.fn(),
}));

vi.mock("../src/metrics.js", () => ({
  publishMessageMetrics: vi.fn().mockResolvedValue(undefined),
  publishFirstResponseTime: vi.fn().mockResolvedValue(undefined),
  publishCountMetric: (...args: unknown[]) => publishCountMetricMock(...args),
}));

vi.mock("../src/gmail-tool.js", () => ({
  maybeHandleCustomGmailRequest: gmailToolMock,
  isGmailReady: isGmailReadyMock,
}));

vi.mock("../src/recent-cost-context.js", () => ({
  RecentCostContextStore: vi.fn().mockImplementation(() => ({
    load: recentCostLoadMock,
    save: recentCostSaveMock,
  })),
}));

vi.mock("../src/aws-cost-explorer.js", () => ({
  lookupAwsCostExplorer: (...args: unknown[]) => awsCostLookupMock(...args),
}));

const directBedrockChatMock = vi.hoisted(() => vi.fn());

vi.mock("../src/direct-bedrock-chat.js", () => ({
  runDirectBedrockChat: (...args: unknown[]) => directBedrockChatMock(...args),
}));

function createMockDeps(): BridgeDeps {
  return {
    authToken: "test-secret-token",
    openclawClient: {
      sendMessage: vi.fn(async function* () {
        yield "Hello ";
        yield "world!";
      }),
      close: vi.fn(),
    },
    callbackSender: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      updateTaskState: vi.fn().mockResolvedValue(undefined),
      gracefulShutdown: vi.fn().mockResolvedValue(undefined),
      updateLastActivity: vi.fn(),
      lastActivityTime: new Date(),
    },
    processStartTime: Date.now(),
    channel: "web",
  };
}

describe("Bridge HTTP Server", () => {
  let deps: BridgeDeps;
  let app: ReturnType<typeof createApp>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    gmailToolMock.mockReset();
    gmailToolMock.mockResolvedValue(undefined);
    publishCountMetricMock.mockClear();
    isGmailReadyMock.mockReset();
    isGmailReadyMock.mockResolvedValue(true);
    recentCostLoadMock.mockReset();
    recentCostLoadMock.mockResolvedValue(undefined);
    recentCostSaveMock.mockReset();
    recentCostSaveMock.mockResolvedValue({
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    awsCostLookupMock.mockReset();
    process.env.DATA_BUCKET = "test-session-bucket";
    deps = createMockDeps();
    app = createApp(deps);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.AGENTCORE_HTTP_DELIVERY_MODE;
    delete process.env.AGENTCORE_ASYNC_CALLBACK_DELIVERY;
    delete process.env.BRIDGE_DEFER_CALLBACK_PERSISTENCE;
    delete process.env.AWS_COST_LOOKUP_ENABLED;
    delete process.env.SESSION_BUCKET;
    delete process.env.DATA_BUCKET;
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("GET /health", () => {
    it("should return 200 without auth", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });

  describe("POST /message", () => {
    it("should return 202 with valid token and body", async () => {
      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Hello",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
        });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: "processing" });
    });

    it("should return 401 without token", async () => {
      const res = await request(app)
        .post("/message")
        .send({
          userId: "user-1",
          message: "Hello",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
        });

      expect(res.status).toBe(401);
    });

    it("should return 400 with missing required fields", async () => {
      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({ userId: "user-1" }); // missing message, channel, etc.

      expect(res.status).toBe(400);
    });

    it("should call openclawClient.sendMessage asynchronously", async () => {
      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Hello",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
        });

      expect(res.status).toBe(202);

      // Wait for async processing to complete
      await vi.waitFor(() => {
        expect(deps.openclawClient.sendMessage).toHaveBeenCalledWith(
          "user-1",
          "Hello",
        );
      });
    });

    it("should add a deterministic fallback for short Linux file-find chat responses", async () => {
      deps.openclawClient.sendMessage = vi.fn(async function* () {
        yield "확인해보세요.";
      });

      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "리눅스에서 파일 찾는 명령어 알려줘",
          channel: "telegram",
          connectionId: "telegram:12345",
          callbackUrl: "https://example.com/prod",
          runtimeClass: "chat-only",
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(deps.callbackSender.send).toHaveBeenCalledWith(
          "telegram:12345",
          expect.objectContaining({
            type: "stream_chunk",
            content: expect.stringContaining("find 명령어"),
          }),
        );
      });
    });

    it("should use direct Bedrock chat as primary for Bedrock chat-only delivery", async () => {
      const previousProvider = process.env.AI_PROVIDER;
      const previousModel = process.env.AI_MODEL;
      const previousExecutor = process.env.BEDROCK_CHAT_EXECUTOR;
      process.env.AI_PROVIDER = "bedrock";
      process.env.AI_MODEL = "anthropic.claude-3-haiku-20240307-v1:0";
      process.env.BEDROCK_CHAT_EXECUTOR = "direct";
      deps.openclawClient.sendMessage = vi.fn(() => {
        throw new Error("Unknown model: amazon-bedrock/anthropic.claude-3-haiku-20240307-v1:0");
      });
      directBedrockChatMock.mockResolvedValue({
        text: "find 명령어로 파일을 찾을 수 있습니다. 예: find . -name \"*.log\"",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      });

      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "리눅스에서 파일 찾는 명령어 알려줘",
          connectionId: "telegram:12345",
          callbackUrl: "https://example.com/prod",
          channel: "telegram",
          runtimeClass: "chat-only",
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(directBedrockChatMock).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "리눅스에서 파일 찾는 명령어 알려줘",
            model: "anthropic.claude-3-haiku-20240307-v1:0",
          }),
        );
        expect(deps.callbackSender.send).toHaveBeenCalledWith(
          "telegram:12345",
          expect.objectContaining({
            type: "stream_chunk",
            content: expect.stringContaining("find 명령어"),
          }),
        );
      });
      expect(deps.openclawClient.sendMessage).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"reason\":\"bedrock_primary_chat\""),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"bridge.direct_chat.completed\""),
      );
      if (previousProvider === undefined) {
        delete process.env.AI_PROVIDER;
      } else {
        process.env.AI_PROVIDER = previousProvider;
      }
      if (previousModel === undefined) {
        delete process.env.AI_MODEL;
      } else {
        process.env.AI_MODEL = previousModel;
      }
      if (previousExecutor === undefined) {
        delete process.env.BEDROCK_CHAT_EXECUTOR;
      } else {
        process.env.BEDROCK_CHAT_EXECUTOR = previousExecutor;
      }
    });

    it("should update lastActivity on message", async () => {
      await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Hello",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
        });

      expect(deps.lifecycle.updateLastActivity).toHaveBeenCalled();
    });

    it("should prepend tool-enabled Gmail guardrails before forwarding", async () => {
      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Summarize my recent inbox",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
          runtimeClass: "tool-enabled",
          emailTokenBudget: {
            mode: "headers-first",
            maxMessages: 3,
            paymentScanMessages: 12,
            maxSnippetChars: 120,
            maxBodyChars: 800,
            requireExplicitBodyAccess: true,
          },
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(deps.openclawClient.sendMessage).toHaveBeenCalledWith(
          "user-1",
          expect.stringContaining("Show at most 3 detailed Gmail items per step"),
        );
      });
      expect(deps.openclawClient.sendMessage).toHaveBeenCalledWith(
        "user-1",
        expect.stringContaining("Do not read full message bodies or attachments unless the user explicitly asks for a specific message."),
      );
      expect(deps.openclawClient.sendMessage).toHaveBeenCalledWith(
        "user-1",
        expect.stringContaining("Summarize my recent inbox"),
      );
    });

    it("should prepend AssistantRuntimeContext before forwarding", async () => {
      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Hello",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
          runtimeClass: "chat-only",
          assistantContext: {
            version: 1,
            userId: "user-1",
            channel: "web",
            sessionId: "session-user-1:chat",
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
            guidance: {
              selfAwareness: "Shared state.",
              lambda: "Chat only.",
              toolRuntime: "Tools.",
            },
          },
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(deps.openclawClient.sendMessage).toHaveBeenCalledWith(
          "user-1",
          expect.stringContaining("AssistantRuntimeContext v1"),
        );
      });
      expect(deps.openclawClient.sendMessage).toHaveBeenCalledWith(
        "user-1",
        expect.stringContaining("available_via_tool_runtime"),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"bridge.assistant_context.loaded\""),
      );
    });

    it("should answer assistant self-state from AssistantRuntimeContext without invoking OpenClaw", async () => {
      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "나에 대해 기억나는 거 있어?",
          channel: "telegram",
          connectionId: "telegram:12345",
          callbackUrl: "https://example.com/prod",
          runtimeClass: "chat-only",
          traceId: "trace-self-state",
          routeDecision: "agentcore",
          assistantContext: {
            version: 1,
            userId: "user-1",
            channel: "telegram",
            sessionId: "session-user-1:telegram",
            generatedAt: "2026-05-24T00:00:00.000Z",
            runtime: {
              agentRuntime: "both",
              runtimeClass: "chat-only",
              routeDecision: "agentcore",
              lambdaRole: "frontdoor-delivery-fallback",
              toolRuntimeProvider: "agentcore",
              fallbackProvider: "fargate",
            },
            capabilities: {
              tools: {
                available: true,
                executionRuntime: "agentcore",
                note: "Tool tasks are delegated.",
                registry: [
                  {
                    id: "gmail_payment",
                    displayName: "Gmail/payment",
                    status: "available",
                    safetyMode: "headers-first",
                  },
                ],
              },
              gmail: {
                status: "available_via_tool_runtime",
                executionRuntime: "agentcore",
                safetyMode: "headers-first",
              },
            },
            guidance: {
              selfAwareness: "Shared state.",
              lambda: "Frontdoor only.",
              toolRuntime: "Tools.",
            },
          },
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(deps.callbackSender.send).toHaveBeenCalledWith(
          "telegram:12345",
          expect.objectContaining({
            type: "stream_chunk",
            content: expect.stringContaining("Gmail 상태: 도구 런타임을 통해 사용 가능"),
          }),
        );
      });
      expect(deps.callbackSender.send).toHaveBeenCalledWith(
        "telegram:12345",
        { type: "stream_end" },
      );
      expect(deps.openclawClient.sendMessage).not.toHaveBeenCalled();
      expect(gmailToolMock).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"bridge.self_state.answered\""),
      );
    });

    it("should return a direct Gmail tool response without calling OpenClaw", async () => {
      gmailToolMock.mockResolvedValue({
        kind: "direct",
        message: "Inbox summary result",
        source: "gmail",
      });

      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Check my Gmail inbox",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
          runtimeClass: "tool-enabled",
          traceId: "trace-123",
          routeDecision: "fargate-new",
          assistantContext: {
            version: 1,
            userId: "user-1",
            channel: "web",
            sessionId: "session-user-1",
            generatedAt: "2026-05-10T00:00:00.000Z",
            runtime: {
              runtimeClass: "tool-enabled",
              routeDecision: "fargate-new",
              lambdaRole: "chat-only-fast-path",
              toolRuntimeProvider: "fargate",
              fallbackProvider: "fargate",
            },
            capabilities: {
              tools: {
                available: true,
                executionRuntime: "fargate",
                note: "Tool tasks are delegated.",
              },
              gmail: {
                status: "available_via_tool_runtime",
                executionRuntime: "fargate",
                safetyMode: "headers-first",
              },
            },
            cost: {
              upstream: [{
                name: "gateway-frontdoor",
                provider: "lambda",
                estimatedUsd: 0.000001234,
                confidence: "partial",
              }],
            },
            guidance: {
              selfAwareness: "Shared state.",
              lambda: "Chat only.",
              toolRuntime: "Tools.",
            },
          },
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(deps.callbackSender.send).toHaveBeenCalledWith(
          "conn-123",
          expect.objectContaining({
            type: "stream_chunk",
            content: "Inbox summary result",
          }),
        );
      });
      expect(gmailToolMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "conn-123",
          message: "Check my Gmail inbox",
        }),
      );
      expect(deps.openclawClient.sendMessage).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"bridge.delivery.success\""),
      );
      expect(recentCostSaveMock).toHaveBeenCalledWith(
        "user-1",
        "session-user-1",
        expect.objectContaining({
          breakdown: expect.objectContaining({
            upstreamUsd: 0.000001234,
          }),
        }),
      );
      expect(publishCountMetricMock).toHaveBeenCalledWith("DeliverySuccess", {
        channel: "web",
        runtime: "fargate",
        deliveryType: "websocket",
      });
    });

    it("should log Gmail telemetry with sanitized query metadata", async () => {
      gmailToolMock.mockImplementation(async (options: { onToolEvent?: (event: unknown) => void }) => {
        options.onToolEvent?.({
          type: "intentDecided",
          decisionSource: "slm",
          action: "clarify_source",
          taskFamily: "gmail_payment_summary",
          sourceChoice: null,
          followUpIntent: "refine_topic",
          confidence: 0.82,
          slmBackend: "mock-local",
        });
        options.onToolEvent?.({
          type: "contextCreated",
          taskFamily: "gmail_payment_summary",
          sourceChoice: null,
        });
        options.onToolEvent?.({
          type: "clarificationSent",
          taskFamily: "gmail_payment_summary",
          reason: "advisor-clarify-source",
        });
        return {
          kind: "direct",
          message: "지메일에서 확인할까요, 아니면 일반 답변으로 도와드릴까요?",
          source: "gmail-clarification",
        };
      });

      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Find card statements from march for zoown13@gmail.com token 1234567890",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
          runtimeClass: "tool-enabled",
          traceId: "trace-telemetry",
          routeDecision: "fargate-new",
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining("\"event\":\"bridge.tool.intent.decided\""),
        );
      });
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"bridge.slm.classified\""),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"slmBackend\":\"mock-local\""),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"bridge.tool.clarification.sent\""),
      );
      expect(publishCountMetricMock).toHaveBeenCalledWith("DeliverySuccess", {
        channel: "web",
        runtime: "fargate",
        deliveryType: "websocket",
      });
    });

    it("should log slm fallback telemetry when the classifier falls back", async () => {
      gmailToolMock.mockImplementation(async (options: { onToolEvent?: (event: unknown) => void }) => {
        options.onToolEvent?.({
          type: "handlerFallback",
          taskFamily: "gmail_payment_summary",
          reason: "advisor-unavailable",
          slmBackend: "mock-local",
        });
        options.onToolEvent?.({
          type: "intentDecided",
          decisionSource: "deterministic",
          action: "deterministic",
          taskFamily: "gmail_payment_summary",
          sourceChoice: "gmail",
          confidence: 0.5,
        });
        return {
          kind: "direct",
          message: "Fallback result",
          source: "gmail-context",
        };
      });

      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "이번주 결제한 금액이 어느정도 되려나?",
          channel: "web",
          connectionId: "conn-123",
          callbackUrl: "https://example.com/prod",
          runtimeClass: "tool-enabled",
          traceId: "trace-slm-fallback",
          routeDecision: "fargate-new",
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining("\"event\":\"bridge.slm.fallback\""),
        );
      });
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"slmBackend\":\"mock-local\""),
      );
    });

    it("should record delivery failure when callback delivery throws", async () => {
      gmailToolMock.mockResolvedValue({
        kind: "direct",
        message: "Inbox summary result",
        source: "gmail",
      });
      deps.callbackSender.send = vi.fn().mockRejectedValue(new Error("telegram send failed"));
      app = createApp(deps);

      const res = await request(app)
        .post("/message")
        .set("Authorization", "Bearer test-secret-token")
        .send({
          userId: "user-1",
          message: "Check my Gmail inbox",
          channel: "telegram",
          connectionId: "telegram:999001111",
          callbackUrl: "https://example.com/prod",
          runtimeClass: "tool-enabled",
          traceId: "trace-delivery-failure",
          routeDecision: "fargate-new",
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("\"event\":\"bridge.delivery.failure\""),
        );
      });
      expect(publishCountMetricMock).toHaveBeenCalledWith("DeliveryFailure", {
        channel: "telegram",
        runtime: "fargate",
        deliveryType: "telegram",
      });
    });
  });

  describe("AgentCore HTTP endpoints", () => {
    it("should expose /ping without bridge auth only when AgentCore HTTP is enabled", async () => {
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const res = await request(app).get("/ping");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "Healthy" });
      expect(res.body.time_of_last_update).toEqual(expect.any(Number));
    });

    it("should process /invocations synchronously without callback delivery", async () => {
      gmailToolMock.mockResolvedValue({
        kind: "direct",
        message: "AgentCore Gmail result",
        source: "gmail",
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const res = await request(app)
        .post("/invocations")
        .send({
          userId: "user-1",
          message: "Check my Gmail inbox",
          channel: "web",
          connectionId: "conn-agentcore",
          runtimeClass: "tool-enabled",
          traceId: "trace-agentcore",
          routeDecision: "agentcore",
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        content: "AgentCore Gmail result",
        source: "gmail",
      });
      expect(deps.callbackSender.send).not.toHaveBeenCalled();
      expect(publishCountMetricMock).toHaveBeenCalledWith("DeliverySuccess", {
        channel: "web",
        runtime: "agentcore",
        deliveryType: "websocket",
      });
    });

    it("should accept /invocations asynchronously when AgentCore callback delivery is enabled", async () => {
      process.env.AGENTCORE_HTTP_DELIVERY_MODE = "callback";
      gmailToolMock.mockResolvedValue({
        kind: "direct",
        message: "AgentCore callback Gmail result",
        source: "gmail",
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const res = await request(app)
        .post("/invocations")
        .send({
          userId: "user-1",
          message: "Check my Gmail inbox",
          channel: "web",
          connectionId: "conn-agentcore",
          callbackUrl: "https://example.com/prod",
          runtimeClass: "tool-enabled",
          traceId: "trace-agentcore-callback",
          routeDecision: "agentcore",
        });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        status: "processing",
        source: "agentcore-callback",
      });

      await vi.waitFor(() => {
        expect(deps.callbackSender.send).toHaveBeenCalledWith(
          "conn-agentcore",
          {
            type: "stream_chunk",
            content: "AgentCore callback Gmail result",
            conversationId: undefined,
          },
        );
        expect(deps.callbackSender.send).toHaveBeenCalledWith(
          "conn-agentcore",
          {
            type: "stream_end",
          },
        );
      });
      expect(publishCountMetricMock).toHaveBeenCalledWith("DeliverySuccess", {
        channel: "web",
        runtime: "agentcore",
        deliveryType: "websocket",
      });
      expect(recentCostSaveMock).toHaveBeenCalledWith(
        "user-1",
        "web:conn-agentcore",
        expect.objectContaining({
          provider: "agentcore",
          estimatedUsd: expect.any(Number),
          breakdown: expect.objectContaining({
            agentCoreUsd: expect.any(Number),
          }),
        }),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"bridge.cost.estimated\""),
      );
    });

    it("should answer AgentCore recent tool cost lookup without invoking tools", async () => {
      recentCostLoadMock.mockResolvedValueOnce({
        version: 1,
        userId: "user-1",
        sessionId: "web:conn-agentcore",
        createdAt: "2026-05-09T12:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        estimate: {
          traceId: "trace-agentcore-cost-source",
          userId: "user-1",
          channel: "web",
          runtimeClass: "tool-enabled",
          provider: "agentcore",
          durationMs: 1200,
          memoryMb: 2048,
          agentCoreVcpu: 1,
          estimatedUsd: 0.000036472,
          confidence: "partial",
          breakdown: {
            agentCoreUsd: 0.000036472,
          },
        },
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const res = await request(app)
        .post("/invocations")
        .send({
          userId: "user-1",
          message: "/cost",
          channel: "web",
          connectionId: "conn-agentcore",
          runtimeClass: "tool-enabled",
          traceId: "trace-agentcore-cost",
          routeDecision: "agentcore",
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        content: expect.stringContaining("직전 tool runtime 질의 추정 비용"),
        source: "cost-context",
      });
      expect(res.body.content).toContain("$0.000036472");
      expect(gmailToolMock).not.toHaveBeenCalled();
      expect(deps.openclawClient.sendMessage).not.toHaveBeenCalled();
      expect(recentCostLoadMock).toHaveBeenCalledWith("user-1", "web:conn-agentcore");
      expect(recentCostSaveMock).not.toHaveBeenCalled();
    });

    it("should answer AgentCore AWS Cost Explorer lookup when enabled", async () => {
      process.env.AWS_COST_LOOKUP_ENABLED = "true";
      awsCostLookupMock.mockResolvedValueOnce({
        request: { period: "month_to_date", groupByService: true, maxServices: 8 },
        dateRange: {
          start: "2026-05-01",
          end: "2026-05-15",
          label: "이번 달 현재까지",
          freshnessNote: "오늘 진행 중인 비용은 Cost Explorer에 아직 완전히 반영되지 않을 수 있습니다.",
        },
        totalUsd: 1.23,
        unit: "USD",
        services: [
          { service: "AWS Lambda", amountUsd: 0.5, unit: "USD" },
        ],
        generatedAt: "2026-05-15T12:00:00.000Z",
        source: "aws-cost-explorer",
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const res = await request(app)
        .post("/invocations")
        .send({
          userId: "user-1",
          message: "이번달 AWS 비용 서비스별로 알려줘",
          channel: "web",
          connectionId: "conn-agentcore",
          runtimeClass: "tool-enabled",
          traceId: "trace-agentcore-aws-cost",
          routeDecision: "agentcore",
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        content: expect.stringContaining("AWS Cost Explorer 기준"),
        source: "aws-cost-explorer",
      });
      expect(res.body.content).toContain("AWS Lambda");
      expect(awsCostLookupMock).toHaveBeenCalledWith(expect.objectContaining({
        period: "month_to_date",
        groupByService: true,
      }));
      expect(gmailToolMock).not.toHaveBeenCalled();
      expect(recentCostLoadMock).not.toHaveBeenCalled();
      expect(deps.openclawClient.sendMessage).not.toHaveBeenCalled();
    });

    it("should emit direct Telegram content-quality signals for AgentCore responses", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      gmailToolMock.mockResolvedValue({
        kind: "direct",
        message:
          "Gmail 헤더/스니펫 기준으로 후보 11건을 확인했습니다. 본문과 첨부파일은 열지 않았습니다. 확인 가능한 합계: KRW 10,000. 확인된 카드사: 삼성카드. 일본/여행 관련 결제만 정리했습니다. 스타벅스",
        source: "gmail",
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const res = await request(app)
        .post("/invocations")
        .send({
          userId: "user-1",
          message: "이번주 결제한 금액 얼마야",
          channel: "telegram",
          connectionId: "telegram:12345",
          runtimeClass: "tool-enabled",
          traceId: "trace-agentcore",
          routeDecision: "agentcore",
        });

      const qualityLog = logSpy.mock.calls
        .map(([value]) => String(value))
        .find((value) => value.includes("telegram.delivery.content_quality"));
      expect(res.status).toBe(200);
      expect(deps.callbackSender.send).not.toHaveBeenCalled();
      expect(qualityLog).toBeDefined();
      expect(qualityLog).not.toContain("스타벅스");
      expect(JSON.parse(qualityLog ?? "{}")).toMatchObject({
        hasKoreanPaymentSummary: true,
        hasPaymentCoverageDisclosure: true,
        hasIssuerBreakdownSignal: true,
        hasTopicFilteredPaymentSignal: true,
        hasRawInternalError: false,
        hasLegacyEnglishPaymentPhrases: false,
      });

      logSpy.mockRestore();
    });

    it("should process /invocations when AgentCore sends octet-stream JSON", async () => {
      gmailToolMock.mockResolvedValue({
        kind: "direct",
        message: "AgentCore octet-stream result",
        source: "gmail",
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const res = await request(app)
        .post("/invocations")
        .set("Content-Type", "application/octet-stream")
        .send(JSON.stringify({
          userId: "user-1",
          message: "Check my Gmail inbox",
          channel: "web",
          connectionId: "conn-agentcore",
          runtimeClass: "tool-enabled",
          traceId: "trace-agentcore-octet",
          routeDecision: "agentcore",
        }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        content: "AgentCore octet-stream result",
        source: "gmail",
      });
      expect(deps.callbackSender.send).not.toHaveBeenCalled();
    });

    it("should process /invocations when AgentCore sends raw JSON with a UTF-8 BOM", async () => {
      gmailToolMock.mockResolvedValue({
        kind: "direct",
        message: "AgentCore BOM result",
        source: "gmail",
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const payload = JSON.stringify({
        userId: "user-1",
        message: "Check my Gmail inbox",
        channel: "web",
        connectionId: "conn-agentcore",
        runtimeClass: "tool-enabled",
        traceId: "trace-agentcore-bom",
        routeDecision: "agentcore",
      });
      const res = await request(app)
        .post("/invocations")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from(`\uFEFF${payload}`, "utf8"));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        content: "AgentCore BOM result",
        source: "gmail",
      });
      expect(deps.callbackSender.send).not.toHaveBeenCalled();
    });

    it("should process /invocations when AgentCore omits content-type", async () => {
      gmailToolMock.mockResolvedValue({
        kind: "direct",
        message: "AgentCore no content-type result",
        source: "gmail",
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const payload = JSON.stringify({
        userId: "user-1",
        message: "Check my Gmail inbox",
        channel: "web",
        connectionId: "conn-agentcore",
        runtimeClass: "tool-enabled",
        traceId: "trace-agentcore-no-content-type",
        routeDecision: "agentcore",
      });
      const res = await request(app)
        .post("/invocations")
        .unset("Content-Type")
        .send(Buffer.from(payload, "utf8"));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        content: "AgentCore no content-type result",
        source: "gmail",
      });
      expect(deps.callbackSender.send).not.toHaveBeenCalled();
    });

    it("should process /invocations when AgentCore wraps the bridge request in a payload field", async () => {
      gmailToolMock.mockResolvedValue({
        kind: "direct",
        message: "AgentCore wrapped result",
        source: "gmail",
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const res = await request(app)
        .post("/invocations")
        .send({
          payload: JSON.stringify({
            userId: "user-1",
            message: "Check my Gmail inbox",
            channel: "web",
            connectionId: "conn-agentcore",
            runtimeClass: "tool-enabled",
            traceId: "trace-agentcore-wrapped",
            routeDecision: "agentcore",
          }),
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        content: "AgentCore wrapped result",
        source: "gmail",
      });
      expect(deps.callbackSender.send).not.toHaveBeenCalled();
    });

    it("should fail /invocations quickly when OpenClaw is not ready and no direct tool result exists", async () => {
      deps.openclawClient.sendMessage = vi.fn(() => {
        throw new Error("OpenClaw runtime is still starting");
      });
      app = createApp({
        ...deps,
        agentCoreHttpEnabled: true,
        runtimeLabel: "agentcore",
      });

      const res = await request(app)
        .post("/invocations")
        .send({
          userId: "user-1",
          message: "Generic tool question",
          channel: "web",
          connectionId: "conn-agentcore",
          runtimeClass: "tool-enabled",
          traceId: "trace-agentcore-not-ready",
          routeDecision: "agentcore",
        });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: "AgentCore runtime failed to process the request",
      });
      expect(deps.callbackSender.send).not.toHaveBeenCalled();
    });
  });

  describe("GET /status", () => {
    it("should return 200 with status info", async () => {
      const res = await request(app)
        .get("/status")
        .set("Authorization", "Bearer test-secret-token");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "running");
      expect(res.body).toHaveProperty("uptime");
      expect(res.body).toHaveProperty("lastActivity");
    });

    it("should return 401 without token", async () => {
      const res = await request(app).get("/status");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /shutdown", () => {
    it("should return 200 and call gracefulShutdown", async () => {
      const res = await request(app)
        .post("/shutdown")
        .set("Authorization", "Bearer test-secret-token");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "shutting_down" });

      await new Promise((r) => setTimeout(r, 50));
      expect(deps.lifecycle.gracefulShutdown).toHaveBeenCalled();
    });

    it("should return 401 without token", async () => {
      const res = await request(app).post("/shutdown");
      expect(res.status).toBe(401);
    });
  });
});
