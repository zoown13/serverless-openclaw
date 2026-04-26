import type {
  ToolIntentAdvisorAction,
  ToolSourceChoice,
  ToolTaskFamily,
} from "@serverless-openclaw/shared";

import type { ToolFollowUpIntent } from "./taxonomy.js";

export type SlmBackendKind = "remote-api" | "mock-local" | "local-transformers";

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
  slmBackend?: SlmBackendKind;
  reason?: string;
}

export interface SlmClassifier {
  readonly backendKind: SlmBackendKind;
  classify(input: SlmClassificationInput): Promise<SlmTaskDecision | null>;
}
