import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import type { MetricDatum } from "@aws-sdk/client-cloudwatch";
import type { Channel } from "@serverless-openclaw/shared";

const NAMESPACE = "ServerlessOpenClaw";
const enabled = process.env.METRICS_ENABLED === "true";
const client = new CloudWatchClient({});

export type LambdaDeliveryMetricName = "DeliverySuccess" | "DeliveryFailure";

interface LambdaDeliveryMetricDimensions {
  channel: Channel;
  deliveryType: "websocket" | "telegram";
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
    console.warn("Failed to publish lambda-agent CloudWatch metrics:", err);
  }
}

export async function publishLambdaDeliveryMetric(
  metricName: LambdaDeliveryMetricName,
  dimensions: LambdaDeliveryMetricDimensions,
  value = 1,
): Promise<void> {
  await putMetrics([
    {
      MetricName: metricName,
      Value: value,
      Unit: "Count",
      Dimensions: [
        { Name: "Channel", Value: dimensions.channel },
        { Name: "Runtime", Value: "lambda" },
        { Name: "DeliveryType", Value: dimensions.deliveryType },
      ],
      Timestamp: new Date(),
    },
  ]);
}
