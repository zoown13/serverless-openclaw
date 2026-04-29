import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

interface SecretMapping {
  envName: string;
  pathEnvName: string;
  required?: boolean;
}

const SECRET_MAPPINGS: SecretMapping[] = [
  {
    envName: "OPENCLAW_GATEWAY_TOKEN",
    pathEnvName: "SSM_OPENCLAW_GATEWAY_TOKEN",
    required: true,
  },
  {
    envName: "BRIDGE_AUTH_TOKEN",
    pathEnvName: "SSM_BRIDGE_AUTH_TOKEN",
  },
  {
    envName: "ANTHROPIC_API_KEY",
    pathEnvName: "SSM_ANTHROPIC_API_KEY",
  },
  {
    envName: "TELEGRAM_BOT_TOKEN",
    pathEnvName: "SSM_TELEGRAM_BOT_TOKEN",
  },
  {
    envName: "OPENCLAW_AUTH_PROFILES_JSON",
    pathEnvName: "SSM_OPENCLAW_AUTH_PROFILES_JSON",
  },
  {
    envName: "OPENCLAW_OAUTH_JSON",
    pathEnvName: "SSM_OPENCLAW_OAUTH_JSON",
  },
  {
    envName: "GOOGLE_OAUTH_CLIENT_JSON",
    pathEnvName: "SSM_GOOGLE_OAUTH_CLIENT_JSON",
  },
];

const ssm = new SSMClient({});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function resolveSecret(mapping: SecretMapping): Promise<string | undefined> {
  const existing = process.env[mapping.envName];
  if (existing) {
    return existing;
  }

  const parameterName = process.env[mapping.pathEnvName];
  if (!parameterName) {
    if (mapping.required) {
      throw new Error(`Missing required AgentCore secret path: ${mapping.pathEnvName}`);
    }
    return undefined;
  }

  const result = await ssm.send(
    new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    }),
  ).catch((error: unknown) => {
    if (!mapping.required && isParameterNotFoundError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!result) {
    return undefined;
  }
  const value = result.Parameter?.Value;
  if (!value && mapping.required) {
    throw new Error(`SSM parameter returned no value: ${parameterName}`);
  }
  return value;
}

export function isParameterNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as Record<string, unknown>;
  return record.name === "ParameterNotFound" ||
    record.__type === "ParameterNotFound";
}

async function main(): Promise<void> {
  for (const mapping of SECRET_MAPPINGS) {
    const value = await resolveSecret(mapping);
    if (value !== undefined) {
      process.stdout.write(`export ${mapping.envName}=${shellQuote(value)}\n`);
    }
  }
}

if (process.argv[1]?.endsWith("resolve-agentcore-env.js")) {
  main().catch((error) => {
    console.error("[agentcore-env] Failed to resolve runtime secrets:", error);
    process.exit(1);
  });
}
