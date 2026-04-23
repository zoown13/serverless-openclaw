import type {
  ToolIntentAdvisorAction,
  ToolSourceChoice,
  ToolTaskFamily,
} from "@serverless-openclaw/shared";

import type { ToolFollowUpIntent } from "./taxonomy.js";

export interface SlmClassificationInput {
  message: string;
  gmailReady: boolean;
  activeTaskFamily?: ToolTaskFamily;
  activeSourceChoice?: ToolSourceChoice | null;
  activeCanonicalGoal?: string;
  recentResultSummary?: string;
}

export interface SlmTaskDecision {
  action: ToolIntentAdvisorAction;
  taskFamily: ToolTaskFamily;
  sourceChoice?: ToolSourceChoice | null;
  followUpIntent?: ToolFollowUpIntent;
  confidence: number;
  reason?: string;
}

export interface SlmClassifier {
  classify(input: SlmClassificationInput): Promise<SlmTaskDecision | null>;
}
