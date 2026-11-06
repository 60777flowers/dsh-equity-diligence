# 从当前 web profile 回滚一级市场调查工作台。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$backupDir = Join-Path $root '.backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (Test-Path (Join-Path $profileDir 'package.json')) {
  Copy-Item (Join-Path $profileDir 'package.json') (Join-Path $backupDir "package.json.$stamp-rollback") -Force
}
if (Test-Path (Join-Path $profileDir 'cordis.patch.yml')) {
  Copy-Item (Join-Path $profileDir 'cordis.patch.yml') (Join-Path $backupDir "cordis.patch.yml.$stamp-rollback") -Force
}

$env:EQUITY_PROFILE_DIR = $profileDir
node -e @'
const fs = require('fs');
const path = require('path');
const dir = process.env.EQUITY_PROFILE_DIR;
const pkgPath = path.join(dir, 'package.json');
const patchPath = path.join(dir, 'cordis.patch.yml');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
  if (pkg.dependencies) delete pkg.dependencies['dsh-equity-diligence'];
  if (pkg.dsh?.profile?.bundles) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== 'dsh-equity-diligence');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}
if (fs.existsSync(patchPath)) {
  let patch = fs.readFileSync(patchPath, 'utf8').replace(/^\uFEFF/, '');
  const marker = '# 一级市场调查工作台';
  const index = patch.lastIndexOf(marker);
  if (index >= 0) patch = patch.slice(0, index).trimEnd() + '\n';
  fs.writeFileSync(patchPath, patch);
}
console.log('profile dependency / patch row removed');
'@

$link = Join-Path $profileDir 'node_modules\dsh-equity-diligence'
if (Test-Path $link) { Remove-Item $link -Recurse -Force }
Write-Host 'Rolled back. Refresh the Web GUI; if needed, restart DSH web.'
