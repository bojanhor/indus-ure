[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9_-]{16,128}$')] [string]$TestPassword,
  [string]$HostName = "192.168.50.242",
  [string]$UserName = "gpt",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\indus_ure_ed25519"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
function Invoke-Native {
  param([Parameter(Mandatory)] [string]$Command, [Parameter(ValueFromRemainingArguments)] [string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Ukaz '$Command' se je končal z izhodno kodo $LASTEXITCODE." }
}
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw "SSH ključ ne obstaja: $IdentityFile" }
$sshOptions = @("-i", $IdentityFile, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10")
$target = "${UserName}@${HostName}"
Invoke-Native scp @sshOptions (Join-Path $repoRoot "deploy\indus-ure-test.service") "${target}:/tmp/indus-ure-test.service"
Invoke-Native scp @sshOptions (Join-Path $repoRoot "scripts\server\deploy-indus-ure-test") "${target}:/tmp/deploy-indus-ure-test"
$remoteScript = @"
set -euo pipefail
TEST_PASSWORD='$TestPassword'
ENV_FILE=/etc/indus-ure-test.env
if ! id -u indus-ure-test >/dev/null 2>&1; then
  sudo useradd --system --home /var/lib/indus-ure-test --create-home --shell /usr/sbin/nologin indus-ure-test
fi
sudo install -d -o indus-ure-test -g indus-ure-test -m 0700 /var/lib/indus-ure-test /var/lib/indus-ure-test/media
if [ ! -f "`$ENV_FILE" ]; then
  DB_PASSWORD="`$(openssl rand -hex 32)"
  if ! sudo -u postgres psql -Atqc "select 1 from pg_roles where rolname = 'indus_ure_test'" | grep -qx 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "create role indus_ure_test login password '`$DB_PASSWORD'"
  fi
  if ! sudo -u postgres psql -Atqc "select 1 from pg_database where datname = 'indus_ure_test'" | grep -qx 1; then
    sudo -u postgres createdb --owner=indus_ure_test indus_ure_test
  fi
  sudo install -o root -g root -m 0600 /dev/null "`$ENV_FILE"
  sudo tee "`$ENV_FILE" >/dev/null <<ENV
PORT=8124
HOST=0.0.0.0
NODE_ENV=test
INDUS_URE_TEST_MODE=true
TEST_LOCAL_LOGIN_PASSWORD=`$TEST_PASSWORD
PUBLIC_BASE_URL=http://192.168.50.242:8124
DATA_DIR=/var/lib/indus-ure-test
MEDIA_DIR=/var/lib/indus-ure-test/media
DATABASE_URL=postgresql://indus_ure_test:`$DB_PASSWORD@127.0.0.1:5432/indus_ure_test
DISABLE_OPERATIONAL_MONITOR=true
ENV
fi
sudo install -o root -g root -m 0644 /tmp/indus-ure-test.service /etc/systemd/system/indus-ure-test.service
sudo install -o root -g root -m 0755 /tmp/deploy-indus-ure-test /usr/local/sbin/deploy-indus-ure-test
sudo systemctl daemon-reload
sudo systemctl enable indus-ure-test.service
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q '^Status: active'; then
  sudo ufw allow from 192.168.50.0/24 to any port 8124 proto tcp comment 'INDUS URE local browser test'
fi
printf 'Testna instanca je pripravljena na http://192.168.50.242:8124\n'
"@
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
Invoke-Native ssh @sshOptions $target "echo $payload | base64 -d | bash"
