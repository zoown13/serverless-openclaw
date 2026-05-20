import { describe, expect, it } from "vitest";

import {
  createDefaultSlmClassifier,
  evaluateSlmDecisionPolicy,
  parseSlmClassifierResponse,
  resolveSlmBackendKind,
} from "../../src/slm/classifier.js";

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

  it("accepts high-confidence SLM decisions", () => {
    expect(
      evaluateSlmDecisionPolicy({
        action: "gmail",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.8,
      }),
    ).toBe("accept");
  });

  it("allows mid-confidence clarification but falls back for source choices", () => {
    expect(
      evaluateSlmDecisionPolicy({
        action: "clarify_source",
        taskFamily: "gmail_payment_summary",
        sourceChoice: null,
        confidence: 0.7,
      }),
    ).toBe("clarify");

    expect(
      evaluateSlmDecisionPolicy({
        action: "gmail",
        taskFamily: "gmail_payment_summary",
        sourceChoice: "gmail",
        confidence: 0.7,
      }),
    ).toBe("fallback");

    expect(
      evaluateSlmDecisionPolicy({
        action: "switch_to_chat",
        taskFamily: "generic_tool_task",
        sourceChoice: "general",
        confidence: 0.7,
      }),
    ).toBe("accept");
  });

  it("rejects very low-confidence SLM decisions", () => {
    expect(
      evaluateSlmDecisionPolicy({
        action: "generic_openclaw",
        taskFamily: "generic_tool_task",
        sourceChoice: "general",
        confidence: 0.54,
      }),
    ).toBe("reject");
  });

  it("defaults to the remote-api backend unless mock-local is explicitly requested", () => {
    expect(resolveSlmBackendKind(undefined)).toBe("remote-api");
    expect(resolveSlmBackendKind("remote-api")).toBe("remote-api");
    expect(resolveSlmBackendKind("mock-local")).toBe("mock-local");
  });

  it("classifies travel spend requests through the mock-local backend", async () => {
    const classifier = createDefaultSlmClassifier("mock-local");

    const decision = await classifier.classify({
      message: "4월 18일부터 일본 여행 관련 쓴 돈 정리해줘",
      gmailReady: true,
    });

    expect(decision).toEqual({
      action: "start_new_task",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.9,
      slmBackend: "mock-local",
      reason: "mock-local payment summary",
    });
  });

  it("parses valid structured JSON for capability answers", () => {
    const parsed = parseSlmClassifierResponse(
      '{"action":"answer_capability","taskFamily":"gmail_payment_summary","sourceChoice":"gmail","confidence":0.95,"reason":"capability question"}',
    );

    expect(parsed).toEqual({
      action: "answer_capability",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.95,
      reason: "capability question",
    });
  });

  it("classifies payment history wording through the mock-local backend", async () => {
    const classifier = createDefaultSlmClassifier("mock-local");

    const decision = await classifier.classify({
      message: "결제 이력 확인해줘",
      gmailReady: true,
    });

    expect(decision).toEqual({
      action: "start_new_task",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.9,
      slmBackend: "mock-local",
      reason: "mock-local payment summary",
    });
  });

  it("classifies capability questions through the mock-local backend", async () => {
    const classifier = createDefaultSlmClassifier("mock-local");

    const decision = await classifier.classify({
      message: "결제 이력 확인할 수 있어?",
      gmailReady: true,
    });

    expect(decision).toEqual({
      action: "answer_capability",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      confidence: 0.95,
      slmBackend: "mock-local",
      reason: "mock-local capability check",
    });
  });

  it("keeps active payment follow-ups inside the specialized task through the mock-local backend", async () => {
    const classifier = createDefaultSlmClassifier("mock-local");

    const decision = await classifier.classify({
      message: "카드사별로 보여줘",
      gmailReady: true,
      activeTaskFamily: "gmail_payment_summary",
      activeSourceChoice: "gmail",
    });

    expect(decision).toEqual({
      action: "refine_current_task",
      taskFamily: "gmail_payment_summary",
      sourceChoice: "gmail",
      followUpIntent: "issuer_breakdown",
      confidence: 0.96,
      slmBackend: "mock-local",
      reason: "mock-local issuer breakdown",
    });
  });
});
