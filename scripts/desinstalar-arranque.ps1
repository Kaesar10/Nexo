# Quita el arranque automático instalado por instalar-arranque.ps1
$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$vbsPath = Join-Path $startup 'Nexo DSH.vbs'
if (Test-Path $vbsPath) {
  Remove-Item $vbsPath -Force
  Write-Host 'Arranque automatico desinstalado.' -ForegroundColor Green
} else {
  Write-Host 'No habia arranque automatico instalado.'
}
