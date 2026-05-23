---
name: status
description: Shows project progress, phase completion status, test coverage, and deployment info. Use when checking what has been implemented, what remains, or current operational state.
allowed-tools: Read, Bash, Glob, Grep
---

# Project Status

Full progress details: [docs/progress.md](../../../docs/progress.md)

## Recent Commits

```bash
git log --oneline -10
```

## Phase Summary

| Phase           | Description                              | Status   |
| --------------- | ---------------------------------------- | -------- |
| Phase 0         | Docs + project setup                     | Complete |
| Phase 1 (10/10) | MVP — Fargate + Gateway + optional Web + Telegram | Complete |
| Phase 2         | Lambda agent migration                   | Complete |
| Phase 3         | Hybrid AgentCore-first tool runtime      | Operational hardening |

### Phase 1 Milestones (all complete)

1-1 Project init, 1-2 NetworkStack + StorageStack, 1-3 Container, 1-4 Gateway Lambda, 1-5 API Gateway, 1-6 Cognito, 1-7 Compute, 1-8 optional Web UI, 1-9 Telegram, 1-10 Integration tests/documentation

### Phase 2 (Lambda Migration)

- Lambda container image with embedded OpenClaw (`runEmbeddedPiAgent()`)
- LambdaAgentStack CDK stack
- `AGENT_RUNTIME` feature flag: `fargate` | `lambda` | `both`
- Bedrock discovery disabled → 1.35s cold start
- SessionLock for concurrent Lambda invocation safety

### Cold Start Issues Resolved

All GitHub issues #2–#9 closed: P1-P5 cold start, #7 zstd, #8 CPU configurable, #9 OpenClaw version pin

## Current Operational Mode

```
AGENT_RUNTIME=both
TOOL_RUNTIME_PROVIDER=agentcore
```

- Lambda handles quick general chat.
- AgentCore Runtime is the primary control-plane for tool/private-data requests.
- Fargate remains as a fallback tool worker.
- WebStack/CloudFront is disabled by default and currently not deployed.

## Test Coverage

| Suite                 | Count   |
| --------------------- | ------- |
| Unit tests            | 233+    |
| E2E tests (CDK synth) | 46      |
| Final Telegram smoke  | 8       |

Run tests:

```bash
npm run test        # Unit tests
npm run test:e2e    # E2E (CDK synth)
```

## AWS Deployment Info

See [docs/deployment.md](../../../docs/deployment.md) for full deployment guide.

| Resource          | Value                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| AWS Region        | ap-northeast-2                                                        |
| HTTP API          | https://re4wh3c3j1.execute-api.ap-northeast-2.amazonaws.com           |
| WebSocket         | wss://emgc2gih17.execute-api.ap-northeast-2.amazonaws.com/prod        |
| CloudFront        | Not deployed by default                                               |
| ECR               | 771785741123.dkr.ecr.ap-northeast-2.amazonaws.com/serverless-openclaw |

## CDK Stacks

Default: SecretsStack → NetworkStack → StorageStack → {AuthStack, ComputeStack, LambdaAgentStack} → ApiStack → MonitoringStack

Optional: WebStack can be re-enabled with `ENABLE_WEB_STACK=true` or `DEPLOY_WEB=true`.

## Verify Deployment

```bash
make task-status    # ECS Fargate task status
make task-logs      # Tail container logs
```
