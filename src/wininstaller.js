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

# Borra temporales sin poder abortar la instalacion (la limpieza es prescindible).
function Remove-Quiet([string]$p) {
  try {
    if ($p -and (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch { }
}

if (-not (Test-Path -LiteralPath $Exe)) {
  Write-Output "Descargando frp $Version ($arch)..."
  $tmp = Join-Path $env:TEMP ('frpc-eds-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp "$zipName.zip"
  try {
    Invoke-WebRequest -Uri "https://github.com/fatedier/frp/releases/download/v$Version/$zipName.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    Copy-Item -LiteralPath (Join-Path $tmp "$zipName\\frpc.exe") -Destination $Exe -Force
  } catch {
    Remove-Quiet $tmp
    throw ("No se pudo instalar frpc: " + $_.Exception.Message + " | Windows Defender bloquea a menudo los binarios de frp (falso positivo). Anade una exclusion de carpeta en Seguridad de Windows > Proteccion antivirus > Exclusiones y vuelve a intentarlo.")
  }
  Remove-Quiet $tmp
  Write-Output "frpc instalado en $Exe"
} else {
  Write-Output "frpc ya presente en $Exe"
}`;
}

/** Bucle oculto: arranca frpc, lo mantiene vivo y sincroniza la config con el panel. */
function runScript(syncUrl) {
  return `$ErrorActionPreference = 'SilentlyContinue'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Dir 'frpc.exe'
$Cfg = Join-Path $Dir 'frpc.toml'
$New = Join-Path $Dir 'frpc.toml.new'
$Log = Join-Path $Dir 'frpc-eds.log'
$Url = '${psSingleQuote(syncUrl)}'

function Write-Log($m) {
  try {
    Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $m) -ErrorAction SilentlyContinue
    $f = Get-Item -LiteralPath $Log -ErrorAction SilentlyContinue
    if ($f -and $f.Length -gt 1048576) {
      Move-Item -Force -LiteralPath $Log -Destination ($Log + '.1') -ErrorAction SilentlyContinue
    }
  } catch { }
}

function Get-Hash($p) {
  if (-not (Test-Path -LiteralPath $p)) { return '' }
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
}

function Start-Frpc {
  try {
    # -NoNewWindow: hereda la consola oculta del servicio, sin crear ninguna ventana.
    # La salida va a frpc.out.log / frpc.err.log para poder diagnosticar fallos.
    $p = Start-Process -FilePath $Exe -ArgumentList ('-c "' + $Cfg + '"') -WorkingDirectory $Dir -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $Dir 'frpc.out.log') -RedirectStandardError (Join-Path $Dir 'frpc.err.log')
    Write-Log ('frpc arrancado (PID ' + $p.Id + ')')
    return $p
  } catch {
    Write-Log ('ERROR al arrancar frpc: ' + $_.Exception.Message)
    return $null
  }
}

Write-Log 'servicio iniciado'
$proc = $null
while ($true) {
  # frpc primero: no depende de que el panel sea accesible.
  if (-not $proc -or $proc.HasExited) {
    if ($proc) { Write-Log ('frpc termino (exit ' + $proc.ExitCode + '), reiniciando') }
    $proc = Start-Frpc
  }
  if ($Url -ne '') {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $New -UseBasicParsing -TimeoutSec 15
      if ((Get-Hash $New) -ne (Get-Hash $Cfg)) {
        if ($proc -and -not $proc.HasExited) { $proc.Kill() }
        Start-Sleep -Seconds 2
        Move-Item -Force -LiteralPath $New -Destination $Cfg
        Write-Log 'configuracion actualizada desde el panel'
        $proc = Start-Frpc
      } else {
        Remove-Item -Force -LiteralPath $New -ErrorAction SilentlyContinue
      }
    } catch { }
  }
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
echo --- frpc-eds.log (ultimas 15 lineas) ---
${ps} "Get-Content -LiteralPath 'C:\\ProgramData\\FRPC-EDS\\frpc-eds.log' -Tail 15 -ErrorAction SilentlyContinue"
echo --- frpc.err.log ---
${ps} "Get-Content -LiteralPath 'C:\\ProgramData\\FRPC-EDS\\frpc.err.log' -Tail 15 -ErrorAction SilentlyContinue"
echo.
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
try { & schtasks /End /TN $Task 2>$null | Out-Null } catch { }
try {
  Get-Process -Name frpc -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $Exe -or $_.Path -like '*\\frpc-eds\\frpc.exe' } |
    Stop-Process -Force -ErrorAction SilentlyContinue
} catch { }

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

# 6) Arrancar y comprobar (con paciencia: el primer arranque puede tardar)
function Wait-Frpc([int]$segundos) {
  $limit = (Get-Date).AddSeconds($segundos)
  while ((Get-Date) -lt $limit) {
    $p = Get-Process -Name frpc -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { return $p }
    Start-Sleep -Milliseconds 750
  }
  return $null
}

Start-ScheduledTask -TaskName $Task
$proc = Wait-Frpc 45
if (-not $proc) {
  # Segundo intento: la primera ejecucion puede quedarse esperando red.
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $Task
  $proc = Wait-Frpc 30
}

if ($proc) {
  Write-Output "OK - frpc en marcha (PID $($proc.Id)) bajo el servicio '$Task'"
  Write-Output "Estado: $Dir\\estado.cmd"
} else {
  $state = (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue).State
  $info = Get-ScheduledTaskInfo -TaskName $Task -ErrorAction SilentlyContinue
  Write-Output "AVISO: servicio '$Task' registrado (estado: $state) pero frpc no aparece."
  if ($info) { Write-Output ('Ultima ejecucion: ' + $info.LastRunTime + ' | resultado: ' + $info.LastTaskResult) }
  Write-Output ('Revisa ' + $Dir + '\\frpc-eds.log y frpc.err.log, o ejecuta estado.cmd.')
  exit 2
}`;
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
  \${OrIf} $ExitCode == "2"
    WriteUninstaller "$INSTDIR\\uninstall.exe"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "DisplayName" "${appName}"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "DisplayVersion" "${version}"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "Publisher" "FRPC-EDS"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "InstallLocation" "$INSTDIR"
    WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "UninstallString" '"$INSTDIR\\uninstall.exe"'
    WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "NoModify" 1
    WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FRPC-EDS" "NoRepair" 1

    \${If} $ExitCode == "0"
    MessageBox MB_ICONINFORMATION|MB_OK "FRPC-EDS instalado.$\\r$\\n$\\r$\\nfrpc ya esta corriendo en segundo plano (servicio 'FRPC-EDS', usuario SYSTEM). No abre ninguna ventana.$\\r$\\n$\\r$\\nEstado: $INSTDIR\\estado.cmd$\\r$\\nPanel: sigue creando tuneles, el cliente se sincroniza solo."
    \${Else}
      MessageBox MB_ICONEXCLAMATION|MB_OK "FRPC-EDS instalado, pero frpc todavia no responde (el primer arranque puede tardar).$\\r$\\n$\\r$\\nDetalle:$\\r$\\n$Output"
    \${EndIf}
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
