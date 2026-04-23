import type {
  RouteDecision,
  RuntimeClass,
  TaskStateItem,
} from "@serverless-openclaw/shared";

export interface ClassifyRouteParams {
  message: string;
  taskState: TaskStateItem | null;
}

export interface RouteClassificationSignals {
  hasFargateHint: boolean;
  hasPrivateDataTarget: boolean;
  hasPrivateDataAction: boolean;
  hasFinanceLookup: boolean;
  hasDataLookupAction: boolean;
  hasTravelContext: boolean;
  hasPaymentRecord: boolean;
  hasHangul: boolean;
}

const FARGATE_HINTS = ["/heavy", "/fargate"];
const PRIVATE_DATA_TARGET_PATTERN =
  /(?:\bgmail\b|\bemails?\b|\be-mails?\b|\bmailbox\b|\binbox\b|\bunread\b|\battachments?\b|\bmessages?\b|\bbrowser\b|\bweb(?:site)?\b|\bsite\b|\bpage\b|\burl\b|\blink\b|\btool\b|\bfiles?\b|\bprivate data\b|지메일|이메일|메일(?:함)?|수신함|받은편지함|편지함|안 읽은|읽지 않은|첨부파일|메시지|브라우저|웹|사이트|페이지|주소|링크|도구|파일|개인\s*데이터)/i;
const PRIVATE_DATA_ACTION_PATTERN =
  /(?:\baccess\b|\bconnect\b|\bintegrat(?:e|ion)?\b|\bfetch\b|\bload\b|\bget\b|\bcheck\b|\bread\b|\bopen\b|\bsearch\b|\bsend\b|\bsummar(?:ize|ise)\b|\banaly[sz]e\b|\breview\b|\btriage\b|\bbody\b|\bcontent\b|\bdetails?\b|\bbrowse\b|\bvisit\b|\bnavigate\b|\blook up\b|접근|연동|연결|가져오|불러오|조회|확인|읽|열|검색|보내|요약|분석|정리|분류|찾|살펴|보여|봐|본문|내용|자세히|상세|둘러|탐색|접속)/i;
const FINANCE_LOOKUP_PATTERN =
  /(?:결제|지출|지출액|사용금액|사용 금액|사용한\s*돈|쓴\s*돈|썼던\s*돈|소비|소비내역|비용|승인내역|카드값|카드\s*(?:사용|결제)|여행\s*경비|출장\s*경비|청구서|영수증|명세서|\bpayment(?:s)?\b|\bcharge(?:s|d)?\b|\btransaction(?:s)?\b|\bspent\b|\bspend(?:ing)?\b|\bexpense(?:s)?\b|\bcosts?\b|\bbilling\b|\binvoice\b|\breceipt\b|\bstatement\b)/i;
const DATA_LOOKUP_ACTION_PATTERN =
  /(?:얼마|총액|합계|총합|어느 정도|어느정도|얼마나|계산|정리|요약|찾|알려|보여|확인|분석|내역|\bhow much\b|\btotal\b|\bsum\b|\bshow\b|\bcheck\b|\bfind\b|\bsummary\b|\bbreakdown\b)/i;
const TRAVEL_CONTEXT_PATTERN =
  /(?:여행|출장|일본|도쿄|오사카|교토|후쿠오카|삿포로|오키나와|항공|비행|호텔|숙소|eSIM|\btravel\b|\btrip\b|\bflight\b|\bhotel\b|\blodging\b|\besim\b)/i;
const PAYMENT_RECORD_PATTERN =
  /(?:결제한?\s*내역(?:들)?|지출\s*내역(?:들)?|사용\s*내역(?:들)?|사용한\s*돈|쓴\s*돈|소비\s*내역(?:들)?|여행\s*경비|출장\s*경비|카드사별|결제처별|\brecords?\b|\bhistory\b)/i;

function normalizeIntentMessage(message: string): string {
  return message.normalize("NFKC").replace(/\s+/gu, " ").trim();
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

export function getRouteClassificationSignals(
  message: string,
): RouteClassificationSignals {
  const normalized = normalizeIntentMessage(message);
  return {
    hasFargateHint: hasFargateHint(normalized),
    hasPrivateDataTarget: PRIVATE_DATA_TARGET_PATTERN.test(normalized),
    hasPrivateDataAction: PRIVATE_DATA_ACTION_PATTERN.test(normalized),
    hasFinanceLookup: FINANCE_LOOKUP_PATTERN.test(normalized),
    hasDataLookupAction: DATA_LOOKUP_ACTION_PATTERN.test(normalized),
    hasTravelContext: TRAVEL_CONTEXT_PATTERN.test(normalized),
    hasPaymentRecord: PAYMENT_RECORD_PATTERN.test(normalized),
    hasHangul: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(normalized),
  };
}

export function classifyRouteRuntimeClass(message: string): RuntimeClass {
  const signals = getRouteClassificationSignals(message);

  if (signals.hasFargateHint) {
    return "tool-enabled";
  }

  if (signals.hasPrivateDataTarget && signals.hasPrivateDataAction) {
    return "tool-enabled";
  }

  if (
    signals.hasTravelContext &&
    signals.hasFinanceLookup &&
    (signals.hasDataLookupAction || signals.hasPaymentRecord)
  ) {
    return "tool-enabled";
  }

  if (signals.hasFinanceLookup && signals.hasDataLookupAction) {
    return "tool-enabled";
  }

  return "chat-only";
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
