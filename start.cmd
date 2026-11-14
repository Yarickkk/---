@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Потрібно встановити Node.js 24 або новішу версію.
  pause
  exit /b 1
)
echo Запуск АІС готелю. Відкрийте http://localhost:3000
echo Для зупинки натисніть Ctrl+C.
node src/server.js
pause
