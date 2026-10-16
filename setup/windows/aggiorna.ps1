# Aggiorna app e servizio all'ultima versione su GitHub.
$Dir = "$env:USERPROFILE\Projects\second-brain"
Set-Location $Dir
git pull
npm ci
Get-Process 'Second Brain' -ErrorAction SilentlyContinue | Stop-Process
npm run app:win
Stop-ScheduledTask 'Second Brain - servizio' -ErrorAction SilentlyContinue
Start-ScheduledTask 'Second Brain - servizio'
Start-Process "$Dir\dist\win-unpacked\Second Brain.exe"
