import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  SESSION_DEFAULT_AGENT,
  SESSION_S3_PREFIX,
  type CostEstimate,
} from "@serverless-openclaw/shared";

const SAFE_ID = /^[a-zA-Z0-9_:-]{1,180}$/;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export interface RecentCostContext {
  version: 1;
  userId: string;
  sessionId: string;
  estimate: CostEstimate;
  createdAt: string;
  expiresAt: string;
}

function validateId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`Invalid ${name}: must be 1-180 alphanumeric/dash/underscore/colon characters`);
  }
}

function parseTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.TOOL_RECENT_COST_CONTEXT_TTL_SECONDS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

async function bodyToString(body: unknown): Promise<string> {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToString" in body &&
    typeof (body as { transformToString?: unknown }).transformToString === "function"
  ) {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  return String(body);
}

export class RecentCostContextStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(bucket: string) {
    this.s3 = new S3Client({});
    this.bucket = bucket;
  }

  async save(userId: string, sessionId: string, estimate: CostEstimate): Promise<RecentCostContext> {
    const now = new Date();
    const item: RecentCostContext = {
      version: 1,
      userId,
      sessionId,
      estimate,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + parseTtlSeconds() * 1000).toISOString(),
    };

    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.getS3Key(userId, sessionId),
      Body: JSON.stringify(item),
      ContentType: "application/json",
    }));

    return item;
  }

  async load(userId: string, sessionId: string): Promise<RecentCostContext | undefined> {
    try {
      const response = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.getS3Key(userId, sessionId),
      }));
      const raw = await bodyToString(response.Body);
      const parsed = JSON.parse(raw) as RecentCostContext;
      if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
        return undefined;
      }
      return parsed;
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === "NoSuchKey" || err.name === "NotFound" || err.message.includes("NoSuchKey"))
      ) {
        return undefined;
      }
      throw err;
    }
  }

  private getS3Key(userId: string, sessionId: string): string {
    validateId(userId, "userId");
    validateId(sessionId, "sessionId");
    return `${SESSION_S3_PREFIX}/${userId}/agents/${SESSION_DEFAULT_AGENT}/recent-cost/${sessionId}.json`;
  }
}
