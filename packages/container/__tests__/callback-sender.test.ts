import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { CallbackSender } from "../src/callback-sender.js";

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => {
  const send = vi.fn();
  return {
    ApiGatewayManagementApiClient: vi.fn().mockImplementation(() => ({ send })),
    PostToConnectionCommand: vi.fn(),
    GoneException: class GoneException extends Error {
      override name = "GoneException";
      $metadata = {};
      constructor() {
        super("Gone");
      }
    },
  };
});

describe("CallbackSender", () => {
  let sender: CallbackSender;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sender = new CallbackSender("https://example.execute-api.amazonaws.com/prod");
    const client = vi.mocked(ApiGatewayManagementApiClient);
    mockSend = (client.mock.results[0].value as { send: ReturnType<typeof vi.fn> }).send;
  });

  it("should send data to a connection successfully", async () => {
    mockSend.mockResolvedValue({});

    await sender.send("conn-123", { type: "message", content: "hello" });

    expect(PostToConnectionCommand).toHaveBeenCalledWith({
      ConnectionId: "conn-123",
      Data: JSON.stringify({ type: "message", content: "hello" }),
    });
    expect(mockSend).toHaveBeenCalled();
  });

  it("should silently ignore GoneException (disconnected client)", async () => {
    mockSend.mockRejectedValue(new GoneException());

    await expect(
      sender.send("conn-gone", { type: "message", content: "hello" }),
    ).resolves.toBeUndefined();
  });

  it("should throw on non-GoneException errors", async () => {
    mockSend.mockRejectedValue(new Error("InternalServerError"));

    await expect(
      sender.send("conn-123", { type: "message", content: "hello" }),
    ).rejects.toThrow("InternalServerError");
  });

  it("should create client with correct endpoint", () => {
    expect(ApiGatewayManagementApiClient).toHaveBeenCalledWith({
      endpoint: "https://example.execute-api.amazonaws.com/prod",
    });
  });
});

describe("CallbackSender — Telegram routing", () => {
  let sender: CallbackSender;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);
    sender = new CallbackSender(
      "https://example.execute-api.amazonaws.com/prod",
      "bot-token-123",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should buffer stream_chunk and send on stream_end", async () => {
    await sender.send("telegram:12345", { type: "stream_chunk", content: "Hello " });
    await sender.send("telegram:12345", { type: "stream_chunk", content: "world!" });

    // No Telegram API call yet
    expect(mockFetch).not.toHaveBeenCalled();

    await sender.send("telegram:12345", { type: "stream_end" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token-123/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: "12345", text: "Hello world!" }),
      },
    );
  });

  it("should emit redacted Telegram content-quality signals", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await sender.send("telegram:12345", {
      type: "stream_chunk",
      content:
        "Gmail 헤더/스니펫 기준으로 후보 12건을 확인했습니다. 본문과 첨부파일은 열지 않았습니다. 확인 가능한 합계: KRW 10,000. 확인된 카드사: 삼성카드. 일본/여행 관련 결제만 정리했습니다. 스타벅스",
    });
    await sender.send("telegram:12345", { type: "stream_end" });

    const qualityLog = consoleSpy.mock.calls
      .map(([value]) => String(value))
      .find((value) => value.includes("telegram.delivery.content_quality"));
    expect(qualityLog).toBeDefined();
    expect(qualityLog).not.toContain("스타벅스");

    const payload = JSON.parse(qualityLog ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      component: "callback",
      event: "telegram.delivery.content_quality",
      hasKoreanPaymentSummary: true,
      hasPaymentCoverageDisclosure: true,
      hasIssuerBreakdownSignal: true,
      hasTopicFilteredPaymentSignal: true,
      hasRawInternalError: false,
      hasLegacyEnglishPaymentPhrases: false,
    });

    consoleSpy.mockRestore();
  });

  it("should send error message via Telegram Bot API", async () => {
    await sender.send("telegram:12345", { type: "stream_chunk", content: "partial" });
    await sender.send("telegram:12345", {
      type: "error",
      error: "Something went wrong",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botbot-token-123/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: "12345",
          text: "Something went wrong",
        }),
      }),
    );
  });

  it("should clear buffer after stream_end", async () => {
    await sender.send("telegram:12345", { type: "stream_chunk", content: "first" });
    await sender.send("telegram:12345", { type: "stream_end" });

    // Second conversation — buffer should be empty
    await sender.send("telegram:12345", { type: "stream_chunk", content: "second" });
    await sender.send("telegram:12345", { type: "stream_end" });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(secondCallBody.text).toBe("second");
  });

  it("should clear buffer after error", async () => {
    await sender.send("telegram:12345", { type: "stream_chunk", content: "partial" });
    await sender.send("telegram:12345", { type: "error", error: "fail" });

    // Next conversation
    await sender.send("telegram:12345", { type: "stream_chunk", content: "fresh" });
    await sender.send("telegram:12345", { type: "stream_end" });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(secondCallBody.text).toBe("fresh");
  });

  it("should silently skip when no telegramBotToken is provided", async () => {
    const senderNoToken = new CallbackSender(
      "https://example.execute-api.amazonaws.com/prod",
    );

    await senderNoToken.send("telegram:12345", { type: "stream_chunk", content: "hi" });
    await senderNoToken.send("telegram:12345", { type: "stream_end" });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should split long messages at 4096 characters", async () => {
    const longText = "A".repeat(5000);
    await sender.send("telegram:12345", { type: "stream_chunk", content: longText });
    await sender.send("telegram:12345", { type: "stream_end" });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(firstBody.text).toHaveLength(4096);
    expect(secondBody.text).toHaveLength(904);
  });

  it("should not send when buffer is empty on stream_end", async () => {
    await sender.send("telegram:12345", { type: "stream_end" });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should not call @connections API for telegram connections", async () => {
    const client = vi.mocked(ApiGatewayManagementApiClient);
    const mockWsSend = (
      client.mock.results[0].value as { send: ReturnType<typeof vi.fn> }
    ).send;

    await sender.send("telegram:12345", { type: "stream_chunk", content: "hi" });
    await sender.send("telegram:12345", { type: "stream_end" });

    expect(mockWsSend).not.toHaveBeenCalled();
  });

  it("should surface fetch failure after logging it", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await sender.send("telegram:12345", { type: "stream_chunk", content: "hi" });
    await expect(
      sender.send("telegram:12345", { type: "stream_end" }),
    ).rejects.toThrow("Network error");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send Telegram message"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});
