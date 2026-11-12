<#
Genera los WAV de prueba del dictado local con la voz de SAPI de Windows.
Se usan en server\voice\selftest.mjs. No hace falta ejecutarlo si los
fixtures ya están en el repo.

Uso:  .\server\voice\fixtures\generar.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$destino = Split-Path -Parent $MyInvocation.MyCommand.Path
$voces = (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices()

# Preferimos una voz en español; si no hay, seguimos con la que haya.
$vozEs = $voces | Where-Object { $_.VoiceInfo.Culture.Name -like 'es-*' } | Select-Object -First 1
$nombreVoz = if ($vozEs) { $vozEs.VoiceInfo.Name } else { $voces[0].VoiceInfo.Name }
Write-Host "Voz usada: $nombreVoz"

$frases = @(
    @{ fichero = 'voz-es-codigo.wav'; texto = 'El codigo secreto es NEXO SIETE' },
    @{ fichero = 'voz-es-larga.wav';  texto = 'Oye Nexo, manana a las nueve y media de la manana recuerdame llamar a Marta y enviar el informe trimestral de ventas.' }
)

foreach ($f in $frases) {
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SelectVoice($nombreVoz)
    $ruta = Join-Path $destino $f.fichero
    $s.SetOutputToWaveFile($ruta)
    $s.Speak($f.texto)
    $s.Dispose()
    Write-Host "Generado $ruta ($((Get-Item $ruta).Length) bytes)"
}
