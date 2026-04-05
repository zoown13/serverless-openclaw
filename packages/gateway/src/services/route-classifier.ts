import type {
  RouteDecision,
  RuntimeClass,
  TaskStateItem,
} from "@serverless-openclaw/shared";

export interface ClassifyRouteParams {
  message: string;
  taskState: TaskStateItem | null;
}

const FARGATE_HINTS = ["/heavy", "/fargate"];
const EMAIL_HINT_PATTERN =
  /(?:\bgmail\b|\bemail\b|\be-mail\b|\bmailbox\b|\binbox\b|\bunread\b|지메일|이메일|메일(?:함)?|수신함|받은편지함|편지함|안 읽은|읽지 않은)/i;
const EMAIL_ACTION_PATTERN =
  /(?:\baccess\b|\bconnect\b|\bintegrat(?:e|ion)?\b|\bfetch\b|\bload\b|\bget\b|\bcheck\b|\bread\b|\bopen\b|\bsearch\b|\bsend\b|\bsummar(?:ize|ise)\b|\banaly[sz]e\b|\breview\b|\btriage\b|\bbody\b|\bcontent\b|\bdetails?\b|\bdetailed\b|접근|연동|연결|가져오|불러오|조회|확인|읽|열|검색|보내|요약|분석|정리|분류|찾|살펴|보여|봐|본문|내용|자세히|상세)/i;
const EMAIL_QUERY_PATTERN =
  /(?:\bfrom\b|\bsubject\b|\binvoice\b|\breceipt\b|\bstatement\b|\bbill(?:ing)?\b|\bcard\b|\btoday\b|\byesterday\b|\bthis week\b|\bthis month\b|\blast month\b|\b20\d{2}[/.](?:1[0-2]|0?[1-9])\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|보낸사람|제목|카드|명세서|청구서|영수증|오늘|어제|이번 주|이번주|이번 달|이번달|지난달|저번 달|저번달|전월|20\d{2}[/.](?:1[0-2]|0?[1-9])|(?:1[0-2]|0?[1-9])월)/i;
const PAYMENT_DATA_PATTERN =
  /(?:결제|지출|사용금액|사용 금액|승인내역|카드값|카드\s*(?:사용|결제)|청구서|영수증|명세서|\bpayment(?:s)?\b|\bcharge(?:s|d)?\b|\btransaction(?:s)?\b|\bspent\b|\bspend\b|\bbilling\b|\binvoice\b|\breceipt\b|\bstatement\b)/i;
const PAYMENT_SUMMARY_PATTERN =
  /(?:얼마|총액|합계|총합|어느 정도|어느정도|얼마나|계산|정리|요약|찾|알려|보여|확인|\bhow much\b|\btotal\b|\bsum\b|\bcalculate\b|\bshow\b|\bcheck\b|\bfind\b)/i;
const PAYMENT_LOOKUP_PATTERN =
  /(?:결제(?:한)?|지출|카드(?:값|사용|결제)?|사용금액|사용 금액).*(?:금액|얼마|얼마나|총액|합계|총합|어느 정도|어느정도|정도|나왔|썼|쓴|되려나)|(?:금액|얼마|얼마나|총액|합계|총합|어느 정도|어느정도|정도|나왔|썼|쓴|되려나).*(?:결제(?:한)?|지출|카드(?:값|사용|결제)?|사용금액|사용 금액)/i;
const PAYMENT_DATA_TOKENS = [
  "결제",
  "지출",
  "사용금액",
  "사용 금액",
  "승인내역",
  "카드값",
  "카드사용",
  "카드 사용",
  "카드결제",
  "카드 결제",
  "청구서",
  "영수증",
  "명세서",
  "payment",
  "payments",
  "charge",
  "charges",
  "charged",
  "transaction",
  "transactions",
  "spent",
  "spend",
  "billing",
  "invoice",
  "receipt",
  "statement",
];
const PAYMENT_SUMMARY_TOKENS = [
  "금액",
  "얼마",
  "총액",
  "합계",
  "총합",
  "어느정도",
  "어느 정도",
  "얼마나",
  "계산",
  "정리",
  "요약",
  "찾",
  "알려",
  "보여",
  "확인",
  "나왔",
  "썼",
  "쓴",
  "되려나",
  "howmuch",
  "how much",
  "total",
  "sum",
  "calculate",
  "show",
  "check",
  "find",
];
const TOOL_HEAVY_PATTERNS = [
  /(?:check|read|open|search|send|summari[sz]e|analy[sz]e|show|body|content|details?).*(?:gmail|email|mailbox|inbox|attachment|message)/i,
  /(?:gmail|email|mailbox|inbox|attachment|message).*(?:check|read|open|search|send|summari[sz]e|analy[sz]e|show|body|content|details?)/i,
  /(?:browse|open|visit|search|crawl|scrape|look up|navigate).*(?:web|browser|site|website|page|url|internet)/i,
  /(?:browser|website|web page|site|internet|url|link).*(?:open|browse|visit|search|check|look up|navigate)/i,
  /\b(use|run|call|invoke)\b.*\btool\b/i,
  /\btool\b.*\b(use|run|call|invoke)\b/i,
  /(?:확인|읽|열|검색|보내|요약|분석|자세히|상세|본문|내용|보여).*(?:지메일|이메일|메일|받은편지함|첨부파일|메시지)/,
  /(?:지메일|이메일|메일|받은편지함|첨부파일|메시지).*(?:확인|읽|열|검색|보내|요약|분석|자세히|상세|본문|내용|보여)/,
  /(?:브라우저|웹|사이트|페이지|인터넷|링크|주소).*(?:열|찾|검색|접속|확인|둘러|탐색)/,
  /(?:열|찾|검색|접속|확인|둘러|탐색).*(?:브라우저|웹|사이트|페이지|인터넷|링크|주소)/,
  /도구.*(?:사용|실행|호출)/,
  /(?:사용|실행|호출).*도구/,
];

function normalizeIntentMessage(message: string): string {
  return message.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function compactIntentMessage(message: string): string {
  return normalizeIntentMessage(message).replace(/[\s\p{P}\p{S}]+/gu, "");
}

function looksLikePaymentDataLookup(message: string): boolean {
  const normalized = normalizeIntentMessage(message);
  const compact = compactIntentMessage(message);
  const hasPaymentToken = PAYMENT_DATA_TOKENS.some(
    (token) => normalized.includes(token) || compact.includes(token.replace(/\s+/gu, "")),
  );
  const hasSummaryToken = PAYMENT_SUMMARY_TOKENS.some(
    (token) => normalized.includes(token) || compact.includes(token.replace(/\s+/gu, "")),
  );

  return (
    (hasPaymentToken && hasSummaryToken) ||
    (PAYMENT_DATA_PATTERN.test(normalized) && PAYMENT_SUMMARY_PATTERN.test(normalized)) ||
    (PAYMENT_DATA_PATTERN.test(compact) && PAYMENT_SUMMARY_PATTERN.test(compact)) ||
    PAYMENT_LOOKUP_PATTERN.test(normalized) ||
    PAYMENT_LOOKUP_PATTERN.test(compact)
  );
}

function hasFargateHint(message: string): boolean {
  const lowerMsg = normalizeIntentMessage(message).toLowerCase();
  for (const hint of FARGATE_HINTS) {
    if (lowerMsg.startsWith(hint)) {
      return true;
    }
  }
  return false;
}

export function classifyRouteRuntimeClass(message: string): RuntimeClass {
  const normalized = normalizeIntentMessage(message);

  if (hasFargateHint(normalized)) {
    return "tool-enabled";
  }

  if (
    EMAIL_HINT_PATTERN.test(normalized) &&
    (EMAIL_ACTION_PATTERN.test(normalized) || EMAIL_QUERY_PATTERN.test(normalized))
  ) {
    return "tool-enabled";
  }

  if (looksLikePaymentDataLookup(normalized)) {
    return "tool-enabled";
  }

  return TOOL_HEAVY_PATTERNS.some((pattern) => pattern.test(normalized))
    ? "tool-enabled"
    : "chat-only";
}

/**
 * Classify which runtime to use when AGENT_RUNTIME=both.
 * Gateway now makes only a coarse cost-aware runtime decision.
 */
export function classifyRoute(params: ClassifyRouteParams): RouteDecision {
  const runtimeClass = classifyRouteRuntimeClass(params.message);

  if (runtimeClass === "tool-enabled") {
    if (params.taskState?.status === "Running" && params.taskState.publicIp) {
      return "fargate-reuse";
    }

    return "fargate-new";
  }

  return "lambda";
}

/**
 * Strip Fargate hint prefix from message if present.
 * Returns the original message if no hint found.
 */
export function stripRouteHint(message: string): string {
  const trimmed = message.trimStart();
  const lowerMsg = trimmed.toLowerCase();
  for (const hint of FARGATE_HINTS) {
    if (lowerMsg.startsWith(hint)) {
      return trimmed.slice(hint.length).trimStart();
    }
  }
  return message;
}
