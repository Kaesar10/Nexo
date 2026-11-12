# Instala Nexo para que arranque solo al iniciar sesión en Windows.
# Crea un acceso directo oculto en la carpeta Inicio del usuario. No requiere admin.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$serverEntry = Join-Path $root 'server\src\index.js'
$logFile = Join-Path $root 'server\data\nexo.log'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $node) {
  Write-Host 'No encuentro Node.js en el PATH. Instalalo primero.' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $serverEntry)) {
  Write-Host "No encuentro $serverEntry" -ForegroundColor Red
  exit 1
}

$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup 'Nexo DSH.vbs'
$dataDir = Join-Path $root 'server\data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$vbs = @"
Set shell = CreateObject("WScript.Shell")
cmd = "cmd /c cd /d ""$root"" && ""$node"" ""$serverEntry"" >> ""$logFile"" 2>&1"
shell.Run cmd, 0, False
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

Write-Host ''
Write-Host '  Nexo arrancara solo al iniciar sesion.' -ForegroundColor Green
Write-Host "  Lanzador: $vbsPath"
Write-Host "  Registro:  $logFile"
Write-Host ''
Write-Host '  Para arrancarlo ahora sin reiniciar, ejecuta scripts\iniciar.cmd'
Write-Host '  Para desinstalarlo: scripts\desinstalar-arranque.ps1'
