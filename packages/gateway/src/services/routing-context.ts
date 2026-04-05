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
  ToolRuntimeAffinityState,
} from "@serverless-openclaw/shared";

type Send = (command: unknown) => Promise<unknown>;

interface GetResult {
  Item?: {
    value?: ToolRuntimeAffinityState;
  };
}

function routingContextKey(userId: string, channel: Channel): {
  PK: string;
  SK: string;
} {
  return {
    PK: `${KEY_PREFIX.USER}${userId}`,
    SK: `${KEY_PREFIX.SETTING}tool-affinity:${channel}`,
  };
}

export async function getRoutingContext(
  send: Send,
  userId: string,
  channel: Channel,
): Promise<ToolRuntimeAffinityState | null> {
  const result = (await send(
    new GetCommand({
      TableName: TABLE_NAMES.SETTINGS,
      Key: routingContextKey(userId, channel),
    }),
  )) as GetResult;

  return result.Item?.value ?? null;
}

export async function putRoutingContext(
  send: Send,
  userId: string,
  state: ToolRuntimeAffinityState,
): Promise<void> {
  await send(
    new PutCommand({
      TableName: TABLE_NAMES.SETTINGS,
      Item: {
        ...routingContextKey(userId, state.channel),
        value: state,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

export async function deleteRoutingContext(
  send: Send,
  userId: string,
  channel: Channel,
): Promise<void> {
  await send(
    new DeleteCommand({
      TableName: TABLE_NAMES.SETTINGS,
      Key: routingContextKey(userId, channel),
    }),
  );
}
