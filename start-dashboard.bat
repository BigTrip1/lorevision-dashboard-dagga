@echo off
TITLE LORE Dashboard Server
echo ======================================
echo      LORE DASHBOARD SERVER
echo ======================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Get port from .env file or use default
set PORT=3001
for /f "tokens=1,2 delims==" %%a in (.env) do (
    if "%%a"=="PORT" set PORT=%%b
)
echo Using PORT=%PORT%

REM Check if port is already in use
netstat -ano | findstr ":%PORT% .*LISTENING" > nul
if %ERRORLEVEL% equ 0 (
    echo.
    echo WARNING: Port %PORT% is already in use.
    echo.
    echo Options:
    echo 1) Kill the existing process using port %PORT%
    echo 2) Change the PORT in the .env file
    echo 3) Start the server on a different port
    echo.
    
    set /p CHOICE="Enter choice (1-3): "
    
    if "%CHOICE%"=="1" (
        for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% .*LISTENING"') do (
            echo Killing process with PID: %%p
            taskkill /F /PID %%p
            if %ERRORLEVEL% equ 0 (
                echo Process killed successfully.
            ) else (
                echo Failed to kill process. Try running as Administrator.
                pause
                exit /b 1
            )
        )
    ) else if "%CHOICE%"=="2" (
        echo Please edit the .env file and change the PORT value.
        start notepad .env
        pause
        exit /b 0
    ) else if "%CHOICE%"=="3" (
        set /p NEW_PORT="Enter new port number: "
        set PORT=%NEW_PORT%
    ) else (
        echo Invalid choice.
        pause
        exit /b 1
    )
)

REM Install dependencies
echo Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)

REM Start the server
echo.
echo Starting LORE Dashboard server...
echo The dashboard will be available at http://localhost:%PORT%
echo.
echo Press Ctrl+C to stop the server
echo.

set NODE_OPTIONS=--no-warnings
set PORT=%PORT%
node index.js

if %ERRORLEVEL% neq 0 (
    echo.
    echo Server stopped with an error (code %ERRORLEVEL%).
)

echo.
echo Server stopped.
pause 