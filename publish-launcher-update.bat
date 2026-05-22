@echo off
setlocal
title BrulunaMS Launcher - Publish Launcher Update

cd /d "%~dp0"

set "OUT=C:\Maplestory\V62\client\Release-Version\Ai-place-here\.patch\public\launcher"
set "LEGACY_OUT=C:\Maplestory\V62\client\MapleStory\.patch\public\launcher"
set "LOCAL_EXE=%~dp0dist\win-unpacked\BrulunaMS Launcher.exe"

echo Closing local dist launcher if it is running...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$target = [IO.Path]::GetFullPath('%LOCAL_EXE%'); Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 2 /nobreak >nul

if exist "dist\win-unpacked\.launcher" (
  rmdir /s /q "dist\win-unpacked\.launcher"
)

call cmd /c npm run dist:win:installer
if errorlevel 1 (
  echo Launcher build failed.
  pause
  exit /b 1
)

if not exist "%OUT%" mkdir "%OUT%"
del /q "%OUT%\latest.yml" "%OUT%\*.exe" "%OUT%\*.blockmap" 2>nul

copy /y "dist\latest.yml" "%OUT%\" >nul
copy /y "dist\BrulunaMS Launcher Setup *.exe" "%OUT%\" >nul
copy /y "dist\BrulunaMS Launcher Setup *.exe.blockmap" "%OUT%\" >nul

if not exist "%LEGACY_OUT%" mkdir "%LEGACY_OUT%"
del /q "%LEGACY_OUT%\latest.yml" "%LEGACY_OUT%\*.exe" "%LEGACY_OUT%\*.blockmap" 2>nul

copy /y "dist\latest.yml" "%LEGACY_OUT%\" >nul
copy /y "dist\BrulunaMS Launcher Setup *.exe" "%LEGACY_OUT%\" >nul
copy /y "dist\BrulunaMS Launcher Setup *.exe.blockmap" "%LEGACY_OUT%\" >nul

echo Launcher update published.
pause
