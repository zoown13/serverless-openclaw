import { QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
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

  it("keeps processing when one pending message fails and leaves it queued", async () => {
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
    expect(dynamoSend).toHaveBeenCalledTimes(2);

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
      `[pending] failed to process message ${first.SK} for user-1; leaving it queued`,
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
});
