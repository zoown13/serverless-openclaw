import fs from "node:fs";
import path from "node:path";
import type { EmailTokenBudgetPolicy, RuntimeClass } from "@serverless-openclaw/shared";

interface GmailToolOptions {
  message: string;
  runtimeClass?: RuntimeClass;
  emailTokenBudget?: EmailTokenBudgetPolicy;
  onTelemetry?: (event: GmailTelemetryEvent) => void;
}

export type GmailTelemetryEvent =
  | { event: "matched" }
  | {
    event: "queryBuilt";
    sanitizedQuery: string;
    isUnread: boolean;
    dateRange?: string;
    keywordCount: number;
  }
  | {
    event: "result";
    sanitizedQuery: string;
    outcome: "success" | "no-results";
    isUnread: boolean;
    dateRange?: string;
    keywordCount: number;
    matchedCount: number;
    inspectedCount: number;
  }
  | {
    event: "failure";
    sanitizedQuery?: string;
    reason: string;
    isUnread: boolean;
    dateRange?: string;
    keywordCount: number;
  };

interface GogOauthExport {
  email?: string;
  refresh_token?: string;
}

interface GoogleClientCredentials {
  client_id: string;
  client_secret: string;
}

interface GmailMessageListResponse {
  messages?: Array<{ id: string }>;
  resultSizeEstimate?: number;
}

interface GmailMessageMetadataResponse {
  snippet?: string;
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
  };
}

const GMAIL_HINT_RE =
  /(?:\bgmail\b|\bemail\b|\be-mail\b|\binbox\b|\bunread\b|지메일|이메일|메일(?:함)?|수신함|받은편지함|편지함|안 읽은|읽지 않은)/i;
const GMAIL_SUMMARY_RE =
  /(?:\baccess\b|\bconnect\b|\bintegrat(?:e|ion)?\b|\bfetch\b|\bload\b|\bget\b|\bcheck\b|\bshow\b|\blist\b|\bread\b|\bopen\b|\bsearch\b|\bsummar(?:ize|ise)\b|\banaly[sz]e\b|\breview\b|\btriage\b|\blatest\b|\brecent\b|\bunread\b|\binbox\b|접근|연동|연결|가져오|불러오|조회|확인|보여|봐|읽|열|검색|요약|분석|정리|최신|최근|수신함|받은편지함)/i;
const GMAIL_UNSUPPORTED_ACTION_RE =
  /(?:\bsend\b|\bcompose\b|\bdraft\b|\breply\b|\bforward\b|\bdelete\b|\barchive\b|\bwrite\b|보내|작성|답장|전달|삭제|보관)/i;
const EXPLICIT_UNREAD_RE = /(?:\bunread\b|안 읽은|읽지 않은)/i;
const TARGETED_SEARCH_RE =
  /(?:\bfind\b|\blook for\b|\bsearch\b|\bfilter\b|\bsubject\b|\bfrom\b|찾|검색|조회|필터|조건|에서)/i;
const ENGLISH_MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

interface MonthRange {
  after: string;
  before: string;
}

function isSupportedGmailSummaryRequest(message: string, runtimeClass?: RuntimeClass): boolean {
  if (runtimeClass !== "tool-enabled") {
    return false;
  }

  if (!GMAIL_HINT_RE.test(message) || !GMAIL_SUMMARY_RE.test(message)) {
    return false;
  }

  return !GMAIL_UNSUPPORTED_ACTION_RE.test(message);
}

function getHomeDir(): string {
  return process.env.HOME ?? "/home/openclaw";
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function loadOauthExport(): GogOauthExport | undefined {
  const filePath = path.join(getHomeDir(), ".openclaw", "credentials", "oauth.json");
  return readJsonFile<GogOauthExport>(filePath);
}

function loadGoogleCredentials():
  | GoogleClientCredentials
  | undefined {
  const filePath = path.join(getHomeDir(), ".config", "gogcli", "credentials.json");
  const raw = readJsonFile<Record<string, unknown>>(filePath);

  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const directClientId = raw.client_id;
  const directClientSecret = raw.client_secret;
  if (typeof directClientId === "string" && typeof directClientSecret === "string") {
    return {
      client_id: directClientId,
      client_secret: directClientSecret,
    };
  }

  for (const key of ["installed", "web"] as const) {
    const nested = raw[key];
    if (
      nested &&
      typeof nested === "object" &&
      typeof (nested as Record<string, unknown>).client_id === "string" &&
      typeof (nested as Record<string, unknown>).client_secret === "string"
    ) {
      return {
        client_id: (nested as Record<string, string>).client_id,
        client_secret: (nested as Record<string, string>).client_secret,
      };
    }
  }

  return undefined;
}

function formatQueryDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function extractMonthRange(message: string, now: Date): MonthRange | undefined {
  const explicitYear = message.match(/\b(20\d{2})\b|(?:(20\d{2})\s*년)/);
  const yearText = explicitYear?.[1] ?? explicitYear?.[2];

  let month: number | undefined;
  const koreanMonth = message.match(/\b(1[0-2]|0?[1-9])\s*월/);
  if (koreanMonth) {
    month = Number.parseInt(koreanMonth[1], 10);
  } else {
    const lower = message.toLowerCase();
    const englishMonthIndex = ENGLISH_MONTH_NAMES.findIndex((name) => lower.includes(name));
    if (englishMonthIndex >= 0) {
      month = englishMonthIndex + 1;
    }
  }

  if (!month) {
    return undefined;
  }

  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const year = yearText
    ? Number.parseInt(yearText, 10)
    : month > currentMonth
      ? currentYear - 1
      : currentYear;

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    after: formatQueryDate(start),
    before: formatQueryDate(end),
  };
}

function extractSemanticTerms(message: string): string[] {
  const terms: string[] = [];

  if (/카드/.test(message)) {
    terms.push("카드");
  }
  if (/\bcard\b/i.test(message)) {
    terms.push("card");
  }
  if (/명세서/.test(message)) {
    terms.push("명세서");
  }
  if (/\bstatement\b|\bbilling\b|\bbill\b/i.test(message)) {
    terms.push("statement");
  }
  if (/청구서/.test(message)) {
    terms.push("청구서");
  }
  if (/\binvoice\b/i.test(message)) {
    terms.push("invoice");
  }
  if (/영수증/.test(message)) {
    terms.push("영수증");
  }
  if (/\breceipt\b/i.test(message)) {
    terms.push("receipt");
  }

  return [...new Set(terms)];
}

function deriveQuery(message: string, now = new Date()): string {
  const parts: string[] = [];
  const normalized = message.toLowerCase();
  const monthRange = extractMonthRange(message, now);
  const semanticTerms = extractSemanticTerms(message);
  const targetedSearch =
    TARGETED_SEARCH_RE.test(message) || Boolean(monthRange) || semanticTerms.length > 0;

  if (EXPLICIT_UNREAD_RE.test(message) || (!targetedSearch && !/\ball\b|\bevery\b|전체|모든/.test(normalized))) {
    parts.push("is:unread");
  }

  if (monthRange) {
    parts.push(`after:${monthRange.after}`);
    parts.push(`before:${monthRange.before}`);
  } else if (/\btoday\b|오늘/.test(normalized)) {
    parts.push("newer_than:1d");
  } else if (/\bmonth\b|30d|한 달|한달/.test(normalized)) {
    parts.push("newer_than:30d");
  } else if (!targetedSearch) {
    parts.push("newer_than:7d");
  }

  parts.push(...semanticTerms);

  return parts.join(" ");
}

export function sanitizeQueryForLogs(query: string): string {
  return query
    .replace(/\S+@\S+/g, "[REDACTED]")
    .replace(/\b(?:bearer|token|access_token|refresh_token|oauth)[^\s]*/gi, "[REDACTED]")
    .replace(/\b\d{8,}\b/g, "[REDACTED]");
}

function summarizeQuery(query: string): {
  sanitizedQuery: string;
  isUnread: boolean;
  dateRange?: string;
  keywordCount: number;
} {
  const sanitizedQuery = sanitizeQueryForLogs(query);
  const tokens = query.split(/\s+/).filter(Boolean);
  const dateTokens = tokens.filter((token) =>
    /^(?:after:|before:|newer_than:)/i.test(token),
  );
  const keywordCount = tokens.filter(
    (token) =>
      !/^(?:after:|before:|newer_than:|is:unread)$/i.test(token),
  ).length;

  return {
    sanitizedQuery,
    isUnread: /\bis:unread\b/i.test(query),
    dateRange: dateTokens.length > 0 ? dateTokens.join(" ") : undefined,
    keywordCount,
  };
}

async function exchangeRefreshToken(
  refreshToken: string,
  credentials: GoogleClientCredentials,
): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10000),
  });

  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || typeof payload.access_token !== "string") {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    throw new Error(
      `Gmail token exchange failed: ${detail}. Ensure google-oauth-client-json matches the OAuth client used during gog auth add.`,
    );
  }

  return payload.access_token;
}

async function gmailGetJson<T>(accessToken: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  const payload = (await response.json()) as T & {
    error?: {
      message?: string;
    };
  };

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "error" in payload
        ? payload.error?.message
        : undefined;
    throw new Error(detail ?? `Gmail API request failed with HTTP ${response.status}`);
  }

  return payload;
}

function getHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string {
  return (
    headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ??
    "Unknown"
  );
}

function sanitizeSnippet(snippet: string | undefined, maxChars: number): string {
  const compact = (snippet ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact || "No snippet available.";
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatSummary(
  query: string,
  inspected: number,
  items: Array<{
    from: string;
    subject: string;
    date: string;
    snippet: string;
  }>,
): string {
  if (items.length === 0) {
    return `I checked Gmail headers-first with query "${query}" and found no matching messages.`;
  }

  const lines = [
    `I checked Gmail headers-first with query "${query}" and inspected ${inspected} message(s).`,
    "I did not open full bodies or attachments.",
    "",
  ];

  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.subject}`);
    lines.push(`From: ${item.from}`);
    lines.push(`Date: ${item.date}`);
    lines.push(`Snippet: ${item.snippet}`);
    if (index < items.length - 1) {
      lines.push("");
    }
  });

  return lines.join("\n");
}

export async function maybeHandleCustomGmailRequest(
  options: GmailToolOptions,
): Promise<string | undefined> {
  if (!isSupportedGmailSummaryRequest(options.message, options.runtimeClass)) {
    return undefined;
  }

  options.onTelemetry?.({ event: "matched" });

  const query = deriveQuery(options.message);
  const querySummary = summarizeQuery(query);
  options.onTelemetry?.({
    event: "queryBuilt",
    sanitizedQuery: querySummary.sanitizedQuery,
    isUnread: querySummary.isUnread,
    dateRange: querySummary.dateRange,
    keywordCount: querySummary.keywordCount,
  });

  const oauthExport = loadOauthExport();
  const refreshToken = oauthExport?.refresh_token;
  if (!refreshToken) {
    options.onTelemetry?.({
      event: "failure",
      sanitizedQuery: querySummary.sanitizedQuery,
      reason: "missing-refresh-token",
      isUnread: querySummary.isUnread,
      dateRange: querySummary.dateRange,
      keywordCount: querySummary.keywordCount,
    });
    return "Gmail is not connected in this runtime yet. I need a valid exported refresh token before I can inspect your inbox.";
  }

  const credentials = loadGoogleCredentials();
  if (!credentials) {
    options.onTelemetry?.({
      event: "failure",
      sanitizedQuery: querySummary.sanitizedQuery,
      reason: "missing-client-credentials",
      isUnread: querySummary.isUnread,
      dateRange: querySummary.dateRange,
      keywordCount: querySummary.keywordCount,
    });
    return "Gmail OAuth client credentials are missing in this runtime. I need the desktop client credentials JSON that was used during gog auth add.";
  }

  const maxMessages = options.emailTokenBudget?.maxMessages ?? 5;
  const maxSnippetChars = options.emailTokenBudget?.maxSnippetChars ?? 240;

  try {
    const accessToken = await exchangeRefreshToken(refreshToken, credentials);
    const listResponse = await gmailGetJson<GmailMessageListResponse>(
      accessToken,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxMessages}`,
    );

    const messageIds = (listResponse.messages ?? []).slice(0, maxMessages);
    if (messageIds.length === 0) {
      options.onTelemetry?.({
        event: "result",
        sanitizedQuery: querySummary.sanitizedQuery,
        outcome: "no-results",
        isUnread: querySummary.isUnread,
        dateRange: querySummary.dateRange,
        keywordCount: querySummary.keywordCount,
        matchedCount: listResponse.resultSizeEstimate ?? 0,
        inspectedCount: 0,
      });
    }

    const items = await Promise.all(
      messageIds.map(async ({ id }) => {
        const metadata = await gmailGetJson<GmailMessageMetadataResponse>(
          accessToken,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        );

        return {
          from: getHeader(metadata.payload?.headers, "From"),
          subject: getHeader(metadata.payload?.headers, "Subject"),
          date: getHeader(metadata.payload?.headers, "Date"),
          snippet: sanitizeSnippet(metadata.snippet, maxSnippetChars),
        };
      }),
    );

    if (messageIds.length > 0) {
      options.onTelemetry?.({
        event: "result",
        sanitizedQuery: querySummary.sanitizedQuery,
        outcome: "success",
        isUnread: querySummary.isUnread,
        dateRange: querySummary.dateRange,
        keywordCount: querySummary.keywordCount,
        matchedCount: listResponse.resultSizeEstimate ?? messageIds.length,
        inspectedCount: messageIds.length,
      });
    }

    return formatSummary(
      query,
      messageIds.length,
      items,
    );
  } catch (err) {
    options.onTelemetry?.({
      event: "failure",
      sanitizedQuery: querySummary.sanitizedQuery,
      reason: err instanceof Error ? err.message : "unknown-error",
      isUnread: querySummary.isUnread,
      dateRange: querySummary.dateRange,
      keywordCount: querySummary.keywordCount,
    });
    return err instanceof Error
      ? err.message
      : "Gmail request failed for an unknown reason.";
  }
}
