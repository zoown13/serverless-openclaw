# AgentCore Runtime Operations

This project uses AgentCore Runtime as the first control-plane for `tool-enabled`
requests, with Fargate kept as the fallback worker. Gateway routing remains
coarse-only: general chat goes to Lambda, and tool-capable traffic goes to
AgentCore first.

## Deployment invariant

When deploying a new AgentCore container image, deploy the Gateway with a new
`AGENTCORE_SESSION_NAMESPACE` value. Use the image tag as the namespace.

AgentCore runtime sessions are sticky by `x-amzn-bedrock-agentcore-runtime-session-id`.
If the Gateway keeps using the same logical session id after a Runtime update,
existing sessions can continue to serve an older container image. Namespacing the
session id by image tag forces a clean cutover while preserving normal follow-up
continuity inside that deployment.

## Safe cutover flow

1. Build and push the container image with a unique tag.

```powershell
$tag = "agentcore-quality-<commit>"
docker build --provenance=false --platform linux/arm64 -f packages/container/Dockerfile -t "serverless-openclaw:$tag" .
docker tag "serverless-openclaw:$tag" "$repo`:$tag"
docker push "$repo`:$tag"
```

2. Update the AgentCore Runtime with the same image tag.

```powershell
powershell -File .\scripts\deploy-agentcore-runtime.ps1 `
  -ImageTag $tag `
  -AiProvider bedrock `
  -AiModel "global.anthropic.claude-haiku-4-5-20251001-v1:0" `
  -ToolSlmBackend mock-local `
  -ResponseFormatVersion ko-payment-v1
```

3. Deploy the Gateway with the image tag as `AGENTCORE_SESSION_NAMESPACE`.

```powershell
powershell -File .\scripts\deploy-option-b-tool-runtime.ps1 `
  -ToolRuntimeProvider agentcore `
  -AgentCoreRuntimeArn "<runtime-arn>" `
  -AgentCoreSessionNamespace $tag
```

4. Run the synthetic Telegram smoke.

```powershell
powershell -File .\scripts\synthetic-telegram-smoke.ps1 `
  -ChatId "<chat-id>" `
  -TelegramId "<telegram-id>" `
  -Scenario TravelPaymentThenChatHandoff `
  -TailLogs
```

## Required log checks

Gateway logs must include:

```text
"agentCoreSessionNamespace":"<image-tag>"
```

AgentCore Runtime logs must include:

```text
"runtimeImageTag":"<image-tag>"
"responseFormatVersion":"ko-payment-v1"
```

The smoke is not considered complete until both markers are present. If the
Gateway namespace marker is missing, redeploy `ApiStack` through
`deploy-option-b-tool-runtime.ps1`. If the Runtime image marker is missing,
redeploy the AgentCore Runtime with `deploy-agentcore-runtime.ps1`.

## Rollback

Rollback is a flag and namespace change, not a code rewrite.

To return tool-capable traffic to Fargate:

```powershell
powershell -File .\scripts\deploy-option-b-tool-runtime.ps1 `
  -ToolRuntimeProvider fargate
```

To rollback to a previous AgentCore image:

1. Redeploy the AgentCore Runtime with the previous image tag.
2. Redeploy the Gateway with `-AgentCoreSessionNamespace` set to that previous tag.
3. Run the same Telegram smoke and confirm both markers.

## Current safety constraints

- No ALB.
- No NAT Gateway.
- No Interface Endpoints.
- Gmail remains headers-first by default.
- Full body reads remain limited and task-specific.
- AgentCore Gateway, Memory, and Identity are not part of v1.
