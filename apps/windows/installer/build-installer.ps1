# Build the DSH Mobile Windows installer with Inno Setup 6.
#
# Usage (from anywhere):
#   ./apps/windows/installer/build-installer.ps1
#   ./apps/windows/installer/build-installer.ps1 -Version <version> `
#       -PublishDir portable/DshMobile.Win-<version>-win-x64 -OutputDir dist/windows
#
# The version is always read from DshMobile.Win.csproj; -Version is only an
# assertion used by the release workflow so the tag, project file and installer
# cannot disagree.

[CmdletBinding()]
param(
  [string]$Version,
  [string]$PublishDir,
  [string]$OutputDir,
  [string]$IsccPath
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$projectPath = Join-Path $repoRoot 'apps\windows\DshMobile.Win\DshMobile.Win.csproj'

[xml]$project = Get-Content -Raw -LiteralPath $projectPath
$versionNode = $project.SelectSingleNode('/Project/PropertyGroup/Version')
if ($null -eq $versionNode -or [string]::IsNullOrWhiteSpace($versionNode.InnerText)) {
  throw "No <Version> found in $projectPath"
}
$declaredVersion = $versionNode.InnerText.Trim()

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = $declaredVersion
}
elseif ($Version -ne $declaredVersion) {
  throw "Version '$Version' does not match the project's declared version '$declaredVersion'"
}

if ([string]::IsNullOrWhiteSpace($PublishDir)) {
  $PublishDir = Join-Path $repoRoot "portable\DshMobile.Win-$Version-win-x64"
}
if (-not [IO.Path]::IsPathRooted($PublishDir)) {
  $PublishDir = Join-Path (Get-Location) $PublishDir
}
$publishedExe = Join-Path $PublishDir 'DshMobile.Win.exe'
if (-not (Test-Path -LiteralPath $publishedExe)) {
  throw "Publish folder '$PublishDir' has no DshMobile.Win.exe. Run 'dotnet publish -c Release -r win-x64 --self-contained true -o $PublishDir' first."
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $repoRoot 'dist\windows'
}
if (-not [IO.Path]::IsPathRooted($OutputDir)) {
  $OutputDir = Join-Path (Get-Location) $OutputDir
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$languageFile = Join-Path $PSScriptRoot 'Languages\ChineseSimplified.isl'
if (-not (Test-Path -LiteralPath $languageFile)) {
  throw "Missing vendored language file '$languageFile'"
}

# Inno Setup's VersionInfoVersion must be four numeric parts; the release
# version may carry a prerelease suffix, which is dropped here only for the
# installer's own file-version resource.
$numericVersion = ($Version -split '-', 2)[0]
$numericParts = @($numericVersion.Split('.'))
if ($numericParts.Count -gt 4) {
  throw "Version '$Version' has more than four numeric parts"
}
while ($numericParts.Count -lt 4) { $numericParts += '0' }
$numericVersion = $numericParts -join '.'

if ([string]::IsNullOrWhiteSpace($IsccPath)) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $IsccPath = $candidate
      break
    }
  }
}
if ([string]::IsNullOrWhiteSpace($IsccPath) -or -not (Test-Path -LiteralPath $IsccPath)) {
  throw 'ISCC.exe not found. Install Inno Setup 6 (winget install --id JRSoftware.InnoSetup) or pass -IsccPath.'
}

$isccArgs = @(
  "/DMyAppVersion=$Version",
  "/DMyAppVersionNumeric=$numericVersion",
  "/DMyPublishDir=$PublishDir",
  "/DMyOutputDir=$OutputDir",
  (Join-Path $PSScriptRoot 'DshMobile.Win.iss')
)

Write-Output "Compiling installer $Version from $PublishDir"
& $IsccPath @isccArgs
if ($LASTEXITCODE -ne 0) {
  throw "ISCC failed with exit code $LASTEXITCODE"
}

$setupPath = Join-Path $OutputDir "dsh-mobile-windows-v$Version-win-x64-setup.exe"
if (-not (Test-Path -LiteralPath $setupPath)) {
  throw "ISCC reported success but '$setupPath' is missing"
}
$sizeMb = [math]::Round(((Get-Item -LiteralPath $setupPath).Length / 1MB), 1)
Write-Output "installer: $setupPath ($sizeMb MB)"
