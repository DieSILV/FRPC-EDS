/**
 * Arranca frps con la configuración generada por el panel (data/runtime/frps.toml).
 * Uso: npm run frps
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { BIN_DIR, RUNTIME_DIR } from "../src/config.js";
import { writeFrpsConfig } from "../src/runtime.js";

const binary = path.join(BIN_DIR, process.platform === "win32" ? "frps.exe" : "frps");
if (!fs.existsSync(binary)) {
  console.error(`\n  No se encontró frps en:\n    ${binary}\n`);
  console.error("  Instálalo con: npm run frp:install\n");
  process.exit(1);
}

const config = writeFrpsConfig();
console.log(`\n  frps usando ${config}\n`);

const child = spawn(binary, ["-c", config], {
  cwd: RUNTIME_DIR,
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code) => process.exit(code ?? 0));
