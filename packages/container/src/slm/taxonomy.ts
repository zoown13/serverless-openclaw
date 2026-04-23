import type {
  ToolIntentAdvisorAction,
  ToolSourceChoice,
  ToolTaskFamily,
} from "@serverless-openclaw/shared";

export const TOOL_INTENT_ADVISOR_ACTIONS = [
  "gmail",
  "clarify_source",
  "generic_openclaw",
  "continue_active_task",
] as const satisfies readonly ToolIntentAdvisorAction[];

export const TOOL_TASK_FAMILIES = [
  "gmail_payment_summary",
  "gmail_search",
  "gmail_body_selection",
  "generic_tool_task",
] as const satisfies readonly ToolTaskFamily[];

export const TOOL_SOURCE_CHOICES = [
  "gmail",
  "general",
  null,
] as const satisfies Array<ToolSourceChoice | null>;

export const TOOL_FOLLOW_UP_INTENTS = [
  "continue_active_task",
  "refine_topic",
  "refine_date",
  "issuer_breakdown",
  "merchant_breakdown",
  "amount_summary",
  "coverage_check",
  "open_body",
  "cancel_task",
] as const;

export type ToolFollowUpIntent = (typeof TOOL_FOLLOW_UP_INTENTS)[number];

export function isToolIntentAdvisorAction(value: unknown): value is ToolIntentAdvisorAction {
  return (
    typeof value === "string" &&
    TOOL_INTENT_ADVISOR_ACTIONS.includes(value as ToolIntentAdvisorAction)
  );
}

export function isToolTaskFamily(value: unknown): value is ToolTaskFamily {
  return typeof value === "string" && TOOL_TASK_FAMILIES.includes(value as ToolTaskFamily);
}

export function isToolSourceChoice(value: unknown): value is ToolSourceChoice | null {
  return (
    value === null ||
    (typeof value === "string" && TOOL_SOURCE_CHOICES.includes(value as ToolSourceChoice))
  );
}

export function isToolFollowUpIntent(value: unknown): value is ToolFollowUpIntent {
  return typeof value === "string" && TOOL_FOLLOW_UP_INTENTS.includes(value as ToolFollowUpIntent);
}
