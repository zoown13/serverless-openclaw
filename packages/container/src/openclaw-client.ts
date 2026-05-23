import WebSocket from "ws";
import { randomUUID } from "node:crypto";

interface PendingChat {
  resolve: () => void;
  reject: (reason: Error) => void;
  chunks: string[];
  chunkResolve: ((value: IteratorResult<string>) => void) | null;
  chunkReject: ((reason: Error) => void) | null;
  lastTextLength: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReqHandler = { resolve: (payload: any) => void; reject: (err: Error) => void };

export class OpenClawClient {
  readonly gatewayUrl: string;
  ws: WebSocket | null = null;
  private token: string;
  private nextId = 1;
  private sessionKey = "";
  private pendingRequests = new Map<string, ReqHandler>();
  private activeRuns = new Map<string, PendingChat>();
  private readyResolve!: () => void;
  private readyReject!: (reason: Error) => void;
  private readyPromise: Promise<void>;
  private ready = false;
  private closed = false;
  private connectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl: string, token: string) {
    this.gatewayUrl = baseUrl;
    this.token = token;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.connect();
  }

  waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  private connect(): void {
    if (this.closed) {
      return;
    }

    const socket = new WebSocket(this.gatewayUrl);
    this.ws = socket;

    socket.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this.ready && this.isRetryableConnectFailure(error.message)) {
        this.scheduleReconnect(error.message, socket);
        return;
      }
      this.readyReject(error);
    });

    socket.on("close", () => {
      if (!this.ready && !this.closed) {
        this.scheduleReconnect("gateway websocket closed before ready", socket);
      }
    });

    socket.on("message", (raw: WebSocket.Data) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = JSON.parse(raw.toString()) as any;

      // Gateway connect challenge — respond with connect request
      if (msg.type === "event" && msg.event === "connect.challenge") {
        const connectReq = {
          type: "req",
          id: "connect-1",
          method: "connect",
          params: {
            minProtocol: 1,
            maxProtocol: 3,
            client: {
              id: "gateway-client",
              version: "1.0.0",
              platform: "linux",
              mode: "backend",
            },
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            caps: [],
            commands: [],
            permissions: {},
            auth: { token: this.token },
            locale: "en-US",
            userAgent: "serverless-openclaw-bridge/1.0",
          },
        };
        socket.send(JSON.stringify(connectReq));
        return;
      }

      // Gateway hello-ok — handshake complete
      if (msg.type === "res" && msg.id === "connect-1" && msg.ok === true) {
        if (msg.payload?.type === "hello-ok") {
          this.sessionKey =
            msg.payload?.snapshot?.sessionDefaults?.mainSessionKey ?? "main";
          console.log(
            "Gateway handshake complete, sessionKey:",
            this.sessionKey,
          );
          this.ready = true;
          this.connectAttempts = 0;
          this.readyResolve();
          return;
        }
      }

      // Gateway connect error
      if (msg.type === "res" && msg.id === "connect-1" && msg.ok === false) {
        const errorMessage = msg.error?.message ?? JSON.stringify(msg);
        if (this.isRetryableConnectFailure(errorMessage)) {
          this.scheduleReconnect(errorMessage, socket);
          return;
        }
        this.readyReject(new Error(`Gateway connect failed: ${errorMessage}`));
        return;
      }

      // Response to a pending request (chat.send → runId)
      if (msg.type === "res" && msg.id && msg.id !== "connect-1") {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          if (msg.ok === true) {
            pending.resolve(msg.payload);
          } else {
            pending.reject(
              new Error(msg.error?.message ?? "Request failed"),
            );
          }
        }
        return;
      }

      // Agent streaming event — carries cumulative text per token
      if (msg.type === "event" && msg.event === "agent") {
        const payload = msg.payload;
        if (!payload) return;
        const runId = (payload?.runId ?? payload?.run) as string;
        if (!runId) return;
        const run = this.activeRuns.get(runId);
        if (!run) return;

        if (payload.stream === "assistant" && payload.data != null) {
          const fullText = extractTextContent(payload.data);
          const delta = fullText.slice(run.lastTextLength);
          run.lastTextLength = fullText.length;
          if (delta) {
            if (run.chunkResolve) {
              const resolve = run.chunkResolve;
              run.chunkResolve = null;
              run.chunkReject = null;
              resolve({ value: delta, done: false });
            } else {
              run.chunks.push(delta);
            }
          }
        }
        return;
      }

      // Chat lifecycle event — final/error/aborted (no text, just lifecycle)
      if (msg.type === "event" && msg.event === "chat") {
        const payload = msg.payload;
        const runId = payload?.runId as string;
        const run = this.activeRuns.get(runId);
        if (!run) return;

        if (payload.state === "final") {
          this.activeRuns.delete(runId);
          if (run.chunkResolve) {
            const resolve = run.chunkResolve;
            run.chunkResolve = null;
            run.chunkReject = null;
            resolve({ value: undefined as unknown as string, done: true });
          }
          run.resolve();
        } else if (
          payload.state === "error" ||
          payload.state === "aborted"
        ) {
          this.activeRuns.delete(runId);
          const err = new Error(
            payload.errorMessage ?? `Chat ${payload.state}`,
          );
          if (run.chunkReject) {
            const reject = run.chunkReject;
            run.chunkResolve = null;
            run.chunkReject = null;
            reject(err);
          }
          run.reject(err);
        }
        return;
      }
    });
  }

  private isRetryableConnectFailure(message: string): boolean {
    return /gateway starting|retry shortly|websocket closed before ready|ECONNREFUSED|socket hang up/i.test(
      message,
    );
  }

  private scheduleReconnect(reason: string, socket: WebSocket | null): void {
    if (this.closed || this.ready || this.reconnectTimer) {
      return;
    }

    this.connectAttempts += 1;
    if (this.connectAttempts > 60) {
      this.readyReject(new Error(`Gateway connect failed after retries: ${reason}`));
      return;
    }

    socket?.removeAllListeners("close");
    socket?.removeAllListeners("error");
    try {
      socket?.close();
    } catch {
      // Ignore close failures while retrying startup handshakes.
    }

    const delayMs = Math.min(250 * this.connectAttempts, 2000);
    console.warn(
      `Gateway not ready yet; retrying bridge connection in ${delayMs}ms (${reason})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  async *sendMessage(
    _userId: string,
    message: string,
  ): AsyncGenerator<string> {
    await this.readyPromise;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    const reqId = String(this.nextId++);
    const request = {
      type: "req",
      id: reqId,
      method: "chat.send",
      params: {
        sessionKey: this.sessionKey,
        message,
        idempotencyKey: randomUUID(),
      },
    };

    const chat: PendingChat = {
      resolve: () => {},
      reject: () => {},
      chunks: [],
      chunkResolve: null,
      chunkReject: null,
      lastTextLength: 0,
    };

    const completionPromise = new Promise<void>((resolve, reject) => {
      chat.resolve = resolve;
      chat.reject = reject;
    });

    // Wait for chat.send response to get runId
    const responsePromise = new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        this.pendingRequests.set(reqId, { resolve, reject });
      },
    );

    this.ws.send(JSON.stringify(request));

    const payload = await responsePromise;
    const runId = payload?.runId as string;
    if (!runId) {
      throw new Error("No runId in chat.send response");
    }
    this.activeRuns.set(runId, chat);

    // Yield chunks as they arrive
    while (true) {
      if (chat.chunks.length > 0) {
        yield chat.chunks.shift()!;
        continue;
      }

      const result = await Promise.race([
        new Promise<IteratorResult<string>>((resolve, reject) => {
          chat.chunkResolve = resolve;
          chat.chunkReject = reject;
        }),
        completionPromise.then(
          () =>
            ({ value: undefined as unknown as string, done: true }) as IteratorResult<string>,
          (err) => {
            throw err;
          },
        ),
      ]);

      if (result.done) {
        return;
      }
      yield result.value;
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
    }
  }
}

function extractTextContent(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const msg = message as Record<string, unknown>;
    if (typeof msg.content === "string") return msg.content;
    if (typeof msg.text === "string") return msg.text;
    // Claude-style content blocks
    if (Array.isArray(msg.content)) {
      return (msg.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join("");
    }
  }
  return "";
}
