import { describe, expect, it } from "vitest";
import { buildAgentCoreRuntimeSessionId } from "../../src/services/agentcore.js";

describe("agentcore service", () => {
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
});
