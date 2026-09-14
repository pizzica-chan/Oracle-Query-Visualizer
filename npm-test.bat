@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo OracleDB-QueryParser: npm test
echo.

call npm test
set EXIT_CODE=%ERRORLEVEL%

if %EXIT_CODE% neq 0 (
  echo.
  echo テスト失敗 ^(exit code: %EXIT_CODE%^)
) else (
  echo.
  echo テスト成功
)

exit /b %EXIT_CODE%
