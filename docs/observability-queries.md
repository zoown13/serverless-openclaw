# Observability Queries

This note gives operators two quick tools:

- inspect `PendingMessages` retry and dead-letter state
- trace a single request across Gateway Lambda and Fargate Bridge logs

## Inspect failed pending messages

Use the helper script from the repository root:

```powershell
powershell -File .\scripts\inspect-pending-messages.ps1
```

Useful variants:

```powershell
powershell -File .\scripts\inspect-pending-messages.ps1 -State Retrying
```

```powershell
powershell -File .\scripts\inspect-pending-messages.ps1 -State DeadLettered
```

```powershell
powershell -File .\scripts\inspect-pending-messages.ps1 -UserId telegram:8585874705
```

```powershell
powershell -File .\scripts\inspect-pending-messages.ps1 -AsJson
```

The script reads these fields from DynamoDB:

- `retryCount`
- `nextAttemptAt`
- `lastError`
- `deadLetteredAt`

Interpretation:

- `RetryScheduled`: the message failed, was kept in queue, and will not be retried before `nextAttemptAt`
- `DeadLettered`: the retry budget was exhausted and the message will not be retried automatically

## Redrive pending messages

Use this when an operator decides a failed or dead-lettered message is safe to retry.

Preview first:

```powershell
powershell -File .\scripts\redrive-pending-messages.ps1 -UserId telegram:8585874705
```

Redrive one dead-lettered message by sort key:

```powershell
powershell -File .\scripts\redrive-pending-messages.ps1 -UserId telegram:8585874705 -SortKey "MSG#1775292899197#1775292899197-2uo3z3" -Execute
```

Force retry-scheduled messages to become eligible again:

```powershell
powershell -File .\scripts\redrive-pending-messages.ps1 -UserId telegram:8585874705 -State RetryScheduled -Execute
```

What redrive does:

- sets `retryCount` back to `0`
- removes `nextAttemptAt`
- removes `deadLetteredAt`
- removes `lastError`

Redriven messages become eligible the next time the user-specific Fargate task starts and drains the pending queue.

## Run a synthetic Telegram smoke

Use the helper script when you want a repeatable Telegram webhook smoke on Windows without BOM or `Invoke-WebRequest` JSON issues.

Example:

```powershell
powershell -File .\scripts\synthetic-telegram-smoke.ps1 -ChatId 8585874705 -TailLogs
```

Defaults:

- resolves `ApiStack.HttpApiEndpoint` from CloudFormation
- resolves `/serverless-openclaw/secrets/telegram-webhook-secret` from SSM
- uses `TelegramId = ChatId` unless you override it
- runs the `PaymentFollowUp` scenario:
  - `이번주 결제한 금액이 어느정도 되려나?`
  - `지메일에서 확인해줘`
  - `그거 표로 보여줘`

Useful variants:

```powershell
powershell -File .\scripts\synthetic-telegram-smoke.ps1 -ChatId 8585874705 -TelegramId 8585874705 -PauseSeconds 12
```

```powershell
powershell -File .\scripts\synthetic-telegram-smoke.ps1 -ChatId 8585874705 -ApiEndpoint https://re4wh3c3j1.execute-api.ap-northeast-2.amazonaws.com -WebhookSecret <SECRET>
```

What to expect:

- HTTP `200` from the webhook for each synthetic update
- Gateway log events such as `route.classified`, `route.affinity.created|reused`
- ECS Bridge log events such as `bridge.tool.intent.decided`, `bridge.tool.context.created|reused`, `bridge.delivery.success`

## Trace a single request by `traceId`

### Gateway Lambda

Run this in CloudWatch Logs Insights against:

- `/aws/lambda/serverless-openclaw-ws-message`
- `/aws/lambda/serverless-openclaw-telegram-webhook`

```sql
fields @timestamp, @message
| filter @message like /"traceId":"REPLACE_ME"/
| sort @timestamp asc
```

For routing-specific entries:

```sql
fields @timestamp, @message
| filter @message like /"traceId":"REPLACE_ME"/
| filter @message like /route.classified|route.lambda.invoked|route.fargate.reused|route.fargate.started|route.pending.queued|route.lambda.fallback_to_fargate/
| sort @timestamp asc
```

What to look for:

- `route.classified`: why the request was classified as `chat-only` or `tool-enabled`
- `route.pending.queued`: whether cold-start queuing happened
- `route.fargate.started` or `route.fargate.reused`: which Fargate path was chosen

### Fargate Bridge

Run this in CloudWatch Logs Insights against:

- `/ecs/serverless-openclaw`

```sql
fields @timestamp, @message
| filter @message like /"traceId":"REPLACE_ME"/
| sort @timestamp asc
```

For Gmail requests:

```sql
fields @timestamp, @message
| filter @message like /"traceId":"REPLACE_ME"/
| filter @message like /bridge.gmail.matched|bridge.gmail.query.built|bridge.gmail.query.result|bridge.gmail.query.failure|bridge.delivery.success|bridge.delivery.failure/
| sort @timestamp asc
```

What to look for:

- `bridge.gmail.query.built`: the sanitized Gmail query and derived search window
- `bridge.gmail.query.result`: `matchedCount` and `inspectedCount`
- `bridge.delivery.failure`: callback or Telegram delivery failure
- `[pending] failed to process`: retry/backoff or dead-letter transition

## Query mismatch checklist

If the assistant answers with the wrong mailbox subset:

1. Find the `traceId` in Gateway logs.
2. Follow the same `traceId` in `/ecs/serverless-openclaw`.
3. Compare:
   - original user intent
   - `bridge.gmail.query.built` sanitized query
   - `bridge.gmail.query.result` counts
4. If the query is structurally wrong, fix extraction logic.
5. If the query is right but results are wrong, inspect Gmail filters, labels, and date window assumptions.
