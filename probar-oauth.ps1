# Prueba OAuth: arranca el servidor unos segundos y llama GET /oauth/status
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$credPath = Join-Path $root "oauth-credentials.ps1"
if (-not (Test-Path $credPath)) {
    Write-Host "Falta oauth-credentials.ps1 en esta carpeta." -ForegroundColor Yellow
    Write-Host "1) Copia oauth-credentials.ps1.example -> oauth-credentials.ps1"
    Write-Host "2) Edita oauth-credentials.ps1 con Client ID, Secret y Refresh token"
    Write-Host "3) Vuelve a ejecutar: .\probar-oauth.ps1"
    exit 1
}

. $credPath

$existing = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "El puerto 3001 esta en uso. Cierra el otro proceso o usa PORT distinto." -ForegroundColor Red
    exit 1
}

$proc = $null
try {
    $proc = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $root -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2

    Write-Host "GET http://127.0.0.1:3001/oauth/status" -ForegroundColor Cyan
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:3001/oauth/status" -Method Get
    $r | ConvertTo-Json -Depth 5
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}
