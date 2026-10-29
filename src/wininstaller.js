import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Instalador .exe (NSIS) para clientes Windows.
 *
 * El panel genera un .exe distinto por servidor con su token y su frpc.toml
 * embebidos. El .exe es un envoltorio silencioso: extrae setup.ps1 y lo ejecuta
 * oculto, así que al hacer doble clic solo se ve el aviso de UAC y un mensaje
 * final. El servicio en sí (tarea programada 'FRPC-EDS', usuario SYSTEM) corre
 * en la sesión 0, sin ninguna ventana.
 *
 * Compilación: `makensis` (paquete `nsis`, disponible también en Linux).
 * Si no está instalado, /api/nodes/:id/install.exe responde 503 y el
 * instalador .ps1 sigue funcionando.
 */

export const FRP_VERSION = "0.71.1";
export const WIN_TASK_NAME = "FRPC-EDS";

const MAKENSIS = process.env.MAKENSIS || "makensis";

let available;
/** ¿Se puede compilar el .exe en este host? (se comprueba una sola vez). */
export function exeInstallerAvailable() {
  if (available === undefined) {
    try {
      const probe = spawnSync(MAKENSIS, ["-VERSION"], { encoding: "utf8", timeout: 8000 });
      available = probe.status === 0;
    } catch {
      available = false;
    }
    if (!available) {
      console.warn(
        "[installer] makensis no disponible: /install.exe responderá 503. " +
          "Instala NSIS (apt-get install -y --no-install-recommends nsis).",
      );
    }
  }
  return available;
}

/* ------------------------------------------------------------------ */
/* Piezas de PowerShell compartidas por .exe y .ps1                    */
/* ------------------------------------------------------------------ */

function psSingleQuote(value) {
  return String(value ?? "").replace(/'/g, "''");
}

/** Descarga frpc.exe si falta (mismo origen que usa el instalador Linux). */
function downloadBlock() {
  return `$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$zipName = "frp_\${Version}_windows_$arch"

if (-not (Test-Path -LiteralPath $Exe)) {
  Write-Output "Descargando frp $Version ($arch)..."
  $zip = Join-Path $env:TEMP "$zipName.zip"
  try {
    Invoke-WebRequest -Uri "https://github.com/fatedier/frp/releases/download/v$Version/$zipName.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $env:TEMP -Force
    Copy-Item -LiteralPath (Join-Path $env:TEMP "$zipName\\frpc.exe") -Destination $Exe -Force
  } catch {
    throw ("No se pudo instalar frpc: " + $_.Exception.Message + " | Windows Defender bloquea a menudo los binarios de frp (falso positivo). Anade una exclusion de carpeta en Seguridad de Windows > Proteccion antivirus > Exclusiones y vuelve a intentarlo.")
  } finally {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  }
  Write-Output "frpc instalado en $Exe"
} else {
  Write-Output "frpc ya presente en $Exe"
}`;
}

/** Bucle oculto: sincroniza frpc.toml con el panel y mantiene frpc vivo. */
function runScript(syncUrl) {
  return `$ErrorActionPreference = 'SilentlyContinue'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Dir 'frpc.exe'
$Cfg = Join-Path $Dir 'frpc.toml'
$New = Join-Path $Dir 'frpc.toml.new'
$Url = '${psSingleQuote(syncUrl)}'

function Get-Hash($p) {
  if (-not (Test-Path -LiteralPath $p)) { return '' }
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
}

function Start-Frpc {
  # CreateNoWindow + sin shell: ningun tipo de ventana, ni un parpadeo.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = '-c "' + $Cfg + '"'
  $psi.WorkingDirectory = $Dir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  return [System.Diagnostics.Process]::Start($psi)
}

$proc = $null
while ($true) {
  if ($Url -ne '') {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $New -UseBasicParsing -TimeoutSec 15
      if ((Get-Hash $New) -ne (Get-Hash $Cfg)) {
        if ($proc -and -not $proc.HasExited) { $proc.Kill(); Start-Sleep -Seconds 2 }
        Move-Item -Force -LiteralPath $New -Destination $Cfg
        $proc = $null
      } else {
        Remove-Item -Force -LiteralPath $New
      }
    } catch { }
  }
  if (-not $proc -or $proc.HasExited) { $proc = Start-Frpc }
  Start-Sleep -Seconds 30
}`;
}

/** Uninstall: para la tarea, borra el servicio y el proceso. */
function uninstallScript() {
  return `$ErrorActionPreference = 'SilentlyContinue'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Dir 'frpc.exe'

& schtasks /End /TN '${WIN_TASK_NAME}' | Out-Null
& schtasks /Delete /TN '${WIN_TASK_NAME}' /F | Out-Null
Get-Process -Name frpc | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
Start-Sleep -Milliseconds 800
exit 0`;
}

/** .cmd de ayuda (se abren solo cuando el usuario los ejecuta). */
function helperScripts() {
  const ps = "powershell -NoProfile -ExecutionPolicy Bypass -Command";
  return [
    {
      name: "estado.cmd",
      body: `@echo off
title FRPC-EDS - estado
${ps} "Get-ScheduledTask -TaskName '${WIN_TASK_NAME}' | Format-List TaskName,State; Get-ScheduledTaskInfo -TaskName '${WIN_TASK_NAME}' | Format-List LastRunTime,LastTaskResult,NextRunTime; Get-Process frpc -ErrorAction SilentlyContinue | Format-Table Id,ProcessName,StartTime -AutoSize"
echo.
echo (frpc debe aparecer arriba: si no, revisa el Visor de eventos)
pause
`,
    },
    {
      name: "iniciar.cmd",
      body: `@echo off
title FRPC-EDS - iniciar
${ps} "Start-ScheduledTask -TaskName '${WIN_TASK_NAME}'"
echo Servicio FRPC-EDS iniciado.
timeout /t 3 >nul
`,
    },
    {
      name: "detener.cmd",
      body: `@echo off
title FRPC-EDS - detener
${ps} "Stop-ScheduledTask -TaskName '${WIN_TASK_NAME}'; Get-Process frpc -ErrorAction SilentlyContinue | Where-Object { \$_.Path -like 'C:\\ProgramData\\FRPC-EDS\\*' } | Stop-Process -Force"
echo Servicio FRPC-EDS detenido.
timeout /t 3 >nul
`,
    },
  ];
}

/**
 * Cuerpo común (sin cabecera): instala frpc, escribe config y alta como servicio.
 * Lanza error (terminante) si algo falla.
 */
function coreScript({ node, toml, syncUrl }) {
  const files = helperScripts()
    .map(
      (f) => `[System.IO.File]::WriteAllText((Join-Path $Dir '${f.name}'), @'
${f.body.trimEnd()}
'@, $Utf8)`,
    )
    .join("\n\n");

  return `$Version = '${FRP_VERSION}'
$Task = '${WIN_TASK_NAME}'
$Dir = Join-Path $env:ProgramData 'FRPC-EDS'
$Exe = Join-Path $Dir 'frpc.exe'
$Cfg = Join-Path $Dir 'frpc.toml'
$Run = Join-Path $Dir 'run.ps1'
$PS = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# 0) Restos de una instalacion anterior (evita dos frpc a la vez)
& schtasks /End /TN $Task 2>$null | Out-Null
Get-Process -Name frpc -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $Exe -or $_.Path -like '*\\frpc-eds\\frpc.exe' } |
  Stop-Process -Force -ErrorAction SilentlyContinue

# 1) Binario
${downloadBlock()}

# 2) Configuracion (sin BOM: algunos parsers TOML fallan con el BOM)
$config = @'
${toml.trimEnd()}
'@
[System.IO.File]::WriteAllText($Cfg, $config, $Utf8)
Write-Output "Configuracion escrita en $Cfg"

# 3) Watchdog + auto-sincronizacion con el panel
$runBody = @'
${runScript(syncUrl).trimEnd()}
'@
[System.IO.File]::WriteAllText($Run, $runBody, $Utf8)

$unBody = @'
${uninstallScript().trimEnd()}
'@
[System.IO.File]::WriteAllText((Join-Path $Dir 'uninstall.ps1'), $unBody, $Utf8)

${files}

# 4) Solo SYSTEM y Administradores (el token vive en frpc.toml)
try {
  & icacls $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
} catch { }

# 5) Servicio: tarea programada como SYSTEM, al arrancar Windows
$action = New-ScheduledTaskAction -Execute $PS -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Run + '"')
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "Servicio '$Task' registrado (arranca con Windows, sin ventanas)"

# 6) Arrancar y comprobar
Start-ScheduledTask -TaskName $Task
$deadline = (Get-Date).AddSeconds(20)
$proc = $null
while (-not $proc -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $proc = Get-Process -Name frpc -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $Exe } |
    Select-Object -First 1
}
if (-not $proc) {
  throw "El servicio '$Task' se registro pero frpc no ha arrancado. Ejecuta estado.cmd o revisa el Visor de eventos."
}
Write-Output "OK - frpc en marcha (PID $($proc.Id)) bajo el servicio '$Task'"
Write-Output "Estado: $Dir\\estado.cmd"`;
}

/* ------------------------------------------------------------------ */
/* Instalador .ps1 (interactivo, con fallback en primer plano)         */
/* ------------------------------------------------------------------ */

export function buildPs1Installer(node, toml, syncUrl = "") {
  const safeName = String(node.name).replace(/["\r\n]/g, " ").slice(0, 60);
  return `# ------------------------------------------------------------------
# FRPC-EDS - instalacion del cliente para "${safeName}" (${node.id})
# Generado el ${new Date().toISOString()}
#
# Uso (PowerShell como Administrador):
#   powershell -ExecutionPolicy Bypass -File install-frpc.ps1
#
# Deja frpc corriendo en segundo plano como tarea programada '${WIN_TASK_NAME}'
# (usuario SYSTEM, al arrancar Windows). No abre ninguna ventana.
# ------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
${coreScript({ node, toml, syncUrl })}
  Write-Output ""
  Write-Output "Listo. frpc corre en segundo plano; para verlo: $env:ProgramData\\FRPC-EDS\\estado.cmd"
} catch {
  $dir = Join-Path $env:ProgramData 'FRPC-EDS'
  Write-Output ""
  Write-Output "No se pudo registrar el servicio: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Output "Iniciando frpc en primer plano (Ctrl+C para detener)..." -ForegroundColor Yellow
  & (Join-Path $dir 'frpc.exe') -c (Join-Path $dir 'frpc.toml')
}
`;
}

/* ------------------------------------------------------------------ */
/* Instalador .exe                                                     */
/* ------------------------------------------------------------------ */

/** Payload que ejecuta el .exe: el core, silencioso y con codigo de salida. */
export function buildExePayload(node, toml, syncUrl = "") {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

${coreScript({ node, toml, syncUrl })}

exit 0
`;
}

function sanitizeNsis(value, fallback = "cliente") {
  const clean = String(value ?? "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["$\\`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return clean || fallback;
}

export function buildNsiSource({ appName, version }) {
  return `Unicode true
Name "FRPC-EDS"
OutFile "installer.exe"
RequestExecutionLevel admin
SilentInstall silent
SilentUnInstall silent
ShowInstDetails nevershow
ShowUninstDetails nevershow
SetCompressor /SOLID lzma
CRCCheck on
XPStyle on

!include "LogicLib.nsh"

Var ExitCode
Var Output

Function .onInit
  InitPluginsDir
FunctionEnd

Function un.onInit
  SetShellVarContext all
  StrCpy $INSTDIR "$APPDATA\\FRPC-EDS"
FunctionEnd

Section "Instalar"
  SetShellVarContext all
  StrCpy $INSTDIR "$APPDATA\\FRPC-EDS"
  SetOutPath "$INSTDIR"
  File "setup.ps1"

  nsExec::ExecToStack '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\\setup.ps1"'
  Pop $ExitCode
  Pop $Output

  \${If} $ExitCode == "0"
    WriteUninstaller "$INSTDIR\\uninstall.exe"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "DisplayName" "${appName}"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "DisplayVersion" "${version}"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "Publisher" "FRPC-EDS"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "InstallLocation" "$INSTDIR"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "UninstallString" '"$INSTDIR\\uninstall.exe"'
    WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "NoModify" 1
    WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "NoRepair" 1

    MessageBox MB_ICONINFORMATION|MB_OK "FRPC-EDS instalado.$\\r$\\n$\\r$\\nfrpc ya esta corriendo en segundo plano (servicio 'FRPC-EDS', usuario SYSTEM). No abre ninguna ventana.$\\r$\\n$\\r$\\nEstado: $INSTDIR\\estado.cmd$\\r$\\nPanel: sigue creando tuneles, el cliente se sincroniza solo."
  \${Else}
    SetErrorLevel 1
    MessageBox MB_ICONSTOP|MB_OK "No se pudo instalar FRPC-EDS.$\\r$\\n$\\r$\\n$Output"
  \${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  StrCpy $INSTDIR "$APPDATA\\FRPC-EDS"

  nsExec::ExecToStack '"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\\uninstall.ps1"'
  Pop $ExitCode
  Pop $Output

  Delete "$INSTDIR\\setup.ps1"
  Delete "$INSTDIR\\uninstall.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS"
SectionEnd
`;
}

/**
 * Compila (o reutiliza de cache) el .exe del nodo.
 * @returns {string} ruta del .exe
 */
export function compileWinInstaller({ node, toml, syncUrl, cacheDir, appVersion = "0.1.0" }) {
  if (!exeInstallerAvailable()) {
    const err = new Error("El generador de .exe no esta disponible en el servidor (falta NSIS)");
    err.status = 503;
    throw err;
  }

  const payload = buildExePayload(node, toml, syncUrl);
  const hash = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 12);
  fs.mkdirSync(cacheDir, { recursive: true });

  const target = path.join(cacheDir, `install-${node.id}-${hash}.exe`);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "frpc-eds-nsis-"));
  try {
    // UTF-8 con BOM: PowerShell 5.1 lo interpreta bien.
    fs.writeFileSync(path.join(work, "setup.ps1"), `\uFEFF${payload}`, "utf8");
    fs.writeFileSync(
      path.join(work, "installer.nsi"),
      buildNsiSource({
        appName: sanitizeNsis(`FRPC-EDS (${node.name})`, "FRPC-EDS"),
        version: appVersion,
      }),
      "utf8",
    );

    const res = spawnSync(MAKENSIS, ["-V2", "-INPUTCHARSET", "UTF8", "installer.nsi"], {
      cwd: work,
      encoding: "utf8",
      timeout: 120000,
    });
    const built = path.join(work, "installer.exe");
    if (res.status !== 0 || !fs.existsSync(built)) {
      throw new Error(`makensis fallo: ${(res.stderr || res.stdout || "").slice(0, 800)}`);
    }

    const tmpTarget = `${target}.tmp`;
    fs.copyFileSync(built, tmpTarget);
    fs.renameSync(tmpTarget, target);

    // Limpia versiones anteriores de este nodo.
    for (const f of fs.readdirSync(cacheDir)) {
      if (f.startsWith(`install-${node.id}-`) && f !== path.basename(target)) {
        fs.rmSync(path.join(cacheDir, f), { force: true });
      }
    }
    return target;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
