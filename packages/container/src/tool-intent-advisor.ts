import { ConverseCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import type {
  ToolIntentAdvisorAction,
  ToolIntentAdvisorResult,
  ToolSourceChoice,
  ToolTaskFamily,
} from "@serverless-openclaw/shared";

const MAX_ADVISOR_CHARS = 600;
const MIN_CONFIDENCE = 0.72;
const TIMEOUT_MS = 3500;
const ALLOWED_ACTIONS = new Set<ToolIntentAdvisorAction>([
  "gmail",
  "clarify_source",
  "generic_openclaw",
  "continue_active_task",
]);
const ALLOWED_FAMILIES = new Set<ToolTaskFamily>([
  "gmail_payment_summary",
  "gmail_search",
  "gmail_body_selection",
  "generic_tool_task",
]);
const ALLOWED_SOURCES = new Set<ToolSourceChoice | null>(["gmail", "general", null]);

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

function provider(): "anthropic" | "bedrock" {
  return process.env.AI_PROVIDER === "bedrock" ? "bedrock" : "anthropic";
}

function model(): string | undefined {
  return process.env.AI_MODEL;
}

function truncate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > MAX_ADVISOR_CHARS ? `${value.slice(0, MAX_ADVISOR_CHARS)}...` : value;
}

function promptFor(input: DecideToolIntentInput): string {
  return [
    "You are a strict routing classifier for a tool-capable OpenClaw runtime.",
    "Return JSON only.",
    "Allowed action values: gmail, clarify_source, generic_openclaw, continue_active_task.",
    "Allowed taskFamily values: gmail_payment_summary, gmail_search, gmail_body_selection, generic_tool_task.",
    "Allowed sourceChoice values: gmail, general, null.",
    "If gmailReady is false, never choose gmail.",
    "Prefer gmail for payment, receipt, statement, billing, or spending questions that likely need the user's own inbox history when gmailReady is true, even if the user did not explicitly mention Gmail.",
    "When the message asks for payment histories, spending totals, card issuer breakdowns, merchant breakdowns, or trip-related expenses, choose taskFamily gmail_payment_summary rather than gmail_search.",
    "Choose clarify_source only when both Gmail lookup and general reasoning are plausible and you cannot safely choose one source.",
    "Choose continue_active_task when the message looks like a follow-up to the active task context, even if it is short or does not repeat the original payment keywords.",
    "Respond with JSON: {\"action\":...,\"taskFamily\":...,\"sourceChoice\":...,\"confidence\":0-1}",
    `gmailReady: ${input.gmailReady}`,
    `message: ${JSON.stringify(truncate(input.message))}`,
    `activeContext: ${JSON.stringify({
      taskFamily: input.activeContext?.taskFamily ?? null,
      sourceChoice: input.activeContext?.sourceChoice ?? null,
      canonicalGoal: truncate(input.activeContext?.canonicalGoal),
      lastResultSummary: truncate(input.activeContext?.lastResultSummary),
    })}`,
  ].join("\n");
}

export function parseToolIntentAdvisorResponse(text: string): ToolIntentAdvisorResult | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0 || end <= start) {
      return null;
    }
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<ToolIntentAdvisorResult>;
    if (!parsed.action || !ALLOWED_ACTIONS.has(parsed.action)) {
      return null;
    }
    const taskFamily = parsed.taskFamily;
    if (!taskFamily || !ALLOWED_FAMILIES.has(taskFamily)) {
      return null;
    }
    const sourceChoice = (parsed.sourceChoice ?? null) as ToolSourceChoice | null;
    if (!ALLOWED_SOURCES.has(sourceChoice)) {
      return null;
    }
    const confidence = Number(parsed.confidence ?? 0);
    if (!Number.isFinite(confidence)) {
      return null;
    }
    return {
      action: parsed.action,
      taskFamily,
      sourceChoice,
      confidence,
    };
  } catch {
    return null;
  }
}

async function decideViaBedrock(prompt: string): Promise<string | null> {
  const selectedModel = model();
  if (!selectedModel) {
    return null;
  }

  const client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
  });
  const response = await client.send(
    new ConverseCommand({
      modelId: selectedModel,
      inferenceConfig: {
        maxTokens: 180,
        temperature: 0,
      },
      messages: [
        {
          role: "user",
          content: [{ text: prompt }],
        },
      ],
    }),
  );

  return response.output?.message?.content?.find((item) => item.text)?.text ?? null;
}

async function decideViaAnthropic(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const selectedModel = model();
  if (!apiKey || !selectedModel) {
    return null;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: selectedModel,
      max_tokens: 180,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    return null;
  }
  const json = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return json.content?.find((item) => item.type === "text")?.text ?? null;
}

export async function decideToolIntent(
  input: DecideToolIntentInput,
): Promise<ToolIntentAdvisorResult | null> {
  const prompt = promptFor(input);
  const decisionPromise =
    provider() === "bedrock" ? decideViaBedrock(prompt) : decideViaAnthropic(prompt);

  const text = await Promise.race<string | null>([
    decisionPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
  ]);
  if (!text) {
    return null;
  }

  const parsed = parseToolIntentAdvisorResponse(text);
  if (!parsed || parsed.confidence < MIN_CONFIDENCE) {
    return null;
  }
  if (!input.gmailReady && parsed.action === "gmail") {
    return null;
  }
  return parsed;
}
