# AgentCore Runtime Operations

This project uses AgentCore Runtime as the unified assistant runtime for normal
text conversations and tool/private-data requests. Gateway remains a thin
frontdoor and delivery harness. It builds `AssistantRuntimeContext`, performs
only coarse safety hints, and sends text traffic to AgentCore first. Fargate is
kept as the controlled fallback worker for tool sessions when AgentCore is
unavailable.

Lambda remains in the architecture as an emergency compatibility runtime and for
paths that are not yet part of the unified text runtime, such as the current
image-analysis route. Lambda should not become a second semantic brain for text
chat.

## Current production baseline

The current known-good baseline is:

| Field | Value |
| --- | --- |
| Assistant runtime provider | `agentcore` |
| Tool runtime provider | `agentcore` |
| Fallback provider | `fargate` |
| AgentCore image/session namespace | `agentcore-unified-selfstate-20260524-000855` |
| AgentCore runtime version | `66` |
| Baseline commit | `1233cb4 feat: unify assistant runtime through AgentCore` |

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
  -ToolSlmBackend remote-api `
  -ResponseFormatVersion ko-payment-v1
```

`remote-api` is the preferred AgentCore setting for planner-v1 semantics. It uses
the configured Bedrock model with a small token budget to decide only among the
closed tool taxonomy. If cost, latency, or provider availability regresses, pass
`-ToolSlmBackend mock-local` to roll back to the deterministic local classifier
without changing the runtime architecture.

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
"slmBackend":"remote-api"
```

The smoke is not considered complete until both markers are present. If the
Gateway namespace marker is missing, redeploy `ApiStack` through
`deploy-option-b-tool-runtime.ps1`. If the Runtime image marker is missing,
redeploy the AgentCore Runtime with `deploy-agentcore-runtime.ps1`.

## Smoke scenarios

Run at least one self-state smoke, one direct payment-context smoke, and one
handoff smoke after every assistant runtime cutover.

Assistant self-state:

```powershell
powershell -File .\scripts\synthetic-telegram-smoke.ps1 `
  -ChatId "<chat-id>" `
  -TelegramId "<telegram-id>" `
  -Scenario AssistantSelfState `
  -TailLogs
```

Payment context continuity:

```powershell
powershell -File .\scripts\synthetic-telegram-smoke.ps1 `
  -ChatId "<chat-id>" `
  -TelegramId "<telegram-id>" `
  -Scenario PaymentCoverageFollowUp `
  -TailLogs
```

Travel payment refinement and chat handoff:

```powershell
powershell -File .\scripts\synthetic-telegram-smoke.ps1 `
  -ChatId "<chat-id>" `
  -TelegramId "<telegram-id>" `
  -Scenario TravelPaymentThenChatHandoff `
  -TailLogs
```

The self-state smoke protects the AssistantRuntimeContext contract, including
Gmail/tool capability awareness. The payment smoke protects payment follow-ups
such as `합계만`, `더 있을텐데`, and `5개 밖에 없어?`. The travel handoff smoke
protects the Japan travel payment flow, topic refinement, card issuer breakdown,
and the return to general assistant chat without losing tool capability context.

## Quality guardrails

The curated Gmail/payment quality evaluation lives in:

```text
packages/container/__tests__/fixtures/gmail-quality-eval.json
```

Run the local quality harness before turning the fixture into a blocking gate:

```powershell
powershell -File .\scripts\evaluate-assistant-quality.ps1
```

This default mode is an offline fixture audit only. To score candidate assistant
answers against the 80% quality target, pass a candidate transcript file:

```powershell
powershell -File .\scripts\evaluate-assistant-quality.ps1 `
  -CandidatePath .\tmp\assistant-quality-candidates.json `
  -FailOnBelowTarget
```

The evaluation must keep at least 80% pass coverage and should include cases for:

- topic-filtered travel payments
- noisy daily-life merchants
- card issuer breakdowns
- amount-only follow-ups
- coverage follow-ups
- limited body checks for ambiguous travel or issuer evidence

Card issuer refinement may inspect at most two candidate message bodies. This is
only allowed inside an active Gmail payment context and only for records whose
issuer is unavailable from headers/snippets. Attachments remain disabled.

See `docs/quality-evaluation.md` for the candidate transcript schema and the
planned bridge from opt-in synthetic Telegram smoke runs to local scoring.

## Runtime readiness interpretation

AgentCore logs use separate readiness events for the direct Gmail fast-path and
the OpenClaw fallback path.

Expected direct tool path events:

```text
bridge.message.accepted
bridge.assistant_context.loaded
bridge.tool.intent.decided
bridge.delivery.success
```

Expected self-state path events:

```text
bridge.message.accepted
bridge.assistant_context.loaded
bridge.self_state.answered
bridge.delivery.success
```

Expected optional fallback readiness events:

```text
bridge.openclaw_fallback.starting
bridge.openclaw_fallback.ready
```

If `bridge.openclaw_fallback.unavailable` appears, Gmail/payment fast-path can
still be healthy when `directToolFastPathAvailable=true`. Treat this as a
generic OpenClaw/browser fallback readiness issue, not as a Gmail/payment outage.

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
