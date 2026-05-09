import { describe, expect, it } from "vitest";

import { createDefaultSlmClassifier } from "../../src/slm/classifier.js";

describe("slm/planner-action-eval", () => {
  it.each([
    {
      name: "starts a new travel payment task",
      message: "일본 여행가는데 결제한 내역들 알려줘",
      active: false,
      expectedAction: "start_new_task",
      expectedFollowUpIntent: undefined,
    },
    {
      name: "refines the active payment task to Japan-related records",
      message: "일본관련된 것만 가져와야지",
      active: true,
      expectedAction: "refine_current_task",
      expectedFollowUpIntent: "refine_topic",
    },
    {
      name: "refines terse destination-only corrections",
      message: "일본 것만",
      active: true,
      expectedAction: "refine_current_task",
      expectedFollowUpIntent: "refine_topic",
    },
    {
      name: "reruns the active payment task for a different date range",
      message: "지난주로 다시 봐줘",
      active: true,
      expectedAction: "refine_current_task",
      expectedFollowUpIntent: "refine_date",
    },
    {
      name: "reruns coverage when the user says more records should exist",
      message: "결제 내역이 더 있을텐데",
      active: true,
      expectedAction: "rerun_current_task",
      expectedFollowUpIntent: "coverage_check",
    },
    {
      name: "keeps issuer breakdown in the active payment task",
      message: "카드사별로 보여줘",
      active: true,
      expectedAction: "refine_current_task",
      expectedFollowUpIntent: "issuer_breakdown",
    },
    {
      name: "hands unrelated general questions back to chat",
      message: "리눅스에서 파일 찾는 명령어 알려줘",
      active: true,
      expectedAction: "switch_to_chat",
      expectedFollowUpIntent: undefined,
    },
    {
      name: "honors explicit general-chat handoff language",
      message: "그거 말고 일반 질문인데 저녁 메뉴 추천해줘",
      active: true,
      expectedAction: "switch_to_chat",
      expectedFollowUpIntent: undefined,
    },
    {
      name: "cancels the active task explicitly",
      message: "그만",
      active: true,
      expectedAction: "cancel_task",
      expectedFollowUpIntent: "cancel_task",
    },
  ])("$name", async ({ message, active, expectedAction, expectedFollowUpIntent }) => {
    const classifier = createDefaultSlmClassifier("mock-local");

    const decision = await classifier.classify({
      message,
      gmailReady: true,
      ...(active
        ? {
            activeTaskFamily: "gmail_payment_summary" as const,
            activeSourceChoice: "gmail" as const,
            activeCanonicalGoal: "이번주 결제한 금액이 어느정도 되려나?",
            activeLastSearchQuery: "결제 newer_than:7d",
            activeTopicKeywords: ["일본"],
            activeLastQueryMode: "topic_filtered_payment_summary",
            activePaymentRecordCount: 4,
            activeLastCandidateCount: 10,
            activeLastScanLimit: 50,
            recentResultSummary: "Gmail payment context with parsed payment records",
          }
        : {}),
    });

    expect(decision?.action).toBe(expectedAction);
    expect(decision?.taskFamily).toBe(
      expectedAction === "switch_to_chat" ? "generic_tool_task" : "gmail_payment_summary",
    );
    expect(decision?.sourceChoice).toBe(expectedAction === "switch_to_chat" ? "general" : "gmail");
    expect(decision?.followUpIntent).toBe(expectedFollowUpIntent);
  });
});
