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
