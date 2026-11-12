@echo off
setlocal
cd /d "%~dp0.."
title Nexo - puente DSH
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   No encontre Node.js en el PATH.
  echo   Instala Node 22 o superior desde https://nodejs.org
  echo.
  pause
  exit /b 1
)
node server\src\index.js
echo.
echo   El puente se ha detenido.
pause
