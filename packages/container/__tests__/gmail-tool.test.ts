import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailTokenBudgetPolicy } from "@serverless-openclaw/shared";

const { decideToolIntentMock, parseToolIntentAdvisorResponseMock } = vi.hoisted(() => ({
  decideToolIntentMock: vi.fn(),
  parseToolIntentAdvisorResponseMock: vi.fn(),
}));

vi.mock("../src/tool-intent-advisor.js", () => ({
  decideToolIntent: decideToolIntentMock,
  parseToolIntentAdvisorResponse: parseToolIntentAdvisorResponseMock,
}));

import { maybeHandleCustomGmailRequest } from "../src/gmail-tool.js";

const EMAIL_BUDGET: EmailTokenBudgetPolicy = {
  mode: "headers-first",
  maxMessages: 5,
  paymentScanMessages: 25,
  maxSnippetChars: 120,
  maxBodyChars: 80,
  requireExplicitBodyAccess: true,
};
const LOW_PAYMENT_SCAN_BUDGET: EmailTokenBudgetPolicy = {
  ...EMAIL_BUDGET,
  paymentScanMessages: 5,
};

interface MockResponseOptions {
  ok?: boolean;
  status?: number;
  body: unknown;
}

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(options: MockResponseOptions) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => options.body,
  };
}

function metadataResponse(
  subject: string,
  from: string,
  date: string,
  snippet: string,
  id = "m1",
) {
  return jsonResponse({
    body: {
      id,
      threadId: `${subject}-thread`,
      snippet,
      payload: {
        headers: [
          { name: "Subject", value: subject },
          { name: "From", value: from },
          { name: "Date", value: date },
        ],
      },
    },
  });
}

function fullBodyResponse(bodyText: string) {
  return jsonResponse({
    body: {
      id: "m1",
      threadId: "t1",
      payload: {
        headers: [
          { name: "Subject", value: "3월 카드 명세서" },
          { name: "From", value: "Card Co <billing@example.com>" },
          { name: "Date", value: "Tue, 31 Mar 2026 09:00:00 +0000" },
        ],
        mimeType: "text/plain",
        body: {
          data: Buffer.from(bodyText, "utf-8").toString("base64url"),
        },
      },
    },
  });
}

describe("gmail-tool", () => {
  let tempHomeDir: string;
  let fetchMock: FetchMock;
  let originalSummaryFetchConcurrency: string | undefined;
  let originalDeterministicPaymentFastPath: string | undefined;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-tool-"));
    originalSummaryFetchConcurrency = process.env.GMAIL_SUMMARY_FETCH_CONCURRENCY;
    originalDeterministicPaymentFastPath =
      process.env.TOOL_DETERMINISTIC_PAYMENT_FAST_PATH;
    delete process.env.TOOL_DETERMINISTIC_PAYMENT_FAST_PATH;
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;
    fs.mkdirSync(path.join(tempHomeDir, ".openclaw", "credentials"), { recursive: true });
    fs.mkdirSync(path.join(tempHomeDir, ".config", "gogcli"), { recursive: true });
    fs.writeFileSync(
      path.join(tempHomeDir, ".openclaw", "credentials", "oauth.json"),
      JSON.stringify({ email: "zoown13@gmail.com", refresh_token: "refresh-token-value" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tempHomeDir, ".config", "gogcli", "credentials.json"),
      JSON.stringify({
        installed: {
          client_id: "client-id",
          client_secret: "client-secret",
        },
      }),
      "utf-8",
    );

    decideToolIntentMock.mockReset();
    decideToolIntentMock.mockResolvedValue(null);
    parseToolIntentAdvisorResponseMock.mockReset();

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    if (originalSummaryFetchConcurrency !== undefined) {
      process.env.GMAIL_SUMMARY_FETCH_CONCURRENCY = originalSummaryFetchConcurrency;
    } else {
      delete process.env.GMAIL_SUMMARY_FETCH_CONCURRENCY;
    }
    if (originalDeterministicPaymentFastPath !== undefined) {
      process.env.TOOL_DETERMINISTIC_PAYMENT_FAST_PATH =
        originalDeterministicPaymentFastPath;
    } else {
      delete process.env.TOOL_DETERMINISTIC_PAYMENT_FAST_PATH;
    }
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it("asks for clarification only when the advisor marks the source as ambiguous", async () => {
    decideToolIntentMock.mockResolvedValueOnce({
      action: "clarify_source",
      taskFamily: "gmail_payment_summary",
      sourceChoice: null,
      confidence: 0.94,
    });

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-clarify",
      sessionKey: "session-clarify",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response).toEqual({
      kind: "direct",
      message: "지메일에서 확인할까요, 아니면 일반 답변으로 도와드릴까요?",
      source: "gmail-clarification",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers payment capability questions without running a Gmail lookup", async () => {
    const events: unknown[] = [];

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-payment-capability",
      sessionKey: "session-payment-capability",
      message: "결제 이력 확인할 수 있어?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
      onToolEvent: (event) => events.push(event),
    });

    expect(response).toEqual({
      kind: "direct",
      message: expect.stringContaining("결제 이력은 지메일(Gmail) 기반 도구 런타임에서 확인할 수 있어요"),
      source: "gmail-context",
    });
    expect(response?.message).toContain("이번주 결제 이력 확인해줘");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(decideToolIntentMock).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "intentDecided",
        action: "answer_capability",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
      }),
    );
  });

  it("bounds Gmail metadata fetch concurrency for payment scans", async () => {
    process.env.GMAIL_SUMMARY_FETCH_CONCURRENCY = "2";
    let activeMetadataRequests = 0;
    let maxActiveMetadataRequests = 0;
    const messageIds = Array.from({ length: 5 }, (_, index) => `m${index + 1}`);

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({
          body: { access_token: "access-token" },
        });
      }

      if (url.includes("/messages?")) {
        return jsonResponse({
          body: {
            resultSizeEstimate: messageIds.length,
            messages: messageIds.map((id) => ({ id })),
          },
        });
      }

      const messageMatch = url.match(/\/messages\/([^?]+)/);
      if (messageMatch) {
        activeMetadataRequests += 1;
        maxActiveMetadataRequests = Math.max(maxActiveMetadataRequests, activeMetadataRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeMetadataRequests -= 1;
        const id = messageMatch[1] ?? "m1";
        const index = Number.parseInt(id.replace("m", ""), 10);
        return metadataResponse(
          "[네이버페이] 결제하신 내역을 안내해드립니다.",
          "네이버페이 <pay@example.com>",
          "Tue, 14 Apr 2026 09:00:00 +0900",
          `가맹점명 테스트상점${index} 총 결제 금액 ${index * 1000}원 결제수단 카드`,
          id,
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-concurrency",
      sessionKey: "session-concurrency",
      message: "최근 결제한 내역 알려줘",
      gmailReady: true,
      emailTokenBudget: LOW_PAYMENT_SCAN_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(maxActiveMetadataRequests).toBeLessThanOrEqual(2);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/messages?"),
      expect.anything(),
    );
  });

  it("defaults payment lookups to Gmail without requiring an explicit source mention", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-direct-payment",
      sessionKey: "session-direct-payment",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("확인 가능한 합계: KRW 12,300");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("can skip the advisor for high-confidence payment lookups when the fast path is enabled", async () => {
    process.env.TOOL_DETERMINISTIC_PAYMENT_FAST_PATH = "true";
    const toolEvents: Array<{ type: string; reason?: string; confidence?: number }> = [];
    decideToolIntentMock.mockResolvedValueOnce({
      action: "clarify_source",
      taskFamily: "gmail_payment_summary",
      sourceChoice: null,
      confidence: 0.95,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-direct-payment-fast-path",
      sessionKey: "session-direct-payment-fast-path",
      message: "최근 결제한 내역 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
      onToolEvent: (event) => toolEvents.push(event),
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("확인 가능한 합계: KRW 12,300");
    expect(fetchMock).toHaveBeenCalled();
    expect(decideToolIntentMock).not.toHaveBeenCalled();
    expect(toolEvents).not.toContainEqual(
      expect.objectContaining({ type: "handlerFallback", reason: "advisor-unavailable" }),
    );
    expect(toolEvents).toContainEqual(
      expect.objectContaining({ type: "intentDecided", confidence: 0.9 }),
    );
  });

  it("can restart an active payment context without the advisor for high-confidence fresh lookups", async () => {
    decideToolIntentMock.mockResolvedValueOnce({
      action: "gmail",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.95,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-active-payment-fast-path",
      sessionKey: "session-active-payment-fast-path",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    vi.clearAllMocks();
    process.env.TOOL_DETERMINISTIC_PAYMENT_FAST_PATH = "true";
    decideToolIntentMock.mockResolvedValueOnce({
      action: "generic_openclaw",
      taskFamily: "generic_tool_task",
      sourceChoice: "general",
      confidence: 0.99,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Sat, 04 Apr 2026 09:00:00 +0000",
          "결제금액 45,600원 카드종류 현대카드 가맹점명 교보문고",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-active-payment-fast-path",
      sessionKey: "session-active-payment-fast-path",
      message: "최근 결제한 내역 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("확인 가능한 합계: KRW 45,600");
    expect(fetchMock).toHaveBeenCalled();
    expect(decideToolIntentMock).not.toHaveBeenCalled();
  });

  it("reuses cached active payment records for repeated high-confidence fresh lookups", async () => {
    decideToolIntentMock.mockResolvedValueOnce({
      action: "gmail",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.95,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-active-payment-cache",
      sessionKey: "session-active-payment-cache",
      message: "최근 결제한 내역 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    vi.clearAllMocks();
    process.env.TOOL_DETERMINISTIC_PAYMENT_FAST_PATH = "true";

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-active-payment-cache",
      sessionKey: "session-active-payment-cache",
      message: "최근 결제한 내역 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("확인 가능한 합계는 KRW 12,300");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(decideToolIntentMock).not.toHaveBeenCalled();
  });

  it("retries transient Gmail API rate limits before failing the payment lookup", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, status: 429, body: {} }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-payment-retry",
      sessionKey: "session-payment-retry",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("확인 가능한 합계: KRW 12,300");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bridge.gmail_api.retry"));
    warnSpy.mockRestore();
  });

  it("treats compact temporal amount questions as Gmail payment lookups when Gmail is ready", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 7,700원 카드종류 신한카드 가맹점명 편의점",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-compact-payment",
      sessionKey: "session-compact-payment",
      message: "이번주는 얼마",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("확인 가능한 합계: KRW 7,700");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("expands payment metadata scans to the hard safety cap when the user explicitly asks for all results", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-expanded-payment-scan",
      sessionKey: "session-expanded-payment-scan",
      message: "이번주 결제한 금액 전체 다 봐줘. 제한 풀고 가능한 많이 확인해줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("maxResults=50");
  });

  it("starts broad payment summaries at the hard scan cap without duplicate expansion scans", async () => {
    const firstPassIds = Array.from({ length: 6 }, (_, index) => ({ id: `m${index + 1}` }));
    const expandedIds = Array.from({ length: 6 }, (_, index) => ({ id: `m${index + 1}` }));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({ body: { messages: firstPassIds, resultSizeEstimate: 12 } }),
      );

    for (const [index, item] of firstPassIds.entries()) {
      fetchMock.mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          `결제금액 ${(1000 * (index + 1)).toLocaleString("ko-KR")}원 카드종류 삼성카드 가맹점명 테스트${index + 1}`,
          item.id,
        ),
      );
    }

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ body: { messages: firstPassIds, resultSizeEstimate: 12 } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ body: { messages: expandedIds, resultSizeEstimate: 12 } }),
      );

    for (const [index, item] of expandedIds.entries()) {
      fetchMock.mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          `결제금액 ${(1000 * (index + 1)).toLocaleString("ko-KR")}원 카드종류 삼성카드 가맹점명 테스트${index + 1}`,
          item.id,
        ),
      );
    }

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-auto-expanded-payment-scan",
      sessionKey: "session-auto-expanded-payment-scan",
      message: "이번주 결제한 금액 얼마야",
      gmailReady: true,
      emailTokenBudget: LOW_PAYMENT_SCAN_BUDGET,
    });

    const listCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/messages?q="));
    expect(listCalls.some((url) => /[?&]maxResults=5(?:&|$)/.test(url))).toBe(false);
    expect(listCalls.some((url) => /[?&]maxResults=50(?:&|$)/.test(url))).toBe(true);
    expect(listCalls.some((url) => /[?&]maxResults=45(?:&|$)/.test(url))).toBe(false);
    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("스캔 범위를 자동으로 넓혔습니다");
    expect(response?.message).toContain("후보 6건을 확인");
    expect(response?.message).toContain("합계는 스캔에서 결제로 파악한 6건 전체 기준");
  });

  it("keeps natural missing-coverage follow-ups in context after a hard-cap scan", async () => {
    for (const [index, followUpMessage] of ["빠진 거 없어?", "전부 다시 봐줘"].entries()) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
        .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
        .mockResolvedValueOnce(
          metadataResponse(
            "카드 결제 알림",
            "Card Co <billing@example.com>",
            "Fri, 03 Apr 2026 09:00:00 +0000",
            "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
            "m1",
          ),
        );

      await maybeHandleCustomGmailRequest({
        userId: `user-natural-coverage-${index}`,
        sessionKey: `session-natural-coverage-${index}`,
        message: "이번주 결제한 금액 얼마야",
        gmailReady: true,
        emailTokenBudget: EMAIL_BUDGET,
      });

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
        .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
        .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }] } }))
        .mockResolvedValueOnce(
          metadataResponse(
            "카드 결제 알림",
            "Card Co <billing@example.com>",
            "Fri, 03 Apr 2026 09:00:00 +0000",
            "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
            "m1",
          ),
        )
        .mockResolvedValueOnce(
          metadataResponse(
            "카드 결제 알림",
            "Card Co <billing@example.com>",
            "Sat, 04 Apr 2026 09:00:00 +0000",
            "결제금액 45,000원 카드종류 현대카드 가맹점명 쿠팡",
            "m2",
          ),
        );

      const followUp = await maybeHandleCustomGmailRequest({
        userId: `user-natural-coverage-${index}`,
        sessionKey: `session-natural-coverage-${index}`,
        message: followUpMessage,
        gmailReady: true,
        emailTokenBudget: EMAIL_BUDGET,
      });

      const listCalls = fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.includes("/messages?q="));
      expect(listCalls.some((url) => /[?&]maxResults=50(?:&|$)/.test(url))).toBe(false);
      expect(followUp?.kind).toBe("direct");
    }
  });

  it("upgrades advisor-decided gmail_search into gmail_payment_summary for payment lookups", async () => {
    decideToolIntentMock.mockResolvedValueOnce({
      action: "gmail",
      taskFamily: "gmail_search",
      sourceChoice: "gmail",
      confidence: 0.95,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-advisor-upgrade",
      sessionKey: "session-advisor-upgrade",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("확인 가능한 합계: KRW 12,300");
    expect(response?.message).toContain("확인된 카드사: 삼성카드.");
    expect(response?.message).toContain("확인된 결제처: 스타벅스.");
  });

  it("cleans merchant names before rendering payment summaries", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "[네이버페이] 결제하신 내역을 안내해드립니다.",
          '"네이버페이" <naverpayadmin_noreply@navercorp.com>',
          "Tue, 14 Apr 2026 00:32:32 +0000",
          "결제정보 가맹점명 주식회사 굿플레이스 총 결제 금액 4460원 ㄴ 상품금액 4460원 결제수단 카드 간편결제 최종결제금액 4460원",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-clean-merchant",
      sessionKey: "session-clean-merchant",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("확인된 결제처: 주식회사 굿플레이스.");
    expect(response?.message).toContain("Snippet: 결제정보 가맹점명 주식회사 굿플레이스 총 결제 금액 4460원");
  });

  it("runs an explicit Gmail search in headers-first mode", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "3월 카드 명세서",
          "Card Company <billing@example.com>",
          "Tue, 31 Mar 2026 09:00:00 +0000",
          "March statement preview",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-search",
      sessionKey: "session-search",
      message: "지메일에서 2026/03 카드 명세서 이메일 요약해줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain('"after:2026/03/01 before:2026/04/01 카드 명세서');
    expect(response?.message).toContain("-약관");
    expect(response?.message).toContain("본문과 첨부파일은 열지 않았습니다.");
    const decodedSearchUrl = decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]));
    expect(decodedSearchUrl).toContain("after:2026/03/01 before:2026/04/01 카드 명세서");
    expect(decodedSearchUrl).toContain("-약관");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      "fields=id,threadId,snippet,payload/headers",
    );
  });

  it("builds precise Gmail date ranges for Korean relative and week-of-month payment periods", async () => {
    vi.setSystemTime(new Date("2026-05-05T12:00:00+09:00"));

    const cases = [
      {
        message: "지난주 결제한 금액 알려줘",
        expectedDateRange: "after:2026/04/27 before:2026/05/04",
      },
      {
        message: "최근 7일 결제한 금액 알려줘",
        expectedDateRange: "after:2026/04/29 before:2026/05/06",
      },
      {
        message: "4월 둘째주 결제한 금액 알려줘",
        expectedDateRange: "after:2026/04/06 before:2026/04/13",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
        .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: `m${index}` }] } }))
        .mockResolvedValueOnce(
          metadataResponse(
            "카드 결제 알림",
            "Card Co <billing@example.com>",
            "Tue, 05 May 2026 09:00:00 +0900",
            "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
            `m${index}`,
          ),
        );

      const response = await maybeHandleCustomGmailRequest({
        userId: `user-date-range-${index}`,
        sessionKey: `session-date-range-${index}`,
        message: testCase.message,
        gmailReady: true,
        emailTokenBudget: EMAIL_BUDGET,
      });

      expect(response?.kind).toBe("direct");
      const decodedQuery = decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]));
      expect(decodedQuery).toContain(testCase.expectedDateRange);
      expect(decodedQuery).toContain('{"결제금액"');
      expect(decodedQuery).toContain("-약관");
    }
  });

  it("reruns active payment context when the follow-up changes the date range", async () => {
    vi.setSystemTime(new Date("2026-05-05T12:00:00+09:00"));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Tue, 05 May 2026 09:00:00 +0900",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
          "m1",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-date-followup",
      sessionKey: "session-date-followup",
      message: "이번주 결제한 금액 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Tue, 28 Apr 2026 09:00:00 +0900",
          "결제금액 7,700원 카드종류 현대카드 가맹점명 편의점",
          "m2",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-date-followup",
      sessionKey: "session-date-followup",
      message: "지난주로 다시 봐줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    const decodedQuery = decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]));
    expect(decodedQuery).toContain("after:2026/04/27 before:2026/05/04");
    expect(decodedQuery).toContain('{"결제금액"');
    expect(response?.message).toContain("KRW 7,700");
  });

  it("confirms Gmail and then reuses parsed payment records for follow-up summaries", async () => {
    decideToolIntentMock.mockResolvedValueOnce({
      action: "gmail",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.95,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Thu, 02 Apr 2026 09:00:00 +0000",
          "결제금액 45,000원 카드종류 현대카드 가맹점명 쿠팡",
        ),
      );

    const first = await maybeHandleCustomGmailRequest({
      userId: "user-payment",
      sessionKey: "session-payment",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(first?.kind).toBe("direct");
    expect(first?.message).toContain("KRW 57,300");

    fetchMock.mockReset();

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-payment",
      sessionKey: "session-payment",
      message: "카드사별로 나눠줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("- 삼성카드: KRW 12,300 (1건)");
    expect(followUp?.message).toContain("- 현대카드: KRW 45,000 (1건)");
  });

  it("reuses the active payment context for generic contextual follow-ups", async () => {
    decideToolIntentMock.mockResolvedValueOnce({
      action: "gmail",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.95,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Thu, 02 Apr 2026 09:00:00 +0000",
          "결제금액 45,000원 카드종류 현대카드 가맹점명 쿠팡",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-contextual-followup",
      sessionKey: "session-contextual-followup",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-contextual-followup",
      sessionKey: "session-contextual-followup",
      message: "그거 표로 정리해줄래?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("주요 결제 내역:");
    expect(followUp?.message).toContain("KRW 57,300");
  });

  it("upgrades an active gmail_search context into payment summary for payment follow-ups", async () => {
    decideToolIntentMock
      .mockResolvedValueOnce({
        action: "gmail",
        taskFamily: "gmail_search",
        sourceChoice: "gmail",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        action: "continue_active_task",
        taskFamily: "gmail_search",
        sourceChoice: "gmail",
        confidence: 0.95,
      });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Thu, 02 Apr 2026 09:00:00 +0000",
          "결제금액 45,000원 카드종류 현대카드 가맹점명 쿠팡",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-upgrade-followup",
      sessionKey: "session-upgrade-followup",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-upgrade-followup",
      sessionKey: "session-upgrade-followup",
      message: "카드사별로 보여줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("카드사별로 정리");
    expect(followUp?.message).toContain("- 삼성카드: KRW 12,300 (1건)");
    expect(followUp?.message).toContain("- 현대카드: KRW 45,000 (1건)");
  });

  it("promotes active gmail_search to payment summary when the advisor chooses a payment task", async () => {
    decideToolIntentMock
      .mockResolvedValueOnce({
        action: "gmail",
        taskFamily: "gmail_search",
        sourceChoice: "gmail",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        action: "continue_active_task",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        followUpIntent: "issuer_breakdown",
        confidence: 0.92,
      });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "스타벅스 카드 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "쿠팡 카드 알림",
          "Card Co <billing@example.com>",
          "Thu, 02 Apr 2026 09:00:00 +0000",
          "결제금액 45,000원 카드종류 현대카드 가맹점명 쿠팡",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-planner-promote",
      sessionKey: "session-planner-promote",
      message: "지메일에서 스타벅스랑 쿠팡 메일 찾아줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-planner-promote",
      sessionKey: "session-planner-promote",
      message: "그걸 카드사별로 정리해줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("카드사별로 정리");
    expect(followUp?.message).toContain("- 삼성카드: KRW 12,300 (1건)");
    expect(followUp?.message).toContain("- 현대카드: KRW 45,000 (1건)");
  });

  it("uses followUpIntent to route short active-context replies into the specialized payment handler", async () => {
    decideToolIntentMock
      .mockResolvedValueOnce({
        action: "gmail",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        action: "continue_active_task",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        followUpIntent: "issuer_breakdown",
        confidence: 0.95,
      });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Thu, 02 Apr 2026 09:00:00 +0000",
          "결제금액 45,000원 카드종류 현대카드 가맹점명 쿠팡",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-followup-intent",
      sessionKey: "session-followup-intent",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-followup-intent",
      sessionKey: "session-followup-intent",
      message: "그걸로 부탁해",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("카드사별로 정리");
    expect(followUp?.message).toContain("- 삼성카드: KRW 12,300 (1건)");
    expect(followUp?.message).toContain("- 현대카드: KRW 45,000 (1건)");
  });

  it("uses advisor coverage_check to rerun active payment lookup from the canonical goal", async () => {
    decideToolIntentMock
      .mockResolvedValueOnce({
        action: "gmail",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        action: "rerun_current_task",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        followUpIntent: "coverage_check",
        confidence: 0.95,
      });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
          "m1",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-advisor-coverage-check",
      sessionKey: "session-advisor-coverage-check",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Sat, 04 Apr 2026 09:00:00 +0000",
          "결제금액 45,000원 카드종류 현대카드 가맹점명 쿠팡",
          "m2",
        ),
      );

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-advisor-coverage-check",
      sessionKey: "session-advisor-coverage-check",
      message: "결제 내역이 더 있을텐데",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("q=");
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("쿠팡");
    expect(followUp?.message).not.toContain("스타벅스");
  });

  it("uses limited body checks to improve unknown card issuer breakdowns", async () => {
    decideToolIntentMock
      .mockResolvedValueOnce({
        action: "gmail",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        action: "continue_active_task",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        followUpIntent: "issuer_breakdown",
        confidence: 0.95,
      });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "해외 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 98,590원 가맹점명 GU",
          "m1",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-issuer-body-check",
      sessionKey: "session-issuer-body-check",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        fullBodyResponse("GU 결제금액 98590원 카드종류 국민카드 해외승인"),
      );

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-issuer-body-check",
      sessionKey: "session-issuer-body-check",
      message: "카드사별로 보여줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    const bodyCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/messages/m1?format=full"),
    );
    expect(bodyCalls.length).toBeLessThanOrEqual(1);
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("- 국민카드: KRW 98,590 (1건)");
  });

  it("hands clearly unrelated active payment turns back to chat-only runtime", async () => {
    decideToolIntentMock
      .mockResolvedValueOnce({
        action: "gmail",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        action: "switch_to_chat",
        taskFamily: "generic_tool_task",
        sourceChoice: "general",
        confidence: 0.9,
      });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-chat-handoff",
      sessionKey: "session-chat-handoff",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-chat-handoff",
      sessionKey: "session-chat-handoff",
      message: "리눅스에서 파일 찾는 명령어 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp).toEqual({
      kind: "handoff",
      message: "리눅스에서 파일 찾는 명령어 알려줘",
      source: "chat-handoff",
      runtimeClass: "chat-only",
      clearToolContext: true,
    });
  });

  it("trusts advisor general handoff even when static payment keywords are present", async () => {
    decideToolIntentMock
      .mockResolvedValueOnce({
        action: "gmail",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        action: "switch_to_chat",
        taskFamily: "generic_tool_task",
        sourceChoice: "general",
        confidence: 0.9,
      });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-advisor-chat-handoff",
      sessionKey: "session-advisor-chat-handoff",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-advisor-chat-handoff",
      sessionKey: "session-advisor-chat-handoff",
      message: "운동 루틴은 얼마 정도 해야 해?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp).toEqual({
      kind: "handoff",
      message: "운동 루틴은 얼마 정도 해야 해?",
      source: "chat-handoff",
      runtimeClass: "chat-only",
      clearToolContext: true,
    });
  });

  it("keeps payment coverage follow-ups in context after a hard-cap first scan", async () => {
    decideToolIntentMock.mockResolvedValueOnce({
      action: "gmail",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.95,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Thu, 02 Apr 2026 09:00:00 +0000",
          "결제금액 45,000원 카드종류 현대카드 가맹점명 쿠팡",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Wed, 01 Apr 2026 09:00:00 +0000",
          "결제금액 2,700원 카드종류 삼성카드 가맹점명 이마트24",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Tue, 31 Mar 2026 09:00:00 +0000",
          "결제금액 1,200원 카드종류 현대카드 가맹점명 편의점",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Mon, 30 Mar 2026 09:00:00 +0000",
          "결제금액 800원 카드종류 삼성카드 가맹점명 카페",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-payment-cap",
      sessionKey: "session-payment-cap",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("maxResults=50");
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }],
            resultSizeEstimate: 5,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            messages: [
              { id: "m1" },
              { id: "m2" },
              { id: "m3" },
              { id: "m4" },
              { id: "m5" },
              { id: "m6" },
            ],
            resultSizeEstimate: 6,
          },
        }),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12,300원 카드종류 삼성카드 가맹점명 스타벅스",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Thu, 02 Apr 2026 09:00:00 +0000",
          "결제금액 45,000원 카드종류 현대카드 가맹점명 쿠팡",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Wed, 01 Apr 2026 09:00:00 +0000",
          "결제금액 2,700원 카드종류 삼성카드 가맹점명 이마트24",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Tue, 31 Mar 2026 09:00:00 +0000",
          "결제금액 1,200원 카드종류 현대카드 가맹점명 편의점",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Mon, 30 Mar 2026 09:00:00 +0000",
          "결제금액 800원 카드종류 삼성카드 가맹점명 카페",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Sun, 29 Mar 2026 09:00:00 +0000",
          "결제금액 9,900원 카드종류 우리카드 가맹점명 추가결제",
        ),
      );

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-payment-cap",
      sessionKey: "session-payment-cap",
      message: "결제 내역이 더 있을텐데",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp?.kind).toBe("direct");
  });

  it("uses the expanded hard cap on the first payment request when the user explicitly asks for it", async () => {
    decideToolIntentMock.mockResolvedValueOnce({
      action: "gmail",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.95,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }, { id: "m6" }],
          },
        }),
      );
    for (const [index, amount] of [12300, 45000, 9900, 3300, 2200, 1100].entries()) {
      fetchMock.mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          `결제금액 ${amount.toLocaleString("ko-KR")}원 카드종류 삼성카드 가맹점명 테스트${index + 1}`,
          `m${index + 1}`,
        ),
      );
    }

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-payment-first-expanded",
      sessionKey: "session-payment-first-expanded",
      message: "이번주 결제한 금액 전체로 제한 풀고 봐줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("maxResults=50");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("maxResults=45");
    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("후보 6건을 확인");
    expect(response?.message).toContain("최대 50건까지 확인하는 모드");
    expect(response?.message).toContain("합계는 스캔에서 결제로 파악한 6건 전체 기준");
  });

  it("allows an explicit deep headers-only payment scan up to 100 candidates", async () => {
    decideToolIntentMock.mockResolvedValueOnce({
      action: "gmail",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.95,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "[네이버페이] 결제하신 내역을 안내해드립니다.",
          '"네이버페이" <naverpayadmin_noreply@navercorp.com>',
          "Mon, 13 Apr 2026 03:08:14 +0000",
          "병천순대전문점 총 결제 금액 35000원 결제수단 카드 간편결제",
          "m1",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-payment-deep-scan",
      sessionKey: "session-payment-deep-scan",
      message: "이번주 결제한 금액 100건까지 더 깊게 봐줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("maxResults=100");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("maxResults=99");
    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("병천순대전문점");
  });

  it("builds a topic-aware travel payment query and excludes policy notices", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [] } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "[하나카드] 표준 전자금융거래 기본약관 외 6종 개정 안내",
          '"하나카드" <hanacard@hanacard.co.kr>',
          "Tue, 14 Apr 2026 11:09:11 +0900",
          "하나카드 표준 전자금융거래 기본약관 외 6종 약관 개정 안내",
          "m1",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "마이리얼트립(일반)의 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "결제금액 9215 원 카드종류 삼성카드 주문상품명 [eSIM/로컬] 일본 사이트",
          "m2",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-japan-query",
      sessionKey: "session-japan-query",
      message: "일본 여행가는데 결제한 내역들 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("%EC%9D%BC%EB%B3%B8");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("maxResults=10");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("maxResults=30");
    expect(response?.message).toContain("일본/여행/eSIM 관련 결제만");
    expect(response?.message).toContain("마이리얼트립(일반)");
    expect(response?.message).toContain("/ 삼성카드");
    expect(response?.message).toContain("근거:");
    expect(response?.message).not.toContain("표준 전자금융거래 기본약관");
  });

  it("automatically widens capped topic-aware travel payment scans", async () => {
    const firstPassIds = Array.from({ length: 10 }, (_, index) => ({ id: `m${index + 1}` }));
    const expandedIds = Array.from({ length: 12 }, (_, index) => ({ id: `m${index + 1}` }));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({ body: { messages: firstPassIds, resultSizeEstimate: 18 } }),
      );

    for (const [index, item] of firstPassIds.entries()) {
      fetchMock.mockResolvedValueOnce(
        metadataResponse(
          "마이리얼트립(일반)의 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          `결제금액 ${(9000 + index).toLocaleString("ko-KR")}원 카드종류 삼성카드 주문상품명 [eSIM/로컬] 일본 사이트`,
          item.id,
        ),
      );
    }

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ body: { messages: expandedIds, resultSizeEstimate: 18 } }),
    );

    for (const [index, item] of expandedIds.entries()) {
      fetchMock.mockResolvedValueOnce(
        metadataResponse(
          "마이리얼트립(일반)의 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          `결제금액 ${(9000 + index).toLocaleString("ko-KR")}원 카드종류 삼성카드 주문상품명 [eSIM/로컬] 일본 사이트`,
          item.id,
        ),
      );
    }

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-topic-auto-expanded",
      sessionKey: "session-topic-auto-expanded",
      message: "일본 여행가는데 결제한 내역들 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    const listCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/messages?q="));
    expect(listCalls.some((url) => url.includes("maxResults=10"))).toBe(true);
    expect(listCalls.some((url) => url.includes("maxResults=30"))).toBe(true);
    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("최대 30건까지 확인");
    expect(response?.message).toContain("실제로 12건을 스캔");
    expect(response?.message).toContain("합계는 찾은 12건 전체 기준");
  });

  it("filters out low-confidence daily-life merchants from travel payment summaries", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [] } }))
      .mockResolvedValueOnce(
        jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] } }),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "마이리얼트립(일반)의 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "결제금액 9215 원 카드종류 삼성카드 주문상품명 [eSIM/로컬] 일본 사이트",
          "m1",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "[네이버페이] 결제하신 내역을 안내해드립니다.",
          '"네이버페이" <naverpayadmin_noreply@navercorp.com>',
          "Tue, 14 Apr 2026 00:28:43 +0000",
          "결제정보 가맹점명 현대엔지니어링 베이커리 총 결제 금액 4460원 결제수단 카드 간편결제",
          "m2",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "[네이버페이] 결제하신 내역을 안내해드립니다.",
          '"네이버페이" <naverpayadmin_noreply@navercorp.com>',
          "Mon, 13 Apr 2026 03:08:14 +0000",
          "병천순대전문점 총 결제 금액 35000원 결제수단 카드 간편결제",
          "m3",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-travel-precision",
      sessionKey: "session-travel-precision",
      message: "일본 여행가는데 결제한 내역들 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("마이리얼트립(일반)");
    expect(response?.message).not.toContain("현대엔지니어링 베이커리");
    expect(response?.message).not.toContain("병천순대전문점");
    expect(response?.message).toContain("확인 가능한 합계: KRW 9,215 (1건)");
  });

  it("keeps destination-specific travel records such as Osaka bookings", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "KLOOK 결제 내역입니다.",
          '"KLOOK" <noreply@klook.com>',
          "Wed, 15 Apr 2026 09:15:00 +0900",
          "결제금액 18400원 카드종류 현대카드 상품명 오사카 주유패스 예약 완료",
          "m1",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-osaka-travel",
      sessionKey: "session-osaka-travel",
      message: "오사카 여행 결제 내역 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("%EC%98%A4%EC%82%AC%EC%B9%B4");
    expect(response?.message).toContain("KLOOK");
    expect(response?.message).toContain("확인 가능한 합계: KRW 18,400 (1건)");
  });

  it("restarts payment lookup when a new topic payment request arrives inside an active context", async () => {
    decideToolIntentMock
      .mockResolvedValueOnce({
        action: "gmail",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        action: "start_new_task",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.9,
      });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12300원 카드종류 삼성카드 가맹점명 스타벅스",
          "m1",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-new-topic-payment",
      sessionKey: "session-new-topic-payment",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "마이리얼트립(일반)의 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "결제금액 9215 원 카드종류 삼성카드 주문상품명 [eSIM/로컬] 일본 사이트",
          "m2",
        ),
      );

    const restarted = await maybeHandleCustomGmailRequest({
      userId: "user-new-topic-payment",
      sessionKey: "session-new-topic-payment",
      message: "일본 여행가는데 결제한 내역들 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("%EC%9D%BC%EB%B3%B8");
    expect(restarted?.kind).toBe("direct");
    expect(restarted?.message).toContain("마이리얼트립(일반)");
    expect(restarted?.message).not.toContain("스타벅스");
  });

  it("restarts explicit topic payment lookup even when the advisor labels it as topic refinement", async () => {
    decideToolIntentMock
      .mockResolvedValueOnce({
        action: "gmail",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.95,
      })
      .mockResolvedValueOnce({
        action: "refine_current_task",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        followUpIntent: "refine_topic",
        confidence: 0.95,
      });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "결제금액 12300원 카드종류 삼성카드 가맹점명 스타벅스",
          "m1",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-topic-refine-restart",
      sessionKey: "session-topic-refine-restart",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "마이리얼트립(일반)의 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "결제금액 9215 원 카드종류 삼성카드 주문상품명 [eSIM/로컬] 일본 사이트",
          "m2",
        ),
      );

    const restarted = await maybeHandleCustomGmailRequest({
      userId: "user-topic-refine-restart",
      sessionKey: "session-topic-refine-restart",
      message: "일본 여행가는데 결제한 내역들 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("%EC%9D%BC%EB%B3%B8");
    expect(restarted?.kind).toBe("direct");
    expect(restarted?.message).toContain("마이리얼트립(일반)");
    expect(restarted?.message).not.toContain("스타벅스");
  });

  it("refines an active payment context to Japan-related records without falling back", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "마이리얼트립(일반)의 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "결제금액 9215 원 카드종류 삼성카드 주문상품명 [eSIM/로컬] 일본 사이트",
          "m1",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "[네이버페이] 결제하신 내역을 안내해드립니다.",
          '"네이버페이" <naverpayadmin_noreply@navercorp.com>',
          "Mon, 13 Apr 2026 03:08:14 +0000",
          "병천순대전문점 총 결제 금액 35000원 결제수단 카드 간편결제",
          "m2",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-japan-followup",
      sessionKey: "session-japan-followup",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-japan-followup",
      sessionKey: "session-japan-followup",
      message: "일본관련된 것만 가져와야지",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("일본/여행/eSIM 관련 결제만");
    expect(followUp?.message).toContain("마이리얼트립(일반)");
    expect(followUp?.message).not.toContain("병천순대전문점");
  });

  it("uses cached generic payment records plus a limited body check for later Japan refinement", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "해외 온라인 결제 내역입니다.",
          '"Travel Data" <billing@example.com>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "결제금액 9215 원 카드종류 삼성카드 주문상품명 [로컬] 데이터 상품",
          "m1",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-japan-refine-body-from-generic",
      sessionKey: "session-japan-refine-body-from-generic",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        fullBodyResponse("주문상품명 [eSIM/로컬] 일본 사이트 결제금액 9215원 삼성카드"),
      );

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-japan-refine-body-from-generic",
      sessionKey: "session-japan-refine-body-from-generic",
      message: "일본관련된 것만 가져와야지",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/messages/m1?format=full");
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("일본/여행/eSIM 관련 결제만");
    expect(followUp?.message).toContain("확인 가능한 합계: KRW 9,215 (1건)");
    expect(followUp?.message).not.toContain("could not confidently confirm");
  });

  it("does not treat generic overseas payments as Japan-specific refinement evidence", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] } }),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "해외 온라인 결제 내역입니다.",
          '"Card Co" <billing@example.com>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "가맹점명 해외 온라인 몰 결제금액 5000원 카드종류 삼성카드",
          "m1",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "글로벌 eSIM 결제 내역입니다.",
          '"Travel Data" <billing@example.com>',
          "Sat, 04 Apr 2026 18:00:00 +0900",
          "가맹점명 글로벌 eSIM 결제금액 5000원 카드종류 삼성카드",
          "m2",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "마이리얼트립(일반)의 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "결제금액 9215 원 카드종류 삼성카드 주문상품명 [eSIM/로컬] 일본 사이트",
          "m3",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-japan-specific-refine",
      sessionKey: "session-japan-specific-refine",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-japan-specific-refine",
      sessionKey: "session-japan-specific-refine",
      message: "일본관련된 것만 가져와야지",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(followUp?.kind).toBe("direct");
    expect(followUp?.message).toContain("마이리얼트립(일반)");
    expect(followUp?.message).toContain("확인 가능한 합계: KRW 9,215 (1건)");
    expect(followUp?.message).not.toContain("해외 온라인 몰");
    expect(followUp?.message).not.toContain("글로벌 eSIM");
  });

  it("reruns a broader payment candidate search when travel refinement needs more than the first 5 headers", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "[네이버페이] 결제하신 내역을 안내해드립니다.",
          '"네이버페이" <naverpayadmin_noreply@navercorp.com>',
          "Mon, 13 Apr 2026 03:08:14 +0000",
          "병천순대전문점 총 결제 금액 35000원 결제수단 카드 간편결제",
          "m1",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-japan-rerun",
      sessionKey: "session-japan-rerun",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        fullBodyResponse("병천순대전문점 총 결제 금액 35000원 결제수단 카드 간편결제"),
      )
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [] } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "마이리얼트립(일반)의 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "결제금액 9215 원 카드종류 삼성카드 주문상품명 [eSIM/로컬] 일본 사이트",
          "m2",
        ),
      );

    const followUp = await maybeHandleCustomGmailRequest({
      userId: "user-japan-rerun",
      sessionKey: "session-japan-rerun",
      message: "일본관련된 것만 가져와야지",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(followUp?.kind).toBe("direct");
    const listCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/messages?q="));
    expect(listCalls[0]).toContain("%EC%9D%BC%EB%B3%B8");
    expect(listCalls[0]).toContain("maxResults=10");
    expect(listCalls[1]).toContain("maxResults=30");
    expect(followUp?.message).toContain("마이리얼트립(일반)");
  });

  it("uses an expanded query ladder on broad first-turn weekly spending summaries", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [], resultSizeEstimate: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }], resultSizeEstimate: 8 } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "[네이버페이] 결제하신 내역을 안내해드립니다.",
          '"네이버페이" <naverpayadmin_noreply@navercorp.com>',
          "Mon, 13 Apr 2026 03:08:14 +0000",
          "병천순대전문점 총 결제 금액 35000원 결제수단 카드 간편결제",
          "m1",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-broad-first-turn",
      sessionKey: "session-broad-first-turn",
      message: "이번주 결제한 금액 얼마야",
      gmailReady: true,
      emailTokenBudget: {
        ...EMAIL_BUDGET,
        maxMessages: 10,
        paymentScanMessages: 25,
      },
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("maxResults=50");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("maxResults=50");
    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("병천순대전문점");
  });

  it("uses at most one or two limited body checks when travel evidence is ambiguous", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "해외 온라인 결제 내역입니다.",
          '"NHN KCP 발신전용" <pgadmcust@kcp.co.kr>',
          "Sat, 04 Apr 2026 17:40:51 +0900",
          "결제금액 9215 원 카드종류 삼성카드 주문상품명 [로컬] 데이터 상품",
          "m1",
        ),
      )
      .mockResolvedValueOnce(
        fullBodyResponse("주문상품명 [eSIM/로컬] 일본 사이트 결제금액 9215원 삼성카드"),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-japan-body-check",
      sessionKey: "session-japan-body-check",
      message: "일본 여행가는데 결제한 내역들 알려줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    const bodyCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/messages/m1?format=full"),
    );
    expect(bodyCalls.length).toBeLessThanOrEqual(1);
    expect(response?.kind).toBe("direct");
    expect(response?.message).toMatch(/최대 2건까지만 짧게 본문 확인|근거:/);
  });

  it("opens one selected body from the last search context", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }, { id: "m2" }] } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "3월 카드 명세서",
          "Card Co <billing@example.com>",
          "Tue, 31 Mar 2026 09:00:00 +0000",
          "Statement snippet",
          "m1",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "3월 카드 승인내역",
          "Card Co <billing@example.com>",
          "Mon, 30 Mar 2026 09:00:00 +0000",
          "Another statement snippet",
          "m2",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-body",
      sessionKey: "session-body",
      message: "지메일에서 3월 카드 명세서 이메일 찾아줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(fullBodyResponse("A".repeat(160)));

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-body",
      sessionKey: "session-body",
      message: "1번 메일 자세히 보여줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("I opened one Gmail message body because you explicitly asked for it.");
    expect(response?.message).toContain("Subject: 3월 카드 명세서");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("messages/m1?format=full");
  });

  it("rejects attachment access before any Gmail API calls", async () => {
    const response = await maybeHandleCustomGmailRequest({
      userId: "user-attachment",
      sessionKey: "session-attachment",
      message: "지메일 첨부파일 열어줘",
      gmailReady: true,
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response?.kind).toBe("direct");
    expect(response?.message).toContain("Attachments are still disabled in this Gmail runtime.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
