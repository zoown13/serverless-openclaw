import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

vi.mock("@aws-sdk/client-cloudwatch");

describe("metrics", () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSend = vi.fn().mockResolvedValue({});
    vi.mocked(CloudWatchClient).mockImplementation(
      () => ({ send: mockSend }) as unknown as CloudWatchClient,
    );
  });

  afterEach(() => {
    delete process.env.METRICS_ENABLED;
  });

  async function loadModule(metricsEnabled = true) {
    if (metricsEnabled) {
      process.env.METRICS_ENABLED = "true";
    } else {
      delete process.env.METRICS_ENABLED;
    }
    return import("../src/metrics.js");
  }

  /** Get the input arg passed to the PutMetricDataCommand constructor */
  function getCommandInput(callIndex = 0) {
    return vi.mocked(PutMetricDataCommand).mock.calls[callIndex][0];
  }

  describe("publishStartupMetrics", () => {
    it("should publish startup phase timings as batch", async () => {
      const { publishStartupMetrics } = await loadModule();

      await publishStartupMetrics({
        total: 5000,
        s3Restore: 1000,
        gatewayWait: 2500,
        clientReady: 1500,
        pendingMessages: 3,
        userId: "telegram:123",
        channel: "telegram",
      });

      expect(mockSend).toHaveBeenCalledTimes(1);

      const input = getCommandInput();
      expect(input.Namespace).toBe("ServerlessOpenClaw");

      const metricNames = input.MetricData!.map((m) => m.MetricName);
      expect(metricNames).toContain("StartupTotal");
      expect(metricNames).toContain("StartupS3Restore");
      expect(metricNames).toContain("StartupGatewayWait");
      expect(metricNames).toContain("StartupClientReady");
      expect(metricNames).toContain("PendingMessagesConsumed");

      const totalMetric = input.MetricData!.find(
        (m) => m.MetricName === "StartupTotal",
      );
      expect(totalMetric!.Unit).toBe("Milliseconds");
      expect(totalMetric!.Value).toBe(5000);
      expect(totalMetric!.Dimensions).toEqual(
        expect.arrayContaining([
          { Name: "Channel", Value: "telegram" },
        ]),
      );

      const pendingMetric = input.MetricData!.find(
        (m) => m.MetricName === "PendingMessagesConsumed",
      );
      expect(pendingMetric!.Unit).toBe("Count");
      expect(pendingMetric!.Value).toBe(3);
    });

    it("should not throw on CloudWatch error", async () => {
      mockSend.mockRejectedValueOnce(new Error("CloudWatch error"));
      const { publishStartupMetrics } = await loadModule();

      await expect(
        publishStartupMetrics({
          total: 1000,
          s3Restore: 200,
          gatewayWait: 500,
          clientReady: 300,
          pendingMessages: 0,
          userId: "user1",
          channel: "web",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("publishMessageMetrics", () => {
    it("should publish latency and response length", async () => {
      const { publishMessageMetrics } = await loadModule();

      await publishMessageMetrics({
        latency: 3200,
        responseLength: 450,
        channel: "web",
      });

      expect(mockSend).toHaveBeenCalledTimes(1);

      const input = getCommandInput();
      expect(input.Namespace).toBe("ServerlessOpenClaw");

      const latencyMetric = input.MetricData!.find(
        (m) => m.MetricName === "MessageLatency",
      );
      expect(latencyMetric!.Unit).toBe("Milliseconds");
      expect(latencyMetric!.Value).toBe(3200);

      const lengthMetric = input.MetricData!.find(
        (m) => m.MetricName === "ResponseLength",
      );
      expect(lengthMetric!.Unit).toBe("Count");
      expect(lengthMetric!.Value).toBe(450);
    });

    it("should not throw on CloudWatch error", async () => {
      mockSend.mockRejectedValueOnce(new Error("Timeout"));
      const { publishMessageMetrics } = await loadModule();

      await expect(
        publishMessageMetrics({
          latency: 1000,
          responseLength: 100,
          channel: "telegram",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("publishFirstResponseTime", () => {
    it("should publish first response time metric", async () => {
      const { publishFirstResponseTime } = await loadModule();

      await publishFirstResponseTime(8500, "telegram");

      expect(mockSend).toHaveBeenCalledTimes(1);

      const input = getCommandInput();
      const metric = input.MetricData!.find(
        (m) => m.MetricName === "FirstResponseTime",
      );
      expect(metric!.Unit).toBe("Milliseconds");
      expect(metric!.Value).toBe(8500);
      expect(metric!.Dimensions).toEqual(
        expect.arrayContaining([
          { Name: "Channel", Value: "telegram" },
        ]),
      );
    });
  });

  describe("no-op in test environment", () => {
    it("should skip publishing when METRICS_ENABLED is not set", async () => {
      const { publishStartupMetrics } = await loadModule(false);

      await publishStartupMetrics({
        total: 1000,
        s3Restore: 200,
        gatewayWait: 500,
        clientReady: 300,
        pendingMessages: 0,
        userId: "user1",
        channel: "web",
      });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should publish when METRICS_ENABLED is true", async () => {
      const { publishStartupMetrics } = await loadModule(true);

      await publishStartupMetrics({
        total: 1000,
        s3Restore: 200,
        gatewayWait: 500,
        clientReady: 300,
        pendingMessages: 0,
        userId: "user1",
        channel: "web",
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("publishCountMetric", () => {
    it("should publish low-cardinality observability dimensions", async () => {
      const { publishCountMetric } = await loadModule();

      await publishCountMetric("DeliverySuccess", {
        channel: "telegram",
        runtime: "fargate",
        deliveryType: "telegram",
      }, 2);

      expect(mockSend).toHaveBeenCalledTimes(1);

      const input = getCommandInput();
      const metric = input.MetricData!.find(
        (m) => m.MetricName === "DeliverySuccess",
      );
      expect(metric!.Value).toBe(2);
      expect(metric!.Dimensions).toEqual(
        expect.arrayContaining([
          { Name: "Channel", Value: "telegram" },
          { Name: "Runtime", Value: "fargate" },
          { Name: "DeliveryType", Value: "telegram" },
        ]),
      );
    });
  });
});
