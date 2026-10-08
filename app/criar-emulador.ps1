# Cria do zero o emulador Android da Avila: imagem enxuta, sem Google, com a marca na moldura.
# Uso: pwsh -File criar-emulador.ps1

$ErrorActionPreference = "Stop"

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$jdk = "C:\Program Files\Android\openjdk\jdk-21.0.8"
$avd = "avila_leve"
# aosp_atd: Android puro sem Google, com apps de sistema e animacoes retirados.
# E a imagem mais leve que o SDK oferece.
$imagem = "system-images;android-35;aosp_atd;x86_64"

$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk
$env:JAVA_HOME = $jdk

$sdkmanager = "$sdk\cmdline-tools\latest\bin\sdkmanager.bat"
$avdmanager = "$sdk\cmdline-tools\latest\bin\avdmanager.bat"

Write-Host "Baixando a imagem do sistema..."
"y" | & $sdkmanager $imagem "platforms;android-35" | Out-Null

Write-Host "Criando o AVD $avd..."
"no" | & $avdmanager create avd -n $avd -k $imagem -d "pixel_6" --force | Out-Null

# --- moldura com a marca ---
$skin = "$sdk\skins\avila"
New-Item -ItemType Directory -Force -Path $skin | Out-Null
$logo = "$PSScriptRoot\..\webmail\public\web-app-manifest-512x512.png"
python "$PSScriptRoot\gerar-skin.py" $logo $skin

# --- ajustes de leveza ---
$config = "$env:USERPROFILE\.android\avd\$avd.avd\config.ini"
python "$PSScriptRoot\ajustar-avd.py" $config $skin

Write-Host "Pronto. Suba com: pwsh -File emulador.ps1"
