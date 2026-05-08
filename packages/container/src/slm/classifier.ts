import { ConverseCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

import { isToolFollowUpIntent, isToolIntentAdvisorAction, isToolSourceChoice, isToolTaskFamily } from "./taxonomy.js";
import { createMockLocalSlmClassifier } from "./mock-local.js";
import type { SlmBackendKind, SlmClassificationInput, SlmClassifier, SlmTaskDecision } from "./types.js";

const MAX_CLASSIFIER_CHARS = 600;
export const SLM_ACCEPT_CONFIDENCE = 0.8;
export const SLM_FALLBACK_CONFIDENCE = 0.55;
export const SLM_SAFE_TRANSITION_CONFIDENCE = 0.65;
export const MIN_TOOL_INTENT_CONFIDENCE = SLM_ACCEPT_CONFIDENCE;
const TIMEOUT_MS = 3500;

export type SlmDecisionPolicy = "accept" | "clarify" | "fallback" | "reject";

export function evaluateSlmDecisionPolicy(decision: Pick<SlmTaskDecision, "action" | "confidence">): SlmDecisionPolicy {
  if (decision.confidence >= SLM_ACCEPT_CONFIDENCE) {
    return "accept";
  }
  if (
    decision.confidence >= SLM_SAFE_TRANSITION_CONFIDENCE &&
    ["switch_to_chat", "generic_openclaw", "cancel_task"].includes(decision.action)
  ) {
    return "accept";
  }
  if (decision.confidence < SLM_FALLBACK_CONFIDENCE) {
    return "reject";
  }
  return decision.action === "clarify_source" || decision.action === "clarify" ? "clarify" : "fallback";
}

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
    "Allowed action values: gmail, clarify_source, generic_openclaw, continue_active_task, start_new_task, continue_task, refine_current_task, rerun_current_task, switch_to_chat, answer_capability, clarify, cancel_task.",
    "Prefer planner-v1 actions over legacy actions: start_new_task, continue_task, refine_current_task, rerun_current_task, switch_to_chat, answer_capability, clarify, cancel_task.",
    "Allowed taskFamily values: gmail_payment_summary, gmail_search, gmail_body_selection, generic_tool_task.",
    "Allowed sourceChoice values: gmail, general, null.",
    "Optional followUpIntent values: continue_active_task, refine_topic, refine_date, issuer_breakdown, merchant_breakdown, amount_summary, coverage_check, open_body, cancel_task.",
    "If gmailReady is false, never choose gmail or any gmail-sourced start/continue/refine/rerun action.",
    "Prefer gmail for payment, receipt, statement, billing, or spending questions that likely need the user's own inbox history when gmailReady is true, even if the user did not explicitly mention Gmail.",
    "If gmailReady is true, do not answer that you cannot access payment history. Route ambiguous personal spending questions to gmail_payment_summary or clarify_source instead.",
    "Korean compact examples like \"이번주는 얼마\", \"이번달은 얼마야\", and \"최근 얼마나 썼지\" usually mean personal spending lookup; choose gmail_payment_summary when gmailReady is true.",
    "When the message asks for payment histories, spending totals, card issuer breakdowns, merchant breakdowns, or trip-related expenses, choose taskFamily gmail_payment_summary rather than gmail_search.",
    "Choose answer_capability when the user asks whether the assistant can check Gmail, payment history, card spending, receipts, or statements, without asking to perform a concrete lookup yet.",
    "Choose switch_to_chat when an active tool context exists but the user clearly moved to unrelated general chat.",
    "For active-context questions about programming, Linux commands, translation, weather, jokes, recommendations, or general explanations that do not ask for Gmail/payment data, choose switch_to_chat with confidence at least 0.9.",
    "Choose start_new_task when an active context exists but the user is clearly asking for a new lookup topic or period.",
    "Choose continue_task when the message continues the active task without changing scope.",
    "Choose refine_current_task when the user corrects, narrows, groups, or filters the active task.",
    "Choose rerun_current_task when the user asks for more coverage or to search again inside the same task.",
    "Choose clarify only when both Gmail lookup and general reasoning are plausible and you cannot safely choose one source.",
    "Example: active payment context + \"리눅스에서 파일 찾는 명령어 알려줘\" => {\"action\":\"switch_to_chat\",\"taskFamily\":\"generic_tool_task\",\"sourceChoice\":\"general\",\"confidence\":0.95}.",
    "Example: \"결제 이력 확인할 수 있어?\" => {\"action\":\"answer_capability\",\"taskFamily\":\"gmail_payment_summary\",\"sourceChoice\":\"gmail\",\"confidence\":0.95}.",
    "Example: active payment context + \"일본관련된 것만 가져와야지\" => {\"action\":\"refine_current_task\",\"taskFamily\":\"gmail_payment_summary\",\"sourceChoice\":\"gmail\",\"followUpIntent\":\"refine_topic\",\"confidence\":0.95}.",
    "Example: active payment context + \"카드사별로 보여줘\" => {\"action\":\"refine_current_task\",\"taskFamily\":\"gmail_payment_summary\",\"sourceChoice\":\"gmail\",\"followUpIntent\":\"issuer_breakdown\",\"confidence\":0.95}.",
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
