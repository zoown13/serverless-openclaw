import type { EmailTokenBudgetPolicy } from "@serverless-openclaw/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ddbSendMock: vi.fn(),
  decideToolIntentMock: vi.fn(),
  parseToolIntentAdvisorResponseMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(() => ({})),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DeleteCommand: vi.fn((input: unknown) => ({ input, kind: "DeleteCommand" })),
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({ send: mocks.ddbSendMock })),
  },
  GetCommand: vi.fn((input: unknown) => ({ input, kind: "GetCommand" })),
  PutCommand: vi.fn((input: unknown) => ({ input, kind: "PutCommand" })),
}));

vi.mock("../src/tool-intent-advisor.js", () => ({
  decideToolIntent: mocks.decideToolIntentMock,
  parseToolIntentAdvisorResponse: mocks.parseToolIntentAdvisorResponseMock,
}));

import { maybeHandleCustomGmailRequest } from "../src/gmail-tool.js";

const EMAIL_TOKEN_BUDGET = {
  allowBody: false,
  maxBodyChars: 0,
  maxBodyMessages: 0,
  maxMessages: 5,
} as unknown as EmailTokenBudgetPolicy;

describe("durable Gmail tool task context", () => {
  beforeEach(() => {
    mocks.ddbSendMock.mockReset();
    mocks.decideToolIntentMock.mockReset();
    mocks.parseToolIntentAdvisorResponseMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env.TOOL_CONTEXT_STORE;
    delete process.env.SETTINGS_TABLE;
  });

  it("loads active payment context from DynamoDB before handling a follow-up", async () => {
    process.env.TOOL_CONTEXT_STORE = "ddb";
    process.env.SETTINGS_TABLE = "serverless-openclaw-Settings";

    const fetchMock = vi.fn(async () => {
      throw new Error("Gmail search should not run when durable context can answer");
    });
    vi.stubGlobal("fetch", fetchMock);

    const storedContext = {
      canonicalGoal: "일본 여행 결제 내역",
      clarificationResendCount: 0,
      createdAt: "2026-04-14T00:00:00.000Z",
      expiresAt: "2099-04-14T00:05:00.000Z",
      lastActivityAt: "2026-04-14T00:00:00.000Z",
      parsedPaymentRecords: [
        {
          amount: 9215,
          cardIssuer: "삼성카드",
          confidence: 0.95,
          date: "Tue, 14 Apr 2026 10:00:00 +0900",
          from: "myrealtrip@example.com",
          isTravelRelated: true,
          matchedBy: "snippet",
          merchant: "마이리얼트립",
          messageId: "m-durable",
          snippet: "일본 eSIM 결제 9215원 삼성카드",
          source: "snippet",
          subject: "마이리얼트립 eSIM 결제",
          topicTags: ["일본", "eSIM"],
        },
      ],
      sourceChoice: "gmail",
      status: "active",
      taskFamily: "gmail_payment_summary",
      topicKeywords: ["일본", "여행", "eSIM"],
    };

    mocks.ddbSendMock.mockImplementation(async (command: { kind?: string }) => {
      if (command.kind === "GetCommand") {
        return { Item: { context: storedContext } };
      }
      return {};
    });

    const response = await maybeHandleCustomGmailRequest({
      emailTokenBudget: EMAIL_TOKEN_BUDGET,
      gmailReady: true,
      message: "카드사별로 보여줘",
      sessionKey: "telegram:8585874705",
      userId: "user-durable",
    });

    expect(response?.source).toBe("gmail-context");
    expect(response?.message).toContain("삼성카드");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.ddbSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "GetCommand" }),
    );
    expect(mocks.ddbSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "PutCommand" }),
    );
  });
});



