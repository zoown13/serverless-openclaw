param(
  [Parameter(Mandatory = $true)]
  [string]$UserId,
  [string]$SortKey,
  [string]$TableName = "PendingMessages",
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [ValidateSet("DeadLettered", "RetryScheduled", "Failed")]
  [string]$State = "DeadLettered",
  [int]$Limit = 20,
  [switch]$Execute
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

function Get-ItemState {
  param([Parameter(Mandatory = $true)]$Row)

  if ($Row.deadLetteredAt) { return "DeadLettered" }
  if ($Row.nextAttemptAt) { return "RetryScheduled" }
  if ($Row.lastError) { return "Failed" }
  return "Unknown"
}

$userPk = if ($UserId.StartsWith("USER#")) { $UserId } else { "USER#$UserId" }

$raw = aws dynamodb query `
  --table-name $TableName `
  --key-condition-expression "PK = :pk" `
  --expression-attribute-values "{`:pk`:{`"S`":`"$userPk`"}}" `
  --max-items $Limit `
  --profile $Profile `
  --region $Region `
  --output json

if ($LASTEXITCODE -ne 0) {
  throw "aws dynamodb query failed with exit code $LASTEXITCODE"
}

$result = $raw | ConvertFrom-Json -Depth 10
$rows = @(
  $result.Items | ForEach-Object {
    $row = Convert-DdbItem $_
    [pscustomobject]@{
      PK             = $row.PK
      SK             = $row.SK
      State          = Get-ItemState $row
      RetryCount     = $row.retryCount
      NextAttemptAt  = $row.nextAttemptAt
      DeadLetteredAt = $row.deadLetteredAt
      CreatedAt      = $row.createdAt
      LastError      = $row.lastError
    }
  }
) | Where-Object {
  $_.State -eq $State -and
  (-not $SortKey -or $_.SK -eq $SortKey)
}

if (-not $rows -or $rows.Count -eq 0) {
  Write-Host "No matching pending messages found for $UserId in state $State."
  return
}

$rows | Format-Table SK, State, RetryCount, NextAttemptAt, DeadLetteredAt, CreatedAt, LastError -AutoSize

if (-not $Execute) {
  Write-Host ""
  Write-Host "Preview only. Re-run with -Execute to clear retry metadata and make these messages eligible again on the next container startup."
  return
}

foreach ($row in $rows) {
  $null = aws dynamodb update-item `
    --table-name $TableName `
    --key "{`"PK`":{`"S`":`"$($row.PK)`"},`"SK`":{`"S`":`"$($row.SK)`"}}" `
    --update-expression "SET retryCount = :retryCount REMOVE nextAttemptAt, deadLetteredAt, lastError" `
    --expression-attribute-values "{`:retryCount`:{`"N`":`"0`"}}" `
    --profile $Profile `
    --region $Region `
    --return-values NONE

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to redrive pending message $($row.SK)"
  }

  Write-Host "Redriven $($row.SK)"
}

Write-Host ""
Write-Host "Redrive complete. The messages are now eligible on the next container startup."
