@echo off
REM Launch Notes Intel (standalone Electron app).
REM Double-click this file, or run it from any console.
cd /d "%~dp0"
echo Starting Notes Intel...
call npm start
if errorlevel 1 (
  echo.
  echo Failed to start. If this is a fresh checkout, run: npm install
  pause
)
