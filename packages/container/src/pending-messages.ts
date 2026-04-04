import { QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  TABLE_NAMES,
  KEY_PREFIX,
} from "@serverless-openclaw/shared";
import type { PendingMessageItem } from "@serverless-openclaw/shared";

interface ConsumeDeps {
  dynamoSend: (command: unknown) => Promise<unknown>;
  userId: string;
  processMessage: (msg: PendingMessageItem) => Promise<void>;
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
    try {
      await deps.processMessage(msg);
    } catch (error) {
      console.warn(
        `[pending] failed to process message ${msg.SK} for ${deps.userId}; leaving it queued`,
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
