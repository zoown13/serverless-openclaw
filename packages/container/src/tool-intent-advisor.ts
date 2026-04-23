import type {
  ToolIntentAdvisorResult,
  ToolSourceChoice,
  ToolTaskFamily,
} from "@serverless-openclaw/shared";
import { MIN_TOOL_INTENT_CONFIDENCE, createDefaultSlmClassifier, parseSlmClassifierResponse } from "./slm/index.js";
import type { SlmClassificationInput, ToolFollowUpIntent } from "./slm/index.js";

export interface DecideToolIntentInput {
  message: string;
  gmailReady: boolean;
  activeContext?: {
    taskFamily?: ToolTaskFamily;
    sourceChoice?: ToolSourceChoice | null;
    canonicalGoal?: string;
    lastResultSummary?: string;
  };
}

export interface ToolIntentDecision extends ToolIntentAdvisorResult {
  followUpIntent?: ToolFollowUpIntent;
  reason?: string;
}

const slmClassifier = createDefaultSlmClassifier();

function toSlmInput(input: DecideToolIntentInput): SlmClassificationInput {
  return {
    message: input.message,
    gmailReady: input.gmailReady,
    activeTaskFamily: input.activeContext?.taskFamily,
    activeSourceChoice: input.activeContext?.sourceChoice,
    activeCanonicalGoal: input.activeContext?.canonicalGoal,
    recentResultSummary: input.activeContext?.lastResultSummary,
  };
}

export function parseToolIntentAdvisorResponse(text: string): ToolIntentAdvisorResult | null {
  const parsed = parseSlmClassifierResponse(text);
  if (!parsed) {
    return null;
  }
  return {
    action: parsed.action,
    taskFamily: parsed.taskFamily,
    sourceChoice: parsed.sourceChoice,
    confidence: parsed.confidence,
  };
}

export async function decideToolIntent(
  input: DecideToolIntentInput,
): Promise<ToolIntentDecision | null> {
  const decision = await slmClassifier.classify(toSlmInput(input));
  if (!decision) {
    return null;
  }
  if (decision.confidence < MIN_TOOL_INTENT_CONFIDENCE) {
    return null;
  }
  if (!input.gmailReady && decision.action === "gmail") {
    return null;
  }
  return {
    action: decision.action,
    taskFamily: decision.taskFamily,
    sourceChoice: decision.sourceChoice,
    followUpIntent: decision.followUpIntent,
    confidence: decision.confidence,
    reason: decision.reason,
  };
}
