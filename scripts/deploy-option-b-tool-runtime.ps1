param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$AiProvider = $(if ($env:AI_PROVIDER) { $env:AI_PROVIDER } else { "bedrock" }),
  [ValidateSet("fargate", "agentcore")]
  [string]$ToolRuntimeProvider = $(if ($env:TOOL_RUNTIME_PROVIDER) { $env:TOOL_RUNTIME_PROVIDER } else { "agentcore" }),
  [ValidateSet("fargate")]
  [string]$AgentCoreFallbackProvider = $(if ($env:AGENTCORE_FALLBACK_PROVIDER) { $env:AGENTCORE_FALLBACK_PROVIDER } else { "fargate" }),
  [string]$AgentCoreInvokeDeadlineMs = $(if ($env:AGENTCORE_INVOKE_DEADLINE_MS) { $env:AGENTCORE_INVOKE_DEADLINE_MS } else { "12000" }),
  [ValidateSet("ddb", "dynamodb", "memory")]
  [string]$ToolContextStore = $(if ($env:TOOL_CONTEXT_STORE) { $env:TOOL_CONTEXT_STORE } else { "ddb" }),
  [string]$AgentCoreRuntimeArn = $(if ($env:AGENTCORE_RUNTIME_ARN) { $env:AGENTCORE_RUNTIME_ARN } else { "" }),
  [string]$AgentCoreRuntimeQualifier = $(if ($env:AGENTCORE_RUNTIME_QUALIFIER) { $env:AGENTCORE_RUNTIME_QUALIFIER } else { "" }),
  [string]$AgentCoreSessionNamespace = $(if ($env:AGENTCORE_SESSION_NAMESPACE) { $env:AGENTCORE_SESSION_NAMESPACE } else { "" }),
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

if ([string]::IsNullOrWhiteSpace($AgentCoreRuntimeArn) -and $env:AGENTCORE_RUNTIME_ARN) {
  $AgentCoreRuntimeArn = $env:AGENTCORE_RUNTIME_ARN
}
if ([string]::IsNullOrWhiteSpace($AgentCoreRuntimeQualifier) -and $env:AGENTCORE_RUNTIME_QUALIFIER) {
  $AgentCoreRuntimeQualifier = $env:AGENTCORE_RUNTIME_QUALIFIER
}
if ([string]::IsNullOrWhiteSpace($AgentCoreInvokeDeadlineMs) -and $env:AGENTCORE_INVOKE_DEADLINE_MS) {
  $AgentCoreInvokeDeadlineMs = $env:AGENTCORE_INVOKE_DEADLINE_MS
}
if ([string]::IsNullOrWhiteSpace($AgentCoreSessionNamespace) -and $env:AGENTCORE_SESSION_NAMESPACE) {
  $AgentCoreSessionNamespace = $env:AGENTCORE_SESSION_NAMESPACE
}

$env:AWS_PROFILE = $Profile
$env:AWS_REGION = $Region
$env:AI_PROVIDER = $AiProvider
$env:AGENT_RUNTIME = "both"
$env:TOOL_RUNTIME_PROVIDER = $ToolRuntimeProvider
$env:TOOL_CONTEXT_STORE = $ToolContextStore
$env:AGENTCORE_FALLBACK_PROVIDER = $AgentCoreFallbackProvider
$env:AGENTCORE_INVOKE_DEADLINE_MS = $AgentCoreInvokeDeadlineMs

if ($ToolRuntimeProvider -eq "agentcore") {
  if ([string]::IsNullOrWhiteSpace($AgentCoreRuntimeArn)) {
    throw "AGENTCORE_RUNTIME_ARN is required when TOOL_RUNTIME_PROVIDER=agentcore. Run scripts/deploy-agentcore-runtime.ps1 first, then pass -AgentCoreRuntimeArn."
  }

  $env:AGENTCORE_RUNTIME_ARN = $AgentCoreRuntimeArn.Trim()
  if (-not [string]::IsNullOrWhiteSpace($AgentCoreRuntimeQualifier)) {
    $env:AGENTCORE_RUNTIME_QUALIFIER = $AgentCoreRuntimeQualifier.Trim()
  } else {
    Remove-Item Env:AGENTCORE_RUNTIME_QUALIFIER -ErrorAction SilentlyContinue
  }
  if (-not [string]::IsNullOrWhiteSpace($AgentCoreSessionNamespace)) {
    $env:AGENTCORE_SESSION_NAMESPACE = $AgentCoreSessionNamespace.Trim()
  } else {
    Remove-Item Env:AGENTCORE_SESSION_NAMESPACE -ErrorAction SilentlyContinue
  }
} else {
  Remove-Item Env:AGENTCORE_RUNTIME_ARN -ErrorAction SilentlyContinue
  Remove-Item Env:AGENTCORE_RUNTIME_QUALIFIER -ErrorAction SilentlyContinue
  Remove-Item Env:AGENTCORE_SESSION_NAMESPACE -ErrorAction SilentlyContinue
}

Write-Host "Deploying Option B tool runtime stacks"
Write-Host "  AWS_PROFILE           : $env:AWS_PROFILE"
Write-Host "  AWS_REGION            : $env:AWS_REGION"
Write-Host "  AI_PROVIDER           : $env:AI_PROVIDER"
Write-Host "  AGENT_RUNTIME         : $env:AGENT_RUNTIME"
Write-Host "  TOOL_RUNTIME_PROVIDER : $env:TOOL_RUNTIME_PROVIDER"
Write-Host "  TOOL_CONTEXT_STORE    : $env:TOOL_CONTEXT_STORE"
Write-Host "  AGENTCORE_FALLBACK    : $env:AGENTCORE_FALLBACK_PROVIDER"
Write-Host "  AGENTCORE_DEADLINE_MS : $env:AGENTCORE_INVOKE_DEADLINE_MS"
if ($ToolRuntimeProvider -eq "agentcore") {
  Write-Host "  AGENTCORE_RUNTIME_ARN : $env:AGENTCORE_RUNTIME_ARN"
  if ($env:AGENTCORE_RUNTIME_QUALIFIER) {
    Write-Host "  AGENTCORE_QUALIFIER   : $env:AGENTCORE_RUNTIME_QUALIFIER"
  }
  if ($env:AGENTCORE_SESSION_NAMESPACE) {
    Write-Host "  AGENTCORE_SESSION_NS  : $env:AGENTCORE_SESSION_NAMESPACE"
  }
}
Write-Host ""
Write-Host "Safety checks"
Write-Host "  - Gateway remains coarse-only; semantic routing stays inside the tool runtime."
Write-Host "  - Lambda remains the default chat path through AGENT_RUNTIME=both."
Write-Host "  - DynamoDB-backed tool context remains enabled unless explicitly overridden."
Write-Host ""

Push-Location $cdkDir
try {
  npx cdk deploy ComputeStack --exclusively --require-approval never
  npx cdk deploy ApiStack --exclusively --require-approval never
} finally {
  Pop-Location
}
