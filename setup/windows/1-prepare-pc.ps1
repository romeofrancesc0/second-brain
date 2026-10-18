# Second Brain - prepare the always-on home PC (Windows). Run in PowerShell AS ADMINISTRATOR:
#   Set-ExecutionPolicy -Scope Process Bypass; .\1-prepare-pc.ps1
$ErrorActionPreference = 'Stop'

Write-Host "`n== 1/5 Programs (winget)" -ForegroundColor Cyan
$apps = @('Git.Git', 'OpenJS.NodeJS.LTS', 'Ollama.Ollama', 'Tailscale.Tailscale', 'Syncthing.Syncthing')
foreach ($a in $apps) {
  winget install --id $a -e --accept-source-agreements --accept-package-agreements --silent
}

Write-Host "`n== 2/5 Ollama reachable from the private network (Tailscale)" -ForegroundColor Cyan
# Ollama listens on all interfaces, but the firewall only lets Tailscale addresses (100.64.0.0/10) through
[Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0:11434', 'User')
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', '2m', 'User')
Get-NetFirewallRule -DisplayName 'Ollama (Tailscale only)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Ollama (Tailscale only)' -Direction Inbound -Protocol TCP -LocalPort 11434 `
  -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null

Write-Host "`n== 3/5 SSH (to use Claude Code and the terminal from the laptop)" -ForegroundColor Cyan
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
Set-Service sshd -StartupType Automatic
Start-Service sshd
# PowerShell as the default SSH shell
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Program Files\PowerShell\7\pwsh.exe' -PropertyType String -Force -ErrorAction SilentlyContinue | Out-Null
if (-not (Test-Path 'C:\Program Files\PowerShell\7\pwsh.exe')) {
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
}

Write-Host "`n== 4/5 Always on" -ForegroundColor Cyan
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 30
powercfg /hibernate off

Write-Host "`n== 5/5 Done" -ForegroundColor Green
Write-Host @"
Now, by hand:
  1. Open Tailscale from the taskbar and sign in (same account as the laptop).
     In the Tailscale admin console rename this PC to "homepc" and disable "Key expiry".
  2. Reboot the PC (needed for OLLAMA_HOST), then run 2-models.ps1 (no administrator needed).
  3. BIOS: enable "Restore on AC power loss" = Power On (boot again after a power outage).
"@
