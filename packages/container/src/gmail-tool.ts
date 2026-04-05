import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  EmailTokenBudgetPolicy,
  ToolIntentAdvisorAction,
  ToolSourceChoice,
  ToolTaskFamily,
} from "@serverless-openclaw/shared";

import {
  decideToolIntent,
  type DecideToolIntentInput,
} from "./tool-intent-advisor.js";

const DEFAULT_CONTEXT_TTL_MS = 5 * 60 * 1000;
const SUMMARY_FOLLOW_UP_PATTERN =
  /(얼마|합계|총액|정리|요약|카드사|결제처|가맹점|merchant|issuer|sum|summary|breakdown|table|표|테이블|이번주 것만 다시|이번 주 것만 다시|다시|계속|그거|이거|그럼|더\s*있|더\s*찾|더\s*보|밖에\s*없|몇\s*개|개수|건수|limit)/i;
const PAYMENT_HINT_PATTERN =
  /(결제|카드값|카드 값|명세서|청구서|영수증|receipt|statement|invoice|spent|spend|payment|total|amount|얼마 썼|얼마 쓴)/i;
const EXPLICIT_GMAIL_PATTERN =
  /(gmail|google mail|inbox|mailbox|이메일|메일함|메일에서|지메일)/i;
const GMAIL_CONFIRM_PATTERN =
  /^(?:지메일(?:에서|로)?(?:\s*확인해줘)?|gmail|gmail로|gmail에서|메일(?:에서|로)?|이메일(?:에서|로)?)(?:[.!?])?$/i;
const GENERAL_CONFIRM_PATTERN =
  /^(?:일반(?:으로)?|그냥\s*답변|일반\s*답변(?:으로)?|채팅(?:으로)?|추론(?:으로)?)(?:[.!?])?$/i;
const CANCEL_PATTERN = /^(?:취소|그만|끝|됐어|done|cancel|stop)(?:[.!?])?$/i;
const ATTACHMENT_PATTERN = /(첨부|attachment|pdf|파일|download)/i;
const BODY_REQUEST_PATTERN =
  /(자세히|본문|내용 보여|본문 보여|열어줘|open|full body|details?)/i;
const ORDER_ONLY_PATTERN =
  /(주문하신 내역|주문배송조회|구매내역|배송상태|배송정보|주문번호|주문하신)/i;
const PAYMENT_SIGNAL_PATTERN =
  /(결제|승인|카드|결제금액|최종결제금액|총 결제 금액|payment|receipt|statement|invoice)/i;
const PAYMENT_MERCHANT_PATTERN =
  /(가맹점명|구매상점명|상호명|merchant)\s*[:：]?\s*([^\n\r,]+)/i;
const PAYMENT_AMOUNT_PATTERNS: RegExp[] = [
  /(총\s*결제\s*금액|최종\s*결제\s*금액|결제\s*금액|결제금액|승인금액|청구금액)\s*[:：]?\s*([0-9][0-9,]*)\s*원/gi,
  /(amount|total)\s*[:：]?\s*(?:krw\s*)?([0-9][0-9,]*)/gi,
  /([0-9][0-9,]*)\s*원/gi,
];
const CARD_ISSUER_PATTERNS: RegExp[] = [
  /(삼성카드|신한카드|현대카드|KB국민카드|국민카드|우리카드|롯데카드|하나카드|비씨카드|BC카드|NH카드|농협카드|카카오뱅크|토스뱅크)/i,
  /(카드종류|결제기관|카드사)\s*[:：]?\s*([^\n\r,]+)/i,
];
const lastSearchContextByUser = new Map<string, SearchContext>();
const taskContextByUser = new Map<string, ToolTaskContext>();

interface ToolTaskContext {
  status: "awaiting_source" | "active";
  taskFamily: ToolTaskFamily;
  sourceChoice: ToolSourceChoice | null;
  canonicalGoal: string;
  lastSearchQuery?: string;
  parsedPaymentRecords?: ParsedPaymentRecord[];
  lastMessages?: GmailMessageSummary[];
  lastResultSummary?: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  clarificationResendCount: number;
}

interface SearchContext {
  messages: GmailMessageSummary[];
  query: string;
  createdAt: string;
}

interface ParsedPaymentRecord {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  merchant?: string;
  amount?: number;
  cardIssuer?: string;
  snippet: string;
  confidence: number;
  source: "snippet" | "body";
}

interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface OAuthClientDescriptor {
  client_id?: string;
  client_secret?: string;
}

interface GogCredentialFile {
  installed?: OAuthClientDescriptor;
  web?: OAuthClientDescriptor;
  client_id?: string;
  client_secret?: string;
}

interface GogOauthExport {
  refresh_token?: string;
  token?: {
    refresh_token?: string;
  };
  accounts?: Record<string, GogOauthExport>;
  [key: string]: unknown;
}

interface GmailListResponse {
  messages?: Array<{
    id: string;
    threadId: string;
  }>;
}

interface GmailMessageResponse {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: GmailPayload;
}

interface GmailPayload {
  mimeType?: string;
  body?: {
    data?: string;
  };
  headers?: Array<{
    name: string;
    value: string;
  }>;
  parts?: GmailPayload[];
}

export interface MaybeHandleCustomGmailRequestOptions {
  userId: string;
  message: string;
  sessionKey?: string;
  gmailReady: boolean;
  emailTokenBudget: EmailTokenBudgetPolicy;
  onToolEvent?: (event: ToolEvent) => void;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export type ToolHandlerResult =
  | {
      kind: "direct";
      message: string;
      source:
        | "gmail"
        | "gmail-clarification"
        | "gmail-context"
        | "gmail-fallback";
    }
  | {
      kind: "forward";
      message: string;
      source: "openclaw";
    };

export type ToolEvent =
  | {
      type: "intentDecided";
      action: ToolIntentAdvisorAction | "deterministic";
      taskFamily?: ToolTaskFamily;
      sourceChoice?: ToolSourceChoice | null;
      confidence?: number;
    }
  | {
      type: "contextCreated" | "contextReused" | "contextCleared" | "contextExpired";
      taskFamily?: ToolTaskFamily;
      sourceChoice?: ToolSourceChoice | null;
      reason?: string;
    }
  | {
      type: "clarificationSent";
      taskFamily?: ToolTaskFamily;
      reason: string;
    }
  | {
      type: "handlerFallback";
      reason: string;
      taskFamily?: ToolTaskFamily;
    };

function emitToolEvent(
  callback: MaybeHandleCustomGmailRequestOptions["onToolEvent"],
  event: ToolEvent,
): void {
  callback?.(event);
}

function getGogCredentialsPath(): string {
  return join(homedir(), ".config", "gogcli", "credentials.json");
}

function getOauthExportPath(): string {
  return join(homedir(), ".config", "gogcli", "oauth.json");
}

function getOpenClawOauthExportPath(): string {
  return join(homedir(), ".openclaw", "credentials", "oauth.json");
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function extractRefreshToken(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.refresh_token === "string") {
    return record.refresh_token;
  }
  if (
    record.token &&
    typeof record.token === "object" &&
    typeof (record.token as Record<string, unknown>).refresh_token === "string"
  ) {
    return (record.token as Record<string, unknown>).refresh_token as string;
  }
  if (record.accounts && typeof record.accounts === "object") {
    for (const nested of Object.values(record.accounts as Record<string, unknown>)) {
      const nestedToken = extractRefreshToken(nested);
      if (nestedToken) {
        return nestedToken;
      }
    }
  }
  for (const nested of Object.values(record)) {
    const nestedToken = extractRefreshToken(nested);
    if (nestedToken) {
      return nestedToken;
    }
  }
  return undefined;
}

async function loadGmailCredentials(): Promise<GmailCredentials | null> {
  const credentialFile = await readJsonFile<GogCredentialFile>(getGogCredentialsPath());
  const descriptor =
    credentialFile?.installed ??
    credentialFile?.web ??
    (credentialFile?.client_id && credentialFile?.client_secret
      ? credentialFile
      : null);
  const clientId = descriptor?.client_id;
  const clientSecret = descriptor?.client_secret;

  const oauthFile =
    (await readJsonFile<GogOauthExport>(getOauthExportPath())) ??
    (await readJsonFile<GogOauthExport>(getOpenClawOauthExportPath()));
  const refreshToken = extractRefreshToken(oauthFile);

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return { clientId, clientSecret, refreshToken };
}

export async function isGmailReady(): Promise<boolean> {
  const credentials = await loadGmailCredentials();
  return Boolean(credentials);
}

function getContextKey(userId: string, sessionKey?: string): string {
  return `${userId}:${sessionKey ?? "default"}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function isExpired(expiresAt?: string): boolean {
  return !expiresAt || Date.parse(expiresAt) <= Date.now();
}

function getTaskContext(key: string): ToolTaskContext | undefined {
  const context = taskContextByUser.get(key);
  if (!context) {
    return undefined;
  }
  if (isExpired(context.expiresAt)) {
    taskContextByUser.delete(key);
    return undefined;
  }
  return context;
}

function setTaskContext(key: string, context: ToolTaskContext): void {
  taskContextByUser.set(key, context);
}

function clearTaskContext(key: string): void {
  taskContextByUser.delete(key);
}

function setSearchContext(key: string, context: SearchContext): void {
  lastSearchContextByUser.set(key, context);
}

function getSearchContext(key: string): SearchContext | undefined {
  const context = lastSearchContextByUser.get(key);
  if (!context) {
    return undefined;
  }
  if (Date.parse(context.createdAt) + DEFAULT_CONTEXT_TTL_MS <= Date.now()) {
    lastSearchContextByUser.delete(key);
    return undefined;
  }
  return context;
}

function looksLikePaymentQuestion(message: string): boolean {
  return PAYMENT_HINT_PATTERN.test(message);
}

function isExplicitGmailMessage(message: string): boolean {
  return EXPLICIT_GMAIL_PATTERN.test(message);
}

function isBodyRequest(message: string): boolean {
  return BODY_REQUEST_PATTERN.test(message);
}

function isAttachmentRequest(message: string): boolean {
  return ATTACHMENT_PATTERN.test(message);
}

function isPaymentFollowUp(message: string): boolean {
  return SUMMARY_FOLLOW_UP_PATTERN.test(message);
}

function isShortReply(message: string): boolean {
  return message.trim().length <= 24;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeForSearch(message: string): string {
  return message
    .replace(EXPLICIT_GMAIL_PATTERN, " ")
    .replace(BODY_REQUEST_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function monthIndexFromText(message: string): number | undefined {
  const normalized = message.toLowerCase();
  const numericMatch = normalized.match(/(\d{1,2})\s*월/);
  if (numericMatch) {
    const month = Number.parseInt(numericMatch[1] ?? "", 10);
    if (month >= 1 && month <= 12) {
      return month - 1;
    }
  }

  const names = [
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
  ];
  for (const [index, name] of names.entries()) {
    if (normalized.includes(name) || normalized.includes(name.slice(0, 3))) {
      return index;
    }
  }
  return undefined;
}

function buildDateRange(message: string): { after?: string; before?: string } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (/오늘|today/i.test(message)) {
    return {
      after: formatDate(startOfToday),
      before: formatDate(new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000)),
    };
  }

  if (/어제|yesterday/i.test(message)) {
    const yesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    return {
      after: formatDate(yesterday),
      before: formatDate(startOfToday),
    };
  }

  if (/이번\s*주|이번주|this week/i.test(message)) {
    const weekday = startOfToday.getDay();
    const diff = weekday === 0 ? -6 : 1 - weekday;
    const weekStart = new Date(startOfToday);
    weekStart.setDate(startOfToday.getDate() + diff);
    return {
      after: formatDate(weekStart),
      before: formatDate(new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000)),
    };
  }

  if (/지난\s*달|지난달|last month/i.test(message)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    return { after: formatDate(start), before: formatDate(end) };
  }

  if (/이번\s*달|이번달|this month/i.test(message)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { after: formatDate(start), before: formatDate(end) };
  }

  const explicitYearMonth = message.match(/(20\d{2})[./-](\d{1,2})/);
  if (explicitYearMonth) {
    const year = Number.parseInt(explicitYearMonth[1] ?? "", 10);
    const month = Number.parseInt(explicitYearMonth[2] ?? "", 10) - 1;
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 1);
    return { after: formatDate(start), before: formatDate(end) };
  }

  const monthIndex = monthIndexFromText(message);
  if (monthIndex !== undefined) {
    const year = now.getFullYear();
    const start = new Date(year, monthIndex, 1);
    const end = new Date(year, monthIndex + 1, 1);
    return { after: formatDate(start), before: formatDate(end) };
  }

  return {};
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function extractFromQuery(message: string): string | undefined {
  const fromMatch =
    message.match(/(?:from|보낸사람|보낸 사람)\s+([^\s]+)/i) ??
    message.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return fromMatch?.[1];
}

function extractSubjectKeyword(message: string): string | undefined {
  const subjectMatch = message.match(/(?:subject|제목)(?:에)?\s+(.+)/i);
  if (subjectMatch?.[1]) {
    return normalizeWhitespace(subjectMatch[1]);
  }

  const sanitized = sanitizeForSearch(message);
  const keywordMatch = sanitized.match(
    /(카드|명세서|청구서|영수증|invoice|receipt|statement|결제|승인|payment)/i,
  );
  return keywordMatch?.[0];
}

function buildPaymentSearchQuery(message: string, unreadOnly: boolean): string {
  const parts: string[] = [];
  const dateRange = buildDateRange(message);
  if (dateRange.after) {
    parts.push(`after:${dateRange.after}`);
  }
  if (dateRange.before) {
    parts.push(`before:${dateRange.before}`);
  }
  if (unreadOnly && /unread|안\s*읽/i.test(message)) {
    parts.push("is:unread");
  }

  const from = extractFromQuery(message);
  if (from) {
    parts.push(`from:${from}`);
  }

  const keywords = new Set<string>();
  const subjectKeyword = extractSubjectKeyword(message);
  if (subjectKeyword) {
    keywords.add(subjectKeyword);
  }
  if (/카드|statement|invoice/i.test(message)) {
    keywords.add("카드");
  }
  if (/명세서|statement/i.test(message)) {
    keywords.add("명세서");
  }
  if (/청구서|invoice/i.test(message)) {
    keywords.add("청구서");
  }
  if (/영수증|receipt/i.test(message)) {
    keywords.add("영수증");
  }
  if (/결제|payment|amount|spent|spend/i.test(message)) {
    keywords.add("결제");
  }
  if (keywords.size === 0) {
    keywords.add("결제");
  }

  parts.push(...keywords);
  return parts.join(" ").trim();
}

async function refreshAccessToken(credentials: GmailCredentials): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    return null;
  }

  const json = (await response.json()) as { access_token?: string };
  return json.access_token ?? null;
}

async function gmailApiRequest<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`gmail api request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

function getHeader(payload: GmailPayload | undefined, name: string): string {
  const match = payload?.headers?.find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  );
  return match?.value ?? "";
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function extractPlainText(payload: GmailPayload | undefined): string {
  if (!payload) {
    return "";
  }

  if (payload.mimeType?.startsWith("text/plain") && payload.body?.data) {
    return base64UrlDecode(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) {
      return text;
    }
  }

  if (payload.mimeType?.startsWith("text/html") && payload.body?.data) {
    return base64UrlDecode(payload.body.data).replace(/<[^>]+>/g, " ");
  }

  return "";
}

async function fetchMessageSummary(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageSummary> {
  const json = await gmailApiRequest<GmailMessageResponse>(
    accessToken,
    `/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
  );

  return {
    id: json.id,
    threadId: json.threadId,
    subject: getHeader(json.payload, "Subject"),
    from: getHeader(json.payload, "From"),
    date: getHeader(json.payload, "Date"),
    snippet: normalizeWhitespace(json.snippet ?? ""),
  };
}

async function fetchMessageBody(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageSummary & { body: string }> {
  const json = await gmailApiRequest<GmailMessageResponse>(
    accessToken,
    `/messages/${messageId}?format=full`,
  );

  return {
    id: json.id,
    threadId: json.threadId,
    subject: getHeader(json.payload, "Subject"),
    from: getHeader(json.payload, "From"),
    date: getHeader(json.payload, "Date"),
    snippet: normalizeWhitespace(json.snippet ?? ""),
    body: normalizeWhitespace(extractPlainText(json.payload)),
  };
}
function extractMerchant(subject: string, snippet: string): string | undefined {
  const joined = `${subject}\n${snippet}`;
  const directMatch = joined.match(PAYMENT_MERCHANT_PATTERN);
  if (directMatch?.[2]) {
    return normalizeWhitespace(directMatch[2]);
  }

  const subjectMatch =
    subject.match(/(.+?)에서\s*(?:결제|승인)/) ??
    subject.match(/(.+?)의\s*(?:결제|승인)\s*내역/);
  if (subjectMatch?.[1]) {
    return normalizeWhitespace(
      subjectMatch[1].replace(/^[["']+/, "").replace(/[\]"']+$/, ""),
    );
  }

  return undefined;
}

function pickBestAmount(text: string): number | undefined {
  for (const pattern of PAYMENT_AMOUNT_PATTERNS) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const numberText = match[2] ?? match[1];
      const normalized = numberText?.replace(/,/g, "");
      const value = normalized ? Number.parseInt(normalized, 10) : Number.NaN;
      if (!Number.isNaN(value) && value > 0) {
        const leadingContext = text.slice(Math.max(0, (match.index ?? 0) - 12), (match.index ?? 0) + 12);
        if (/할인|쿠폰|discount|수수료\s*0/i.test(leadingContext)) {
          continue;
        }
        return value;
      }
    }
  }

  return undefined;
}

function extractCardIssuer(text: string): string | undefined {
  for (const pattern of CARD_ISSUER_PATTERNS) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }
    const issuer = match[2] ?? match[1];
    if (issuer) {
      return normalizeWhitespace(issuer);
    }
  }
  return undefined;
}

function buildPaymentRecord(summary: GmailMessageSummary): ParsedPaymentRecord | null {
  const signalText = `${summary.subject}\n${summary.snippet}`;
  const hasPaymentSignal = PAYMENT_SIGNAL_PATTERN.test(signalText);
  const looksLikeOrderOnly =
    ORDER_ONLY_PATTERN.test(signalText) && !hasPaymentSignal && !/결제금액|최종결제금액/.test(signalText);
  if (looksLikeOrderOnly) {
    return null;
  }

  const amount = pickBestAmount(signalText);
  const merchant = extractMerchant(summary.subject, summary.snippet);
  const cardIssuer = extractCardIssuer(signalText);
  const confidence =
    hasPaymentSignal && amount
      ? 0.92
      : amount
        ? 0.78
        : hasPaymentSignal
          ? 0.65
          : 0.35;
  if (!amount && confidence < 0.6) {
    return null;
  }

  return {
    messageId: summary.id,
    subject: summary.subject,
    from: summary.from,
    date: summary.date,
    merchant,
    amount,
    cardIssuer,
    snippet: summary.snippet,
    confidence,
    source: "snippet",
  };
}

function formatCurrency(amount: number): string {
  return `KRW ${amount.toLocaleString("en-US")}`;
}

function buildEvidenceList(messages: GmailMessageSummary[]): string {
  return messages
    .map((message, index) => {
      return `${index + 1}. ${message.subject}\nFrom: ${message.from}\nDate: ${message.date}\nSnippet: ${message.snippet}`;
    })
    .join("\n\n");
}

function buildPaymentSummaryResponse(
  query: string,
  messages: GmailMessageSummary[],
  records: ParsedPaymentRecord[],
): string {
  const total = records.reduce((sum, record) => sum + (record.amount ?? 0), 0);
  const merchants = [...new Set(records.map((record) => record.merchant).filter(Boolean))];
  const issuers = [...new Set(records.map((record) => record.cardIssuer).filter(Boolean))];

  const summaryLines = [
    `I checked Gmail headers-first with query "${query}" and inspected ${messages.length} message(s).`,
    "I did not open full bodies or attachments.",
  ];

  if (records.length > 0) {
    summaryLines.push(
      `Estimated total from visible headers/snippets: ${formatCurrency(total)} across ${records.length} matched payment message(s). This is a rough headers-first estimate only.`,
    );
    if (issuers.length > 0) {
      summaryLines.push(`Observed card issuers: ${issuers.join(", ")}.`);
    }
    if (merchants.length > 0) {
      summaryLines.push(`Observed merchants: ${merchants.slice(0, 4).join(", ")}.`);
    }
  } else {
    summaryLines.push(
      "I found candidate messages but could not extract reliable payment amounts from the visible headers/snippets alone.",
    );
  }

  return `${summaryLines.join("\n")}\n\n${buildEvidenceList(messages)}`;
}

function formatPaymentFollowUp(
  context: ToolTaskContext,
  message: string,
  maxMessages: number,
): ToolHandlerResult | undefined {
  const records = context.parsedPaymentRecords ?? [];
  if (records.length === 0) {
    return {
      kind: "direct",
      message:
        "I do not have a usable payment summary in the current Gmail context. Please ask the Gmail question again so I can rebuild it.",
      source: "gmail-context",
    };
  }

  const total = records.reduce((sum, record) => sum + (record.amount ?? 0), 0);
  const normalized = message.toLowerCase();

  if (/더\s*(있|찾|보)|밖에\s*없|몇\s*개|개수|건수|limit/i.test(normalized)) {
    const inspectedCount = context.lastMessages?.length ?? records.length;
    const hitSafetyCap = inspectedCount >= maxMessages;
    const capMessage = hitSafetyCap
      ? `I only inspected the first ${maxMessages} Gmail message(s) because the current safety policy is headers-first with a ${maxMessages}-message cap, so there may be more matching payment emails beyond this window.`
      : `I inspected ${inspectedCount} Gmail message(s) in the current headers-first window and did not hit the ${maxMessages}-message cap.`;

    return {
      kind: "direct",
      message:
        `${capMessage}\n\n` +
        `Within the currently visible payment context, I extracted ${records.length} payment-like message(s) with a rough visible total of ${formatCurrency(total)}.\n` +
        "If you want me to check a different slice safely, narrow it by period, sender, card issuer, or merchant.",
      source: "gmail-context",
    };
  }

  if (/카드사|issuer/i.test(normalized)) {
    const grouped = new Map<string, number>();
    for (const record of records) {
      const key = record.cardIssuer ?? "Unknown";
      grouped.set(key, (grouped.get(key) ?? 0) + (record.amount ?? 0));
    }
    const lines = [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([issuer, amount]) => `- ${issuer}: ${formatCurrency(amount)}`);
    return {
      kind: "direct",
      message: `Within the current Gmail payment context, here is the card-issuer breakdown:\n${lines.join("\n")}`,
      source: "gmail-context",
    };
  }

  if (/결제처|가맹점|merchant/i.test(normalized)) {
    const grouped = new Map<string, number>();
    for (const record of records) {
      const key = record.merchant ?? "Unknown merchant";
      grouped.set(key, (grouped.get(key) ?? 0) + (record.amount ?? 0));
    }
    const lines = [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([merchant, amount]) => `- ${merchant}: ${formatCurrency(amount)}`);
    return {
      kind: "direct",
      message: `Within the current Gmail payment context, here is the merchant breakdown:\n${lines.join("\n")}`,
      source: "gmail-context",
    };
  }

  if (/합계|총액|sum|total/i.test(normalized)) {
    return {
      kind: "direct",
      message: `Within the current Gmail payment context, the visible headers-first total is ${formatCurrency(total)} across ${records.length} payment message(s).`,
      source: "gmail-context",
    };
  }

  const topRecords = records
    .slice()
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, 5)
    .map((record, index) => {
      const issuer = record.cardIssuer ? `, ${record.cardIssuer}` : "";
      const merchant = record.merchant ?? record.subject;
      const amount = record.amount ? formatCurrency(record.amount) : "amount unavailable";
      return `${index + 1}. ${merchant} - ${amount}${issuer} (${record.date})`;
    });

  return {
    kind: "direct",
    message:
      `Within the current Gmail payment context, the visible headers-first total is ${formatCurrency(total)} across ${records.length} payment message(s).\n\n` +
      `Top matched payments:\n${topRecords.join("\n")}`,
    source: "gmail-context",
  };
}

function parseBodySelector(message: string, searchContext?: SearchContext): GmailMessageSummary[] {
  if (!searchContext) {
    return [];
  }

  const ordinalMatch = message.match(/(?:^|\s)(\d+)\s*번/);
  if (ordinalMatch) {
    const index = Number.parseInt(ordinalMatch[1] ?? "", 10) - 1;
    const selected = searchContext.messages[index];
    return selected ? [selected] : [];
  }

  const normalized = sanitizeForSearch(message).toLowerCase();
  if (!normalized) {
    return [];
  }

  const filtered = searchContext.messages.filter((item) => {
    const haystack = `${item.subject} ${item.from} ${item.snippet}`.toLowerCase();
    return normalized
      .split(/\s+/)
      .filter(Boolean)
      .every((token) => haystack.includes(token));
  });
  return filtered;
}

function buildClarificationPrompt(): string {
  return "지메일에서 확인할까요, 아니면 일반 답변으로 도와드릴까요?";
}

function buildGmailUnavailableMessage(): string {
  return "Gmail is not connected in this runtime yet. I need a valid exported refresh token before I can inspect your inbox.";
}

async function runGmailTask(
  contextKey: string,
  options: MaybeHandleCustomGmailRequestOptions,
  taskFamily: ToolTaskFamily,
  sourceMessage: string,
  credentials: GmailCredentials,
): Promise<ToolHandlerResult> {
  if (isAttachmentRequest(sourceMessage)) {
    return {
      kind: "direct",
      message:
        "Attachments are still disabled in this Gmail runtime. I can search headers/snippets and open one email body when you explicitly point to it, but I will not open attachments.",
      source: "gmail-fallback",
    };
  }

  const accessToken = await refreshAccessToken(credentials);
  if (!accessToken) {
    return {
      kind: "direct",
      message: buildGmailUnavailableMessage(),
      source: "gmail-fallback",
    };
  }

  const searchContext = getSearchContext(contextKey);
  if (isBodyRequest(sourceMessage)) {
    const selectedMessages = parseBodySelector(sourceMessage, searchContext);
    if (selectedMessages.length === 0) {
      return {
        kind: "direct",
        message:
          "I do not have a clear single email to open. Please refer to one result by number, for example `1번 메일 자세히 보여줘`.",
        source: "gmail-fallback",
      };
    }
    if (selectedMessages.length > 1) {
      return {
        kind: "direct",
        message:
          "Multiple Gmail messages still match that description. Please narrow it by sender, date, or the result number.",
        source: "gmail-fallback",
      };
    }

    const selected = await fetchMessageBody(accessToken, selectedMessages[0].id);
    const body = selected.body.slice(0, options.emailTokenBudget.maxBodyChars);
    return {
      kind: "direct",
      message:
        `I opened one Gmail message body because you explicitly asked for it.\n\n` +
        `Subject: ${selected.subject}\nFrom: ${selected.from}\nDate: ${selected.date}\n\n` +
        `${body}`,
      source: "gmail",
    };
  }
  const query = buildPaymentSearchQuery(
    sourceMessage,
    !/\ball\b|전체|모두/i.test(sourceMessage),
  );
  const listJson = await gmailApiRequest<GmailListResponse>(
    accessToken,
    `/messages?q=${encodeURIComponent(query)}&maxResults=${options.emailTokenBudget.maxMessages}`,
  );
  const ids = listJson.messages?.map((item) => item.id) ?? [];
  const messages = await Promise.all(ids.map((id) => fetchMessageSummary(accessToken, id)));

  setSearchContext(contextKey, {
    messages,
    query,
    createdAt: nowIso(),
  });

  const paymentRecords =
    taskFamily === "gmail_payment_summary"
      ? messages
          .map((summary) => buildPaymentRecord(summary))
          .filter((record): record is ParsedPaymentRecord => Boolean(record))
      : [];

  const taskContext: ToolTaskContext = {
    status: "active",
    taskFamily,
    sourceChoice: "gmail",
    canonicalGoal: sourceMessage,
    lastSearchQuery: query,
    parsedPaymentRecords: paymentRecords,
    lastMessages: messages,
    lastResultSummary: messages.map((item) => item.subject).join(" | "),
    createdAt: nowIso(),
    lastActivityAt: nowIso(),
    expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
    clarificationResendCount: 0,
  };
  setTaskContext(contextKey, taskContext);
  emitToolEvent(options.onToolEvent, {
    type: "contextCreated",
    taskFamily,
    sourceChoice: "gmail",
  });

  if (taskFamily === "gmail_payment_summary" && paymentRecords.length === 0) {
    return {
      kind: "direct",
      message:
        messages.length === 0
          ? "I did not find payment-related Gmail messages in the visible window. Please narrow it by period, sender, or card issuer."
          : "I found candidate Gmail messages, but I could not extract reliable payment amounts from the visible headers/snippets. Please narrow it by sender, period, or ask me to open one specific email body.",
      source: "gmail-fallback",
    };
  }

  return {
    kind: "direct",
    message:
      taskFamily === "gmail_payment_summary"
        ? buildPaymentSummaryResponse(query, messages, paymentRecords)
        : `${messages.length === 0 ? "I did not find matching Gmail messages." : `I checked Gmail headers-first with query "${query}" and inspected ${messages.length} message(s).`}\n\n${buildEvidenceList(messages)}`,
    source: "gmail",
  };
}

function buildDeterministicDecision(
  message: string,
  _gmailReady: boolean,
  activeContext?: ToolTaskContext,
): ToolIntentAdvisorAction {
  if (activeContext?.status === "active" && !isClearlyUnrelated(message)) {
    return "continue_active_task";
  }
  if (
    isExplicitGmailMessage(message) ||
    looksLikePaymentQuestion(message) ||
    isBodyRequest(message)
  ) {
    return "gmail";
  }
  return "generic_openclaw";
}

function buildAdvisorInput(
  message: string,
  gmailReady: boolean,
  activeContext?: ToolTaskContext,
): DecideToolIntentInput {
  return {
    message,
    gmailReady,
    activeContext: activeContext
      ? {
          taskFamily: activeContext.taskFamily,
          sourceChoice: activeContext.sourceChoice,
          canonicalGoal: activeContext.canonicalGoal,
          lastResultSummary: activeContext.lastResultSummary,
        }
      : undefined,
  };
}

function isClearlyUnrelated(message: string): boolean {
  return !looksLikePaymentQuestion(message) && !isExplicitGmailMessage(message) && !isPaymentFollowUp(message) && !isBodyRequest(message);
}

async function handleAwaitingSourceContext(
  contextKey: string,
  context: ToolTaskContext,
  options: MaybeHandleCustomGmailRequestOptions,
): Promise<ToolHandlerResult | undefined> {
  const trimmed = normalizeWhitespace(options.message);
  if (CANCEL_PATTERN.test(trimmed)) {
    clearTaskContext(contextKey);
    emitToolEvent(options.onToolEvent, {
      type: "contextCleared",
      taskFamily: context.taskFamily,
      reason: "user-cancelled",
    });
    return {
      kind: "direct",
      message: "알겠습니다. 현재 도구 작업 문맥을 종료할게요.",
      source: "gmail-context",
    };
  }

  if (GMAIL_CONFIRM_PATTERN.test(trimmed)) {
    if (!options.gmailReady) {
      clearTaskContext(contextKey);
      emitToolEvent(options.onToolEvent, {
        type: "contextCleared",
        taskFamily: context.taskFamily,
        reason: "gmail-not-ready",
      });
      return {
        kind: "direct",
        message: buildGmailUnavailableMessage(),
        source: "gmail-fallback",
      };
    }

    const credentials = await loadGmailCredentials();
    if (!credentials) {
      return {
        kind: "direct",
        message: buildGmailUnavailableMessage(),
        source: "gmail-fallback",
      };
    }

    return runGmailTask(
      contextKey,
      options,
      context.taskFamily,
      context.canonicalGoal,
      credentials,
    );
  }

  if (GENERAL_CONFIRM_PATTERN.test(trimmed)) {
    clearTaskContext(contextKey);
    emitToolEvent(options.onToolEvent, {
      type: "contextCleared",
      taskFamily: context.taskFamily,
      reason: "general-selected",
    });
    return {
      kind: "forward",
      message: context.canonicalGoal,
      source: "openclaw",
    };
  }

  if (isShortReply(trimmed) && context.clarificationResendCount < 1) {
    const nextContext: ToolTaskContext = {
      ...context,
      clarificationResendCount: context.clarificationResendCount + 1,
      lastActivityAt: nowIso(),
      expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
    };
    setTaskContext(contextKey, nextContext);
    emitToolEvent(options.onToolEvent, {
      type: "clarificationSent",
      taskFamily: context.taskFamily,
      reason: "awaiting-source-resend",
    });
    return {
      kind: "direct",
      message: buildClarificationPrompt(),
      source: "gmail-clarification",
    };
  }

  clearTaskContext(contextKey);
  emitToolEvent(options.onToolEvent, {
    type: "contextCleared",
    taskFamily: context.taskFamily,
    reason: "awaiting-source-replaced",
  });
  return undefined;
}

async function handleActiveTaskContext(
  contextKey: string,
  context: ToolTaskContext,
  options: MaybeHandleCustomGmailRequestOptions,
): Promise<ToolHandlerResult | undefined> {
  const trimmed = normalizeWhitespace(options.message);
  if (CANCEL_PATTERN.test(trimmed)) {
    clearTaskContext(contextKey);
    emitToolEvent(options.onToolEvent, {
      type: "contextCleared",
      taskFamily: context.taskFamily,
      reason: "user-cancelled",
    });
    return {
      kind: "direct",
      message: "알겠습니다. 현재 도구 작업 문맥을 종료할게요.",
      source: "gmail-context",
    };
  }

  if (context.taskFamily === "gmail_payment_summary" && context.sourceChoice === "gmail") {
    if (isBodyRequest(trimmed) || isAttachmentRequest(trimmed)) {
      const credentials = await loadGmailCredentials();
      if (!credentials) {
        return {
          kind: "direct",
          message: buildGmailUnavailableMessage(),
          source: "gmail-fallback",
        };
      }
      const nextContext: ToolTaskContext = {
        ...context,
        lastActivityAt: nowIso(),
        expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
      };
      setTaskContext(contextKey, nextContext);
      emitToolEvent(options.onToolEvent, {
        type: "contextReused",
        taskFamily: context.taskFamily,
        sourceChoice: context.sourceChoice,
      });
      return runGmailTask(
        contextKey,
        options,
        "gmail_body_selection",
        trimmed,
        credentials,
      );
    }

    if (isClearlyUnrelated(trimmed)) {
      clearTaskContext(contextKey);
      emitToolEvent(options.onToolEvent, {
        type: "contextCleared",
        taskFamily: context.taskFamily,
        reason: "topic-switch",
      });
      return undefined;
    }

    const nextContext: ToolTaskContext = {
      ...context,
      lastActivityAt: nowIso(),
      expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
    };
    setTaskContext(contextKey, nextContext);
    emitToolEvent(options.onToolEvent, {
      type: "contextReused",
      taskFamily: context.taskFamily,
      sourceChoice: context.sourceChoice,
    });
    return formatPaymentFollowUp(
      nextContext,
      trimmed,
      options.emailTokenBudget.maxMessages,
    );
  }

  return undefined;
}

export async function maybeHandleCustomGmailRequest(
  options: MaybeHandleCustomGmailRequestOptions,
): Promise<ToolHandlerResult | undefined> {
  const contextKey = getContextKey(options.userId, options.sessionKey);
  const activeContext = getTaskContext(contextKey);

  if (activeContext && isExpired(activeContext.expiresAt)) {
    clearTaskContext(contextKey);
    emitToolEvent(options.onToolEvent, {
      type: "contextExpired",
      taskFamily: activeContext.taskFamily,
      sourceChoice: activeContext.sourceChoice,
    });
  }

  const currentContext = getTaskContext(contextKey);
  if (currentContext?.status === "awaiting_source") {
    const handled = await handleAwaitingSourceContext(contextKey, currentContext, options);
    if (handled) {
      return handled;
    }
  }

  const refreshedContext = getTaskContext(contextKey);
  if (refreshedContext?.status === "active") {
    const handled = await handleActiveTaskContext(contextKey, refreshedContext, options);
    if (handled) {
      return handled;
    }
  }

  const deterministicAction = buildDeterministicDecision(
    options.message,
    options.gmailReady,
    refreshedContext,
  );

  const advisorDecision = await decideToolIntent(
    buildAdvisorInput(options.message, options.gmailReady, refreshedContext),
  );

  const finalDecision = advisorDecision ?? {
    action: deterministicAction,
    confidence: 0.5,
    sourceChoice: deterministicAction === "gmail" ? "gmail" : null,
    taskFamily: looksLikePaymentQuestion(options.message)
      ? "gmail_payment_summary"
      : "gmail_search",
  };

  if (!advisorDecision) {
    emitToolEvent(options.onToolEvent, {
      type: "handlerFallback",
      reason: "advisor-unavailable",
      taskFamily: refreshedContext?.taskFamily,
    });
  }

  emitToolEvent(options.onToolEvent, {
    type: "intentDecided",
    action: finalDecision.action,
    taskFamily: finalDecision.taskFamily,
    sourceChoice: finalDecision.sourceChoice,
    confidence: finalDecision.confidence,
  });

  if (finalDecision.action === "continue_active_task" && refreshedContext) {
    const handled = await handleActiveTaskContext(contextKey, refreshedContext, options);
    if (handled) {
      return handled;
    }
  }

  if (finalDecision.action === "clarify_source") {
    const taskFamily = finalDecision.taskFamily ?? "gmail_payment_summary";
    const nextContext: ToolTaskContext = {
      status: "awaiting_source",
      taskFamily,
      sourceChoice: null,
      canonicalGoal: options.message,
      createdAt: nowIso(),
      lastActivityAt: nowIso(),
      expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
      clarificationResendCount: 0,
    };
    setTaskContext(contextKey, nextContext);
    emitToolEvent(options.onToolEvent, {
      type: "contextCreated",
      taskFamily,
      sourceChoice: null,
    });
    emitToolEvent(options.onToolEvent, {
      type: "clarificationSent",
      taskFamily,
      reason: "advisor-clarify-source",
    });
    return {
      kind: "direct",
      message: buildClarificationPrompt(),
      source: "gmail-clarification",
    };
  }

  if (finalDecision.action === "gmail") {
    if (!options.gmailReady) {
      return {
        kind: "direct",
        message: buildGmailUnavailableMessage(),
        source: "gmail-fallback",
      };
    }
    const credentials = await loadGmailCredentials();
    if (!credentials) {
      return {
        kind: "direct",
        message: buildGmailUnavailableMessage(),
        source: "gmail-fallback",
      };
    }
    return runGmailTask(
      contextKey,
      options,
      finalDecision.taskFamily ?? "gmail_search",
      options.message,
      credentials,
    );
  }

  return {
    kind: "forward",
    message: options.message,
    source: "openclaw",
  };
}
