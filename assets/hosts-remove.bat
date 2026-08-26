@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -Command "(Get-Content 'C:\Windows\System32\drivers\etc\hosts') | Where-Object {$_ -notmatch 'getfiddler'} | Set-Content 'C:\Windows\System32\drivers\etc\hosts'"
echo hosts entries removed.
pause
