import { describe, it, expect } from "vitest";
import {
  buildRuntimeSessionId,
  resolveCrisPrefix,
  resolveBedrockModel,
  resolveProviderConfig,
  BEDROCK_DEFAULT_MODEL,
} from "../src/provider-config.js";

describe("resolveCrisPrefix", () => {
  it("returns 'eu' for eu-central-1", () => {
    expect(resolveCrisPrefix("eu-central-1")).toBe("eu");
  });

  it("returns 'eu' for eu-west-1", () => {
    expect(resolveCrisPrefix("eu-west-1")).toBe("eu");
  });

  it("returns 'eu' for eu-west-2", () => {
    expect(resolveCrisPrefix("eu-west-2")).toBe("eu");
  });

  it("returns 'eu' for eu-north-1", () => {
    expect(resolveCrisPrefix("eu-north-1")).toBe("eu");
  });

  it("returns 'us' for us-east-1", () => {
    expect(resolveCrisPrefix("us-east-1")).toBe("us");
  });

  it("returns 'us' for us-west-2", () => {
    expect(resolveCrisPrefix("us-west-2")).toBe("us");
  });

  it("returns 'us' for ca-central-1", () => {
    expect(resolveCrisPrefix("ca-central-1")).toBe("us");
  });

  it("returns 'apac' for ap-northeast-1", () => {
    expect(resolveCrisPrefix("ap-northeast-1")).toBe("apac");
  });

  it("returns 'apac' for ap-southeast-2", () => {
    expect(resolveCrisPrefix("ap-southeast-2")).toBe("apac");
  });

  it("returns 'apac' for ap-south-1", () => {
    expect(resolveCrisPrefix("ap-south-1")).toBe("apac");
  });

  it("returns undefined for unknown region", () => {
    expect(resolveCrisPrefix("sa-east-1")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(resolveCrisPrefix(undefined)).toBeUndefined();
  });
});

describe("resolveBedrockModel", () => {
  it("returns the safe default model for eu-central-1", () => {
    expect(resolveBedrockModel("eu-central-1")).toBe(BEDROCK_DEFAULT_MODEL);
  });

  it("returns the safe default model for us-east-1", () => {
    expect(resolveBedrockModel("us-east-1")).toBe(BEDROCK_DEFAULT_MODEL);
  });

  it("returns the safe default model for ap-northeast-1", () => {
    expect(resolveBedrockModel("ap-northeast-1")).toBe(BEDROCK_DEFAULT_MODEL);
  });

  it("returns the safe default model for unknown region", () => {
    expect(resolveBedrockModel("sa-east-1")).toBe(BEDROCK_DEFAULT_MODEL);
  });

  it("returns the safe default model when region is undefined", () => {
    expect(resolveBedrockModel(undefined)).toBe(BEDROCK_DEFAULT_MODEL);
  });

  it("returns AI_MODEL override as-is regardless of region", () => {
    expect(resolveBedrockModel("eu-central-1", "my-custom-model")).toBe(
      "my-custom-model",
    );
  });

  it("returns AI_MODEL override even for unknown region", () => {
    expect(resolveBedrockModel("sa-east-1", "my-custom-model")).toBe(
      "my-custom-model",
    );
  });

  it("ignores empty string AI_MODEL and uses region resolution", () => {
    expect(resolveBedrockModel("eu-central-1", "")).toBe(BEDROCK_DEFAULT_MODEL);
  });
});

describe("resolveProviderConfig", () => {
  it("resolves bedrock model to the safe default without requiring AI_MODEL", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "eu-central-1",
    });
    expect(config.defaultModel).toBe(BEDROCK_DEFAULT_MODEL);
    expect(config.openclawProvider).toBe("amazon-bedrock");
    expect(config.openclawApi).toBe("bedrock-converse-stream");
    expect(config.capability).toBe("chat-only");
    expect(config.sessionNamespace).toBe("bedrock-chat");
    expect(config.secretContract.requiresAnthropicApiKey).toBe(false);
  });

  it("uses AI_MODEL override over region resolution for bedrock", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "eu-central-1",
      AI_MODEL: "custom-model-id",
    });
    expect(config.defaultModel).toBe("custom-model-id");
  });

  it("falls back to safe default model for bedrock with unknown region", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "bedrock",
      AWS_REGION: "sa-east-1",
    });
    expect(config.defaultModel).toBe(BEDROCK_DEFAULT_MODEL);
  });

  it("resolves anthropic defaults correctly", () => {
    const config = resolveProviderConfig({ AI_PROVIDER: "anthropic" });
    expect(config.openclawProvider).toBe("anthropic");
    expect(config.openclawApi).toBe("anthropic");
    expect(config.defaultModel).toBe("claude-sonnet-4-20250514");
    expect(config.capability).toBe("tool-enabled");
    expect(config.sessionNamespace).toBe("anthropic-tools");
    expect(config.readiness.toolRuntimeReady).toBe(true);
    expect(config.emailTokenBudget).toEqual({
      mode: "headers-first",
      maxMessages: 5,
      maxSnippetChars: 240,
      maxBodyChars: 1600,
      requireExplicitBodyAccess: true,
    });
  });

  it("applies AI_MODEL override for anthropic", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "anthropic",
      AI_MODEL: "claude-opus-4-20250514",
    });
    expect(config.defaultModel).toBe("claude-opus-4-20250514");
  });

  it("defaults to anthropic when AI_PROVIDER is not set", () => {
    const config = resolveProviderConfig({});
    expect(config.provider).toBe("anthropic");
  });

  it("does not expose bedrockDiscovery on the config object", () => {
    const config = resolveProviderConfig({ AI_PROVIDER: "bedrock" });
    expect(config).not.toHaveProperty("bedrockDiscovery");
  });

  it("builds runtime session ids with namespace and channel", () => {
    const config = resolveProviderConfig({ AI_PROVIDER: "bedrock" });
    expect(buildRuntimeSessionId(config, "telegram", "session-123")).toBe(
      "bedrock-chat:telegram:session-123",
    );
  });

  it("applies Gmail token budget overrides from env", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "anthropic",
      GMAIL_TOOL_MAX_MESSAGES: "3",
      GMAIL_TOOL_MAX_SNIPPET_CHARS: "120",
      GMAIL_TOOL_MAX_BODY_CHARS: "800",
      GMAIL_TOOL_REQUIRE_EXPLICIT_BODY: "false",
    });

    expect(config.emailTokenBudget).toEqual({
      mode: "headers-first",
      maxMessages: 3,
      maxSnippetChars: 120,
      maxBodyChars: 800,
      requireExplicitBodyAccess: false,
    });
  });
});
