param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$UserId,
  [long]$TelegramId,
  [ValidateSet("telegram", "web")]
  [string]$Channel = "telegram",
  [int]$SinceMinutes = 120,
  [int]$StaleTaskAgeHours = 6,
  [switch]$AllEvents
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$diagnosePath = Join-Path $scriptRoot "diagnose-operational-copilot.ps1"
$repairPath = Join-Path $scriptRoot "repair-operational-copilot.ps1"

if (-not (Test-Path -LiteralPath $diagnosePath)) {
  throw "Diagnostic script not found: $diagnosePath"
}

if (-not (Test-Path -LiteralPath $repairPath)) {
  throw "Repair runbook script not found: $repairPath"
}

function Invoke-CheckedScript {
  param([Parameter(Mandatory = $true)][string[]]$Command)

  & $Command[0] @($Command | Select-Object -Skip 1)
  if ($LASTEXITCODE -ne 0) {
    throw "Operational health check step failed: $($Command -join ' ')"
  }
}

$identityArgs = @()
if ($TelegramId) {
  $identityArgs += @("-TelegramId", "$TelegramId")
}
if ($UserId) {
  $identityArgs += @("-UserId", $UserId)
}
if ($identityArgs.Count -eq 0) {
  throw "Provide either -TelegramId or -UserId."
}

Write-Host "Operational health check"
Write-Host "  Region        : $Region"
Write-Host "  Channel       : $Channel"
Write-Host "  SinceMinutes  : $SinceMinutes"
Write-Host "  StaleTaskAgeH : $StaleTaskAgeHours"
Write-Host ""

Write-Host "== 1. Latest trace diagnosis =="
$diagnoseCommand = @(
  "powershell", "-File", $diagnosePath,
  "-Profile", $Profile,
  "-Region", $Region,
  "-Channel", $Channel,
  "-SinceMinutes", "$SinceMinutes"
) + $identityArgs
if ($AllEvents) {
  $diagnoseCommand += "-AllEvents"
}
Invoke-CheckedScript -Command $diagnoseCommand

Write-Host ""
Write-Host "== 2. Pending queue inspection =="
Invoke-CheckedScript -Command (@(
  "powershell", "-File", $repairPath,
  "-Profile", $Profile,
  "-Region", $Region,
  "-Channel", $Channel,
  "-Action", "inspect-pending-messages"
) + $identityArgs)

Write-Host ""
Write-Host "== 3. Fargate cost guardrail inspection =="
Invoke-CheckedScript -Command (@(
  "powershell", "-File", $repairPath,
  "-Profile", $Profile,
  "-Region", $Region,
  "-Channel", $Channel,
  "-Action", "inspect-fargate-tasks",
  "-StaleTaskAgeHours", "$StaleTaskAgeHours"
) + $identityArgs)

Write-Host ""
Write-Host "Operational health check complete."
