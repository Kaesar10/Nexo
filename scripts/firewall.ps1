# Abre el puerto de Nexo en el Firewall de Windows (necesita permiso de administrador).
# Sin esto, el movil puede no ver el PC desde la misma WiFi.
$ErrorActionPreference = 'Stop'
$port = 8790
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host ''
  Write-Host '  Necesita permisos de administrador.' -ForegroundColor Yellow
  Write-Host '  Cierra esta ventana, abre PowerShell como administrador y ejecuta:' -ForegroundColor Yellow
  Write-Host ''
  Write-Host "    netsh advfirewall firewall add rule name=`"Nexo DSH`" dir=in action=allow protocol=TCP localport=$port" -ForegroundColor Cyan
  Write-Host ''
  exit 1
}

$existing = netsh advfirewall firewall show rule name="Nexo DSH" 2>$null
if ($LASTEXITCODE -eq 0 -and $existing -match 'Nexo DSH') {
  Write-Host "La regla 'Nexo DSH' ya existe para el puerto $port." -ForegroundColor Green
  exit 0
}

netsh advfirewall firewall add rule name="Nexo DSH" dir=in action=allow protocol=TCP localport=$port | Out-Null
Write-Host "Regla creada: puerto $port abierto para la red local." -ForegroundColor Green
Write-Host 'Recuerda: no expongas este puerto directamente a Internet. Usa Tailscale o tunel-cloudflare.ps1.'
