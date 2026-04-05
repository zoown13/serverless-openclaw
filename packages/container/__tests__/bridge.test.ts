import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/bridge.js";
import type { BridgeDeps } from "../src/bridge.js";

const { gmailToolMock, publishCountMetricMock } = vi.hoisted(() => ({
  gmailToolMock: vi.fn(),
  publishCountMetricMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/metrics.js", () => ({
  publishMessageMetrics: vi.fn().mockResolvedValue(undefined),
  publishFirstResponseTime: vi.fn().mockResolvedValue(undefined),
  publishCountMetric: (...args: unknown[]) => publishCountMetricMock(...args),
}));

vi.mock("../src/gmail-tool.js", () => ({
  maybeHandleCustomGmailRequest: gmailToolMock,
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

    it("should return a direct Gmail tool response without calling OpenClaw", async () => {
      gmailToolMock.mockResolvedValue("Inbox summary result");

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
          routingContext: {
            status: "active_task",
            intentKind: "payment_summary",
            canonicalGoal: "이번주 결제한 금액이 어느정도 되려나?",
            sourceChoice: "gmail",
            runtimeClass: "tool-enabled",
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
          routingContext: expect.objectContaining({
            status: "active_task",
            intentKind: "payment_summary",
            canonicalGoal: "이번주 결제한 금액이 어느정도 되려나?",
            sourceChoice: "gmail",
            runtimeClass: "tool-enabled",
          }),
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
      gmailToolMock.mockImplementation(async (options: { onTelemetry?: (event: unknown) => void }) => {
        options.onTelemetry?.({ event: "matched" });
        options.onTelemetry?.({
          event: "queryBuilt",
          sanitizedQuery: "after:2026/03/01 [REDACTED]",
          isUnread: false,
          dateRange: "after:2026/03/01 before:2026/04/01",
          keywordCount: 2,
        });
        options.onTelemetry?.({
          event: "result",
          sanitizedQuery: "after:2026/03/01 [REDACTED]",
          outcome: "no-results",
          isUnread: false,
          dateRange: "after:2026/03/01 before:2026/04/01",
          keywordCount: 2,
          matchedCount: 0,
          inspectedCount: 0,
        });
        return "No matches";
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
          expect.stringContaining("\"event\":\"bridge.gmail.query.built\""),
        );
      });
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("[REDACTED]"),
      );
      expect(publishCountMetricMock).toHaveBeenCalledWith("GmailToolMatched", {
        channel: "web",
        runtime: "fargate",
      });
      expect(publishCountMetricMock).toHaveBeenCalledWith("GmailToolNoResults", {
        channel: "web",
        runtime: "fargate",
      });
    });

    it("should record delivery failure when callback delivery throws", async () => {
      gmailToolMock.mockResolvedValue("Inbox summary result");
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
