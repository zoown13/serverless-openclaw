param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$TraceId,
  [string]$UserId,
  [long]$TelegramId,
  [ValidateSet("telegram", "web")]
  [string]$Channel = "telegram",
  [int]$SinceMinutes = 30,
  [int]$Limit = 250,
  [switch]$IncludeRawEvents
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Utf8NoBomJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Json
  )

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Json, $utf8NoBom)
}

function Get-OptionalProperty {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $Object) {
    return $null
  }

  if ($Object.PSObject.Properties.Match($Name).Count -eq 0) {
    return $null
  }

  return $Object.$Name
}

function ConvertFrom-DynamoAttribute {
  param($Attribute)

  if ($null -eq $Attribute) {
    return $null
  }

  if ($Attribute.PSObject.Properties.Match("S").Count -gt 0) {
    return $Attribute.S
  }

  if ($Attribute.PSObject.Properties.Match("N").Count -gt 0) {
    return $Attribute.N
  }

  if ($Attribute.PSObject.Properties.Match("BOOL").Count -gt 0) {
    return $Attribute.BOOL
  }

  if ($Attribute.PSObject.Properties.Match("M").Count -gt 0) {
    $result = [ordered]@{}
    foreach ($property in $Attribute.M.PSObject.Properties) {
      $result[$property.Name] = ConvertFrom-DynamoAttribute -Attribute $property.Value
    }
    return [pscustomobject]$result
  }

  if ($Attribute.PSObject.Properties.Match("L").Count -gt 0) {
    return @($Attribute.L | ForEach-Object { ConvertFrom-DynamoAttribute -Attribute $_ })
  }

  return $Attribute
}

function ConvertFrom-DynamoItem {
  param($Item)

  if ($null -eq $Item) {
    return $null
  }

  $result = [ordered]@{}
  foreach ($property in $Item.PSObject.Properties) {
    $result[$property.Name] = ConvertFrom-DynamoAttribute -Attribute $property.Value
  }

  return [pscustomobject]$result
}

function Invoke-AwsJson {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$AllowFailure
  )

  $output = & aws @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) {
    if ($AllowFailure) {
      return $null
    }

    throw "AWS CLI command failed: aws $($Arguments -join ' ')"
  }

  if (-not $output) {
    return $null
  }

  return ([string]::Join("`n", @($output)) | ConvertFrom-Json)
}

function Resolve-LinkedTelegramUserId {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][long]$SelectedTelegramId
  )

  $telegramKey = "telegram:$SelectedTelegramId"
  $tempPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("telegram-link-key-{0}.json" -f [Guid]::NewGuid().ToString("N"))

  try {
    Write-Utf8NoBomJson `
      -Path $tempPath `
      -Json "{`"PK`":{`"S`":`"USER#$telegramKey`"},`"SK`":{`"S`":`"SETTING#linked-cognito`"}}"

    $linked = Invoke-AwsJson `
      -Arguments @(
        "dynamodb", "get-item",
        "--table-name", "serverless-openclaw-Settings",
        "--key", "file://$tempPath",
        "--output", "json",
        "--profile", $SelectedProfile,
        "--region", $SelectedRegion
      ) `
      -AllowFailure

    $item = Get-OptionalProperty -Object $linked -Name "Item"
    $decoded = ConvertFrom-DynamoItem -Item $item
    $value = Get-OptionalProperty -Object $decoded -Name "value"
    $cognitoUserId = Get-OptionalProperty -Object $value -Name "cognitoUserId"

    if ($cognitoUserId) {
      return $cognitoUserId
    }
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      Remove-Item -LiteralPath $tempPath -Force
    }
  }

  return $telegramKey
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

  $discovered = & aws logs describe-log-groups `
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

function ConvertFrom-StructuredLogMessage {
  param([Parameter(Mandatory = $true)][string]$Message)

  $jsonStart = $Message.IndexOf("{")
  if ($jsonStart -lt 0) {
    return $null
  }

  $candidate = $Message.Substring($jsonStart).Trim()
  try {
    return ($candidate | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Read-LogEvents {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][string]$LogGroup,
    [Parameter(Mandatory = $true)][long]$StartTimeMs,
    [Parameter(Mandatory = $true)][int]$SelectedLimit,
    [string]$FilterPattern
  )

  $arguments = @(
    "logs", "filter-log-events",
    "--log-group-name", $LogGroup,
    "--start-time", "$StartTimeMs",
    "--limit", "$SelectedLimit",
    "--output", "json",
    "--profile", $SelectedProfile,
    "--region", $SelectedRegion
  )

  if ($FilterPattern) {
    $arguments += @("--filter-pattern", $FilterPattern)
  }

  $result = Invoke-AwsJson -Arguments $arguments -AllowFailure
  if ($null -eq $result) {
    return @()
  }

  $events = Get-OptionalProperty -Object $result -Name "events"
  if ($null -eq $events) {
    return @()
  }

  return @($events | ForEach-Object {
    $message = Get-OptionalProperty -Object $_ -Name "message"
    $structured = if ($message) { ConvertFrom-StructuredLogMessage -Message $message } else { $null }
    [pscustomobject]@{
      Timestamp = [int64](Get-OptionalProperty -Object $_ -Name "timestamp")
      LogGroup = $LogGroup
      LogStream = Get-OptionalProperty -Object $_ -Name "logStreamName"
      Message = $message
      Json = $structured
    }
  })
}

function Read-AllOperationalEvents {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][long]$StartTimeMs,
    [Parameter(Mandatory = $true)][int]$SelectedLimit,
    [string]$SelectedTraceId,
    [string]$SelectedUserId
  )

  $logGroups = @(
    "/aws/lambda/serverless-openclaw-telegram-webhook",
    "/aws/lambda/serverless-openclaw-ws-message",
    "/aws/lambda/serverless-openclaw-api-handler",
    "/aws/lambda/serverless-openclaw-agent",
    "/ecs/serverless-openclaw"
  )

  $logGroups += Get-AgentCoreLogGroups `
    -SelectedProfile $SelectedProfile `
    -SelectedRegion $SelectedRegion
  $logGroups = @($logGroups | Where-Object { $_ } | Select-Object -Unique)

  $filterPattern = $null
  if ($SelectedTraceId) {
    $filterPattern = $SelectedTraceId
  } elseif ($SelectedUserId) {
    $filterPattern = $SelectedUserId
  }

  $events = @()
  foreach ($logGroup in $logGroups) {
    $events += Read-LogEvents `
      -SelectedProfile $SelectedProfile `
      -SelectedRegion $SelectedRegion `
      -LogGroup $logGroup `
      -StartTimeMs $StartTimeMs `
      -SelectedLimit $SelectedLimit `
      -FilterPattern $filterPattern
  }

  if ($events.Count -eq 0 -and $filterPattern) {
    foreach ($logGroup in $logGroups) {
      $events += Read-LogEvents `
        -SelectedProfile $SelectedProfile `
        -SelectedRegion $SelectedRegion `
        -LogGroup $logGroup `
        -StartTimeMs $StartTimeMs `
        -SelectedLimit $SelectedLimit
    }
  }

  return @(
    $events |
      Where-Object {
        $matchesFilter = $true
        if ($SelectedTraceId) {
          $matchesFilter = ($_.Message -like "*$SelectedTraceId*")
        } elseif ($SelectedUserId) {
          $matchesFilter = (
            $_.Message -like "*$SelectedUserId*" -or
            $_.Message -like "*session-$SelectedUserId*"
          )
        }

        $matchesFilter
      } |
      Sort-Object Timestamp
  )
}

function Read-DynamoState {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][string]$SelectedUserId,
    [Parameter(Mandatory = $true)][string]$SelectedChannel
  )

  $taskKeyPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("taskstate-key-{0}.json" -f [Guid]::NewGuid().ToString("N"))
  $affinityKeyPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("active-tool-key-{0}.json" -f [Guid]::NewGuid().ToString("N"))
  $pendingValuesPath = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("pending-values-{0}.json" -f [Guid]::NewGuid().ToString("N"))

  try {
    Write-Utf8NoBomJson `
      -Path $taskKeyPath `
      -Json "{`"PK`":{`"S`":`"USER#$SelectedUserId`"}}"
    Write-Utf8NoBomJson `
      -Path $affinityKeyPath `
      -Json "{`"PK`":{`"S`":`"USER#$SelectedUserId`"},`"SK`":{`"S`":`"SETTING#active-tool:$SelectedChannel`"}}"
    Write-Utf8NoBomJson `
      -Path $pendingValuesPath `
      -Json "{`":pk`":{`"S`":`"USER#$SelectedUserId`"}}"

    $taskState = Invoke-AwsJson `
      -Arguments @(
        "dynamodb", "get-item",
        "--table-name", "serverless-openclaw-TaskState",
        "--key", "file://$taskKeyPath",
        "--output", "json",
        "--profile", $SelectedProfile,
        "--region", $SelectedRegion
      ) `
      -AllowFailure
    $affinity = Invoke-AwsJson `
      -Arguments @(
        "dynamodb", "get-item",
        "--table-name", "serverless-openclaw-Settings",
        "--key", "file://$affinityKeyPath",
        "--output", "json",
        "--profile", $SelectedProfile,
        "--region", $SelectedRegion
      ) `
      -AllowFailure
    $pending = Invoke-AwsJson `
      -Arguments @(
        "dynamodb", "query",
        "--table-name", "serverless-openclaw-PendingMessages",
        "--key-condition-expression", "PK = :pk",
        "--expression-attribute-values", "file://$pendingValuesPath",
        "--scan-index-forward", "false",
        "--limit", "10",
        "--output", "json",
        "--profile", $SelectedProfile,
        "--region", $SelectedRegion
      ) `
      -AllowFailure

    $taskItem = if ($taskState) { ConvertFrom-DynamoItem -Item (Get-OptionalProperty -Object $taskState -Name "Item") } else { $null }
    $affinityItem = if ($affinity) { ConvertFrom-DynamoItem -Item (Get-OptionalProperty -Object $affinity -Name "Item") } else { $null }
    $pendingItems = @()
    if ($pending) {
      $rawItems = Get-OptionalProperty -Object $pending -Name "Items"
      if ($rawItems) {
        $pendingItems = @($rawItems | ForEach-Object { ConvertFrom-DynamoItem -Item $_ })
      }
    }

    return [pscustomobject]@{
      TaskState = $taskItem
      ActiveToolAffinity = $affinityItem
      PendingMessages = $pendingItems
    }
  } finally {
    foreach ($path in @($taskKeyPath, $affinityKeyPath, $pendingValuesPath)) {
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
      }
    }
  }
}

function Format-Time {
  param([Parameter(Mandatory = $true)][int64]$Timestamp)

  return ([DateTimeOffset]::FromUnixTimeMilliseconds($Timestamp).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss"))
}

function Get-EventName {
  param($Event)

  $json = Get-OptionalProperty -Object $Event -Name "Json"
  $name = Get-OptionalProperty -Object $json -Name "event"
  if ($name) {
    return $name
  }

  $message = Get-OptionalProperty -Object $Event -Name "Message"
  if ($message -match "\[(?<component>[^\]]+)\]\s+(?<text>.+)") {
    return $Matches.text.Trim()
  }

  return "log"
}

function Get-EventLayer {
  param($Event)

  $logGroup = Get-OptionalProperty -Object $Event -Name "LogGroup"
  if ($logGroup -like "*telegram-webhook*" -or $logGroup -like "*ws-message*" -or $logGroup -like "*api-handler*") {
    return "gateway"
  }

  if ($logGroup -like "*serverless-openclaw-agent*") {
    return "lambda-agent"
  }

  if ($logGroup -like "*bedrock-agentcore*" -or $logGroup -like "*ecs/serverless-openclaw*") {
    return "tool-runtime"
  }

  return "unknown"
}

function Select-OperationalEvents {
  param([Parameter(Mandatory = $true)]$Events)

  $interesting = @(
    "route.classified",
    "route.affinity.created",
    "route.affinity.reused",
    "route.affinity.cleared",
    "agentcore.invoke.started",
    "agentcore.invoke.completed",
    "agentcore.invoke.fallback",
    "agentcore.invoke.handoff",
    "route.lambda.invoked",
    "lambda.request.accepted",
    "lambda.delivery.telegram.success",
    "lambda.delivery.web.success",
    "bridge.message.accepted",
    "bridge.tool.intent.decided",
    "bridge.slm.classified",
    "bridge.tool.context.created",
    "bridge.tool.context.reused",
    "bridge.tool.context.cleared",
    "bridge.tool.handoff.chat_only",
    "bridge.tool.payment.refine.started",
    "bridge.tool.payment.refine.completed",
    "bridge.tool.payment.refine.used_body_check",
    "bridge.delivery.success",
    "bridge.delivery.failed",
    "bridge.openclaw_fallback.unavailable"
  )

  return @($Events | Where-Object {
    $name = Get-EventName -Event $_
    $message = Get-OptionalProperty -Object $_ -Name "Message"
    return (
      $interesting -contains $name -or
      $message -match "error|timeout|timed out|failed|missing scope|TaskDefinition is inactive|Port 18789 not ready"
    )
  })
}

function Test-HasEvent {
  param(
    [Parameter(Mandatory = $true)]$Events,
    [Parameter(Mandatory = $true)][string]$Name
  )

  return [bool](@($Events | Where-Object { (Get-EventName -Event $_) -eq $Name } | Select-Object -First 1).Count)
}

function Get-Diagnosis {
  param([Parameter(Mandatory = $true)]$Events)

  $hasGateway = Test-HasEvent -Events $Events -Name "route.classified"
  $hasAgentCoreStarted = Test-HasEvent -Events $Events -Name "agentcore.invoke.started"
  $hasAgentCoreCompleted = Test-HasEvent -Events $Events -Name "agentcore.invoke.completed"
  $hasAgentCoreFallback = Test-HasEvent -Events $Events -Name "agentcore.invoke.fallback"
  $hasAgentCoreHandoff = Test-HasEvent -Events $Events -Name "agentcore.invoke.handoff"
  $hasBridgeAccepted = Test-HasEvent -Events $Events -Name "bridge.message.accepted"
  $hasPlannerDecision = Test-HasEvent -Events $Events -Name "bridge.tool.intent.decided"
  $hasBridgeDelivery = Test-HasEvent -Events $Events -Name "bridge.delivery.success"
  $hasLambdaInvoked = Test-HasEvent -Events $Events -Name "route.lambda.invoked"
  $hasLambdaDelivery = Test-HasEvent -Events $Events -Name "lambda.delivery.telegram.success" -or
    Test-HasEvent -Events $Events -Name "lambda.delivery.web.success"
  $hasBridgeFailure = Test-HasEvent -Events $Events -Name "bridge.delivery.failed"
  $hasOpenClawFallbackUnavailable = Test-HasEvent -Events $Events -Name "bridge.openclaw_fallback.unavailable"

  if (-not $hasGateway -and -not $hasBridgeAccepted -and -not $hasLambdaInvoked) {
    return [pscustomobject]@{
      Status = "attention"
      Layer = "ingress"
      Summary = "No matching Gateway, Lambda, or tool-runtime event was found in the selected window."
      NextAction = "Check the time window, traceId/userId filter, Telegram webhook registration, and API Gateway invocation logs."
    }
  }

  if ($hasAgentCoreStarted -and -not ($hasAgentCoreCompleted -or $hasAgentCoreFallback -or $hasAgentCoreHandoff)) {
    return [pscustomobject]@{
      Status = "attention"
      Layer = "agentcore"
      Summary = "Gateway invoked AgentCore, but no completion, fallback, or chat handoff was observed."
      NextAction = "Inspect the AgentCore runtime log group and consider reducing the invoke deadline or allowing Fargate fallback."
    }
  }

  if ($hasBridgeAccepted -and -not ($hasPlannerDecision -or $hasBridgeDelivery -or $hasAgentCoreHandoff)) {
    return [pscustomobject]@{
      Status = "attention"
      Layer = "tool-runtime"
      Summary = "The tool runtime accepted the message, but no planner decision or delivery event was observed."
      NextAction = "Inspect bridge.tool.intent logs, provider/model errors, Gmail readiness, and runtime timeout logs."
    }
  }

  if ($hasAgentCoreHandoff -or $hasLambdaInvoked) {
    if ($hasLambdaDelivery) {
      return [pscustomobject]@{
        Status = "healthy"
        Layer = "chat-handoff"
        Summary = "Tool runtime handed the turn back to chat-only and Lambda delivered the response."
        NextAction = "No action needed. If the answer quality was poor, add the conversation to the planner quality eval set."
      }
    }

    return [pscustomobject]@{
      Status = "attention"
      Layer = "lambda-agent"
      Summary = "A chat-only handoff or Lambda invocation happened, but no delivery success was observed."
      NextAction = "Inspect /aws/lambda/serverless-openclaw-agent for provider, Bedrock, or Telegram delivery errors."
    }
  }

  if ($hasBridgeDelivery) {
    return [pscustomobject]@{
      Status = "healthy"
      Layer = "tool-runtime"
      Summary = "The tool runtime delivered a response successfully."
      NextAction = "No action needed. If the content was wrong, add the turn to the semantic routing or Gmail retrieval eval set."
    }
  }

  if ($hasAgentCoreFallback) {
    return [pscustomobject]@{
      Status = "attention"
      Layer = "fallback"
      Summary = "AgentCore fallback was triggered, but no successful downstream delivery was found."
      NextAction = "Check PendingMessages, TaskState, and Fargate task startup logs."
    }
  }

  if ($hasBridgeFailure -or $hasOpenClawFallbackUnavailable) {
    return [pscustomobject]@{
      Status = "attention"
      Layer = "tool-runtime"
      Summary = "The runtime reported a controlled delivery or OpenClaw fallback failure."
      NextAction = "If direct tool fast path succeeded, this may be harmless. Otherwise inspect bridge error logs and OpenClaw port readiness."
    }
  }

  return [pscustomobject]@{
    Status = "unknown"
    Layer = "unknown"
    Summary = "Events were found, but they do not map to a known operational pattern yet."
    NextAction = "Re-run with -IncludeRawEvents and add the new pattern to this diagnostic script."
  }
}

function Show-DynamoState {
  param($State)

  if ($null -eq $State) {
    Write-Host "DynamoDB state: not inspected"
    return
  }

  $taskStatus = Get-OptionalProperty -Object $State.TaskState -Name "status"
  $taskTtl = Get-OptionalProperty -Object $State.TaskState -Name "ttl"
  $affinityValue = Get-OptionalProperty -Object $State.ActiveToolAffinity -Name "value"
  $affinityProvider = Get-OptionalProperty -Object $affinityValue -Name "provider"
  $affinityRuntimeClass = Get-OptionalProperty -Object $affinityValue -Name "runtimeClass"
  $affinityExpiresAt = Get-OptionalProperty -Object $affinityValue -Name "expiresAt"
  $pendingCount = @($State.PendingMessages).Count

  Write-Host "DynamoDB state:"
  Write-Host "  TaskState.status       : $(if ($taskStatus) { $taskStatus } else { 'none' })"
  Write-Host "  TaskState.ttl          : $(if ($taskTtl) { $taskTtl } else { 'none' })"
  Write-Host "  ActiveTool.provider    : $(if ($affinityProvider) { $affinityProvider } else { 'none' })"
  Write-Host "  ActiveTool.runtime     : $(if ($affinityRuntimeClass) { $affinityRuntimeClass } else { 'none' })"
  Write-Host "  ActiveTool.expiresAt   : $(if ($affinityExpiresAt) { $affinityExpiresAt } else { 'none' })"
  Write-Host "  PendingMessages.count  : $pendingCount"
}

if ($TelegramId -and -not $UserId) {
  $UserId = Resolve-LinkedTelegramUserId `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -SelectedTelegramId $TelegramId
}

$startTimeMs = [DateTimeOffset]::UtcNow.AddMinutes(-1 * $SinceMinutes).ToUnixTimeMilliseconds()
$events = Read-AllOperationalEvents `
  -SelectedProfile $Profile `
  -SelectedRegion $Region `
  -StartTimeMs $startTimeMs `
  -SelectedLimit $Limit `
  -SelectedTraceId $TraceId `
  -SelectedUserId $UserId
$operationalEvents = Select-OperationalEvents -Events $events
$diagnosis = Get-Diagnosis -Events $operationalEvents
$dynamoState = if ($UserId) {
  Read-DynamoState `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -SelectedUserId $UserId `
    -SelectedChannel $Channel
} else {
  $null
}

Write-Host "Operational Copilot v1 diagnosis"
Write-Host "  Region       : $Region"
Write-Host "  Window       : last $SinceMinutes minute(s)"
Write-Host "  Channel      : $Channel"
Write-Host "  TraceId      : $(if ($TraceId) { $TraceId } else { 'not provided' })"
Write-Host "  UserId       : $(if ($UserId) { $UserId } else { 'not provided' })"
Write-Host "  Events       : $($operationalEvents.Count) operational / $($events.Count) total"
Write-Host ""

Show-DynamoState -State $dynamoState

Write-Host ""
Write-Host "Timeline:"
if ($operationalEvents.Count -eq 0) {
  Write-Host "  No matching operational events found."
} else {
  foreach ($event in $operationalEvents) {
    $json = Get-OptionalProperty -Object $event -Name "Json"
    $name = Get-EventName -Event $event
    $layer = Get-EventLayer -Event $event
    $action = Get-OptionalProperty -Object $json -Name "action"
    $followUpIntent = Get-OptionalProperty -Object $json -Name "followUpIntent"
    $runtimeClass = Get-OptionalProperty -Object $json -Name "runtimeClass"
    $routeDecision = Get-OptionalProperty -Object $json -Name "routeDecision"
    $provider = Get-OptionalProperty -Object $json -Name "toolRuntimeProvider"
    $source = Get-OptionalProperty -Object $json -Name "source"

    $details = @()
    if ($runtimeClass) { $details += "runtime=$runtimeClass" }
    if ($routeDecision) { $details += "route=$routeDecision" }
    if ($provider) { $details += "provider=$provider" }
    if ($action) { $details += "action=$action" }
    if ($followUpIntent) { $details += "intent=$followUpIntent" }
    if ($source) { $details += "source=$source" }

    $suffix = if ($details.Count -gt 0) { " ($($details -join ', '))" } else { "" }
    Write-Host ("  {0} [{1}] {2}{3}" -f (Format-Time -Timestamp $event.Timestamp), $layer, $name, $suffix)
  }
}

Write-Host ""
Write-Host "Diagnosis:"
Write-Host "  Status      : $($diagnosis.Status)"
Write-Host "  Likely layer: $($diagnosis.Layer)"
Write-Host "  Summary     : $($diagnosis.Summary)"
Write-Host "  Next action : $($diagnosis.NextAction)"

if ($IncludeRawEvents) {
  Write-Host ""
  Write-Host "Raw matching events:"
  foreach ($event in $events) {
    Write-Host ("--- {0} {1}" -f (Format-Time -Timestamp $event.Timestamp), $event.LogGroup)
    Write-Host $event.Message
  }
}
