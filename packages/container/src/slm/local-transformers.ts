import type { SlmClassificationInput, SlmClassifier, SlmTaskDecision } from "./types.js";

const DEFAULT_MODEL = "Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7";
const DEFAULT_DTYPE = "q8";
const DEFAULT_CACHE_DIR = "/tmp/openclaw-slm-cache";
const DEFAULT_LOAD_TIMEOUT_MS = 12_000;
const DEFAULT_INFERENCE_TIMEOUT_MS = 3_500;

type ZeroShotResult = {
  labels?: string[];
  scores?: number[];
};

type ZeroShotPipeline = (
  text: string,
  labels: string[],
  options?: Record<string, unknown>,
) => Promise<ZeroShotResult | ZeroShotResult[]>;

interface LabelDecision {
  label: string;
  score: number;
}

const FRESH_LABELS = [
  "lookup personal payment records in Gmail",
  "search Gmail messages",
  "ask the user to choose between Gmail and general answer",
  "answer as general OpenClaw chat",
];

const ACTIVE_LABELS = [
  "filter active payment context by destination or topic",
  "show card issuer breakdown",
  "show merchant breakdown",
  "summarize the total amount",
  "check whether more payment records exist",
  "open one selected Gmail message body",
  "cancel the active task",
  "continue the active task",
  "answer as general OpenClaw chat",
];

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race<T | null>([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

function normalizeResult(result: ZeroShotResult | ZeroShotResult[]): LabelDecision | null {
  const first = Array.isArray(result) ? result[0] : result;
  const labels = first?.labels ?? [];
  const scores = first?.scores ?? [];
  if (labels.length === 0 || scores.length === 0) {
    return null;
  }

  let bestIndex = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if ((scores[index] ?? 0) > (scores[bestIndex] ?? 0)) {
      bestIndex = index;
    }
  }

  const label = labels[bestIndex];
  const score = scores[bestIndex];
  if (!label || !Number.isFinite(score)) {
    return null;
  }

  return { label, score };
}

function configureTransformersEnv(env: unknown): void {
  const config = env as {
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
    cacheDir?: string;
    localModelPath?: string;
    useFSCache?: boolean;
  };
  config.useFSCache = true;
  config.cacheDir = process.env.TOOL_SLM_CACHE_DIR ?? DEFAULT_CACHE_DIR;
  config.allowRemoteModels = process.env.TOOL_SLM_ALLOW_REMOTE !== "false";

  if (process.env.TOOL_SLM_LOCAL_MODEL_PATH) {
    config.allowLocalModels = true;
    config.localModelPath = process.env.TOOL_SLM_LOCAL_MODEL_PATH;
  }
}

async function loadZeroShotPipeline(): Promise<ZeroShotPipeline | null> {
  try {
    const transformers = await import("@huggingface/transformers");
    configureTransformersEnv(transformers.env);
    const model = process.env.TOOL_SLM_LOCAL_MODEL ?? DEFAULT_MODEL;
    const dtype = process.env.TOOL_SLM_LOCAL_DTYPE ?? DEFAULT_DTYPE;
    const pipeline = transformers.pipeline as unknown as (
      task: string,
      model: string,
      options: Record<string, unknown>,
    ) => Promise<ZeroShotPipeline>;
    return await pipeline("zero-shot-classification", model, {
      dtype,
    });
  } catch {
    return null;
  }
}

function buildSequence(input: SlmClassificationInput): string {
  return [
    `message: ${input.message}`,
    `gmailReady: ${input.gmailReady}`,
    input.activeTaskFamily ? `activeTaskFamily: ${input.activeTaskFamily}` : undefined,
    input.activeSourceChoice ? `activeSourceChoice: ${input.activeSourceChoice}` : undefined,
    input.activeCanonicalGoal ? `activeGoal: ${input.activeCanonicalGoal}` : undefined,
    input.recentResultSummary ? `recentResultSummary: ${input.recentResultSummary}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function mapFreshDecision(
  input: SlmClassificationInput,
  decision: LabelDecision,
): SlmTaskDecision | null {
  if (decision.label === "lookup personal payment records in Gmail") {
    if (!input.gmailReady) {
      return {
        action: "generic_openclaw",
        taskFamily: "generic_tool_task",
        sourceChoice: "general",
        confidence: Math.min(decision.score, 0.54),
        reason: "local-transformers payment lookup without gmail",
      };
    }
    return {
      action: "gmail",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: decision.score,
      reason: "local-transformers payment summary",
    };
  }

  if (decision.label === "search Gmail messages") {
    if (!input.gmailReady) {
      return null;
    }
    return {
      action: "gmail",
      taskFamily: "gmail_search",
      sourceChoice: "gmail",
      confidence: decision.score,
      reason: "local-transformers gmail search",
    };
  }

  if (decision.label === "ask the user to choose between Gmail and general answer") {
    return {
      action: "clarify_source",
      taskFamily: "gmail_payment_summary",
      sourceChoice: null,
      confidence: decision.score,
      reason: "local-transformers clarify source",
    };
  }

  return {
    action: "generic_openclaw",
    taskFamily: "generic_tool_task",
    sourceChoice: "general",
    confidence: decision.score,
    reason: "local-transformers generic openclaw",
  };
}

function mapActiveDecision(
  input: SlmClassificationInput,
  decision: LabelDecision,
): SlmTaskDecision | null {
  const taskFamily = input.activeTaskFamily;
  if (!taskFamily) {
    return null;
  }
  const sourceChoice = input.gmailReady ? input.activeSourceChoice ?? "gmail" : "general";

  if (decision.label === "answer as general OpenClaw chat") {
    return {
      action: "generic_openclaw",
      taskFamily: "generic_tool_task",
      sourceChoice: "general",
      confidence: decision.score,
      reason: "local-transformers active topic switch",
    };
  }

  const followUpIntent =
    decision.label === "filter active payment context by destination or topic"
      ? "refine_topic"
      : decision.label === "show card issuer breakdown"
        ? "issuer_breakdown"
        : decision.label === "show merchant breakdown"
          ? "merchant_breakdown"
          : decision.label === "summarize the total amount"
            ? "amount_summary"
            : decision.label === "check whether more payment records exist"
              ? "coverage_check"
              : decision.label === "open one selected Gmail message body"
                ? "open_body"
                : decision.label === "cancel the active task"
                  ? "cancel_task"
                  : "continue_active_task";

  return {
    action: "continue_active_task",
    taskFamily,
    sourceChoice,
    followUpIntent,
    confidence: decision.score,
    reason: `local-transformers ${followUpIntent}`,
  };
}

export function createLocalTransformersSlmClassifier(): SlmClassifier {
  let pipelinePromise: Promise<ZeroShotPipeline | null> | null = null;

  return {
    backendKind: "local-transformers",
    async classify(input: SlmClassificationInput): Promise<SlmTaskDecision | null> {
      pipelinePromise ??= loadZeroShotPipeline();
      const pipe = await withTimeout(
        pipelinePromise,
        numberFromEnv("TOOL_SLM_LOCAL_LOAD_TIMEOUT_MS", DEFAULT_LOAD_TIMEOUT_MS),
      );
      if (!pipe) {
        return null;
      }

      const labels = input.activeTaskFamily ? ACTIVE_LABELS : FRESH_LABELS;
      const result = await withTimeout(
        pipe(buildSequence(input), labels, {
          multi_label: false,
          hypothesis_template: "The user wants to {}.",
        }),
        numberFromEnv("TOOL_SLM_LOCAL_INFERENCE_TIMEOUT_MS", DEFAULT_INFERENCE_TIMEOUT_MS),
      );
      if (!result) {
        return null;
      }

      const decision = normalizeResult(result);
      if (!decision) {
        return null;
      }

      return input.activeTaskFamily
        ? mapActiveDecision(input, decision)
        : mapFreshDecision(input, decision);
    },
  };
}
