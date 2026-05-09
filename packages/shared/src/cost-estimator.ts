import type { Channel, RuntimeClass } from "./types.js";

export type CostRuntimeProvider = "lambda" | "agentcore" | "fargate";
export type CostEstimateConfidence = "high" | "partial";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface BedrockTokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: "default" | "env";
}

export interface CostEstimateInput {
  traceId: string;
  userId: string;
  channel: Channel;
  runtimeClass: RuntimeClass;
  provider: CostRuntimeProvider;
  model?: string;
  durationMs: number;
  memoryMb?: number;
  architecture?: "arm64" | "x86_64";
  tokenUsage?: TokenUsage;
  bedrockInputUsdPerMillionOverride?: number;
  bedrockOutputUsdPerMillionOverride?: number;
}

export interface CostEstimate {
  traceId: string;
  userId: string;
  channel: Channel;
  runtimeClass: RuntimeClass;
  provider: CostRuntimeProvider;
  model?: string;
  durationMs: number;
  memoryMb?: number;
  architecture?: "arm64" | "x86_64";
  estimatedUsd: number;
  confidence: CostEstimateConfidence;
  breakdown: {
    bedrockUsd?: number;
    lambdaUsd?: number;
    requestUsd?: number;
  };
  tokenUsage?: TokenUsage;
  pricing?: {
    bedrock?: BedrockTokenPricing;
    lambdaGbSecondUsd?: number;
  };
}

const LAMBDA_ARM_GB_SECOND_USD = 0.0000133334;
const LAMBDA_X86_GB_SECOND_USD = 0.0000166667;
const LAMBDA_REQUEST_USD = 0.20 / 1_000_000;

const DEFAULT_BEDROCK_PRICING: Array<{
  pattern: RegExp;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}> = [
  {
    pattern: /amazon\.nova-micro/i,
    inputUsdPerMillion: 0.035,
    outputUsdPerMillion: 0.14,
  },
  {
    pattern: /anthropic\.claude-haiku-4-5/i,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
  },
  {
    pattern: /anthropic\.claude-sonnet-4/i,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
  },
];

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function safeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resolveBedrockTokenPricing(
  model: string | undefined,
  inputOverride?: number,
  outputOverride?: number,
): BedrockTokenPricing | undefined {
  const safeInputOverride = safeNumber(inputOverride);
  const safeOutputOverride = safeNumber(outputOverride);
  if (safeInputOverride !== undefined && safeOutputOverride !== undefined) {
    return {
      inputUsdPerMillion: safeInputOverride,
      outputUsdPerMillion: safeOutputOverride,
      source: "env",
    };
  }

  if (!model) return undefined;
  const matched = DEFAULT_BEDROCK_PRICING.find((item) => item.pattern.test(model));
  if (!matched) return undefined;

  return {
    inputUsdPerMillion: matched.inputUsdPerMillion,
    outputUsdPerMillion: matched.outputUsdPerMillion,
    source: "default",
  };
}

export function estimateBedrockTokenCost(
  tokenUsage: TokenUsage | undefined,
  pricing: BedrockTokenPricing | undefined,
): number | undefined {
  const inputTokens = safeNumber(tokenUsage?.inputTokens);
  const outputTokens = safeNumber(tokenUsage?.outputTokens);
  if (!pricing || (inputTokens === undefined && outputTokens === undefined)) {
    return undefined;
  }

  return roundUsd(
    ((inputTokens ?? 0) / 1_000_000) * pricing.inputUsdPerMillion +
    ((outputTokens ?? 0) / 1_000_000) * pricing.outputUsdPerMillion,
  );
}

export function estimateLambdaCost(
  durationMs: number,
  memoryMb: number | undefined,
  architecture: "arm64" | "x86_64" = "arm64",
): { lambdaUsd: number; requestUsd: number; lambdaGbSecondUsd: number } | undefined {
  const safeDurationMs = safeNumber(durationMs);
  const safeMemoryMb = safeNumber(memoryMb);
  if (safeDurationMs === undefined || safeMemoryMb === undefined || safeMemoryMb <= 0) {
    return undefined;
  }

  const lambdaGbSecondUsd = architecture === "x86_64"
    ? LAMBDA_X86_GB_SECOND_USD
    : LAMBDA_ARM_GB_SECOND_USD;
  const gbSeconds = (safeDurationMs / 1000) * (safeMemoryMb / 1024);
  return {
    lambdaUsd: roundUsd(gbSeconds * lambdaGbSecondUsd),
    requestUsd: roundUsd(LAMBDA_REQUEST_USD),
    lambdaGbSecondUsd,
  };
}

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const bedrockPricing = resolveBedrockTokenPricing(
    input.model,
    input.bedrockInputUsdPerMillionOverride,
    input.bedrockOutputUsdPerMillionOverride,
  );
  const bedrockUsd = estimateBedrockTokenCost(input.tokenUsage, bedrockPricing);
  const lambdaCost = input.provider === "lambda"
    ? estimateLambdaCost(input.durationMs, input.memoryMb, input.architecture)
    : undefined;

  const estimatedUsd = roundUsd(
    (bedrockUsd ?? 0) +
    (lambdaCost?.lambdaUsd ?? 0) +
    (lambdaCost?.requestUsd ?? 0),
  );

  return {
    traceId: input.traceId,
    userId: input.userId,
    channel: input.channel,
    runtimeClass: input.runtimeClass,
    provider: input.provider,
    model: input.model,
    durationMs: input.durationMs,
    memoryMb: input.memoryMb,
    architecture: input.architecture,
    estimatedUsd,
    confidence: bedrockUsd !== undefined ? "high" : "partial",
    breakdown: {
      bedrockUsd,
      lambdaUsd: lambdaCost?.lambdaUsd,
      requestUsd: lambdaCost?.requestUsd,
    },
    tokenUsage: input.tokenUsage,
    pricing: {
      bedrock: bedrockPricing,
      lambdaGbSecondUsd: lambdaCost?.lambdaGbSecondUsd,
    },
  };
}
