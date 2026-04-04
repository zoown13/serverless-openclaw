import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  maybeHandleCustomGmailRequest,
  sanitizeQueryForLogs,
} from "../src/gmail-tool.js";
import type { EmailTokenBudgetPolicy } from "@serverless-openclaw/shared";

const EMAIL_BUDGET: EmailTokenBudgetPolicy = {
  mode: "headers-first",
  maxMessages: 5,
  maxSnippetChars: 120,
  maxBodyChars: 160,
  requireExplicitBodyAccess: true,
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

function metadataResponse(subject: string, from: string, date: string, snippet: string) {
  return jsonResponse({
    body: {
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
      payload: {
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

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-tool-"));
    process.env.HOME = tempHomeDir;
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

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.HOME;
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it("redacts emails, token-like strings, and long digit runs", () => {
    const sanitized = sanitizeQueryForLogs(
      "from:zoown13@gmail.com refresh_token=abc123 bearerSecret 123456789012 after:2026/03/01",
    );

    expect(sanitized).not.toContain("zoown13@gmail.com");
    expect(sanitized).not.toContain("refresh_token=abc123");
    expect(sanitized).not.toContain("123456789012");
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain("after:2026/03/01");
  });

  it("builds a March card statement query and stays headers-first", async () => {
    const telemetry = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }], resultSizeEstimate: 1 } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "3월 카드 명세서",
          "Card Company <billing@example.com>",
          "Tue, 31 Mar 2026 09:00:00 +0000",
          "March statement preview",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-summary-march",
      sessionKey: "session-summary-march",
      message: "2026/03 카드 명세서 이메일 요약해줘",
      runtimeClass: "tool-enabled",
      emailTokenBudget: EMAIL_BUDGET,
      onTelemetry: telemetry,
    });

    expect(response).toContain('query "after:2026/03/01 before:2026/04/01 카드 명세서"');
    expect(response).toContain("I did not open full bodies or attachments.");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("after%3A2026%2F03%2F01%20before%3A2026%2F04%2F01%20%EC%B9%B4%EB%93%9C%20%EB%AA%85%EC%84%B8%EC%84%9C");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("format=full"))).toBe(false);
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ event: "queryBuilt" }));
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "result",
        outcome: "success",
        matchedCount: 1,
        inspectedCount: 1,
      }),
    );
  });

  it("maps last-month receipt requests to the previous month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T09:00:00Z"));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }], resultSizeEstimate: 1 } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "지난달 영수증",
          "Store <receipt@example.com>",
          "Mon, 30 Mar 2026 09:00:00 +0000",
          "Receipt preview",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-last-month",
      sessionKey: "session-last-month",
      message: "지난달 영수증 메일 요약해줘",
      runtimeClass: "tool-enabled",
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response).toContain('query "after:2026/03/01 before:2026/04/01 영수증"');
    expect(fetchMock.mock.calls[1]?.[0]).toContain("after%3A2026%2F03%2F01%20before%3A2026%2F04%2F01%20%EC%98%81%EC%88%98%EC%A6%9D");
  });

  it("refines sender unread requests into a Gmail from query", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }], resultSizeEstimate: 1 } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "Amazon order update",
          "Amazon <shipment@amazon.com>",
          "Wed, 01 Apr 2026 09:00:00 +0000",
          "Amazon preview",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-amazon",
      sessionKey: "session-amazon",
      message: "Amazon에서 온 unread 메일 찾아줘",
      runtimeClass: "tool-enabled",
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock.mock.calls[1]?.[0]).toContain("is%3Aunread%20from%3AAmazon");
  });

  it("refines subject queries when the user names a title keyword", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(jsonResponse({ body: { messages: [{ id: "m1" }], resultSizeEstimate: 1 } }))
      .mockResolvedValueOnce(
        metadataResponse(
          "Invoice for March",
          "Vendor <invoice@example.com>",
          "Thu, 02 Apr 2026 09:00:00 +0000",
          "Invoice preview",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-subject",
      sessionKey: "session-subject",
      message: "제목에 invoice 포함된 메일 찾아줘",
      runtimeClass: "tool-enabled",
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock.mock.calls[1]?.[0]).toContain("subject%3Ainvoice");
  });

  it("routes weekly payment amount questions to Gmail search and estimates totals from headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T09:00:00Z"));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            messages: [{ id: "m1" }, { id: "m2" }],
            resultSizeEstimate: 2,
          },
        }),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림 12,300원",
          "Card Co <billing@example.com>",
          "Fri, 03 Apr 2026 09:00:00 +0000",
          "이번주 사용금액 12,300원 승인",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "카드 결제 알림 45,000원",
          "Card Co <billing@example.com>",
          "Thu, 02 Apr 2026 09:00:00 +0000",
          "이번주 사용금액 45,000원 승인",
        ),
      );

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-payment-summary",
      sessionKey: "session-payment-summary",
      message: "이번주 결제한 금액이 어느정도 되려나?",
      runtimeClass: "tool-enabled",
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      "after%3A2026%2F03%2F30%20before%3A2026%2F04%2F06%20%EA%B2%B0%EC%A0%9C",
    );
    expect(response).toContain(
      "Estimated total from visible headers/snippets: KRW 57,300 across 2 matched message(s).",
    );
    expect(response).toContain("I did not open full bodies or attachments.");
  });

  it("opens one selected body from the last search context and respects the body budget", async () => {
    const longBody = "A".repeat(200);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            messages: [{ id: "m1" }, { id: "m2" }],
            resultSizeEstimate: 2,
          },
        }),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "3월 카드 명세서",
          "Card Co <billing@example.com>",
          "Tue, 31 Mar 2026 09:00:00 +0000",
          "Statement snippet",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "3월 카드 승인내역",
          "Card Co <billing@example.com>",
          "Mon, 30 Mar 2026 09:00:00 +0000",
          "Another statement snippet",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-body-ordinal",
      sessionKey: "session-body-ordinal",
      message: "3월 카드 명세서 이메일 찾아줘",
      runtimeClass: "tool-enabled",
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(fullBodyResponse(longBody));

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-body-ordinal",
      sessionKey: "session-body-ordinal",
      message: "1번 메일 자세히 보여줘",
      runtimeClass: "tool-enabled",
      emailTokenBudget: { ...EMAIL_BUDGET, maxBodyChars: 40 },
    });

    expect(response).toContain("I opened one Gmail message body after narrowing the request safely.");
    expect(response).toContain("Subject: 3월 카드 명세서");
    expect(response).toContain("I did not inspect attachments.");
    expect(response).toContain(`${"A".repeat(39)}…`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("messages/m1?format=full");
  });

  it("asks for clarification when a body request matches multiple prior results", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          body: {
            messages: [{ id: "m1" }, { id: "m2" }],
            resultSizeEstimate: 2,
          },
        }),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "Invoice for March",
          "Vendor A <invoice-a@example.com>",
          "Tue, 31 Mar 2026 09:00:00 +0000",
          "Invoice A snippet",
        ),
      )
      .mockResolvedValueOnce(
        metadataResponse(
          "Invoice follow-up",
          "Vendor B <invoice-b@example.com>",
          "Mon, 30 Mar 2026 09:00:00 +0000",
          "Invoice B snippet",
        ),
      );

    await maybeHandleCustomGmailRequest({
      userId: "user-ambiguous",
      sessionKey: "session-ambiguous",
      message: "invoice 메일 찾아줘",
      runtimeClass: "tool-enabled",
      emailTokenBudget: EMAIL_BUDGET,
    });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse({ body: { access_token: "access-token" } }));

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-ambiguous",
      sessionKey: "session-ambiguous",
      message: "invoice 메일 자세히 보여줘",
      runtimeClass: "tool-enabled",
      emailTokenBudget: EMAIL_BUDGET,
    });

    expect(response).toContain("I found multiple matching Gmail messages.");
    expect(response).toContain("1. Invoice for March");
    expect(response).toContain("2. Invoice follow-up");
    expect(response).toContain("1번 메일 자세히 보여줘");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("format=full"))).toBe(false);
  });

  it("rejects attachment access before any Gmail API calls", async () => {
    const telemetry = vi.fn();

    const response = await maybeHandleCustomGmailRequest({
      userId: "user-attachment",
      sessionKey: "session-attachment",
      message: "지메일 첨부파일 열어줘",
      runtimeClass: "tool-enabled",
      emailTokenBudget: EMAIL_BUDGET,
      onTelemetry: telemetry,
    });

    expect(response).toContain("Gmail attachment access is disabled in this runtime.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(telemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "failure",
        reason: "attachment-access-disabled",
      }),
    );
  });
});
