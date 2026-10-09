@echo off
title ChainBreaker server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install it from https://nodejs.org  then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the ChainBreaker server...
echo   Leave this window open while you use the app.
echo.

node server.js

echo.
echo   The server has stopped.
pause
