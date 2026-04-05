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
});
