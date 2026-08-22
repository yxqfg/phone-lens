# 放行 phone-lens 接收端口(默认 8791,仅私有网段;需要管理员)
# 用法: powershell -ExecutionPolicy Bypass -File scripts\firewall.ps1 [-Port 8791] [-Remove]
param(
  [int]$Port = 8791,
  [switch]$Remove
)
$rule = "PhoneLens Receiver ($Port)"
if ($Remove) {
  Remove-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
  Write-Host "removed rule '$rule'"
  exit 0
}
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "需要管理员权限运行(右键以管理员身份运行,或 git-bash 里用提升的 shell)"
  exit 1
}
New-NetFirewallRule -DisplayName $rule -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort $Port `
  -RemoteAddress LocalSubnet,Intranet |
  Out-Null
Write-Host "allowed inbound TCP/$Port from LocalSubnet+Intranet (rule '$rule')"
Write-Host "USB tethering note: the phone's tether subnet usually matches 'Intranet'; if pairing"
Write-Host "fails over USB, rerun with -Remove and add an explicit -RemoteAddress for that subnet."
