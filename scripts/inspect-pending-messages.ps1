param(
  [string]$TableName = "PendingMessages",
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [ValidateSet("AllFailures", "Retrying", "DeadLettered")]
  [string]$State = "AllFailures",
  [string]$UserId,
  [int]$Limit = 50,
  [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Convert-DdbValue {
  param([Parameter(Mandatory = $true)]$Value)

  $props = $Value.PSObject.Properties.Name
  if ($props -contains "S") { return [string]$Value.S }
  if ($props -contains "N") {
    $numberText = [string]$Value.N
    if ($numberText -match "^-?\d+$") {
      return [int64]$numberText
    }
    return [double]$numberText
  }
  if ($props -contains "BOOL") { return [bool]$Value.BOOL }
  if ($props -contains "NULL") { return $null }
  if ($props -contains "L") { return @($Value.L | ForEach-Object { Convert-DdbValue $_ }) }
  if ($props -contains "M") {
    $map = @{}
    foreach ($entry in $Value.M.PSObject.Properties) {
      $map[$entry.Name] = Convert-DdbValue $entry.Value
    }
    return $map
  }

  return $Value
}

function Convert-DdbItem {
  param([Parameter(Mandatory = $true)]$Item)

  $converted = @{}
  foreach ($entry in $Item.PSObject.Properties) {
    $converted[$entry.Name] = Convert-DdbValue $entry.Value
  }
  return [pscustomobject]$converted
}

function Get-StateFilter {
  param([Parameter(Mandatory = $true)][string]$RequestedState)

  switch ($RequestedState) {
    "Retrying" {
      return "attribute_exists(nextAttemptAt) AND attribute_not_exists(deadLetteredAt)"
    }
    "DeadLettered" {
      return "attribute_exists(deadLetteredAt)"
    }
    default {
      return "attribute_exists(lastError) OR attribute_exists(nextAttemptAt) OR attribute_exists(deadLetteredAt)"
    }
  }
}

function Get-RowState {
  param([Parameter(Mandatory = $true)]$Row)

  if ($Row.deadLetteredAt) { return "DeadLettered" }
  if ($Row.nextAttemptAt) { return "RetryScheduled" }
  if ($Row.lastError) { return "Failed" }
  return "Unknown"
}

$filterExpression = Get-StateFilter -RequestedState $State
$exprValuesPath = $null

try {
  $awsArgs = @(
    "dynamodb", "scan",
    "--table-name", $TableName,
    "--projection-expression", "PK,SK,channel,retryCount,nextAttemptAt,lastError,deadLetteredAt,createdAt",
    "--filter-expression", $filterExpression,
    "--max-items", "$Limit",
    "--profile", $Profile,
    "--region", $Region,
    "--output", "json"
  )

  if ($UserId) {
    $userPk = if ($UserId.StartsWith("USER#")) { $UserId } else { "USER#$UserId" }
    $exprValuesPath = Join-Path ([System.IO.Path]::GetTempPath()) ("pending-messages-" + [guid]::NewGuid().ToString("N") + ".json")
    $exprValues = @{
      ":pk" = @{ S = $userPk }
    } | ConvertTo-Json -Compress -Depth 5
    [System.IO.File]::WriteAllText($exprValuesPath, $exprValues, (New-Object System.Text.UTF8Encoding($false)))
    $awsArgs[7] = "(begins_with(PK, :pk)) AND ($filterExpression)"
    $awsArgs += @("--expression-attribute-values", "file://$exprValuesPath")
  }

  $raw = & aws @awsArgs
  if ($LASTEXITCODE -ne 0) {
    throw "aws dynamodb scan failed with exit code $LASTEXITCODE"
  }

  $result = $raw | ConvertFrom-Json -Depth 10
  $rows = @(
    $result.Items | ForEach-Object {
      $row = Convert-DdbItem $_
      [pscustomobject]@{
        UserId         = ([string]$row.PK).Replace("USER#", "")
        SortKey        = $row.SK
        State          = Get-RowState $row
        RetryCount     = $row.retryCount
        NextAttemptAt  = $row.nextAttemptAt
        DeadLetteredAt = $row.deadLetteredAt
        Channel        = $row.channel
        CreatedAt      = $row.createdAt
        LastError      = $row.lastError
      }
    }
  ) | Sort-Object @{ Expression = {
      if ($_.DeadLetteredAt) { return [DateTime]$_.DeadLetteredAt }
      if ($_.NextAttemptAt) { return [DateTime]$_.NextAttemptAt }
      return [DateTime]$_.CreatedAt
    }; Descending = $true }

  if (-not $rows -or $rows.Count -eq 0) {
    Write-Host "No matching pending messages found."
    return
  }

  if ($AsJson) {
    $rows | ConvertTo-Json -Depth 5
    return
  }

  $rows | Format-Table UserId, State, RetryCount, NextAttemptAt, DeadLetteredAt, Channel, CreatedAt, LastError, SortKey -AutoSize
} finally {
  if ($exprValuesPath -and (Test-Path $exprValuesPath)) {
    Remove-Item $exprValuesPath -Force -ErrorAction SilentlyContinue
  }
}
