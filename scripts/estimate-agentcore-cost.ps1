param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [int]$SinceHours = 24,
  [int]$Limit = 1000,
  [double]$CpuVcpu = 1.0,
  [double]$MemoryGb = 0.5,
  [double]$CpuUsdPerVcpuHour = 0.0895,
  [double]$MemoryUsdPerGbHour = 0.00945,
  [double]$MonthlyBudgetUsd = 1.0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-OptionalProperty {
  param(
    $Object,
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

function Invoke-AwsJson {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$AllowFailure
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & aws @Arguments 2>$null
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

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
    [Parameter(Mandatory = $true)][int]$SelectedLimit
  )

  $result = Invoke-AwsJson `
    -Arguments @(
      "logs", "filter-log-events",
      "--log-group-name", $LogGroup,
      "--start-time", "$StartTimeMs",
      "--filter-pattern", "agentcore.invoke",
      "--limit", "$SelectedLimit",
      "--output", "json",
      "--profile", $SelectedProfile,
      "--region", $SelectedRegion
    ) `
    -AllowFailure

  if ($null -eq $result) {
    return @()
  }

  $events = Get-OptionalProperty -Object $result -Name "events"
  if ($null -eq $events) {
    return @()
  }

  return @($events | ForEach-Object {
    $message = Get-OptionalProperty -Object $_ -Name "message"
    $json = if ($message) { ConvertFrom-StructuredLogMessage -Message $message } else { $null }
    [pscustomobject]@{
      Timestamp = [int64](Get-OptionalProperty -Object $_ -Name "timestamp")
      LogGroup = $LogGroup
      Message = $message
      Json = $json
    }
  } | Where-Object { $null -ne $_.Json })
}

function New-AgentCoreInvocationSummary {
  param([Parameter(Mandatory = $true)]$Events)

  $started = @{}
  $terminal = @{}

  foreach ($event in @($Events | Sort-Object Timestamp)) {
    $json = Get-OptionalProperty -Object $event -Name "Json"
    $name = Get-OptionalProperty -Object $json -Name "event"
    $traceId = Get-OptionalProperty -Object $json -Name "traceId"
    if (-not $traceId) {
      continue
    }

    if ($name -eq "agentcore.invoke.started") {
      $started[$traceId] = $event
      continue
    }

    if ($name -in @("agentcore.invoke.completed", "agentcore.invoke.fallback", "agentcore.invoke.handoff")) {
      if (-not $terminal.ContainsKey($traceId)) {
        $terminal[$traceId] = $event
      }
    }
  }

  $records = @()
  foreach ($traceId in $started.Keys) {
    $startEvent = $started[$traceId]
    $endEvent = if ($terminal.ContainsKey($traceId)) { $terminal[$traceId] } else { $null }
    $endName = if ($endEvent) { Get-OptionalProperty -Object $endEvent.Json -Name "event" } else { "missing-terminal-event" }
    $durationMs = if ($endEvent) { [Math]::Max(0, [int64]$endEvent.Timestamp - [int64]$startEvent.Timestamp) } else { $null }

    $records += [pscustomobject]@{
      TraceId = $traceId
      StartTimestamp = $startEvent.Timestamp
      EndTimestamp = if ($endEvent) { $endEvent.Timestamp } else { $null }
      EndEvent = $endName
      DurationMs = $durationMs
    }
  }

  return @($records | Sort-Object StartTimestamp)
}

function Get-Percentile {
  param(
    [Parameter(Mandatory = $true)][double[]]$Values,
    [Parameter(Mandatory = $true)][double]$Percentile
  )

  if ($Values.Count -eq 0) {
    return 0
  }

  $sorted = @($Values | Sort-Object)
  $index = [Math]::Ceiling(($Percentile / 100.0) * $sorted.Count) - 1
  $index = [Math]::Max(0, [Math]::Min($sorted.Count - 1, $index))
  return $sorted[$index]
}

$startTimeMs = [DateTimeOffset]::UtcNow.AddHours(-1 * $SinceHours).ToUnixTimeMilliseconds()
$gatewayLogGroups = @(
  "/aws/lambda/serverless-openclaw-telegram-webhook",
  "/aws/lambda/serverless-openclaw-ws-message",
  "/aws/lambda/serverless-openclaw-api-handler"
)

$events = @()
foreach ($logGroup in $gatewayLogGroups) {
  $events += Read-LogEvents `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -LogGroup $logGroup `
    -StartTimeMs $startTimeMs `
    -SelectedLimit $Limit
}

$invocations = New-AgentCoreInvocationSummary -Events $events
$completed = @($invocations | Where-Object { $null -ne $_.DurationMs })
$durationsSeconds = @($completed | ForEach-Object { [double]$_.DurationMs / 1000.0 })
$totalSeconds = if ($durationsSeconds.Count -gt 0) { ($durationsSeconds | Measure-Object -Sum).Sum } else { 0.0 }
$avgSeconds = if ($durationsSeconds.Count -gt 0) { ($durationsSeconds | Measure-Object -Average).Average } else { 0.0 }
$p95Seconds = Get-Percentile -Values ([double[]]$durationsSeconds) -Percentile 95
$cpuCost = ($totalSeconds / 3600.0) * $CpuVcpu * $CpuUsdPerVcpuHour
$memoryCost = ($totalSeconds / 3600.0) * $MemoryGb * $MemoryUsdPerGbHour
$estimatedCost = $cpuCost + $memoryCost
$windowHours = [Math]::Max(1.0, [double]$SinceHours)
$monthlyProjection = $estimatedCost * (24.0 * 30.0 / $windowHours)
$budgetUsagePercent = if ($MonthlyBudgetUsd -gt 0) { ($monthlyProjection / $MonthlyBudgetUsd) * 100.0 } else { 0.0 }
$fallbackCount = @($invocations | Where-Object { $_.EndEvent -eq "agentcore.invoke.fallback" }).Count
$handoffCount = @($invocations | Where-Object { $_.EndEvent -eq "agentcore.invoke.handoff" }).Count
$missingCount = @($invocations | Where-Object { $_.EndEvent -eq "missing-terminal-event" }).Count

Write-Host "AgentCore cost guardrail estimate"
Write-Host "  Region             : $Region"
Write-Host "  Window             : last $SinceHours hour(s)"
Write-Host "  Invocations        : $($invocations.Count)"
Write-Host "  Completed pairs    : $($completed.Count)"
Write-Host "  Fallbacks          : $fallbackCount"
Write-Host "  Chat handoffs      : $handoffCount"
Write-Host "  Missing terminals  : $missingCount"
Write-Host ""
Write-Host "Duration summary:"
Write-Host "  Total wall seconds : $([Math]::Round($totalSeconds, 2))"
Write-Host "  Average seconds    : $([Math]::Round($avgSeconds, 2))"
Write-Host "  P95 seconds        : $([Math]::Round($p95Seconds, 2))"
Write-Host ""
Write-Host "Conservative cost estimate:"
Write-Host "  CPU assumption     : $CpuVcpu vCPU @ `$$CpuUsdPerVcpuHour/vCPU-hour"
Write-Host "  Memory assumption  : $MemoryGb GB @ `$$MemoryUsdPerGbHour/GB-hour"
Write-Host "  CPU estimate       : `$$(('{0:N6}' -f $cpuCost))"
Write-Host "  Memory estimate    : `$$(('{0:N6}' -f $memoryCost))"
Write-Host "  Window estimate    : `$$(('{0:N6}' -f $estimatedCost))"
Write-Host "  Monthly projection : `$$(('{0:N4}' -f $monthlyProjection))"
Write-Host "  Budget usage       : $([Math]::Round($budgetUsagePercent, 1))% of `$$MonthlyBudgetUsd/month"
Write-Host ""

if ($missingCount -gt 0) {
  Write-Host "Cost guardrail warning: $missingCount AgentCore invoke(s) have no terminal event in the selected window."
}

if ($monthlyProjection -gt $MonthlyBudgetUsd) {
  Write-Host "Cost guardrail warning: projected AgentCore runtime cost exceeds the configured monthly budget."
} else {
  Write-Host "Cost guardrail status: projected AgentCore runtime cost is within the configured monthly budget."
}

Write-Host ""
Write-Host "Note: this is a conservative wall-clock estimate from Gateway logs. AgentCore Runtime billing is based on active CPU consumption and peak memory consumed per second, so actual billed runtime cost may be lower during I/O wait."
