@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  AgriSuri - push to GitHub.
rem
rem  BEFORE running this:
rem    1. Go to github.com and create a NEW EMPTY repository.
rem       Do not add a README, .gitignore or licence.
rem    2. Copy its URL, e.g. https://github.com/yourname/agrisuri.git
rem
rem  Then double-click this file and answer the three questions.
rem ---------------------------------------------------------------------------

echo.
echo  ==========================================================
echo   AgriSuri - push to GitHub
echo  ==========================================================
echo.
echo   Create an EMPTY repo on github.com first, then paste its
echo   URL below. If you have not created it yet, close this
echo   window, create the repo, and run this again.
echo.

set "GITNAME="
set "GITEMAIL="
set "REPOURL="

set /p GITNAME=Your name (e.g. Juan Dela Cruz):
if "%GITNAME%"=="" (
  echo.
  echo   No name given. Nothing was changed.
  pause
  exit /b 1
)

set /p GITEMAIL=Your email:
if "%GITEMAIL%"=="" (
  echo.
  echo   No email given. Nothing was changed.
  pause
  exit /b 1
)

set /p REPOURL=Repo URL (https://github.com/USER/REPO.git):
if "%REPOURL%"=="" (
  echo.
  echo   No repo URL given. Nothing was changed.
  pause
  exit /b 1
)

echo.
echo   Saving %GITNAME% ^<%GITEMAIL%^>
git config user.name "%GITNAME%"
git config user.email "%GITEMAIL%"

echo   Staging files...
git add -A
if errorlevel 1 (
  echo.
  echo   Could not stage files. Nothing was pushed.
  pause
  exit /b 1
)

echo   Committing...
git commit -m "AgriSuri v4: local pipeline verified, gateway deployed"
if errorlevel 1 (
  echo.
  echo   Nothing to commit, or the commit failed. Continuing to push.
)

echo   Setting the remote...
git remote remove origin >nul 2>&1
git remote add origin "%REPOURL%"
if errorlevel 1 (
  echo.
  echo   That repo URL was rejected. Check it and run this again.
  pause
  exit /b 1
)

echo   Pushing to GitHub...
echo.
echo   A sign-in window may appear. Approve it if it does.
echo.
git push -u origin main

rem Git Credential Manager can return a non-zero code even when the push
rem landed - it reports the helper's status, not git's. So do not trust
rem errorlevel here; compare what the remote actually has.
set "LOCAL="
set "REMOTE="
for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "LOCAL=%%i"
for /f "delims=" %%i in ('git rev-parse origin/main 2^>nul') do set "REMOTE=%%i"

if not "%LOCAL%"=="%REMOTE%" (
  echo.
  echo   Push did not complete. Usual causes:
  echo     - the repo already has commits ^(it must be empty^)
  echo     - the URL is wrong
  echo     - you cancelled the sign-in
  echo.
  pause
  exit /b 1
)

echo.
echo   Verified: origin/main is at %LOCAL:~0,7%
echo.
echo  ==========================================================
echo   Pushed. Two things left, both on github.com:
echo.
echo   1. Your repo - Settings - Pages - Source: GitHub Actions
echo   2. Your repo - Actions tab - wait for the green check
echo.
echo   The site URL appears in Settings - Pages when it is done.
echo  ==========================================================
echo.
pause
