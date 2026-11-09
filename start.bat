@echo off
title Chips.gg Stream Overlay Hub
echo ========================================================
echo        Starting Chips.gg Stream Tracker Server
echo ========================================================
echo.
cd /d "%~dp0"

echo Launching overlay server on http://localhost:3300 ...
start "" http://localhost:3300/control
node server.js

pause
