param(
  [string]$Region = $(if ($env:AWS_REGION) { $env:AWS_REGION } else { "ap-northeast-2" }),
  [string]$Repository = "zoown13/serverless-openclaw",
  [string]$RoleName = "serverless-openclaw-github-actions-deploy",
  [string]$ProviderUrl = "https://token.actions.githubusercontent.com",
  [string]$Thumbprint = "6938fd4d98bab03faadb97b34396831e3780aea1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertTo-Utf8JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )

  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

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

$accountId = Invoke-TextCli {
  aws sts get-caller-identity --query Account --output text --region $Region
}
$providerHost = $ProviderUrl.Replace("https://", "").TrimEnd("/")
$providerArn = "arn:aws:iam::${accountId}:oidc-provider/${providerHost}"

$existingProviders = Invoke-JsonCli {
  aws iam list-open-id-connect-providers --output json
}
$hasProvider = @($existingProviders.OpenIDConnectProviderList |
  Where-Object { $_.Arn -eq $providerArn }).Count -gt 0

if (-not $hasProvider) {
  Write-Host "Creating GitHub Actions OIDC provider: $providerArn"
  aws iam create-open-id-connect-provider `
    --url $ProviderUrl `
    --client-id-list sts.amazonaws.com `
    --thumbprint-list $Thumbprint `
    --tags Key=Project,Value=serverless-openclaw Key=ManagedBy,Value=setup-github-actions-oidc `
    --output json | Out-Null
} else {
  Write-Host "GitHub Actions OIDC provider already exists: $providerArn"
}

$trustFile = Join-Path $env:TEMP "serverless-openclaw-github-actions-trust.json"
$policyFile = Join-Path $env:TEMP "serverless-openclaw-github-actions-policy.json"

ConvertTo-Utf8JsonFile -Path $trustFile -Value @{
  Version = "2012-10-17"
  Statement = @(
    @{
      Effect = "Allow"
      Principal = @{ Federated = $providerArn }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = @{
        StringEquals = @{
          "${providerHost}:aud" = "sts.amazonaws.com"
        }
        StringLike = @{
          "${providerHost}:sub" = "repo:${Repository}:*"
        }
      }
    }
  )
}

$role = $null
try {
  $role = Invoke-JsonCli {
    aws iam get-role --role-name $RoleName --output json
  }
  Write-Host "Updating trust policy for existing role: $RoleName"
  aws iam update-assume-role-policy `
    --role-name $RoleName `
    --policy-document "file://$trustFile" | Out-Null
} catch {
  Write-Host "Creating GitHub Actions deployment role: $RoleName"
  $role = Invoke-JsonCli {
    aws iam create-role `
      --role-name $RoleName `
      --assume-role-policy-document "file://$trustFile" `
      --description "GitHub Actions deployment role for Serverless OpenClaw AgentCore production deploys" `
      --tags Key=Project,Value=serverless-openclaw Key=ManagedBy,Value=setup-github-actions-oidc `
      --output json
  }
}

ConvertTo-Utf8JsonFile -Path $policyFile -Value @{
  Version = "2012-10-17"
  Statement = @(
    @{
      Sid = "DeploymentReadIdentity"
      Effect = "Allow"
      Action = @(
        "sts:GetCallerIdentity"
      )
      Resource = "*"
    },
    @{
      Sid = "ServerlessOpenClawDeployment"
      Effect = "Allow"
      Action = @(
        "apigateway:*",
        "bedrock-agentcore:*",
        "bedrock-agentcore-control:*",
        "cloudformation:*",
        "dynamodb:*",
        "ec2:Describe*",
        "ecr:*",
        "ecs:*",
        "events:*",
        "iam:AttachRolePolicy",
        "iam:CreateRole",
        "iam:DeleteRolePolicy",
        "iam:GetOpenIDConnectProvider",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:List*",
        "iam:PassRole",
        "iam:PutRolePolicy",
        "iam:TagRole",
        "iam:UpdateAssumeRolePolicy",
        "lambda:*",
        "logs:*",
        "s3:*",
        "ssm:DescribeParameters",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath"
      )
      Resource = "*"
    }
  )
}

aws iam put-role-policy `
  --role-name $RoleName `
  --policy-name "serverless-openclaw-github-actions-deploy-policy" `
  --policy-document "file://$policyFile" | Out-Null

$roleArn = if ($role.Role.Arn) { $role.Role.Arn } else { "arn:aws:iam::${accountId}:role/${RoleName}" }

Write-Host ""
Write-Host "GitHub Actions OIDC deployment role is ready."
Write-Host "  RoleArn    : $roleArn"
Write-Host "  Repository : $Repository"
Write-Host "  Region     : $Region"
Write-Host ""
Write-Host "Next step:"
Write-Host "  Add this repository secret in GitHub:"
Write-Host "  AWS_OIDC_ROLE_ARN=$roleArn"
