import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import {
  resolveAwsCostLookupDateRange,
  type AwsCostLookupRequest,
  type AwsCostLookupResult,
  type AwsCostServiceBreakdown,
} from "@serverless-openclaw/shared";

let costExplorerClient: CostExplorerClient | undefined;

function getCostExplorerClient(): CostExplorerClient {
  costExplorerClient ??= new CostExplorerClient({
    region: process.env.AWS_COST_EXPLORER_REGION ?? "us-east-1",
  });
  return costExplorerClient;
}

export async function lookupAwsCostExplorer(
  request: AwsCostLookupRequest,
): Promise<AwsCostLookupResult> {
  const dateRange = resolveAwsCostLookupDateRange(request);
  const response = await getCostExplorerClient().send(
    new GetCostAndUsageCommand({
      TimePeriod: {
        Start: dateRange.start,
        End: dateRange.end,
      },
      Granularity: request.period === "last_7_days" ? "DAILY" : "MONTHLY",
      Metrics: ["UnblendedCost"],
      ...(request.groupByService
        ? { GroupBy: [{ Type: "DIMENSION" as const, Key: "SERVICE" }] }
        : {}),
    }),
  );

  const services = new Map<string, AwsCostServiceBreakdown>();
  let totalUsd = 0;
  let unit = "USD";

  for (const result of response.ResultsByTime ?? []) {
    if (result.Groups?.length) {
      for (const group of result.Groups) {
        const serviceName = group.Keys?.[0] ?? "Unknown";
        const metric = group.Metrics?.UnblendedCost;
        const amount = Number.parseFloat(metric?.Amount ?? "0");
        if (!Number.isFinite(amount) || amount <= 0) continue;
        unit = metric?.Unit ?? unit;
        totalUsd += amount;
        const current = services.get(serviceName);
        services.set(serviceName, {
          service: serviceName,
          amountUsd: (current?.amountUsd ?? 0) + amount,
          unit,
        });
      }
      continue;
    }

    const metric = result.Total?.UnblendedCost;
    const amount = Number.parseFloat(metric?.Amount ?? "0");
    if (Number.isFinite(amount) && amount > 0) {
      unit = metric?.Unit ?? unit;
      totalUsd += amount;
    }
  }

  return {
    request,
    dateRange,
    totalUsd,
    unit,
    services: [...services.values()]
      .sort((a, b) => b.amountUsd - a.amountUsd)
      .slice(0, request.maxServices),
    generatedAt: new Date().toISOString(),
    source: "aws-cost-explorer",
  };
}
