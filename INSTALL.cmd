@echo off
setlocal
cd /d "%~dp0"

echo.
echo HTML WYSIWYG PDF / PNG Utility installer
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found in PATH.
  echo.
  pause
  exit /b 1
)

echo Detected versions:
node --version
call npm --version
echo.

echo Removing any previous dependency install...
if exist "node_modules" rmdir /s /q "node_modules"
if exist "package-lock.json" del /q "package-lock.json"
echo.

echo Installing puppeteer-core 19.11.1 for Node 14...
call npm install --only=prod
if errorlevel 1 (
  echo.
  echo ERROR: npm install failed.
  echo.
  pause
  exit /b 1
)

echo.
if not exist "node_modules\puppeteer-core" (
  echo ERROR: Installation finished but puppeteer-core was not found.
  echo.
  pause
  exit /b 1
)

echo Installation completed successfully.
echo.
echo Recommended for Word:
echo   Convert_HTML_to_600DPI_PNG.cmd
echo.
pause
