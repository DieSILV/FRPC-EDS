import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { frpcBinary } from "./config.js";
import { httpError } from "./errors.js";
import * as store from "./store.js";
import { writeNodeConfig } from "./runtime.js";

const MAX_LOGS = 800;

/**
 * Gestor del proceso frpc local (el que corre en el mismo host que el panel).
 * Mantiene un único proceso con todos los túneles del nodo local y aplica
 * los cambios en caliente mediante la API /api/reload de frpc.
 */
class LocalAgent {
  constructor() {
    this.proc = null;
    this.nodeId = null;
    this.status = "stopped"; // stopped | starting | running | stopping | error
    this.logs = [];
    this.subscribers = new Set();
    this.startedAt = null;
    this.exitedAt = null;
    this.restarts = 0;
    this.restartTimer = null;
    this.intentionalStop = false;
    this.lastExit = null;
    this.binary = null;
    this.configPath = null;
  }

  get running() {
    return Boolean(this.proc);
  }

  log(stream, line) {
    const entry = {
      t: new Date().toISOString(),
      stream,
      line: String(line).slice(0, 2000),
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    for (const fn of this.subscribers) {
      try {
        fn(entry);
      } catch {
        /* el cliente SSE se cayó */
      }
    }
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  unsubscribe(fn) {
    this.subscribers.delete(fn);
  }

  snapshot() {
    return {
      status: this.status,
      nodeId: this.nodeId,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      restarts: this.restarts,
      lastExit: this.lastExit,
      binary: this.binary,
      configPath: this.configPath,
    };
  }

  async start(nodeId) {
    if (this.proc) throw httpError(409, "El agente local ya está en ejecución");

    const node = (nodeId && store.getNode(nodeId)) || store.localNode();
    if (!node) throw httpError(404, "No hay ningún servidor local configurado");
    if (node.mode !== "local") {
      throw httpError(400, "Solo el servidor local se ejecuta en este host");
    }

    const binary = frpcBinary();
    if (!fs.existsSync(binary)) {
      throw httpError(
        400,
        `No se encontró el binario frpc en "${binary}". Ejecuta: npm run frp:install`,
      );
    }

    const written = writeNodeConfig(node.id);
    if (!written) throw httpError(500, "No se pudo generar la configuración del cliente");

    this.nodeId = node.id;
    this.binary = binary;
    this.configPath = written.file;
    this.status = "starting";
    this.intentionalStop = false;
    this.lastExit = null;
    this.startedAt = new Date().toISOString();
    this.exitedAt = null;

    this.log("info", `Iniciando ${path.basename(binary)} -c ${written.file}`);

    const proc = spawn(binary, ["-c", written.file], {
      cwd: path.dirname(written.file),
      windowsHide: true,
    });
    this.proc = proc;

    readline.createInterface({ input: proc.stdout }).on("line", (l) => this.log("stdout", l));
    readline.createInterface({ input: proc.stderr }).on("line", (l) => this.log("stderr", l));

    proc.on("spawn", () => {
      this.status = "running";
      this.log("info", `frpc en ejecución (pid ${proc.pid})`);
    });
    proc.on("error", (err) => {
      this.status = "error";
      this.lastExit = err.message;
      this.log("stderr", `No se pudo lanzar frpc: ${err.message}`);
    });
    proc.on("exit", (code, signal) => this.handleExit(code, signal));

    return this.snapshot();
  }

  handleExit(code, signal) {
    this.proc = null;
    this.exitedAt = new Date().toISOString();
    this.lastExit = `código ${code ?? "null"}${signal ? ` / señal ${signal}` : ""}`;
    this.log("info", `frpc terminó (${this.lastExit})`);

    if (this.intentionalStop) {
      this.status = "stopped";
      return;
    }

    this.status = "error";
    const settings = store.getSettings();
    if (!settings.autoRestart) {
      this.log("info", "Reinicio automático desactivado");
      return;
    }

    this.restarts += 1;
    const delay = Math.min(30000, 2000 * Math.min(this.restarts, 5));
    this.log("info", `Reintentando en ${Math.round(delay / 1000)}s (intento ${this.restarts})`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.proc || this.intentionalStop) return;
      this.start(this.nodeId).catch((err) =>
        this.log("stderr", `No se pudo reiniciar frpc: ${err.message}`),
      );
    }, delay);
  }

  async stop() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (!this.proc) {
      this.status = "stopped";
      return this.snapshot();
    }

    this.intentionalStop = true;
    this.status = "stopping";
    const proc = this.proc;

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ya terminó */
        }
        resolve();
      }, 6000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });

    this.proc = null;
    this.status = "stopped";
    this.log("info", "frpc detenido");
    return this.snapshot();
  }

  async restart() {
    const nodeId = this.nodeId || store.localNode()?.id;
    if (this.proc) await this.stop();
    if (!nodeId) throw httpError(400, "No hay ningún servidor local configurado");
    this.restarts = 0;
    return this.start(nodeId);
  }

  /**
   * Reescribe la config del nodo local y la aplica al proceso en ejecución:
   * primero intenta recarga en caliente, si falla reinicia el proceso.
   */
  async applyConfig() {
    const nodeId = this.nodeId || store.localNode()?.id;
    if (!nodeId) return { applied: false, reason: "sin nodo local" };

    writeNodeConfig(nodeId);
    if (!this.proc) return { applied: false, reason: "agente detenido" };

    const settings = store.getSettings();
    try {
      const res = await fetch(`http://127.0.0.1:${settings.frpcAdminPort}/api/reload`, {
        headers: {
          authorization: `Basic ${Buffer.from(`admin:${settings.frpcAdminPassword}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data.code !== undefined && data.code !== 0)) {
        throw new Error(data.msg || `HTTP ${res.status}`);
      }
      this.log("info", "Configuración recargada en caliente");
      return { applied: true, mode: "reload" };
    } catch (err) {
      this.log("stderr", `Recarga en caliente fallida (${err.message}). Reiniciando frpc…`);
      await this.restart();
      return { applied: true, mode: "restart" };
    }
  }
}

export const agent = new LocalAgent();
