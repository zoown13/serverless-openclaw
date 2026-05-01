param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$UserId,
  [long]$TelegramId,
  [ValidateSet("telegram", "web")]
  [string]$Channel = "telegram",
  [ValidateSet("inspect", "clear-active-tool-affinity", "clear-task-state", "clear-runtime-state")]
  [string]$Action = "inspect",
  [switch]$Apply
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

function Invoke-AwsNoJson {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  & aws @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "AWS CLI command failed: aws $($Arguments -join ' ')"
  }
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

function New-TempJsonFile {
  param([Parameter(Mandatory = $true)][string]$Json)

  $path = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    ("openclaw-repair-{0}.json" -f [Guid]::NewGuid().ToString("N"))
  Write-Utf8NoBomJson -Path $path -Json $Json
  return $path
}

function Read-RuntimeState {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][string]$SelectedUserId,
    [Parameter(Mandatory = $true)][string]$SelectedChannel
  )

  $taskKeyPath = New-TempJsonFile -Json "{`"PK`":{`"S`":`"USER#$SelectedUserId`"}}"
  $affinityKeyPath = New-TempJsonFile -Json "{`"PK`":{`"S`":`"USER#$SelectedUserId`"},`"SK`":{`"S`":`"SETTING#active-tool:$SelectedChannel`"}}"
  $pendingValuesPath = New-TempJsonFile -Json "{`":pk`":{`"S`":`"USER#$SelectedUserId`"}}"

  try {
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
        "--select", "COUNT",
        "--output", "json",
        "--profile", $SelectedProfile,
        "--region", $SelectedRegion
      ) `
      -AllowFailure

    return [pscustomobject]@{
      TaskState = if ($taskState) { ConvertFrom-DynamoItem -Item (Get-OptionalProperty -Object $taskState -Name "Item") } else { $null }
      ActiveToolAffinity = if ($affinity) { ConvertFrom-DynamoItem -Item (Get-OptionalProperty -Object $affinity -Name "Item") } else { $null }
      PendingCount = if ($pending) { Get-OptionalProperty -Object $pending -Name "Count" } else { $null }
    }
  } finally {
    foreach ($path in @($taskKeyPath, $affinityKeyPath, $pendingValuesPath)) {
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
      }
    }
  }
}

function Show-RuntimeState {
  param($State)

  $taskStatus = Get-OptionalProperty -Object $State.TaskState -Name "status"
  $taskTtl = Get-OptionalProperty -Object $State.TaskState -Name "ttl"
  $affinityValue = Get-OptionalProperty -Object $State.ActiveToolAffinity -Name "value"
  $affinityProvider = Get-OptionalProperty -Object $affinityValue -Name "provider"
  $affinityRuntimeClass = Get-OptionalProperty -Object $affinityValue -Name "runtimeClass"
  $affinityExpiresAt = Get-OptionalProperty -Object $affinityValue -Name "expiresAt"

  Write-Host "Runtime state:"
  Write-Host "  TaskState.status       : $(if ($taskStatus) { $taskStatus } else { 'none' })"
  Write-Host "  TaskState.ttl          : $(if ($taskTtl) { $taskTtl } else { 'none' })"
  Write-Host "  ActiveTool.provider    : $(if ($affinityProvider) { $affinityProvider } else { 'none' })"
  Write-Host "  ActiveTool.runtime     : $(if ($affinityRuntimeClass) { $affinityRuntimeClass } else { 'none' })"
  Write-Host "  ActiveTool.expiresAt   : $(if ($affinityExpiresAt) { $affinityExpiresAt } else { 'none' })"
  Write-Host "  PendingMessages.count  : $(if ($null -ne $State.PendingCount) { $State.PendingCount } else { 'unknown' })"
}

function Remove-ActiveToolAffinity {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][string]$SelectedUserId,
    [Parameter(Mandatory = $true)][string]$SelectedChannel
  )

  $keyPath = New-TempJsonFile -Json "{`"PK`":{`"S`":`"USER#$SelectedUserId`"},`"SK`":{`"S`":`"SETTING#active-tool:$SelectedChannel`"}}"
  try {
    Invoke-AwsNoJson `
      -Arguments @(
        "dynamodb", "delete-item",
        "--table-name", "serverless-openclaw-Settings",
        "--key", "file://$keyPath",
        "--profile", $SelectedProfile,
        "--region", $SelectedRegion
      )
  } finally {
    if (Test-Path -LiteralPath $keyPath) {
      Remove-Item -LiteralPath $keyPath -Force
    }
  }
}

function Remove-TaskState {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][string]$SelectedUserId
  )

  $keyPath = New-TempJsonFile -Json "{`"PK`":{`"S`":`"USER#$SelectedUserId`"}}"
  try {
    Invoke-AwsNoJson `
      -Arguments @(
        "dynamodb", "delete-item",
        "--table-name", "serverless-openclaw-TaskState",
        "--key", "file://$keyPath",
        "--profile", $SelectedProfile,
        "--region", $SelectedRegion
      )
  } finally {
    if (Test-Path -LiteralPath $keyPath) {
      Remove-Item -LiteralPath $keyPath -Force
    }
  }
}

if ($TelegramId -and -not $UserId) {
  $UserId = Resolve-LinkedTelegramUserId `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -SelectedTelegramId $TelegramId
}

if (-not $UserId) {
  throw "Provide either -UserId or -TelegramId."
}

Write-Host "Operational Copilot repair runbook"
Write-Host "  Region  : $Region"
Write-Host "  UserId  : $UserId"
Write-Host "  Channel : $Channel"
Write-Host "  Action  : $Action"
Write-Host "  Apply   : $Apply"
Write-Host ""

$beforeState = Read-RuntimeState `
  -SelectedProfile $Profile `
  -SelectedRegion $Region `
  -SelectedUserId $UserId `
  -SelectedChannel $Channel

Write-Host "Before:"
Show-RuntimeState -State $beforeState
Write-Host ""

if ($Action -eq "inspect") {
  Write-Host "No repair action selected. This was a read-only inspection."
  exit 0
}

if (-not $Apply) {
  Write-Host "Dry run only. Re-run with -Apply to execute this guarded repair action."
  Write-Host ""
  Write-Host "Planned repair:"
  if ($Action -in @("clear-active-tool-affinity", "clear-runtime-state")) {
    Write-Host "  - Delete Settings item: USER#$UserId / SETTING#active-tool:$Channel"
  }
  if ($Action -in @("clear-task-state", "clear-runtime-state")) {
    Write-Host "  - Delete TaskState item: USER#$UserId"
  }
  exit 0
}

if ($Action -in @("clear-active-tool-affinity", "clear-runtime-state")) {
  Remove-ActiveToolAffinity `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -SelectedUserId $UserId `
    -SelectedChannel $Channel
}

if ($Action -in @("clear-task-state", "clear-runtime-state")) {
  Remove-TaskState `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -SelectedUserId $UserId
}

$afterState = Read-RuntimeState `
  -SelectedProfile $Profile `
  -SelectedRegion $Region `
  -SelectedUserId $UserId `
  -SelectedChannel $Channel

Write-Host "After:"
Show-RuntimeState -State $afterState
Write-Host ""
Write-Host "Repair action completed."
