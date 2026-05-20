import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  SESSION_DEFAULT_AGENT,
  SESSION_S3_PREFIX,
  type LambdaAgentImageInput,
} from "@serverless-openclaw/shared";

const SAFE_ID = /^[a-zA-Z0-9_:-]{1,160}$/;
const DEFAULT_TTL_SECONDS = 10 * 60;

export interface RecentImageContext {
  version: 1;
  userId: string;
  sessionId: string;
  imageInput: LambdaAgentImageInput;
  lastPrompt: string;
  createdAt: string;
  expiresAt: string;
}

function validateId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`Invalid ${name}: must be 1-160 alphanumeric/dash/underscore/colon characters`);
  }
}

function parseTtlSeconds(): number {
  const parsed = Number.parseInt(
    process.env.LAMBDA_RECENT_IMAGE_CONTEXT_TTL_SECONDS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

function isNoSuchKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "NoSuchKey"
  );
}

export class RecentImageContextStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(bucket: string) {
    this.s3 = new S3Client({});
    this.bucket = bucket;
  }

  async save(
    userId: string,
    sessionId: string,
    imageInput: LambdaAgentImageInput,
    lastPrompt: string,
  ): Promise<RecentImageContext> {
    const now = new Date();
    const item: RecentImageContext = {
      version: 1,
      userId,
      sessionId,
      imageInput,
      lastPrompt,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + parseTtlSeconds() * 1000).toISOString(),
    };

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.getS3Key(userId, sessionId),
        Body: JSON.stringify(item),
        ContentType: "application/json",
      }),
    );

    return item;
  }

  async load(userId: string, sessionId: string): Promise<RecentImageContext | null> {
    const key = this.getS3Key(userId, sessionId);
    try {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const raw = await response.Body!.transformToString();
      const parsed = JSON.parse(raw) as RecentImageContext;
      if (Date.parse(parsed.expiresAt) <= Date.now()) {
        await this.deleteByKey(key).catch(() => undefined);
        return null;
      }
      return parsed;
    } catch (err: unknown) {
      if (isNoSuchKeyError(err)) {
        return null;
      }
      throw err;
    }
  }

  private async deleteByKey(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  private getS3Key(userId: string, sessionId: string): string {
    validateId(userId, "userId");
    validateId(sessionId, "sessionId");
    return `${SESSION_S3_PREFIX}/${userId}/agents/${SESSION_DEFAULT_AGENT}/recent-images/${sessionId}.json`;
  }
}
