import fs from "node:fs";
import path from "node:path";
import {
  applyRuntimeReadiness,
  resolveProviderConfig,
  type ResolvedRuntimeConfig,
} from "@serverless-openclaw/shared";
import type { ConfigInitResult } from "./types.js";

interface InitConfigOptions {
  anthropicApiKey?: string;
  runtimeConfig?: ResolvedRuntimeConfig;
  openclawAuthProfilesJson?: string;
  openclawOauthJson?: string;
  googleOauthClientJson?: string;
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid ${label} JSON`);
  }
}

function parseOptionalJson<T>(raw: string, label: string): T | undefined {
  try {
    return parseJson<T>(raw, label);
  } catch (err) {
    console.warn(`[config-init] Skipping invalid ${label}:`, err);
    return undefined;
  }
}

function writeAuthProfiles(
  defaultAgentDir: string,
  mainAgentDir: string,
  payload: unknown,
): void {
  const json = JSON.stringify(payload);
  fs.writeFileSync(path.join(defaultAgentDir, "auth-profiles.json"), json, "utf-8");
  fs.writeFileSync(path.join(mainAgentDir, "auth-profiles.json"), json, "utf-8");
}

function buildAnthropicAuthProfiles(apiKey: string) {
  return {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: apiKey,
      },
    },
    order: {
      anthropic: ["anthropic:default"],
    },
    lastGood: {
      anthropic: "anthropic:default",
    },
  };
}

/**
 * Initialize OpenClaw config and directory structure in $HOME/.openclaw.
 * Sets HOME=/tmp in Lambda so OpenClaw reads from /tmp/.openclaw/.
 *
 * Idempotent — safe to call multiple times.
 */
export async function initConfig(
  options?: InitConfigOptions,
): Promise<ConfigInitResult> {
  const runtimeConfig = options?.runtimeConfig ?? resolveProviderConfig();
  const home = process.env.HOME ?? "/tmp";
  const configDir = path.join(home, ".openclaw");
  const sessionsDir = path.join(configDir, "agents", "default", "sessions");
  const defaultAgentDir = path.join(configDir, "agents", "default", "agent");
  const mainAgentDir = path.join(configDir, "agents", "main", "agent");
  const credentialsDir = path.join(configDir, "credentials");
  const gogConfigDir = path.join(home, ".config", "gogcli");

  // Create directory structure
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(defaultAgentDir, { recursive: true });
  fs.mkdirSync(mainAgentDir, { recursive: true });
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.mkdirSync(gogConfigDir, { recursive: true });

  // Write minimal config optimized for Lambda execution:
  // - gateway.mode: "local" — no WS server needed
  // - models.bedrockDiscovery: always disabled — model selection is explicit via resolveBedrockModel()
  const configPath = path.join(configDir, "openclaw.json");
  const isBedrock = runtimeConfig.provider === "bedrock";
  const primaryModel = `${runtimeConfig.openclawProvider}/${runtimeConfig.defaultModel}`;
  const config: Record<string, unknown> = {
    gateway: { mode: "local" },
    models: { bedrockDiscovery: { enabled: false } },
    agents: {
      defaults: {
        model: {
          primary: primaryModel,
        },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

  // Optional: hydrate OpenClaw auth stores from SSM-provided JSON blobs.
  // This stabilizes OAuth/API-key auth across Lambda cold starts.
  // Bedrock authenticates via the Lambda IAM role, so its reserved auth-profile
  // secret may legitimately be empty or a deployment placeholder.
  let wroteAuthProfiles = false;
  if (!isBedrock && options?.openclawAuthProfilesJson) {
    const authProfiles = parseOptionalJson<unknown>(
      options.openclawAuthProfilesJson,
      "openclaw auth-profiles",
    );
    if (authProfiles !== undefined) {
      writeAuthProfiles(defaultAgentDir, mainAgentDir, authProfiles);
      wroteAuthProfiles = true;
    }
  }

  // Optional: hydrate legacy OAuth file used by OpenClaw migration path.
  if (options?.openclawOauthJson) {
    const oauth = parseOptionalJson<unknown>(options.openclawOauthJson, "openclaw oauth");
    if (oauth !== undefined) {
      fs.writeFileSync(
        path.join(credentialsDir, "oauth.json"),
        JSON.stringify(oauth),
        "utf-8",
      );
    }
  }

  // Optional: hydrate Google OAuth client credentials for gog/gmail tooling.
  if (options?.googleOauthClientJson) {
    const gogCreds = parseOptionalJson<unknown>(
      options.googleOauthClientJson,
      "google oauth client",
    );
    if (gogCreds !== undefined) {
      fs.writeFileSync(
        path.join(gogConfigDir, "credentials.json"),
        JSON.stringify(gogCreds),
        "utf-8",
      );
    }
  }

  // Set API key via environment variable (OpenClaw reads from env)
  // Skip when using Bedrock — it authenticates via IAM role credentials
  if (isBedrock || !options?.anthropicApiKey) {
    delete process.env.ANTHROPIC_API_KEY;
  }

  if (!isBedrock && !options?.anthropicApiKey && !wroteAuthProfiles) {
    throw new Error(
      "Anthropic runtime requires anthropicApiKey or openclawAuthProfilesJson",
    );
  }

  if (!isBedrock && options?.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = options.anthropicApiKey;
  }

  if (!isBedrock && options?.anthropicApiKey && !wroteAuthProfiles) {
    writeAuthProfiles(
      defaultAgentDir,
      mainAgentDir,
      buildAnthropicAuthProfiles(options.anthropicApiKey),
    );
  }

  const gmailReady = options?.openclawOauthJson
    ? parseOptionalJson<unknown>(
      options.openclawOauthJson,
      "openclaw oauth readiness",
    ) !== undefined
    : false;
  const toolRuntimeReady =
    runtimeConfig.capability === "tool-enabled" && gmailReady;
  const resolvedRuntimeConfig = applyRuntimeReadiness(
    runtimeConfig,
    {
      chatReady: true,
      toolRuntimeReady,
      gmailReady,
    },
    runtimeConfig.capability,
  );

  return {
    configDir,
    sessionsDir,
    config,
    runtimeConfig: resolvedRuntimeConfig,
    gmailReady: resolvedRuntimeConfig.readiness.gmailReady,
    toolRuntimeReady: resolvedRuntimeConfig.readiness.toolRuntimeReady,
    sessionNamespace: resolvedRuntimeConfig.sessionNamespace,
  };
}
