param(
  [string]$Region = "ap-northeast-2",
  [string]$RuntimeName = "ServerlessOpenClawToolRuntime",
  [string]$RuntimeRoleName = "serverless-openclaw-agentcore-runtime-role",
  [string]$ImageTag = "latest",
  [string]$UserId = "system:agentcore",
  [string]$AiProvider = "bedrock",
  [string]$AiModel = "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  [string]$ToolSlmBackend = "mock-local"
)

$ErrorActionPreference = "Stop"

function Invoke-JsonCli {
  param([Parameter(Mandatory = $true)] [scriptblock]$Command)

  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativePreference = $null
  if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $previousNativePreference = $Global:PSNativeCommandUseErrorActionPreference
  }
  try {
    $ErrorActionPreference = "Continue"
    if ($null -ne $previousNativePreference) {
      $Global:PSNativeCommandUseErrorActionPreference = $false
    }
    $output = & $Command 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw ($output | Out-String)
    }
    return $output | ConvertFrom-Json
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($null -ne $previousNativePreference) {
      $Global:PSNativeCommandUseErrorActionPreference = $previousNativePreference
    }
  }
}

function Invoke-TextCli {
  param([Parameter(Mandatory = $true)] [scriptblock]$Command)

  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativePreference = $null
  if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $previousNativePreference = $Global:PSNativeCommandUseErrorActionPreference
  }
  try {
    $ErrorActionPreference = "Continue"
    if ($null -ne $previousNativePreference) {
      $Global:PSNativeCommandUseErrorActionPreference = $false
    }
    $output = & $Command 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw ($output | Out-String)
    }
    return ($output | Out-String).Trim()
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($null -ne $previousNativePreference) {
      $Global:PSNativeCommandUseErrorActionPreference = $previousNativePreference
    }
  }
}

function Invoke-UnitCli {
  param([Parameter(Mandatory = $true)] [scriptblock]$Command)

  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativePreference = $null
  if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $previousNativePreference = $Global:PSNativeCommandUseErrorActionPreference
  }
  try {
    $ErrorActionPreference = "Continue"
    if ($null -ne $previousNativePreference) {
      $Global:PSNativeCommandUseErrorActionPreference = $false
    }
    $output = & $Command 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw ($output | Out-String)
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($null -ne $previousNativePreference) {
      $Global:PSNativeCommandUseErrorActionPreference = $previousNativePreference
    }
  }
}

function ConvertTo-Utf8JsonFile {
  param(
    [Parameter(Mandatory = $true)] [object]$Value,
    [Parameter(Mandatory = $true)] [string]$Path
  )

  $json = $Value | ConvertTo-Json -Depth 20
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8)
}

function Get-StorageOutput {
  param([Parameter(Mandatory = $true)] [string]$Key)

  $stack = Invoke-JsonCli {
    aws cloudformation describe-stacks `
      --stack-name StorageStack `
      --region $Region `
      --output json
  }
  $output = $stack.Stacks[0].Outputs | Where-Object { $_.OutputKey -eq $Key } | Select-Object -First 1
  if (-not $output) {
    throw "StorageStack output not found: $Key"
  }
  return $output.OutputValue
}

function Ensure-AgentCoreRuntimeRole {
  param(
    [Parameter(Mandatory = $true)] [string]$AccountId,
    [Parameter(Mandatory = $true)] [string]$DataBucketName,
    [Parameter(Mandatory = $true)] [string]$EcrRepositoryArn
  )

  $trustFile = Join-Path $env:TEMP "serverless-openclaw-agentcore-trust.json"
  $policyFile = Join-Path $env:TEMP "serverless-openclaw-agentcore-policy.json"

  ConvertTo-Utf8JsonFile -Path $trustFile -Value @{
    Version = "2012-10-17"
    Statement = @(
      @{
        Effect = "Allow"
        Principal = @{ Service = "bedrock-agentcore.amazonaws.com" }
        Action = "sts:AssumeRole"
      }
    )
  }

  $roleExists = $true
  try {
    Invoke-UnitCli {
      aws iam get-role --role-name $RuntimeRoleName --output json
    }
  } catch {
    $roleExists = $false
  }

  if (-not $roleExists) {
    Invoke-UnitCli {
      aws iam create-role `
      --role-name $RuntimeRoleName `
      --assume-role-policy-document "file://$trustFile" `
      --description "Execution role for Serverless OpenClaw AgentCore tool runtime" `
      --output json
    }
  }

  ConvertTo-Utf8JsonFile -Path $policyFile -Value @{
    Version = "2012-10-17"
    Statement = @(
      @{
        Sid = "ReadRuntimeSecrets"
        Effect = "Allow"
        Action = @("ssm:GetParameter")
        Resource = @(
          "arn:aws:ssm:${Region}:${AccountId}:parameter/serverless-openclaw/secrets/*"
        )
      },
      @{
        Sid = "ReadWriteOpenClawData"
        Effect = "Allow"
        Action = @("s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket")
        Resource = @(
          "arn:aws:s3:::$DataBucketName",
          "arn:aws:s3:::$DataBucketName/*"
        )
      },
      @{
        Sid = "ReadWriteRuntimeTables"
        Effect = "Allow"
        Action = @(
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query"
        )
        Resource = @(
          "arn:aws:dynamodb:${Region}:${AccountId}:table/serverless-openclaw-Conversations",
          "arn:aws:dynamodb:${Region}:${AccountId}:table/serverless-openclaw-Settings",
          "arn:aws:dynamodb:${Region}:${AccountId}:table/serverless-openclaw-TaskState",
          "arn:aws:dynamodb:${Region}:${AccountId}:table/serverless-openclaw-Connections",
          "arn:aws:dynamodb:${Region}:${AccountId}:table/serverless-openclaw-PendingMessages"
        )
      },
      @{
        Sid = "InvokeBedrockModels"
        Effect = "Allow"
        Action = @(
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:ListFoundationModels"
        )
        Resource = "*"
      },
      @{
        Sid = "PullContainerImage"
        Effect = "Allow"
        Action = @(
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        )
        Resource = $EcrRepositoryArn
      },
      @{
        Sid = "GetEcrAuthToken"
        Effect = "Allow"
        Action = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      @{
        Sid = "PublishRuntimeMetrics"
        Effect = "Allow"
        Action = "cloudwatch:PutMetricData"
        Resource = "*"
      },
      @{
        Sid = "PublishRuntimeLogs"
        Effect = "Allow"
        Action = @(
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents"
        )
        Resource = @(
          "arn:aws:logs:${Region}:${AccountId}:log-group:/aws/bedrock-agentcore/runtimes/*",
          "arn:aws:logs:${Region}:${AccountId}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"
        )
      },
      @{
        Sid = "PublishRuntimeTraces"
        Effect = "Allow"
        Action = @(
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords"
        )
        Resource = "*"
      }
    )
  }

  Invoke-UnitCli {
    aws iam put-role-policy `
      --role-name $RuntimeRoleName `
      --policy-name "serverless-openclaw-agentcore-runtime-policy" `
      --policy-document "file://$policyFile"
  }

  $role = Invoke-JsonCli {
    aws iam get-role --role-name $RuntimeRoleName --output json
  }
  return $role.Role.Arn
}

$accountId = Invoke-TextCli {
  aws sts get-caller-identity --query Account --output text
}
$dataBucketName = Get-StorageOutput -Key "DataBucketName"
$ecrRepositoryUri = Get-StorageOutput -Key "EcrRepositoryUri"
$ecrRepository = Invoke-JsonCli {
  aws ecr describe-repositories `
    --repository-names serverless-openclaw `
    --region $Region `
    --output json
}
$ecrRepositoryArn = $ecrRepository.repositories[0].repositoryArn
$imageUri = "$ecrRepositoryUri`:$ImageTag"
$roleArn = Ensure-AgentCoreRuntimeRole `
  -AccountId $accountId `
  -DataBucketName $dataBucketName `
  -EcrRepositoryArn $ecrRepositoryArn

$environmentVariables = @{
  CONTAINER_RUNTIME_MODE = "agentcore"
  AGENTCORE_HTTP_ENABLED = "true"
  USER_ID = $UserId
  DATA_BUCKET = $dataBucketName
  BRIDGE_PORT = "8080"
  METRICS_ENABLED = "true"
  AI_PROVIDER = $AiProvider
  AI_MODEL = $AiModel
  TOOL_SLM_BACKEND = $ToolSlmBackend
  TOOL_CONTEXT_STORE = "ddb"
  AWS_REGION = $Region
  SSM_BRIDGE_AUTH_TOKEN = "/serverless-openclaw/secrets/bridge-auth-token"
  SSM_OPENCLAW_GATEWAY_TOKEN = "/serverless-openclaw/secrets/openclaw-gateway-token"
  SSM_ANTHROPIC_API_KEY = "/serverless-openclaw/secrets/anthropic-api-key"
  SSM_TELEGRAM_BOT_TOKEN = "/serverless-openclaw/secrets/telegram-bot-token"
  SSM_OPENCLAW_AUTH_PROFILES_JSON = "/serverless-openclaw/secrets/openclaw-auth-profiles-json"
  SSM_OPENCLAW_OAUTH_JSON = "/serverless-openclaw/secrets/openclaw-oauth-json"
  SSM_GOOGLE_OAUTH_CLIENT_JSON = "/serverless-openclaw/secrets/google-oauth-client-json"
}

$runtimeFile = Join-Path $env:TEMP "serverless-openclaw-agentcore-runtime.json"
$environmentVariablesFile = Join-Path $env:TEMP "serverless-openclaw-agentcore-env.json"
ConvertTo-Utf8JsonFile -Path $environmentVariablesFile -Value $environmentVariables
ConvertTo-Utf8JsonFile -Path $runtimeFile -Value @{
  agentRuntimeName = $RuntimeName
  description = "Serverless OpenClaw tool-capable runtime PoC"
  agentRuntimeArtifact = @{
    containerConfiguration = @{
      containerUri = $imageUri
    }
  }
  roleArn = $roleArn
  networkConfiguration = @{
    networkMode = "PUBLIC"
  }
  protocolConfiguration = @{
    serverProtocol = "HTTP"
  }
  environmentVariables = $environmentVariables
}

$runtimeList = Invoke-JsonCli {
  aws bedrock-agentcore-control list-agent-runtimes `
    --region $Region `
    --output json
}
$existingRuntime = $runtimeList |
  Select-Object -ExpandProperty agentRuntimes -ErrorAction SilentlyContinue |
  Where-Object { $_.agentRuntimeName -eq $RuntimeName } |
  Select-Object -First 1

if ($existingRuntime) {
  $update = Invoke-JsonCli {
    aws bedrock-agentcore-control update-agent-runtime `
      --region $Region `
      --agent-runtime-id $existingRuntime.agentRuntimeId `
      --agent-runtime-artifact "containerConfiguration={containerUri=$imageUri}" `
      --role-arn $roleArn `
      --network-configuration "networkMode=PUBLIC" `
      --protocol-configuration "serverProtocol=HTTP" `
      --environment-variables "file://$environmentVariablesFile" `
      --output json
  }
  $runtime = $update
} else {
  $runtime = Invoke-JsonCli {
    aws bedrock-agentcore-control create-agent-runtime `
      --region $Region `
      --cli-input-json "file://$runtimeFile" `
      --output json
  }
}

Write-Host "AgentCore runtime is ready for gateway wiring:"
Write-Host "  RuntimeArn : $($runtime.agentRuntimeArn)"
Write-Host "  RuntimeId  : $($runtime.agentRuntimeId)"
Write-Host "  Version    : $($runtime.agentRuntimeVersion)"
Write-Host "  RoleArn    : $roleArn"
Write-Host ""
Write-Host "Deploy ApiStack with:"
Write-Host "  `$env:TOOL_RUNTIME_PROVIDER='agentcore'"
Write-Host "  `$env:AGENTCORE_RUNTIME_ARN='$($runtime.agentRuntimeArn)'"
Write-Host ""
Write-Host "Or run:"
Write-Host "  powershell -File .\scripts\deploy-option-b-tool-runtime.ps1 -ToolRuntimeProvider agentcore -AgentCoreRuntimeArn '$($runtime.agentRuntimeArn)'"





