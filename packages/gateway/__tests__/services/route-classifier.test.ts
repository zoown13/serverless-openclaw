import { describe, it, expect } from "vitest";
import {
  classifyRoute,
  classifyRouteRuntimeClass,
  getRouteClassificationSignals,
  stripRouteHint,
} from "../../src/services/route-classifier.js";
import type { TaskStateItem } from "@serverless-openclaw/shared";

const runningTask: TaskStateItem = {
  PK: "USER#user-123",
  taskArn: "arn:task",
  status: "Running",
  publicIp: "1.2.3.4",
  startedAt: "2024-01-01T00:00:00Z",
  lastActivity: "2024-01-01T00:00:00Z",
};

describe("classifyRoute", () => {
  it("returns 'lambda' for normal chat even when taskState is Running with publicIp", () => {
    const result = classifyRoute({ message: "hello", taskState: runningTask });
    expect(result).toBe("lambda");
  });

  it("returns 'lambda' when taskState is Running WITHOUT publicIp", () => {
    const taskWithoutIp: TaskStateItem = { ...runningTask, publicIp: undefined };
    const result = classifyRoute({ message: "hello", taskState: taskWithoutIp });
    expect(result).toBe("lambda");
  });

  it("returns 'lambda' when taskState is null", () => {
    const result = classifyRoute({ message: "hello", taskState: null });
    expect(result).toBe("lambda");
  });

  it("returns 'lambda' when taskState is Starting", () => {
    const startingTask: TaskStateItem = {
      PK: "USER#user-123",
      taskArn: "arn:task",
      status: "Starting",
      startedAt: "2024-01-01T00:00:00Z",
      lastActivity: "2024-01-01T00:00:00Z",
    };
    const result = classifyRoute({ message: "hello", taskState: startingTask });
    expect(result).toBe("lambda");
  });

  it("returns 'fargate-reuse' for tool-heavy requests when taskState is Running", () => {
    const result = classifyRoute({
      message: "check my gmail inbox",
      taskState: runningTask,
    });
    expect(result).toBe("fargate-reuse");
  });

  it("returns 'fargate-new' when message starts with '/heavy'", () => {
    const result = classifyRoute({ message: "/heavy do something", taskState: null });
    expect(result).toBe("fargate-new");
  });

  it("returns 'fargate-new' when message starts with '/fargate'", () => {
    const result = classifyRoute({ message: "/fargate run this", taskState: null });
    expect(result).toBe("fargate-new");
  });

  it("returns 'fargate-new' when message has leading spaces before '/heavy'", () => {
    const result = classifyRoute({ message: "   /heavy compute", taskState: null });
    expect(result).toBe("fargate-new");
  });

  it("returns 'lambda' for normal messages", () => {
    const result = classifyRoute({ message: "what is the weather?", taskState: null });
    expect(result).toBe("lambda");
  });

  it("returns 'fargate-new' for Gmail requests", () => {
    const result = classifyRoute({
      message: "please summarize my latest emails",
      taskState: null,
    });
    expect(result).toBe("fargate-new");
  });

  it("returns 'fargate-new' for Korean Gmail access requests", () => {
    const result = classifyRoute({
      message: "지메일에 접근해서 읽지 않은 메일 5개 요약해줘",
      taskState: null,
    });
    expect(result).toBe("fargate-new");
  });
});

describe("classifyRouteRuntimeClass", () => {
  it("classifies normal chat as chat-only", () => {
    expect(classifyRouteRuntimeClass("hello there")).toBe("chat-only");
  });

  it("classifies general file command how-to questions as chat-only", () => {
    expect(classifyRouteRuntimeClass("리눅스에서 파일 찾는 명령어 알려줘")).toBe(
      "chat-only",
    );
  });

  it("classifies /heavy hint as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("/heavy analyze this")).toBe("tool-enabled");
  });

  it("classifies browser requests as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("browse this website and summarize it")).toBe("tool-enabled");
  });

  it("classifies Korean Gmail access requests as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("내 Gmail 받은편지함 확인해줘")).toBe("tool-enabled");
  });

  it("classifies short Korean Gmail confirmation replies as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("지메일에서 확인해줘.")).toBe("tool-enabled");
  });

  it("classifies Korean Gmail body selection requests as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("1번 메일 자세히 보여줘")).toBe("tool-enabled");
  });

  it("classifies explicit Korean Gmail search requests as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("지메일에 접근해서 3월 카드 명세서 이메일 찾아줘")).toBe("tool-enabled");
  });

  it("classifies Korean email statement searches as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("3월 카드 명세서 이메일 찾아줘")).toBe("tool-enabled");
  });

  it("classifies Korean payment summary questions as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("이번주 결제한 금액이 어느정도 되려나?")).toBe("tool-enabled");
  });

  it("classifies Korean payment history capability questions as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("결제 이력 확인할 수 있어?")).toBe("tool-enabled");
    expect(classifyRouteRuntimeClass("지난달 결제 기록 보여줘")).toBe("tool-enabled");
  });

  it("classifies explicit expanded payment scan requests as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("이번주 결제한 금액 전체로 제한 풀고 봐줘")).toBe("tool-enabled");
  });

  it("classifies compact Korean payment summary questions as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("이번주 카드값이 얼마나 나왔을까")).toBe("tool-enabled");
  });

  it("routes compact temporal amount questions to AgentCore as ambiguous personal lookups", () => {
    expect(classifyRouteRuntimeClass("이번주는 얼마")).toBe("tool-enabled");
    expect(classifyRouteRuntimeClass("이번달은 얼마야")).toBe("tool-enabled");
  });

  it("classifies Korean travel payment lookup questions as tool-enabled", () => {
    expect(
      classifyRouteRuntimeClass("일본 여행가는데 결제한 내역들 알려줘"),
    ).toBe("tool-enabled");
  });

  it("classifies Korean travel payment breakdown questions as tool-enabled", () => {
    expect(classifyRouteRuntimeClass("여행 경비 카드사별로 보여줘")).toBe(
      "tool-enabled",
    );
  });

  it("classifies travel spending lookups with date ranges as tool-enabled", () => {
    expect(
      classifyRouteRuntimeClass("4월 18일부터 일본 여행 관련 쓴 돈 정리해줘"),
    ).toBe("tool-enabled");
  });
});

describe("getRouteClassificationSignals", () => {
  it("captures coarse private-data signals for travel payment lookup questions", () => {
    expect(
      getRouteClassificationSignals("일본 여행가는데 결제한 내역들 알려줘"),
    ).toMatchObject({
      hasFargateHint: false,
      hasTravelContext: true,
      hasSensitiveDataCue: true,
      hasAmbiguousPersonalLookup: true,
      hasDataLookupAction: true,
      hasHangul: true,
    });
  });

  it("captures travel spending signals for dated travel spend lookups", () => {
    expect(
      getRouteClassificationSignals("4월 18일부터 일본 여행 관련 쓴 돈 정리해줘"),
    ).toMatchObject({
      hasTravelContext: true,
      hasSensitiveDataCue: true,
      hasDataLookupAction: true,
      hasAmbiguousPersonalLookup: true,
      hasHangul: true,
    });
  });

  it("captures compact ambiguous personal lookup signals", () => {
    expect(getRouteClassificationSignals("이번주는 얼마")).toMatchObject({
      hasTemporalContext: true,
      hasAmbiguousPersonalLookup: true,
      hasDataLookupAction: true,
      hasHangul: true,
    });
  });

  it("captures expanded payment scan requests as personal data lookups", () => {
    expect(getRouteClassificationSignals("이번주 결제한 금액 전체로 제한 풀고 봐줘")).toMatchObject({
      hasSensitiveDataCue: true,
      hasTemporalContext: true,
      hasDataLookupAction: true,
      hasAmbiguousPersonalLookup: true,
      hasHangul: true,
    });
  });

  it("captures payment history questions as tool-capable personal data lookups", () => {
    expect(getRouteClassificationSignals("결제 이력 확인할 수 있어?")).toMatchObject({
      hasSensitiveDataCue: true,
      hasDataLookupAction: true,
      hasAmbiguousPersonalLookup: true,
      hasHangul: true,
    });
  });
});

describe("classifyRoute coarse tool routing", () => {
  it("routes Korean payment summary questions to tool-enabled compute", () => {
    const result = classifyRoute({
      message: "이번주 결제한 금액이 어느정도 되려나?",
      taskState: runningTask,
    });

    expect(result).toBe("fargate-reuse");
  });

  it("routes explicit expanded payment scans to tool-enabled compute", () => {
    const result = classifyRoute({
      message: "이번주 결제한 금액 전체로 제한 풀고 봐줘",
      taskState: runningTask,
    });

    expect(result).toBe("fargate-reuse");
  });

  it("routes Korean payment history questions to tool-enabled compute", () => {
    const result = classifyRoute({
      message: "결제 이력 확인할 수 있어?",
      taskState: runningTask,
    });

    expect(result).toBe("fargate-reuse");
  });

  it("routes compact Korean payment summary questions to tool-enabled compute", () => {
    const result = classifyRoute({
      message: "이번주 카드값이 얼마나 나왔을까",
      taskState: runningTask,
    });

    expect(result).toBe("fargate-reuse");
  });

  it("routes compact temporal amount questions to tool-enabled compute without assigning a task family", () => {
    const result = classifyRoute({
      message: "이번주는 얼마",
      taskState: runningTask,
    });

    expect(result).toBe("fargate-reuse");
  });

  it("routes Korean travel payment lookup questions to tool-enabled compute", () => {
    const result = classifyRoute({
      message: "일본 여행가는데 결제한 내역들 알려줘",
      taskState: runningTask,
    });

    expect(result).toBe("fargate-reuse");
  });

  it("routes dated travel spending lookups to tool-enabled compute", () => {
    const result = classifyRoute({
      message: "4월 18일부터 일본 여행 관련 쓴 돈 정리해줘",
      taskState: runningTask,
    });

    expect(result).toBe("fargate-reuse");
  });
});

describe("stripRouteHint", () => {
  it("removes '/heavy ' prefix", () => {
    expect(stripRouteHint("/heavy do something")).toBe("do something");
  });

  it("removes '/fargate ' prefix", () => {
    expect(stripRouteHint("/fargate run this")).toBe("run this");
  });

  it("returns original message when no hint", () => {
    expect(stripRouteHint("hello world")).toBe("hello world");
  });
});
