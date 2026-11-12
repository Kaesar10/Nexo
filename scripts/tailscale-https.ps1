# Publica Nexo con HTTPS valido dentro de tu tailnet (Tailscale).
#
# Por que: los navegadores solo permiten INSTALAR una PWA desde una URL HTTPS
# (o localhost). Con esto obtienes https://<tu-equipo>.<tailnet>.ts.net:8443
# con certificado valido, accesible desde tus dispositivos con Tailscale, incluso
# fuera de casa, y sin abrir nada a Internet.
param(
  [ValidateSet('on', 'off', 'status')]
  [string]$Action = 'on',
  [int]$HttpsPort = 8443,
  [int]$LocalPort = 8790
)
$ErrorActionPreference = 'Stop'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path $ts)) {
  $ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
}
if (-not $ts) {
  Write-Host 'No encuentro Tailscale. Instalalo desde https://tailscale.com/download' -ForegroundColor Red
  exit 1
}

switch ($Action) {
  'status' {
    & $ts serve status
    return
  }
  'off' {
    & $ts serve "--https=$HttpsPort" off 2>&1 | Out-Host
    Write-Host "HTTPS:$HttpsPort desactivado." -ForegroundColor Yellow
    return
  }
  default {
    try {
      & $ts serve --bg "--https=$HttpsPort" $LocalPort 2>&1 | Out-Host
    } catch {
      Write-Host ''
      Write-Host 'No se pudo activar. Comprueba que:' -ForegroundColor Yellow
      Write-Host '  · Tailscale esta conectado (tailscale status)'
      Write-Host '  · HTTPS/MagicDNS esta activado en el panel de Tailscale'
      Write-Host '  · el puerto 8443 no lo usa otra cosa'
      exit 1
    }
    $dns = (& $ts status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
    Write-Host ''
    Write-Host "  Abre en el movil:  https://${dns}:$HttpsPort" -ForegroundColor Green
    Write-Host '  (el movil debe tener Tailscale activo con la misma cuenta)'
    Write-Host ''
    Write-Host '  En Chrome: menu > Instalar aplicacion. En iPhone: Compartir > Añadir a pantalla de inicio.'
  }
}
