import { QueryCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  TABLE_NAMES,
  KEY_PREFIX,
} from "@serverless-openclaw/shared";
import type { PendingMessageItem } from "@serverless-openclaw/shared";
import { publishCountMetric } from "./metrics.js";

interface ConsumeDeps {
  dynamoSend: (command: unknown) => Promise<unknown>;
  userId: string;
  processMessage: (msg: PendingMessageItem) => Promise<void>;
}

const MAX_PENDING_RETRIES = 3;
const BASE_PENDING_RETRY_DELAY_MS = 30_000;
const MAX_PENDING_RETRY_DELAY_MS = 10 * 60_000;

function getBackoffDelayMs(retryCount: number): number {
  return Math.min(
    BASE_PENDING_RETRY_DELAY_MS * 2 ** Math.max(retryCount - 1, 0),
    MAX_PENDING_RETRY_DELAY_MS,
  );
}

export async function consumePendingMessages(
  deps: ConsumeDeps,
): Promise<number> {
  const result = (await deps.dynamoSend(
    new QueryCommand({
      TableName: TABLE_NAMES.PENDING_MESSAGES,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `${KEY_PREFIX.USER}${deps.userId}`,
      },
    }),
  )) as { Items?: PendingMessageItem[] };

  const items = result.Items ?? [];

  let consumed = 0;

  for (const msg of items) {
    if (msg.deadLetteredAt) {
      continue;
    }

    if (msg.nextAttemptAt) {
      const nextAttemptTime = Date.parse(msg.nextAttemptAt);
      if (Number.isFinite(nextAttemptTime) && nextAttemptTime > Date.now()) {
        continue;
      }
    }

    try {
      await deps.processMessage(msg);
    } catch (error) {
      const retryCount = (msg.retryCount ?? 0) + 1;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (retryCount >= MAX_PENDING_RETRIES) {
        await deps.dynamoSend(
          new UpdateCommand({
            TableName: TABLE_NAMES.PENDING_MESSAGES,
            Key: { PK: msg.PK, SK: msg.SK },
            UpdateExpression:
              "SET retryCount = :retryCount, lastError = :lastError, deadLetteredAt = :deadLetteredAt REMOVE nextAttemptAt",
            ExpressionAttributeValues: {
              ":retryCount": retryCount,
              ":lastError": errorMessage,
              ":deadLetteredAt": new Date().toISOString(),
            },
          }),
        );
        await publishCountMetric("PendingMessagesDeadLettered", {
          channel: msg.channel,
          runtime: "fargate",
        });
        console.warn(
          `[pending] dead-lettered message ${msg.SK} for ${deps.userId} after ${retryCount} attempts`,
          error,
        );
        continue;
      }

      const nextAttemptAt = new Date(
        Date.now() + getBackoffDelayMs(retryCount),
      ).toISOString();
      await deps.dynamoSend(
        new UpdateCommand({
          TableName: TABLE_NAMES.PENDING_MESSAGES,
          Key: { PK: msg.PK, SK: msg.SK },
          UpdateExpression:
            "SET retryCount = :retryCount, lastError = :lastError, nextAttemptAt = :nextAttemptAt REMOVE deadLetteredAt",
          ExpressionAttributeValues: {
            ":retryCount": retryCount,
            ":lastError": errorMessage,
            ":nextAttemptAt": nextAttemptAt,
          },
        }),
      );
      await publishCountMetric("PendingMessagesRetryScheduled", {
        channel: msg.channel,
        runtime: "fargate",
      });
      console.warn(
        `[pending] failed to process message ${msg.SK} for ${deps.userId}; retry ${retryCount}/${MAX_PENDING_RETRIES} at ${nextAttemptAt}`,
        error,
      );
      continue;
    }

    try {
      await deps.dynamoSend(
        new DeleteCommand({
          TableName: TABLE_NAMES.PENDING_MESSAGES,
          Key: { PK: msg.PK, SK: msg.SK },
        }),
      );
      consumed += 1;
    } catch (error) {
      console.warn(
        `[pending] failed to delete message ${msg.SK} for ${deps.userId}; it may be retried`,
        error,
      );
    }
  }

  return consumed;
}
