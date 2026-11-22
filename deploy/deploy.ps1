# Deploys Odin from this PC to the host. Settings come from deploy/host.env.local. Usage: deploy.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $PSScriptRoot "host.env.local"
if (-not (Test-Path $EnvFile)) { throw "Missing $EnvFile. Copy deploy/host.env.example to it and edit." }

$Cfg = @{ ODIN_DEPLOY_USER = "odin"; ODIN_CORE_PORT = "8790"; ODIN_SERVE_PORT = "8443" }
foreach ($line in Get-Content $EnvFile) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$' -and -not $line.TrimStart().StartsWith("#")) { $Cfg[$Matches[1]] = $Matches[2].Trim('"', "'") }
}
if (-not $Cfg.ODIN_DEPLOY_HOST) { throw "Set ODIN_DEPLOY_HOST in host.env.local" }
$Target = "$($Cfg.ODIN_DEPLOY_USER)@$($Cfg.ODIN_DEPLOY_HOST)"
$Port = $Cfg.ODIN_CORE_PORT
$Tgz = Join-Path $env:TEMP "odin-deploy.tgz"

function Invoke-Checked([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$what failed" }
}

Push-Location $Root
try {
  Write-Host "Building web..."
  Invoke-Checked "build:web" { corepack yarn build:web }
  if (-not (Test-Path (Join-Path $Root "packages/web/dist/index.html"))) { throw "packages/web/dist/index.html missing after build" }

  Write-Host "Packing..."
  Invoke-Checked "tar" { tar -czf $Tgz --exclude=node_modules --exclude=.git --exclude=.worktrees --exclude=.yarn/cache --exclude=apps/desktop/stage --exclude=apps/desktop/dist --exclude=packages/core/dist --exclude=packages/shared/dist package.json yarn.lock .yarnrc.yml tsconfig.json packages apps adapters templates deploy docs }

  Write-Host "Uploading to $Target..."
  Invoke-Checked "upload" { scp -q -o BatchMode=yes $Tgz "${Target}:/tmp/odin-deploy.tgz" }
  Write-Host "Installing..."
  $install = "rm -rf ~/odin-app/packages/web/dist && mkdir -p ~/odin-app && tar -xzf /tmp/odin-deploy.tgz -C ~/odin-app && ODIN_CORE_PORT=$Port `$SHELL -l -c 'sh ~/odin-app/deploy/remote-install.sh'"
  Invoke-Checked "install" { ssh -o BatchMode=yes $Target $install }
  Write-Host "Waiting for core /api/health (up to 60s)..."
  $health = "ODIN_CORE_PORT=$Port `$SHELL -l -c 'sh ~/odin-app/deploy/wait-health.sh'"
  Invoke-Checked "health check" { ssh -o BatchMode=yes $Target $health }
  Write-Host "Deployed."
} finally {
  Pop-Location
}
