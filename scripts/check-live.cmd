@echo off
rem Builds the bot and runs the read-only live checks against the club site (login, wallet, free slots, status).
rem The result is shown here AND saved to logs\check-live.txt (it contains no passwords or tokens).
setlocal EnableExtensions
cd /d "%~dp0.."
if not exist ".env" (
  echo .env not found: copy .env.example to .env and fill it in first.
  pause
  exit /b 1
)
if not exist logs mkdir logs
set "LOG=logs\check-live.txt"
> "%LOG%" echo ==== %DATE% %TIME% check-live ====
echo Installing and building, please wait...
call npm install --no-audit --no-fund >> "%LOG%" 2>&1
if errorlevel 1 goto :fail_install
call npm run build >> "%LOG%" 2>&1
if errorlevel 1 goto :fail_build
for /f %%d in ('powershell -NoProfile -Command "(Get-Date).AddDays(6).ToString('yyyy-MM-dd')"') do set "DAY=%%d"
>> "%LOG%" echo.
>> "%LOG%" echo ---- login-check
call npm run cli -- login-check >> "%LOG%" 2>&1
>> "%LOG%" echo (exit code %ERRORLEVEL%)
>> "%LOG%" echo.
>> "%LOG%" echo ---- wallet
call npm run cli -- wallet >> "%LOG%" 2>&1
>> "%LOG%" echo (exit code %ERRORLEVEL%)
>> "%LOG%" echo.
>> "%LOG%" echo ---- slots %DAY%
call npm run cli -- slots %DAY% >> "%LOG%" 2>&1
>> "%LOG%" echo (exit code %ERRORLEVEL%)
>> "%LOG%" echo.
>> "%LOG%" echo ---- status
call npm run cli -- status >> "%LOG%" 2>&1
>> "%LOG%" echo (exit code %ERRORLEVEL%)
goto :done
:fail_install
echo npm install failed, see %LOG%
goto :done
:fail_build
echo The build failed, see %LOG%
:done
echo.
type "%LOG%"
echo.
echo Saved to %LOG% - you do not need to copy anything, just tell Claude it is done.
pause
