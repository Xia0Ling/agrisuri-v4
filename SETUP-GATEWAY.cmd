@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  AgriSuri - deploy the inference gateway.
rem
rem  Double-click this file. It does three things:
rem    1. finds the Supabase command line tool
rem    2. opens a browser so you can sign in to Supabase
rem    3. uploads the small server function that holds the Roboflow key
rem
rem  You only need this once, and only for the GitHub deployment.
rem  Running the app locally does not need it.
rem ---------------------------------------------------------------------------

set "PATH=%PATH%;C:\Users\Admin\.workbuddy-ai\binaries\node\versions\22.22.2-6"

echo.
echo  ==========================================================
echo   AgriSuri - deploy the inference gateway
echo  ==========================================================
echo.
echo   A browser window will open. Sign in to Supabase and
echo   click "Authorize". Then come back to this window.
echo.
pause

call supabase.cmd login
if errorlevel 1 (
  echo.
  echo   Login failed or was cancelled. Nothing was changed.
  echo.
  pause
  exit /b 1
)

echo.
echo   Login OK. Uploading the function...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\deploy-gateway.ps1"

echo.
echo  ==========================================================
echo   Finished. If you saw "gateway is live", it worked.
echo.
echo   Next steps for GitHub:
echo     git config user.name  "Your Name"
echo     git config user.email "you@example.com"
echo     git commit -m "AgriSuri v4"
echo.
echo   Then create an empty repo on github.com and run:
echo     git remote add origin https://github.com/USERNAME/REPO.git
echo     git push -u origin main
echo.
echo   Finally: repo Settings - Pages - Source: GitHub Actions
echo  ==========================================================
echo.
pause
