# Arranca el servidor con Client ID y Secret cargados (misma app para todas las cuentas).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$cred = Join-Path $PSScriptRoot "oauth-credentials.ps1"
if (Test-Path $cred) {
    . $cred
} elseif (-not (Test-Path (Join-Path $PSScriptRoot "oauth-env.json"))) {
    Write-Host "Aviso: sin oauth-credentials.ps1 ni oauth-env.json - el servidor puede fallar OAuth" -ForegroundColor Yellow
}

node server.js
