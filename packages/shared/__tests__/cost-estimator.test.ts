import { describe, expect, it } from "vitest";
import {
  estimateAgentCoreCost,
  estimateCost,
  estimateLambdaCost,
  resolveBedrockTokenPricing,
} from "../src/index.js";

describe("cost-estimator", () => {
  it("should estimate Lambda arm64 duration cost", () => {
    const estimate = estimateLambdaCost(1000, 2048, "arm64");

    expect(estimate?.lambdaUsd).toBe(0.000026667);
    expect(estimate?.requestUsd).toBe(0.0000002);
  });

  it("should resolve default Bedrock token pricing by model id", () => {
    const pricing = resolveBedrockTokenPricing("global.anthropic.claude-haiku-4-5-20251001-v1:0");

    expect(pricing).toEqual({
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 5,
      source: "default",
    });
  });

  it("should combine Bedrock token and Lambda execution estimates", () => {
    const estimate = estimateCost({
      traceId: "trace-1",
      userId: "user-1",
      channel: "telegram",
      runtimeClass: "chat-only",
      provider: "lambda",
      model: "apac.amazon.nova-micro-v1:0",
      durationMs: 2000,
      memoryMb: 2048,
      architecture: "arm64",
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
      },
    });

    expect(estimate.estimatedUsd).toBe(0.000158534);
    expect(estimate.breakdown.bedrockUsd).toBe(0.000105);
    expect(estimate.breakdown.lambdaUsd).toBe(0.000053334);
    expect(estimate.confidence).toBe("high");
  });

  it("should estimate AgentCore active runtime consumption", () => {
    const runtimeCost = estimateAgentCoreCost(1200, 1, 2);

    expect(runtimeCost?.agentCoreUsd).toBe(0.000036133);

    const estimate = estimateCost({
      traceId: "trace-agentcore",
      userId: "user-1",
      channel: "telegram",
      runtimeClass: "tool-enabled",
      provider: "agentcore",
      durationMs: 1200,
      memoryMb: 2048,
      agentCoreVcpu: 1,
    });

    expect(estimate.estimatedUsd).toBe(0.000036133);
    expect(estimate.breakdown.agentCoreUsd).toBe(0.000036133);
    expect(estimate.confidence).toBe("partial");
  });

  it("should include upstream gateway cost in a runtime estimate", () => {
    const estimate = estimateCost({
      traceId: "trace-tool",
      userId: "user-1",
      channel: "telegram",
      runtimeClass: "tool-enabled",
      provider: "agentcore",
      durationMs: 1200,
      memoryMb: 2048,
      agentCoreVcpu: 1,
      upstreamCosts: [{
        name: "gateway-frontdoor",
        provider: "lambda",
        estimatedUsd: 0.000001234,
        confidence: "partial",
      }],
    });

    expect(estimate.estimatedUsd).toBe(0.000037367);
    expect(estimate.breakdown.agentCoreUsd).toBe(0.000036133);
    expect(estimate.breakdown.upstreamUsd).toBe(0.000001234);
    expect(estimate.upstreamCosts?.[0]).toEqual(
      expect.objectContaining({
        name: "gateway-frontdoor",
        provider: "lambda",
      }),
    );
    expect(estimate.confidence).toBe("partial");
  });
});
