[CmdletBinding()]
param(
  [string]$HostName = "192.168.50.242",
  [string]$UserName = "gpt",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\indus_ure_ed25519",
  [string]$PublicUrl = "https://ure.indus.si/",
  [switch]$SkipTests,
  [switch]$SkipPush,
  [switch]$SkipVideoSmoke
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Native {
  param(
    [Parameter(Mandatory)] [string]$Command,
    [Parameter(ValueFromRemainingArguments)] [string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Ukaz '$Command' se je končal z izhodno kodo $LASTEXITCODE."
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
  if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
    throw "SSH ključ ne obstaja: $IdentityFile"
  }

  $dirty = (& git status --porcelain)
  if ($LASTEXITCODE -ne 0) {
    throw "Ni mogoče preveriti Git delovnega drevesa."
  }
  if ($dirty) {
    throw "Delovno drevo ni čisto. Spremembe najprej commitaj."
  }

  if (-not $SkipTests) {
    Write-Host "[1/6] Testi"
    Invoke-Native npm.cmd test
  } else {
    Write-Host "[1/6] Testi preskoceni"
  }

  $fullCommit = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $fullCommit -notmatch '^[0-9a-f]{40}$') {
    throw "Ni mogoče dolociti trenutnega commita."
  }
  $release = $fullCommit.Substring(0, 7)

  if (-not $SkipPush) {
    Write-Host "[2/6] Git push $release"
    Invoke-Native git push origin HEAD:main
  } else {
    Write-Host "[2/6] Git push preskocen"
  }

  $archive = Join-Path $env:TEMP "indus-ure-$release.tar.gz"
  Write-Host "[3/6] Arhiv $release"
  Invoke-Native git archive --format=tar.gz "--output=$archive" $fullCommit
  $checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()

  $sshOptions = @(
    "-i", $IdentityFile,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10"
  )
  $target = "${UserName}@${HostName}"

  Write-Host "[4/6] Prenos"
  Invoke-Native scp @sshOptions $archive "${target}:/tmp/indus-ure-$release.tar.gz"

  Write-Host "[5/6] Priprava in preklop izdaje"
  $remoteCommand = "prepare-indus-ure-release $release $checksum && sudo /usr/local/sbin/deploy-indus-ure $release"
  if (-not $SkipVideoSmoke) {
    $remoteCommand += " && sudo systemd-run --quiet --wait --collect --pipe -p User=indus-ure -p Group=indus-ure -p EnvironmentFile=/etc/indus-ure.env -p WorkingDirectory=/opt/indus-ure/current /usr/bin/node /opt/indus-ure/current/scripts/smoke-drive-video-upload.js"
  }
  Invoke-Native ssh @sshOptions $target $remoteCommand

  Write-Host "[6/6] Preverjanje produkcije"
  $healthy = $false
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $PublicUrl -MaximumRedirection 5 -TimeoutSec 10
      if ($response.StatusCode -eq 200) {
        $healthy = $true
        break
      }
    } catch {
      if ($attempt -eq 10) {
        throw
      }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) {
    throw "Produkcija po desetih poskusih ni vrnila HTTP 200."
  }

  Write-Host "Objavljeno: $release ($PublicUrl)" -ForegroundColor Green
} finally {
  if (Get-Variable archive -ErrorAction SilentlyContinue) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
