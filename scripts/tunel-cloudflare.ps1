# Abre un tunel publico temporal (Cloudflare Quick Tunnel) hacia Nexo.
# Util para usar el movil fuera de casa sin Tailscale. La URL cambia cada vez
# que arrancas el tunel; cualquiera con la URL llega al PIN de emparejamiento.
$ErrorActionPreference = 'Stop'
$port = 8790
$candidates = @(
  "$env:USERPROFILE\.dsh\dsh-pocket\bin\cloudflared.exe",
  (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $candidates) {
  Write-Host 'No encuentro cloudflared.exe.' -ForegroundColor Red
  Write-Host 'Descargalo en https://github.com/cloudflare/cloudflared/releases y ponlo en el PATH.'
  exit 1
}
$cloudflared = $candidates[0]

Write-Host ''
Write-Host '  Abriendo tunel publico hacia http://127.0.0.1:' -NoNewline
Write-Host $port -ForegroundColor Cyan
Write-Host '  La URL https://...trycloudflare.com aparecera abajo. Ctrl+C para cerrar.' -ForegroundColor DarkGray
Write-Host ''

& $cloudflared tunnel --url "http://127.0.0.1:$port" --no-autoupdate
