@echo off
rem Read-only session diagnostics (no booking is sent): cookie names, status codes, session lifetime (about 2 minutes).
rem Saved to logs\diag-session.txt (no passwords, tokens or cookie values). Stop the bot first.
setlocal EnableExtensions
cd /d "%~dp0.."
if not exist ".env" (
  echo .env not found.
  pause
  exit /b 1
)
if not exist logs mkdir logs
echo Running the diagnostics, about 2 minutes, please wait...
node --env-file=.env scripts\diag-session.mjs > logs\diag-session.txt 2>&1
type logs\diag-session.txt
echo.
echo Saved to logs\diag-session.txt - just tell Claude it is done.
pause
