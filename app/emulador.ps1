# Sobe o emulador Android da Avila (AVD avila_leve).
# Uso: pwsh -File emulador.ps1 [-Limpar] [-SemJanela]

param(
  [switch]$Limpar,    # apaga o estado do aparelho e comeca do zero
  [switch]$SemJanela  # roda sem interface, so para teste automatizado
)

$ErrorActionPreference = "Stop"

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$jdk = "C:\Program Files\Android\openjdk\jdk-21.0.8"
$avd = "avila_leve"

# o emulador le estas variaveis para achar a imagem do sistema
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk
$env:JAVA_HOME = $jdk

$emulador = "$sdk\emulator\emulator.exe"
$adb = "$sdk\platform-tools\adb.exe"
$pasta = "$env:USERPROFILE\.android\avd\$avd.avd"

if (-not (Test-Path $emulador)) { throw "Emulador nao encontrado em $emulador" }
if (-not (Test-Path $pasta)) { throw "AVD $avd nao existe. Rode criar-emulador.ps1" }

# instancia anterior travada deixa lock e impede subir de novo
Get-Process qemu-system-x86_64* -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Get-ChildItem $pasta -Filter "*.lock" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

$argumentos = @("-avd", $avd, "-no-boot-anim", "-gpu", "swiftshader_indirect")
if ($Limpar) { $argumentos += "-wipe-data" }
if ($SemJanela) { $argumentos += "-no-window" }

Write-Host "Subindo $avd..."
Start-Process -FilePath $emulador -ArgumentList $argumentos -WindowStyle Normal

# o primeiro boot passa de dois minutos; os seguintes usam snapshot e sao rapidos
Write-Host "Esperando o Android terminar de subir (pode levar alguns minutos no primeiro boot)..."
$limite = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $limite) {
  $pronto = (& $adb -s emulator-5554 shell getprop sys.boot_completed 2>$null) -replace "\s", ""
  if ($pronto -eq "1") {
    Write-Host "Pronto. Emulador no ar em emulator-5554."
    exit 0
  }
  Start-Sleep -Seconds 5
}

throw "O emulador nao terminou de subir em 10 minutos. Veja: adb logcat"
