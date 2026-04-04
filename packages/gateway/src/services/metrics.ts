import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import type { MetricDatum } from "@aws-sdk/client-cloudwatch";
import type { Channel } from "@serverless-openclaw/shared";

const NAMESPACE = "ServerlessOpenClaw";
const enabled = process.env.METRICS_ENABLED === "true";
const client = new CloudWatchClient({});

export type GatewayMetricName =
  | "RouteToLambda"
  | "RouteToFargate"
  | "RouteFallbackToFargate"
  | "PendingMessagesQueued";

interface GatewayMetricDimensions {
  channel: Channel;
  runtime: "lambda" | "fargate";
}

async function putMetrics(metrics: MetricDatum[]): Promise<void> {
  if (!enabled) return;

  try {
    await client.send(
      new PutMetricDataCommand({
        Namespace: NAMESPACE,
        MetricData: metrics,
      }),
    );
  } catch (err) {
    console.warn("Failed to publish gateway CloudWatch metrics:", err);
  }
}

export async function publishGatewayCountMetric(
  metricName: GatewayMetricName,
  dimensions: GatewayMetricDimensions,
  value = 1,
): Promise<void> {
  await putMetrics([
    {
      MetricName: metricName,
      Value: value,
      Unit: "Count",
      Dimensions: [
        { Name: "Channel", Value: dimensions.channel },
        { Name: "Runtime", Value: dimensions.runtime },
      ],
      Timestamp: new Date(),
    },
  ]);
}
