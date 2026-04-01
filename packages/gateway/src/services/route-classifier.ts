import type { RuntimeClass, TaskStateItem } from "@serverless-openclaw/shared";

export type RouteDecision = "lambda" | "fargate-reuse" | "fargate-new";

export interface ClassifyRouteParams {
  message: string;
  taskState: TaskStateItem | null;
}

const FARGATE_HINTS = ["/heavy", "/fargate"];
const TOOL_HEAVY_PATTERNS = [
  /(?:check|read|open|search|send|summari[sz]e|analy[sz]e).*(?:gmail|email|mailbox|inbox|attachment)/i,
  /(?:gmail|email|mailbox|inbox|attachment).*(?:check|read|open|search|send|summari[sz]e|analy[sz]e)/i,
  /(?:browse|open|visit|search|crawl|scrape|look up|navigate).*(?:web|browser|site|website|page|url|internet)/i,
  /(?:browser|website|web page|site|internet|url|link).*(?:open|browse|visit|search|check|look up|navigate)/i,
  /\b(use|run|call|invoke)\b.*\btool\b/i,
  /\btool\b.*\b(use|run|call|invoke)\b/i,
  /(?:확인|읽|열|검색|보내|요약|분석).*(?:지메일|이메일|메일|받은편지함|첨부파일)/,
  /(?:지메일|이메일|메일|받은편지함|첨부파일).*(?:확인|읽|열|검색|보내|요약|분석)/,
  /(?:브라우저|웹|사이트|페이지|인터넷|링크|주소).*(?:열|찾|검색|접속|확인|둘러|탐색)/,
  /(?:열|찾|검색|접속|확인|둘러|탐색).*(?:브라우저|웹|사이트|페이지|인터넷|링크|주소)/,
  /도구.*(?:사용|실행|호출)/,
  /(?:사용|실행|호출).*도구/,
];

function hasFargateHint(message: string): boolean {
  const lowerMsg = message.trimStart().toLowerCase();
  for (const hint of FARGATE_HINTS) {
    if (lowerMsg.startsWith(hint)) {
      return true;
    }
  }
  return false;
}

export function classifyRouteRuntimeClass(message: string): RuntimeClass {
  if (hasFargateHint(message)) {
    return "tool-enabled";
  }

  return TOOL_HEAVY_PATTERNS.some((pattern) => pattern.test(message))
    ? "tool-enabled"
    : "chat-only";
}

/**
 * Classify which runtime to use for a message when AGENT_RUNTIME=both.
 * Tool-heavy requests prefer Fargate, while normal chat stays on Lambda.
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
