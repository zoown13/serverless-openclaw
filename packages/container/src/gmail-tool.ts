import fs from "node:fs";
import path from "node:path";
import type { EmailTokenBudgetPolicy, RuntimeClass } from "@serverless-openclaw/shared";

interface GmailToolOptions {
  userId?: string;
  sessionKey?: string;
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

interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  body?: {
    data?: string;
  };
  parts?: GmailPayloadPart[];
  headers?: Array<{ name?: string; value?: string }>;
}

interface GmailMessageResponse {
  snippet?: string;
  payload?: GmailPayloadPart;
}

interface GmailMessageSummaryItem {
  messageId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

interface GmailSearchContextItem {
  ordinal: number;
  messageId: string;
  from: string;
  subject: string;
  date: string;
}

interface GmailSearchContext {
  query: string;
  items: GmailSearchContextItem[];
  updatedAt: string;
}

interface DateRange {
  after: string;
  before: string;
}

const GMAIL_HINT_RE =
  /(?:\bgmail\b|\bemail\b|\be-mail\b|\binbox\b|\bunread\b|지메일|이메일|메일(?:함)?|수신함|받은편지함|편지함|안 읽은|읽지 않은)/i;
const GMAIL_SUMMARY_RE =
  /(?:\baccess\b|\bconnect\b|\bintegrat(?:e|ion)?\b|\bfetch\b|\bload\b|\bget\b|\bcheck\b|\bshow\b|\blist\b|\bread\b|\bopen\b|\bsearch\b|\bfind\b|\blook for\b|\bfilter\b|\bsummar(?:ize|ise)\b|\banaly[sz]e\b|\breview\b|\btriage\b|\blatest\b|\brecent\b|\bunread\b|\binbox\b|접근|연동|연결|가져오|불러오|조회|확인|보여|봐|읽|열|검색|요약|분석|정리|최신|최근|수신함|받은편지함|찾)/i;
const PAYMENT_DATA_RE =
  /(?:결제|지출|사용금액|사용 금액|승인내역|카드값|카드\s*(?:사용|결제)|청구서|영수증|명세서|\bpayment(?:s)?\b|\bcharge(?:s|d)?\b|\btransaction(?:s)?\b|\bspent\b|\bspend\b|\bbilling\b|\binvoice\b|\breceipt\b|\bstatement\b)/i;
const PAYMENT_SUMMARY_RE =
  /(?:얼마|총액|합계|총합|어느 정도|어느정도|얼마나|계산|정리|요약|찾|알려|보여|확인|\bhow much\b|\btotal\b|\bsum\b|\bcalculate\b|\bshow\b|\bcheck\b|\bfind\b)/i;
const GMAIL_UNSUPPORTED_ACTION_RE =
  /(?:\bsend\b|\bcompose\b|\bdraft\b|\breply\b|\bforward\b|\bdelete\b|\barchive\b|\bwrite\b|보내|작성|답장|전달|삭제|보관)/i;
const ATTACHMENT_REQUEST_RE =
  /(?:\battachment\b|\battachments\b|\bpdf\b|\bfile\b|첨부|첨부파일|파일|pdf)/i;
const BODY_REQUEST_RE =
  /(?:\bbody\b|\bcontent\b|\bdetails?\b|\bdetailed\b|\bfull\s+body\b|\bopen\b|\bread\b|\bshow\b|본문|내용|자세히|상세|열어|읽어|보여)/i;
const EXPLICIT_UNREAD_RE = /(?:\bunread\b|안 읽은|읽지 않은)/i;
const ALL_MESSAGES_RE = /(?:\ball\b|\bevery\b|전체|모든)/i;
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

const lastSearchContextByUser = new Map<string, GmailSearchContext>();

function buildContextKey(
  userId: string | undefined,
  sessionKey: string | undefined,
): string | undefined {
  if (!userId) {
    return undefined;
  }

  return sessionKey
    ? `${userId}:${sessionKey}`
    : userId;
}

function isSupportedGmailSummaryRequest(message: string, runtimeClass?: RuntimeClass): boolean {
  if (runtimeClass !== "tool-enabled") {
    return false;
  }

  const looksLikeGmailSummary =
    GMAIL_HINT_RE.test(message) && GMAIL_SUMMARY_RE.test(message);
  const looksLikePaymentSummary =
    PAYMENT_DATA_RE.test(message) && PAYMENT_SUMMARY_RE.test(message);

  if (!looksLikeGmailSummary && !looksLikePaymentSummary) {
    return false;
  }

  return !GMAIL_UNSUPPORTED_ACTION_RE.test(message);
}

function isExplicitBodyRequest(message: string): boolean {
  return BODY_REQUEST_RE.test(message);
}

function isAttachmentRequest(message: string): boolean {
  return ATTACHMENT_REQUEST_RE.test(message);
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

function getStartOfUtcWeek(date: Date): Date {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = start.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  start.setUTCDate(start.getUTCDate() - diff);
  return start;
}

function extractExplicitMonthRange(message: string, now: Date): DateRange | undefined {
  const explicitYearMonth = message.match(/\b(20\d{2})[/.-](1[0-2]|0?[1-9])\b/);
  if (explicitYearMonth) {
    const year = Number.parseInt(explicitYearMonth[1], 10);
    const month = Number.parseInt(explicitYearMonth[2], 10);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    return {
      after: formatQueryDate(start),
      before: formatQueryDate(end),
    };
  }

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

function extractDateRange(message: string, now: Date): DateRange | undefined {
  const explicitMonth = extractExplicitMonthRange(message, now);
  if (explicitMonth) {
    return explicitMonth;
  }

  const normalized = message.toLowerCase();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (/\btoday\b|오늘/.test(normalized)) {
    const end = new Date(todayStart);
    end.setUTCDate(end.getUTCDate() + 1);
    return {
      after: formatQueryDate(todayStart),
      before: formatQueryDate(end),
    };
  }

  if (/\byesterday\b|어제/.test(normalized)) {
    const start = new Date(todayStart);
    start.setUTCDate(start.getUTCDate() - 1);
    return {
      after: formatQueryDate(start),
      before: formatQueryDate(todayStart),
    };
  }

  if (/\bthis week\b|이번 주|이번주/.test(normalized)) {
    const start = getStartOfUtcWeek(now);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return {
      after: formatQueryDate(start),
      before: formatQueryDate(end),
    };
  }

  if (/\bthis month\b|이번 달|이번달/.test(normalized)) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return {
      after: formatQueryDate(start),
      before: formatQueryDate(end),
    };
  }

  if (/\blast month\b|지난달|저번 달|저번달|전월/.test(normalized)) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return {
      after: formatQueryDate(start),
      before: formatQueryDate(end),
    };
  }

  return undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeMatchText(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function dedupeTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => normalizeWhitespace(term)).filter(Boolean))];
}

function extractFromTerms(message: string): string[] {
  const terms: string[] = [];

  const englishFrom = message.match(/\bfrom\s+["']?([^"'\n]+?)["']?(?=\s+(?:email|gmail|mail|message|messages|subject|body|summary|search|show|open|read)|$)/i);
  if (englishFrom) {
    terms.push(englishFrom[1]);
  }

  const koreanFrom = message.match(/(.+?)에서\s+온(?:\s+(?:메일|이메일|지메일))?/);
  if (koreanFrom) {
    terms.push(koreanFrom[1]);
  }

  const senderField = message.match(/보낸사람(?:은|이|:)?\s*["']?(.+?)["']?(?=\s*(?:메일|이메일|지메일|본문|내용|요약|검색|조회|확인|보여|$))/);
  if (senderField) {
    terms.push(senderField[1]);
  }

  return dedupeTerms(terms);
}

function extractSubjectTerms(message: string): string[] {
  const terms: string[] = [];

  const englishSubject = message.match(/\bsubject\s*(?::|contains)?\s*["']?([^"'\n]+?)["']?(?=\s+(?:email|gmail|mail|message|messages|body|summary|search|show|open|read)|$)/i);
  if (englishSubject) {
    terms.push(englishSubject[1]);
  }

  const koreanSubjectContains = message.match(/제목(?:에)?\s*["']?(.+?)["']?\s*(?:포함|들어간|있는)/);
  if (koreanSubjectContains) {
    terms.push(koreanSubjectContains[1]);
  }

  const koreanSubjectField = message.match(/제목(?:은|이|:)?\s*["']?(.+?)["']?(?=\s*(?:메일|이메일|본문|내용|요약|검색|조회|확인|보여|$))/);
  if (koreanSubjectField) {
    terms.push(koreanSubjectField[1]);
  }

  return dedupeTerms(terms);
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
  if (/결제|승인내역|사용금액|사용 금액/.test(message)) {
    terms.push("결제");
  }
  if (/\bpayment(?:s)?\b|\bcharge(?:s|d)?\b|\btransaction(?:s)?\b/i.test(message)) {
    terms.push("payment");
  }

  return dedupeTerms(terms);
}

function formatQueryToken(term: string): string {
  const cleaned = normalizeWhitespace(term).replace(/"/g, "");
  if (!cleaned) {
    return "";
  }
  return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function deriveQuery(message: string, now = new Date()): string {
  const parts: string[] = [];
  const normalized = message.toLowerCase();
  const dateRange = extractDateRange(message, now);
  const semanticTerms = extractSemanticTerms(message);
  const fromTerms = extractFromTerms(message);
  const subjectTerms = extractSubjectTerms(message);
  const targetedSearch =
    TARGETED_SEARCH_RE.test(message) ||
    Boolean(dateRange) ||
    semanticTerms.length > 0 ||
    fromTerms.length > 0 ||
    subjectTerms.length > 0;

  if (EXPLICIT_UNREAD_RE.test(message) || (!targetedSearch && !ALL_MESSAGES_RE.test(normalized))) {
    parts.push("is:unread");
  }

  if (dateRange) {
    parts.push(`after:${dateRange.after}`);
    parts.push(`before:${dateRange.before}`);
  } else if (!targetedSearch) {
    parts.push("newer_than:7d");
  }

  parts.push(
    ...fromTerms
      .map((term) => formatQueryToken(term))
      .filter(Boolean)
      .map((term) => `from:${term}`),
  );
  parts.push(
    ...subjectTerms
      .map((term) => formatQueryToken(term))
      .filter(Boolean)
      .map((term) => `subject:${term}`),
  );
  parts.push(
    ...semanticTerms
      .map((term) => formatQueryToken(term))
      .filter(Boolean),
  );

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

function sanitizePreview(text: string | undefined, maxChars: number): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact || "No preview available.";
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function extractPaymentAmount(text: string): number | undefined {
  const patterns = [
    /₩\s*(\d{1,3}(?:,\d{3})+|\d+)/g,
    /\bKRW\s*(\d{1,3}(?:,\d{3})+|\d+)\b/gi,
    /(\d{1,3}(?:,\d{3})+|\d+)\s*원/g,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) {
      continue;
    }

    const numeric = Number.parseInt(match[1].replace(/,/g, ""), 10);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return undefined;
}

function formatPaymentEstimate(items: GmailMessageSummaryItem[]): string | undefined {
  const amounts = items
    .map((item) => extractPaymentAmount(`${item.subject} ${item.snippet}`))
    .filter((value): value is number => value !== undefined);

  if (amounts.length === 0) {
    return undefined;
  }

  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  const formatted = new Intl.NumberFormat("en-US").format(total);
  return `Estimated total from visible headers/snippets: KRW ${formatted} across ${amounts.length} matched message(s). This is a rough headers-first estimate only.`;
}

function formatSummary(
  query: string,
  inspected: number,
  items: GmailMessageSummaryItem[],
  options?: {
    includePaymentEstimate?: boolean;
  },
): string {
  if (items.length === 0) {
    return `I checked Gmail headers-first with query "${query}" and found no matching messages.`;
  }

  const paymentEstimate = options?.includePaymentEstimate
    ? formatPaymentEstimate(items)
    : undefined;
  const lines = [
    `I checked Gmail headers-first with query "${query}" and inspected ${inspected} message(s).`,
    "I did not open full bodies or attachments.",
  ];
  if (paymentEstimate) {
    lines.push(paymentEstimate);
  }
  lines.push("");

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

function formatNoResults(
  query: string,
  options?: { paymentSummary?: boolean },
): string {
  if (options?.paymentSummary) {
    return `I checked Gmail headers-first with query "${query}" and found no payment emails I could use safely. Try narrowing by period, sender, or card company.`;
  }

  return `I checked Gmail headers-first with query "${query}" and found no matching messages.`;
}

function encodeContextItems(items: GmailMessageSummaryItem[]): GmailSearchContextItem[] {
  return items.map((item, index) => ({
    ordinal: index + 1,
    messageId: item.messageId,
    from: item.from,
    subject: item.subject,
    date: item.date,
  }));
}

function saveSearchContext(
  userId: string | undefined,
  sessionKey: string | undefined,
  query: string,
  items: GmailMessageSummaryItem[],
): void {
  const contextKey = buildContextKey(userId, sessionKey);
  if (!contextKey) {
    return;
  }

  lastSearchContextByUser.set(contextKey, {
    query,
    items: encodeContextItems(items),
    updatedAt: new Date().toISOString(),
  });
}

function saveNarrowedContext(
  userId: string | undefined,
  sessionKey: string | undefined,
  items: GmailSearchContextItem[],
  query: string,
): void {
  const contextKey = buildContextKey(userId, sessionKey);
  if (!contextKey) {
    return;
  }

  lastSearchContextByUser.set(contextKey, {
    query,
    items: items.map((item, index) => ({
      ...item,
      ordinal: index + 1,
    })),
    updatedAt: new Date().toISOString(),
  });
}

async function listMessageIds(
  accessToken: string,
  query: string,
  maxResults: number,
): Promise<GmailMessageListResponse> {
  return gmailGetJson<GmailMessageListResponse>(
    accessToken,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
  );
}

async function loadMessageSummaries(
  accessToken: string,
  messageIds: Array<{ id: string }>,
  maxSnippetChars: number,
): Promise<GmailMessageSummaryItem[]> {
  return Promise.all(
    messageIds.map(async ({ id }) => {
      const metadata = await gmailGetJson<GmailMessageResponse>(
        accessToken,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      );

      return {
        messageId: id,
        from: getHeader(metadata.payload?.headers, "From"),
        subject: getHeader(metadata.payload?.headers, "Subject"),
        date: getHeader(metadata.payload?.headers, "Date"),
        snippet: sanitizePreview(metadata.snippet, maxSnippetChars),
      };
    }),
  );
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf-8");
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function extractTextFromPayload(payload: GmailPayloadPart | undefined): string {
  if (!payload) {
    return "";
  }

  const currentType = payload.mimeType?.toLowerCase();
  const hasAttachment = Boolean(payload.filename);
  const currentBody = payload.body?.data
    ? decodeBase64Url(payload.body.data)
    : "";

  if (!hasAttachment && currentType?.startsWith("text/plain") && currentBody) {
    return currentBody;
  }

  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      const nested = extractTextFromPayload(part);
      if (nested) {
        return nested;
      }
    }
  }

  if (!hasAttachment && currentType?.startsWith("text/html") && currentBody) {
    return stripHtml(currentBody);
  }

  return !hasAttachment ? currentBody : "";
}

function truncateBodyPreview(text: string, maxChars: number): string {
  return sanitizePreview(text, maxChars);
}

async function loadMessageBodyPreview(
  accessToken: string,
  messageId: string,
  maxBodyChars: number,
): Promise<string> {
  const full = await gmailGetJson<GmailMessageResponse>(
    accessToken,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
  );

  const extracted = extractTextFromPayload(full.payload);
  if (!extracted) {
    return "No readable plain-text body was available for this message.";
  }

  return truncateBodyPreview(extracted, maxBodyChars);
}

function formatBodyResponse(item: GmailSearchContextItem, bodyPreview: string): string {
  return [
    "I opened one Gmail message body after narrowing the request safely.",
    "I did not inspect attachments.",
    "",
    `Subject: ${item.subject}`,
    `From: ${item.from}`,
    `Date: ${item.date}`,
    `Body preview: ${bodyPreview}`,
  ].join("\n");
}

function formatDisambiguationResponse(items: GmailSearchContextItem[]): string {
  const lines = [
    "I found multiple matching Gmail messages. Tell me which one to open by number.",
    "I can read the body of one message only.",
    "",
  ];

  items.forEach((item) => {
    lines.push(`${item.ordinal}. ${item.subject}`);
    lines.push(`From: ${item.from}`);
    lines.push(`Date: ${item.date}`);
    lines.push("");
  });

  lines.push("Reply with something like '1번 메일 자세히 보여줘'.");
  return lines.join("\n");
}

function extractSelectionOrdinal(message: string): number | undefined {
  const koreanOrdinal = message.match(/(?:^|\s)(\d+)\s*번/);
  if (koreanOrdinal) {
    return Number.parseInt(koreanOrdinal[1], 10);
  }

  const englishOrdinal = message.match(/\b(\d+)(?:st|nd|rd|th)\b/i);
  if (englishOrdinal) {
    return Number.parseInt(englishOrdinal[1], 10);
  }

  const ordinalWords: Array<[RegExp, number]> = [
    [/\bfirst\b|첫 번째|첫번째|첫 메일/i, 1],
    [/\bsecond\b|두 번째|두번째/i, 2],
    [/\bthird\b|세 번째|세번째/i, 3],
  ];

  for (const [pattern, value] of ordinalWords) {
    if (pattern.test(message)) {
      return value;
    }
  }

  return undefined;
}

function headerDateMatchesRange(date: string, range: DateRange): boolean {
  const parsed = Date.parse(date);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  const start = Date.parse(`${range.after}T00:00:00Z`);
  const end = Date.parse(`${range.before}T00:00:00Z`);
  return parsed >= start && parsed < end;
}

function narrowContextItems(
  message: string,
  context: GmailSearchContext,
): GmailSearchContextItem[] {
  const ordinal = extractSelectionOrdinal(message);
  if (ordinal !== undefined) {
    return context.items.filter((item) => item.ordinal === ordinal);
  }

  let candidates = context.items.slice();

  const subjectTerms = extractSubjectTerms(message).map(normalizeMatchText);
  if (subjectTerms.length > 0) {
    candidates = candidates.filter((item) => {
      const subject = normalizeMatchText(item.subject);
      return subjectTerms.some((term) => subject.includes(term));
    });
  }

  const fromTerms = extractFromTerms(message).map(normalizeMatchText);
  if (fromTerms.length > 0) {
    candidates = candidates.filter((item) => {
      const from = normalizeMatchText(item.from);
      return fromTerms.some((term) => from.includes(term));
    });
  }

  const dateRange = extractDateRange(message, new Date());
  if (dateRange) {
    candidates = candidates.filter((item) => headerDateMatchesRange(item.date, dateRange));
  }

  return candidates;
}

function buildSearchFirstResponse(): string {
  return "I need a recent Gmail result set before I can open one message body. Ask me to search your inbox first, then tell me which result number to open.";
}

async function readExplicitBodyFromSelection(
  options: GmailToolOptions,
  accessToken: string,
  maxBodyChars: number,
): Promise<string | undefined> {
  const contextKey = buildContextKey(options.userId, options.sessionKey);
  const context = contextKey ? lastSearchContextByUser.get(contextKey) : undefined;
  if (!context) {
    return undefined;
  }

  const narrowed = narrowContextItems(options.message, context);
  if (narrowed.length === 0) {
    return undefined;
  }

  if (narrowed.length > 1) {
    saveNarrowedContext(options.userId, options.sessionKey, narrowed, context.query);
    return formatDisambiguationResponse(
      narrowed.map((item, index) => ({
        ...item,
        ordinal: index + 1,
      })),
    );
  }

  const selected = narrowed[0];
  const bodyPreview = await loadMessageBodyPreview(accessToken, selected.messageId, maxBodyChars);
  return formatBodyResponse(selected, bodyPreview);
}

async function resolveExplicitBodyRequest(
  options: GmailToolOptions,
  accessToken: string,
  maxMessages: number,
  maxSnippetChars: number,
  maxBodyChars: number,
): Promise<string> {
  const fromContext = await readExplicitBodyFromSelection(options, accessToken, maxBodyChars);
  if (fromContext) {
    return fromContext;
  }

  if (!GMAIL_HINT_RE.test(options.message)) {
    return buildSearchFirstResponse();
  }

  const query = deriveQuery(options.message);
  const querySummary = summarizeQuery(query);
  options.onTelemetry?.({
    event: "queryBuilt",
    sanitizedQuery: querySummary.sanitizedQuery,
    isUnread: querySummary.isUnread,
    dateRange: querySummary.dateRange,
    keywordCount: querySummary.keywordCount,
  });

  const listResponse = await listMessageIds(accessToken, query, Math.min(maxMessages, 5));
  const messageIds = listResponse.messages ?? [];
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
    return `I couldn't find a Gmail message body to open with query "${query}".`;
  }

  const items = await loadMessageSummaries(accessToken, messageIds, maxSnippetChars);
  saveSearchContext(options.userId, options.sessionKey, query, items);

  options.onTelemetry?.({
    event: "result",
    sanitizedQuery: querySummary.sanitizedQuery,
    outcome: "success",
    isUnread: querySummary.isUnread,
    dateRange: querySummary.dateRange,
    keywordCount: querySummary.keywordCount,
    matchedCount: listResponse.resultSizeEstimate ?? items.length,
    inspectedCount: items.length,
  });

  if (items.length > 1) {
    return formatDisambiguationResponse(
      encodeContextItems(items),
    );
  }

  const only = encodeContextItems(items)[0];
  const bodyPreview = await loadMessageBodyPreview(accessToken, only.messageId, maxBodyChars);
  return formatBodyResponse(only, bodyPreview);
}

export async function maybeHandleCustomGmailRequest(
  options: GmailToolOptions,
): Promise<string | undefined> {
  if (options.runtimeClass !== "tool-enabled") {
    return undefined;
  }

  const contextKey = buildContextKey(options.userId, options.sessionKey);
  const hasContext = contextKey
    ? lastSearchContextByUser.has(contextKey)
    : false;
  const isBodyRequest = isExplicitBodyRequest(options.message) && (GMAIL_HINT_RE.test(options.message) || hasContext);
  const isSummaryRequest = isSupportedGmailSummaryRequest(options.message, options.runtimeClass);
  const isAttachmentOnlyRequest =
    isAttachmentRequest(options.message) && (GMAIL_HINT_RE.test(options.message) || hasContext);
  const isPaymentSummary =
    PAYMENT_DATA_RE.test(options.message) && PAYMENT_SUMMARY_RE.test(options.message);

  if (!isBodyRequest && !isSummaryRequest && !isAttachmentOnlyRequest) {
    return undefined;
  }

  options.onTelemetry?.({ event: "matched" });

  if (isAttachmentOnlyRequest) {
    options.onTelemetry?.({
      event: "failure",
      reason: "attachment-access-disabled",
      isUnread: false,
      keywordCount: 0,
    });
    return "Gmail attachment access is disabled in this runtime. I can summarize headers or open the body of one clearly identified message, but I will not inspect attachments.";
  }

  const oauthExport = loadOauthExport();
  const refreshToken = oauthExport?.refresh_token;
  if (!refreshToken) {
    options.onTelemetry?.({
      event: "failure",
      reason: "missing-refresh-token",
      isUnread: false,
      keywordCount: 0,
    });
    return "Gmail is not connected in this runtime yet. I need a valid exported refresh token before I can inspect your inbox.";
  }

  const credentials = loadGoogleCredentials();
  if (!credentials) {
    options.onTelemetry?.({
      event: "failure",
      reason: "missing-client-credentials",
      isUnread: false,
      keywordCount: 0,
    });
    return "Gmail OAuth client credentials are missing in this runtime. I need the desktop client credentials JSON that was used during gog auth add.";
  }

  const maxMessages = options.emailTokenBudget?.maxMessages ?? 5;
  const maxSnippetChars = options.emailTokenBudget?.maxSnippetChars ?? 240;
  const maxBodyChars = options.emailTokenBudget?.maxBodyChars ?? 1600;

  try {
    const accessToken = await exchangeRefreshToken(refreshToken, credentials);

    if (isBodyRequest) {
      return await resolveExplicitBodyRequest(
        options,
        accessToken,
        maxMessages,
        maxSnippetChars,
        maxBodyChars,
      );
    }

    const query = deriveQuery(options.message);
    const querySummary = summarizeQuery(query);
    options.onTelemetry?.({
      event: "queryBuilt",
      sanitizedQuery: querySummary.sanitizedQuery,
      isUnread: querySummary.isUnread,
      dateRange: querySummary.dateRange,
      keywordCount: querySummary.keywordCount,
    });

    const listResponse = await listMessageIds(accessToken, query, maxMessages);
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
      return formatNoResults(query, { paymentSummary: isPaymentSummary });
    }

    const items = await loadMessageSummaries(accessToken, messageIds, maxSnippetChars);
    saveSearchContext(options.userId, options.sessionKey, query, items);

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
      { includePaymentEstimate: isPaymentSummary },
    );
  } catch (err) {
    options.onTelemetry?.({
      event: "failure",
      reason: err instanceof Error ? err.message : "unknown-error",
      isUnread: false,
      keywordCount: 0,
    });
    return err instanceof Error
      ? err.message
      : "Gmail request failed for an unknown reason.";
  }
}
