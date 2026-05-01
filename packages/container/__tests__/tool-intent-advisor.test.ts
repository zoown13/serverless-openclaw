import { describe, expect, it } from "vitest";

import { parseToolIntentAdvisorResponse } from "../src/tool-intent-advisor.js";

describe("tool-intent-advisor", () => {
  it("parses valid structured JSON", () => {
    const parsed = parseToolIntentAdvisorResponse(
      '{"action":"gmail","taskFamily":"gmail_payment_summary","sourceChoice":"gmail","confidence":0.93}',
    );

    expect(parsed).toEqual({
      action: "gmail",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.93,
    });
  });

  it("rejects malformed JSON", () => {
    expect(parseToolIntentAdvisorResponse("not-json")).toBeNull();
  });

  it("rejects values outside the closed taxonomy", () => {
    expect(
      parseToolIntentAdvisorResponse(
        '{"action":"bank_app","taskFamily":"gmail_payment_summary","sourceChoice":"gmail","confidence":0.93}',
      ),
    ).toBeNull();
  });

  it("parses planner-v1 task control actions and follow-up intents", () => {
    const parsed = parseToolIntentAdvisorResponse(
      '{"action":"refine_current_task","taskFamily":"gmail_payment_summary","sourceChoice":"gmail","followUpIntent":"issuer_breakdown","confidence":0.91,"reason":"grouping active payment task"}',
    );

    expect(parsed).toEqual({
      action: "refine_current_task",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      followUpIntent: "issuer_breakdown",
      confidence: 0.91,
      reason: "grouping active payment task",
    });
  });

  it("parses planner-v1 chat handoff actions", () => {
    const parsed = parseToolIntentAdvisorResponse(
      '{"action":"switch_to_chat","taskFamily":"generic_tool_task","sourceChoice":"general","confidence":0.88}',
    );

    expect(parsed).toEqual({
      action: "switch_to_chat",
      taskFamily: "generic_tool_task",
      sourceChoice: "general",
      confidence: 0.88,
    });
  });
});
