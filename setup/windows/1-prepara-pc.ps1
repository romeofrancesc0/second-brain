# Second Brain - preparazione del PC di casa (Windows). Esegui in PowerShell COME AMMINISTRATORE:
#   Set-ExecutionPolicy -Scope Process Bypass; .\1-prepara-pc.ps1
$ErrorActionPreference = 'Stop'

Write-Host "`n== 1/5 Programmi (winget)" -ForegroundColor Cyan
$apps = @('Git.Git', 'OpenJS.NodeJS.LTS', 'Ollama.Ollama', 'Tailscale.Tailscale', 'Syncthing.Syncthing')
foreach ($a in $apps) {
  winget install --id $a -e --accept-source-agreements --accept-package-agreements --silent
}

Write-Host "`n== 2/5 Ollama raggiungibile dalla rete privata (Tailscale)" -ForegroundColor Cyan
# Ollama ascolta su tutte le interfacce, ma il firewall lascia passare SOLO gli indirizzi Tailscale (100.64.0.0/10)
[Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0:11434', 'User')
[Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', '2m', 'User')
Get-NetFirewallRule -DisplayName 'Ollama (solo Tailscale)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Ollama (solo Tailscale)' -Direction Inbound -Protocol TCP -LocalPort 11434 `
  -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null

Write-Host "`n== 3/5 SSH (per usare Claude Code e il terminale dal Mac)" -ForegroundColor Cyan
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
Set-Service sshd -StartupType Automatic
Start-Service sshd
# PowerShell come shell di default per SSH
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Program Files\PowerShell\7\pwsh.exe' -PropertyType String -Force -ErrorAction SilentlyContinue | Out-Null
if (-not (Test-Path 'C:\Program Files\PowerShell\7\pwsh.exe')) {
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
}

Write-Host "`n== 4/5 Sempre acceso" -ForegroundColor Cyan
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 30
powercfg /hibernate off

Write-Host "`n== 5/5 Fatto" -ForegroundColor Green
Write-Host @"
Ora, a mano:
  1. Apri Tailscale dalla barra delle applicazioni e accedi (stesso account del Mac).
     In admin.tailscale.com rinomina questo PC in "palermo" e disattiva "Key expiry".
  2. Riavvia il PC (serve per OLLAMA_HOST), poi lancia 2-modelli.ps1 (non serve l'amministratore).
  3. BIOS: abilita "Restore on AC power loss" = Power On (riaccensione dopo un blackout).
"@
