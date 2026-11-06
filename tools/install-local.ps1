# 安装一级市场调查工作台到当前 web profile。
# 可重复执行；每一步先备份 profile 配置。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$backupDir = Join-Path $root '.backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item (Join-Path $profileDir 'package.json') (Join-Path $backupDir "package.json.$stamp-install") -Force
Copy-Item (Join-Path $profileDir 'cordis.patch.yml') (Join-Path $backupDir "cordis.patch.yml.$stamp-install") -Force

# dsh plugin 需要 PATH 中有 pnpm；优先使用 corepack，不修改全局安装。
$tools = Join-Path $root '.tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$pnpmShim = Join-Path $tools 'pnpm.cmd'
if (-not (Test-Path $pnpmShim)) {
  Set-Content -Path $pnpmShim -Value "@echo off`r`ncorepack pnpm %*" -Encoding ASCII
}
$env:PATH = "$tools;$env:PATH"

Write-Host "Installing $root -> profile $profileDir"
dsh plugin --profile web add "link:$root"

# 避免“bundle 行 + patch 行”重复：从 bundles 移除，由 patch 行单独插入。
$env:EQUITY_PROFILE_DIR = $profileDir
$env:EQUITY_PLUGIN_ROOT = $root
node -e @'
const fs = require('fs');
const path = require('path');
const dir = process.env.EQUITY_PROFILE_DIR;
const pkgPath = path.join(dir, 'package.json');
const patchPath = path.join(dir, 'cordis.patch.yml');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['dsh-equity-diligence'] = 'link:' + process.env.EQUITY_PLUGIN_ROOT.replaceAll('\\', '/');
pkg.dsh = pkg.dsh || {}; pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles || []).filter((name) => name !== 'dsh-equity-diligence');
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
let patch = fs.readFileSync(patchPath, 'utf8').replace(/^\uFEFF/, '');
if (!/id:\s*equity-diligence/.test(patch)) {
  patch = patch.trimEnd() + '\n\n# 一级市场调查工作台（本地 link 安装，可用 rollback-local.ps1 回滚）\n- insert:\n    - id: equity-diligence\n      name: \'dsh-equity-diligence\'\n';
  fs.writeFileSync(patchPath, patch);
}
console.log('profile composed: dependency + single patch row');
'@

Write-Host ''
Write-Host 'Installed. Refresh the Web GUI; if the host has not hot-reloaded the profile, restart DSH web.'
Write-Host 'Rollback: tools/rollback-local.ps1'
