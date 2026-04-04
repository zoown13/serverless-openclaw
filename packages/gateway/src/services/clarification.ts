import {
  DeleteCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  KEY_PREFIX,
  TABLE_NAMES,
} from "@serverless-openclaw/shared";
import type {
  Channel,
  PendingClarificationState,
} from "@serverless-openclaw/shared";

type Send = (command: unknown) => Promise<unknown>;

interface GetResult {
  Item?: {
    value?: PendingClarificationState;
  };
}

function clarificationKey(userId: string, channel: Channel): {
  PK: string;
  SK: string;
} {
  return {
    PK: `${KEY_PREFIX.USER}${userId}`,
    SK: `${KEY_PREFIX.SETTING}clarification:${channel}`,
  };
}

export async function getPendingClarification(
  send: Send,
  userId: string,
  channel: Channel,
): Promise<PendingClarificationState | null> {
  const result = (await send(
    new GetCommand({
      TableName: TABLE_NAMES.SETTINGS,
      Key: clarificationKey(userId, channel),
    }),
  )) as GetResult;

  return result.Item?.value ?? null;
}

export async function putPendingClarification(
  send: Send,
  userId: string,
  state: PendingClarificationState,
): Promise<void> {
  await send(
    new PutCommand({
      TableName: TABLE_NAMES.SETTINGS,
      Item: {
        ...clarificationKey(userId, state.channel),
        value: state,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

export async function deletePendingClarification(
  send: Send,
  userId: string,
  channel: Channel,
): Promise<void> {
  await send(
    new DeleteCommand({
      TableName: TABLE_NAMES.SETTINGS,
      Key: clarificationKey(userId, channel),
    }),
  );
}
