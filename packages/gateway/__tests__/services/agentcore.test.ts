import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgentCoreRuntimeSessionId,
  invokeAgentCoreRuntime,
} from "../../src/services/agentcore.js";

const ORIGINAL_ENV = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  AWS_REGION: process.env.AWS_REGION,
};

describe("agentcore service", () => {
  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("builds stable AgentCore session ids from user, channel, and logical session", () => {
    const first = buildAgentCoreRuntimeSessionId({
      userId: "user-123",
      channel: "telegram",
      sessionId: "session-user-123",
    });
    const second = buildAgentCoreRuntimeSessionId({
      userId: "user-123",
      channel: "telegram",
      sessionId: "session-user-123",
    });

    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(33);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9-_]*$/);
  });

  it("separates sessions by channel", () => {
    const web = buildAgentCoreRuntimeSessionId({
      userId: "user-123",
      channel: "web",
      sessionId: "session-user-123",
    });
    const telegram = buildAgentCoreRuntimeSessionId({
      userId: "user-123",
      channel: "telegram",
      sessionId: "session-user-123",
    });

    expect(web).not.toBe(telegram);
  });

  it("signs invoke requests with the same required headers as the official AgentCore CLI", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    delete process.env.AWS_SESSION_TOKEN;
    process.env.AWS_REGION = "ap-northeast-2";

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const result = await invokeAgentCoreRuntime({
      runtimeArn:
        "arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/ServerlessOpenClawToolRuntime-test",
      userId: "user-123",
      sessionId: "session-user-123",
      message: "ping",
      channel: "telegram",
      connectionId: "telegram:123",
      callbackUrl: "",
      runtimeClass: "tool-enabled",
      now: new Date("2026-04-26T05:03:44Z"),
      fetchFn: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ content: "ok" }));
      },
    });

    expect(result.content).toBe("ok");
    expect(capturedUrl).toBe(
      "https://bedrock-agentcore.ap-northeast-2.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aap-northeast-2%3A123456789012%3Aruntime%2FServerlessOpenClawToolRuntime-test/invocations",
    );
    expect(capturedHeaders["x-amz-content-sha256"]).toBeUndefined();
    expect(capturedHeaders["x-amzn-bedrock-agentcore-runtime-session-id"]).toMatch(/^soc-/);
    expect(capturedHeaders.Authorization).toContain(
      "SignedHeaders=accept;content-type;host;x-amz-date;x-amzn-bedrock-agentcore-runtime-session-id",
    );
  });
});
