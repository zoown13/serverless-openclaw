import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  routeMessage,
  savePendingMessage,
  sendToBridge,
} from "../../src/services/message.js";

const publishGatewayCountMetricMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  PutCommand: vi.fn((params: unknown) => ({ input: params, _tag: "PutCommand" })),
}));

vi.mock("../../src/services/metrics.js", () => ({
  publishGatewayCountMetric: (...args: unknown[]) => publishGatewayCountMetricMock(...args),
}));

describe("message service", () => {
  const mockDynamoSend = vi.fn();
  const mockFetch = vi.fn();
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 202 });
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  describe("sendToBridge", () => {
    it("should POST to bridge with Bearer token and AbortSignal", async () => {
      await sendToBridge(mockFetch, "1.2.3.4", "my-token", {
        userId: "user-123",
        message: "hello",
        channel: "web",
        connectionId: "conn-1",
        callbackUrl: "https://api.example.com",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://1.2.3.4:8080/message",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer my-token",
          }),
          body: expect.any(String),
          signal: expect.any(AbortSignal),
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.userId).toBe("user-123");
      expect(body.message).toBe("hello");
    });

    it("should throw on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        sendToBridge(mockFetch, "1.2.3.4", "token", {
          userId: "u",
          message: "m",
          channel: "web",
          connectionId: "c",
          callbackUrl: "https://cb",
        }),
      ).rejects.toThrow("Bridge returned 500");
    });

    it("should pass an AbortSignal that is not immediately aborted", async () => {
      await sendToBridge(mockFetch, "1.2.3.4", "token", {
        userId: "u",
        message: "m",
        channel: "web",
        connectionId: "c",
        callbackUrl: "https://cb",
      });

      const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });
  });

  describe("savePendingMessage", () => {
    it("should save message with TTL to PendingMessages table", async () => {
      mockDynamoSend.mockResolvedValueOnce({});

      const item = {
        PK: "USER#user-123",
        SK: "MSG#1000#uuid-1",
        message: "hello",
        channel: "web" as const,
        connectionId: "conn-1",
        createdAt: "2024-01-01T00:00:00Z",
        ttl: 9999999999,
      };

      await savePendingMessage(mockDynamoSend, item);

      expect(mockDynamoSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            TableName: expect.stringContaining("PendingMessages"),
            Item: item,
          }),
        }),
      );
    });
  });

  describe("routeMessage", () => {
    const baseDeps = {
      userId: "user-123",
      message: "hello",
      traceId: "trace-123",
      channel: "web" as const,
      connectionId: "conn-1",
      callbackUrl: "https://cb",
      bridgeAuthToken: "token",
      startTaskParams: { cluster: "c", taskDefinition: "td", subnets: ["s"], securityGroups: ["sg"], containerName: "openclaw", environment: [] },
    };

    function makeDeps(overrides: Record<string, unknown> = {}) {
      return {
        ...baseDeps,
        fetchFn: mockFetch,
        getTaskState: vi.fn().mockResolvedValue(null),
        startTask: vi.fn().mockResolvedValue("arn:new-task"),
        putTaskState: vi.fn(),
        savePendingMessage: vi.fn(),
        deleteTaskState: vi.fn(),
        getRoutingContext: vi.fn().mockResolvedValue(null),
        putRoutingContext: vi.fn(),
        deleteRoutingContext: vi.fn(),
        sendClarification: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    it("should route ambiguous payment questions directly to tool-enabled compute", async () => {
      const deps = makeDeps({
        message: "이번주 결제한 금액이 어느정도 되려나?",
      });

      const result = await routeMessage(deps);
      const affinityState = (deps.putRoutingContext as ReturnType<typeof vi.fn>).mock
        .calls[0][1];

      expect(result).toBe("started");
      expect(deps.putRoutingContext).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          status: "active",
          runtimeClass: "tool-enabled",
          channel: "web",
        }),
      );
      expect(
        Object.prototype.hasOwnProperty.call(
          affinityState as Record<string, unknown>,
          "canonicalGoal",
        ),
      ).toBe(false);
      expect(deps.sendClarification).not.toHaveBeenCalled();
      expect(deps.startTask).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(deps.savePendingMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({
          routingContext: expect.anything(),
        }),
      );
    });

    it("should reuse an active tool affinity for a short payment follow-up", async () => {
      const deps = makeDeps({
        message: "얼마 썼는지 정리해줄래?",
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Running",
          publicIp: "1.2.3.4",
          taskArn: "arn:task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
        getRoutingContext: vi.fn().mockResolvedValue({
          status: "active",
          channel: "web",
          connectionId: "conn-1",
          callbackUrl: "https://cb",
          createdAt: "2026-04-04T00:00:00Z",
          lastActivityAt: "2026-04-04T00:00:00Z",
          expiresAt: "2099-04-04T00:05:00Z",
          runtimeClass: "tool-enabled",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("sent");
      expect(deps.putRoutingContext).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({
          status: "active",
          runtimeClass: "tool-enabled",
        }),
      );
      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toBe("얼마 썼는지 정리해줄래?");
      expect(body.runtimeClass).toBe("tool-enabled");
      expect(body.routingContext).toBeUndefined();
    });

    it("should reuse an active tool affinity for a short contextual follow-up without explicit Gmail terms", async () => {
      const deps = makeDeps({
        message: "그거 표로 보여줘",
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Running",
          publicIp: "1.2.3.4",
          taskArn: "arn:task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
        getRoutingContext: vi.fn().mockResolvedValue({
          status: "active",
          channel: "web",
          connectionId: "conn-1",
          callbackUrl: "https://cb",
          createdAt: "2026-04-04T00:00:00Z",
          lastActivityAt: "2026-04-04T00:00:00Z",
          expiresAt: "2099-04-04T00:05:00Z",
          runtimeClass: "tool-enabled",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("sent");
      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toBe("그거 표로 보여줘");
      expect(body.runtimeClass).toBe("tool-enabled");
    });

    it("should keep an active tool affinity for travel-refinement follow-ups", async () => {
      const deps = makeDeps({
        message: "일본관련된 것만 가져와야지",
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Running",
          publicIp: "1.2.3.4",
          taskArn: "arn:task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
        getRoutingContext: vi.fn().mockResolvedValue({
          status: "active",
          channel: "web",
          connectionId: "conn-1",
          callbackUrl: "https://cb",
          createdAt: "2026-04-04T00:00:00Z",
          lastActivityAt: "2026-04-04T00:00:00Z",
          expiresAt: "2099-04-04T00:05:00Z",
          runtimeClass: "tool-enabled",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("sent");
      expect(deps.deleteRoutingContext).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toBe("일본관련된 것만 가져와야지");
      expect(body.runtimeClass).toBe("tool-enabled");
    });

    it("should clear an active tool affinity on explicit cancel", async () => {
      const deps = makeDeps({
        message: "취소",
        getRoutingContext: vi.fn().mockResolvedValue({
          status: "active",
          channel: "web",
          connectionId: "conn-1",
          callbackUrl: "https://cb",
          runtimeClass: "tool-enabled",
          createdAt: "2026-04-04T00:00:00Z",
          lastActivityAt: "2026-04-04T00:00:00Z",
          expiresAt: "2099-04-04T00:05:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("clarify");
      expect(deps.deleteRoutingContext).toHaveBeenCalledWith("user-123", "web");
      expect(deps.sendClarification).toHaveBeenCalledWith(
        "알겠습니다. 현재 도구 작업 문맥을 종료할게요.",
      );
    });

    it("should clear an unrelated active task context and route the new message normally", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({ accepted: true });
      const deps = makeDeps({
        message: "안녕",
        agentRuntime: "both",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        getRoutingContext: vi.fn().mockResolvedValue({
          status: "active",
          channel: "web",
          connectionId: "conn-1",
          callbackUrl: "https://cb",
          runtimeClass: "tool-enabled",
          createdAt: "2026-04-04T00:00:00Z",
          lastActivityAt: "2026-04-04T00:00:00Z",
          expiresAt: "2099-04-04T00:05:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("lambda");
      expect(deps.deleteRoutingContext).toHaveBeenCalledWith("user-123", "web");
      expect(mockInvokeLambda).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "안녕",
        }),
      );
    });

    it("should ignore an expired routing context and route the message fresh", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({ accepted: true });
      const deps = makeDeps({
        message: "hello",
        agentRuntime: "both",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        getRoutingContext: vi.fn().mockResolvedValue({
          status: "active",
          channel: "web",
          connectionId: "conn-1",
          callbackUrl: "https://cb",
          runtimeClass: "tool-enabled",
          createdAt: "2026-04-04T00:00:00Z",
          lastActivityAt: "2026-04-04T00:00:00Z",
          expiresAt: "2026-04-04T00:01:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("lambda");
      expect(deps.deleteRoutingContext).toHaveBeenCalledWith("user-123", "web");
      expect(mockInvokeLambda).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "hello",
        }),
      );
    });

    it("should send to bridge when task is Running with publicIp", async () => {
      const deps = makeDeps({
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Running",
          publicIp: "1.2.3.4",
          taskArn: "arn:task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("sent");
      expect(mockFetch).toHaveBeenCalled();
      expect(deps.startTask).not.toHaveBeenCalled();
      expect(deps.deleteTaskState).not.toHaveBeenCalled();
    });

    it("should save pending + start task when no active task", async () => {
      const deps = makeDeps();

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(mockFetch).not.toHaveBeenCalled();
      expect(deps.savePendingMessage).toHaveBeenCalled();
      expect(deps.startTask).toHaveBeenCalled();
      expect(deps.putTaskState).toHaveBeenCalledWith(
        expect.objectContaining({
          PK: "USER#user-123",
          status: "Starting",
          taskArn: "arn:new-task",
        }),
      );
    });

    it("should preserve tool-enabled runtime metadata in pending messages", async () => {
      const deps = makeDeps({
        message: "Check my Gmail inbox and summarize unread emails",
      });

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(deps.savePendingMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeClass: "tool-enabled",
          traceId: "trace-123",
          routeDecision: "fargate-new",
          emailTokenBudget: expect.objectContaining({
            mode: "headers-first",
          }),
        }),
      );
    });

    it("should save pending when task is Starting (no publicIp yet)", async () => {
      const deps = makeDeps({
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Starting",
          taskArn: "arn:task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("queued");
      expect(deps.savePendingMessage).toHaveBeenCalled();
      expect(deps.startTask).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should claim a pre-warmed container when no user task exists", async () => {
      const deps = makeDeps({
        getTaskState: vi.fn()
          .mockResolvedValueOnce(null) // user's task state
          .mockResolvedValueOnce({     // prewarm task state
            PK: "USER#system:prewarm",
            status: "Running",
            publicIp: "10.0.0.1",
            taskArn: "arn:prewarm-task",
            startedAt: "2024-01-01T00:00:00Z",
            lastActivity: "2024-01-01T00:00:00Z",
          }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("sent");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://10.0.0.1:8080/message",
        expect.objectContaining({ method: "POST" }),
      );
      // Should delete prewarm TaskState
      expect(deps.deleteTaskState).toHaveBeenCalledWith("system:prewarm");
      // Should create user's TaskState with same taskArn/publicIp
      expect(deps.putTaskState).toHaveBeenCalledWith(
        expect.objectContaining({
          PK: "USER#user-123",
          taskArn: "arn:prewarm-task",
          status: "Running",
          publicIp: "10.0.0.1",
        }),
      );
      // Should NOT start a new task
      expect(deps.startTask).not.toHaveBeenCalled();
    });

    it("should fall through to normal path when prewarm bridge is unreachable", async () => {
      const failFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      const deps = makeDeps({
        fetchFn: failFetch,
        getTaskState: vi.fn()
          .mockResolvedValueOnce(null) // user's task state
          .mockResolvedValueOnce({     // prewarm task state
            PK: "USER#system:prewarm",
            status: "Running",
            publicIp: "10.0.0.1",
            taskArn: "arn:prewarm-task",
            startedAt: "2024-01-01T00:00:00Z",
            lastActivity: "2024-01-01T00:00:00Z",
          }),
      });

      const result = await routeMessage(deps);

      // Should fall through to normal path (save pending + start new task)
      expect(result).toBe("started");
      expect(deps.savePendingMessage).toHaveBeenCalled();
      expect(deps.startTask).toHaveBeenCalled();
    });

    it("should skip prewarm claim when prewarm task is Starting (no publicIp)", async () => {
      const deps = makeDeps({
        getTaskState: vi.fn()
          .mockResolvedValueOnce(null) // user's task state
          .mockResolvedValueOnce({     // prewarm task state — Starting, no IP
            PK: "USER#system:prewarm",
            status: "Starting",
            taskArn: "arn:prewarm-task",
            startedAt: "2024-01-01T00:00:00Z",
            lastActivity: "2024-01-01T00:00:00Z",
          }),
      });

      const result = await routeMessage(deps);

      // Should fall through to normal path
      expect(result).toBe("started");
      expect(deps.savePendingMessage).toHaveBeenCalled();
      expect(deps.startTask).toHaveBeenCalled();
      expect(deps.deleteTaskState).not.toHaveBeenCalledWith("system:prewarm");
    });

    it("should skip prewarm claim when no prewarm task exists", async () => {
      const deps = makeDeps({
        getTaskState: vi.fn()
          .mockResolvedValueOnce(null) // user's task state
          .mockResolvedValueOnce(null), // prewarm task state — none
      });

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(deps.savePendingMessage).toHaveBeenCalled();
      expect(deps.startTask).toHaveBeenCalled();
    });

    it("should fallback on bridge connection refused: save pending + delete stale state + start new task", async () => {
      const failFetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      const deps = makeDeps({
        fetchFn: failFetch,
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Running",
          publicIp: "1.2.3.4",
          taskArn: "arn:stale-task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(deps.savePendingMessage).toHaveBeenCalled();
      expect(deps.deleteTaskState).toHaveBeenCalledWith("user-123");
      expect(deps.startTask).toHaveBeenCalled();
      expect(deps.putTaskState).toHaveBeenCalledWith(
        expect.objectContaining({
          PK: "USER#user-123",
          status: "Starting",
          taskArn: "arn:new-task",
        }),
      );
    });

    it("should fallback on bridge timeout (AbortError)", async () => {
      const abortError = new DOMException("The operation was aborted", "AbortError");
      const failFetch = vi.fn().mockRejectedValue(abortError);
      const deps = makeDeps({
        fetchFn: failFetch,
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Running",
          publicIp: "1.2.3.4",
          taskArn: "arn:stale-task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(deps.savePendingMessage).toHaveBeenCalled();
      expect(deps.deleteTaskState).toHaveBeenCalledWith("user-123");
      expect(deps.startTask).toHaveBeenCalled();
    });

    it("should fallback on bridge non-ok response (e.g. 502)", async () => {
      const failFetch = vi.fn().mockResolvedValue({ ok: false, status: 502, statusText: "Bad Gateway" });
      const deps = makeDeps({
        fetchFn: failFetch,
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Running",
          publicIp: "1.2.3.4",
          taskArn: "arn:stale-task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(deps.savePendingMessage).toHaveBeenCalled();
      expect(deps.deleteTaskState).toHaveBeenCalledWith("user-123");
      expect(deps.startTask).toHaveBeenCalled();
    });

    it("should invoke Lambda agent when agentRuntime is 'lambda'", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({
        success: true,
        payloads: [{ text: "Lambda response" }],
      });

      const deps = makeDeps({
        agentRuntime: "lambda",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        sessionId: "session-456",
      });

      const result = await routeMessage(deps);

      expect(result).toBe("lambda");
      expect(mockInvokeLambda).toHaveBeenCalledWith(
        expect.objectContaining({
          functionArn: "arn:aws:lambda:us-east-1:123:function:agent",
          userId: "user-123",
          sessionId: "session-456",
          message: "hello",
          channel: "web",
        }),
      );
      // Should NOT touch Fargate path
      expect(mockFetch).not.toHaveBeenCalled();
      expect(deps.startTask).not.toHaveBeenCalled();
    });

    it("should throw when Lambda agent returns failure", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({
        success: false,
        error: "Agent timeout",
      });

      const deps = makeDeps({
        agentRuntime: "lambda",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
      });

      await expect(routeMessage(deps)).rejects.toThrow("Agent timeout");
    });

    it("should fail fast when web lambda delivery metadata is incomplete", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({ accepted: true });
      const deps = makeDeps({
        agentRuntime: "lambda",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        callbackUrl: "",
      });

      await expect(routeMessage(deps)).rejects.toThrow(
        "Web Lambda delivery requires both connectionId and callbackUrl",
      );
      expect(mockInvokeLambda).not.toHaveBeenCalled();
    });

    it("should fail fast when telegram lambda delivery metadata is incomplete", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({ accepted: true });
      const deps = makeDeps({
        agentRuntime: "lambda",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        channel: "telegram",
        connectionId: "",
        callbackUrl: "",
      });

      await expect(routeMessage(deps)).rejects.toThrow(
        "Telegram Lambda delivery requires telegramChatId or connectionId",
      );
      expect(mockInvokeLambda).not.toHaveBeenCalled();
    });

    it("should use Fargate path when agentRuntime is 'fargate'", async () => {
      const deps = makeDeps({
        agentRuntime: "fargate",
      });

      const result = await routeMessage(deps);

      // Falls through to Fargate path (no task → start new)
      expect(result).toBe("started");
      expect(deps.startTask).toHaveBeenCalled();
    });

    it("should use Fargate path when agentRuntime is not set", async () => {
      const deps = makeDeps();

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(deps.startTask).toHaveBeenCalled();
    });

    it("should reuse Fargate when AGENT_RUNTIME=both and container is Running", async () => {
      const mockInvokeLambda = vi.fn();
      const deps = makeDeps({
        agentRuntime: "both",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        message: "check my gmail inbox",
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Running",
          publicIp: "1.2.3.4",
          taskArn: "arn:task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("sent");
      expect(mockFetch).toHaveBeenCalled();
      expect(mockInvokeLambda).not.toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.runtimeClass).toBe("tool-enabled");
      expect(body.emailTokenBudget).toEqual({
        mode: "headers-first",
        maxMessages: 5,
        maxSnippetChars: 240,
        maxBodyChars: 1600,
        requireExplicitBodyAccess: true,
      });
    });

    it("should use Lambda when AGENT_RUNTIME=both and no Fargate running", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({
        accepted: true,
      });
      const deps = makeDeps({
        agentRuntime: "both",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        getTaskState: vi.fn().mockResolvedValue(null),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("lambda");
      expect(mockInvokeLambda).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(deps.startTask).not.toHaveBeenCalled();
    });

    it("should keep normal chat on Lambda when AGENT_RUNTIME=both and Fargate is already Running", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({
        accepted: true,
      });
      const deps = makeDeps({
        agentRuntime: "both",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        message: "hello there",
        getTaskState: vi.fn().mockResolvedValue({
          PK: "USER#user-123",
          status: "Running",
          publicIp: "1.2.3.4",
          taskArn: "arn:task",
          startedAt: "2024-01-01T00:00:00Z",
          lastActivity: "2024-01-01T00:00:00Z",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("lambda");
      expect(mockInvokeLambda).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should start Fargate when AGENT_RUNTIME=both and message has /heavy hint", async () => {
      const mockInvokeLambda = vi.fn();
      const deps = makeDeps({
        agentRuntime: "both",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        message: "/heavy do something",
        getTaskState: vi.fn().mockResolvedValue(null),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(mockInvokeLambda).not.toHaveBeenCalled();
      expect(deps.startTask).toHaveBeenCalled();
      expect(deps.savePendingMessage).toHaveBeenCalled();
      expect(deps.savePendingMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "do something",
        }),
      );
    });

    it("should route Gmail requests to Fargate when AGENT_RUNTIME=both", async () => {
      const mockInvokeLambda = vi.fn();
      const deps = makeDeps({
        agentRuntime: "both",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        message: "please read my latest gmail messages",
        getTaskState: vi.fn().mockResolvedValue(null),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(mockInvokeLambda).not.toHaveBeenCalled();
      expect(deps.startTask).toHaveBeenCalled();
      expect(deps.savePendingMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "please read my latest gmail messages",
          connectionId: "conn-1",
        }),
      );
    });

    it("should route tool-enabled requests to AgentCore when selected", async () => {
      const mockInvokeLambda = vi.fn();
      const mockInvokeAgentCore = vi.fn().mockResolvedValue({
        accepted: true,
        content: "AgentCore response",
      });
      const deps = makeDeps({
        agentRuntime: "both",
        toolRuntimeProvider: "agentcore",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        invokeAgentCoreRuntime: mockInvokeAgentCore,
        agentCoreRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123:runtime/test",
        message: "please read my latest gmail messages",
        getTaskState: vi.fn().mockResolvedValue(null),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("agentcore");
      expect(mockInvokeAgentCore).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123:runtime/test",
          runtimeClass: "tool-enabled",
          message: "please read my latest gmail messages",
        }),
      );
      expect(deps.sendClarification).toHaveBeenCalledWith("AgentCore response");
      expect(mockInvokeLambda).not.toHaveBeenCalled();
      expect(deps.startTask).not.toHaveBeenCalled();
    });

    it("should keep normal chat on Lambda when AgentCore is selected for tools", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({ accepted: true });
      const mockInvokeAgentCore = vi.fn();
      const deps = makeDeps({
        agentRuntime: "both",
        toolRuntimeProvider: "agentcore",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        invokeAgentCoreRuntime: mockInvokeAgentCore,
        agentCoreRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123:runtime/test",
        message: "hello there",
        getTaskState: vi.fn().mockResolvedValue(null),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("lambda");
      expect(mockInvokeLambda).toHaveBeenCalled();
      expect(mockInvokeAgentCore).not.toHaveBeenCalled();
    });

    it("should fallback to Fargate when AgentCore invoke fails", async () => {
      const mockInvokeAgentCore = vi.fn().mockRejectedValue(new Error("AgentCore timeout"));
      const deps = makeDeps({
        agentRuntime: "both",
        toolRuntimeProvider: "agentcore",
        invokeLambdaAgent: vi.fn(),
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        invokeAgentCoreRuntime: mockInvokeAgentCore,
        agentCoreRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123:runtime/test",
        message: "please read my latest gmail messages",
        getTaskState: vi.fn().mockResolvedValue(null),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(deps.startTask).toHaveBeenCalled();
      expect(deps.savePendingMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          routeDecision: "fargate-new",
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"agentcore.invoke.fallback\""),
      );
    });

    it("should preserve active AgentCore context instead of falling back to Fargate on follow-up timeout", async () => {
      const mockInvokeAgentCore = vi.fn().mockRejectedValue(new Error("AgentCore timeout"));
      const deps = makeDeps({
        agentRuntime: "both",
        toolRuntimeProvider: "agentcore",
        invokeLambdaAgent: vi.fn(),
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        invokeAgentCoreRuntime: mockInvokeAgentCore,
        agentCoreRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123:runtime/test",
        message: "일본관련된 것만 가져와야지",
        getTaskState: vi.fn().mockResolvedValue(null),
        getRoutingContext: vi.fn().mockResolvedValue({
          status: "active",
          channel: "web",
          connectionId: "conn-1",
          callbackUrl: "https://cb",
          createdAt: "2026-04-04T00:00:00Z",
          lastActivityAt: "2026-04-04T00:00:00Z",
          expiresAt: "2099-04-04T00:05:00Z",
          runtimeClass: "tool-enabled",
        }),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("clarify");
      expect(mockInvokeAgentCore).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "일본관련된 것만 가져와야지",
          timeoutMs: 8000,
        }),
      );
      expect(deps.sendClarification).toHaveBeenCalledWith(
        expect.stringContaining("문맥이 섞이지 않도록"),
      );
      expect(deps.savePendingMessage).not.toHaveBeenCalled();
      expect(deps.startTask).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"agentcore.invoke.context_preserved\""),
      );
    });

    it("should fallback to Fargate when AGENT_RUNTIME=both and Lambda fails", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({
        success: false,
        error: "Lambda timeout",
      });
      const deps = makeDeps({
        agentRuntime: "both",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
        getTaskState: vi.fn().mockResolvedValue(null),
      });

      const result = await routeMessage(deps);

      expect(result).toBe("started");
      expect(mockInvokeLambda).toHaveBeenCalled();
      expect(deps.startTask).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"route.lambda.fallback_to_fargate\""),
      );
    });

    it("should emit structured route logs and route metrics for Lambda requests", async () => {
      const mockInvokeLambda = vi.fn().mockResolvedValue({ accepted: true });
      const deps = makeDeps({
        agentRuntime: "lambda",
        invokeLambdaAgent: mockInvokeLambda,
        lambdaAgentFunctionArn: "arn:aws:lambda:us-east-1:123:function:agent",
      });

      const result = await routeMessage(deps);

      expect(result).toBe("lambda");
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"route.classified\""),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"classifierSignals\""),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("\"event\":\"route.lambda.invoked\""),
      );
      expect(publishGatewayCountMetricMock).toHaveBeenCalledWith("RouteToLambda", {
        channel: "web",
        runtime: "lambda",
      });
    });
  });
});
