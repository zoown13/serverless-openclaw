import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maybeHandleCustomGmailRequest } from "../src/gmail-tool.js";

function writeRuntimeFiles(homeDir: string, oauth: unknown, credentials: unknown): void {
  const oauthDir = path.join(homeDir, ".openclaw", "credentials");
  const gogDir = path.join(homeDir, ".config", "gogcli");
  fs.mkdirSync(oauthDir, { recursive: true });
  fs.mkdirSync(gogDir, { recursive: true });
  fs.writeFileSync(path.join(oauthDir, "oauth.json"), JSON.stringify(oauth), "utf-8");
  fs.writeFileSync(path.join(gogDir, "credentials.json"), JSON.stringify(credentials), "utf-8");
}

describe("maybeHandleCustomGmailRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.HOME;
  });

  it("returns undefined for non-Gmail messages", async () => {
    await expect(
      maybeHandleCustomGmailRequest({
        message: "Say hello",
        runtimeClass: "tool-enabled",
      }),
    ).resolves.toBeUndefined();
  });

  it("returns a friendly message when OAuth token is missing", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-tool-"));
    process.env.HOME = homeDir;

    fs.mkdirSync(path.join(homeDir, ".config", "gogcli"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".config", "gogcli", "credentials.json"),
      JSON.stringify({ client_id: "id", client_secret: "secret" }),
      "utf-8",
    );

    await expect(
      maybeHandleCustomGmailRequest({
        message: "Check my Gmail inbox",
        runtimeClass: "tool-enabled",
      }),
    ).resolves.toContain("Gmail is not connected");
  });

  it("supports Korean Gmail summary requests", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-tool-"));
    process.env.HOME = homeDir;
    writeRuntimeFiles(
      homeDir,
      {
        email: "zoown13@gmail.com",
        refresh_token: "refresh-token",
      },
      {
        client_id: "client-id",
        client_secret: "client-secret",
      },
    );

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://oauth2.googleapis.com/token") {
        return {
          ok: true,
          json: async () => ({ access_token: "access-token" }),
        };
      }
      if (url.includes("/messages?q=")) {
        return {
          ok: true,
          json: async () => ({ messages: [{ id: "msg-1" }] }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          snippet: "Unread Korean summary request should still use headers-first mode.",
          payload: {
            headers: [
              { name: "From", value: "Alice <alice@example.com>" },
              { name: "Subject", value: "Korean routing check" },
              { name: "Date", value: "Thu, 02 Apr 2026 20:00:00 +0900" },
            ],
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await maybeHandleCustomGmailRequest({
      message: "지메일에 접근해서 읽지 않은 메일 5개 요약해줘",
      runtimeClass: "tool-enabled",
    });

    expect(result).toContain("Korean routing check");
    expect(result).toContain("Alice <alice@example.com>");
  });

  it("summarizes unread Gmail messages with headers-first limits", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-tool-"));
    process.env.HOME = homeDir;
    writeRuntimeFiles(
      homeDir,
      {
        email: "zoown13@gmail.com",
        refresh_token: "refresh-token",
      },
      {
        client_id: "client-id",
        client_secret: "client-secret",
      },
    );

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://oauth2.googleapis.com/token") {
        return {
          ok: true,
          json: async () => ({ access_token: "access-token" }),
        };
      }
      if (url.includes("/messages?q=")) {
        return {
          ok: true,
          json: async () => ({ messages: [{ id: "msg-1" }, { id: "msg-2" }] }),
        };
      }
      if (url.includes("/messages/msg-1")) {
        return {
          ok: true,
          json: async () => ({
            snippet: "First unread email snippet that should be trimmed nicely.",
            payload: {
              headers: [
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "Subject", value: "Quarterly update" },
                { name: "Date", value: "Thu, 02 Apr 2026 20:00:00 +0900" },
              ],
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          snippet: "Second unread email snippet.",
          payload: {
            headers: [
              { name: "From", value: "Bob <bob@example.com>" },
              { name: "Subject", value: "Follow-up needed" },
              { name: "Date", value: "Thu, 02 Apr 2026 18:30:00 +0900" },
            ],
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await maybeHandleCustomGmailRequest({
      message: "Check my Gmail inbox and summarize the latest unread emails.",
      runtimeClass: "tool-enabled",
      emailTokenBudget: {
        mode: "headers-first",
        maxMessages: 2,
        maxSnippetChars: 20,
        maxBodyChars: 100,
        requireExplicitBodyAccess: true,
      },
    });

    expect(result).toContain('query "is:unread newer_than:7d"');
    expect(result).toContain("1. Quarterly update");
    expect(result).toContain("Alice <alice@example.com>");
    expect(result).toContain("Snippet: First unread email…");
    expect(result).toContain("2. Follow-up needed");
  });

  it("builds a targeted month query instead of reusing the default unread query", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-02T13:30:00Z"));

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-tool-"));
    process.env.HOME = homeDir;
    writeRuntimeFiles(
      homeDir,
      {
        email: "zoown13@gmail.com",
        refresh_token: "refresh-token",
      },
      {
        client_id: "client-id",
        client_secret: "client-secret",
      },
    );

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://oauth2.googleapis.com/token") {
        return {
          ok: true,
          json: async () => ({ access_token: "access-token" }),
        };
      }
      return {
        ok: true,
        json: async () => ({ messages: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await maybeHandleCustomGmailRequest({
      message: "3월 카드 명세서 이메일에서 찾아서 요약할래?",
      runtimeClass: "tool-enabled",
    });

    expect(result).toContain('query "after:2026/03/01 before:2026/04/01 카드 명세서"');
    expect(result).not.toContain("is:unread newer_than:7d");
  });
});
