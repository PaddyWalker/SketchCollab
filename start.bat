@echo off
rem Starts SketchCollab: a small local server (minimised window) and the app in Chrome.
cd /d "%~dp0"
start "SketchCollab (close to stop)" /min python server.py
timeout /t 2 /nobreak >nul
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://localhost:8765/
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:8765/
) else (
  start "" http://localhost:8765/
)
