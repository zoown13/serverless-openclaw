// === Task State ===
export type TaskStatus = "Idle" | "Starting" | "Running" | "Stopping";

// === WebSocket Message Protocol (architecture.md §6.1) ===
export interface ClientMessage {
  action: "sendMessage" | "getHistory" | "getStatus";
  conversationId?: string;
  message?: string;
}

export type ServerMessageType = "message" | "status" | "error" | "stream_chunk" | "stream_end";

export interface ServerMessage {
  type: ServerMessageType;
  conversationId?: string;
  content?: string;
  status?: TaskStatus | "idle" | "starting" | "running" | "stopping";
  error?: string;
}

// === Channel ===
export type Channel = "web" | "telegram";
export type RuntimeClass = "chat-only" | "tool-enabled";
export type ToolRuntimeProvider = "fargate" | "agentcore";
export type RouteDecision =
  | "lambda"
  | "fargate-reuse"
  | "fargate-new"
  | "agentcore"
  | "clarify";
export type ClarificationKind = "payment_source";

export interface EmailTokenBudgetPolicy {
  mode: "headers-first";
  maxMessages: number;
  maxSnippetChars: number;
  maxBodyChars: number;
  requireExplicitBodyAccess: boolean;
}

/**
 * Minimal Gateway-side active tool state persisted in Settings:
 * PK=USER#{userId}, SK=SETTING#active-tool:{channel}
 *
 * Gateway only remembers that the current user/channel is in a tool-capable
 * workflow so follow-up turns can stay on Fargate until they clearly switch
 * topics, are cancelled, or expire.
 */
export interface ToolRuntimeAffinityState {
  status: "active";
  channel: Channel;
  runtimeClass: "tool-enabled";
  connectionId: string;
  callbackUrl: string;
  telegramChatId?: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export type ToolTaskContextStatus = "awaiting_source" | "active";
export type ToolTaskFamily =
  | "gmail_payment_summary"
  | "gmail_search"
  | "gmail_body_selection"
  | "generic_tool_task";
export type ToolSourceChoice = "gmail" | "general";
export type ToolIntentAdvisorAction =
  | "gmail"
  | "clarify_source"
  | "generic_openclaw"
  | "continue_active_task";

export interface ToolIntentAdvisorResult {
  action: ToolIntentAdvisorAction;
  taskFamily: ToolTaskFamily;
  sourceChoice?: ToolSourceChoice | null;
  confidence: number;
}

// === DynamoDB Items (architecture.md §5) ===
export interface ConversationItem {
  PK: string; // USER#{userId}
  SK: string; // CONV#{conversationId}#MSG#{timestamp}
  role: "user" | "assistant" | "system";
  content: string;
  channel: Channel;
  metadata?: Record<string, unknown>;
  ttl?: number;
}

export interface SettingsItem {
  PK: string; // USER#{userId}
  SK: string; // SETTING#{key}
  value: string | Record<string, unknown>;
  updatedAt: string;
  ttl?: number;
}

export interface TaskStateItem {
  PK: string; // USER#{userId}
  taskArn: string;
  status: TaskStatus;
  publicIp?: string;
  startedAt: string;
  lastActivity: string;
  ttl?: number;
  prewarmUntil?: number; // Unix timestamp (ms). Watchdog skips if now < this.
}

export interface ConnectionItem {
  PK: string; // CONN#{connectionId}
  userId: string;
  connectedAt: string;
  ttl?: number;
}

export interface PendingMessageItem {
  PK: string; // USER#{userId}
  SK: string; // MSG#{timestamp}#{uuid}
  message: string;
  channel: Channel;
  connectionId: string;
  traceId?: string;
  runtimeClass?: RuntimeClass;
  routeDecision?: RouteDecision;
  emailTokenBudget?: EmailTokenBudgetPolicy;
  retryCount?: number;
  nextAttemptAt?: string;
  lastError?: string;
  deadLetteredAt?: string;
  createdAt: string;
  ttl: number;
}

// === Bridge API ===
export interface BridgeMessageRequest {
  userId: string;
  message: string;
  channel: Channel;
  connectionId: string;
  callbackUrl: string;
  traceId?: string;
  runtimeClass?: RuntimeClass;
  routeDecision?: RouteDecision;
  emailTokenBudget?: EmailTokenBudgetPolicy;
}

export interface BridgeHealthResponse {
  status: "ok";
}

// === Lambda Agent ===
export interface LambdaAgentEvent {
  userId: string;
  sessionId: string;
  traceId?: string;
  connectionId?: string;
  /** WebSocket API Gateway callback URL for direct push (async invocation) */
  callbackUrl?: string;
  message: string;
  model?: string;
  disableTools?: boolean;
  channel: Channel;
  telegramChatId?: string;
}

export interface LambdaAgentResponse {
  success: boolean;
  payloads?: Array<{ text?: string; mediaUrl?: string; isError?: boolean }>;
  error?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
}

// === JSON-RPC 2.0 (implementation-plan.md §2.2) ===
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number;
}
