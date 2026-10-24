@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo JSON to PostgreSQL upload
echo Settings: start.ps1
echo Existing DB settings will be preserved.
echo.
python -u "%~dp0upload_json_to_db.py"
set "UPLOAD_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%UPLOAD_EXIT_CODE%"=="0" echo Upload failed. Read the error above before trying again.
if not "%~1"=="--no-pause" pause
exit /b %UPLOAD_EXIT_CODE%
