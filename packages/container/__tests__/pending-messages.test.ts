import { QueryCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KEY_PREFIX, TABLE_NAMES, type PendingMessageItem } from "@serverless-openclaw/shared";
import { consumePendingMessages } from "../src/pending-messages.js";

function makeMessage(sk: string): PendingMessageItem {
  return {
    PK: `${KEY_PREFIX.USER}user-1`,
    SK: sk,
    connectionId: "connection-1",
    message: "hello",
    channel: "telegram",
    createdAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + 300,
  };
}

describe("consumePendingMessages", () => {
  const dynamoSend = vi.fn<(command: unknown) => Promise<unknown>>();
  const processMessage = vi.fn<(msg: PendingMessageItem) => Promise<void>>();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps processing when one pending message fails and leaves it queued with retry metadata", async () => {
    const first = makeMessage("MSG#1");
    const second = makeMessage("MSG#2");

    dynamoSend.mockImplementation(async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [first, second] };
      }
      return {};
    });

    processMessage
      .mockRejectedValueOnce(new Error("telegram delivery failed"))
      .mockResolvedValueOnce();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const consumed = await consumePendingMessages({
      dynamoSend,
      userId: "user-1",
      processMessage,
    });

    expect(consumed).toBe(1);
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(dynamoSend).toHaveBeenCalledWith(expect.any(QueryCommand));
    expect(dynamoSend).toHaveBeenCalledTimes(3);

    const updateInput = vi
      .mocked(dynamoSend)
      .mock.calls
      .map(([command]) => command)
      .find((command): command is UpdateCommand => command instanceof UpdateCommand);

    expect(updateInput?.input).toMatchObject({
      TableName: TABLE_NAMES.PENDING_MESSAGES,
      Key: { PK: first.PK, SK: first.SK },
      ExpressionAttributeValues: expect.objectContaining({
        ":retryCount": 1,
        ":lastError": "telegram delivery failed",
      }),
    });
    expect(
      Date.parse(String(updateInput?.input.ExpressionAttributeValues?.[":nextAttemptAt"])),
    ).toBeGreaterThan(Date.now());

    const deleteInput = vi
      .mocked(dynamoSend)
      .mock.calls
      .map(([command]) => command)
      .find((command): command is DeleteCommand => command instanceof DeleteCommand);

    expect(deleteInput?.input).toMatchObject({
      TableName: TABLE_NAMES.PENDING_MESSAGES,
      Key: { PK: second.PK, SK: second.SK },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `[pending] failed to process message ${first.SK} for user-1; retry 1/3`,
      ),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("does not throw when deleting a processed pending message fails", async () => {
    const msg = makeMessage("MSG#3");

    dynamoSend.mockImplementation(async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [msg] };
      }
      throw new Error("dynamo delete failed");
    });

    processMessage.mockResolvedValueOnce();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const consumed = await consumePendingMessages({
      dynamoSend,
      userId: "user-1",
      processMessage,
    });

    expect(consumed).toBe(0);
    expect(processMessage).toHaveBeenCalledWith(msg);
    expect(warnSpy).toHaveBeenCalledWith(
      `[pending] failed to delete message ${msg.SK} for user-1; it may be retried`,
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it("skips pending messages whose retry backoff has not opened yet", async () => {
    const msg = {
      ...makeMessage("MSG#4"),
      retryCount: 1,
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    };

    dynamoSend.mockImplementation(async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [msg] };
      }
      return {};
    });

    const consumed = await consumePendingMessages({
      dynamoSend,
      userId: "user-1",
      processMessage,
    });

    expect(consumed).toBe(0);
    expect(processMessage).not.toHaveBeenCalled();
    expect(dynamoSend).toHaveBeenCalledTimes(1);
  });

  it("dead-letters a pending message after the retry budget is exhausted", async () => {
    const msg = {
      ...makeMessage("MSG#5"),
      retryCount: 2,
    };

    dynamoSend.mockImplementation(async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [msg] };
      }
      return {};
    });

    processMessage.mockRejectedValueOnce(new Error("still broken"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const consumed = await consumePendingMessages({
      dynamoSend,
      userId: "user-1",
      processMessage,
    });

    expect(consumed).toBe(0);

    const updateInput = vi
      .mocked(dynamoSend)
      .mock.calls
      .map(([command]) => command)
      .find((command): command is UpdateCommand => command instanceof UpdateCommand);

    expect(updateInput?.input).toMatchObject({
      TableName: TABLE_NAMES.PENDING_MESSAGES,
      Key: { PK: msg.PK, SK: msg.SK },
      ExpressionAttributeValues: expect.objectContaining({
        ":retryCount": 3,
        ":lastError": "still broken",
      }),
    });
    expect(String(updateInput?.input.UpdateExpression)).toContain("deadLetteredAt");
    expect(warnSpy).toHaveBeenCalledWith(
      `[pending] dead-lettered message ${msg.SK} for user-1 after 3 attempts`,
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });
});
