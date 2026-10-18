# Update the app and the service to the latest version on GitHub.
$Dir = "$env:USERPROFILE\Projects\second-brain"
Set-Location $Dir
git pull
npm ci
Get-Process 'Second Brain' -ErrorAction SilentlyContinue | Stop-Process
npm run app:win
Stop-ScheduledTask 'Second Brain - service' -ErrorAction SilentlyContinue
Start-ScheduledTask 'Second Brain - service'
Start-Process "$Dir\dist\win-unpacked\Second Brain.exe"
