export type AwsCostLookupPeriod = "month_to_date" | "last_7_days" | "previous_month";

export interface AwsCostLookupRequest {
  period: AwsCostLookupPeriod;
  groupByService: boolean;
  maxServices: number;
}

export interface AwsCostLookupDateRange {
  start: string;
  end: string;
  label: string;
  freshnessNote: string;
}

export interface AwsCostServiceBreakdown {
  service: string;
  amountUsd: number;
  unit: string;
}

export interface AwsCostLookupResult {
  request: AwsCostLookupRequest;
  dateRange: AwsCostLookupDateRange;
  totalUsd: number;
  unit: string;
  services: AwsCostServiceBreakdown[];
  generatedAt: string;
  source: "aws-cost-explorer";
}

function normalizeMessage(message: string): string {
  return message.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function parseAwsCostLookupRequest(
  message: string,
): AwsCostLookupRequest | undefined {
  const normalized = normalizeMessage(message);
  if (!normalized || normalized.length > 180) return undefined;

  const hasExplicitCommand = /^\/(?:aws-?cost|aws-?billing|billing)\b/i.test(normalized);
  const hasAwsCue =
    /(?:\baws\b|amazon web services|아마존\s*웹|클라우드|cloud|aws\s*계정|aws\s*청구)/i
      .test(normalized);
  const hasBillingCue =
    /(?:비용|요금|청구|사용량|사용료|cost|costs|billing|bill|usage|spend|spending)/i
      .test(normalized);

  if (!hasExplicitCommand && !(hasAwsCue && hasBillingCue)) {
    return undefined;
  }

  const period: AwsCostLookupPeriod =
    /(?:지난\s*(?:달|월)|저번\s*(?:달|월)|last\s+month|previous\s+month)/i.test(normalized)
      ? "previous_month"
      : /(?:최근\s*7\s*일|지난\s*7\s*일|7\s*일|last\s*7\s*days?)/i.test(normalized)
        ? "last_7_days"
        : "month_to_date";

  return {
    period,
    groupByService:
      /(?:서비스별|항목별|세부|상세|브레이크다운|breakdown|by\s+service|service\s+breakdown)/i
        .test(normalized),
    maxServices: 8,
  };
}

function startOfUtcDate(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function resolveAwsCostLookupDateRange(
  request: AwsCostLookupRequest,
  now = new Date(),
): AwsCostLookupDateRange {
  const today = startOfUtcDate(now);
  const currentMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

  if (request.period === "previous_month") {
    const previousMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    return {
      start: formatUtcDate(previousMonthStart),
      end: formatUtcDate(currentMonthStart),
      label: "지난달",
      freshnessNote: "지난달 Cost Explorer 반영분 기준입니다.",
    };
  }

  if (request.period === "last_7_days") {
    return {
      start: formatUtcDate(addUtcDays(today, -7)),
      end: formatUtcDate(today),
      label: "최근 7일",
      freshnessNote: "오늘 진행 중인 비용은 Cost Explorer에 아직 완전히 반영되지 않을 수 있습니다.",
    };
  }

  const end = today > currentMonthStart ? today : addUtcDays(today, 1);
  return {
    start: formatUtcDate(currentMonthStart),
    end: formatUtcDate(end),
    label: "이번 달 현재까지",
    freshnessNote: "오늘 진행 중인 비용은 Cost Explorer에 아직 완전히 반영되지 않을 수 있습니다.",
  };
}

export function formatAwsUsd(value: number): string {
  if (value > 0 && value < 0.0001) return "<$0.0001";
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function buildAwsCostLookupMessage(result: AwsCostLookupResult): string {
  const parts = [
    `AWS Cost Explorer 기준 ${result.dateRange.label} 비용은 약 ${formatAwsUsd(result.totalUsd)}입니다.`,
    `조회 기간: ${result.dateRange.start} ~ ${result.dateRange.end} (end exclusive)`,
  ];

  if (result.services.length > 0) {
    parts.push("", "서비스별 상위 비용:");
    for (const [index, service] of result.services.entries()) {
      parts.push(`${index + 1}. ${service.service}: ${formatAwsUsd(service.amountUsd)}`);
    }
  }

  parts.push("", result.dateRange.freshnessNote);
  return parts.join("\n");
}

export function buildAwsCostLookupDisabledMessage(): string {
  return [
    "AWS 비용 조회 capability는 registry에 정의되어 있지만 현재 runtime에서는 아직 활성화되어 있지 않아요.",
    "활성화하려면 AWS_COST_LOOKUP_ENABLED=true와 Cost Explorer read-only IAM 권한이 필요합니다.",
  ].join("\n");
}

export function buildAwsCostLookupFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/accessdenied|not authorized|unauthorized|forbidden/i.test(message)) {
    return "AWS 비용 조회 권한이 아직 충분하지 않아요. ce:GetCostAndUsage read 권한을 확인해야 합니다.";
  }

  return "AWS Cost Explorer 조회에 실패했어요. 잠시 후 다시 시도하거나 CloudWatch 로그의 aws_cost.lookup_failed 이벤트를 확인해야 합니다.";
}
