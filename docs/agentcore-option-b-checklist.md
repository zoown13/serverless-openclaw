# AgentCore Option B Progress Checklist

This checklist tracks the B-lite migration from Fargate tool runtime to AgentCore Runtime while keeping Fargate as the safe fallback.

## Status legend

- `[x]` Done
- `[~]` In progress or partially verified
- `[ ]` Not started

## Current checklist

- `[x]` Keep Gateway coarse routing and `ToolRuntimeAffinityState`.
- `[x]` Keep Fargate as the fallback production tool runtime.
- `[x]` Revert the heavy local Transformers runtime from production image.
- `[x]` Add `TOOL_RUNTIME_PROVIDER=fargate|agentcore`.
- `[x]` Add AgentCore Runtime deploy script and runtime IAM role.
- `[x]` Add AgentCore-compatible container HTTP adapter.
- `[x]` Fix AgentCore invoke SigV4 signed headers.
- `[x]` Fix AgentCore canonical URI double-encoding.
- `[x]` Grant `bedrock-agentcore:InvokeAgentRuntime` on both runtime and runtime-endpoint ARNs.
- `[x]` Verify first-turn AgentCore invoke succeeds from Telegram smoke.
- `[x]` Resolve AgentCore same-session follow-up timeout with durable context, callback delivery, and session namespace cutovers.
- `[x]` Prevent active AgentCore context from falling back to Fargate and mixing task context.
- `[x]` Add shorter configurable timeout for AgentCore follow-up turns.
- `[x]` Add durable ToolTaskContext storage for AgentCore/Fargate parity. Uses the existing Settings table behind `TOOL_CONTEXT_STORE=ddb` so AgentCore and Fargate can resume the same Gmail/payment task context.
- `[x]` Add planner-v1 closed actions for `start_new_task`, `continue_task`, `refine_current_task`, `rerun_current_task`, `switch_to_chat`, `clarify`, and `cancel_task`.
- `[x]` Move AgentCore deployment default from `mock-local` to `remote-api` planner while keeping `mock-local` as rollback.
- `[x]` Re-test AgentCore-only follow-up flow after durable context work.
- `[x]` Compare latency, cost, and answer quality before cutover.
- `[x]` Cut over `TOOL_RUNTIME_PROVIDER=agentcore` after the follow-up flow stabilized.
- `[x]` Cut over AgentCore Runtime to protocol-4 image tag `agentcore-protocol4-20260523`.
- `[x]` Verify Gateway session namespace `agentcore-protocol4-20260523` to avoid sticky sessions serving older runtime images.

## Operational rule

Production now runs `TOOL_RUNTIME_PROVIDER=agentcore` with `AGENTCORE_FALLBACK_PROVIDER=fargate`.

AgentCore must keep passing:

1. First turn: `일본 여행가는데 결제한 내역들 알려줘`
2. Follow-up: `일본관련된 것만 가져와야지`
3. Follow-up: `카드사별로 보여줘`

The AgentCore path must complete these turns without falling back to Fargate, leaking internal errors, or losing task context.

Latest verified cutover:

- Runtime image tag: `agentcore-protocol4-20260523`
- Runtime version: `64`
- Planner backend: `remote-api`
- Gateway session namespace: `agentcore-protocol4-20260523`
- Smoke scenario: `TravelPaymentFollowUp`
- Result: passed
- Post-cutover protocol check: no `protocol mismatch` events observed in the recent AgentCore Runtime window

Planner-v1 quality gate:

1. New lookup inside an active context must choose `start_new_task`, not stale continuation.
2. Contextual corrections such as `일본관련된 것만` must choose `refine_current_task`.
3. Coverage complaints such as `더 있을텐데` must choose `rerun_current_task`.
4. General questions such as `리눅스에서 파일 찾는 명령어 알려줘` must choose `switch_to_chat`.
5. Logs should show `slmBackend=remote-api` for AgentCore quality runs.


