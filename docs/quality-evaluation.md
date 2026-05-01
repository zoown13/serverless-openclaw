# Assistant Quality Evaluation

The quality lane tracks whether assistant answers stay above the 80% target for
known Gmail/payment behaviors without requiring AWS, Telegram, Docker, or a
deploy by default.

The local harness is:

```powershell
powershell -File .\scripts\evaluate-assistant-quality.ps1
```

Default mode is a fixture audit. It reads the curated fixture at
`packages/container/__tests__/fixtures/gmail-quality-eval.json` and reports how
many cases, answer substring checks, exclusion checks, no-extra-fetch checks, and
limited body-check fixtures are covered. This mode is safe to run locally because
it only reads repo files.

## Scoring candidate assistant outputs

To score real assistant answers, export them into a candidate JSON file and pass
it to the harness:

```powershell
powershell -File .\scripts\evaluate-assistant-quality.ps1 `
  -CandidatePath .\tmp\assistant-quality-candidates.json `
  -FailOnBelowTarget
```

`-FailOnBelowTarget` makes the command exit non-zero when the scored assistant
quality is below `-TargetPercent` (80 by default). Omit it for exploratory local
runs.

Candidate JSON schema:

```json
{
  "cases": [
    {
      "id": "followup_amount_and_coverage_reuse_payment_context",
      "steps": [
        {
          "response": "확인 가능한 합계는 KRW 44,215 ...",
          "additionalFetches": 0
        }
      ]
    }
  ]
}
```

Each candidate case id must match the fixture case id. Each step can be either a
string response or an object with one of `response`, `assistant`, `answer`,
`text`, or `output`. Steps that protect context reuse may also include
`additionalFetches`, `fetches`, or `fetched` so the harness can enforce
`expectNoAdditionalFetch`.

The scorer checks:

- `expectIncludes`: every expected phrase must appear in the answer.
- `expectExcludes`: excluded noise must not appear in the answer.
- `expectNoAdditionalFetch`: any supplied fetch evidence must show zero extra
  fetches.

If fetch evidence is omitted for a no-extra-fetch step, the text quality still
scores but the harness prints a warning. Add fetch evidence before making the
quality gate blocking in automation.

## Connecting to synthetic Telegram smoke

Live Telegram/AWS mode should remain opt-in. The synthetic smoke script is still
the right live source:

```powershell
powershell -File .\scripts\synthetic-telegram-smoke.ps1 `
  -ChatId "<chat-id>" `
  -TelegramId "<telegram-id>" `
  -Scenario TravelPaymentThenChatHandoff `
  -TailLogs
```

Later automation should transform the smoke transcript or terminal assistant
messages into the candidate JSON schema above, then run:

```powershell
powershell -File .\scripts\evaluate-assistant-quality.ps1 `
  -CandidatePath .\tmp\assistant-quality-candidates.json `
  -FailOnBelowTarget
```

This keeps the default quality lane offline while allowing a live smoke/eval lane
to verify the deployed Telegram path after runtime cutovers.

## Adding cases

Add new quality cases to the existing fixture when a regression is found. Prefer
small, user-observable expectations:

- Include phrases that prove the right payment context was used.
- Exclude phrases that would reveal noisy daily-life merchants or policy emails.
- Mark follow-up steps with `expectNoAdditionalFetch` when the answer must reuse
  prior context.
- Keep full body checks limited and task-specific.
