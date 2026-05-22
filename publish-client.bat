@echo off
setlocal
title BrulunaMS Launcher - Publish Client Patch

cd /d "%~dp0"

node scripts\prepare-release-client.js
if errorlevel 1 (
  echo Release client preparation failed.
  pause
  exit /b 1
)

node scripts\publisher.js --client "C:\Maplestory\V62\client\Release-Version\Ai-place-here"

if errorlevel 1 (
  echo Publish failed.
) else (
  echo Publish complete.
)
pause
