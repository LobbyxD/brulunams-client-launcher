@echo off
setlocal
title BrulunaMS Launcher - Public Patch Server

cd /d "%~dp0"

echo Public URL: http://46.117.116.14:1717

node scripts\server.js --public "C:\Maplestory\V62\client\Release-Version\Ai-place-here\.patch\public" --host 0.0.0.0 --port 1717

echo Patch server stopped.
pause
