@echo off
rem Builds and starts the bot. Keep this window open: closing it stops the bot. Ctrl+C stops it cleanly.
rem Logs (JSON lines, secrets redacted) are also appended to logs\bot.log.
setlocal EnableExtensions
cd /d "%~dp0.."
title vamos-a-padel-bot
if not exist ".env" (
  echo .env not found: copy .env.example to .env and fill it in first.
  pause
  exit /b 1
)
if not exist logs mkdir logs
echo Building...
call npm run build
if errorlevel 1 (
  echo The build failed.
  pause
  exit /b 1
)
echo [%DATE% %TIME%] starting the bot - leave this window open
call npm start 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath 'logs\bot.log' -Append"
echo.
echo [%DATE% %TIME%] the bot has stopped.
pause
