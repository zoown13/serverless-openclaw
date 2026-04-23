import { ConverseCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import { isToolFollowUpIntent, isToolIntentAdvisorAction, isToolSourceChoice, isToolTaskFamily } from "./taxonomy.js";
import { createMockLocalSlmClassifier } from "./mock-local.js";
import type { SlmBackendKind, SlmClassificationInput, SlmClassifier, SlmTaskDecision } from "./types.js";

const MAX_CLASSIFIER_CHARS = 600;
export const MIN_TOOL_INTENT_CONFIDENCE = 0.72;
const TIMEOUT_MS = 3500;

export function resolveSlmBackendKind(value = process.env.TOOL_SLM_BACKEND): SlmBackendKind {
  return value === "mock-local" ? "mock-local" : "remote-api";
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
  return value.length > MAX_CLASSIFIER_CHARS
    ? `${value.slice(0, MAX_CLASSIFIER_CHARS)}...`
    : value;
}

function promptFor(input: SlmClassificationInput): string {
  return [
    "You are a strict routing classifier for a tool-capable OpenClaw runtime.",
    "Return JSON only.",
    "Allowed action values: gmail, clarify_source, generic_openclaw, continue_active_task.",
    "Allowed taskFamily values: gmail_payment_summary, gmail_search, gmail_body_selection, generic_tool_task.",
    "Allowed sourceChoice values: gmail, general, null.",
    "Optional followUpIntent values: continue_active_task, refine_topic, refine_date, issuer_breakdown, merchant_breakdown, amount_summary, coverage_check, open_body, cancel_task.",
    "If gmailReady is false, never choose gmail.",
    "Prefer gmail for payment, receipt, statement, billing, or spending questions that likely need the user's own inbox history when gmailReady is true, even if the user did not explicitly mention Gmail.",
    "When the message asks for payment histories, spending totals, card issuer breakdowns, merchant breakdowns, or trip-related expenses, choose taskFamily gmail_payment_summary rather than gmail_search.",
    "Choose clarify_source only when both Gmail lookup and general reasoning are plausible and you cannot safely choose one source.",
    "Choose continue_active_task when the message looks like a follow-up to the active task context, even if it is short or does not repeat the original payment keywords.",
    "Respond with JSON: {\"action\":...,\"taskFamily\":...,\"sourceChoice\":...,\"followUpIntent\":optional,\"confidence\":0-1,\"reason\":optional}",
    `gmailReady: ${input.gmailReady}`,
    `message: ${JSON.stringify(truncate(input.message))}`,
    `activeContext: ${JSON.stringify({
      taskFamily: input.activeTaskFamily ?? null,
      sourceChoice: input.activeSourceChoice ?? null,
      canonicalGoal: truncate(input.activeCanonicalGoal),
      lastResultSummary: truncate(input.recentResultSummary),
    })}`,
  ].join("\n");
}

export function parseSlmClassifierResponse(text: string): SlmTaskDecision | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0 || end <= start) {
      return null;
    }
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<SlmTaskDecision>;
    if (!isToolIntentAdvisorAction(parsed.action)) {
      return null;
    }
    if (!isToolTaskFamily(parsed.taskFamily)) {
      return null;
    }
    const sourceChoice = parsed.sourceChoice ?? null;
    if (!isToolSourceChoice(sourceChoice)) {
      return null;
    }
    if (parsed.followUpIntent !== undefined && !isToolFollowUpIntent(parsed.followUpIntent)) {
      return null;
    }
    const confidence = Number(parsed.confidence ?? 0);
    if (!Number.isFinite(confidence)) {
      return null;
    }

    return {
      action: parsed.action,
      taskFamily: parsed.taskFamily,
      sourceChoice,
      followUpIntent: parsed.followUpIntent,
      confidence,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
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
        maxTokens: 220,
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
      max_tokens: 220,
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

function createRemoteApiSlmClassifier(): SlmClassifier {
  return {
    backendKind: "remote-api",
    async classify(input: SlmClassificationInput): Promise<SlmTaskDecision | null> {
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

      return parseSlmClassifierResponse(text);
    },
  };
}

async function loadClassifierBackend(kind: SlmBackendKind): Promise<SlmClassifier> {
  if (kind === "mock-local") {
    return createMockLocalSlmClassifier();
  }
  return createRemoteApiSlmClassifier();
}

export function createDefaultSlmClassifier(kind = resolveSlmBackendKind()): SlmClassifier {
  let backendPromise: Promise<SlmClassifier> | null = null;

  return {
    backendKind: kind,
    async classify(input: SlmClassificationInput): Promise<SlmTaskDecision | null> {
      backendPromise ??= loadClassifierBackend(kind);
      const backend = await backendPromise;
      const decision = await backend.classify(input);
      if (!decision) {
        return null;
      }
      return {
        ...decision,
        slmBackend: backend.backendKind,
      };
    },
  };
}
