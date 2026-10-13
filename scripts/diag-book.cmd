@echo off
rem REHEARSAL: books one court (20.10, Pista 9, 15:00) like the site does and cancels it at once (refund to the Monedero).
rem Stop the bot first. Output is saved to logs\diag-book.txt (no passwords, cookies or hashes).
setlocal EnableExtensions
cd /d "%~dp0.."
if not exist ".env" (
  echo .env not found.
  pause
  exit /b 1
)
if not exist logs mkdir logs
call npm run build > /dev/null 2>&1
node --env-file=.env scripts\diag-book.mjs > logs\diag-book.txt 2>&1
type logs\diag-book.txt
echo.
echo Saved to logs\diag-book.txt - just tell Claude it is done.
pause
