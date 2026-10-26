param(
  [string]$Version = "0.71.1"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "bin\frp"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
$name = "frp_${Version}_windows_${arch}"
$url = "https://github.com/fatedier/frp/releases/download/v$Version/$name.zip"
$zip = Join-Path $env:TEMP "$name.zip"
$tmp = Join-Path $env:TEMP $name

Write-Host "Descargando $url"
Invoke-WebRequest -Uri $url -OutFile $zip

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }

try {
  Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
} catch {
  Write-Host ""
  Write-Host "No se pudo extraer el archivo." -ForegroundColor Yellow
  Write-Host "Windows Defender suele marcar los binarios de frp como falso positivo" -ForegroundColor Yellow
  Write-Host "(deteccion generica 'Trojan:Win32/Kepavll' / 'Wacatac'). Opciones:" -ForegroundColor Yellow
  Write-Host "  1) Anade una exclusion de carpeta en Seguridad de Windows >" -ForegroundColor Yellow
  Write-Host "     Proteccion antivirus > Administrar configuracion > Exclusiones" -ForegroundColor Yellow
  Write-Host "     y vuelve a ejecutar este script." -ForegroundColor Yellow
  Write-Host "  2) Instala frp en el servidor Linux con scripts/install-frp.sh." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Detalle: $($_.Exception.Message)" -ForegroundColor DarkGray
  exit 1
}

Copy-Item (Join-Path $tmp "frpc.exe") $bin -Force
Copy-Item (Join-Path $tmp "frps.exe") $bin -Force

Write-Host "Instalado en $bin"
& (Join-Path $bin "frpc.exe") -v
