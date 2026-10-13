@echo off
rem Prints YOUR numeric Telegram user id: run this, then send any message to your bot.
rem Put the printed number into TELEGRAM_ALLOWED_USER_IDS in .env. Do not run it while the bot itself is running.
setlocal EnableExtensions
cd /d "%~dp0.."
if not exist ".env" (
  echo .env not found: copy .env.example to .env and fill it in first.
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  echo The build failed.
  pause
  exit /b 1
)
echo.
echo Now send any message to your bot in Telegram (it will not reply) ...
call npm run cli -- whoami-telegram
pause
