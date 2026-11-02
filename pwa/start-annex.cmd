@echo off
rem Serves Annex on http://localhost:27180 so Chrome/Edge can install it as an app.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-annex.ps1"
if errorlevel 1 (
  echo PowerShell server failed, trying Python...
  start "" http://localhost:27180/
  py -m http.server 27180 --bind 127.0.0.1 || python -m http.server 27180 --bind 127.0.0.1
)
