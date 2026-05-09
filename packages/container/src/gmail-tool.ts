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
  type RuntimeClass,
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
  /(얼마|합계|총액|정리|요약|카드사|결제처|가맹점|merchant|issuer|sum|summary|breakdown|table|표|테이블|이번주 것만 다시|이번 주 것만 다시|다시|계속|그거|그걸|그걸로|이거|그럼|부탁|더\s*있|더\s*찾|더\s*보|밖에\s*없|몇\s*개|개수|건수|빠진|누락|전부\s*다시|전체\s*다시|다시\s*전부|limit)/i;
const PAYMENT_HINT_PATTERN =
  /(결제|카드값|카드 값|명세서|청구서|영수증|지출|지출액|사용금액|사용 금액|사용한\s*돈|쓴\s*돈|소비|비용|이번\s*주.*얼마|이번주.*얼마|이번\s*달.*얼마|이번달.*얼마|최근.*얼마|receipt|statement|invoice|spent|spend|payment|total|amount|얼마 썼|얼마 쓴)/i;
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
const EXPANDED_PAYMENT_SCAN_PATTERN =
  /(전체|전부|모두|제한\s*(?:풀|해제|없이)|한도\s*(?:풀|해제|없이)|더\s*넓게|더\s*많이|가능한\s*많이|최대한|끝까지|빠짐\s*없이|누락\s*없이|전부\s*다시|전체\s*다시|all|everything|no\s*limit|full\s*scan)/i;
const DEEP_PAYMENT_SCAN_PATTERN =
  /(100\s*건|100\s*개|백\s*건|백\s*개|최대\s*100|더\s*깊게|깊게\s*스캔|deep\s*scan)/i;
const PAYMENT_COVERAGE_FOLLOW_UP_PATTERN =
  /(?:더\s*(?:있|찾|보)|밖에\s*없|몇\s*개|개수|건수|빠진\s*(?:거|것)?\s*없|누락|전부\s*다시|전체\s*다시|다시\s*전부|limit|coverage)/i;
const CAPABILITY_QUERY_PATTERN =
  /((결제|지출|카드|거래|승인|영수증|명세서|payment|transaction|spending|expense|gmail|지메일|메일).*(할\s*수\s*있|가능(?!한)|볼\s*수\s*있|가져올\s*수\s*있|확인\s*가능(?!한)|접근\s*가능(?!한)|연결(?:돼|되어)|available|can\s+you|can\s+i))|((할\s*수\s*있|가능(?!한)|볼\s*수\s*있|가져올\s*수\s*있|확인\s*가능(?!한)|접근\s*가능(?!한)|available|can\s+you).*(결제|지출|카드|거래|승인|영수증|명세서|payment|transaction|spending|expense|gmail|지메일|메일))/i;
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
const PAYMENT_PRECISION_QUERY_GROUP =
  '{"결제금액" "최종결제금액" "총 결제 금액" "승인금액" "청구금액" "결제하신 내역" "결제가 완료되었습니다" "결제 정보" "구매금액" receipt payment}';
const PAYMENT_NOISE_EXCLUSION_TERMS = [
  "약관",
  "개정",
  "이용약관",
  "기본약관",
  "프로모션",
  "이벤트",
  "광고",
  "newsletter",
  "수신거부",
];
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
const DEFAULT_PAYMENT_SCAN_MESSAGES = 25;
const MAX_PAYMENT_SCAN_MESSAGES = 50;
const EXTENDED_PAYMENT_SCAN_MESSAGES = 100;
const DEFAULT_TOPIC_CANDIDATE_MESSAGES = 10;
const EXPANDED_TOPIC_CANDIDATE_MESSAGES = 30;
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
  userExpandedScan?: boolean;
  autoExpandedScan?: boolean;
  lastCandidateCount?: number;
  lastScanLimit?: number;
  lastResultEstimate?: number;
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
  nextPageToken?: string;
  resultSizeEstimate?: number;
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
    }
  | {
      kind: "handoff";
      message: string;
      source: "chat-handoff";
      runtimeClass: RuntimeClass;
      clearToolContext: boolean;
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
        | "paymentRefineNoMatch"
        | "paymentScanCompleted";
        taskFamily?: ToolTaskFamily;
        topicKeywords?: string[];
        matchedCount?: number;
        candidateCount?: number;
        filteredCount?: number;
        bodyCheckedCount?: number;
        scanLimit?: number;
        queryCount?: number;
        expandedScan?: boolean;
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
  documentClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
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

function looksLikeCapabilityQuestion(message: string): boolean {
  return CAPABILITY_QUERY_PATTERN.test(normalizeWhitespace(message));
}

function inferCapabilityTaskFamily(message: string): ToolTaskFamily {
  if (looksLikePaymentQuestion(message)) {
    return "gmail_payment_summary";
  }
  if (isExplicitGmailMessage(message)) {
    return "gmail_search";
  }
  return "generic_tool_task";
}

function buildCapabilityAnswer(gmailReady: boolean): string {
  if (gmailReady) {
    return [
      "네, 결제 이력은 지메일(Gmail) 기반 도구 런타임에서 확인할 수 있어요.",
      "결제/영수증/카드 승인/명세서 메일의 헤더와 스니펫을 먼저 안전하게 보고, 필요할 때만 사용자가 지정한 메일 본문을 제한적으로 확인합니다.",
      "예를 들어 '이번주 결제 이력 확인해줘', '지난달 카드사별로 정리해줘', '일본 여행 관련 결제만 보여줘'처럼 물어보면 지메일에서 조회해서 정리할 수 있어요.",
    ].join("\n");
  }

  return [
    "결제 이력은 원래 지메일(Gmail) 기반 도구 런타임에서 확인하는 작업이에요.",
    "다만 현재 런타임에서는 Gmail 연결 상태를 사용할 수 없어 실제 조회는 진행할 수 없습니다.",
    "Gmail OAuth 연결이 복구되면 결제/영수증/카드 승인/명세서 메일을 기준으로 다시 확인할 수 있어요.",
  ].join("\n");
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

function isExpandedPaymentScanRequest(message: string): boolean {
  return EXPANDED_PAYMENT_SCAN_PATTERN.test(message) || DEEP_PAYMENT_SCAN_PATTERN.test(message);
}

function isDeepPaymentScanRequest(message: string): boolean {
  return DEEP_PAYMENT_SCAN_PATTERN.test(message);
}

function isBroadPaymentSummaryRequest(message: string): boolean {
  const hasTimeWindow =
    /이번\s*주|이번주|지난\s*주|지난주|최근|오늘|어제|이번\s*달|이번달|지난\s*달|지난달|\d{1,2}\s*월|week|month|today|yesterday/i.test(
      message,
    );
  const hasSummaryAsk =
    /얼마|얼마나|합계|총액|총\s*금액|금액|쓴|썼|지출|사용|내역|정리|spend|spent|total|amount/i.test(
      message,
    );

  return hasTimeWindow && hasSummaryAsk;
}

function isPaymentCoverageFollowUp(message: string, followUpIntent?: ToolFollowUpIntent): boolean {
  return (
    followUpIntent === "coverage_check" ||
    PAYMENT_COVERAGE_FOLLOW_UP_PATTERN.test(message) ||
    isExpandedPaymentScanRequest(message)
  );
}

function resolvePaymentScanLimit(
  emailTokenBudget: EmailTokenBudgetPolicy,
  message = "",
): number {
  if (isDeepPaymentScanRequest(message)) {
    return EXTENDED_PAYMENT_SCAN_MESSAGES;
  }

  if (isExpandedPaymentScanRequest(message)) {
    return MAX_PAYMENT_SCAN_MESSAGES;
  }

  const defaultScanLimit = Math.min(
    Math.max(
      emailTokenBudget.maxMessages,
      emailTokenBudget.paymentScanMessages ?? DEFAULT_PAYMENT_SCAN_MESSAGES,
    ),
    MAX_PAYMENT_SCAN_MESSAGES,
  );

  if (isBroadPaymentSummaryRequest(message) && emailTokenBudget.maxMessages >= 10) {
    return MAX_PAYMENT_SCAN_MESSAGES;
  }

  return defaultScanLimit;
}

function resolvePaymentCoverageScanLimit(
  emailTokenBudget: EmailTokenBudgetPolicy,
  message: string,
  followUpIntent?: ToolFollowUpIntent,
): number {
  if (isDeepPaymentScanRequest(message)) {
    return EXTENDED_PAYMENT_SCAN_MESSAGES;
  }

  if (isPaymentCoverageFollowUp(message, followUpIntent)) {
    return MAX_PAYMENT_SCAN_MESSAGES;
  }

  return resolvePaymentScanLimit(emailTokenBudget, message);
}

function shouldAutoExpandPaymentScan(
  result: {
    candidateCount: number;
    resultEstimate?: number;
    records: ParsedPaymentRecord[];
  },
  scanLimit: number,
  userExpandedScan: boolean,
): boolean {
  if (userExpandedScan || scanLimit >= MAX_PAYMENT_SCAN_MESSAGES) {
    return false;
  }

  const resultEstimateExceedsScan =
    typeof result.resultEstimate === "number" && result.resultEstimate > result.candidateCount;
  const hitScanLimit = result.candidateCount >= scanLimit;

  return resultEstimateExceedsScan || hitScanLimit;
}

function shouldAutoExpandTopicPaymentScan(
  result: {
    candidateCount: number;
    resultEstimate?: number;
    records: ParsedPaymentRecord[];
  },
  scanLimit: number,
): boolean {
  if (scanLimit >= EXPANDED_TOPIC_CANDIDATE_MESSAGES) {
    return false;
  }

  const resultEstimateExceedsScan =
    typeof result.resultEstimate === "number" && result.resultEstimate > result.candidateCount;
  const hitScanLimit = result.candidateCount >= scanLimit;
  const hasTopicPaymentMatch = result.records.length > 0;

  return hasTopicPaymentMatch && (resultEstimateExceedsScan || hitScanLimit);
}

function buildPaymentRerunMessage(canonicalGoal: string, followUpMessage: string): string {
  return isExpandedPaymentScanRequest(followUpMessage)
    ? `${canonicalGoal}\n${followUpMessage}`
    : canonicalGoal;
}

function buildExpandedPaymentRerunMessage(canonicalGoal: string, followUpMessage: string): string {
  return `${canonicalGoal}\n${followUpMessage}\n전체 범위로 다시 스캔`;
}

function buildDateRefinementRerunMessage(followUpMessage: string): string {
  return `${followUpMessage}\n결제 금액`;
}

function isTopicRefinementFollowUp(message: string): boolean {
  const extracted = extractTopicKeywords(message);
  return extracted.length > 0 || TRAVEL_REFINEMENT_PATTERN.test(message);
}

function startOfWeekMonday(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = start.getDay();
  const diff = weekday === 0 ? -6 : 1 - weekday;
  start.setDate(start.getDate() + diff);
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseWeekOrdinal(value: string): number | undefined {
  const normalized = value.replace(/\s+/g, "");
  if (/^(?:첫째|첫번째|1(?:째|번째|주차)?)$/.test(normalized)) return 1;
  if (/^(?:둘째|두번째|2(?:째|번째|주차)?)$/.test(normalized)) return 2;
  if (/^(?:셋째|세번째|3(?:째|번째|주차)?)$/.test(normalized)) return 3;
  if (/^(?:넷째|네번째|4(?:째|번째|주차)?)$/.test(normalized)) return 4;
  if (/^(?:다섯째|다섯번째|5(?:째|번째|주차)?)$/.test(normalized)) return 5;
  return undefined;
}

function buildWeekOfMonthRange(message: string, now: Date): { after?: string; before?: string } | undefined {
  const match = message.match(
    /(?:(20\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(첫째|첫\s*번째|둘째|두\s*번째|셋째|세\s*번째|넷째|네\s*번째|다섯째|다섯\s*번째|[1-5]\s*(?:째|번째|주차)?)\s*(?:주|주차)?/i,
  );
  if (!match) return undefined;

  const year = match[1] ? Number.parseInt(match[1], 10) : now.getFullYear();
  const month = Number.parseInt(match[2] ?? "", 10);
  const ordinal = parseWeekOrdinal(match[3] ?? "");
  if (!Number.isFinite(year) || month < 1 || month > 12 || ordinal === undefined) {
    return undefined;
  }

  const firstOfMonth = new Date(year, month - 1, 1);
  const firstWeekday = firstOfMonth.getDay();
  const daysUntilFirstMonday = firstWeekday === 1 ? 0 : (8 - firstWeekday) % 7;
  const firstMonday = addDays(firstOfMonth, daysUntilFirstMonday);
  const start =
    ordinal === 1
      ? firstOfMonth
      : addDays(firstMonday, (ordinal - (firstWeekday === 1 ? 1 : 2)) * 7);
  const end =
    ordinal === 1 && firstWeekday !== 1 ? firstMonday : addDays(start, 7);

  return { after: formatDate(start), before: formatDate(end) };
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
  const explicitWeekOfMonth = buildWeekOfMonthRange(message, now);
  if (explicitWeekOfMonth) {
    return explicitWeekOfMonth;
  }

  if (/오늘|today/i.test(message)) {
    return {
      after: formatDate(startOfToday),
      before: formatDate(addDays(startOfToday, 1)),
    };
  }

  if (/어제|yesterday/i.test(message)) {
    const yesterday = addDays(startOfToday, -1);
    return {
      after: formatDate(yesterday),
      before: formatDate(startOfToday),
    };
  }

  const recentDaysMatch = message.match(/(?:최근|지난)\s*(\d{1,2})\s*일|last\s+(\d{1,2})\s+days?/i);
  if (recentDaysMatch) {
    const days = Number.parseInt(recentDaysMatch[1] ?? recentDaysMatch[2] ?? "", 10);
    if (days >= 1 && days <= 31) {
      return {
        after: formatDate(addDays(startOfToday, -(days - 1))),
        before: formatDate(addDays(startOfToday, 1)),
      };
    }
  }

  if (/최근\s*(?:일주일|한\s*주)|지난\s*일주일/i.test(message) && !/지난\s*주|지난주|저번\s*주|저번주/i.test(message)) {
    return {
      after: formatDate(addDays(startOfToday, -6)),
      before: formatDate(addDays(startOfToday, 1)),
    };
  }

  if (/이번\s*주|이번주|this week/i.test(message)) {
    const weekStart = startOfWeekMonday(startOfToday);
    return {
      after: formatDate(weekStart),
      before: formatDate(addDays(weekStart, 7)),
    };
  }

  if (/지난\s*주|지난주|저번\s*주|저번주|last\s+week|previous week/i.test(message)) {
    const thisWeekStart = startOfWeekMonday(startOfToday);
    const lastWeekStart = addDays(thisWeekStart, -7);
    return {
      after: formatDate(lastWeekStart),
      before: formatDate(thisWeekStart),
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

function hasDateRangeCue(message: string): boolean {
  const dateRange = buildDateRange(message);
  return Boolean(dateRange.after || dateRange.before);
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

function addPaymentAnchorKeyword(keywords: Set<string>, precisePayment: boolean): void {
  keywords.add(precisePayment ? PAYMENT_PRECISION_QUERY_GROUP : "결제");
}

function buildPaymentSearchQuery(
  message: string,
  unreadOnly: boolean,
  topicKeywords: string[] = [],
  options: { precisePayment?: boolean } = {},
): string {
  const precisePayment = options.precisePayment === true;
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
    if (precisePayment && /결제|payment/i.test(subjectKeyword)) {
      addPaymentAnchorKeyword(keywords, true);
    } else {
      keywords.add(subjectKeyword);
    }
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
    addPaymentAnchorKeyword(keywords, precisePayment);
  }
  if (keywords.size === 0) {
    addPaymentAnchorKeyword(keywords, precisePayment);
  }

  parts.push(...keywords);
  parts.push(...selectTopicQueryKeywords(topicKeywords));
  if (precisePayment) {
    parts.push(...PAYMENT_NOISE_EXCLUSION_TERMS.map((term) => `-${term}`));
  }
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

async function refineUnknownIssuersWithBodyChecks(
  accessToken: string,
  records: ParsedPaymentRecord[],
  maxBodyChars: number,
): Promise<{
  records: ParsedPaymentRecord[];
  bodyCheckedCount: number;
}> {
  const refined = records.map((record) => ({ ...record }));
  const candidates = refined
    .filter((record) => !record.cardIssuer)
    .filter((record) => Boolean(record.amount || record.merchant))
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, MAX_TOPIC_BODY_CHECKS);

  for (const candidate of candidates) {
    const full = await fetchMessageBody(accessToken, candidate.messageId);
    const bodySlice = full.body.slice(0, maxBodyChars);
    const issuer = extractCardIssuer(`${full.subject}\n${full.snippet}\n${bodySlice}`);
    if (issuer) {
      candidate.cardIssuer = issuer;
      candidate.source = "body";
      if (candidate.matchedBy !== "query") {
        candidate.matchedBy = "body";
      }
    }
  }

  return {
    records: refined,
    bodyCheckedCount: candidates.length,
  };
}

function formatCurrency(amount: number): string {
  return `KRW ${amount.toLocaleString("en-US")}`;
}

function formatDisplayTopicLabel(topicKeywords: string[]): string {
  const labels: string[] = [];
  const normalized = topicKeywords.join(" ").toLowerCase();
  if (/일본|japan|도쿄|tokyo|오사카|osaka|교토|kyoto|후쿠오카|fukuoka|삿포로|sapporo|오키나와|okinawa|나고야|nagoya/.test(normalized)) {
    labels.push("일본");
  }
  if (/여행|travel|trip|해외|overseas/.test(normalized)) {
    labels.push("여행");
  }
  if (/esim|e-sim/.test(normalized)) {
    labels.push("eSIM");
  }
  if (labels.length > 0) {
    return [...new Set(labels)].join("/");
  }
  return [...new Set(topicKeywords.filter((keyword) => !/관련|가져|보여|정리/.test(keyword)))]
    .slice(0, 4)
    .join("/");
}

function formatIssuerLabel(issuer?: string): string {
  return issuer ?? "카드사 확인 불가";
}

function isIssuerBreakdownFollowUp(
  message: string,
  followUpIntent?: ToolFollowUpIntent,
): boolean {
  return followUpIntent === "issuer_breakdown" || /카드사|issuer/i.test(message);
}

function buildEvidenceList(
  messages: GmailMessageSummary[],
  displayLimit = messages.length,
): string {
  const visibleMessages = messages.slice(0, displayLimit);
  const hiddenCount = Math.max(0, messages.length - visibleMessages.length);
  const evidence = visibleMessages
    .map((message, index) => {
      return `${index + 1}. ${message.subject}\nFrom: ${message.from}\nDate: ${message.date}\nSnippet: ${message.snippet}`;
    })
    .join("\n\n");

  return hiddenCount > 0
    ? `${evidence}\n\n... ${hiddenCount} more header/snippet candidate(s) scanned but not expanded in the response.`
    : evidence;
}

function buildPaymentSummaryResponse(
  query: string,
  messages: GmailMessageSummary[],
  records: ParsedPaymentRecord[],
  displayLimit: number,
  resultEstimate?: number,
  expandedScanLimit?: number,
  expandedScanReason?: "user-requested" | "auto-cap-suspected",
): string {
  const total = records.reduce((sum, record) => sum + (record.amount ?? 0), 0);
  const merchants = [...new Set(records.map((record) => record.merchant).filter(Boolean))];
  const issuers = [...new Set(records.map((record) => record.cardIssuer).filter(Boolean))];
  const shownCount = Math.min(messages.length, displayLimit);

  const summaryLines = [
    `Gmail 헤더/스니펫 기준으로 "${query}" 검색을 실행했고 후보 ${messages.length}건을 확인했습니다.`,
    "본문과 첨부파일은 열지 않았습니다.",
  ];
  if (typeof resultEstimate === "number" && resultEstimate > messages.length) {
    summaryLines.push(
      `Gmail 검색 결과는 약 ${resultEstimate}건으로 추정됩니다. 이번 답변은 먼저 스캔한 후보 ${messages.length}건 기준입니다.`,
    );
  }
  if (expandedScanLimit !== undefined) {
    const reason =
      expandedScanReason === "auto-cap-suspected"
        ? "첫 검색 결과가 제한에 걸린 것으로 보여 헤더/스니펫 스캔 범위를 자동으로 넓혔습니다"
        : "요청에 따라 헤더/스니펫 스캔 범위를 넓혔습니다";
    summaryLines.push(`${reason}. 최대 ${expandedScanLimit}건까지 확인하는 모드입니다.`);
  }

  if (records.length > 0) {
    summaryLines.push(
      `확인 가능한 합계: ${formatCurrency(total)} (${records.length}건). 헤더/스니펫 기준 추정치입니다.`,
    );
    if (messages.length > shownCount) {
      summaryLines.push(
        `아래에는 대표 ${shownCount}건만 보여드리지만, 합계는 스캔에서 결제로 파악한 ${records.length}건 전체 기준입니다.`,
      );
    }
    if (issuers.length > 0) {
      summaryLines.push(`확인된 카드사: ${issuers.join(", ")}.`);
    }
    if (merchants.length > 0) {
      summaryLines.push(`확인된 결제처: ${merchants.slice(0, 4).join(", ")}.`);
    }
  } else {
    summaryLines.push(
      "후보 메일은 찾았지만, 헤더/스니펫만으로 신뢰할 만한 결제 금액을 추출하지 못했습니다.",
    );
  }

  return `${summaryLines.join("\n")}\n\n${buildEvidenceList(messages, displayLimit)}`;
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
  coverage?: {
    candidateCount?: number;
    scanLimit?: number;
  },
): string {
  const total = records.reduce((sum, record) => sum + (record.amount ?? 0), 0);
  const topicLabel = formatDisplayTopicLabel(topicKeywords);
  const shownCount = Math.min(records.length, 5);
  const lines = records
    .slice()
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, 5)
    .map((record, index) => {
      const merchant = record.merchant ?? record.subject;
      const amount = record.amount ? formatCurrency(record.amount) : "금액 확인 불가";
      const issuer = formatIssuerLabel(record.cardIssuer);
      const evidenceBits = [
        record.matchedBy === "body"
          ? "본문 확인"
          : record.matchedBy === "query"
            ? "검색어 매칭"
            : "스니펫 매칭",
        record.topicTags && record.topicTags.length > 0 ? record.topicTags.join(", ") : undefined,
      ].filter(Boolean);
      const evidence = evidenceBits.length > 0 ? evidenceBits.join(" · ") : "여행 단서";
      return `${index + 1}. ${merchant} - ${amount} / ${issuer}\n   날짜: ${record.date}\n   근거: ${evidence}`;
    });

  return [
    `${topicLabel} 관련 결제만 다시 추렸습니다.`,
    `검색 기준: "${query}"`,
    usedBodyCheck
      ? "스니펫만으로 애매한 메일은 최대 2건까지만 짧게 본문 확인했습니다."
      : "본문/첨부는 열지 않고 헤더와 스니펫 기준으로만 확인했습니다.",
    coverage?.scanLimit
      ? `헤더/스니펫 후보는 최대 ${coverage.scanLimit}건까지 확인했고, 실제로 ${coverage.candidateCount ?? records.length}건을 스캔했습니다. 그중 ${topicLabel} 관련 결제 ${records.length}건을 찾았습니다.`
      : undefined,
    `확인 가능한 합계: ${formatCurrency(total)} (${records.length}건)`,
    records.length > shownCount
      ? `아래에는 금액이 큰 순서로 상위 ${shownCount}건만 먼저 보여드립니다. 합계는 찾은 ${records.length}건 전체 기준입니다.`
      : undefined,
    "",
    "결제 내역:",
    ...lines,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

async function fetchPaymentMessages(
  accessToken: string,
  query: string,
  maxMessages: number,
  topicKeywords: string[] = [],
): Promise<{
  candidateCount: number;
  resultEstimate?: number;
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
    resultEstimate: listJson.resultSizeEstimate,
    messages,
    records,
  };
}

async function fetchPaymentMessagesAcrossQueries(
  accessToken: string,
  queries: string[],
  maxMessages: number,
  topicKeywords: string[] = [],
): Promise<{
  candidateCount: number;
  resultEstimate?: number;
  messages: GmailMessageSummary[];
  records: ParsedPaymentRecord[];
}> {
  const uniqueQueries = [...new Set(queries.filter((query) => query.trim().length > 0))];
  if (uniqueQueries.length <= 1) {
    return fetchPaymentMessages(accessToken, uniqueQueries[0] ?? "", maxMessages, topicKeywords);
  }

  const ids: string[] = [];
  const seenIds = new Set<string>();
  let resultEstimate: number | undefined;

  for (const query of uniqueQueries) {
    const remaining = maxMessages - ids.length;
    if (remaining <= 0) {
      break;
    }
    const listJson = await gmailApiRequest<GmailListResponse>(
      accessToken,
      `/messages?q=${encodeURIComponent(query)}&maxResults=${remaining}`,
    );
    if (typeof listJson.resultSizeEstimate === "number") {
      resultEstimate = Math.max(resultEstimate ?? 0, listJson.resultSizeEstimate);
    }
    for (const item of listJson.messages ?? []) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        ids.push(item.id);
      }
      if (ids.length >= maxMessages) {
        break;
      }
    }
  }

  const messages = await Promise.all(ids.map((id) => fetchMessageSummary(accessToken, id)));
  const records = messages
    .map((summary) => buildPaymentRecord(summary, topicKeywords))
    .filter((record): record is ParsedPaymentRecord => Boolean(record));

  return {
    candidateCount: messages.length,
    resultEstimate,
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
  resultEstimate?: number;
  filteredCount: number;
  bodyCheckedCount: number;
  queryMode: "topic-filtered" | "broad-fallback";
  messages: GmailMessageSummary[];
  records: ParsedPaymentRecord[];
  usedBodyCheck: boolean;
  scanLimit: number;
}> {
  const initialCandidateLimit = resolveInitialTopicCandidateLimit(
    isExpandedPaymentScanRequest(message)
      ? MAX_PAYMENT_SCAN_MESSAGES
      : emailTokenBudget.maxMessages,
  );
  const expandedCandidateLimit = resolveExpandedTopicCandidateLimit(
    initialCandidateLimit,
  );
  const queryTopicKeywords = selectTopicQueryKeywords(topicKeywords);
  const narrowedQuery = buildPaymentSearchQuery(message, unreadOnly, queryTopicKeywords, {
    precisePayment: true,
  });
  let query = narrowedQuery;
  let queryMode: "topic-filtered" | "broad-fallback" = "topic-filtered";
  let candidateCount = 0;
  let resultEstimate: number | undefined;
  let filteredCount = 0;
  let bodyCheckedCount = 0;
  let usedBodyCheck = false;
  let scanLimitUsed = initialCandidateLimit;

  const narrowedResult = await fetchPaymentMessages(
    accessToken,
    narrowedQuery,
    initialCandidateLimit,
    topicKeywords,
  );
  candidateCount = narrowedResult.candidateCount;
  resultEstimate = narrowedResult.resultEstimate;
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

  if (
    matched.length > 0 &&
    shouldAutoExpandTopicPaymentScan(
      {
        candidateCount,
        resultEstimate,
        records: matched,
      },
      initialCandidateLimit,
    )
  ) {
    scanLimitUsed = expandedCandidateLimit;
    const expandedNarrowResult = await fetchPaymentMessages(
      accessToken,
      narrowedQuery,
      expandedCandidateLimit,
      topicKeywords,
    );
    candidateCount = expandedNarrowResult.candidateCount;
    resultEstimate = expandedNarrowResult.resultEstimate;
    messages = expandedNarrowResult.messages;
    records = expandedNarrowResult.records;
    matched = filterRecordsByTopic(records, topicKeywords);
    filteredCount = matched.length;

    if (matched.length === 0 && records.length > 0) {
      const expandedBodyRefined = await refineRecordsWithBodyChecks(
        accessToken,
        records,
        topicKeywords,
        emailTokenBudget.maxBodyChars,
      );
      records = expandedBodyRefined.records;
      matched = filterRecordsByTopic(records, topicKeywords);
      filteredCount = matched.length;
      bodyCheckedCount += expandedBodyRefined.bodyCheckedCount;
      usedBodyCheck = usedBodyCheck || expandedBodyRefined.usedBodyCheck;
    }
  }

  if (matched.length === 0) {
    const broadQuery = buildPaymentSearchQuery(message, unreadOnly, [], {
      precisePayment: true,
    });
    if (broadQuery !== narrowedQuery) {
      query = broadQuery;
      queryMode = "broad-fallback";
      scanLimitUsed = expandedCandidateLimit;
      const broadResult = await fetchPaymentMessages(
        accessToken,
        broadQuery,
        expandedCandidateLimit,
        topicKeywords,
      );
      candidateCount = broadResult.candidateCount;
      resultEstimate = broadResult.resultEstimate;
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
    resultEstimate,
    filteredCount,
    bodyCheckedCount,
    queryMode,
    messages,
    records: matched,
    usedBodyCheck,
    scanLimit: scanLimitUsed,
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
  const currentMatches = filterRecordsByTopic(context.parsedPaymentRecords ?? [], topicKeywords);
  emitToolEvent(options.onToolEvent, {
    type: "paymentRefineStarted",
    taskFamily: context.taskFamily,
    topicKeywords,
    candidateCount: context.lastCandidateCount,
    filteredCount: currentMatches.length,
  });

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
        {
          candidateCount: context.lastCandidateCount,
          scanLimit: context.lastScanLimit,
        },
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
  const contextBodyRefined = await refineRecordsWithBodyChecks(
    accessToken,
    context.parsedPaymentRecords ?? [],
    topicKeywords,
    options.emailTokenBudget.maxBodyChars,
  );
  const contextBodyMatches = filterRecordsByTopic(contextBodyRefined.records, topicKeywords);
  if (contextBodyRefined.usedBodyCheck) {
    emitToolEvent(options.onToolEvent, {
      type: "paymentRefineUsedBodyCheck",
      taskFamily: context.taskFamily,
      topicKeywords,
      candidateCount: context.lastCandidateCount ?? context.parsedPaymentRecords?.length ?? 0,
      filteredCount: contextBodyMatches.length,
      bodyCheckedCount: contextBodyRefined.bodyCheckedCount,
      queryMode: "cached-context",
    });
  }

  if (contextBodyMatches.length > 0) {
    const nextContext: ToolTaskContext = {
      ...context,
      topicKeywords,
      lastQueryMode: "topic_filtered_payment_summary",
      refinedFromFollowUp: true,
      parsedPaymentRecords: contextBodyMatches,
      lastResultSummary: contextBodyMatches.map((record) => record.subject).join(" | "),
      lastActivityAt: nowIso(),
      expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
    };
    await setTaskContext(contextKey, nextContext);
    emitToolEvent(options.onToolEvent, {
      type: "paymentRefineCompleted",
      taskFamily: context.taskFamily,
      topicKeywords,
      candidateCount: context.lastCandidateCount ?? contextBodyMatches.length,
      filteredCount: contextBodyMatches.length,
      matchedCount: contextBodyMatches.length,
      bodyCheckedCount: contextBodyRefined.bodyCheckedCount,
      queryMode: "cached-context",
    });
    return {
      kind: "direct",
      message: buildTopicFilteredPaymentSummaryResponse(
        context.lastSearchQuery ?? "current-payment-context",
        contextBodyMatches,
        topicKeywords,
        true,
        {
          candidateCount: context.lastCandidateCount,
          scanLimit: context.lastScanLimit,
        },
      ),
      source: "gmail-context",
    };
  }

  const refinementMessage = normalizeWhitespace(`${context.canonicalGoal}\n${options.message}`);
  const searchResult = await searchTopicAwarePaymentCandidates(
    accessToken,
    refinementMessage,
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
      lastResultEstimate: searchResult.resultEstimate,
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
        {
          candidateCount: searchResult.candidateCount,
          scanLimit: searchResult.scanLimit,
        },
      ),
      source: "gmail-context",
    };
  }

function formatPaymentFollowUp(
  context: ToolTaskContext,
  message: string,
  emailTokenBudget: EmailTokenBudgetPolicy,
  followUpIntent?: ToolFollowUpIntent,
): ToolHandlerResult | undefined {
  const records = context.parsedPaymentRecords ?? [];
  if (records.length === 0) {
    return {
      kind: "direct",
      message:
        "현재 Gmail 문맥에 다시 정리할 수 있는 결제 레코드가 없습니다. 같은 Gmail 질문을 한 번 더 해주시면 결제 문맥을 새로 만들겠습니다.",
      source: "gmail-context",
    };
  }

  const total = records.reduce((sum, record) => sum + (record.amount ?? 0), 0);
  const normalized = message.toLowerCase();
  const displayLimit = emailTokenBudget.maxMessages;
  const scanLimit = Math.max(
    resolvePaymentCoverageScanLimit(emailTokenBudget, message, followUpIntent),
    context.lastScanLimit ?? 0,
  );

  if (isPaymentCoverageFollowUp(normalized, followUpIntent)) {
    const inspectedCount = context.lastMessages?.length ?? records.length;
    const resultEstimate = context.lastResultEstimate;
    const maybeMore = typeof resultEstimate === "number" && resultEstimate > inspectedCount;
    const hitScanCap = inspectedCount >= scanLimit;
    const capMessage = maybeMore
      ? `현재 Gmail 검색 결과는 약 ${resultEstimate}건으로 추정되고, 안전 정책상 헤더/스니펫 기준으로 먼저 ${inspectedCount}건까지 스캔했습니다. 이 범위 밖에 결제 메일이 더 있을 수 있습니다.`
      : hitScanCap
        ? `현재 안전 정책상 헤더/스니펫 기준으로 먼저 ${scanLimit}건까지 스캔했습니다. 이 범위 밖에 결제 메일이 더 있을 수 있습니다.`
        : `현재 헤더/스니펫 기준으로 ${inspectedCount}건을 스캔했고, 집계 스캔 제한 ${scanLimit}건에는 걸리지 않았습니다.`;

    return {
      kind: "direct",
      message:
        `${capMessage}\n\n` +
        `상세 목록은 한 번에 최대 ${displayLimit}건만 보여주지만, 현재 합계는 스캔된 결제성 메일 ${records.length}건 기준 ${formatCurrency(total)}입니다.\n` +
        (scanLimit >= EXTENDED_PAYMENT_SCAN_MESSAGES
          ? `명시적 요청에 따라 이번 단계에서는 헤더/스니펫 집계 후보를 ${EXTENDED_PAYMENT_SCAN_MESSAGES}건까지 넓게 보는 모드입니다.\n`
          : scanLimit >= MAX_PAYMENT_SCAN_MESSAGES
            ? context.userExpandedScan
              ? `명시적 요청에 따라 이번 단계에서는 hard safety cap ${MAX_PAYMENT_SCAN_MESSAGES}건까지 넓게 보는 모드입니다.\n`
              : `초기 결과가 제한에 걸린 것으로 보여 이번 단계에서는 hard safety cap ${MAX_PAYMENT_SCAN_MESSAGES}건까지 자동 확장 스캔했습니다.\n`
            : "") +
        (scanLimit >= EXTENDED_PAYMENT_SCAN_MESSAGES
          ? "이 확장은 제목/보낸 사람/날짜/스니펫 기반 집계만 넓히며, 본문과 첨부파일은 열지 않습니다.\n"
          : "") +
        "더 넓게 보려면 기간, 보낸 사람, 카드사, 결제처 중 하나로 범위를 좁혀주세요.",
      source: "gmail-context",
    };
  }

  if (followUpIntent === "issuer_breakdown" || /카드사|issuer/i.test(normalized)) {
    const grouped = new Map<string, { total: number; count: number }>();
    for (const record of records) {
      const key = formatIssuerLabel(record.cardIssuer);
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
      message:
        `현재 Gmail 결제 문맥을 카드사별로 정리했습니다.\n${lines.join("\n")}` +
        (grouped.has("카드사 확인 불가")
          ? "\n\n참고: '카드사 확인 불가'는 헤더/스니펫에 카드사명이 보이지 않는 결제입니다. 필요하면 특정 메일 번호를 지정해 본문을 제한적으로 확인할 수 있습니다."
          : ""),
      source: "gmail-context",
    };
  }

  if (followUpIntent === "merchant_breakdown" || /결제처|가맹점|merchant/i.test(normalized)) {
    const grouped = new Map<string, number>();
    for (const record of records) {
      const key = record.merchant ?? "결제처 확인 불가";
      grouped.set(key, (grouped.get(key) ?? 0) + (record.amount ?? 0));
    }
    const lines = [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([merchant, amount]) => `- ${merchant}: ${formatCurrency(amount)}`);
    return {
      kind: "direct",
      message: `현재 Gmail 결제 문맥을 결제처별로 정리했습니다.\n${lines.join("\n")}`,
      source: "gmail-context",
    };
  }

  if (followUpIntent === "amount_summary" || /합계|총액|sum|total/i.test(normalized)) {
    return {
      kind: "direct",
      message: `현재 Gmail 결제 문맥에서 헤더/스니펫 기준 확인 가능한 합계는 ${formatCurrency(total)}입니다. 대상 결제성 메일은 ${records.length}건입니다.`,
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
      `현재 Gmail 결제 문맥에서 확인 가능한 합계는 ${formatCurrency(total)}입니다. 대상 결제성 메일은 ${records.length}건입니다.\n\n` +
      `주요 결제 내역:\n${topRecords.join("\n")}`,
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
  return "이 런타임에서는 아직 Gmail 연결 정보를 사용할 수 없습니다. 받은편지함을 확인하려면 유효한 Gmail OAuth refresh token이 먼저 필요합니다.";
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
  const precisePaymentQuery = taskFamily === "gmail_payment_summary";
  const primaryQuery = buildPaymentSearchQuery(sourceMessage, unreadOnly, topicKeywords, {
    precisePayment: precisePaymentQuery,
  });
  let query = primaryQuery;
  let candidateCount = options.emailTokenBudget.maxMessages;
  let resultEstimate: number | undefined;
  let messages: GmailMessageSummary[] = [];
  let paymentRecords: ParsedPaymentRecord[] = [];
  let usedBodyCheck = false;
  let scanLimitUsed = options.emailTokenBudget.maxMessages;
  const userExpandedScan = isExpandedPaymentScanRequest(sourceMessage);
  const broadPaymentSummaryScan = isBroadPaymentSummaryRequest(sourceMessage);
  let autoExpandedScan = false;

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
    resultEstimate = searchResult.resultEstimate;
    messages = searchResult.messages;
    paymentRecords = searchResult.records;
    usedBodyCheck = searchResult.usedBodyCheck;
    scanLimitUsed = searchResult.scanLimit;
  } else {
    const scanLimit =
      taskFamily === "gmail_payment_summary"
        ? resolvePaymentScanLimit(options.emailTokenBudget, sourceMessage)
        : options.emailTokenBudget.maxMessages;
    scanLimitUsed = scanLimit;
    const broadPaymentQuery = taskFamily === "gmail_payment_summary"
      ? buildPaymentSearchQuery(sourceMessage, unreadOnly, topicKeywords)
      : primaryQuery;
    const shouldUseExpandedQueryLadder =
      taskFamily === "gmail_payment_summary" &&
      userExpandedScan &&
      broadPaymentQuery !== primaryQuery;
    let standardResult = shouldUseExpandedQueryLadder
      ? await fetchPaymentMessagesAcrossQueries(
          accessToken,
          [primaryQuery, broadPaymentQuery],
          scanLimit,
          topicKeywords,
        )
      : await fetchPaymentMessages(
          accessToken,
          primaryQuery,
          scanLimit,
          topicKeywords,
        );
    if (
      taskFamily === "gmail_payment_summary" &&
      broadPaymentSummaryScan &&
      options.emailTokenBudget.maxMessages >= 10 &&
      !shouldUseExpandedQueryLadder &&
      scanLimit >= 25 &&
      broadPaymentQuery !== primaryQuery &&
      standardResult.records.length < 5
    ) {
      const broadSummaryResult = await fetchPaymentMessages(
        accessToken,
        broadPaymentQuery,
        scanLimit,
        topicKeywords,
      );
      if (
        broadSummaryResult.records.length > standardResult.records.length ||
        broadSummaryResult.candidateCount > standardResult.candidateCount
      ) {
        standardResult = broadSummaryResult;
        query = `${primaryQuery} || ${broadPaymentQuery}`;
        autoExpandedScan = true;
      }
    }
    if (
      taskFamily === "gmail_payment_summary" &&
      !shouldUseExpandedQueryLadder &&
      broadPaymentQuery !== primaryQuery &&
      shouldAutoExpandPaymentScan(
        standardResult,
        scanLimit,
        userExpandedScan,
      )
    ) {
      standardResult = await fetchPaymentMessagesAcrossQueries(
        accessToken,
        [primaryQuery, broadPaymentQuery],
        MAX_PAYMENT_SCAN_MESSAGES,
        topicKeywords,
      );
      query = `${primaryQuery} || ${broadPaymentQuery}`;
      scanLimitUsed = MAX_PAYMENT_SCAN_MESSAGES;
      autoExpandedScan = true;
    }
    if (shouldUseExpandedQueryLadder) {
      query = `${primaryQuery} || ${broadPaymentQuery}`;
    }
    if (
      taskFamily === "gmail_payment_summary" &&
      standardResult.records.length === 0 &&
      !shouldUseExpandedQueryLadder
    ) {
      const fallbackQuery = broadPaymentQuery;
      if (fallbackQuery !== primaryQuery) {
        const fallbackResult = await fetchPaymentMessages(
          accessToken,
          fallbackQuery,
          scanLimit,
          topicKeywords,
        );
        if (fallbackResult.records.length > 0 || fallbackResult.candidateCount > standardResult.candidateCount) {
          query = fallbackQuery;
          standardResult = fallbackResult;
        }
      }
    }
    candidateCount = standardResult.candidateCount;
    resultEstimate = standardResult.resultEstimate;
    messages = standardResult.messages;
    paymentRecords = standardResult.records;
  }

  if (taskFamily === "gmail_payment_summary" && topicKeywords.length > 0) {
    paymentRecords = refineTravelPaymentRecords(paymentRecords, topicKeywords);
    messages = filterMessagesByRecords(messages, paymentRecords);
  }

  if (taskFamily === "gmail_payment_summary") {
    emitToolEvent(options.onToolEvent, {
      type: "paymentScanCompleted",
      taskFamily,
      topicKeywords,
      matchedCount: paymentRecords.length,
      candidateCount,
      scanLimit: scanLimitUsed,
      queryCount: query.includes(" || ") ? 2 : 1,
      expandedScan: userExpandedScan || autoExpandedScan,
      queryMode: topicKeywords.length > 0
        ? "topic_filtered_payment_summary"
        : query.includes(" || ")
          ? userExpandedScan
            ? "expanded-query-ladder"
            : "auto-expanded-query-ladder"
          : "payment_summary",
    });
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
    userExpandedScan,
    autoExpandedScan,
    lastCandidateCount: candidateCount,
    lastScanLimit: scanLimitUsed,
    lastResultEstimate: resultEstimate,
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
              {
                candidateCount,
                scanLimit: scanLimitUsed,
              },
            )
          : buildPaymentSummaryResponse(
              query,
              messages,
              paymentRecords,
              options.emailTokenBudget.maxMessages,
              resultEstimate,
              userExpandedScan || autoExpandedScan ? scanLimitUsed : undefined,
              autoExpandedScan ? "auto-cap-suspected" : "user-requested",
            )
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

function isStartNewTaskAction(action: ToolIntentAdvisorAction): boolean {
  return action === "gmail" || action === "start_new_task";
}

function isContinueTaskAction(action: ToolIntentAdvisorAction): boolean {
  return [
    "continue_active_task",
    "continue_task",
    "refine_current_task",
    "rerun_current_task",
    "cancel_task",
  ].includes(action);
}

function isSwitchToChatAction(action: ToolIntentAdvisorAction): boolean {
  return action === "generic_openclaw" || action === "switch_to_chat";
}

function isClarifyAction(action: ToolIntentAdvisorAction): boolean {
  return action === "clarify_source" || action === "clarify";
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
    (isStartNewTaskAction(action) || isContinueTaskAction(action)) &&
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
  return !looksLikePaymentQuestion(message) &&
    !isExplicitGmailMessage(message) &&
    !isPaymentFollowUp(message) &&
    !isBodyRequest(message) &&
    !isTopicRefinementFollowUp(message);
}

function isExplicitTopicPaymentLookup(message: string): boolean {
  const trimmed = normalizeWhitespace(message);
  if (!looksLikePaymentQuestion(trimmed) || extractTopicKeywords(trimmed).length === 0) {
    return false;
  }

  return /((결제|지출|카드|영수증|승인|사용|쓴|썼|payment|transaction|spending|expense).*(내역|목록|알려|보여|정리|합계|금액|얼마|조회|검색|찾아))|((내역|목록|알려|보여|정리|합계|금액|얼마|조회|검색|찾아).*(결제|지출|카드|영수증|승인|사용|쓴|썼|payment|transaction|spending|expense))/i.test(
    trimmed,
  );
}

function isFreshPaymentLookupRequest(
  message: string,
  activeContext: ToolTaskContext,
  plannerHint?: ToolIntentDecision | null,
): boolean {
  const trimmed = normalizeWhitespace(message);
  if (activeContext.status !== "active") {
    return false;
  }
  if (
    CANCEL_PATTERN.test(trimmed) ||
    isBodyRequest(trimmed) ||
    isAttachmentRequest(trimmed) ||
    !looksLikePaymentQuestion(trimmed)
  ) {
    return false;
  }

  const followUpIntent = plannerHint?.followUpIntent;
  const explicitTopicPaymentLookup = isExplicitTopicPaymentLookup(trimmed);
  if (explicitTopicPaymentLookup) {
    return true;
  }

  if (followUpIntent && followUpIntent !== "continue_active_task") {
    return false;
  }

  if (extractTopicKeywords(trimmed).length > 0) {
    return true;
  }

  if (isPaymentFollowUp(trimmed) || isTopicRefinementFollowUp(trimmed)) {
    return false;
  }

  return (
    trimmed.length > 12 &&
    /(내역|조회|검색|찾아|알려|이번\s*주|이번주|지난\s*주|지난주|최근|오늘|어제|이번\s*달|이번달|지난\s*달|지난달|20\d{2})/i.test(trimmed)
  );
}

async function restartPaymentTaskFromActiveContext(
  contextKey: string,
  context: ToolTaskContext,
  options: MaybeHandleCustomGmailRequestOptions,
): Promise<ToolHandlerResult> {
  await clearTaskContext(contextKey);
  emitToolEvent(options.onToolEvent, {
    type: "contextCleared",
    taskFamily: context.taskFamily,
    sourceChoice: context.sourceChoice,
    reason: "new-payment-request",
  });

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
    "gmail_payment_summary",
    options.message,
    credentials,
  );
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

async function handoffActiveTaskContextToChat(
  contextKey: string,
  context: ToolTaskContext,
  options: MaybeHandleCustomGmailRequestOptions,
  reason: string,
): Promise<ToolHandlerResult> {
  const trimmed = normalizeWhitespace(options.message);
  await clearTaskContext(contextKey);
  emitToolEvent(options.onToolEvent, {
    type: "contextCleared",
    taskFamily: context.taskFamily,
    reason,
  });
  return {
    kind: "handoff",
    message: trimmed,
    source: "chat-handoff",
    runtimeClass: "chat-only",
    clearToolContext: true,
  };
}

function rebuildPaymentRecordsFromContext(
  context: ToolTaskContext,
  message: string,
): ParsedPaymentRecord[] {
  if (context.parsedPaymentRecords && context.parsedPaymentRecords.length > 0) {
    return context.parsedPaymentRecords;
  }

  const topicKeywords =
    context.topicKeywords && context.topicKeywords.length > 0
      ? context.topicKeywords
      : extractTopicKeywords(`${context.canonicalGoal}\n${message}`);

  return (context.lastMessages ?? [])
    .map((summary) => buildPaymentRecord(summary, topicKeywords))
    .filter((record): record is ParsedPaymentRecord => Boolean(record));
}

async function handleActiveTaskContext(
  contextKey: string,
  context: ToolTaskContext,
  options: MaybeHandleCustomGmailRequestOptions,
  plannerHint?: ToolIntentDecision,
): Promise<ToolHandlerResult | undefined> {
  const trimmed = normalizeWhitespace(options.message);
  const followUpIntent = plannerHint?.followUpIntent;
  if (plannerHint?.action === "cancel_task" || followUpIntent === "cancel_task" || CANCEL_PATTERN.test(trimmed)) {
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

  if (plannerHint && isSwitchToChatAction(plannerHint.action)) {
    return handoffActiveTaskContextToChat(contextKey, context, options, "advisor-topic-switch");
  }

  if (isClearlyUnrelated(trimmed)) {
    return handoffActiveTaskContextToChat(contextKey, context, options, "topic-switch");
  }

  let effectiveContext = context;
  const plannerWantsCurrentPaymentTask =
    plannerHint !== undefined &&
    plannerHint.taskFamily === "gmail_payment_summary" &&
    (plannerHint.sourceChoice === "gmail" || plannerHint.sourceChoice === null);
  const plannerWantsPaymentSummary =
    plannerWantsCurrentPaymentTask &&
    plannerHint !== undefined &&
    (isStartNewTaskAction(plannerHint.action) || isContinueTaskAction(plannerHint.action)) &&
    plannerHint.taskFamily === "gmail_payment_summary";
  const plannerRequestsPaymentRerun =
    plannerWantsCurrentPaymentTask &&
    plannerHint !== undefined &&
    (plannerHint.action === "rerun_current_task" || followUpIntent === "coverage_check");
  const plannerRequestsDateRerun =
    effectiveContext.taskFamily === "gmail_payment_summary" &&
    effectiveContext.sourceChoice === "gmail" &&
    (followUpIntent === "refine_date" || hasDateRangeCue(trimmed));
  const requestedCoverageScanLimit = resolvePaymentCoverageScanLimit(
    options.emailTokenBudget,
    trimmed,
    followUpIntent,
  );
  const userRequestsCoverageExpansion =
    isPaymentCoverageFollowUp(trimmed, followUpIntent) &&
    !isTopicRefinementFollowUp(trimmed) &&
    requestedCoverageScanLimit > (effectiveContext.lastScanLimit ?? 0);
  const plannerRequestsTopicRefinement =
    followUpIntent === "refine_topic" ||
    (plannerWantsCurrentPaymentTask &&
      plannerHint !== undefined &&
      plannerHint.action === "refine_current_task" &&
      extractTopicKeywords(trimmed).length > 0);
  if (
    context.taskFamily === "gmail_search" &&
    context.sourceChoice === "gmail" &&
    (plannerWantsPaymentSummary || shouldPreferPaymentSummaryTask(trimmed, context))
  ) {
    const rebuiltPaymentRecords = rebuildPaymentRecordsFromContext(context, trimmed);
    effectiveContext = {
      ...context,
      taskFamily: "gmail_payment_summary",
      parsedPaymentRecords: rebuiltPaymentRecords,
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
    if (userRequestsCoverageExpansion) {
      const credentials = options.gmailReady ? await loadGmailCredentials() : null;
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
        "gmail_payment_summary",
        buildExpandedPaymentRerunMessage(nextContext.canonicalGoal, trimmed),
        credentials,
      );
    }
    if (plannerRequestsDateRerun) {
      const credentials = options.gmailReady ? await loadGmailCredentials() : null;
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
        "gmail_payment_summary",
        buildDateRefinementRerunMessage(trimmed),
        credentials,
      );
    }
    if (plannerRequestsPaymentRerun) {
      if ((nextContext.topicKeywords ?? []).length > 0) {
        return refineActivePaymentContextByTopic(contextKey, nextContext, options);
      }
      const credentials = options.gmailReady ? await loadGmailCredentials() : null;
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
        "gmail_payment_summary",
        buildPaymentRerunMessage(nextContext.canonicalGoal, trimmed),
        credentials,
      );
    }
    if (plannerRequestsTopicRefinement || isTopicRefinementFollowUp(trimmed)) {
      return refineActivePaymentContextByTopic(contextKey, nextContext, options);
    }
    let followUpContext = nextContext;
    if (
      isIssuerBreakdownFollowUp(trimmed, followUpIntent) &&
      (nextContext.parsedPaymentRecords ?? []).some((record) => !record.cardIssuer)
    ) {
      const credentials = options.gmailReady ? await loadGmailCredentials() : null;
      if (credentials) {
        const accessToken = await refreshAccessToken(credentials);
        if (accessToken) {
          const refined = await refineUnknownIssuersWithBodyChecks(
            accessToken,
            nextContext.parsedPaymentRecords ?? [],
            options.emailTokenBudget.maxBodyChars,
          );
          if (refined.bodyCheckedCount > 0) {
            followUpContext = {
              ...nextContext,
              parsedPaymentRecords: refined.records,
              lastActivityAt: nowIso(),
              expiresAt: futureIso(DEFAULT_CONTEXT_TTL_MS),
            };
            await setTaskContext(contextKey, followUpContext);
            emitToolEvent(options.onToolEvent, {
              type: "paymentRefineUsedBodyCheck",
              taskFamily: followUpContext.taskFamily,
              topicKeywords: followUpContext.topicKeywords ?? [],
              candidateCount: nextContext.parsedPaymentRecords?.length ?? 0,
              filteredCount: refined.records.filter((record) => Boolean(record.cardIssuer)).length,
              bodyCheckedCount: refined.bodyCheckedCount,
              queryMode: "cached-context",
            });
          }
        }
      }
    }
    return formatPaymentFollowUp(
      followUpContext,
      trimmed,
      options.emailTokenBudget,
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
  if (looksLikeCapabilityQuestion(options.message)) {
    if (currentContext) {
      await clearTaskContext(contextKey);
      emitToolEvent(options.onToolEvent, {
        type: "contextCleared",
        taskFamily: currentContext.taskFamily,
        sourceChoice: currentContext.sourceChoice,
        reason: "capability-question",
      });
    }
    const taskFamily = inferCapabilityTaskFamily(options.message);
    emitToolEvent(options.onToolEvent, {
      type: "intentDecided",
      decisionSource: "deterministic",
      action: "answer_capability",
      taskFamily,
      sourceChoice: options.gmailReady ? "gmail" : "general",
      confidence: 0.99,
    });
    return {
      kind: "direct",
      message: buildCapabilityAnswer(options.gmailReady),
      source: options.gmailReady ? "gmail-context" : "gmail-fallback",
    };
  }

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
    if (advisorDecision?.action === "answer_capability") {
      return {
        kind: "direct",
        message: buildCapabilityAnswer(options.gmailReady),
        source: options.gmailReady ? "gmail-context" : "gmail-fallback",
      };
    }
    if (advisorDecision && isSwitchToChatAction(advisorDecision.action)) {
      return handoffActiveTaskContextToChat(
        contextKey,
        refreshedContext,
        options,
        "advisor-topic-switch",
      );
    }
    if (
      advisorDecision?.action === "start_new_task" &&
      advisorDecision.taskFamily === "gmail_payment_summary" &&
      advisorDecision.sourceChoice === "gmail"
    ) {
      return restartPaymentTaskFromActiveContext(contextKey, refreshedContext, options);
    }
    if (isFreshPaymentLookupRequest(options.message, refreshedContext, advisorDecision)) {
      return restartPaymentTaskFromActiveContext(contextKey, refreshedContext, options);
    }
    const handled = await handleActiveTaskContext(
      contextKey,
      refreshedContext,
      options,
      advisorDecision ?? undefined,
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
    sourceChoice: isStartNewTaskAction(deterministicAction) ? "gmail" : null,
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

  if (finalDecision.action === "answer_capability") {
    return {
      kind: "direct",
      message: buildCapabilityAnswer(options.gmailReady),
      source: options.gmailReady ? "gmail-context" : "gmail-fallback",
    };
  }

  if (isContinueTaskAction(finalDecision.action) && refreshedContext) {
    const handled = await handleActiveTaskContext(
      contextKey,
      refreshedContext,
      options,
      advisorDecision ?? undefined,
    );
    if (handled) {
      return handled;
    }
  }

  if (isClarifyAction(finalDecision.action)) {
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

  if (
    isStartNewTaskAction(finalDecision.action) ||
    (isContinueTaskAction(finalDecision.action) &&
      !refreshedContext &&
      finalDecision.sourceChoice === "gmail")
  ) {
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




