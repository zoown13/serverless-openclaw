#!/bin/bash
set -euo pipefail

CONFIG_PATH="/home/openclaw/.openclaw/openclaw.json"
OPENCLAW_HOME="${HOME:-/home/openclaw}"
OPENCLAW_DIR="${OPENCLAW_HOME}/.openclaw"
DEFAULT_AGENT_DIR="${OPENCLAW_DIR}/agents/default/agent"
MAIN_AGENT_DIR="${OPENCLAW_DIR}/agents/main/agent"
CREDENTIALS_DIR="${OPENCLAW_DIR}/credentials"
GOG_CONFIG_DIR="${OPENCLAW_HOME}/.config/gogcli"

mkdir -p "${DEFAULT_AGENT_DIR}" "${MAIN_AGENT_DIR}" "${CREDENTIALS_DIR}" "${GOG_CONFIG_DIR}"

if [ "${CONTAINER_RUNTIME_MODE:-}" = "agentcore" ] || [ "${AGENTCORE_HTTP_ENABLED:-}" = "true" ]; then
  echo "[start] Resolving AgentCore runtime secrets from SSM..."
  eval "$(node /app/dist/resolve-agentcore-env.js)"
fi

write_secret_file() {
  local raw_value="$1"
  local target_path="$2"

  if [ -z "${raw_value}" ] || [ "${raw_value}" = "__UNSET__" ]; then
    return 0
  fi

  printf '%s' "${raw_value}" > "${target_path}"
}

echo "[start] Patching openclaw.json..."
node /app/dist/patch-config.js "${CONFIG_PATH}" 2>&1 || echo "[start] WARNING: patch-config exited with code $?"

echo "[start] Restoring OpenClaw auth state..."
write_secret_file "${OPENCLAW_AUTH_PROFILES_JSON:-}" "${DEFAULT_AGENT_DIR}/auth-profiles.json"
write_secret_file "${OPENCLAW_AUTH_PROFILES_JSON:-}" "${MAIN_AGENT_DIR}/auth-profiles.json"
write_secret_file "${OPENCLAW_OAUTH_JSON:-}" "${CREDENTIALS_DIR}/oauth.json"
write_secret_file "${GOOGLE_OAUTH_CLIENT_JSON:-}" "${GOG_CONFIG_DIR}/credentials.json"
unset OPENCLAW_AUTH_PROFILES_JSON OPENCLAW_OAUTH_JSON GOOGLE_OAUTH_CLIENT_JSON

echo "[start] Starting Bridge server (background)..."
node /app/dist/index.js &
BRIDGE_PID=$!

unset TELEGRAM_BOT_TOKEN

echo "[start] Starting OpenClaw Gateway (foreground)..."
openclaw gateway run --port 18789 --verbose --bind loopback 2>&1 &
GATEWAY_PID=$!

# Wait for either process to exit
wait -n ${BRIDGE_PID} ${GATEWAY_PID} 2>/dev/null || true

echo "[start] A process exited, shutting down..."
kill ${BRIDGE_PID} ${GATEWAY_PID} 2>/dev/null || true
wait
