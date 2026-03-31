export type {
  LambdaAgentEvent,
  LambdaAgentResponse,
  ResolvedRuntimeConfig,
  RuntimeCapability,
  RuntimeReadiness,
  ServerMessage,
} from "@serverless-openclaw/shared";

export interface AgentPayload {
  text?: string;
  mediaUrl?: string;
  isError?: boolean;
}

export interface ConfigInitResult {
  configDir: string;
  sessionsDir: string;
  config: Record<string, unknown>;
  runtimeConfig: import("@serverless-openclaw/shared").ResolvedRuntimeConfig;
  gmailReady: boolean;
  toolRuntimeReady: boolean;
  sessionNamespace: string;
}
