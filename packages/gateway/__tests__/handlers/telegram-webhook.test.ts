import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handler } from "../../src/handlers/telegram-webhook.js";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const mockRouteMessage = vi.fn();
const mockSendTelegramMessage = vi.fn();
const mockGetTaskState = vi.fn();
const mockResolveUserId = vi.fn();
const mockVerifyOtpAndLink = vi.fn();
const mockGetPendingClarification = vi.fn();
const mockPutPendingClarification = vi.fn();
const mockDeletePendingClarification = vi.fn();
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("../../src/services/message.js", () => ({
  routeMessage: (...args: unknown[]) => mockRouteMessage(...args),
  savePendingMessage: vi.fn(),
  sendToBridge: vi.fn(),
}));

vi.mock("../../src/services/task-state.js", () => ({
  getTaskState: (...args: unknown[]) => mockGetTaskState(...args),
  putTaskState: vi.fn(),
}));

vi.mock("../../src/services/telegram.js", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));

vi.mock("../../src/services/container.js", () => ({
  startTask: vi.fn(),
}));

vi.mock("../../src/services/lambda-agent.js", () => ({
  invokeLambdaAgent: vi.fn(),
}));

vi.mock("../../src/services/identity.js", () => ({
  resolveUserId: (...args: unknown[]) => mockResolveUserId(...args),
  verifyOtpAndLink: (...args: unknown[]) => mockVerifyOtpAndLink(...args),
}));

vi.mock("../../src/services/clarification.js", () => ({
  getPendingClarification: (...args: unknown[]) => mockGetPendingClarification(...args),
  putPendingClarification: (...args: unknown[]) => mockPutPendingClarification(...args),
  deletePendingClarification: (...args: unknown[]) => mockDeletePendingClarification(...args),
}));

vi.mock("../../src/services/secrets.js", () => ({
  resolveSecrets: vi.fn().mockResolvedValue(
    new Map([
      ["/serverless-openclaw/secrets/bridge-auth-token", "bridge-token"],
      ["/serverless-openclaw/secrets/telegram-bot-token", "123456:ABC-DEF"],
      ["/serverless-openclaw/secrets/telegram-webhook-secret", "my-secret"],
    ]),
  ),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: vi.fn(() => ({ send: vi.fn() })) },
  GetCommand: vi.fn(),
  PutCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(() => ({})),
}));

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn(() => ({ send: vi.fn() })),
  RunTaskCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: vi.fn(() => ({ send: vi.fn() })),
}));

function makeEvent(body: Record<string, unknown>, secretToken?: string): APIGatewayProxyEventV2 {
  return {
    headers: secretToken ? { "x-telegram-bot-api-secret-token": secretToken } : {},
    body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2;
}

describe("telegram-webhook handler", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("SSM_TELEGRAM_SECRET_TOKEN", "/serverless-openclaw/secrets/telegram-webhook-secret");
    vi.stubEnv("SSM_TELEGRAM_BOT_TOKEN", "/serverless-openclaw/secrets/telegram-bot-token");
    vi.stubEnv("ECS_CLUSTER_ARN", "arn:cluster");
    vi.stubEnv("TASK_DEFINITION_ARN", "arn:taskdef");
    vi.stubEnv("SUBNET_IDS", "subnet-1");
    vi.stubEnv("SECURITY_GROUP_IDS", "sg-1");
    vi.stubEnv("SSM_BRIDGE_AUTH_TOKEN", "/serverless-openclaw/secrets/bridge-auth-token");
    vi.stubEnv("WEBSOCKET_CALLBACK_URL", "https://api.example.com");
    mockRouteMessage.mockResolvedValue(undefined);
    mockSendTelegramMessage.mockResolvedValue(undefined);
    fetchMock.mockReset();
    mockGetTaskState.mockResolvedValue(null);
    mockResolveUserId.mockImplementation((_send: unknown, uid: string) => Promise.resolve(uid));
    mockVerifyOtpAndLink.mockResolvedValue({ error: "not set" });
    mockGetPendingClarification.mockResolvedValue(null);
    mockPutPendingClarification.mockResolvedValue(undefined);
    mockDeletePendingClarification.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("should return 403 for invalid secret token", async () => {
    const event = makeEvent({ message: { chat: { id: 123 }, text: "hi" } }, "wrong-secret");

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
    expect(mockRouteMessage).not.toHaveBeenCalled();
  });

  it("should return 403 when secret token is missing", async () => {
    const event = makeEvent({ message: { chat: { id: 123 }, text: "hi" } });

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
  });

  it("should route message with valid secret token", async () => {
    mockGetTaskState.mockResolvedValue({
      status: "Running",
      publicIp: "1.2.3.4",
    });

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "hello bot",
        },
      },
      "my-secret",
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockRouteMessage).toHaveBeenCalled();
  });

  it("should send cold start reply when no task exists", async () => {
    mockGetTaskState.mockResolvedValue(null);
    mockRouteMessage.mockResolvedValueOnce("started");

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "hello",
        },
      },
      "my-secret",
    );

    await handler(event);

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      "123456:ABC-DEF",
      "telegram:12345",
      expect.stringContaining("Waking up"),
    );
    expect(mockRouteMessage).toHaveBeenCalled();
  });

  it("should send cold start reply when task is Starting", async () => {
    mockGetTaskState.mockResolvedValue({ status: "Starting" });
    mockRouteMessage.mockResolvedValueOnce("queued");

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "hello",
        },
      },
      "my-secret",
    );

    await handler(event);

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      "123456:ABC-DEF",
      "telegram:12345",
      expect.stringContaining("Waking up"),
    );
  });

  it("should NOT send cold start reply when task is Running", async () => {
    mockGetTaskState.mockResolvedValue({
      status: "Running",
      publicIp: "1.2.3.4",
    });
    mockRouteMessage.mockResolvedValueOnce("sent");

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "hello",
        },
      },
      "my-secret",
    );

    await handler(event);

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("should return 200 for updates without message", async () => {
    const event = makeEvent({ edited_message: { chat: { id: 123 }, text: "edited" } }, "my-secret");

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockRouteMessage).not.toHaveBeenCalled();
  });

  it("should download Telegram photo uploads and route them as Lambda image input", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          ok: true,
          result: { file_path: "photos/file_1.jpg", file_size: 4 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: vi.fn().mockResolvedValue(
          Uint8Array.from([1, 2, 3, 4]).buffer,
        ),
      });

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          caption: "이 사진 분석해줘",
          photo: [
            { file_id: "photo-small", file_unique_id: "small", file_size: 4 },
            { file_id: "photo-large", file_unique_id: "large", file_size: 400_000 },
          ],
        },
      },
      "my-secret",
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockRouteMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "이 사진 분석해줘",
        imageInput: expect.objectContaining({
          source: "telegram",
          mediaType: "image/jpeg",
          dataBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
          fileId: "photo-small",
          fileUniqueId: "small",
          fileSize: 4,
          caption: "이 사진 분석해줘",
        }),
      }),
    );
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("should return a controlled unsupported message for non-photo Telegram media", async () => {
    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          caption: "이 파일 분석해줘",
          document: {
            file_id: "doc-1",
            file_name: "receipt.pdf",
            mime_type: "application/pdf",
          },
        },
      },
      "my-secret",
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      "123456:ABC-DEF",
      "telegram:12345",
      expect.stringContaining("파일 형식은 아직 지원하지 않습니다"),
    );
  });

  // ── /link command tests ──

  it("should handle /link command successfully", async () => {
    mockVerifyOtpAndLink.mockResolvedValueOnce({ cognitoUserId: "cognito-abc" });

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "/link 123456",
        },
      },
      "my-secret",
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockVerifyOtpAndLink).toHaveBeenCalledWith(expect.anything(), "67890", "123456", {
      agentRuntime: undefined,
    });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "telegram:12345",
      expect.stringContaining("linked"),
    );
    expect(mockRouteMessage).not.toHaveBeenCalled();
  });

  it("should handle /link command with error", async () => {
    mockVerifyOtpAndLink.mockResolvedValueOnce({
      error: "OTP has expired or is invalid.",
    });

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "/link 000000",
        },
      },
      "my-secret",
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "telegram:12345",
      expect.stringContaining("expired"),
    );
    expect(mockRouteMessage).not.toHaveBeenCalled();
  });

  it("should handle /link without code", async () => {
    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "/link ",
        },
      },
      "my-secret",
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "telegram:12345",
      expect.stringContaining("Usage"),
    );
    expect(mockVerifyOtpAndLink).not.toHaveBeenCalled();
  });

  it("should handle /unlink command", async () => {
    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "/unlink",
        },
      },
      "my-secret",
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "telegram:12345",
      expect.stringContaining("Web UI"),
    );
    expect(mockRouteMessage).not.toHaveBeenCalled();
  });

  it("should pass agentRuntime and Lambda deps to routeMessage", async () => {
    vi.stubEnv("AGENT_RUNTIME", "both");
    vi.stubEnv("LAMBDA_AGENT_FUNCTION_ARN", "arn:aws:lambda:us-east-1:123:function:agent");
    mockGetTaskState.mockResolvedValue({ status: "Running", publicIp: "1.2.3.4" });

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "hello",
        },
      },
      "my-secret",
    );

    await handler(event);

    const routeCall = mockRouteMessage.mock.calls[0][0];
    expect(routeCall.agentRuntime).toBe("both");
    expect(routeCall.lambdaAgentFunctionArn).toBe("arn:aws:lambda:us-east-1:123:function:agent");
    expect(routeCall.invokeLambdaAgent).toBeDefined();
  });

  it("should default agentRuntime to fargate when env not set", async () => {
    delete process.env.AGENT_RUNTIME;
    delete process.env.LAMBDA_AGENT_FUNCTION_ARN;
    mockGetTaskState.mockResolvedValue({ status: "Running", publicIp: "1.2.3.4" });

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "hello",
        },
      },
      "my-secret",
    );

    await handler(event);

    const routeCall = mockRouteMessage.mock.calls[0][0];
    expect(routeCall.agentRuntime).toBe("fargate");
    expect(routeCall.invokeLambdaAgent).toBeUndefined();
    expect(routeCall.lambdaAgentFunctionArn).toBeUndefined();
  });

  it("should resolve userId for linked telegram user", async () => {
    mockResolveUserId.mockResolvedValueOnce("cognito-abc");
    mockGetTaskState.mockResolvedValue({ status: "Running", publicIp: "1.2.3.4" });

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "hello",
        },
      },
      "my-secret",
    );

    await handler(event);

    expect(mockResolveUserId).toHaveBeenCalledWith(expect.anything(), "telegram:67890");
    expect(mockRouteMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "cognito-abc",
      }),
    );
  });

  it("should include TELEGRAM_CHAT_ID in env when userId is resolved", async () => {
    mockResolveUserId.mockResolvedValueOnce("cognito-abc");
    mockGetTaskState.mockResolvedValue(null);

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "hello",
        },
      },
      "my-secret",
    );

    await handler(event);

    const routeCall = mockRouteMessage.mock.calls[0][0];
    const env = routeCall.startTaskParams.environment;
    expect(env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TELEGRAM_CHAT_ID", value: "12345" }),
      ]),
    );
  });

  it("should not send wake-up text when routeMessage returns clarify", async () => {
    mockRouteMessage.mockResolvedValueOnce("clarify");

    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "이번주 결제한 금액이 어느정도 되려나?",
        },
      },
      "my-secret",
    );

    await handler(event);

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    expect(mockRouteMessage).toHaveBeenCalled();
  });

  it("should log Hangul diagnostics for Korean messages", async () => {
    const event = makeEvent(
      {
        message: {
          chat: { id: 12345 },
          from: { id: 67890 },
          text: "일본 여행가는데 결제한 내역들 알려줘",
        },
      },
      "my-secret",
    );

    await handler(event);

    expect(logSpy).toHaveBeenCalledWith(
      "[telegram] received message",
      expect.objectContaining({
        hasHangul: true,
        messageCodePointSample: expect.arrayContaining(["U+C77C", "U+BCF8"]),
      }),
    );
  });
});
