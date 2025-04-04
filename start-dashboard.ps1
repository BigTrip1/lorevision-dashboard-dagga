# LoreVision Dashboard PowerShell Startup Script
Write-Host "Starting LoreVision Dashboard..." -ForegroundColor Cyan

# Stop any existing node processes if needed
try {
    $running = Get-Process -Name "node" -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "Stopping existing Node.js processes..." -ForegroundColor Yellow
        Stop-Process -Name "node" -Force
        Start-Sleep -Seconds 2
        Write-Host "Existing Node.js processes stopped" -ForegroundColor Green
    } else {
        Write-Host "No Node.js processes were running" -ForegroundColor Green
    }
} catch {
    Write-Host "Error checking for running Node.js processes: $_" -ForegroundColor Red
}

# Make sure we're in the correct directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Start the server with increased memory
Write-Host "Starting server with 4GB memory limit..." -ForegroundColor Cyan
try {
    node --max-old-space-size=4096 index.js
} catch {
    Write-Host "Error starting server: $_" -ForegroundColor Red
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
} 