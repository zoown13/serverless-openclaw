import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/bridge.js";
import type { BridgeDeps } from "../src/bridge.js";

const { gmailToolMock, publishCountMetricMock, isGmailReadyMock } = vi.hoisted(() => ({
  gmailToolMock: vi.fn(),
  publishCountMetricMock: vi.fn().mockResolvedValue(undefined),
  isGmailReadyMock: vi.fn().mockResolvedValue(true),
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
    deps = createMockDeps();
    app = createApp(deps);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
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
            maxSnippetChars: 120,
            maxBodyChars: 800,
            requireExplicitBodyAccess: true,
          },
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(deps.openclawClient.sendMessage).toHaveBeenCalledWith(
          "user-1",
          expect.stringContaining("Inspect at most 3 items per step"),
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
