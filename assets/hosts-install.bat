@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
findstr /C:"api.getfiddler.be" C:\Windows\System32\drivers\etc\hosts >nul 2>&1
if %errorlevel% neq 0 (
  echo 127.0.0.1 api.getfiddler.be>> C:\Windows\System32\drivers\etc\hosts
  echo 127.0.0.1 identity.getfiddler.be>> C:\Windows\System32\drivers\etc\hosts
  echo hosts entries added OK
) else (
  echo hosts entries already exist
)
echo Done.
pause >nul
