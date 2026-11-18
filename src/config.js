import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Raíz del proyecto. */
export const ROOT = path.resolve(here, "..");

// Carga .env con el lector nativo de Node (sin dependencias).
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn(`[config] No se pudo leer .env: ${err.message}`);
  }
}

export const DATA_DIR = path.join(ROOT, "data");
export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
export const PUBLIC_DIR = path.join(ROOT, "public");
export const BIN_DIR = path.join(ROOT, "bin", "frp");
export const DB_FILE = path.join(DATA_DIR, "db.json");

/**
 * Caddy: el panel genera un fragmento con un bloque por cada puerto público
 * adicional y lo aplica recargando Caddy por su API de administración.
 * `scripts/setup-caddy-ports.sh` deja todo preparado (carpeta + import).
 */
export const CADDY_CONFIG = process.env.CADDY_CONFIG || "/etc/caddy/Caddyfile";
export const CADDY_ADMIN = process.env.CADDY_ADMIN || "http://127.0.0.1:2019";
export const CADDY_PORTS_DIR =
  process.env.CADDY_PORTS_DIR || path.join(path.dirname(CADDY_CONFIG), "frpc-eds.d");
export const CADDY_PORTS_FILE = path.join(CADDY_PORTS_DIR, "ports.caddy");

/**
 * Firewall: el panel abre/cierra en UFW los puertos públicos adicionales
 * llamando (vía sudo, sin contraseña) a este helper root, que valida cada
 * puerto antes de tocar nada. Lo instala `scripts/setup-caddy-ports.sh`.
 */
export const FIREWALL_HELPER =
  process.env.FIREWALL_HELPER || "/usr/local/sbin/frpc-eds-ports";

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

/** Ruta al binario de frpc. */
export function frpcBinary() {
  if (process.env.FRPC_PATH) return process.env.FRPC_PATH;
  return path.join(BIN_DIR, process.platform === "win32" ? "frpc.exe" : "frpc");
}

export const env = {
  host: process.env.PANEL_HOST || "127.0.0.1",
  port: Number(process.env.PANEL_PORT || 7800),
  user: process.env.PANEL_USER || "admin",
  password: process.env.PANEL_PASSWORD || "cambiar-esta-clave",
  sessionSecret: process.env.SESSION_SECRET || "",
  sessionHours: Number(process.env.SESSION_HOURS || 12),
};
