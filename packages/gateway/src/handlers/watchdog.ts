import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ECSClient,
  StopTaskCommand,
  DescribeTasksCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import {
  TABLE_NAMES,
  INACTIVITY_TIMEOUT_MS,
  ACTIVE_TIMEOUT_MS,
  INACTIVE_TIMEOUT_MS,
  ACTIVITY_LOOKBACK_DAYS,
  ACTIVE_HOUR_THRESHOLD,
  METRICS_NAMESPACE,
  MIN_UPTIME_MINUTES,
} from "@serverless-openclaw/shared";
import type { TaskStateItem } from "@serverless-openclaw/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecs = new ECSClient({});
const cloudwatch = new CloudWatchClient({});

const STALE_STARTING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const ORPHAN_TASK_MIN_UPTIME_MS = Number.parseInt(
  process.env.WATCHDOG_ORPHAN_TASK_MIN_UPTIME_MS ?? "",
  10,
) || 15 * 60 * 1000;

async function getActiveTimeout(): Promise<number> {
  try {
    const now = new Date();
    const currentHourKST = (now.getUTCHours() + 9) % 24;
    const startTime = new Date(now.getTime() - ACTIVITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    let totalActiveDatapoints = 0;

    for (const channel of ["telegram", "web"]) {
      const result = await cloudwatch.send(
        new GetMetricStatisticsCommand({
          Namespace: METRICS_NAMESPACE,
          MetricName: "MessageLatency",
          StartTime: startTime,
          EndTime: now,
          Period: 3600,
          Statistics: ["SampleCount"],
          Dimensions: [{ Name: "Channel", Value: channel }],
        }),
      );

      const matchingDatapoints = (result.Datapoints ?? []).filter((dp) => {
        if (!dp.Timestamp) return false;
        const dpHourKST = (new Date(dp.Timestamp).getUTCHours() + 9) % 24;
        return dpHourKST === currentHourKST;
      });

      totalActiveDatapoints += matchingDatapoints.length;
    }

    if (totalActiveDatapoints === 0) return INACTIVITY_TIMEOUT_MS;
    return totalActiveDatapoints >= ACTIVE_HOUR_THRESHOLD ? ACTIVE_TIMEOUT_MS : INACTIVE_TIMEOUT_MS;
  } catch {
    return INACTIVITY_TIMEOUT_MS;
  }
}

export async function handler(): Promise<void> {
  const agentRuntime = process.env.AGENT_RUNTIME ?? "fargate";
  if (agentRuntime === "lambda") {
    console.log("[watchdog] AGENT_RUNTIME=lambda, skipping Fargate watchdog");
    return;
  }

  const cluster = process.env.ECS_CLUSTER_ARN ?? "";
  const now = Date.now();
  const timeout = await getActiveTimeout();

  // Scan all active TaskState items (Running or Starting)
  const result = (await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAMES.TASK_STATE,
      FilterExpression: "#s IN (:running, :starting)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":running": "Running", ":starting": "Starting" },
    }),
  )) as { Items?: TaskStateItem[] };

  const items = result.Items ?? [];
  const referencedTaskArns = new Set(items.map((item) => item.taskArn));

  for (const item of items) {
    const startedAt = new Date(item.startedAt).getTime();
    const lastActivity = new Date(item.lastActivity).getTime();
    const uptimeMs = now - startedAt;

    if (item.status === "Starting") {
      // Clean up stale "Starting" entries — task may have failed to start
      if (uptimeMs > STALE_STARTING_TIMEOUT_MS) {
        // Verify the ECS task is actually stopped
        try {
          const desc = await ecs.send(
            new DescribeTasksCommand({ cluster, tasks: [item.taskArn] }),
          );
          const task = desc.tasks?.[0];
          if (!task || task.lastStatus === "STOPPED") {
            await ddb.send(
              new DeleteCommand({ TableName: TABLE_NAMES.TASK_STATE, Key: { PK: item.PK } }),
            );
          }
        } catch {
          // Task not found — clean up the stale entry
          await ddb.send(
            new DeleteCommand({ TableName: TABLE_NAMES.TASK_STATE, Key: { PK: item.PK } }),
          );
        }
      }
      continue;
    }

    // Verify the ECS task is actually running — clean up stale "Running" entries
    try {
      const desc = await ecs.send(
        new DescribeTasksCommand({ cluster, tasks: [item.taskArn] }),
      );
      const task = desc.tasks?.[0];
      if (!task || task.lastStatus === "STOPPED") {
        await ddb.send(
          new DeleteCommand({ TableName: TABLE_NAMES.TASK_STATE, Key: { PK: item.PK } }),
        );
        continue;
      }
    } catch {
      // Task not found — clean up stale entry
      await ddb.send(
        new DeleteCommand({ TableName: TABLE_NAMES.TASK_STATE, Key: { PK: item.PK } }),
      );
      continue;
    }

    // Running tasks: don't stop if uptime is too short
    if (uptimeMs < MIN_UPTIME_MINUTES * 60 * 1000) {
      continue;
    }

    // Skip tasks under prewarm protection
    if (item.prewarmUntil && now < item.prewarmUntil) {
      continue;
    }

    // Stop tasks that have been inactive too long
    const inactiveMs = now - lastActivity;
    if (inactiveMs > timeout) {
      await ecs.send(
        new StopTaskCommand({
          cluster,
          task: item.taskArn,
          reason: "Watchdog: inactivity timeout",
        }),
      );

      await ddb.send(
        new DeleteCommand({
          TableName: TABLE_NAMES.TASK_STATE,
          Key: { PK: item.PK },
        }),
      );
    }
  }

  try {
    await stopOrphanStandaloneTasks(cluster, now, referencedTaskArns);
  } catch (error) {
    console.warn("[watchdog] orphan standalone task cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveTaskFamily(taskDefinitionArn: string | undefined): string | undefined {
  if (!taskDefinitionArn) return undefined;
  const definition = taskDefinitionArn.split("/").pop();
  return definition?.split(":")[0];
}

async function stopOrphanStandaloneTasks(
  cluster: string,
  now: number,
  referencedTaskArns: Set<string>,
): Promise<void> {
  const family = resolveTaskFamily(process.env.TASK_DEFINITION_ARN);
  if (!family) return;

  const listed = await ecs.send(
    new ListTasksCommand({
      cluster,
      desiredStatus: "RUNNING",
      family,
    }),
  );

  const orphanCandidates = (listed.taskArns ?? []).filter((taskArn) => !referencedTaskArns.has(taskArn));
  if (orphanCandidates.length === 0) return;

  const described = await ecs.send(
    new DescribeTasksCommand({
      cluster,
      tasks: orphanCandidates,
    }),
  );

  for (const task of described.tasks ?? []) {
    const taskArn = task.taskArn;
    if (!taskArn || referencedTaskArns.has(taskArn)) continue;
    if (task.lastStatus !== "RUNNING" || task.desiredStatus === "STOPPED") continue;
    if (task.launchType && task.launchType !== "FARGATE") continue;
    if (task.group && !task.group.startsWith("family:")) continue;

    const startedAt = task.startedAt?.getTime?.() ?? task.createdAt?.getTime?.() ?? now;
    if (now - startedAt < ORPHAN_TASK_MIN_UPTIME_MS) continue;

    console.log("[watchdog] stopping orphan standalone Fargate task", {
      taskArn,
      group: task.group,
      taskDefinitionArn: task.taskDefinitionArn,
      startedAt: task.startedAt?.toISOString?.() ?? task.createdAt?.toISOString?.(),
    });

    await ecs.send(
      new StopTaskCommand({
        cluster,
        task: taskArn,
        reason: "Watchdog: orphan standalone task without TaskState",
      }),
    );
  }
}
