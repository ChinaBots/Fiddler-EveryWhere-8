@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -Command "$h='C:\Windows\System32\drivers\etc\hosts'; $c = Get-Content $h | Where-Object {$_ -notmatch 'getfiddler'}; Set-Content -Path $env:TEMP\hosts.tmp -Value $c -Encoding ascii; Move-Item -Force $env:TEMP\hosts.tmp $h"
if %errorlevel% neq 0 (echo hosts update FAILED - check permissions) else (echo hosts entries removed OK)
pause
