param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$AiProvider = $(if ($env:AI_PROVIDER) { $env:AI_PROVIDER } else { "bedrock" }),
  [ValidateSet("fargate", "agentcore")]
  [string]$ToolRuntimeProvider = $(if ($env:TOOL_RUNTIME_PROVIDER) { $env:TOOL_RUNTIME_PROVIDER } else { "fargate" }),
  [ValidateSet("ddb", "dynamodb", "memory")]
  [string]$ToolContextStore = $(if ($env:TOOL_CONTEXT_STORE) { $env:TOOL_CONTEXT_STORE } else { "ddb" }),
  [switch]$SkipEnvFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Import-DotEnv {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }

    $separator = $line.IndexOf("=")
    if ($separator -le 0) {
      return
    }

    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim().Trim('"')
    if ($name) {
      Set-Item -Path "Env:$name" -Value $value
    }
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$cdkDir = Join-Path $repoRoot "packages/cdk"

if (-not $SkipEnvFile) {
  Import-DotEnv -Path (Join-Path $repoRoot ".env")
}

$env:AWS_PROFILE = $Profile
$env:AWS_REGION = $Region
$env:AI_PROVIDER = $AiProvider
$env:AGENT_RUNTIME = "both"
$env:TOOL_RUNTIME_PROVIDER = $ToolRuntimeProvider
$env:TOOL_CONTEXT_STORE = $ToolContextStore

Write-Host "Deploying Option B tool runtime stacks"
Write-Host "  AWS_PROFILE           : $env:AWS_PROFILE"
Write-Host "  AWS_REGION            : $env:AWS_REGION"
Write-Host "  AI_PROVIDER           : $env:AI_PROVIDER"
Write-Host "  AGENT_RUNTIME         : $env:AGENT_RUNTIME"
Write-Host "  TOOL_RUNTIME_PROVIDER : $env:TOOL_RUNTIME_PROVIDER"
Write-Host "  TOOL_CONTEXT_STORE    : $env:TOOL_CONTEXT_STORE"
Write-Host ""

Push-Location $cdkDir
try {
  npx cdk deploy ComputeStack --exclusively --require-approval never
  npx cdk deploy ApiStack --exclusively --require-approval never
} finally {
  Pop-Location
}
