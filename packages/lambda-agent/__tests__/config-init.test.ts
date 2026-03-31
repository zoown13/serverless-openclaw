import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveProviderConfig } from "@serverless-openclaw/shared";
import { initConfig } from "../src/config-init.js";

describe("config-init", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lambda-agent-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create .openclaw directory structure", async () => {
    await initConfig({
      runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "bedrock" }),
    });

    const openclawDir = path.join(tmpDir, ".openclaw");
    expect(fs.existsSync(openclawDir)).toBe(true);
  });

  it("should create openclaw.json with minimal config", async () => {
    await initConfig({
      runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "bedrock" }),
    });

    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.gateway).toEqual({ mode: "local" });
  });

  it("should create agents/default/sessions directory", async () => {
    await initConfig({
      runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "bedrock" }),
    });

    const sessionsDir = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "default",
      "sessions",
    );
    expect(fs.existsSync(sessionsDir)).toBe(true);
  });

  it("should set ANTHROPIC_API_KEY env var when provided", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    try {
      await initConfig({
        anthropicApiKey: "test-key-123",
        runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "anthropic" }),
      });
      expect(process.env.ANTHROPIC_API_KEY).toBe("test-key-123");
    } finally {
      if (originalKey) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("should clear ANTHROPIC_API_KEY for bedrock runtime", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = "existing-key";
      await initConfig({
        runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "bedrock" }),
      });
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (originalKey) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("should be idempotent (safe to call multiple times)", async () => {
    const runtimeConfig = resolveProviderConfig({ AI_PROVIDER: "bedrock" });
    await initConfig({ runtimeConfig });
    await initConfig({ runtimeConfig });

    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.gateway.mode).toBe("local");
  });

  it("should return the config directory path", async () => {
    const result = await initConfig({
      runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "bedrock" }),
    });
    expect(result.configDir).toBe(path.join(tmpDir, ".openclaw"));
    expect(result.sessionsDir).toBe(
      path.join(tmpDir, ".openclaw", "agents", "default", "sessions"),
    );
    expect(result.sessionNamespace).toBe("bedrock-chat");
    expect(result.gmailReady).toBe(false);
    expect(result.toolRuntimeReady).toBe(false);
  });

  it("should downgrade anthropic runtime to chat-only when OAuth secret is missing", async () => {
    const result = await initConfig({
      anthropicApiKey: "test-key-123",
      runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "anthropic" }),
    });

    expect(result.gmailReady).toBe(false);
    expect(result.toolRuntimeReady).toBe(false);
    expect(result.sessionNamespace).toBe("anthropic-chat");
  });

  it("should keep gmailReady false when only Google client JSON is provided", async () => {
    const result = await initConfig({
      anthropicApiKey: "test-key-123",
      runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "anthropic" }),
      googleOauthClientJson: JSON.stringify({
        web: { client_id: "client-id", client_secret: "client-secret" },
      }),
    });

    expect(result.gmailReady).toBe(false);
    expect(result.toolRuntimeReady).toBe(false);
    expect(result.sessionNamespace).toBe("anthropic-chat");
  });

  it("should keep cold start alive when OAuth JSON is malformed", async () => {
    const result = await initConfig({
      anthropicApiKey: "test-key-123",
      runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "anthropic" }),
      openclawOauthJson: "{not-json",
    });

    expect(result.gmailReady).toBe(false);
    expect(result.toolRuntimeReady).toBe(false);
    expect(result.sessionNamespace).toBe("anthropic-chat");
  });

  it("should enable tool runtime when valid OAuth JSON is provided", async () => {
    const result = await initConfig({
      anthropicApiKey: "test-key-123",
      runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "anthropic" }),
      openclawOauthJson: JSON.stringify({ refresh_token: "refresh-token" }),
    });

    expect(result.gmailReady).toBe(true);
    expect(result.toolRuntimeReady).toBe(true);
    expect(result.sessionNamespace).toBe("anthropic-tools");
  });

  it("should fail fast for anthropic runtime without key or auth profiles", async () => {
    await expect(
      initConfig({
        runtimeConfig: resolveProviderConfig({ AI_PROVIDER: "anthropic" }),
      }),
    ).rejects.toThrow("Anthropic runtime requires anthropicApiKey or openclawAuthProfilesJson");
  });
});
