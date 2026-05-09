param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$ApiEndpoint,
  [string]$WebhookSecret,
  [Parameter(Mandatory = $true)]
  [long]$ChatId,
  [long]$TelegramId,
  [string]$UserId,
  [ValidateSet("PaymentFollowUp", "PaymentCoverageFollowUp", "PaymentCoverageThenIssuerBreakdown", "PaymentExpandedFirstTurn", "PaymentDeepScanFirstTurn", "PaymentHistoryCapability", "PaymentCapabilityThenChatHandoff", "PaymentThenEverydayChatHandoff", "RepeatedPaymentCacheHit", "PaymentDateRange", "TravelPaymentFollowUp", "TravelPaymentThenChatHandoff", "GenericPaymentThenTravelRefinement")]
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
    "PaymentCoverageFollowUp" {
      return @(
        "이번주 결제한 금액이 어느정도 되려나?",
        "합계만",
        "더 있을텐데",
        "5개 밖에 없어?"
      )
    }
    "PaymentCoverageThenIssuerBreakdown" {
      return @(
        "이번주 결제한 금액 얼마야",
        "더 있을텐데",
        "카드사별로"
      )
    }
    "PaymentExpandedFirstTurn" {
      return @(
        "이번주 결제한 금액 전체로 제한 풀고 봐줘"
      )
    }
    "PaymentDeepScanFirstTurn" {
      return @(
        "이번주 결제한 금액 100건까지 더 깊게 봐줘"
      )
    }
    "PaymentHistoryCapability" {
      return @(
        "결제 이력 확인할 수 있어?"
      )
    }
    "PaymentCapabilityThenChatHandoff" {
      return @(
        "결제 이력 확인할 수 있어?",
        "그거 말고 일반 질문으로 리눅스에서 파일 찾는 명령어 알려줘"
      )
    }
    "PaymentThenEverydayChatHandoff" {
      return @(
        "최근 결제한 내역 알려줘",
        "저녁 메뉴 추천해줘"
      )
    }
    "RepeatedPaymentCacheHit" {
      return @(
        "최근 결제한 내역 알려줘",
        "최근 결제한 내역 알려줘"
      )
    }
    "PaymentDateRange" {
      return @(
        "이번주 결제한 금액 알려줘",
        "지난주로 다시 봐줘",
        "최근 7일로 다시 봐줘",
        "4월 둘째주 결제한 금액 알려줘"
      )
    }
    "TravelPaymentFollowUp" {
      return @(
        "일본 여행가는데 결제한 내역들 알려줘",
        "일본관련된 것만 가져와야지",
        "카드사별로 보여줘"
      )
    }
    "TravelPaymentThenChatHandoff" {
      return @(
        "일본 여행가는데 결제한 내역들 알려줘",
        "일본관련된 것만 가져와야지",
        "카드사별로 보여줘",
        "리눅스에서 파일 찾는 명령어 알려줘"
      )
    }
    "GenericPaymentThenTravelRefinement" {
      return @(
        "최근 결제한 내역 알려줘",
        "더 있을텐데",
        "일본관련된 것만 가져와야지"
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

  try {
    $headers = @{
      "X-Telegram-Bot-Api-Secret-Token" = $Secret
    }
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)

    $response = Invoke-WebRequest `
      -Uri $Uri `
      -Method Post `
      -Headers $headers `
      -ContentType "application/json; charset=utf-8" `
      -Body $bodyBytes `
      -UseBasicParsing

    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
      throw "Webhook POST failed with HTTP $($response.StatusCode)."
    }
  } catch {
    throw "Webhook POST failed: $($_.Exception.Message)"
  }
}

function Get-AgentCoreLogGroups {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion
  )

  $logGroups = @()

  if ($env:AGENTCORE_LOG_GROUP) {
    $logGroups += $env:AGENTCORE_LOG_GROUP
  }

  if ($env:AGENTCORE_RUNTIME_ID) {
    $logGroups += "/aws/bedrock-agentcore/runtimes/$($env:AGENTCORE_RUNTIME_ID)-DEFAULT"
  }

  $discovered = aws logs describe-log-groups `
    --log-group-name-prefix /aws/bedrock-agentcore/runtimes/ `
    --query "logGroups[?contains(logGroupName, 'ServerlessOpenClawToolRuntime')].logGroupName" `
    --output text `
    --profile $SelectedProfile `
    --region $SelectedRegion 2>$null

  if ($LASTEXITCODE -eq 0 -and $discovered) {
    $logGroups += @($discovered -split "\s+" | Where-Object { $_ })
  }

  return @($logGroups | Where-Object { $_ } | Select-Object -Unique)
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
  Write-Host "Recent Lambda Agent logs:"
  aws logs tail /aws/lambda/serverless-openclaw-agent `
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

  $agentCoreLogGroups = Get-AgentCoreLogGroups `
    -SelectedProfile $SelectedProfile `
    -SelectedRegion $SelectedRegion

  foreach ($logGroup in $agentCoreLogGroups) {
    Write-Host ""
    Write-Host "Recent AgentCore Runtime logs: $logGroup"
    aws logs tail $logGroup `
      --since 5m `
      --format short `
      --profile $SelectedProfile `
      --region $SelectedRegion
  }
}

function Read-BridgeSignalMessages {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][long]$StartTimeMs,
    [Parameter(Mandatory = $true)][string[]]$LogGroups
  )

  $allMessages = @()
  $readCount = 0
  $effectiveStartTimeMs = [Math]::Max([int64]0, [int64]($StartTimeMs - 120000))

  foreach ($logGroup in $LogGroups) {
    $messages = aws logs filter-log-events `
      --log-group-name $logGroup `
      --start-time $effectiveStartTimeMs `
      --query "events[].message" `
      --output text `
      --profile $SelectedProfile `
      --region $SelectedRegion 2>$null

    if ($LASTEXITCODE -eq 0) {
      $readCount += 1
      if ($messages) {
        $allMessages += @($messages)
      }
    }
  }

  if ($readCount -eq 0) {
    throw "Failed to read Bridge logs from ECS or AgentCore log groups."
  }

  return [string]::Join("`n", @($allMessages))
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
    "bridge.delivery.success"
  )

  $requiredSignalGroups = @(
    [pscustomobject]@{
      Label = "bridge.tool.context.created or bridge.tool.context.reused"
      Signals = @("bridge.tool.context.created", "bridge.tool.context.reused")
    }
  )

  $requiresPaymentCoverageSignals = $SelectedScenario -eq "PaymentCoverageFollowUp"
  $requiresCoverageRerunSignals = $SelectedScenario -in @("PaymentCoverageFollowUp", "PaymentCoverageThenIssuerBreakdown", "GenericPaymentThenTravelRefinement")
  $requiresIssuerBreakdownSignals = $SelectedScenario -in @("PaymentCoverageThenIssuerBreakdown", "TravelPaymentFollowUp", "TravelPaymentThenChatHandoff")
  $requiresPaymentCapabilitySignals = $SelectedScenario -in @("PaymentHistoryCapability", "PaymentCapabilityThenChatHandoff")
  $requiresTravelSignals = $SelectedScenario -in @("TravelPaymentFollowUp", "TravelPaymentThenChatHandoff", "GenericPaymentThenTravelRefinement")
  $requiresDeepScanSignals = $SelectedScenario -eq "PaymentDeepScanFirstTurn"
  $requiresPaymentCacheHitSignals = $SelectedScenario -eq "RepeatedPaymentCacheHit"
  $requiresPaymentResponseQuality = $SelectedScenario -in @("PaymentCoverageFollowUp", "PaymentCoverageThenIssuerBreakdown", "PaymentExpandedFirstTurn", "PaymentDeepScanFirstTurn", "TravelPaymentFollowUp", "TravelPaymentThenChatHandoff", "GenericPaymentThenTravelRefinement")
  $requiresTravelResponseQuality = $requiresTravelSignals
  $requiresChatHandoff = $SelectedScenario -in @("TravelPaymentThenChatHandoff", "PaymentCapabilityThenChatHandoff", "PaymentThenEverydayChatHandoff")
  $requiresFindCommandHandoff = $SelectedScenario -in @("TravelPaymentThenChatHandoff", "PaymentCapabilityThenChatHandoff")

  if ($requiresPaymentCapabilitySignals) {
    $requiredSignalGroups = @()
    $requiredSignals += @(
      '"action":"answer_capability"'
    )
  }

  if ($requiresPaymentCoverageSignals) {
    $requiredSignals += @(
      '"followUpIntent":"amount_summary"'
    )
  }

  if ($requiresCoverageRerunSignals) {
    $requiredSignals += @(
      '"action":"rerun_current_task"'
    )
  }

  if ($requiresDeepScanSignals) {
    $requiredSignals += @(
      '"scanLimit":100'
    )
  }

  if ($requiresPaymentCacheHitSignals) {
    $requiredSignals += @(
      "bridge.tool.context.reused",
      '"action":"continue_active_task"',
      '"source":"gmail-context"'
    )
  }

  if ($requiresTravelSignals) {
    $requiredSignals += @(
      "bridge.tool.payment.refine.completed"
    )
  }

  if ($requiresIssuerBreakdownSignals) {
    $requiredSignals += @(
      '"followUpIntent":"issuer_breakdown"'
    )
  }

  if ($requiresPaymentResponseQuality) {
    $requiredSignals += @(
      "telegram.delivery.content_quality",
      '"hasKoreanPaymentSummary":true',
      '"hasPaymentCoverageDisclosure":true'
    )
  }

  if ($requiresIssuerBreakdownSignals) {
    $requiredSignals += @(
      '"hasIssuerBreakdownSignal":true'
    )
  }

  if ($requiresTravelResponseQuality) {
    $requiredSignals += @(
      '"hasTopicFilteredPaymentSignal":true'
    )
  }

  $requiredGatewaySignals = @()
  $requiredLambdaSignals = @()

  if ($requiresChatHandoff) {
    $requiredGatewaySignals = @(
      "route.affinity.cleared",
      '"runtimeClass":"chat-only"',
      "route.lambda.invoked"
    )
    $requiredLambdaSignals = @(
      "lambda.delivery.telegram.success",
      "lambda.delivery.content_quality",
      '"hasGeneralChatAnswer":true'
    )
    if ($requiresFindCommandHandoff) {
      $requiredLambdaSignals += @(
        '"hasFindCommandAnswer":true'
      )
    }
  }

  $forbiddenSignals = @(
    "Failed to persist durable tool context",
    "missing scope: operator.write",
    "TaskDefinition is inactive",
    "CIAO PROBING",
    "AgentCore runtime failed to process the request",
    "An error occurred",
    "Cannot read properties",
    "TypeError",
    "ReferenceError",
    '"hasRawInternalError":true',
    '"hasLegacyEnglishPaymentPhrases":true',
    '"hasFallbackFailureText":true'
  )

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastMissing = @($requiredSignals + ($requiredSignalGroups | ForEach-Object { $_.Label }))
  $bridgeLogGroups = @("/ecs/serverless-openclaw")
  $bridgeLogGroups += Get-AgentCoreLogGroups `
    -SelectedProfile $SelectedProfile `
    -SelectedRegion $SelectedRegion
  $bridgeLogGroups = @($bridgeLogGroups | Where-Object { $_ } | Select-Object -Unique)
  $gatewayLogGroups = @()
  $lambdaLogGroups = @()

  if ($requiresChatHandoff) {
    $gatewayLogGroups = @("/aws/lambda/serverless-openclaw-telegram-webhook")
    $lambdaLogGroups = @("/aws/lambda/serverless-openclaw-agent")
  }

  Write-Host ""
  Write-Host "Waiting for Bridge processing signals in:"
  $bridgeLogGroups | ForEach-Object { Write-Host "  - $_" }
  if ($requiresChatHandoff) {
    Write-Host "Waiting for Gateway handoff signals in:"
    $gatewayLogGroups | ForEach-Object { Write-Host "  - $_" }
    Write-Host "Waiting for Lambda chat delivery signals in:"
    $lambdaLogGroups | ForEach-Object { Write-Host "  - $_" }
  }

  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $text = Read-BridgeSignalMessages `
      -SelectedProfile $SelectedProfile `
      -SelectedRegion $SelectedRegion `
      -StartTimeMs $StartTimeMs `
      -LogGroups $bridgeLogGroups

    $gatewayText = ""
    $lambdaText = ""

    if ($requiresChatHandoff) {
      $gatewayText = Read-BridgeSignalMessages `
        -SelectedProfile $SelectedProfile `
        -SelectedRegion $SelectedRegion `
        -StartTimeMs $StartTimeMs `
        -LogGroups $gatewayLogGroups
      $lambdaText = Read-BridgeSignalMessages `
        -SelectedProfile $SelectedProfile `
        -SelectedRegion $SelectedRegion `
        -StartTimeMs $StartTimeMs `
        -LogGroups $lambdaLogGroups
    }

    $combinedText = [string]::Join("`n", @($text, $gatewayText, $lambdaText))
    $forbiddenHit = $forbiddenSignals | Where-Object { $combinedText.Contains($_) } | Select-Object -First 1
    if ($forbiddenHit) {
      throw "Bridge signal check failed: found forbidden signal '$forbiddenHit'."
    }

    $missingSignals = @($requiredSignals | Where-Object { -not $text.Contains($_) })
    if ($requiresChatHandoff) {
      $missingSignals += @(
        $requiredGatewaySignals |
          Where-Object { -not $gatewayText.Contains($_) } |
          ForEach-Object { "gateway:$_" }
      )
      $missingSignals += @(
        $requiredLambdaSignals |
          Where-Object { -not $lambdaText.Contains($_) } |
          ForEach-Object { "lambda:$_" }
      )
    }
    $missingGroups = @()

    foreach ($requiredGroup in $requiredSignalGroups) {
      $groupMatched = $false
      foreach ($signal in $requiredGroup.Signals) {
        if ($text.Contains($signal)) {
          $groupMatched = $true
          break
        }
      }

      if (-not $groupMatched) {
        $missingGroups += $requiredGroup.Label
      }
    }

    $lastMissing = @($missingSignals + $missingGroups)
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

$messages = @(Get-ScenarioMessages -SelectedScenario $Scenario)
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
