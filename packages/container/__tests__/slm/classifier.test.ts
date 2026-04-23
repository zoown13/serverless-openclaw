import { describe, expect, it } from "vitest";

import { parseSlmClassifierResponse } from "../../src/slm/classifier.js";

describe("slm/classifier", () => {
  it("parses valid structured JSON with an optional follow-up intent", () => {
    const parsed = parseSlmClassifierResponse(
      '{"action":"continue_active_task","taskFamily":"gmail_payment_summary","sourceChoice":"gmail","followUpIntent":"issuer_breakdown","confidence":0.91,"reason":"active payment context"}',
    );

    expect(parsed).toEqual({
      action: "continue_active_task",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      followUpIntent: "issuer_breakdown",
      confidence: 0.91,
      reason: "active payment context",
    });
  });

  it("rejects values outside the closed follow-up taxonomy", () => {
    expect(
      parseSlmClassifierResponse(
        '{"action":"continue_active_task","taskFamily":"gmail_payment_summary","sourceChoice":"gmail","followUpIntent":"invent_new_intent","confidence":0.91}',
      ),
    ).toBeNull();
  });
});
