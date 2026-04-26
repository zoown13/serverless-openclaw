param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$ApiEndpoint,
  [string]$WebhookSecret,
  [Parameter(Mandatory = $true)]
  [long]$ChatId,
  [long]$TelegramId,
  [string]$UserId,
  [ValidateSet("PaymentFollowUp", "TravelPaymentFollowUp")]
  [string]$Scenario = "PaymentFollowUp",
  [int]$PauseSeconds = 10,
  [int]$BridgeSignalTimeoutSeconds = 180,
  [switch]$SkipStateReset,
  [switch]$SkipBridgeSignalCheck,
  [switch]$TailLogs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $TelegramId) {
  $TelegramId = $ChatId
}

function Write-Utf8NoBomJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Json
  )

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Json, $utf8NoBom)
}

function Resolve-ApiEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion
  )

  $value = aws cloudformation describe-stacks `
    --stack-name ApiStack `
    --query "Stacks[0].Outputs[?OutputKey=='HttpApiEndpoint'].OutputValue" `
    --output text `
    --profile $SelectedProfile `
    --region $SelectedRegion

  if ($LASTEXITCODE -ne 0 -or -not $value) {
    throw "Failed to resolve ApiStack.HttpApiEndpoint from CloudFormation."
  }

  return $value.TrimEnd("/")
}

function Resolve-WebhookSecret {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion
  )

  $value = aws ssm get-parameter `
    --name /serverless-openclaw/secrets/telegram-webhook-secret `
    --with-decryption `
    --query Parameter.Value `
    --output text `
    --profile $SelectedProfile `
    --region $SelectedRegion

  if ($LASTEXITCODE -ne 0 -or -not $value) {
    throw "Failed to resolve telegram webhook secret from SSM."
  }

  return $value
}

function Resolve-SyntheticUserId {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][long]$SelectedTelegramId,
    [string]$ExplicitUserId
  )

  if ($ExplicitUserId) {
    return $ExplicitUserId
  }

  $telegramKey = "telegram:$SelectedTelegramId"
  $tempPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("telegram-link-key-{0}.json" -f [Guid]::NewGuid().ToString("N"))

  try {
    Write-Utf8NoBomJson `
      -Path $tempPath `
      -Json "{`"PK`":{`"S`":`"USER#$telegramKey`"},`"SK`":{`"S`":`"SETTING#linked-cognito`"}}"

    $linkedJson = aws dynamodb get-item `
      --table-name serverless-openclaw-Settings `
      --key "file://$tempPath" `
      --output json `
      --profile $SelectedProfile `
      --region $SelectedRegion

    if ($LASTEXITCODE -ne 0) {
      throw "Failed to resolve linked Telegram identity."
    }

    if ($linkedJson) {
      $linked = $linkedJson | ConvertFrom-Json
      $item = if ($linked.PSObject.Properties.Match("Item").Count -gt 0) { $linked.Item } else { $null }
      $value = if ($item -and $item.PSObject.Properties.Match("value").Count -gt 0) { $item.value } else { $null }
      $map = if ($value -and $value.PSObject.Properties.Match("M").Count -gt 0) { $value.M } else { $null }
      $cognito = if ($map -and $map.PSObject.Properties.Match("cognitoUserId").Count -gt 0) { $map.cognitoUserId } else { $null }
      $cognitoUserId = if ($cognito -and $cognito.PSObject.Properties.Match("S").Count -gt 0) { $cognito.S } else { $null }
      if ($cognitoUserId) {
        return $cognitoUserId
      }
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      Remove-Item -LiteralPath $tempPath -Force
    }
  }

  return $telegramKey
}

function Clear-SyntheticRuntimeState {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][string]$SelectedUserId
  )

  $taskKeyPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("taskstate-key-{0}.json" -f [Guid]::NewGuid().ToString("N"))
  $affinityKeyPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("active-tool-key-{0}.json" -f [Guid]::NewGuid().ToString("N"))

  try {
    Write-Utf8NoBomJson `
      -Path $taskKeyPath `
      -Json "{`"PK`":{`"S`":`"USER#$SelectedUserId`"}}"
    Write-Utf8NoBomJson `
      -Path $affinityKeyPath `
      -Json "{`"PK`":{`"S`":`"USER#$SelectedUserId`"},`"SK`":{`"S`":`"SETTING#active-tool:telegram`"}}"

    aws dynamodb delete-item `
      --table-name serverless-openclaw-TaskState `
      --key "file://$taskKeyPath" `
      --profile $SelectedProfile `
      --region $SelectedRegion | Out-Null

    if ($LASTEXITCODE -ne 0) {
      throw "Failed to clear TaskState."
    }

    aws dynamodb delete-item `
      --table-name serverless-openclaw-Settings `
      --key "file://$affinityKeyPath" `
      --profile $SelectedProfile `
      --region $SelectedRegion | Out-Null

    if ($LASTEXITCODE -ne 0) {
      throw "Failed to clear active tool affinity."
    }
  } finally {
    foreach ($path in @($taskKeyPath, $affinityKeyPath)) {
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
      }
    }
  }
}

function Get-ScenarioMessages {
  param([Parameter(Mandatory = $true)][string]$SelectedScenario)

  switch ($SelectedScenario) {
    "PaymentFollowUp" {
      return @(
        "이번주 결제한 금액이 어느정도 되려나?",
        "지메일에서 확인해줘",
        "그거 표로 보여줘"
      )
    }
    "TravelPaymentFollowUp" {
      return @(
        "일본 여행가는데 결제한 내역들 알려줘",
        "일본관련된 것만 가져와야지",
        "카드사별로 보여줘"
      )
    }
    default {
      throw "Unsupported scenario: $SelectedScenario"
    }
  }
}

function New-TelegramUpdateJson {
  param(
    [Parameter(Mandatory = $true)][long]$UpdateId,
    [Parameter(Mandatory = $true)][int]$MessageId,
    [Parameter(Mandatory = $true)][long]$SelectedChatId,
    [Parameter(Mandatory = $true)][long]$SelectedTelegramId,
    [Parameter(Mandatory = $true)][string]$Text
  )

  $payload = @{
    update_id = $UpdateId
    message = @{
      message_id = $MessageId
      date = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
      chat = @{
        id = $SelectedChatId
        type = "private"
        first_name = "Synthetic"
      }
      from = @{
        id = $SelectedTelegramId
        is_bot = $false
        first_name = "Synthetic"
        language_code = "ko"
      }
      text = $Text
    }
  }

  return ($payload | ConvertTo-Json -Depth 8 -Compress)
}

function Send-TelegramWebhookEvent {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Secret,
    [Parameter(Mandatory = $true)][string]$JsonBody
  )

  $tempPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("telegram-webhook-{0}.json" -f [Guid]::NewGuid().ToString("N"))

  try {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($tempPath, $JsonBody, $utf8NoBom)

    $response = & curl.exe `
      --silent `
      --show-error `
      --fail `
      --request POST `
      --header "X-Telegram-Bot-Api-Secret-Token: $Secret" `
      --header "Content-Type: application/json; charset=utf-8" `
      --data-binary "@$tempPath" `
      $Uri 2>&1

    if ($LASTEXITCODE -ne 0) {
      throw "Webhook POST failed: $response"
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      Remove-Item -LiteralPath $tempPath -Force
    }
  }
}

function Show-RecentLogs {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion
  )

  Write-Host ""
  Write-Host "Recent Gateway logs:"
  aws logs tail /aws/lambda/serverless-openclaw-telegram-webhook `
    --since 5m `
    --format short `
    --profile $SelectedProfile `
    --region $SelectedRegion

  Write-Host ""
  Write-Host "Recent ECS logs:"
  aws logs tail /ecs/serverless-openclaw `
    --since 5m `
    --format short `
    --profile $SelectedProfile `
    --region $SelectedRegion
}

function Wait-BridgeSignals {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][string]$SelectedScenario,
    [Parameter(Mandatory = $true)][long]$StartTimeMs,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $requiredSignals = @(
    "bridge.tool.context.created",
    "bridge.tool.context.reused",
    "bridge.delivery.success"
  )

  if ($SelectedScenario -eq "TravelPaymentFollowUp") {
    $requiredSignals += @(
      "bridge.tool.payment.refine.completed",
      '"followUpIntent":"issuer_breakdown"'
    )
  }

  $forbiddenSignals = @(
    "Failed to persist durable tool context",
    "missing scope: operator.write",
    "TaskDefinition is inactive",
    "CIAO PROBING",
    "bridge.tool.handler.fallback"
  )

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastMissing = $requiredSignals

  Write-Host ""
  Write-Host "Waiting for Bridge processing signals..."

  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $messages = aws logs filter-log-events `
      --log-group-name /ecs/serverless-openclaw `
      --start-time $StartTimeMs `
      --query "events[].message" `
      --output text `
      --profile $SelectedProfile `
      --region $SelectedRegion

    if ($LASTEXITCODE -ne 0) {
      throw "Failed to read ECS logs for Bridge signal check."
    }

    $text = ($messages | Out-String)
    $forbiddenHit = $forbiddenSignals | Where-Object { $text.Contains($_) } | Select-Object -First 1
    if ($forbiddenHit) {
      throw "Bridge signal check failed: found forbidden signal '$forbiddenHit'."
    }

    $lastMissing = @($requiredSignals | Where-Object { -not $text.Contains($_) })
    if ($lastMissing.Count -eq 0) {
      Write-Host "Bridge signal check passed."
      return
    }

    Start-Sleep -Seconds 5
  }

  throw "Bridge signal check timed out after ${TimeoutSeconds}s. Missing: $($lastMissing -join ', ')"
}

if (-not $ApiEndpoint) {
  $ApiEndpoint = Resolve-ApiEndpoint -SelectedProfile $Profile -SelectedRegion $Region
}

if (-not $WebhookSecret) {
  $WebhookSecret = Resolve-WebhookSecret -SelectedProfile $Profile -SelectedRegion $Region
}

$messages = Get-ScenarioMessages -SelectedScenario $Scenario
$webhookUri = "$ApiEndpoint/telegram"
$baseUpdateId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$scenarioStartTimeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$resolvedUserId = Resolve-SyntheticUserId `
  -SelectedProfile $Profile `
  -SelectedRegion $Region `
  -SelectedTelegramId $TelegramId `
  -ExplicitUserId $UserId

if (-not $SkipStateReset) {
  Clear-SyntheticRuntimeState `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -SelectedUserId $resolvedUserId
}

Write-Host "Synthetic Telegram smoke"
Write-Host "  Endpoint : $webhookUri"
Write-Host "  ChatId   : $ChatId"
Write-Host "  Telegram : $TelegramId"
Write-Host "  UserId   : $resolvedUserId"
Write-Host "  Scenario : $Scenario"
Write-Host "  Pause(s) : $PauseSeconds"
Write-Host "  Reset    : $(-not $SkipStateReset)"
Write-Host "  Signals  : $(-not $SkipBridgeSignalCheck)"
Write-Host ""

for ($index = 0; $index -lt $messages.Count; $index++) {
  $text = $messages[$index]
  $updateId = $baseUpdateId + $index
  $messageId = 900001 + $index
  $json = New-TelegramUpdateJson `
    -UpdateId $updateId `
    -MessageId $messageId `
    -SelectedChatId $ChatId `
    -SelectedTelegramId $TelegramId `
    -Text $text

  Write-Host "[$($index + 1)/$($messages.Count)] POST -> $text"
  Send-TelegramWebhookEvent -Uri $webhookUri -Secret $WebhookSecret -JsonBody $json

  if ($index -lt ($messages.Count - 1)) {
    Start-Sleep -Seconds $PauseSeconds
  }
}

Write-Host ""
Write-Host "Synthetic Telegram smoke complete."

if (-not $SkipBridgeSignalCheck) {
  Wait-BridgeSignals `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -SelectedScenario $Scenario `
    -StartTimeMs $scenarioStartTimeMs `
    -TimeoutSeconds $BridgeSignalTimeoutSeconds
}

if (-not $TailLogs) {
  Write-Host "If you want the paired logs too, re-run with -TailLogs."
}

if ($TailLogs) {
  Start-Sleep -Seconds 12
  Show-RecentLogs -SelectedProfile $Profile -SelectedRegion $Region
}
