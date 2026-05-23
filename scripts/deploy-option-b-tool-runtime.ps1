param(
  [string]$Profile = $(if ($env:AWS_PROFILE) { $env:AWS_PROFILE } else { "default" }),
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$AiProvider = $(if ($env:AI_PROVIDER) { $env:AI_PROVIDER } else { "bedrock" }),
  [ValidateSet("fargate", "agentcore")]
  [string]$ToolRuntimeProvider = $(if ($env:TOOL_RUNTIME_PROVIDER) { $env:TOOL_RUNTIME_PROVIDER } else { "agentcore" }),
  [ValidateSet("lambda", "agentcore")]
  [string]$AssistantRuntimeProvider = $(if ($env:ASSISTANT_RUNTIME_PROVIDER) { $env:ASSISTANT_RUNTIME_PROVIDER } else { "agentcore" }),
  [ValidateSet("fargate")]
  [string]$AgentCoreFallbackProvider = $(if ($env:AGENTCORE_FALLBACK_PROVIDER) { $env:AGENTCORE_FALLBACK_PROVIDER } else { "fargate" }),
  [string]$AgentCoreInvokeDeadlineMs = $(if ($env:AGENTCORE_INVOKE_DEADLINE_MS) { $env:AGENTCORE_INVOKE_DEADLINE_MS } else { "12000" }),
  [ValidateSet("ddb", "dynamodb", "memory")]
  [string]$ToolContextStore = $(if ($env:TOOL_CONTEXT_STORE) { $env:TOOL_CONTEXT_STORE } else { "ddb" }),
  [string]$AgentCoreRuntimeArn = $(if ($env:AGENTCORE_RUNTIME_ARN) { $env:AGENTCORE_RUNTIME_ARN } else { "" }),
  [string]$AgentCoreRuntimeName = $(if ($env:AGENTCORE_RUNTIME_NAME) { $env:AGENTCORE_RUNTIME_NAME } else { "ServerlessOpenClawToolRuntime" }),
  [string]$AgentCoreRuntimeQualifier = $(if ($env:AGENTCORE_RUNTIME_QUALIFIER) { $env:AGENTCORE_RUNTIME_QUALIFIER } else { "" }),
  [string]$AgentCoreSessionNamespace = $(if ($env:AGENTCORE_SESSION_NAMESPACE) { $env:AGENTCORE_SESSION_NAMESPACE } else { "" }),
  [string]$LambdaAgentImageTag = $(if ($env:LAMBDA_AGENT_IMAGE_TAG) { $env:LAMBDA_AGENT_IMAGE_TAG } else { "" }),
  [string]$LambdaAgentRepositoryName = $(if ($env:LAMBDA_AGENT_ECR_REPOSITORY) { $env:LAMBDA_AGENT_ECR_REPOSITORY } else { "serverless-openclaw-lambda-agent" }),
  [string]$LambdaAgentFunctionName = $(if ($env:LAMBDA_AGENT_FUNCTION_NAME) { $env:LAMBDA_AGENT_FUNCTION_NAME } else { "serverless-openclaw-agent" }),
  [switch]$PushLambdaAgentImage,
  [switch]$UpdateLambdaAgentCode,
  [switch]$ApiOnly,
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

function Resolve-AgentCoreRuntimeArn {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeName,
    [Parameter(Mandatory = $true)][string]$AwsRegion,
    [Parameter(Mandatory = $true)][string]$AwsProfile
  )

  if ([string]::IsNullOrWhiteSpace($RuntimeName)) {
    return ""
  }

  Write-Host "Resolving AgentCore runtime ARN by name: $RuntimeName"
  $args = @(
    "bedrock-agentcore-control",
    "list-agent-runtimes",
    "--region",
    $AwsRegion,
    "--output",
    "json"
  )
  if (-not [string]::IsNullOrWhiteSpace($AwsProfile)) {
    $args += @("--profile", $AwsProfile)
  }

  $raw = aws @args
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to list AgentCore runtimes while resolving $RuntimeName."
  }

  $runtimeList = $raw | ConvertFrom-Json
  $runtime = $runtimeList.agentRuntimes |
    Where-Object { $_.agentRuntimeName -eq $RuntimeName } |
    Select-Object -First 1

  if (-not $runtime) {
    return ""
  }

  return [string]$runtime.agentRuntimeArn
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $Command $($Arguments -join ' ')"
  }
}

function Resolve-GitShortSha {
  param([Parameter(Mandatory = $true)][string]$WorkingDirectory)

  Push-Location $WorkingDirectory
  try {
    $sha = git rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($sha)) {
      return $sha.Trim()
    }
  } finally {
    Pop-Location
  }

  return (Get-Date -Format "yyyyMMddHHmmss")
}

function Resolve-AwsAccountId {
  param(
    [Parameter(Mandatory = $true)][string]$AwsRegion,
    [Parameter(Mandatory = $true)][string]$AwsProfile
  )

  $args = @(
    "sts",
    "get-caller-identity",
    "--query",
    "Account",
    "--output",
    "text",
    "--region",
    $AwsRegion
  )
  if (-not [string]::IsNullOrWhiteSpace($AwsProfile)) {
    $args += @("--profile", $AwsProfile)
  }

  $accountId = aws @args
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($accountId)) {
    throw "Failed to resolve AWS account id for Lambda Agent image deployment."
  }

  return $accountId.Trim()
}

function Push-LambdaAgentImage {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryUri,
    [Parameter(Mandatory = $true)][string]$ImageTag,
    [Parameter(Mandatory = $true)][string]$AwsRegion,
    [Parameter(Mandatory = $true)][string]$AwsProfile,
    [Parameter(Mandatory = $true)][string]$RootDirectory
  )

  Write-Host "Building and pushing Lambda Agent image"
  Write-Host "  Repository: $RepositoryUri"
  Write-Host "  Tag       : $ImageTag"

  $registry = $RepositoryUri.Split("/")[0]
  $passwordArgs = @("ecr", "get-login-password", "--region", $AwsRegion)
  if (-not [string]::IsNullOrWhiteSpace($AwsProfile)) {
    $passwordArgs += @("--profile", $AwsProfile)
  }
  $password = aws @passwordArgs
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($password)) {
    throw "Failed to get ECR login password."
  }

  # On Windows PowerShell, --password-stdin can intermittently fail against ECR.
  # Passing the short-lived ECR token as an argument is acceptable for this local
  # deployment helper and avoids a false-negative deploy.
  Invoke-Checked -Command "docker" -Arguments @(
    "login",
    "--username",
    "AWS",
    "--password",
    $password.Trim(),
    $registry
  )

  Push-Location $RootDirectory
  try {
    Invoke-Checked -Command "docker" -Arguments @(
      "buildx",
      "build",
      "--platform",
      "linux/arm64",
      "--provenance=false",
      "--sbom=false",
      "-f",
      "packages/lambda-agent/Dockerfile",
      "-t",
      "${RepositoryUri}:latest",
      "-t",
      "${RepositoryUri}:${ImageTag}",
      "--push",
      "."
    )
  } finally {
    Pop-Location
  }
}

function Update-LambdaAgentFunctionCode {
  param(
    [Parameter(Mandatory = $true)][string]$FunctionName,
    [Parameter(Mandatory = $true)][string]$ImageUri,
    [Parameter(Mandatory = $true)][string]$AwsRegion,
    [Parameter(Mandatory = $true)][string]$AwsProfile
  )

  Write-Host "Updating Lambda Agent function code"
  Write-Host "  Function: $FunctionName"
  Write-Host "  Image   : $ImageUri"

  $updateArgs = @(
    "lambda",
    "update-function-code",
    "--function-name",
    $FunctionName,
    "--region",
    $AwsRegion,
    "--image-uri",
    $ImageUri,
    "--output",
    "json"
  )
  if (-not [string]::IsNullOrWhiteSpace($AwsProfile)) {
    $updateArgs += @("--profile", $AwsProfile)
  }
  Invoke-Checked -Command "aws" -Arguments $updateArgs

  $waitArgs = @(
    "lambda",
    "wait",
    "function-updated",
    "--function-name",
    $FunctionName,
    "--region",
    $AwsRegion
  )
  if (-not [string]::IsNullOrWhiteSpace($AwsProfile)) {
    $waitArgs += @("--profile", $AwsProfile)
  }
  Invoke-Checked -Command "aws" -Arguments $waitArgs

  $checkArgs = @(
    "lambda",
    "get-function-configuration",
    "--function-name",
    $FunctionName,
    "--region",
    $AwsRegion,
    "--query",
    "{LastUpdateStatus:LastUpdateStatus,CodeSha256:CodeSha256,AI_PROVIDER:Environment.Variables.AI_PROVIDER}",
    "--output",
    "json"
  )
  if (-not [string]::IsNullOrWhiteSpace($AwsProfile)) {
    $checkArgs += @("--profile", $AwsProfile)
  }
  Invoke-Checked -Command "aws" -Arguments $checkArgs
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
if ([string]::IsNullOrWhiteSpace($LambdaAgentImageTag) -and $env:LAMBDA_AGENT_IMAGE_TAG) {
  $LambdaAgentImageTag = $env:LAMBDA_AGENT_IMAGE_TAG
}
if (($PushLambdaAgentImage -or $UpdateLambdaAgentCode) -and [string]::IsNullOrWhiteSpace($LambdaAgentImageTag)) {
  $LambdaAgentImageTag = "lambda-$(Resolve-GitShortSha -WorkingDirectory $repoRoot)"
}

if (
  $ToolRuntimeProvider -eq "agentcore" -and
  [string]::IsNullOrWhiteSpace($AgentCoreRuntimeArn)
) {
  $AgentCoreRuntimeArn = Resolve-AgentCoreRuntimeArn `
    -RuntimeName $AgentCoreRuntimeName `
    -AwsRegion $Region `
    -AwsProfile $Profile
}

$env:AWS_PROFILE = $Profile
$env:AWS_REGION = $Region
$env:AI_PROVIDER = $AiProvider
$env:AGENT_RUNTIME = "both"
$env:TOOL_RUNTIME_PROVIDER = $ToolRuntimeProvider
$env:ASSISTANT_RUNTIME_PROVIDER = $AssistantRuntimeProvider
$env:TOOL_CONTEXT_STORE = $ToolContextStore
$env:AGENTCORE_FALLBACK_PROVIDER = $AgentCoreFallbackProvider
$env:AGENTCORE_INVOKE_DEADLINE_MS = $AgentCoreInvokeDeadlineMs
if (-not [string]::IsNullOrWhiteSpace($LambdaAgentImageTag)) {
  $env:LAMBDA_AGENT_IMAGE_TAG = $LambdaAgentImageTag.Trim()
} else {
  Remove-Item Env:LAMBDA_AGENT_IMAGE_TAG -ErrorAction SilentlyContinue
}

if ($ToolRuntimeProvider -eq "agentcore") {
  if ([string]::IsNullOrWhiteSpace($AgentCoreRuntimeArn)) {
    throw "AGENTCORE_RUNTIME_ARN is required when TOOL_RUNTIME_PROVIDER=agentcore. Run scripts/deploy-agentcore-runtime.ps1 first, then pass -AgentCoreRuntimeArn."
  }
  if ([string]::IsNullOrWhiteSpace($AgentCoreSessionNamespace)) {
    Write-Warning "AGENTCORE_SESSION_NAMESPACE is empty. Existing AgentCore runtime sessions may continue to serve an older container image. Pass -AgentCoreSessionNamespace with the deployed image tag for production cutovers."
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
Write-Host "  ASSISTANT_RUNTIME     : $env:ASSISTANT_RUNTIME_PROVIDER"
Write-Host "  TOOL_CONTEXT_STORE    : $env:TOOL_CONTEXT_STORE"
Write-Host "  AGENTCORE_FALLBACK    : $env:AGENTCORE_FALLBACK_PROVIDER"
Write-Host "  AGENTCORE_DEADLINE_MS : $env:AGENTCORE_INVOKE_DEADLINE_MS"
if ($env:LAMBDA_AGENT_IMAGE_TAG) {
  Write-Host "  LAMBDA_AGENT_IMAGE_TAG: $env:LAMBDA_AGENT_IMAGE_TAG"
}
if ($PushLambdaAgentImage -or $UpdateLambdaAgentCode) {
  Write-Host "  LAMBDA_AGENT_REPO     : $LambdaAgentRepositoryName"
  Write-Host "  LAMBDA_AGENT_FUNCTION : $LambdaAgentFunctionName"
  Write-Host "  LAMBDA_IMAGE_PUSH     : $PushLambdaAgentImage"
  Write-Host "  LAMBDA_CODE_UPDATE    : $UpdateLambdaAgentCode"
}
if ($ToolRuntimeProvider -eq "agentcore") {
  Write-Host "  AGENTCORE_RUNTIME_ARN : $env:AGENTCORE_RUNTIME_ARN"
  Write-Host "  AGENTCORE_RUNTIME_NAME: $AgentCoreRuntimeName"
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
if ($ApiOnly) {
  Write-Host "  - ApiOnly mode updates Gateway wiring only; ComputeStack and LambdaAgentStack are left untouched."
}
if ($PushLambdaAgentImage -or $UpdateLambdaAgentCode) {
  Write-Host "  - Lambda Agent image deploy uses docker buildx with --provenance=false and --sbom=false so AWS Lambda accepts the image manifest."
  Write-Host "  - UpdateLambdaAgentCode updates the live function image directly after ECR push."
}
Write-Host ""

$lambdaAgentRepositoryUri = ""
if ($PushLambdaAgentImage -or $UpdateLambdaAgentCode) {
  if ([string]::IsNullOrWhiteSpace($LambdaAgentImageTag)) {
    throw "LambdaAgentImageTag is required when PushLambdaAgentImage or UpdateLambdaAgentCode is enabled."
  }
  $accountId = Resolve-AwsAccountId -AwsRegion $Region -AwsProfile $Profile
  $lambdaAgentRepositoryUri = "$accountId.dkr.ecr.$Region.amazonaws.com/$LambdaAgentRepositoryName"
}

if ($PushLambdaAgentImage) {
  Push-LambdaAgentImage `
    -RepositoryUri $lambdaAgentRepositoryUri `
    -ImageTag $LambdaAgentImageTag `
    -AwsRegion $Region `
    -AwsProfile $Profile `
    -RootDirectory $repoRoot
}

if ($UpdateLambdaAgentCode) {
  Update-LambdaAgentFunctionCode `
    -FunctionName $LambdaAgentFunctionName `
    -ImageUri "${lambdaAgentRepositoryUri}:${LambdaAgentImageTag}" `
    -AwsRegion $Region `
    -AwsProfile $Profile
}

Push-Location $cdkDir
try {
  if (-not $ApiOnly) {
    npx cdk deploy ComputeStack --exclusively --require-approval never
    npx cdk deploy LambdaAgentStack --exclusively --require-approval never
  }
  npx cdk deploy ApiStack --exclusively --require-approval never
} finally {
  Pop-Location
}
