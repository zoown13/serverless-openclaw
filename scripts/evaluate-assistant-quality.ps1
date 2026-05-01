param(
  [string]$FixturePath = (Join-Path (Split-Path -Parent $PSScriptRoot) "packages\container\__tests__\fixtures\gmail-quality-eval.json"),
  [string]$CandidatePath,
  [int]$TargetPercent = 80,
  [switch]$FailOnBelowTarget,
  [switch]$EmitJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "JSON file not found: $Path"
  }

  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $json = [System.IO.File]::ReadAllText($resolvedPath, [System.Text.Encoding]::UTF8)
  return $json | ConvertFrom-Json
}

function Get-PropertyValue {
  param(
    [object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $Object) {
    return $null
  }

  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) {
      return $Object[$Name]
    }

    return $null
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($property) {
    return $property.Value
  }

  return $null
}

function ConvertTo-List {
  param(
    [object]$Value
  )

  if ($null -eq $Value) {
    return @()
  }

  if ($Value -is [System.Array]) {
    return @($Value)
  }

  return @($Value)
}

function Test-ContainsText {
  param(
    [Parameter(Mandatory = $true)][string]$Haystack,
    [Parameter(Mandatory = $true)][string]$Needle
  )

  return $Haystack.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-CandidateCase {
  param(
    [object]$Candidate,
    [Parameter(Mandatory = $true)][string]$CaseId
  )

  if ($null -eq $Candidate) {
    return $null
  }

  $cases = Get-PropertyValue -Object $Candidate -Name "cases"
  if ($cases) {
    foreach ($candidateCase in (ConvertTo-List -Value $cases)) {
      if ((Get-PropertyValue -Object $candidateCase -Name "id") -eq $CaseId) {
        return $candidateCase
      }
    }
  }

  return Get-PropertyValue -Object $Candidate -Name $CaseId
}

function Get-CandidateStep {
  param(
    [object]$CandidateCase,
    [Parameter(Mandatory = $true)][int]$StepIndex
  )

  if ($null -eq $CandidateCase) {
    return $null
  }

  $steps = Get-PropertyValue -Object $CandidateCase -Name "steps"
  if ($null -eq $steps -and $CandidateCase -is [System.Array]) {
    $steps = $CandidateCase
  }

  $stepList = ConvertTo-List -Value $steps
  if ($StepIndex -ge $stepList.Count) {
    return $null
  }

  return $stepList[$StepIndex]
}

function Get-CandidateResponse {
  param(
    [object]$CandidateStep
  )

  if ($null -eq $CandidateStep) {
    return $null
  }

  if ($CandidateStep -is [string]) {
    return $CandidateStep
  }

  foreach ($name in @("response", "assistant", "answer", "text", "output")) {
    $value = Get-PropertyValue -Object $CandidateStep -Name $name
    if ($null -ne $value) {
      return [string]$value
    }
  }

  return $null
}

function Get-AdditionalFetchEvidence {
  param(
    [object]$CandidateStep
  )

  if ($null -eq $CandidateStep -or $CandidateStep -is [string]) {
    return [pscustomobject]@{
      HasEvidence = $false
      Count = 0
    }
  }

  $additionalFetches = Get-PropertyValue -Object $CandidateStep -Name "additionalFetches"
  if ($null -ne $additionalFetches) {
    return [pscustomobject]@{
      HasEvidence = $true
      Count = [int]$additionalFetches
    }
  }

  $fetches = Get-PropertyValue -Object $CandidateStep -Name "fetches"
  if ($null -ne $fetches) {
    return [pscustomobject]@{
      HasEvidence = $true
      Count = (ConvertTo-List -Value $fetches).Count
    }
  }

  $fetched = Get-PropertyValue -Object $CandidateStep -Name "fetched"
  if ($null -ne $fetched) {
    return [pscustomobject]@{
      HasEvidence = $true
      Count = $(if ([bool]$fetched) { 1 } else { 0 })
    }
  }

  return [pscustomobject]@{
    HasEvidence = $false
    Count = 0
  }
}

$fixture = Read-JsonFile -Path $FixturePath
$cases = ConvertTo-List -Value (Get-PropertyValue -Object $fixture -Name "cases")
if ($cases.Count -eq 0) {
  throw "Fixture does not contain any cases: $FixturePath"
}

$candidate = $null
if ($CandidatePath) {
  $candidate = Read-JsonFile -Path $CandidatePath
}

$totalSteps = 0
$includeChecks = 0
$excludeChecks = 0
$noAdditionalFetchChecks = 0
$bodyFixtureSteps = 0
$results = @()

foreach ($case in $cases) {
  $caseId = [string](Get-PropertyValue -Object $case -Name "id")
  $steps = ConvertTo-List -Value (Get-PropertyValue -Object $case -Name "steps")
  $candidateCase = Get-CandidateCase -Candidate $candidate -CaseId $caseId

  for ($index = 0; $index -lt $steps.Count; $index++) {
    $step = $steps[$index]
    $totalSteps++

    $expectIncludes = ConvertTo-List -Value (Get-PropertyValue -Object $step -Name "expectIncludes")
    $expectExcludes = ConvertTo-List -Value (Get-PropertyValue -Object $step -Name "expectExcludes")
    $expectNoAdditionalFetch = [bool](Get-PropertyValue -Object $step -Name "expectNoAdditionalFetch")
    $fullBodies = ConvertTo-List -Value (Get-PropertyValue -Object $step -Name "fullBodies")

    $includeChecks += $expectIncludes.Count
    $excludeChecks += $expectExcludes.Count
    if ($expectNoAdditionalFetch) {
      $noAdditionalFetchChecks++
    }
    if ($fullBodies.Count -gt 0) {
      $bodyFixtureSteps++
    }

    if (-not $candidate) {
      continue
    }

    $candidateStep = Get-CandidateStep -CandidateCase $candidateCase -StepIndex $index
    $response = Get-CandidateResponse -CandidateStep $candidateStep
    $missingIncludes = @()
    $unexpectedExcludes = @()
    $warnings = @()

    if ($null -eq $response -or $response.Length -eq 0) {
      $missingIncludes += "<candidate response missing>"
      $response = ""
    }

    foreach ($expected in $expectIncludes) {
      $expectedText = [string]$expected
      if (-not (Test-ContainsText -Haystack $response -Needle $expectedText)) {
        $missingIncludes += $expectedText
      }
    }

    foreach ($excluded in $expectExcludes) {
      $excludedText = [string]$excluded
      if (Test-ContainsText -Haystack $response -Needle $excludedText) {
        $unexpectedExcludes += $excludedText
      }
    }

    $additionalFetchCount = 0
    $fetchEvidence = Get-AdditionalFetchEvidence -CandidateStep $candidateStep
    if ($expectNoAdditionalFetch) {
      $additionalFetchCount = $fetchEvidence.Count
      if (-not $fetchEvidence.HasEvidence) {
        $warnings += "no additional-fetch evidence supplied"
      }
    }

    $passed = $missingIncludes.Count -eq 0 -and
      $unexpectedExcludes.Count -eq 0 -and
      (-not $expectNoAdditionalFetch -or $additionalFetchCount -eq 0)

    $results += [pscustomobject]@{
      CaseId = $caseId
      Step = $index + 1
      Passed = $passed
      MissingIncludes = $missingIncludes
      UnexpectedExcludes = $unexpectedExcludes
      ExpectedNoAdditionalFetch = $expectNoAdditionalFetch
      AdditionalFetchCount = $additionalFetchCount
      Warnings = $warnings
    }
  }
}

$report = [ordered]@{
  TargetPercent = $TargetPercent
  FixturePath = (Resolve-Path -LiteralPath $FixturePath).Path
  CandidatePath = $(if ($CandidatePath) { (Resolve-Path -LiteralPath $CandidatePath).Path } else { $null })
  Mode = $(if ($CandidatePath) { "candidate-scoring" } else { "fixture-audit" })
  Cases = $cases.Count
  Steps = $totalSteps
  IncludeChecks = $includeChecks
  ExcludeChecks = $excludeChecks
  NoAdditionalFetchChecks = $noAdditionalFetchChecks
  BodyFixtureSteps = $bodyFixtureSteps
}

if ($CandidatePath) {
  $passedSteps = @($results | Where-Object { $_.Passed }).Count
  $score = if ($totalSteps -gt 0) { [Math]::Round(($passedSteps / $totalSteps) * 100, 1) } else { 0 }
  $meetsTarget = $score -ge $TargetPercent

  $report["PassedSteps"] = $passedSteps
  $report["FailedSteps"] = $totalSteps - $passedSteps
  $report["ScorePercent"] = $score
  $report["MeetsTarget"] = $meetsTarget
  $report["Results"] = $results
} else {
  $report["Note"] = "No CandidatePath was supplied, so only fixture coverage was audited. Pass candidate assistant outputs to score quality against the target."
}

if ($EmitJson) {
  [pscustomobject]$report | ConvertTo-Json -Depth 8
} else {
  Write-Host "Assistant quality evaluation"
  Write-Host ("Mode: {0}" -f $report["Mode"])
  Write-Host ("Fixture: {0}" -f $report["FixturePath"])
  Write-Host ("Target: {0}%" -f $report["TargetPercent"])
  Write-Host ("Cases: {0}; steps: {1}; include checks: {2}; exclude checks: {3}; no-fetch checks: {4}; body-fixture steps: {5}" -f `
      $report["Cases"], $report["Steps"], $report["IncludeChecks"], $report["ExcludeChecks"], $report["NoAdditionalFetchChecks"], $report["BodyFixtureSteps"])

  if ($CandidatePath) {
    foreach ($result in $results) {
      $status = if ($result.Passed) { "PASS" } else { "FAIL" }
      Write-Host ("{0} {1} step {2}" -f $status, $result.CaseId, $result.Step)

      if (@($result.MissingIncludes).Count -gt 0) {
        Write-Host ("  Missing includes: {0}" -f ($result.MissingIncludes -join " | "))
      }
      if (@($result.UnexpectedExcludes).Count -gt 0) {
        Write-Host ("  Unexpected excludes: {0}" -f ($result.UnexpectedExcludes -join " | "))
      }
      if ($result.ExpectedNoAdditionalFetch -and $result.AdditionalFetchCount -gt 0) {
        Write-Host ("  Additional fetches: {0}" -f $result.AdditionalFetchCount)
      }
      if (@($result.Warnings).Count -gt 0) {
        Write-Host ("  Warnings: {0}" -f ($result.Warnings -join " | "))
      }
    }

    $targetStatus = if ($report["MeetsTarget"]) { "PASS" } else { "FAIL" }
    Write-Host ("Score: {0}% ({1}/{2} steps) target {3}% {4}" -f $report["ScorePercent"], $report["PassedSteps"], $report["Steps"], $report["TargetPercent"], $targetStatus)
  } else {
    Write-Host $report["Note"]
  }
}

if ($CandidatePath -and $FailOnBelowTarget -and -not $report["MeetsTarget"]) {
  exit 1
}
