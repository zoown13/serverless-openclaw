import { describe, expect, it } from "vitest";
import {
  buildAwsCostLookupMessage,
  parseAwsCostLookupRequest,
  resolveAwsCostLookupDateRange,
} from "../src/aws-cost-lookup.js";

describe("AWS cost lookup helpers", () => {
  it("detects explicit AWS billing questions without matching generic cost wording", () => {
    expect(parseAwsCostLookupRequest("이번달 AWS 비용 서비스별로 알려줘")).toMatchObject({
      period: "month_to_date",
      groupByService: true,
    });
    expect(parseAwsCostLookupRequest("이번 질문 비용 얼마야?")).toBeUndefined();
  });

  it("builds stable Cost Explorer date ranges", () => {
    expect(resolveAwsCostLookupDateRange(
      { period: "month_to_date", groupByService: false, maxServices: 8 },
      new Date("2026-05-15T12:00:00.000Z"),
    )).toMatchObject({
      start: "2026-05-01",
      end: "2026-05-15",
      label: "이번 달 현재까지",
    });
  });

  it("formats service breakdowns with freshness guidance", () => {
    const message = buildAwsCostLookupMessage({
      request: { period: "month_to_date", groupByService: true, maxServices: 8 },
      dateRange: {
        start: "2026-05-01",
        end: "2026-05-15",
        label: "이번 달 현재까지",
        freshnessNote: "오늘 진행 중인 비용은 Cost Explorer에 아직 완전히 반영되지 않을 수 있습니다.",
      },
      totalUsd: 1.2345,
      unit: "USD",
      services: [
        { service: "AWS Lambda", amountUsd: 0.5, unit: "USD" },
        { service: "Amazon Bedrock", amountUsd: 0.25, unit: "USD" },
      ],
      generatedAt: "2026-05-15T12:00:00.000Z",
      source: "aws-cost-explorer",
    });

    expect(message).toContain("AWS Cost Explorer 기준 이번 달 현재까지 비용");
    expect(message).toContain("AWS Lambda: $0.5000");
    expect(message).toContain("Cost Explorer");
  });
});
