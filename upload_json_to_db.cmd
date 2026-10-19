@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo JSON to PostgreSQL upload
echo Settings: .env.postgres
echo Existing DB settings will be preserved.
echo.
python -u scripts\manage_db.py upload
set "UPLOAD_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%UPLOAD_EXIT_CODE%"=="0" echo Upload failed. Read the error above before trying again.
if not "%~1"=="--no-pause" pause
exit /b %UPLOAD_EXIT_CODE%
