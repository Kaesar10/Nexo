<#
.SYNOPSIS
    Instala el dictado por voz 100% local (Whisper ONNX) para el puente Nexo.

.DESCRIPTION
    Idempotente y sin permisos de administrador:
      1. Comprueba Node (>= 22).
      2. Instala las dependencias aisladas de server\voice (npm install).
      3. Descarga el modelo Whisper a server\voice\models (desde hf-mirror.com).
      4. Verifica que el motor responde (voiceStatus).

    A partir de ahí la transcripción funciona sin internet: el modelo está en
    disco y el worker arranca con la descarga remota desactivada.

.PARAMETER Modelo
    Repo de Hugging Face del modelo. Por defecto Xenova/whisper-base (~76 MB).
    Opción más precisa (y lenta): Xenova/whisper-small (~316 MB).

.PARAMETER Force
    Vuelve a descargar el modelo aunque ya esté instalado.

.PARAMETER Probar
    Ejecuta el selftest completo (transcribe audio real de SAPI) al terminar.

.EXAMPLE
    .\scripts\instalar-voz.ps1
    .\scripts\instalar-voz.ps1 -Modelo Xenova/whisper-small -Probar
    .\scripts\instalar-voz.ps1 -Force
#>
[CmdletBinding()]
param(
    [string]$Modelo = 'Xenova/whisper-base',
    [switch]$Force,
    [switch]$Probar
)

$ErrorActionPreference = 'Stop'

function Paso($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "[ok] $msg" -ForegroundColor Green }
function Aviso($msg) { Write-Host "[aviso] $msg" -ForegroundColor Yellow }
function Fallo($msg) { Write-Host "[error] $msg" -ForegroundColor Red }

$raiz = Split-Path -Parent $PSScriptRoot  # scripts\ -> raíz del proyecto
$voz = Join-Path $raiz 'server\voice'
$modelos = Join-Path $voz 'models'
$marcador = Join-Path $modelos '.installed.json'

try {
    Paso '1/4 Comprobando requisitos'
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'No se encontró Node.js. Instala Node 22 o superior y vuelve a ejecutar: https://nodejs.org'
    }
    $nodeVersion = (node -v).Trim()
    $nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 22) { throw "Node $nodeVersion es demasiado antiguo: hace falta Node 22 o superior." }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'No se encontró npm (viene con Node.js).' }
    Ok "Node $nodeVersion y npm $((npm -v).Trim())"

    if (-not (Test-Path $voz)) { throw "No existe $voz. ¿Estás ejecutando el script desde el repo de Nexo?" }
    if (-not (Test-Path (Join-Path $voz 'worker.mjs'))) { throw "Falta $voz\worker.mjs (paquete de voz incompleto)." }

    Paso '2/4 Instalando dependencias del motor (server\voice)'
    $depsOk = Test-Path (Join-Path $voz 'node_modules\@huggingface\transformers\package.json')
    if ($depsOk) {
        Ok 'Dependencias ya instaladas (se omite npm install).'
    } else {
        Push-Location $voz
        try {
            Write-Host 'Ejecutando npm install...'
            npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm install terminó con código $LASTEXITCODE." }
        } finally { Pop-Location }
        Ok 'Dependencias instaladas.'
    }

    Paso '3/4 Descargando el modelo de voz'
    New-Item -ItemType Directory -Force -Path $modelos | Out-Null
    Push-Location $voz
    try {
        $argsModelo = @('install.mjs', '--model', $Modelo)
        if ($Force) { $argsModelo += '--force' }
        node @argsModelo
        if ($LASTEXITCODE -ne 0) { throw "La descarga del modelo terminó con código $LASTEXITCODE." }
    } finally { Pop-Location }
    Ok 'Modelo preparado en server\voice\models.'

    Paso '4/4 Verificando el motor'
    Push-Location $voz
    try {
        node -e "import('../src/transcribe.js').then(m => m.voiceStatus()).then(s => { console.log(JSON.stringify(s, null, 2)); if (!s.available) process.exit(1); })"
        if ($LASTEXITCODE -ne 0) { throw 'voiceStatus() dice que el motor no está disponible.' }
    } finally { Pop-Location }

    if (Test-Path $marcador) {
        $m = Get-Content $marcador -Raw | ConvertFrom-Json
        $mb = [math]::Round($m.bytes / 1MB, 1)
        Write-Host "`nModelo: $($m.model)  ·  $mb MB  ·  dtype $($m.dtype)  ·  instalado $($m.installedAt)" -ForegroundColor Cyan
    }

    if ($Probar) {
        Paso 'Prueba extra: selftest con audio real'
        Push-Location $voz
        try {
            node selftest.mjs
            if ($LASTEXITCODE -ne 0) { throw 'El selftest falló.' }
        } finally { Pop-Location }
    }

    Write-Host "`nListo. El dictado local está operativo (no necesita internet)." -ForegroundColor Green
    Write-Host 'Para probarlo rapido:  cd server\voice; node selftest.mjs'
    Write-Host 'Uso desde el puente:   import { voiceStatus, transcribeWav } from "./server/src/transcribe.js"'
    exit 0
}
catch {
    Fallo $_.Exception.Message
    Write-Host 'Si la descarga falló por red, vuelve a ejecutar el script: es idempotente y reanuda lo que falta.' -ForegroundColor Yellow
    exit 1
}
