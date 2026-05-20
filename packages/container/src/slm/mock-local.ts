import type { SlmClassificationInput, SlmClassifier, SlmTaskDecision } from "./types.js";

const PAYMENT_LOOKUP_PATTERN =
  /(결제|결제\s*(?:이력|기록)|카드값|카드 값|카드\s*(?:이력|기록)|명세서|청구서|영수증|지출|지출액|사용금액|사용 금액|사용\s*(?:이력|기록)|거래\s*(?:이력|기록)|receipt|statement|invoice|spent|spend|payment|payment\s+histor(?:y|ies)|transaction\s+(?:history|records?)|total|amount|얼마 썼|얼마 쓴|사용한 돈|사용한\s*돈|쓴 돈|쓴\s*돈|소비|비용|이번\s*주.*얼마|이번주.*얼마|이번\s*달.*얼마|이번달.*얼마|최근.*얼마|expenses?|costs?|spending)/i;
const DATA_LOOKUP_PATTERN =
  /(정리|요약|알려|보여|찾|조회|확인|summary|breakdown|history|records?|내역|이력|기록|어디에|기간|부터|까지|이번주|이번 주|이번달|이번 달|최근|오늘|어제|얼마)/i;
const TRAVEL_CONTEXT_PATTERN =
  /(여행|travel|trip|출장|해외|overseas|일본|japan|도쿄|tokyo|오사카|osaka|교토|kyoto|후쿠오카|fukuoka|삿포로|sapporo|오키나와|okinawa|나고야|nagoya|나리타|narita|하네다|haneda|간사이|kansai|항공|flight|호텔|hotel|숙소|esim|e-sim|jr|rail|기차|train|전철|지하철|subway|메트로|metro|렌터카|rental|공항|airport|셔틀|shuttle|버스|bus|패스|pass|페리|ferry)/i;
const BODY_OPEN_PATTERN =
  /(본문|자세히|열어줘|open|full body|details?|메일 보여|1번|2번|3번|4번|5번)/i;
const TOPIC_REFINE_PATTERN =
  /(관련된 것만|관련만|쪽만|여행 관련|일본 관련|일본\s*(?:것|쪽|관련)?만|travel|trip)/i;
const DATE_REFINE_PATTERN =
  /(\d+\s*월\s*\d+\s*일|이번주|이번 주|지난주|지난 주|이번달|이번 달|지난달|지난 달|최근\s*\d+\s*일|부터|까지|전후|날짜|date|기간)/i;
const ISSUER_BREAKDOWN_PATTERN = /(카드사|issuer)/i;
const MERCHANT_BREAKDOWN_PATTERN = /(결제처|가맹점|merchant)/i;
const AMOUNT_SUMMARY_PATTERN = /(합계|총액|sum|total|얼마)/i;
const COVERAGE_CHECK_PATTERN =
  /(더\s*(있|찾|보)|밖에\s*없|몇\s*개|개수|건수|빠진\s*(?:거|것)?\s*없|누락|전부\s*다시|전체\s*다시|다시\s*전부|limit)/i;
const CANCEL_PATTERN = /^(?:취소|그만|끝|됐어|done|cancel|stop)(?:[.!?])?$/i;
const EXPLICIT_GMAIL_PATTERN = /(gmail|google mail|inbox|mailbox|이메일|메일함|메일에서|지메일)/i;
const CAPABILITY_QUERY_PATTERN =
  /((결제|지출|카드|거래|승인|영수증|명세서|payment|transaction|spending|expense|gmail|지메일|메일).*(할\s*수\s*있|가능(?!한)|볼\s*수\s*있|가져올\s*수\s*있|확인\s*가능(?!한)|접근\s*가능(?!한)|연결(?:돼|되어)|available|can\s+you|can\s+i))|((할\s*수\s*있|가능(?!한)|볼\s*수\s*있|가져올\s*수\s*있|확인\s*가능(?!한)|접근\s*가능(?!한)|available|can\s+you).*(결제|지출|카드|거래|승인|영수증|명세서|payment|transaction|spending|expense|gmail|지메일|메일))/i;
const OBVIOUS_GENERAL_CHAT_PATTERN =
  /(날씨|weather|번역|translate|농담|joke|리눅스|linux|명령어|command|코드|code|설명해|추천해|맛집|일정|계획|어떻게|왜|무엇|뭐야|what|how|why)/i;
const EXPLICIT_GENERAL_HANDOFF_PATTERN =
  /(그거\s*말고|그건\s*됐고|다른\s*질문|일반\s*질문|툴\s*말고|지메일\s*말고|gmail\s*말고|not\s+gmail|different\s+question)/i;

function classifyActiveFollowUp(input: SlmClassificationInput): SlmTaskDecision | null {
  if (!input.activeTaskFamily) {
    return null;
  }

  const message = input.message.trim();
  const sourceChoice = input.activeSourceChoice ?? "gmail";

  if (CAPABILITY_QUERY_PATTERN.test(message)) {
    return {
      action: "answer_capability",
      taskFamily: PAYMENT_LOOKUP_PATTERN.test(message)
        ? "gmail_payment_summary"
        : "gmail_search",
      sourceChoice: input.gmailReady ? "gmail" : "general",
      confidence: 0.95,
      reason: "mock-local capability check",
    };
  }

  if (CANCEL_PATTERN.test(message)) {
    return {
      action: "cancel_task",
      taskFamily: input.activeTaskFamily,
      sourceChoice,
      followUpIntent: "cancel_task",
      confidence: 0.99,
      reason: "mock-local active cancel",
    };
  }
  if (
    (OBVIOUS_GENERAL_CHAT_PATTERN.test(message) || EXPLICIT_GENERAL_HANDOFF_PATTERN.test(message)) &&
    !PAYMENT_LOOKUP_PATTERN.test(message) &&
    !EXPLICIT_GMAIL_PATTERN.test(message) &&
    !TOPIC_REFINE_PATTERN.test(message) &&
    !BODY_OPEN_PATTERN.test(message)
  ) {
    return {
      action: "switch_to_chat",
      taskFamily: "generic_tool_task",
      sourceChoice: "general",
      confidence: EXPLICIT_GENERAL_HANDOFF_PATTERN.test(message) ? 0.95 : 0.9,
      reason: "mock-local active general chat handoff",
    };
  }
  if (BODY_OPEN_PATTERN.test(message)) {
    return {
      action: "continue_task",
      taskFamily: input.activeTaskFamily,
      sourceChoice,
      followUpIntent: "open_body",
      confidence: 0.95,
      reason: "mock-local body open",
    };
  }
  if (TOPIC_REFINE_PATTERN.test(message)) {
    return {
      action: "refine_current_task",
      taskFamily: input.activeTaskFamily,
      sourceChoice,
      followUpIntent: "refine_topic",
      confidence: 0.9,
      reason: "mock-local topic refine",
    };
  }
  if (DATE_REFINE_PATTERN.test(message)) {
    return {
      action: "refine_current_task",
      taskFamily: input.activeTaskFamily,
      sourceChoice,
      followUpIntent: "refine_date",
      confidence: 0.9,
      reason: "mock-local date refine",
    };
  }
  if (ISSUER_BREAKDOWN_PATTERN.test(message)) {
    return {
      action: "refine_current_task",
      taskFamily: input.activeTaskFamily,
      sourceChoice,
      followUpIntent: "issuer_breakdown",
      confidence: 0.96,
      reason: "mock-local issuer breakdown",
    };
  }
  if (MERCHANT_BREAKDOWN_PATTERN.test(message)) {
    return {
      action: "refine_current_task",
      taskFamily: input.activeTaskFamily,
      sourceChoice,
      followUpIntent: "merchant_breakdown",
      confidence: 0.96,
      reason: "mock-local merchant breakdown",
    };
  }
  if (AMOUNT_SUMMARY_PATTERN.test(message)) {
    return {
      action: "continue_task",
      taskFamily: input.activeTaskFamily,
      sourceChoice,
      followUpIntent: "amount_summary",
      confidence: 0.85,
      reason: "mock-local amount summary",
    };
  }
  if (COVERAGE_CHECK_PATTERN.test(message)) {
    return {
      action: "rerun_current_task",
      taskFamily: input.activeTaskFamily,
      sourceChoice,
      followUpIntent: "coverage_check",
      confidence: 0.9,
      reason: "mock-local coverage check",
    };
  }
  if (message.length <= 24) {
    return {
      action: "continue_task",
      taskFamily: input.activeTaskFamily,
      sourceChoice,
      followUpIntent: "continue_active_task",
      confidence: 0.8,
      reason: "mock-local short follow-up",
    };
  }

  return null;
}

function classifyFreshMessage(input: SlmClassificationInput): SlmTaskDecision | null {
  const message = input.message.trim();
  if (CAPABILITY_QUERY_PATTERN.test(message)) {
    return {
      action: "answer_capability",
      taskFamily: PAYMENT_LOOKUP_PATTERN.test(message)
        ? "gmail_payment_summary"
        : "gmail_search",
      sourceChoice: input.gmailReady ? "gmail" : "general",
      confidence: 0.95,
      reason: "mock-local capability check",
    };
  }

  const looksLikePaymentLookup =
    PAYMENT_LOOKUP_PATTERN.test(message) ||
    (TRAVEL_CONTEXT_PATTERN.test(message) && DATA_LOOKUP_PATTERN.test(message));

  if (looksLikePaymentLookup) {
    if (!input.gmailReady) {
      return {
        action: "switch_to_chat",
        taskFamily: "generic_tool_task",
        sourceChoice: "general",
        confidence: 0.45,
        reason: "mock-local payment lookup without gmail",
      };
    }
    return {
      action: "start_new_task",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.9,
      reason: "mock-local payment summary",
    };
  }

  if (BODY_OPEN_PATTERN.test(message) && input.gmailReady) {
    return {
      action: "start_new_task",
      taskFamily: "gmail_body_selection",
      sourceChoice: "gmail",
      confidence: 0.84,
      reason: "mock-local body selection",
    };
  }

  if (EXPLICIT_GMAIL_PATTERN.test(message) && input.gmailReady) {
    return {
      action: "start_new_task",
      taskFamily: "gmail_search",
      sourceChoice: "gmail",
      confidence: 0.8,
      reason: "mock-local explicit gmail",
    };
  }

  return {
    action: "switch_to_chat",
    taskFamily: "generic_tool_task",
    sourceChoice: "general",
    confidence: 0.4,
    reason: "mock-local fallback",
  };
}

export function createMockLocalSlmClassifier(): SlmClassifier {
  return {
    backendKind: "mock-local",
    async classify(input: SlmClassificationInput): Promise<SlmTaskDecision | null> {
      return classifyActiveFollowUp(input) ?? classifyFreshMessage(input);
    },
  };
}
