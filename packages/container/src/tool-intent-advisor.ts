import type {
  ToolIntentAdvisorResult,
  ToolSourceChoice,
  ToolTaskFamily,
} from "@serverless-openclaw/shared";
import {
  createDefaultSlmClassifier,
  evaluateSlmDecisionPolicy,
  parseSlmClassifierResponse,
} from "./slm/index.js";
import type { SlmBackendKind, SlmClassificationInput, ToolFollowUpIntent } from "./slm/index.js";

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
  slmBackend?: SlmBackendKind;
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

function decisionNeedsGmail(decision: ToolIntentDecision): boolean {
  return (
    decision.sourceChoice === "gmail" &&
    [
      "gmail",
      "start_new_task",
      "continue_task",
      "refine_current_task",
      "rerun_current_task",
      "continue_active_task",
    ].includes(decision.action)
  );
}

export function parseToolIntentAdvisorResponse(text: string): ToolIntentDecision | null {
  const parsed = parseSlmClassifierResponse(text);
  if (!parsed) {
    return null;
  }
  return {
    action: parsed.action,
    taskFamily: parsed.taskFamily,
    sourceChoice: parsed.sourceChoice,
    ...(parsed.followUpIntent ? { followUpIntent: parsed.followUpIntent } : {}),
    confidence: parsed.confidence,
    ...(parsed.reason ? { reason: parsed.reason } : {}),
  };
}

export async function decideToolIntent(
  input: DecideToolIntentInput,
): Promise<ToolIntentDecision | null> {
  const decision = await slmClassifier.classify(toSlmInput(input));
  if (!decision) {
    return null;
  }
  const policy = evaluateSlmDecisionPolicy(decision);
  if (policy === "reject" || policy === "fallback") {
    return null;
  }
  if (!input.gmailReady && decisionNeedsGmail(decision)) {
    return null;
  }
  return {
    action: decision.action,
    taskFamily: decision.taskFamily,
    sourceChoice: decision.sourceChoice,
    followUpIntent: decision.followUpIntent,
    confidence: decision.confidence,
    slmBackend: decision.slmBackend ?? slmClassifier.backendKind,
    reason: decision.reason,
  };
}
