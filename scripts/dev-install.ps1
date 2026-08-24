# 开发安装:把 phone-lens 插件装进 dsh 的 web profile
# 用法: powershell -ExecutionPolicy Bypass -File scripts\dev-install.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pkg = Join-Path $root "packages\phone-lens"

Write-Host "==> building phone-lens..."
Push-Location $pkg
pnpm build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "build failed" }
Pop-Location

Write-Host "==> installing into dsh profile 'web' (pnpm add local path)..."
dsh plugin --profile web add $pkg
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed" }

Write-Host ""
Write-Host "done. restart dsh web and check the boot log for:"
Write-Host "  [phone-lens] 手机扫码配对(或浏览器打开 http://127.0.0.1:8791/view.html)"
