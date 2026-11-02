@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="" (
  echo.
  echo Drag one or more HTML files onto:
  echo   Convert_HTML_to_PDF.cmd
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\puppeteer-core" (
  echo.
  echo The utility has not been installed yet.
  echo Run INSTALL.cmd once, then try again.
  echo.
  pause
  exit /b 1
)

node html2output.mjs --pdf-exact %*
if errorlevel 1 (
  echo.
  echo PDF conversion failed.
  echo.
  pause
  exit /b 1
)

echo.
echo PDF conversion complete.
echo.
pause
