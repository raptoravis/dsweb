# Run backend and frontend together on non-default ports.
$ErrorActionPreference = "Stop"

# Non-default ports to avoid the usual dev ports (3000/3001/5000/5173/8000/8080).
$backendPort  = if ($env:RUN_ALL_BACKEND_PORT)  { $env:RUN_ALL_BACKEND_PORT }  else { "4120" }
$frontendPort = if ($env:RUN_ALL_FRONTEND_PORT) { $env:RUN_ALL_FRONTEND_PORT } else { "5180" }

$env:PORT = $backendPort
$env:VITE_DEV_PORT = $frontendPort
$env:VITE_BACKEND_PORT = $backendPort

# Install dependencies once if missing or out of date.
$needInstall = -not (Test-Path -LiteralPath "node_modules")
if (-not $needInstall) {
    $lock = Get-Item -LiteralPath "package-lock.json" -ErrorAction SilentlyContinue
    $nm   = Get-Item -LiteralPath "node_modules"
    if ($lock -and $lock.LastWriteTime -gt $nm.LastWriteTime) { $needInstall = $true }
}
if ($needInstall) {
    Write-Host "[run-all] installing dependencies..."
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "[run-all] backend  -> http://localhost:$backendPort"
Write-Host "[run-all] frontend -> http://localhost:$frontendPort"

function Stop-Tree([int]$Id) {
    if (Get-Process -Id $Id -ErrorAction SilentlyContinue) {
        taskkill /PID $Id /T /F *> $null
    }
}

# npm resolves via cmd.exe so the .cmd shim works; /T lets taskkill reap the
# whole node/tsx/vite tree on shutdown.
$backend  = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev --workspace backend"  -PassThru -NoNewWindow
$frontend = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev --workspace frontend" -PassThru -NoNewWindow

try {
    while ($true) {
        Start-Sleep -Milliseconds 500
        $backendAlive  = [bool](Get-Process -Id $backend.Id  -ErrorAction SilentlyContinue)
        $frontendAlive = [bool](Get-Process -Id $frontend.Id -ErrorAction SilentlyContinue)
        if (-not $backendAlive -or -not $frontendAlive) { break }
    }
}
finally {
    Stop-Tree $backend.Id
    Stop-Tree $frontend.Id
}
