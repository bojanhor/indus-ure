[CmdletBinding()]
param(
  [string]$HostName = "192.168.50.242",
  [string]$UserName = "gpt",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\indus_ure_ed25519",
  [string]$PublicUrl = "https://ure.indus.si/",
  [switch]$SkipTests,
  [switch]$SkipPush
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
    Write-Host "[1/8] Testi"
    Invoke-Native npm.cmd test
  } else {
    Write-Host "[1/8] Testi preskoceni"
  }

  $fullCommit = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $fullCommit -notmatch '^[0-9a-f]{40}$') {
    throw "Ni mogoče dolociti trenutnega commita."
  }
  $release = $fullCommit.Substring(0, 7)

  if (-not $SkipPush) {
    Write-Host "[2/8] Git push $release"
    Invoke-Native git push origin HEAD:main
  } else {
    Write-Host "[2/8] Git push preskocen"
  }

  $archive = Join-Path $env:TEMP "indus-ure-$release.tar.gz"
  Write-Host "[3/8] Arhiv $release"
  Invoke-Native git archive --format=tar.gz "--output=$archive" $fullCommit
  $checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()

  $sshOptions = @(
    "-i", $IdentityFile,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10"
  )
  $target = "${UserName}@${HostName}"

  Write-Host "[4/8] Prenos"
  Invoke-Native scp @sshOptions $archive "${target}:/tmp/indus-ure-$release.tar.gz"

  $nginxConfig = Join-Path $repoRoot "deploy\nginx-indus-ure.conf"
  $remoteNginxConfig = "/tmp/indus-ure-nginx-$release.conf"
  $pruneScript = Join-Path $repoRoot "deploy\prune-indus-ure-releases"
  $remotePruneScript = "/tmp/indus-ure-prune-$release"
  Write-Host "[5/8] Nginx in ciscenje izdaj"
  Invoke-Native scp @sshOptions $nginxConfig "${target}:$remoteNginxConfig"
  Invoke-Native scp @sshOptions $pruneScript "${target}:$remotePruneScript"

  Write-Host "[6/8] Priprava in preklop izdaje"
  $remoteCommand = "prepare-indus-ure-release $release $checksum && sudo /usr/local/sbin/deploy-indus-ure $release && sudo install -o root -g root -m 0644 $remoteNginxConfig /etc/nginx/conf.d/indus-ure.conf && sudo install -o root -g root -m 0755 $remotePruneScript /usr/local/sbin/prune-indus-ure-releases && sudo /usr/local/sbin/prune-indus-ure-releases 3 && sudo nginx -t && sudo systemctl reload nginx"
  Invoke-Native ssh @sshOptions $target $remoteCommand

  Write-Host "[7/8] Preverjanje produkcije"
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
