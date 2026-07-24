[CmdletBinding()]
param(
  [string]$HostName = "192.168.50.242",
  [string]$UserName = "gpt",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\indus_ure_ed25519",
  [string]$TestUrl = "http://192.168.50.242:8124"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Native {
  param([Parameter(Mandatory)] [string]$Command, [Parameter(ValueFromRemainingArguments)] [string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Ukaz '$Command' se je končal z izhodno kodo $LASTEXITCODE." }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw "SSH ključ ne obstaja: $IdentityFile" }
  $safeRepo = $repoRoot.Replace('\', '/')
  $dirty = (& git -c "safe.directory=$safeRepo" status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw "Ni mogoče preveriti Git delovnega drevesa." }
  if ($dirty) { throw "Delovno drevo ni čisto. Spremembe najprej commitaj." }
  Write-Host "[1/5] Testi"
  Invoke-Native npm.cmd test
  $fullCommit = (& git -c "safe.directory=$safeRepo" rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $fullCommit -notmatch '^[0-9a-f]{40}$') { throw "Ni mogoče določiti trenutnega commita." }
  $release = $fullCommit.Substring(0, 7)
  $archive = Join-Path $env:TEMP "indus-ure-$release.tar.gz"
  Write-Host "[2/5] Arhiv testne izdaje $release"
  & git -c "safe.directory=$safeRepo" archive --format=tar.gz "--output=$archive" $fullCommit
  if ($LASTEXITCODE -ne 0) { throw "Git arhiva testne izdaje ni bilo mogoče ustvariti." }
  $checksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
  $sshOptions = @("-i", $IdentityFile, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10")
  $target = "${UserName}@${HostName}"
  Write-Host "[3/5] Prenos"
  Invoke-Native scp @sshOptions $archive "${target}:/tmp/indus-ure-$release.tar.gz"
  Write-Host "[4/5] Preklop lokalne testne izdaje"
  Invoke-Native ssh @sshOptions $target "prepare-indus-ure-release $release $checksum && sudo /usr/local/sbin/deploy-indus-ure-test $release && rm -rf /tmp/indus-ure-$release-deploy"
  Write-Host "[5/5] Preverjanje testne instance"
  $healthUrl = "$($TestUrl.TrimEnd('/'))/api/health"
  $response = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 15
  if ($response.StatusCode -ne 200) { throw "Testna instanca ni vrnila HTTP 200." }
  Write-Host "Testna izdaja: $release ($TestUrl)" -ForegroundColor Green
} finally {
  if (Get-Variable archive -ErrorAction SilentlyContinue) { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
  Pop-Location
}
