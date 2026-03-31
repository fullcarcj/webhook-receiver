# Carga oauth-credentials.ps1 y prueba OAuth + API Mercado Libre (sin levantar server.js)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$credPath = Join-Path $root "oauth-credentials.ps1"
if (-not (Test-Path $credPath)) {
    Write-Host "No existe oauth-credentials.ps1" -ForegroundColor Yellow
    Write-Host "Copia oauth-credentials.ps1.example -> oauth-credentials.ps1"
    Write-Host "Rellena: Application ID, Secret Key, Refresh token"
    exit 1
}

. $credPath

Write-Host "`n--- Prueba de conexion OAuth (Mercado Libre) ---`n" -ForegroundColor Cyan
node "$root\test-conexion.js"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$port = if ($env:PORT) { $env:PORT } else { "3001" }
    Write-Host "`n--- Opcional: servidor en marcha? token enmascarado (puerto $port) ---`n" -ForegroundColor DarkGray
try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/oauth/token-status" -Method Get -TimeoutSec 3
    $r | ConvertTo-Json
} catch {
    Write-Host "(Servidor no escucha en $port - normal si no has ejecutado node server.js)" -ForegroundColor DarkGray
}
