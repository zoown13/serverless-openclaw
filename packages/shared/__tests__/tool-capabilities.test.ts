import { describe, expect, it } from "vitest";
import { buildAssistantToolCapabilities } from "../src/tool-capabilities.js";

describe("tool capability registry", () => {
  it("marks Gmail capabilities available when Gmail is ready", () => {
    const capabilities = buildAssistantToolCapabilities({
      toolRuntimeProvider: "agentcore",
      gmailAvailable: true,
    });

    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gmail_payment",
          status: "available",
          executionRuntime: "agentcore",
          readOnly: true,
        }),
      ]),
    );
  });

  it("keeps AWS cost lookup planned until the handler and IAM are enabled", () => {
    const capabilities = buildAssistantToolCapabilities({
      toolRuntimeProvider: "agentcore",
      gmailAvailable: true,
    });

    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "aws_cost_lookup",
          status: "planned",
          dataSensitivity: "account_private",
          readOnly: true,
        }),
      ]),
    );
  });

  it("can expose AWS cost lookup as available when explicitly enabled", () => {
    const capabilities = buildAssistantToolCapabilities({
      toolRuntimeProvider: "agentcore",
      gmailAvailable: true,
      awsCostLookupAvailable: true,
    });

    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "aws_cost_lookup",
          status: "available",
          executionRuntime: "agentcore",
        }),
      ]),
    );
  });
});
