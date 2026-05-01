param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$UserId,
  [long]$TelegramId,
  [long]$ChatId,
  [ValidateSet("telegram", "web")]
  [string]$Channel = "telegram",
  [ValidateSet("inspect", "inspect-pending-messages", "clear-active-tool-affinity", "clear-task-state", "clear-runtime-state", "clear-pending-messages")]
  [string]$Action = "inspect",
  [ValidateSet("PaymentFollowUp", "PaymentCoverageFollowUp", "TravelPaymentFollowUp", "TravelPaymentThenChatHandoff")]
  [string]$SmokeScenario = "TravelPaymentThenChatHandoff",
  [int]$SmokePauseSeconds = 10,
  [switch]$RunSmokeAfterRepair,
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

function Read-PendingMessages {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][string]$SelectedUserId,
    [int]$SelectedLimit = 25
  )

  $pendingValuesPath = New-TempJsonFile -Json "{`":pk`":{`"S`":`"USER#$SelectedUserId`"}}"

  try {
    $pending = Invoke-AwsJson `
      -Arguments @(
        "dynamodb", "query",
        "--table-name", "serverless-openclaw-PendingMessages",
        "--key-condition-expression", "PK = :pk",
        "--expression-attribute-values", "file://$pendingValuesPath",
        "--scan-index-forward", "false",
        "--limit", "$SelectedLimit",
        "--output", "json",
        "--profile", $SelectedProfile,
        "--region", $SelectedRegion
      ) `
      -AllowFailure

    if (-not $pending) {
      return @()
    }

    $items = Get-OptionalProperty -Object $pending -Name "Items"
    if (-not $items) {
      return @()
    }

    return @($items | ForEach-Object { ConvertFrom-DynamoItem -Item $_ })
  } finally {
    if (Test-Path -LiteralPath $pendingValuesPath) {
      Remove-Item -LiteralPath $pendingValuesPath -Force
    }
  }
}

function Show-PendingMessages {
  param($Messages)

  $visibleMessages = @($Messages | Where-Object { $null -ne $_ })

  if ($visibleMessages.Count -eq 0) {
    Write-Host "Pending messages: none"
    return
  }

  Write-Host "Pending messages:"
  foreach ($message in $visibleMessages) {
    $sk = Get-OptionalProperty -Object $message -Name "SK"
    $ttl = Get-OptionalProperty -Object $message -Name "ttl"
    $createdAt = Get-OptionalProperty -Object $message -Name "createdAt"
    $traceId = Get-OptionalProperty -Object $message -Name "traceId"
    $text = Get-OptionalProperty -Object $message -Name "message"
    if (-not $text) {
      $text = Get-OptionalProperty -Object $message -Name "text"
    }

    if ($text -and $text.Length -gt 80) {
      $text = "$($text.Substring(0, 80))..."
    }

    Write-Host "  - SK       : $(if ($sk) { $sk } else { 'unknown' })"
    Write-Host "    ttl      : $(if ($ttl) { $ttl } else { 'unknown' })"
    Write-Host "    createdAt: $(if ($createdAt) { $createdAt } else { 'unknown' })"
    Write-Host "    traceId  : $(if ($traceId) { $traceId } else { 'unknown' })"
    Write-Host "    message  : $(if ($text) { $text } else { 'unavailable' })"
  }
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

function Remove-PendingMessages {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProfile,
    [Parameter(Mandatory = $true)][string]$SelectedRegion,
    [Parameter(Mandatory = $true)][string]$SelectedUserId
  )

  $messages = Read-PendingMessages `
    -SelectedProfile $SelectedProfile `
    -SelectedRegion $SelectedRegion `
    -SelectedUserId $SelectedUserId `
    -SelectedLimit 100

  foreach ($message in $messages) {
    $sk = Get-OptionalProperty -Object $message -Name "SK"
    if (-not $sk) {
      continue
    }

    $keyPath = New-TempJsonFile -Json "{`"PK`":{`"S`":`"USER#$SelectedUserId`"},`"SK`":{`"S`":`"$sk`"}}"
    try {
      Invoke-AwsNoJson `
        -Arguments @(
          "dynamodb", "delete-item",
          "--table-name", "serverless-openclaw-PendingMessages",
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

  return $messages.Count
}

function Invoke-PostRepairSmoke {
  param(
    [Parameter(Mandatory = $true)][long]$SelectedChatId,
    [Parameter(Mandatory = $true)][long]$SelectedTelegramId,
    [Parameter(Mandatory = $true)][string]$SelectedScenario,
    [Parameter(Mandatory = $true)][int]$SelectedPauseSeconds
  )

  $scriptRoot = Split-Path -Parent $MyInvocation.ScriptName
  $smokePath = Join-Path $scriptRoot "synthetic-telegram-smoke.ps1"
  if (-not (Test-Path -LiteralPath $smokePath)) {
    throw "Synthetic smoke script not found: $smokePath"
  }

  & powershell -File $smokePath `
    -ChatId $SelectedChatId `
    -TelegramId $SelectedTelegramId `
    -Scenario $SelectedScenario `
    -PauseSeconds $SelectedPauseSeconds

  if ($LASTEXITCODE -ne 0) {
    throw "Post-repair synthetic smoke failed."
  }
}

if ($TelegramId -and -not $UserId) {
  $UserId = Resolve-LinkedTelegramUserId `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -SelectedTelegramId $TelegramId
}

if ($TelegramId -and -not $ChatId) {
  $ChatId = $TelegramId
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
Write-Host "  Smoke   : $(if ($RunSmokeAfterRepair) { $SmokeScenario } else { 'disabled' })"
Write-Host ""

$beforeState = Read-RuntimeState `
  -SelectedProfile $Profile `
  -SelectedRegion $Region `
  -SelectedUserId $UserId `
  -SelectedChannel $Channel

Write-Host "Before:"
Show-RuntimeState -State $beforeState
Write-Host ""

if ($Action -eq "inspect" -or $Action -eq "inspect-pending-messages") {
  if ($Action -eq "inspect-pending-messages") {
    $pendingMessages = Read-PendingMessages `
      -SelectedProfile $Profile `
      -SelectedRegion $Region `
      -SelectedUserId $UserId `
      -SelectedLimit 25
    Show-PendingMessages -Messages $pendingMessages
  }

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
  if ($Action -eq "clear-pending-messages") {
    $pendingMessages = Read-PendingMessages `
      -SelectedProfile $Profile `
      -SelectedRegion $Region `
      -SelectedUserId $UserId `
      -SelectedLimit 25
    Write-Host "  - Delete PendingMessages items for USER#$UserId"
    Show-PendingMessages -Messages $pendingMessages
  }
  if ($RunSmokeAfterRepair) {
    Write-Host "  - Run synthetic Telegram smoke after repair: $SmokeScenario"
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

if ($Action -eq "clear-pending-messages") {
  $deletedCount = Remove-PendingMessages `
    -SelectedProfile $Profile `
    -SelectedRegion $Region `
    -SelectedUserId $UserId
  Write-Host "Deleted pending messages: $deletedCount"
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

if ($RunSmokeAfterRepair) {
  if (-not $TelegramId -or -not $ChatId) {
    throw "Post-repair smoke requires -TelegramId and -ChatId."
  }

  Write-Host ""
  Write-Host "Running post-repair synthetic smoke..."
  Invoke-PostRepairSmoke `
    -SelectedChatId $ChatId `
    -SelectedTelegramId $TelegramId `
    -SelectedScenario $SmokeScenario `
    -SelectedPauseSeconds $SmokePauseSeconds
}
