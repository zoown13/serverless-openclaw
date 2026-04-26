import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  KEY_PREFIX,
  TABLE_NAMES,
  type EmailTokenBudgetPolicy,
  type ToolIntentAdvisorAction,
  type ToolSourceChoice,
  type ToolTaskFamily,
} from "@serverless-openclaw/shared";

import {
  decideToolIntent,
  type DecideToolIntentInput,
  type ToolIntentDecision,
} from "./tool-intent-advisor.js";
import type { SlmBackendKind, ToolFollowUpIntent } from "./slm/index.js";

const DEFAULT_CONTEXT_TTL_MS = 5 * 60 * 1000;
const TOOL_CONTEXT_SETTING_KEY = "tool-task-context";
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
const POLICY_NOTICE_PATTERN =
  /(약관|개정\s*안내|기본약관|이용약관|정책\s*안내|표준\s*전자금융거래|전자금융거래\s*기본약관|terms?|policy)/i;
const TRAVEL_REFINEMENT_PATTERN =
  /(관련된\s*것만|관련만|쪽만|만\s*(?:가져|보여|알려|정리)|여행\s*관련|일본\s*관련|travel|trip)/i;
const TRAVEL_DESTINATION_PATTERN =
  /(일본|japan|도쿄|tokyo|오사카|osaka|교토|kyoto|후쿠오카|fukuoka|삿포로|sapporo|오키나와|okinawa|나고야|nagoya|나리타|narita|하네다|haneda|간사이|kansai)/i;
const TRAVEL_PLATFORM_PATTERN =
  /(마이리얼트립|myrealtrip|trip\.com|tripcom|아고다|agoda|booking\.com|booking|airbnb|klook|kkday|스카이스캐너|skyscanner|익스피디아|expedia|호텔스닷컴|hotels\.com|rentalcars|rentalcars\.com|rentacar|rent-a-car|toyota\s+rent\s+a\s+car)/i;
const TRAVEL_SIGNAL_PATTERN =
  /(일본|japan|도쿄|tokyo|오사카|osaka|교토|kyoto|후쿠오카|fukuoka|삿포로|sapporo|오키나와|okinawa|나고야|nagoya|나리타|narita|하네다|haneda|간사이|kansai|여행|travel|trip|해외|overseas|항공|flight|호텔|hotel|숙소|stay|숙박|lodging|료칸|ryokan|게스트하우스|guesthouse|리조트|resort|esim|e-sim|jr|rail|기차|train|전철|철도|지하철|subway|메트로|metro|공항|airport|셔틀|shuttle|리무진|limousine|버스|bus|렌터카|rental\s*car|rentalcars|페리|ferry|패스|pass|마이리얼트립|myrealtrip|trip\.com|tripcom|아고다|agoda|airbnb|klook|kkday|투어|tour|예약|booking|익스피디아|expedia|호텔스닷컴|hotels\.com|toyota\s+rent\s+a\s+car)/i;
const ORDER_ONLY_PATTERN =
  /(주문하신 내역|주문배송조회|구매내역|배송상태|배송정보|주문번호|주문하신)/i;
const PAYMENT_SIGNAL_PATTERN =
  /(결제|승인|카드|결제금액|최종결제금액|총 결제 금액|payment|receipt|statement|invoice)/i;
const TRAVEL_POSITIVE_PATTERN =
  /(마이리얼트립|myrealtrip|trip\.com|tripcom|agoda|booking\.com|booking|airbnb|klook|kkday|익스피디아|expedia|호텔스닷컴|hotels\.com|rentalcars|rentalcars\.com|rentacar|rent-a-car|toyota\s+rent\s+a\s+car|야놀자|여기어때|호텔|hotel|숙소|stay|숙박|lodging|료칸|ryokan|게스트하우스|guesthouse|리조트|resort|항공|flight|airline|jr|rail|기차|train|전철|철도|지하철|subway|메트로|metro|공항|airport|셔틀|shuttle|리무진|limousine|버스|bus|렌터카|e\s*-?sim|sim\b|여행|travel|trip|투어|tour|페리|ferry|패스|pass|해외|overseas|일본|japan|도쿄|tokyo|오사카|osaka|교토|kyoto|후쿠오카|fukuoka|삿포로|sapporo|오키나와|okinawa|나고야|nagoya|나리타|narita|하네다|haneda|간사이|kansai)/i;
const STRONG_TRAVEL_EVIDENCE_PATTERN =
  /(항공|flight|airline|호텔|hotel|숙소|stay|숙박|lodging|료칸|ryokan|게스트하우스|guesthouse|리조트|resort|jr|rail|기차|train|전철|철도|지하철|subway|메트로|metro|공항|airport|셔틀|shuttle|리무진|limousine|렌터카|rental\s*car|rentalcars|rentacar|e\s*-?sim|sim\b|투어|tour|페리|ferry|패스|pass)/i;
const TRAVEL_NEGATIVE_PATTERN =
  /(약관|정책|개정|안내|베이커리|편의점|카페|마트|식당|분식|오프라인|푸드|치킨|순대|약국|스타벅스|이마트24|쿠팡|배달|굿플레이스|병천순대|현대엔지니어링\s*베이커리)/i;
const LOCAL_LIFE_MERCHANT_PATTERN =
  /(베이커리|편의점|카페|마트|식당|분식|오프라인|푸드|치킨|순대|약국|슈퍼|커피|빵집|로컬\s*푸드)/i;
const PAYMENT_MERCHANT_PATTERN =
  /(가맹점명|구매상점명|상호명|merchant)\s*[:：]?\s*([^\n\r,]+)/i;
const PAYMENT_AMOUNT_PATTERNS: RegExp[] = [
  /(총\s*결제\s*금액|최종\s*결제\s*금액|결제\s*금액|결제금액|승인금액|청구금액)\s*[:：]?\s*([0-9][0-9,]*)\s*원/gi,
  /(amount|total)\s*[:：]?\s*(?:krw\s*)?([0-9][0-9,]*)/gi,
  /([0-9][0-9,]*)\s*원/gi,
];
const DEFAULT_TOPIC_CANDIDATE_MESSAGES = 10;
const EXPANDED_TOPIC_CANDIDATE_MESSAGES = 15;
const MAX_TOPIC_BODY_CHECKS = 2;
const CARD_ISSUER_PATTERNS: RegExp[] = [
  /(삼성카드|신한카드|현대카드|KB국민카드|국민카드|우리카드|롯데카드|하나카드|비씨카드|BC카드|NH카드|농협카드|카카오뱅크|토스뱅크)/i,
  /(카드종류|결제기관|카드사)\s*[:：]?\s*([^\n\r,]+)/i,
];
const lastSearchContextByUser = new Map<string, SearchContext>();
const taskContextByUser = new Map<string, ToolTaskContext>();
let documentClient: DynamoDBDocumentClient | null = null;

interface ToolTaskContext {
  status: "awaiting_source" | "active";
  taskFamily: ToolTaskFamily;
  sourceChoice: ToolSourceChoice | null;
  canonicalGoal: string;
  lastSearchQuery?: string;
  topicKeywords?: string[];
  lastQueryMode?: "payment_summary" | "topic_filtered_payment_summary";
  refinedFromFollowUp?: boolean;
  lastCandidateCount?: number;
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
  topicTags?: string[];
  matchedBy?: "snippet" | "body" | "query";
  isTravelRelated?: boolean;
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
      decisionSource?: "slm" | "deterministic";
      action: ToolIntentAdvisorAction | "deterministic";
      taskFamily?: ToolTaskFamily;
      sourceChoice?: ToolSourceChoice | null;
      followUpIntent?: ToolFollowUpIntent;
      confidence?: number;
      slmBackend?: SlmBackendKind;
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
      slmBackend?: SlmBackendKind;
    }
    | {
        type:
        | "paymentRefineStarted"
        | "paymentRefineUsedBodyCheck"
        | "paymentRefineCompleted"
        | "paymentRefineNoMatch";
        taskFamily?: ToolTaskFamily;
        topicKeywords?: string[];
        matchedCount?: number;
        candidateCount?: number;
        filteredCount?: number;
        bodyCheckedCount?: number;
        queryMode?: string;
        reason?: string;
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

function isDurableToolContextEnabled(): boolean {
  const value = process.env.TOOL_CONTEXT_STORE?.trim().toLowerCase();
  return value === "ddb" || value === "dynamodb";
}

function getDocumentClient(): DynamoDBDocumentClient {
  documentClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return documentClient;
}

function getToolContextItemKey(contextKey: string): { PK: string; SK: string } {
  return {
    PK: `${KEY_PREFIX.USER}${contextKey}`,
    SK: `${KEY_PREFIX.SETTING}${TOOL_CONTEXT_SETTING_KEY}`,
  };
}

function isToolTaskContext(value: unknown): value is ToolTaskContext {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ToolTaskContext>;
  return (
    (record.status === "awaiting_source" || record.status === "active") &&
    typeof record.taskFamily === "string" &&
    (record.sourceChoice === null || typeof record.sourceChoice === "string") &&
    typeof record.canonicalGoal === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.lastActivityAt === "string" &&
    typeof record.expiresAt === "string" &&
    typeof record.clarificationResendCount === "number"
  );
}

function getMemoryTaskContext(key: string): ToolTaskContext | undefined {
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

async function loadTaskContextFromStore(key: string): Promise<ToolTaskContext | undefined> {
  if (!isDurableToolContextEnabled()) return undefined;

  try {
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: process.env.SETTINGS_TABLE ?? TABLE_NAMES.SETTINGS,
        Key: getToolContextItemKey(key),
      }),
    );
    const context = (result.Item as { context?: unknown } | undefined)?.context;
    if (!isToolTaskContext(context)) return undefined;
    if (isExpired(context.expiresAt)) {
      await clearTaskContext(key);
      return undefined;
    }
    taskContextByUser.set(key, context);
    return context;
  } catch (err) {
    console.warn("[gmail-tool] Failed to load durable tool context", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function getTaskContext(key: string): Promise<ToolTaskContext | undefined> {
  return getMemoryTaskContext(key) ?? loadTaskContextFromStore(key);
}

async function setTaskContext(key: string, context: ToolTaskContext): Promise<void> {
  taskContextByUser.set(key, context);
  if (!isDurableToolContextEnabled()) return;

  try {
    await getDocumentClient().send(
      new PutCommand({
        TableName: process.env.SETTINGS_TABLE ?? TABLE_NAMES.SETTINGS,
        Item: {
          ...getToolContextItemKey(key),
          context,
          updatedAt: nowIso(),
          ttl: Math.floor(Date.parse(context.expiresAt) / 1000),
        },
      }),
    );
  } catch (err) {
    console.warn("[gmail-tool] Failed to persist durable tool context", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function clearTaskContext(key: string): Promise<void> {
  taskContextByUser.delete(key);
  if (!isDurableToolContextEnabled()) return;

  try {
    await getDocumentClient().send(
      new DeleteCommand({
        TableName: process.env.SETTINGS_TABLE ?? TABLE_NAMES.SETTINGS,
        Key: getToolContextItemKey(key),
      }),
    );
  } catch (err) {
    console.warn("[gmail-tool] Failed to delete durable tool context", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeWhitespace(value)).filter(Boolean))];
}

function extractTopicKeywords(message: string): string[] {
  const normalized = normalizeWhitespace(message);
  const keywords = new Set<string>();

  if (/일본|japan/i.test(normalized)) {
    for (const keyword of ["일본", "japan", "여행", "travel", "trip", "esim", "eSIM"]) {
      keywords.add(keyword);
    }
  }
  if (TRAVEL_DESTINATION_PATTERN.test(normalized)) {
    for (const keyword of [
      "일본",
      "japan",
      "도쿄",
      "tokyo",
      "오사카",
      "osaka",
      "교토",
      "kyoto",
      "후쿠오카",
      "fukuoka",
      "삿포로",
      "sapporo",
      "오키나와",
      "okinawa",
      "나고야",
      "nagoya",
      "나리타",
      "narita",
      "하네다",
      "haneda",
      "간사이",
      "kansai",
    ]) {
      if (normalized.includes(keyword)) {
        keywords.add(keyword);
      }
    }
  }
  if (/여행|travel|trip/i.test(normalized)) {
    for (const keyword of [
      "여행",
      "travel",
      "trip",
      "해외",
      "overseas",
      "항공",
      "flight",
      "호텔",
      "hotel",
      "숙소",
      "esim",
      "예약",
      "booking",
    ]) {
      keywords.add(keyword);
    }
  }
  if (/해외|overseas/i.test(normalized)) {
    for (const keyword of ["해외", "overseas", "여행", "travel"]) {
      keywords.add(keyword);
    }
  }
  if (/항공|flight|airline/i.test(normalized)) {
    for (const keyword of ["항공", "flight"]) {
      keywords.add(keyword);
    }
  }
  if (/공항|airport|셔틀|shuttle|리무진|limousine|버스|bus/i.test(normalized)) {
    for (const keyword of ["공항", "airport", "셔틀", "shuttle", "리무진", "버스"]) {
      keywords.add(keyword);
    }
  }
  if (/호텔|hotel|숙소|stay/i.test(normalized)) {
    for (const keyword of ["호텔", "hotel", "숙소"]) {
      keywords.add(keyword);
    }
  }
  if (/숙박|lodging|게스트하우스|guesthouse|료칸|ryokan|리조트|resort/i.test(normalized)) {
    for (const keyword of ["숙박", "lodging", "게스트하우스", "료칸", "리조트"]) {
      keywords.add(keyword);
    }
  }
  if (/esim|e-sim/i.test(normalized)) {
    for (const keyword of ["esim", "eSIM"]) {
      keywords.add(keyword);
    }
  }
    if (/패스|pass|jr|rail|기차|train|전철|철도|지하철|subway|메트로|metro/i.test(normalized)) {
      for (const keyword of ["패스", "pass", "jr", "rail", "기차", "train", "지하철", "subway", "메트로", "metro"]) {
        keywords.add(keyword);
      }
    }
    if (/예약|booking|agoda|airbnb|rentalcars|rentacar|렌터카/i.test(normalized)) {
      for (const keyword of ["예약", "booking", "호텔", "렌터카", "rentalcars"]) {
        keywords.add(keyword);
      }
    }
  if (TRAVEL_PLATFORM_PATTERN.test(normalized)) {
    for (const keyword of [
      "마이리얼트립",
      "myrealtrip",
      "trip.com",
      "아고다",
      "agoda",
      "booking",
      "airbnb",
      "klook",
      "kkday",
        "익스피디아",
        "expedia",
        "호텔스닷컴",
        "rentalcars",
      ]) {
        if (normalized.includes(keyword.toLowerCase())) {
          keywords.add(keyword);
        }
      }
    }
    if (/jr|rail/i.test(normalized)) {
      for (const keyword of ["jr", "rail"]) {
        keywords.add(keyword);
      }
    }
    if (/렌터카|rental\s*car|rentalcars|rentacar/i.test(normalized)) {
      for (const keyword of ["렌터카", "rentalcars"]) {
        keywords.add(keyword);
      }
    }
    if (/페리|ferry/i.test(normalized)) {
      for (const keyword of ["페리", "ferry"]) {
        keywords.add(keyword);
      }
    }

  const stopwords = new Set([
    "결제",
    "내역",
    "알려줘",
    "정리해줄래",
    "정리",
    "요약",
    "가져와",
    "가져와야지",
    "것만",
    "관련된",
    "관련",
    "이번주",
    "이번",
    "주",
    "카드",
    "명세서",
    "영수증",
    "얼마",
  ]);
  for (const token of normalized.split(/\s+/)) {
    const cleaned = token.replace(/[^\p{L}\p{N}]/gu, "");
    if (cleaned.length < 2 || stopwords.has(cleaned.toLowerCase())) {
      continue;
    }
    if (/^[0-9]+$/.test(cleaned)) {
      continue;
    }
    if (TRAVEL_SIGNAL_PATTERN.test(cleaned)) {
      keywords.add(cleaned);
    }
  }

  return uniqueStrings([...keywords]).slice(0, 8);
}

function extractTopicTags(text: string, topicKeywords: string[]): string[] {
  const normalized = text.toLowerCase();
  const tags = new Set<string>();

  for (const keyword of topicKeywords) {
    if (normalized.includes(keyword.toLowerCase())) {
      tags.add(keyword);
    }
  }

  if (TRAVEL_SIGNAL_PATTERN.test(text)) {
    if (/일본|japan/i.test(text)) tags.add("일본");
    if (/여행|travel|trip/i.test(text)) tags.add("여행");
    if (/항공|flight|airline/i.test(text)) tags.add("항공");
    if (/호텔|hotel|숙소|stay/i.test(text)) tags.add("호텔");
    if (/esim|e-sim/i.test(text)) tags.add("eSIM");
    if (/jr|rail/i.test(text)) tags.add("JR");
  }

  return uniqueStrings([...tags]);
}

function buildTravelEvidenceText(record: ParsedPaymentRecord): string {
  return [record.subject, record.from, record.snippet, record.merchant]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function hasDestinationSpecificTopic(topicKeywords: string[]): boolean {
  return topicKeywords.some((keyword) => TRAVEL_DESTINATION_PATTERN.test(keyword));
}

function hasDestinationEvidence(text: string, tags: string[]): boolean {
  if (TRAVEL_DESTINATION_PATTERN.test(text)) {
    return true;
  }

  return tags.some((tag) => TRAVEL_DESTINATION_PATTERN.test(tag));
}

function hasStrongTravelEvidence(text: string, tags: string[]): boolean {
  if (
    TRAVEL_DESTINATION_PATTERN.test(text) ||
    TRAVEL_PLATFORM_PATTERN.test(text) ||
    STRONG_TRAVEL_EVIDENCE_PATTERN.test(text)
  ) {
    return true;
  }

  return tags.some(
    (tag) =>
      TRAVEL_DESTINATION_PATTERN.test(tag) ||
      TRAVEL_PLATFORM_PATTERN.test(tag) ||
      STRONG_TRAVEL_EVIDENCE_PATTERN.test(tag),
  );
}

function scoreTravelRecord(
  record: ParsedPaymentRecord,
  topicKeywords: string[],
): { score: number; tags: string[]; confident: boolean } {
  const evidenceText = buildTravelEvidenceText(record);
  const tags = mergeTopicKeywords(record.topicTags, extractTopicTags(evidenceText, topicKeywords));
  const destinationScoped = hasDestinationSpecificTopic(topicKeywords);
  const destinationEvidence = hasDestinationEvidence(evidenceText, tags);
  const strongEvidence = hasStrongTravelEvidence(evidenceText, tags);
  let score = 0;

  if (POLICY_NOTICE_PATTERN.test(evidenceText)) {
    score -= 6;
  }
  if (ORDER_ONLY_PATTERN.test(evidenceText)) {
    score -= 2;
  }
  if (TRAVEL_DESTINATION_PATTERN.test(evidenceText)) {
    score += 3;
  }
  if (TRAVEL_PLATFORM_PATTERN.test(evidenceText)) {
    score += 3;
  }
  if (TRAVEL_POSITIVE_PATTERN.test(evidenceText)) {
    score += 4;
  }
  if (TRAVEL_NEGATIVE_PATTERN.test(evidenceText)) {
    score -= 3;
  }
  if (record.merchant && TRAVEL_PLATFORM_PATTERN.test(record.merchant)) {
    score += 2;
  }
  if (LOCAL_LIFE_MERCHANT_PATTERN.test(record.merchant ?? record.subject)) {
    score -= 3;
  }
  if (topicKeywords.length > 0) {
    score += Math.min(tags.length, 3) * 2;
  }
  if (record.matchedBy === "body" || record.source === "body") {
    score += 1;
  }
  if (!record.amount) {
    score -= 1;
  }

  return {
    score,
    tags,
    confident: destinationScoped
      ? score >= 3 && destinationEvidence
      : score >= 2 && (strongEvidence || tags.length > 0),
  };
}

function refineTravelPaymentRecords(
  records: ParsedPaymentRecord[],
  topicKeywords: string[],
): ParsedPaymentRecord[] {
  return records
    .map((record) => {
      const evaluation = scoreTravelRecord(record, topicKeywords);
      return {
        record: {
          ...record,
          topicTags: evaluation.tags,
          isTravelRelated: evaluation.confident,
        },
        score: evaluation.score,
        confident: evaluation.confident,
      };
    })
    .filter((entry) => entry.confident)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if ((right.record.amount ?? 0) !== (left.record.amount ?? 0)) {
        return (right.record.amount ?? 0) - (left.record.amount ?? 0);
      }
      return right.record.date.localeCompare(left.record.date);
    })
    .map((entry) => entry.record);
}

function filterMessagesByRecords(
  messages: GmailMessageSummary[],
  records: ParsedPaymentRecord[],
): GmailMessageSummary[] {
  if (records.length === 0) {
    return [];
  }

  const ids = new Set(records.map((record) => record.messageId));
  return messages.filter((message) => ids.has(message.id));
}

function cleanMerchantValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = normalizeWhitespace(value)
    .replace(/^["'[\]\s]+|["'[\]\s]+$/g, "")
    .replace(
      /\s*(총\s*결제\s*금액|최종결제금액|최종\s*결제\s*금액|상품금액|결제수단|결제\s*내역은|주문상품명|주문번호|승인번호|할부기간|ㄴ\s*상품금액|영수증\s*출력|english\s*receipt|-+\s*결제\s*내역은).*/i,
      "",
    )
    .replace(/\s+-\s*$/, "")
    .trim();

  if (!cleaned || cleaned.length < 2) {
    return undefined;
  }

  if (/^(결제정보|payment|merchant)$/i.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}

function mergeTopicKeywords(...groups: Array<string[] | undefined>): string[] {
  return uniqueStrings(groups.flatMap((group) => group ?? []));
}

function selectTopicQueryKeywords(topicKeywords: string[]): string[] {
  const destinationKeyword = topicKeywords.find((keyword) =>
    /일본|japan|도쿄|tokyo|오사카|osaka|교토|kyoto|후쿠오카|fukuoka|삿포로|sapporo|오키나와|okinawa|나고야|nagoya/i.test(
      keyword,
    ),
  );
  if (destinationKeyword) {
    return [destinationKeyword];
  }

  const productKeyword = topicKeywords.find((keyword) =>
    /esim|e-sim|항공|flight|호텔|hotel|숙소|stay|jr|rail|공항|airport/i.test(keyword),
  );
  if (productKeyword) {
    return [productKeyword];
  }

  const travelKeyword = topicKeywords.find((keyword) =>
    /여행|travel|trip/i.test(keyword),
  );
  if (travelKeyword) {
    return [travelKeyword];
  }

  return topicKeywords.slice(0, 1);
}

function resolveInitialTopicCandidateLimit(maxMessages: number): number {
  return Math.max(maxMessages, DEFAULT_TOPIC_CANDIDATE_MESSAGES);
}

function resolveExpandedTopicCandidateLimit(maxMessages: number): number {
  return Math.max(maxMessages, EXPANDED_TOPIC_CANDIDATE_MESSAGES);
}

function isTopicRefinementFollowUp(message: string): boolean {
  const extracted = extractTopicKeywords(message);
  return extracted.length > 0 || TRAVEL_REFINEMENT_PATTERN.test(message);
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

function buildPaymentSearchQuery(
  message: string,
  unreadOnly: boolean,
  topicKeywords: string[] = [],
): string {
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
  parts.push(...selectTopicQueryKeywords(topicKeywords));
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
    `/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&fields=id,threadId,snippet,payload/headers`,
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
    return cleanMerchantValue(directMatch[2]);
  }

  const subjectMatch =
    subject.match(/(.+?)에서\s*(?:결제|승인)/) ??
    subject.match(/(.+?)의\s*(?:결제|승인)\s*내역/);
  if (subjectMatch?.[1]) {
    return cleanMerchantValue(
      subjectMatch[1].replace(/^[["']+/, "").replace(/[\]"']+$/, ""),
    );
  }

  const merchantHint =
    snippet.match(/가맹점명\s*([^\n\r]+)/i) ??
    snippet.match(/구매상점명\s*([^\n\r]+)/i) ??
    snippet.match(/([^\n\r]+?)\s*(?:총\s*결제\s*금액|결제금액|최종결제금액)/i);
  if (merchantHint?.[1]) {
    return cleanMerchantValue(merchantHint[1]);
  }

  return undefined;
}

function looksLikePolicyNotice(subject: string, snippet: string): boolean {
  return POLICY_NOTICE_PATTERN.test(`${subject}\n${snippet}`);
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

function buildPaymentRecord(
  summary: GmailMessageSummary,
  topicKeywords: string[] = [],
): ParsedPaymentRecord | null {
  const signalText = `${summary.subject}\n${summary.snippet}`;
  const hasPaymentSignal = PAYMENT_SIGNAL_PATTERN.test(signalText);
  const looksLikeOrderOnly =
    ORDER_ONLY_PATTERN.test(signalText) && !hasPaymentSignal && !/결제금액|최종결제금액/.test(signalText);
  if (looksLikePolicyNotice(summary.subject, summary.snippet) && !/\d[\d,]*\s*원/.test(signalText)) {
    return null;
  }
  if (looksLikeOrderOnly) {
    return null;
  }

  const amount = pickBestAmount(signalText);
  const merchant = extractMerchant(summary.subject, summary.snippet);
  const cardIssuer = extractCardIssuer(signalText);
  const topicTags = extractTopicTags(`${signalText}\n${merchant ?? ""}`, topicKeywords);
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
    topicTags,
    matchedBy: topicTags.length > 0 ? "query" : "snippet",
    isTravelRelated: topicTags.length > 0,
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

function filterRecordsByTopic(
  records: ParsedPaymentRecord[],
  topicKeywords: string[],
): ParsedPaymentRecord[] {
  if (topicKeywords.length === 0) {
    return records;
  }

  return refineTravelPaymentRecords(records, topicKeywords);
}

function buildTopicFilteredPaymentSummaryResponse(
  query: string,
  records: ParsedPaymentRecord[],
  topicKeywords: string[],
  usedBodyCheck: boolean,
): string {
  const total = records.reduce((sum, record) => sum + (record.amount ?? 0), 0);
  const topicLabel = topicKeywords.join(", ");
  const lines = records
    .slice()
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, 5)
    .map((record, index) => {
      const merchant = record.merchant ?? record.subject;
      const amount = record.amount ? formatCurrency(record.amount) : "amount unavailable";
      const issuer = record.cardIssuer ?? "Unknown issuer";
      const evidenceBits = [
        record.matchedBy ? `matched by ${record.matchedBy}` : undefined,
        record.topicTags && record.topicTags.length > 0 ? record.topicTags.join(", ") : undefined,
      ].filter(Boolean);
      const evidence = evidenceBits.length > 0 ? evidenceBits.join(" · ") : "travel context";
      return [
        `${index + 1}. Merchant: ${merchant}`,
        `   Amount: ${amount}`,
        `   Card: ${issuer}`,
        `   Date: ${record.date}`,
        `   Evidence: ${evidence}`,
      ].join("\n");
    });

  return [
    `I filtered the Gmail payment context for travel-related payments linked to: ${topicLabel}.`,
    `Topic-aware query: "${query}".`,
    "I stayed in headers-first mode by default.",
    usedBodyCheck
      ? "I opened up to 2 short email bodies only where snippet evidence was ambiguous."
      : "I did not open full bodies or attachments.",
    `Estimated topic-linked total: ${formatCurrency(total)} across ${records.length} matched payment message(s).`,
    "",
    "Matched travel-related payments:",
    ...lines,
  ].join("\n");
}

async function fetchPaymentMessages(
  accessToken: string,
  query: string,
  maxMessages: number,
  topicKeywords: string[] = [],
): Promise<{
  candidateCount: number;
  messages: GmailMessageSummary[];
  records: ParsedPaymentRecord[];
}> {
  const listJson = await gmailApiRequest<GmailListResponse>(
    accessToken,
    `/messages?q=${encodeURIComponent(query)}&maxResults=${maxMessages}`,
  );
  const ids = listJson.messages?.map((item) => item.id) ?? [];
  const messages = await Promise.all(ids.map((id) => fetchMessageSummary(accessToken, id)));
  const records = messages
    .map((summary) => buildPaymentRecord(summary, topicKeywords))
    .filter((record): record is ParsedPaymentRecord => Boolean(record));

  return {
    candidateCount: messages.length,
    messages,
    records,
  };
}

async function refineRecordsWithBodyChecks(
  accessToken: string,
  records: ParsedPaymentRecord[],
  topicKeywords: string[],
  maxBodyChars: number,
): Promise<{
  records: ParsedPaymentRecord[];
  usedBodyCheck: boolean;
  bodyCheckedCount: number;
}> {
  const refined = records.map((record) => ({ ...record }));
  const candidates = refined
    .filter((record) => !scoreTravelRecord(record, topicKeywords).confident)
    .filter((record) => Boolean(record.amount || record.merchant))
    .slice(0, MAX_TOPIC_BODY_CHECKS);

  if (candidates.length === 0) {
    return { records: refined, usedBodyCheck: false, bodyCheckedCount: 0 };
  }

  for (const candidate of candidates) {
    const full = await fetchMessageBody(accessToken, candidate.messageId);
    const bodySlice = full.body.slice(0, maxBodyChars);
    const bodyTags = extractTopicTags(
      `${full.subject}\n${full.snippet}\n${candidate.merchant ?? ""}\n${bodySlice}`,
      topicKeywords,
    );
    if (bodyTags.length > 0) {
      candidate.topicTags = uniqueStrings([...(candidate.topicTags ?? []), ...bodyTags]);
      candidate.isTravelRelated = true;
      candidate.matchedBy = "body";
    }
  }

  return {
    records: refined,
    usedBodyCheck: candidates.length > 0,
    bodyCheckedCount: candidates.length,
  };
}

async function searchTopicAwarePaymentCandidates(
  accessToken: string,
  message: string,
  unreadOnly: boolean,
  topicKeywords: string[],
  emailTokenBudget: EmailTokenBudgetPolicy,
): Promise<{
  query: string;
  candidateCount: number;
  filteredCount: number;
  bodyCheckedCount: number;
  queryMode: "topic-filtered" | "broad-fallback";
  messages: GmailMessageSummary[];
  records: ParsedPaymentRecord[];
  usedBodyCheck: boolean;
}> {
  const initialCandidateLimit = resolveInitialTopicCandidateLimit(
    emailTokenBudget.maxMessages,
  );
  const expandedCandidateLimit = resolveExpandedTopicCandidateLimit(
    initialCandidateLimit,
  );
  const narrowedQuery = buildPaymentSearchQuery(message, unreadOnly, topicKeywords);
  let query = narrowedQuery;
  let queryMode: "topic-filtered" | "broad-fallback" = "topic-filtered";
  let candidateCount = 0;
  let filteredCount = 0;
  let bodyCheckedCount = 0;
  let usedBodyCheck = false;

  const narrowedResult = await fetchPaymentMessages(
    accessToken,
    narrowedQuery,
    initialCandidateLimit,
    topicKeywords,
  );
  candidateCount = narrowedResult.candidateCount;
  let messages = narrowedResult.messages;
  let records = narrowedResult.records;
  let matched = filterRecordsByTopic(records, topicKeywords);
  filteredCount = matched.length;

  if (matched.length === 0 && records.length > 0) {
    const bodyRefined = await refineRecordsWithBodyChecks(
      accessToken,
      records,
      topicKeywords,
      emailTokenBudget.maxBodyChars,
    );
    records = bodyRefined.records;
    matched = filterRecordsByTopic(records, topicKeywords);
    filteredCount = matched.length;
    bodyCheckedCount += bodyRefined.bodyCheckedCount;
    usedBodyCheck = bodyRefined.usedBodyCheck;
  }

  if (matched.length === 0) {
    const broadQuery = buildPaymentSearchQuery(message, unreadOnly);
    if (broadQuery !== narrowedQuery) {
      query = broadQuery;
      queryMode = "broad-fallback";
      const broadResult = await fetchPaymentMessages(
        accessToken,
        broadQuery,
        expandedCandidateLimit,
        topicKeywords,
      );
      candidateCount = broadResult.candidateCount;
      messages = broadResult.messages;
      records = broadResult.records;
      matched = filterRecordsByTopic(records, topicKeywords);
      filteredCount = matched.length;

      if (matched.length === 0 && records.length > 0) {
        const broadBodyRefined = await refineRecordsWithBodyChecks(
          accessToken,
          records,
          topicKeywords,
          emailTokenBudget.maxBodyChars,
        );
        records = broadBodyRefined.records;
        matched = filterRecordsByTopic(records, topicKeywords);
        filteredCount = matched.length;
        bodyCheckedCount += broadBodyRefined.bodyCheckedCount;
        usedBodyCheck = usedBodyCheck || broadBodyRefined.usedBodyCheck;
      }
    }
  }

  return {
    query,
    candidateCount,
    filteredCount,
    bodyCheckedCount,
    queryMode,
    messages,
    records: matched,
    usedBodyCheck,
  };
}

async function refineActivePaymentContextByTopic(
  contextKey: string,
  context: ToolTaskContext,
  options: MaybeHandleCustomGmailRequestOptions,
): Promise<ToolHandlerResult> {
  const topicKeywords = mergeTopicKeywords(
    context.topicKeywords,
    extractTopicKeywords(context.canonicalGoal),
    extractTopicKeywords(options.message),
  );
  emitToolEvent(options.onToolEvent, {
    type: "paymentRefineStarted",
    taskFamily: context.taskFamily,
    topicKeywords,
    candidateCount: context.lastCandidateCount,
    filteredCount: context.parsedPaymentRecords?.length ?? 0,
  });

  const currentMatches = filterRecordsByTopic(context.parsedPaymentRecords ?? [], topicKeywords);
  if (currentMatches.length > 0) {
    const nextContext: ToolTaskContext = {
      ...context,
      topicKeywords,
      lastQueryMode: "topic_filtered_payment_summary",
      refinedFromFollowUp: true,
      parsedPaymentRecords: currentMatches,
      lastResultSummary: currentMatches.map((record) => record.subject).join(" | "),
      lastActivityAt: nowIso(),
      expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
    };
    await setTaskContext(contextKey, nextContext);
      emitToolEvent(options.onToolEvent, {
        type: "paymentRefineCompleted",
        taskFamily: context.taskFamily,
        topicKeywords,
        candidateCount: context.lastCandidateCount ?? currentMatches.length,
        filteredCount: currentMatches.length,
        matchedCount: currentMatches.length,
        bodyCheckedCount: 0,
        queryMode: "cached-context",
      });
    return {
      kind: "direct",
      message: buildTopicFilteredPaymentSummaryResponse(
        context.lastSearchQuery ?? "current-payment-context",
        currentMatches,
        topicKeywords,
        false,
      ),
      source: "gmail-context",
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

  const accessToken = await refreshAccessToken(credentials);
  if (!accessToken) {
    return {
      kind: "direct",
      message: buildGmailUnavailableMessage(),
      source: "gmail-fallback",
    };
  }

  const unreadOnly = Boolean(context.lastSearchQuery?.includes("is:unread"));
  const searchResult = await searchTopicAwarePaymentCandidates(
    accessToken,
    context.canonicalGoal,
    unreadOnly,
    topicKeywords,
    options.emailTokenBudget,
  );

  if (searchResult.usedBodyCheck) {
    emitToolEvent(options.onToolEvent, {
      type: "paymentRefineUsedBodyCheck",
      taskFamily: context.taskFamily,
      topicKeywords,
      candidateCount: searchResult.candidateCount,
      filteredCount: searchResult.filteredCount,
      bodyCheckedCount: searchResult.bodyCheckedCount,
      queryMode: searchResult.queryMode,
    });
  }

  if (searchResult.records.length === 0) {
    emitToolEvent(options.onToolEvent, {
      type: "paymentRefineNoMatch",
      taskFamily: context.taskFamily,
      topicKeywords,
      candidateCount: searchResult.candidateCount,
      filteredCount: 0,
      bodyCheckedCount: searchResult.bodyCheckedCount,
      queryMode: searchResult.queryMode,
      reason: "no-travel-payment-match",
    });
    return {
      kind: "direct",
      message:
        `I searched for travel-related payments linked to ${topicKeywords.join(", ")}, but I could not confidently confirm any visible payment emails as part of that trip.\n` +
        "Please narrow it by period, merchant, or point me to one specific email body by number.",
      source: "gmail-context",
    };
  }

  const nextContext: ToolTaskContext = {
    ...context,
      topicKeywords,
      lastQueryMode: "topic_filtered_payment_summary",
      refinedFromFollowUp: true,
      lastCandidateCount: searchResult.candidateCount,
      parsedPaymentRecords: searchResult.records,
      lastMessages: searchResult.messages,
      lastSearchQuery: searchResult.query,
      lastResultSummary: searchResult.records.map((record) => record.subject).join(" | "),
      lastActivityAt: nowIso(),
      expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
    };
  await setTaskContext(contextKey, nextContext);
    emitToolEvent(options.onToolEvent, {
      type: "paymentRefineCompleted",
      taskFamily: context.taskFamily,
      topicKeywords,
      candidateCount: searchResult.candidateCount,
      filteredCount: searchResult.filteredCount,
      matchedCount: searchResult.records.length,
      bodyCheckedCount: searchResult.bodyCheckedCount,
      queryMode: searchResult.queryMode,
    });
    return {
      kind: "direct",
      message: buildTopicFilteredPaymentSummaryResponse(
        searchResult.query,
        searchResult.records,
        topicKeywords,
        searchResult.usedBodyCheck,
      ),
      source: "gmail-context",
    };
  }

function formatPaymentFollowUp(
  context: ToolTaskContext,
  message: string,
  maxMessages: number,
  followUpIntent?: ToolFollowUpIntent,
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

  if (followUpIntent === "coverage_check" || /더\s*(있|찾|보)|밖에\s*없|몇\s*개|개수|건수|limit/i.test(normalized)) {
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

  if (followUpIntent === "issuer_breakdown" || /카드사|issuer/i.test(normalized)) {
    const grouped = new Map<string, { total: number; count: number }>();
    for (const record of records) {
      const key = record.cardIssuer ?? "Unknown";
      const current = grouped.get(key) ?? { total: 0, count: 0 };
      current.total += record.amount ?? 0;
      current.count += 1;
      grouped.set(key, current);
    }
    const lines = [...grouped.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(
        ([issuer, value]) =>
          `- ${issuer}: ${formatCurrency(value.total)} (${value.count}건)`,
      );
    return {
      kind: "direct",
      message: `Within the current Gmail payment context, here is the card-issuer breakdown:\n${lines.join("\n")}`,
      source: "gmail-context",
    };
  }

  if (followUpIntent === "merchant_breakdown" || /결제처|가맹점|merchant/i.test(normalized)) {
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

  if (followUpIntent === "amount_summary" || /합계|총액|sum|total/i.test(normalized)) {
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

function shouldKeepPaymentContextByIntent(followUpIntent?: ToolFollowUpIntent): boolean {
  return [
    "continue_active_task",
    "refine_topic",
    "refine_date",
    "issuer_breakdown",
    "merchant_breakdown",
    "amount_summary",
    "coverage_check",
    "open_body",
  ].includes(followUpIntent ?? "");
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
  const topicKeywords =
    taskFamily === "gmail_payment_summary" ? extractTopicKeywords(sourceMessage) : [];
  const unreadOnly = !/\ball\b|전체|모두/i.test(sourceMessage);
  const primaryQuery = buildPaymentSearchQuery(sourceMessage, unreadOnly, topicKeywords);
  let query = primaryQuery;
  let candidateCount = options.emailTokenBudget.maxMessages;
  let messages: GmailMessageSummary[] = [];
  let paymentRecords: ParsedPaymentRecord[] = [];
  let usedBodyCheck = false;

  if (taskFamily === "gmail_payment_summary" && topicKeywords.length > 0) {
    const searchResult = await searchTopicAwarePaymentCandidates(
      accessToken,
      sourceMessage,
      unreadOnly,
      topicKeywords,
      options.emailTokenBudget,
    );
    query = searchResult.query;
    candidateCount = searchResult.candidateCount;
    messages = searchResult.messages;
    paymentRecords = searchResult.records;
    usedBodyCheck = searchResult.usedBodyCheck;
  } else {
    const standardResult = await fetchPaymentMessages(
      accessToken,
      primaryQuery,
      options.emailTokenBudget.maxMessages,
      topicKeywords,
    );
    candidateCount = standardResult.candidateCount;
    messages = standardResult.messages;
    paymentRecords = standardResult.records;
  }

  if (taskFamily === "gmail_payment_summary" && topicKeywords.length > 0) {
    paymentRecords = refineTravelPaymentRecords(paymentRecords, topicKeywords);
    messages = filterMessagesByRecords(messages, paymentRecords);
  }

  setSearchContext(contextKey, {
    messages,
    query,
    createdAt: nowIso(),
  });

  const taskContext: ToolTaskContext = {
    status: "active",
    taskFamily,
    sourceChoice: "gmail",
    canonicalGoal: sourceMessage,
    lastSearchQuery: query,
    topicKeywords,
    lastQueryMode:
      topicKeywords.length > 0 ? "topic_filtered_payment_summary" : "payment_summary",
    refinedFromFollowUp: false,
    lastCandidateCount: candidateCount,
    parsedPaymentRecords: paymentRecords,
    lastMessages: messages,
    lastResultSummary: messages.map((item) => item.subject).join(" | "),
    createdAt: nowIso(),
    lastActivityAt: nowIso(),
    expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
    clarificationResendCount: 0,
  };
  await setTaskContext(contextKey, taskContext);
  emitToolEvent(options.onToolEvent, {
    type: "contextCreated",
    taskFamily,
    sourceChoice: "gmail",
  });

  if (taskFamily === "gmail_payment_summary" && paymentRecords.length === 0) {
    return {
      kind: "direct",
      message:
        topicKeywords.length > 0
          ? `I searched for travel-related payments linked to ${topicKeywords.join(", ")}, but I could not confidently match any visible payment emails to that trip. Please narrow it by period, merchant, or ask me to inspect one specific email body.`
          : messages.length === 0
          ? "I did not find payment-related Gmail messages in the visible window. Please narrow it by period, sender, or card issuer."
          : "I found candidate Gmail messages, but I could not extract reliable payment amounts from the visible headers/snippets. Please narrow it by sender, period, or ask me to open one specific email body.",
      source: "gmail-fallback",
    };
  }

  return {
    kind: "direct",
    message:
      taskFamily === "gmail_payment_summary"
        ? topicKeywords.length > 0
          ? buildTopicFilteredPaymentSummaryResponse(
              query,
              paymentRecords,
              topicKeywords,
              usedBodyCheck,
            )
          : buildPaymentSummaryResponse(query, messages, paymentRecords)
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

function shouldPreferPaymentSummaryTask(
  message: string,
  activeContext?: ToolTaskContext,
): boolean {
  if (isBodyRequest(message) || isAttachmentRequest(message)) {
    return false;
  }

  if (
    looksLikePaymentQuestion(message) ||
    isPaymentFollowUp(message) ||
    isTopicRefinementFollowUp(message)
  ) {
    return true;
  }

  if (!activeContext) {
    return false;
  }

  if (activeContext.taskFamily === "gmail_payment_summary") {
    return true;
  }

  return Boolean(
    activeContext.parsedPaymentRecords?.length ||
      looksLikePaymentQuestion(activeContext.canonicalGoal) ||
      isTopicRefinementFollowUp(activeContext.canonicalGoal),
  );
}

function normalizeTaskFamilyForMessage(
  action: ToolIntentAdvisorAction,
  taskFamily: ToolTaskFamily,
  message: string,
  activeContext?: ToolTaskContext,
): ToolTaskFamily {
  if (
    (action === "gmail" || action === "continue_active_task") &&
    taskFamily === "gmail_search" &&
    shouldPreferPaymentSummaryTask(message, activeContext)
  ) {
    return "gmail_payment_summary";
  }
  return taskFamily;
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
  return !looksLikePaymentQuestion(message) && !isExplicitGmailMessage(message) && !isPaymentFollowUp(message) && !isBodyRequest(message) && !TRAVEL_REFINEMENT_PATTERN.test(message) && extractTopicKeywords(message).length === 0;
}

async function handleAwaitingSourceContext(
  contextKey: string,
  context: ToolTaskContext,
  options: MaybeHandleCustomGmailRequestOptions,
): Promise<ToolHandlerResult | undefined> {
  const trimmed = normalizeWhitespace(options.message);
  if (CANCEL_PATTERN.test(trimmed)) {
    await clearTaskContext(contextKey);
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
      await clearTaskContext(contextKey);
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
    await clearTaskContext(contextKey);
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
    await setTaskContext(contextKey, nextContext);
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

  await clearTaskContext(contextKey);
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
  followUpIntent?: ToolFollowUpIntent,
): Promise<ToolHandlerResult | undefined> {
  const trimmed = normalizeWhitespace(options.message);
  if (CANCEL_PATTERN.test(trimmed)) {
    await clearTaskContext(contextKey);
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

  let effectiveContext = context;
  if (
    context.taskFamily === "gmail_search" &&
    context.sourceChoice === "gmail" &&
    shouldPreferPaymentSummaryTask(trimmed, context)
  ) {
    effectiveContext = {
      ...context,
      taskFamily: "gmail_payment_summary",
      lastActivityAt: nowIso(),
      expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
    };
    await setTaskContext(contextKey, effectiveContext);
  }

  if (
    effectiveContext.taskFamily === "gmail_payment_summary" &&
    effectiveContext.sourceChoice === "gmail"
  ) {
    if (followUpIntent === "open_body" || isBodyRequest(trimmed) || isAttachmentRequest(trimmed)) {
      const credentials = await loadGmailCredentials();
      if (!credentials) {
        return {
          kind: "direct",
          message: buildGmailUnavailableMessage(),
          source: "gmail-fallback",
        };
      }
      const nextContext: ToolTaskContext = {
        ...effectiveContext,
        lastActivityAt: nowIso(),
        expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
      };
      await setTaskContext(contextKey, nextContext);
      emitToolEvent(options.onToolEvent, {
        type: "contextReused",
        taskFamily: nextContext.taskFamily,
        sourceChoice: nextContext.sourceChoice,
      });
      return runGmailTask(
        contextKey,
        options,
        "gmail_body_selection",
        trimmed,
        credentials,
      );
    }

    if (!shouldKeepPaymentContextByIntent(followUpIntent) && isClearlyUnrelated(trimmed)) {
      await clearTaskContext(contextKey);
      emitToolEvent(options.onToolEvent, {
        type: "contextCleared",
        taskFamily: effectiveContext.taskFamily,
        reason: "topic-switch",
      });
      return undefined;
    }

    const nextContext: ToolTaskContext = {
      ...effectiveContext,
      lastActivityAt: nowIso(),
      expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
    };
    await setTaskContext(contextKey, nextContext);
    emitToolEvent(options.onToolEvent, {
      type: "contextReused",
      taskFamily: nextContext.taskFamily,
      sourceChoice: nextContext.sourceChoice,
    });
    if (followUpIntent === "refine_topic" || isTopicRefinementFollowUp(trimmed)) {
      return refineActivePaymentContextByTopic(contextKey, nextContext, options);
    }
    return formatPaymentFollowUp(
      nextContext,
      trimmed,
      options.emailTokenBudget.maxMessages,
      followUpIntent,
    );
  }

  return undefined;
}

export async function maybeHandleCustomGmailRequest(
  options: MaybeHandleCustomGmailRequestOptions,
): Promise<ToolHandlerResult | undefined> {
  const contextKey = getContextKey(options.userId, options.sessionKey);
  const activeContext = await getTaskContext(contextKey);

  if (activeContext && isExpired(activeContext.expiresAt)) {
    await clearTaskContext(contextKey);
    emitToolEvent(options.onToolEvent, {
      type: "contextExpired",
      taskFamily: activeContext.taskFamily,
      sourceChoice: activeContext.sourceChoice,
    });
  }

  const currentContext = await getTaskContext(contextKey);
  if (currentContext?.status === "awaiting_source") {
    const handled = await handleAwaitingSourceContext(contextKey, currentContext, options);
    if (handled) {
      return handled;
    }
  }

  const refreshedContext = await getTaskContext(contextKey);
  let advisorDecision: ToolIntentDecision | null = null;
  if (refreshedContext?.status === "active") {
    advisorDecision = await decideToolIntent(
      buildAdvisorInput(options.message, options.gmailReady, refreshedContext),
    );
    if (!advisorDecision) {
      emitToolEvent(options.onToolEvent, {
        type: "handlerFallback",
        reason: "advisor-unavailable",
        taskFamily: refreshedContext.taskFamily,
        slmBackend: undefined,
      });
    }
    emitToolEvent(options.onToolEvent, {
      type: "intentDecided",
      decisionSource: advisorDecision ? "slm" : "deterministic",
      action: advisorDecision?.action ?? "deterministic",
      taskFamily: advisorDecision?.taskFamily ?? refreshedContext.taskFamily,
      sourceChoice: advisorDecision?.sourceChoice ?? refreshedContext.sourceChoice,
      followUpIntent: advisorDecision?.followUpIntent,
      confidence: advisorDecision?.confidence,
      slmBackend: advisorDecision?.slmBackend,
    });
    const handled = await handleActiveTaskContext(
      contextKey,
      refreshedContext,
      options,
      advisorDecision?.followUpIntent,
    );
    if (handled) {
      return handled;
    }
  }

  const deterministicAction = buildDeterministicDecision(
    options.message,
    options.gmailReady,
    refreshedContext,
  );

  advisorDecision ??= await decideToolIntent(
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
  finalDecision.taskFamily = normalizeTaskFamilyForMessage(
    finalDecision.action,
    finalDecision.taskFamily,
    options.message,
    refreshedContext,
  );

  if (!advisorDecision) {
    emitToolEvent(options.onToolEvent, {
      type: "handlerFallback",
      reason: "advisor-unavailable",
      taskFamily: refreshedContext?.taskFamily,
      slmBackend: undefined,
    });
  }

  emitToolEvent(options.onToolEvent, {
    type: "intentDecided",
    decisionSource: advisorDecision ? "slm" : "deterministic",
    action: finalDecision.action,
    taskFamily: finalDecision.taskFamily,
    sourceChoice: finalDecision.sourceChoice,
    followUpIntent: advisorDecision?.followUpIntent,
    confidence: finalDecision.confidence,
    slmBackend: advisorDecision?.slmBackend,
  });

  if (finalDecision.action === "continue_active_task" && refreshedContext) {
    const handled = await handleActiveTaskContext(
      contextKey,
      refreshedContext,
      options,
      advisorDecision?.followUpIntent,
    );
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
    await setTaskContext(contextKey, nextContext);
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




