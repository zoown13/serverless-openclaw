param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$ApiEndpoint,
  [string]$WebhookSecret,
  [Parameter(Mandatory = $true)]
  [long]$ChatId,
  [long]$TelegramId,
  [string]$UserId,
  [ValidateSet("Critical", "Full")]
  [string]$Suite = "Critical",
  [int]$PauseSeconds = 10,
  [int]$BridgeSignalTimeoutSeconds = 240,
  [int]$InterScenarioPauseSeconds = 8,
  [switch]$TailLogs,
  [switch]$ContinueOnFailure
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $TelegramId) {
  $TelegramId = $ChatId
}

$syntheticSmoke = Join-Path $PSScriptRoot "synthetic-telegram-smoke.ps1"
if (-not (Test-Path -LiteralPath $syntheticSmoke)) {
  throw "Missing synthetic smoke script: $syntheticSmoke"
}

$criticalScenarios = @(
  [pscustomobject]@{
    Name = "ChatThenCostLookup"
    Goal = "Lambda chat-only route, delivery quality, and /cost recent query cost recall"
  },
  [pscustomobject]@{
    Name = "AwsCostLookup"
    Goal = "AWS Cost Explorer capability and controlled response"
  },
  [pscustomobject]@{
    Name = "PaymentCapabilityThenChatHandoff"
    Goal = "Gmail/payment capability awareness followed by Lambda chat handoff"
  },
  [pscustomobject]@{
    Name = "TravelPaymentThenChatHandoff"
    Goal = "Travel payment refinement, issuer breakdown, and general chat return"
  }
)

$fullOnlyScenarios = @(
  [pscustomobject]@{
    Name = "PaymentCoverageThenIssuerBreakdown"
    Goal = "Payment coverage correction and issuer breakdown"
  },
  [pscustomobject]@{
    Name = "PaymentExpandedFirstTurn"
    Goal = "User-requested payment search limit expansion"
  },
  [pscustomobject]@{
    Name = "PaymentDateRange"
    Goal = "Payment date-range follow-up interpretation"
  },
  [pscustomobject]@{
    Name = "PlannerSemanticHandoff"
    Goal = "Planner/advisor context continuity and topic switch handoff"
  }
)

$scenarios = @($criticalScenarios)
if ($Suite -eq "Full") {
  $scenarios += $fullOnlyScenarios
}

Write-Host "Final Serverless OpenClaw regression smoke"
Write-Host "  Suite    : $Suite"
Write-Host "  Region   : $Region"
Write-Host "  ChatId   : $ChatId"
Write-Host "  Telegram : $TelegramId"
Write-Host "  Count    : $($scenarios.Count)"
Write-Host ""

$startedAt = Get-Date
$failures = @()
$passedCount = 0

for ($index = 0; $index -lt $scenarios.Count; $index++) {
  $scenario = $scenarios[$index]
  $scenarioNumber = $index + 1

  Write-Host "[$scenarioNumber/$($scenarios.Count)] Scenario: $($scenario.Name)"
  Write-Host "  Goal: $($scenario.Goal)"

  $params = @{
    Profile = $Profile
    Region = $Region
    ChatId = $ChatId
    TelegramId = $TelegramId
    Scenario = $scenario.Name
    PauseSeconds = $PauseSeconds
    BridgeSignalTimeoutSeconds = $BridgeSignalTimeoutSeconds
  }

  if ($ApiEndpoint) {
    $params.ApiEndpoint = $ApiEndpoint
  }
  if ($WebhookSecret) {
    $params.WebhookSecret = $WebhookSecret
  }
  if ($UserId) {
    $params.UserId = $UserId
  }
  if ($TailLogs) {
    $params.TailLogs = $true
  }

  try {
    & $syntheticSmoke @params
    if ($LASTEXITCODE -ne 0) {
      throw "synthetic-telegram-smoke.ps1 exited with code $LASTEXITCODE"
    }
    $passedCount += 1
    Write-Host "[$scenarioNumber/$($scenarios.Count)] PASS: $($scenario.Name)"
  } catch {
    $message = $_.Exception.Message
    $failures += [pscustomobject]@{
      Scenario = $scenario.Name
      Error = $message
    }
    Write-Host "[$scenarioNumber/$($scenarios.Count)] FAIL: $($scenario.Name)"
    Write-Host "  Error: $message"

    if (-not $ContinueOnFailure) {
      break
    }
  }

  if ($index -lt ($scenarios.Count - 1) -and $InterScenarioPauseSeconds -gt 0) {
    Start-Sleep -Seconds $InterScenarioPauseSeconds
  }

  Write-Host ""
}

$duration = [int]((Get-Date) - $startedAt).TotalSeconds
Write-Host ""
Write-Host "Final regression smoke summary"
Write-Host "  Suite    : $Suite"
Write-Host "  Duration : ${duration}s"
Write-Host "  Passed   : $passedCount"
Write-Host "  Failed   : $($failures.Count)"

if ($failures.Count -gt 0) {
  foreach ($failure in $failures) {
    Write-Host "  - $($failure.Scenario): $($failure.Error)"
  }
  throw "Final regression smoke failed."
}

Write-Host "Final regression smoke passed."
