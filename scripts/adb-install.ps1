# 构建 APK 并通过 adb 安装到已连接的手机
# 用法: powershell -ExecutionPolicy Bypass -File scripts\adb-install.ps1 [-Run]
param([switch]$Run)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root "packages\app"

Write-Host "==> flutter build apk --release"
Push-Location $app
flutter build apk --release
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "build failed" }
Pop-Location

$apk = Join-Path $app "build\app\outputs\flutter-apk\app-release.apk"
Write-Host "==> adb install -r $apk"
adb install -r $apk
if ($LASTEXITCODE -ne 0) { throw "adb install failed" }

if ($Run) {
  Write-Host "==> launching com.lensmate.lens_mate / .MainActivity"
  adb shell am start -n com.lensmate.lens_mate/.MainActivity
}
Write-Host "done."
