# Install the Second Brain app from the GitHub repo, plus the always-on service (agent + Telegram bot).
#   .\3-app-and-service.ps1 -Vault "C:\Users\<you>\SECONDBRAIN"
param(
  [Parameter(Mandatory = $true)][string]$Vault,
  [string]$Repo = 'https://github.com/romeofrancesc0/second-brain.git',
  [string]$Dir = "$env:USERPROFILE\Projects\second-brain"
)
$ErrorActionPreference = 'Stop'

if (Test-Path "$Dir\.git") { git -C $Dir pull } else { git clone $Repo $Dir }
Set-Location $Dir
npm ci
npm run app:win
Write-Host "App: $Dir\dist\win-unpacked\Second Brain.exe" -ForegroundColor Green

# service configuration
$data = "$env:APPDATA\Second Brain"
New-Item -ItemType Directory -Force -Path $data | Out-Null
$serverJson = "$data\server.json"
if (-not (Test-Path $serverJson)) {
  @{ vault = $Vault; telegramToken = ''; allowedUsers = @() } | ConvertTo-Json | Set-Content -Encoding UTF8 $serverJson
}
$configJson = "$data\config.json"
if (-not (Test-Path $configJson)) {
  @{ lastVault = $Vault; ai = @{ provider = 'ollama'; baseUrl = 'http://localhost:11434'; model = 'qwen3.5:9b'; embedModel = 'nomic-embed-text'; numCtx = 16384 } } |
    ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $configJson
}

# start at login, restart if it stops
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$Dir\out\main\server.js`"" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0 -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName 'Second Brain - service' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

# open the app at login
$lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Second Brain.lnk"
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sh.TargetPath = "$Dir\dist\win-unpacked\Second Brain.exe"
$sh.Save()

Write-Host "`nEdit $serverJson with the bot token and your Telegram ID, then:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask 'Second Brain - service'"
