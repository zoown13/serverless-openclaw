param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$ApiEndpoint,
  [string]$WebhookSecret,
  [Parameter(Mandatory = $true)]
  [long]$ChatId,
  [long]$TelegramId,
  [ValidateSet("PaymentFollowUp")]
  [string]$Scenario = "PaymentFollowUp",
  [int]$PauseSeconds = 10,
  [switch]$TailLogs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $TelegramId) {
  $TelegramId = $ChatId
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

  $handler = [System.Net.Http.HttpClientHandler]::new()
  $client = [System.Net.Http.HttpClient]::new($handler)
  try {
    $request = [System.Net.Http.HttpRequestMessage]::new(
      [System.Net.Http.HttpMethod]::Post,
      $Uri
    )
    $request.Headers.Add("X-Telegram-Bot-Api-Secret-Token", $Secret)
    $request.Content = [System.Net.Http.ByteArrayContent]::new(
      [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
    )
    $request.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse(
      "application/json; charset=utf-8"
    )

    $response = $client.Send($request)
    if (-not $response.IsSuccessStatusCode) {
      $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      throw "Webhook returned HTTP $([int]$response.StatusCode): $body"
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
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

if (-not $ApiEndpoint) {
  $ApiEndpoint = Resolve-ApiEndpoint -SelectedProfile $Profile -SelectedRegion $Region
}

if (-not $WebhookSecret) {
  $WebhookSecret = Resolve-WebhookSecret -SelectedProfile $Profile -SelectedRegion $Region
}

$messages = Get-ScenarioMessages -SelectedScenario $Scenario
$webhookUri = "$ApiEndpoint/telegram"
$baseUpdateId = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

Write-Host "Synthetic Telegram smoke"
Write-Host "  Endpoint : $webhookUri"
Write-Host "  ChatId   : $ChatId"
Write-Host "  Telegram : $TelegramId"
Write-Host "  Scenario : $Scenario"
Write-Host "  Pause(s) : $PauseSeconds"
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
Write-Host "If you want the paired logs too, re-run with -TailLogs."

if ($TailLogs) {
  Start-Sleep -Seconds 12
  Show-RecentLogs -SelectedProfile $Profile -SelectedRegion $Region
}
