/**
 * Firewall (UFW) para los puertos públicos adicionales.
 *
 * El panel corre como usuario sin privilegios (`frp`), así que no puede tocar
 * UFW directamente. En su lugar ejecuta, mediante `sudo -n`, el helper root
 * `/usr/local/sbin/frpc-eds-ports`, autorizado en
 * `/etc/sudoers.d/frpc-eds-ports` y con validación propia de puertos
 * (1024-65535 y fuera de la lista de infraestructura).
 *
 * Si el helper no está instalado (desarrollo, mock, servidor sin UFW) el panel
 * sigue funcionando: el túnel se guarda y solo se devuelve un aviso.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { FIREWALL_HELPER } from "./config.js";

const DISABLED = String(process.env.FIREWALL_SYNC ?? "").trim() === "0";

function runHelper(args) {
  return new Promise((resolve) => {
    execFile(
      "sudo",
      ["-n", FIREWALL_HELPER, ...args],
      { timeout: 30000, env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
          error: err,
        });
      },
    );
  });
}

export function normalizePorts(ports) {
  const list = Array.isArray(ports) ? ports : [];
  return [...new Set(list.map((p) => Number(p)))]
    .filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535)
    .sort((a, b) => a - b);
}

/**
 * Deja abiertos en UFW exactamente `ports` (los que el panel abrió antes y ya
 * no se usan se cierran). Nunca lanza: devuelve `{ applied, error }`.
 */
export async function syncFirewallPorts(ports) {
  if (DISABLED) return { skipped: "deshabilitado por FIREWALL_SYNC=0" };
  if (!fs.existsSync(FIREWALL_HELPER)) {
    return {
      applied: false,
      skipped: "helper-ausente",
      error:
        "Falta el helper de firewall en el servidor. " +
        "Ejecuta 'sudo bash scripts/setup-caddy-ports.sh' en /opt/frpc-eds.",
    };
  }

  const list = normalizePorts(ports);
  const res = await runHelper(["sync", ...list.map(String)]);
  if (res.ok) return { applied: true, ports: list };

  const detail =
    (res.stderr || res.stdout || res.error?.message || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() || "no se pudo actualizar el firewall";
  console.warn(`[firewall] ${detail}`);
  return { applied: false, ports: list, error: detail };
}
