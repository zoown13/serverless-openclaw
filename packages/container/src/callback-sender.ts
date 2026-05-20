import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { ServerMessage } from "@serverless-openclaw/shared";
import { setDefaultResultOrder } from "node:dns";

const TELEGRAM_MAX_LENGTH = 4096;
const TELEGRAM_SEND_ATTEMPTS = 3;
const TELEGRAM_SEND_TIMEOUT_MS = 15_000;

setDefaultResultOrder("ipv4first");

interface TelegramContentQuality {
  textLength: number;
  chunkCount: number;
  hasKoreanPaymentSummary: boolean;
  hasPaymentCoverageDisclosure: boolean;
  hasIssuerBreakdownSignal: boolean;
  hasTopicFilteredPaymentSignal: boolean;
  hasRawInternalError: boolean;
  hasLegacyEnglishPaymentPhrases: boolean;
}

function stripMarkdown(text: string): string {
  return text
    // Code blocks (```...```)
    .replace(/```[\s\S]*?```/g, (m) => m.slice(3, -3).trim())
    // Inline code (`...`)
    .replace(/`([^`]+)`/g, "$1")
    // Bold (**...**  or __...__)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    // Italic (*...* or _..._)
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "$1")
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
    // Strikethrough (~~...~~)
    .replace(/~~(.+?)~~/g, "$1")
    // Links [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    // Heading markers (# ## ### etc.)
    .replace(/^#{1,6}\s+/gm, "");
}

function buildTelegramContentQuality(text: string): TelegramContentQuality {
  const hasKoreanPaymentSummary =
    /(Gmail\s*헤더\/스니펫\s*기준|확인 가능한 합계|헤더\/스니펫 후보)/.test(text);
  const hasPaymentCoverageDisclosure =
    /(후보\s*\d+건을\s*확인|실제로\s*\d+건을\s*스캔|본문과 첨부파일은 열지 않았습니다|합계는.*전체 기준|최대\s*\d+건까지\s*확인)/.test(
      text,
    );
  const hasIssuerBreakdownSignal =
    /(카드사별|카드사|확인된 카드사|삼성카드|현대카드|신한카드|하나카드|우리카드|국민카드|롯데카드|BC카드|NH카드|농협카드|토스뱅크|카카오뱅크|미확인 카드사)/.test(
      text,
    );
  const hasTopicFilteredPaymentSignal =
    /(관련 결제만|일본\/여행|일본|여행|travel|trip|eSIM|esim)/i.test(text) &&
    /(확인 가능한 합계|결제 내역|관련 결제)/.test(text);
  const hasRawInternalError =
    /(missing scope:\s*operator\.write|TaskDefinition is inactive|Cannot read properties|TypeError|ReferenceError|AgentCore runtime failed to process the request|An error occurred)/i.test(
      text,
    );
  const hasLegacyEnglishPaymentPhrases =
    /(I scanned Gmail|I did not open full bodies|Estimated total from visible headers|Observed card issuers|Observed merchants|matched payment message\(s\))/i.test(
      text,
    );

  return {
    textLength: text.length,
    chunkCount: Math.max(1, Math.ceil(text.length / TELEGRAM_MAX_LENGTH)),
    hasKoreanPaymentSummary,
    hasPaymentCoverageDisclosure,
    hasIssuerBreakdownSignal,
    hasTopicFilteredPaymentSignal,
    hasRawInternalError,
    hasLegacyEnglishPaymentPhrases,
  };
}

export function logTelegramContentQuality(text: string): void {
  console.log(
    JSON.stringify({
      component: "callback",
      event: "telegram.delivery.content_quality",
      ...buildTelegramContentQuality(text),
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CallbackSender {
  private client: ApiGatewayManagementApiClient;
  private telegramBotToken?: string;
  private bridgeAuthToken?: string;
  private telegramDeliveryUrl?: string;
  private telegramBuffers = new Map<string, string[]>();

  constructor(
    endpoint: string,
    telegramBotToken?: string,
    bridgeAuthToken?: string,
    telegramDeliveryUrl?: string,
  ) {
    this.client = new ApiGatewayManagementApiClient({ endpoint });
    this.telegramBotToken = telegramBotToken;
    this.bridgeAuthToken = bridgeAuthToken;
    this.telegramDeliveryUrl = telegramDeliveryUrl;
  }

  async send(connectionId: string, data: ServerMessage): Promise<void> {
    if (connectionId.startsWith("telegram:")) {
      await this.handleTelegram(connectionId, data);
      return;
    }

    try {
      await this.client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: JSON.stringify(data),
        }),
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "GoneException") {
        return;
      }
      throw err;
    }
  }

  private async handleTelegram(
    connectionId: string,
    data: ServerMessage,
  ): Promise<void> {
    if (!this.telegramBotToken && !this.canUseTelegramRelay()) return;

    if (data.type === "stream_chunk" && data.content) {
      const buffer = this.telegramBuffers.get(connectionId) ?? [];
      buffer.push(data.content);
      this.telegramBuffers.set(connectionId, buffer);
      return;
    }

    if (data.type === "stream_end") {
      const buffer = this.telegramBuffers.get(connectionId);
      this.telegramBuffers.delete(connectionId);
      if (buffer && buffer.length > 0) {
        await this.sendTelegramMessage(connectionId, buffer.join(""));
      }
      return;
    }

    if (data.type === "error") {
      this.telegramBuffers.delete(connectionId);
      const text = data.error ?? data.content ?? "An error occurred";
      await this.sendTelegramMessage(connectionId, text);
      return;
    }
  }

  private async sendTelegramMessage(
    connectionId: string,
    text: string,
  ): Promise<void> {
    const chatId = connectionId.slice(9); // Remove "telegram:" prefix
    const plain = stripMarkdown(text);
    logTelegramContentQuality(plain);
    for (let i = 0; i < plain.length; i += TELEGRAM_MAX_LENGTH) {
      const chunk = plain.slice(i, i + TELEGRAM_MAX_LENGTH);
      if (this.canUseTelegramRelay()) {
        await this.sendTelegramMessageViaRelay(connectionId, chunk);
        continue;
      }

      if (!this.telegramBotToken) {
        console.warn("[callback] Telegram delivery unavailable; no relay or bot token configured");
        return;
      }

      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= TELEGRAM_SEND_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TELEGRAM_SEND_TIMEOUT_MS);
        try {
          const resp = await fetch(
            `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: chunk }),
              signal: controller.signal,
            },
          );
          if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            console.error(
              `[callback] Telegram API error ${resp.status} for ${connectionId}`,
            );
            throw new Error(
              body
                ? `Telegram delivery failed (${resp.status}): ${body}`
                : `Telegram delivery failed with status ${resp.status}`,
            );
          }
          lastError = undefined;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = new Error(
            `Telegram delivery network failed after ${attempt}/${TELEGRAM_SEND_ATTEMPTS} attempt(s): ${message}`,
          );
          if (message.startsWith("Telegram delivery failed")) {
            throw lastError;
          }
          if (attempt < TELEGRAM_SEND_ATTEMPTS) {
            console.warn(
              `[callback] Telegram delivery attempt ${attempt}/${TELEGRAM_SEND_ATTEMPTS} failed for ${connectionId}: ${message}`,
            );
            await sleep(750 * attempt);
            continue;
          }
        } finally {
          clearTimeout(timeout);
        }
      }
      if (lastError) {
        console.error(
          `[callback] Failed to send Telegram message for ${connectionId}: ${lastError.message}`,
        );
        throw lastError;
      }
    }
  }

  private canUseTelegramRelay(): boolean {
    return Boolean(this.telegramDeliveryUrl && this.bridgeAuthToken);
  }

  private async sendTelegramMessageViaRelay(
    connectionId: string,
    text: string,
  ): Promise<void> {
    const response = await fetch(this.telegramDeliveryUrl!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bridgeAuthToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ connectionId, text }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        body
          ? `Telegram delivery relay failed (${response.status}): ${body.slice(0, 200)}`
          : `Telegram delivery relay failed with status ${response.status}`,
      );
    }
  }
}
