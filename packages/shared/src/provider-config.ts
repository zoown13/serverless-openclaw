import type { Channel } from "./types.js";

export type AiProvider = "anthropic" | "bedrock";
export type RuntimeCapability = "chat-only" | "tool-enabled";

export interface EmailTokenBudget {
  mode: "headers-first";
  maxMessages: number;
  paymentScanMessages: number;
  maxSnippetChars: number;
  maxBodyChars: number;
  requireExplicitBodyAccess: boolean;
}

export interface RuntimeReadiness {
  chatReady: boolean;
  toolRuntimeReady: boolean;
  gmailReady: boolean;
}

export interface SecretContract {
  requiresAnthropicApiKey: boolean;
  supportsOpenclawAuthProfiles: boolean;
  supportsOpenclawOauth: boolean;
  supportsGoogleOauthClient: boolean;
}

export interface ProviderConfig {
  provider: AiProvider;
  openclawProvider: string;
  openclawApi: string;
  openclawAuth: string;
  defaultModel: string;
}

interface ProviderRuntimeEnv {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AWS_REGION?: string;
  GMAIL_TOOL_MAX_MESSAGES?: string;
  GMAIL_PAYMENT_MAX_SCAN_MESSAGES?: string;
  GMAIL_TOOL_MAX_SNIPPET_CHARS?: string;
  GMAIL_TOOL_MAX_BODY_CHARS?: string;
  GMAIL_TOOL_REQUIRE_EXPLICIT_BODY?: string;
}

export interface ResolvedRuntimeConfig extends ProviderConfig {
  capability: RuntimeCapability;
  sessionNamespace: string;
  readiness: RuntimeReadiness;
  emailTokenBudget: EmailTokenBudget;
  secretContract: SecretContract;
}

// Safe Bedrock default verified with the embedded OpenClaw Lambda runtime.
// Keep this explicit instead of deriving a regional CRIS profile so a missing
// AI_MODEL cannot fall back to an OpenClaw-unknown model.
export const BEDROCK_DEFAULT_MODEL =
  "global.anthropic.claude-haiku-4-5-20251001-v1:0";
export const BEDROCK_BASE_MODEL = BEDROCK_DEFAULT_MODEL;

// Maps AWS region → cross-region inference system (CRIS) geographic prefix.
// Bedrock uses these prefixes to route requests within a geographic boundary.
// Regions not listed here have no CRIS support — base model ID is used directly.
const REGION_CRIS_PREFIX: Record<string, string> = {
  // United States
  "us-east-1": "us",
  "us-east-2": "us",
  "us-west-1": "us",
  "us-west-2": "us",
  "ca-central-1": "us",
  "ca-west-1": "us",
  // Europe
  "eu-central-1": "eu",
  "eu-west-1": "eu",
  "eu-west-2": "eu",
  "eu-west-3": "eu",
  "eu-north-1": "eu",
  "eu-south-1": "eu",
  "eu-south-2": "eu",
  // Asia Pacific
  "ap-northeast-1": "apac",
  "ap-northeast-2": "apac",
  "ap-northeast-3": "apac",
  "ap-south-1": "apac",
  "ap-south-2": "apac",
  "ap-southeast-1": "apac",
  "ap-southeast-2": "apac",
  "ap-southeast-3": "apac",
  "ap-southeast-4": "apac",
  "ap-southeast-5": "apac",
  "ap-southeast-7": "apac",
};

export const PROVIDER_DEFAULTS = {
  anthropic: {
    openclawProvider: "anthropic",
    openclawApi: "anthropic",
    openclawAuth: "api-key",
    defaultModel: "claude-sonnet-4-20250514",
  },
  bedrock: {
    openclawProvider: "amazon-bedrock",
    openclawApi: "bedrock-converse-stream",
    openclawAuth: "aws-sdk",
  },
} as const;

const VALID_PROVIDERS: readonly string[] = ["anthropic", "bedrock"];

export function validateProvider(value: string): asserts value is AiProvider {
  if (!VALID_PROVIDERS.includes(value)) {
    throw new Error(
      `Unsupported AI_PROVIDER: '${value}'. Valid values: anthropic, bedrock`,
    );
  }
}

/**
 * Returns the CRIS geographic prefix for a given AWS region, or undefined
 * if the region does not have a cross-region inference system prefix.
 */
export function resolveCrisPrefix(region?: string): string | undefined {
  if (!region) return undefined;
  return REGION_CRIS_PREFIX[region];
}

/**
 * Resolves the Bedrock model ID to use.
 * If aiModel is explicitly set, returns it as-is. Otherwise returns the
 * verified global Haiku 4.5 inference profile used by the Lambda chat path.
 */
export function resolveBedrockModel(region?: string, aiModel?: string): string {
  if (aiModel) return aiModel;
  void region;
  return BEDROCK_DEFAULT_MODEL;
}

export function resolveModel(provider: "anthropic", aiModel?: string): string {
  return aiModel || PROVIDER_DEFAULTS[provider].defaultModel;
}

export function resolveRuntimeCapability(provider: AiProvider): RuntimeCapability {
  return provider === "bedrock" ? "chat-only" : "tool-enabled";
}

export function resolveSessionNamespace(
  provider: AiProvider,
  capability: RuntimeCapability,
): string {
  return `${provider}-${capability === "tool-enabled" ? "tools" : "chat"}`;
}

export function buildRuntimeReadiness(
  capability: RuntimeCapability,
  overrides: Partial<RuntimeReadiness> = {},
): RuntimeReadiness {
  return {
    chatReady: true,
    toolRuntimeReady: capability === "tool-enabled",
    gmailReady: false,
    ...overrides,
  };
}

export function applyRuntimeReadiness(
  config: ResolvedRuntimeConfig,
  readiness: RuntimeReadiness,
  requestedCapability: RuntimeCapability = config.capability,
): ResolvedRuntimeConfig {
  const capability = readiness.toolRuntimeReady ? requestedCapability : "chat-only";

  return {
    ...config,
    capability,
    sessionNamespace: resolveSessionNamespace(config.provider, capability),
    readiness,
  };
}

export function buildRuntimeSessionId(
  config: Pick<ResolvedRuntimeConfig, "sessionNamespace">,
  channel: Channel,
  baseSessionId: string,
): string {
  return `${config.sessionNamespace}:${channel}:${baseSessionId}`;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function resolveEmailTokenBudget(env?: ProviderRuntimeEnv): EmailTokenBudget {
  const resolved = (env ?? process.env) as ProviderRuntimeEnv;

  return {
    mode: "headers-first",
    maxMessages: parsePositiveInteger(resolved.GMAIL_TOOL_MAX_MESSAGES, 5),
    paymentScanMessages: parsePositiveInteger(
      resolved.GMAIL_PAYMENT_MAX_SCAN_MESSAGES,
      25,
    ),
    maxSnippetChars: parsePositiveInteger(
      resolved.GMAIL_TOOL_MAX_SNIPPET_CHARS,
      240,
    ),
    maxBodyChars: parsePositiveInteger(
      resolved.GMAIL_TOOL_MAX_BODY_CHARS,
      1600,
    ),
    requireExplicitBodyAccess: parseBooleanFlag(
      resolved.GMAIL_TOOL_REQUIRE_EXPLICIT_BODY,
      true,
    ),
  };
}

export function resolveProviderConfig(
  env?: ProviderRuntimeEnv,
): ResolvedRuntimeConfig {
  const resolved = (env ?? process.env) as ProviderRuntimeEnv;
  const raw = resolved.AI_PROVIDER ?? "anthropic";
  validateProvider(raw);

  const defaults = PROVIDER_DEFAULTS[raw];

  const defaultModel =
    raw === "bedrock"
      ? resolveBedrockModel(resolved.AWS_REGION, resolved.AI_MODEL)
      : resolveModel(raw, resolved.AI_MODEL);

  const capability = resolveRuntimeCapability(raw);

  return {
    provider: raw,
    openclawProvider: defaults.openclawProvider,
    openclawApi: defaults.openclawApi,
    openclawAuth: defaults.openclawAuth,
    defaultModel,
    capability,
    sessionNamespace: resolveSessionNamespace(raw, capability),
    readiness: buildRuntimeReadiness(capability),
    emailTokenBudget: resolveEmailTokenBudget(resolved),
    secretContract: {
      requiresAnthropicApiKey: raw === "anthropic",
      supportsOpenclawAuthProfiles: true,
      supportsOpenclawOauth: true,
      supportsGoogleOauthClient: true,
    },
  };
}
