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
  agentCoreVcpu?: number;
  architecture?: "arm64" | "x86_64";
  tokenUsage?: TokenUsage;
  bedrockInputUsdPerMillionOverride?: number;
  bedrockOutputUsdPerMillionOverride?: number;
  upstreamCosts?: UpstreamCostEstimate[];
}

export interface CostEstimateBreakdown {
  bedrockUsd?: number;
  lambdaUsd?: number;
  agentCoreUsd?: number;
  fargateUsd?: number;
  requestUsd?: number;
  upstreamUsd?: number;
}

export interface UpstreamCostEstimate {
  name: string;
  provider: CostRuntimeProvider;
  estimatedUsd: number;
  durationMs?: number;
  confidence?: CostEstimateConfidence;
  breakdown?: CostEstimateBreakdown;
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
  agentCoreVcpu?: number;
  architecture?: "arm64" | "x86_64";
  estimatedUsd: number;
  confidence: CostEstimateConfidence;
  breakdown: CostEstimateBreakdown;
  tokenUsage?: TokenUsage;
  upstreamCosts?: UpstreamCostEstimate[];
  pricing?: {
    bedrock?: BedrockTokenPricing;
    lambdaGbSecondUsd?: number;
    agentCoreVcpuHourUsd?: number;
    agentCoreGbHourUsd?: number;
  };
}

const LAMBDA_ARM_GB_SECOND_USD = 0.0000133334;
const LAMBDA_X86_GB_SECOND_USD = 0.0000166667;
const LAMBDA_REQUEST_USD = 0.20 / 1_000_000;
const AGENTCORE_VCPU_HOUR_USD = 0.0895;
const AGENTCORE_GB_HOUR_USD = 0.00945;

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

function sanitizeUpstreamCosts(
  upstreamCosts: UpstreamCostEstimate[] | undefined,
): UpstreamCostEstimate[] | undefined {
  const safe = upstreamCosts
    ?.filter((item) => item.name.trim().length > 0 && safeNumber(item.estimatedUsd) !== undefined)
    .map((item) => ({
      name: item.name,
      provider: item.provider,
      estimatedUsd: roundUsd(item.estimatedUsd),
      ...(safeNumber(item.durationMs) !== undefined ? { durationMs: item.durationMs } : {}),
      ...(item.confidence ? { confidence: item.confidence } : {}),
      ...(item.breakdown ? { breakdown: item.breakdown } : {}),
    }));

  return safe && safe.length > 0 ? safe : undefined;
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

export function estimateAgentCoreCost(
  durationMs: number,
  vcpu: number | undefined,
  memoryGb: number | undefined,
): { agentCoreUsd: number; agentCoreVcpuHourUsd: number; agentCoreGbHourUsd: number } | undefined {
  const safeDurationMs = safeNumber(durationMs);
  const safeVcpu = safeNumber(vcpu);
  const safeMemoryGb = safeNumber(memoryGb);
  if (
    safeDurationMs === undefined ||
    safeVcpu === undefined ||
    safeMemoryGb === undefined ||
    safeVcpu <= 0 ||
    safeMemoryGb <= 0
  ) {
    return undefined;
  }

  const hours = safeDurationMs / 1000 / 3600;
  return {
    agentCoreUsd: roundUsd(
      hours * safeVcpu * AGENTCORE_VCPU_HOUR_USD +
      hours * safeMemoryGb * AGENTCORE_GB_HOUR_USD,
    ),
    agentCoreVcpuHourUsd: AGENTCORE_VCPU_HOUR_USD,
    agentCoreGbHourUsd: AGENTCORE_GB_HOUR_USD,
  };
}

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const upstreamCosts = sanitizeUpstreamCosts(input.upstreamCosts);
  const upstreamUsd = upstreamCosts
    ? roundUsd(upstreamCosts.reduce((sum, item) => sum + item.estimatedUsd, 0))
    : undefined;
  const bedrockPricing = resolveBedrockTokenPricing(
    input.model,
    input.bedrockInputUsdPerMillionOverride,
    input.bedrockOutputUsdPerMillionOverride,
  );
  const bedrockUsd = estimateBedrockTokenCost(input.tokenUsage, bedrockPricing);
  const lambdaCost = input.provider === "lambda"
    ? estimateLambdaCost(input.durationMs, input.memoryMb, input.architecture)
    : undefined;
  const agentCoreCost = input.provider === "agentcore"
    ? estimateAgentCoreCost(
        input.durationMs,
        input.agentCoreVcpu,
        safeNumber(input.memoryMb) === undefined ? undefined : input.memoryMb! / 1024,
      )
    : undefined;

  const estimatedUsd = roundUsd(
    (bedrockUsd ?? 0) +
    (lambdaCost?.lambdaUsd ?? 0) +
    (agentCoreCost?.agentCoreUsd ?? 0) +
    (lambdaCost?.requestUsd ?? 0) +
    (upstreamUsd ?? 0),
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
    agentCoreVcpu: input.agentCoreVcpu,
    architecture: input.architecture,
    estimatedUsd,
    confidence: bedrockUsd !== undefined && upstreamCosts?.every((item) => item.confidence === "high")
      ? "high"
      : bedrockUsd !== undefined && !upstreamCosts
        ? "high"
        : "partial",
    breakdown: {
      bedrockUsd,
      lambdaUsd: lambdaCost?.lambdaUsd,
      agentCoreUsd: agentCoreCost?.agentCoreUsd,
      requestUsd: lambdaCost?.requestUsd,
      upstreamUsd,
    },
    tokenUsage: input.tokenUsage,
    upstreamCosts,
    pricing: {
      bedrock: bedrockPricing,
      lambdaGbSecondUsd: lambdaCost?.lambdaGbSecondUsd,
      agentCoreVcpuHourUsd: agentCoreCost?.agentCoreVcpuHourUsd,
      agentCoreGbHourUsd: agentCoreCost?.agentCoreGbHourUsd,
    },
  };
}
