import { createHash, createHmac } from "node:crypto";
import type {
  BridgeMessageRequest,
  Channel,
  EmailTokenBudgetPolicy,
  RuntimeClass,
} from "@serverless-openclaw/shared";

export interface InvokeAgentCoreRuntimeParams {
  runtimeArn: string;
  region?: string;
  qualifier?: string;
  userId: string;
  sessionId?: string;
  traceId?: string;
  message: string;
  channel: Channel;
  connectionId: string;
  callbackUrl: string;
  runtimeClass: RuntimeClass;
  emailTokenBudget?: EmailTokenBudgetPolicy;
  fetchFn?: typeof fetch;
  now?: Date;
}

export interface AgentCoreRuntimeResult {
  accepted: true;
  content?: string;
}

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const SERVICE_NAME = "bedrock-agentcore";
const DEFAULT_REGION = "ap-northeast-2";
const AGENTCORE_INVOKE_TIMEOUT_MS = 25_000;

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function toAmzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function toDateStamp(amzDate: string): string {
  return amzDate.slice(0, 8);
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function getCredentialsFromEnv(): AwsCredentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS credentials unavailable for AgentCore runtime invocation");
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

export function buildAgentCoreRuntimeSessionId(params: {
  userId: string;
  channel: Channel;
  sessionId?: string;
}): string {
  const logicalSession = params.sessionId ?? `session-${params.userId}`;
  return `soc-${hashHex(`${params.userId}|${params.channel}|${logicalSession}`)}`;
}

function normalizeHeaders(headers: Record<string, string>): {
  canonicalHeaders: string;
  signedHeaders: string;
} {
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  return {
    canonicalHeaders: entries.map(([key, value]) => `${key}:${value}\n`).join(""),
    signedHeaders: entries.map(([key]) => key).join(";"),
  };
}

function createAuthorizationHeader(params: {
  method: string;
  canonicalUri: string;
  canonicalQueryString: string;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  amzDate: string;
  credentials: AwsCredentials;
}): string {
  const dateStamp = toDateStamp(params.amzDate);
  const credentialScope = `${dateStamp}/${params.region}/${SERVICE_NAME}/aws4_request`;
  const { canonicalHeaders, signedHeaders } = normalizeHeaders(params.headers);
  const canonicalRequest = [
    params.method,
    params.canonicalUri,
    params.canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    params.payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    params.amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${params.credentials.secretAccessKey}`, dateStamp),
        params.region,
      ),
      SERVICE_NAME,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return [
    `AWS4-HMAC-SHA256 Credential=${params.credentials.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
}

function extractTextFromAgentCoreResponse(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextFromAgentCoreResponse(item))
      .filter((item): item is string => Boolean(item))
      .join("");
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["content", "message", "text", "output", "response"]) {
    const extracted = extractTextFromAgentCoreResponse(record[key]);
    if (extracted) return extracted;
  }

  const payload = record.payload;
  if (typeof payload === "string") {
    try {
      return extractTextFromAgentCoreResponse(JSON.parse(payload));
    } catch {
      return payload.trim() || undefined;
    }
  }

  return undefined;
}

function parseAgentCoreResponseText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return extractTextFromAgentCoreResponse(JSON.parse(trimmed)) ?? trimmed;
  } catch {
    return trimmed;
  }
}

export async function invokeAgentCoreRuntime(
  params: InvokeAgentCoreRuntimeParams,
): Promise<AgentCoreRuntimeResult> {
  const region = params.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? DEFAULT_REGION;
  const runtimeArn = params.runtimeArn.trim();
  if (!runtimeArn) {
    throw new Error("AgentCore runtime ARN is not configured");
  }

  const sessionId = buildAgentCoreRuntimeSessionId({
    userId: params.userId,
    channel: params.channel,
    sessionId: params.sessionId,
  });
  const body: BridgeMessageRequest = {
    userId: params.userId,
    message: params.message,
    channel: params.channel,
    connectionId: params.connectionId,
    callbackUrl: params.callbackUrl,
    traceId: params.traceId,
    runtimeClass: params.runtimeClass,
    routeDecision: "agentcore",
    emailTokenBudget: params.emailTokenBudget,
  };
  const payload = JSON.stringify(body);
  const payloadHash = hashHex(payload);
  const host = `${SERVICE_NAME}.${region}.amazonaws.com`;
  const requestUri = `/runtimes/${encodeURIComponent(runtimeArn)}/invocations`;
  const canonicalUri = requestUri.replace(/%/g, "%25");
  const canonicalQueryString = params.qualifier
    ? `qualifier=${encodeQueryValue(params.qualifier)}`
    : "";
  const url = `https://${host}${requestUri}${canonicalQueryString ? `?${canonicalQueryString}` : ""}`;
  const amzDate = toAmzDate(params.now ?? new Date());
  const credentials = getCredentialsFromEnv();
  const signedHeaders: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    host,
    "x-amz-date": amzDate,
    "x-amzn-bedrock-agentcore-runtime-session-id": sessionId,
  };
  if (credentials.sessionToken) {
    signedHeaders["x-amz-security-token"] = credentials.sessionToken;
  }
  const authorization = createAuthorizationHeader({
    method: "POST",
    canonicalUri,
    canonicalQueryString,
    headers: signedHeaders,
    payloadHash,
    region,
    amzDate,
    credentials,
  });

  const resp = await (params.fetchFn ?? fetch)(url, {
    method: "POST",
    headers: {
      ...signedHeaders,
      Authorization: authorization,
    },
    body: payload,
    signal: AbortSignal.timeout(AGENTCORE_INVOKE_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const details = await resp.text().catch(() => "");
    const suffix = details.trim() ? `: ${details.trim().slice(0, 300)}` : "";
    throw new Error(`AgentCore runtime returned ${resp.status}${suffix}`);
  }

  return {
    accepted: true,
    content: parseAgentCoreResponseText(await resp.text()),
  };
}
