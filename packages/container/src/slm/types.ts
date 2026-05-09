import type {
  ToolIntentAdvisorAction,
  ToolSourceChoice,
  ToolTaskFamily,
} from "@serverless-openclaw/shared";

import type { ToolFollowUpIntent } from "./taxonomy.js";

export type SlmBackendKind = "remote-api" | "mock-local";

export interface SlmClassificationInput {
  message: string;
  gmailReady: boolean;
  activeStatus?: "awaiting_source" | "active";
  activeTaskFamily?: ToolTaskFamily;
  activeSourceChoice?: ToolSourceChoice | null;
  activeCanonicalGoal?: string;
  activeLastSearchQuery?: string;
  activeTopicKeywords?: string[];
  activeLastQueryMode?: string;
  activePaymentRecordCount?: number;
  activeLastCandidateCount?: number;
  activeLastScanLimit?: number;
  activeLastResultEstimate?: number;
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
