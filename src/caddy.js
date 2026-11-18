/**
 * Puertos públicos adicionales servidos por Caddy.
 *
 * Cada puerto se publica como https://<sub>.<dominio>:<puerto> con TLS
 * on-demand, reescribiendo el Host a "p<puerto>-<host>" para que frps lo
 * enrute al proxy correcto del túnel.
 *
 * El panel NO exige una lista fija de puertos: genera un fragmento de
 * Caddyfile (un bloque por puerto en uso) y recarga Caddy por su API de
 * administración. Si Caddy rechaza el cambio (p. ej. puerto ocupado por otro
 * servicio) mantiene la configuración anterior y el fragmento se revierte.
 *
 * Preparación en el servidor (una sola vez, como root):
 *   sudo bash scripts/setup-caddy-ports.sh
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import {
  CADDY_ADMIN,
  CADDY_CONFIG,
  CADDY_PORTS_DIR,
  CADDY_PORTS_FILE,
  env,
} from "./config.js";
import { httpError } from "./errors.js";
import { syncFirewallPorts } from "./firewall.js";
import * as store from "./store.js";

/** Puertos con bloque fijo en el Caddyfile (no hace falta generarlos). */
export const BASE_PUBLIC_PORTS = store.DEFAULT_PUBLIC_PORTS;

/** Puertos adicionales que deben tener listener TLS según los túneles actuales. */
export function collectPublicPorts() {
  const db = store.read();
  const ports = new Set();
  for (const tunnel of db.tunnels) {
    if (!tunnel.enabled) continue;
    if (tunnel.type !== "http" && tunnel.type !== "https") continue;
    if (!tunnel.subdomain) continue;
    for (const raw of tunnel.publicPorts || []) {
      const port = Number(raw);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
    }
  }
  for (const port of BASE_PUBLIC_PORTS) ports.delete(port);
  return [...ports].sort((a, b) => a - b);
}

/** Bloque Caddyfile para un puerto adicional. */
function renderBlock(port) {
  const upstream = store.getSettings().vhostHTTPPort;
  return `https://:${port} {
	tls {
		on_demand
	}
	encode zstd gzip
	forward_auth 127.0.0.1:${env.port} {
		uri /api/guard
		header_up X-Original-Uri {http.request.uri}
	}
	reverse_proxy 127.0.0.1:${upstream} {
		header_up Host p${port}-{http.request.host}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto https
		header_up X-Forwarded-Host {host}
		header_up X-Forwarded-Port ${port}
		flush_interval -1
	}
}
`;
}

export function renderPortsFile(ports) {
  const header = [
    "# ------------------------------------------------------------------",
    "# GENERADO POR FRPC-EDS — no editar a mano.",
    "# Un bloque por cada puerto público adicional de los túneles:",
    "#   https://<subdominio>.<dominio>:<puerto>",
    "# El panel reescribe este archivo y recarga Caddy automáticamente.",
    "# ------------------------------------------------------------------",
  ].join("\n");
  if (!ports.length) return `${header}\n\n# Sin puertos adicionales por ahora.\n`;
  return `${header}\n\n${ports.map(renderBlock).join("\n")}`;
}

/** ¿Se puede escuchar en ese puerto en todas las interfaces? */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Comprueba antes de guardar que los puertos pedidos no los use otro servicio.
 * `ignore` son los puertos que ya sirve este Caddy (base + generados), para no
 * rechazarlos al editar un túnel existente.
 */
export async function findBusyPublicPorts(ports, ignore = []) {
  const skip = new Set([...BASE_PUBLIC_PORTS, ...ignore].map(Number));
  const busy = [];
  for (const port of ports) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1) continue;
    if (skip.has(n)) continue;
    if (!(await isPortFree(n))) busy.push(n);
  }
  return busy;
}

/** POST del Caddyfile completo a la API de administración (via http nativo). */
function postCaddyConfig(body) {
  const url = new URL(`${CADDY_ADMIN.replace(/\/+$/, "")}/load`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "content-type": "text/caddyfile",
          "content-length": Buffer.byteLength(body),
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("tiempo de espera agotado")));
    req.on("error", reject);
    req.end(body);
  });
}

/** Recarga Caddy enviando el Caddyfile completo por la API de administración. */
async function reloadCaddy() {
  const config = fs.readFileSync(CADDY_CONFIG, "utf8");
  let res;
  try {
    res = await postCaddyConfig(config);
  } catch (err) {
    // Caddy parado o API inaccesible: el fragmento queda escrito y Caddy lo
    // aplicará al arrancar (el import está en el Caddyfile principal).
    console.warn(`[caddy] API de administración no disponible (${err.message})`);
    return { applied: false };
  }
  if (res.status < 200 || res.status >= 300) {
    let message = res.body;
    try {
      message = JSON.parse(res.body).error || res.body;
    } catch {
      /* respuesta en texto plano */
    }
    throw new Error(message || `HTTP ${res.status}`);
  }
  return { applied: true };
}

let warnedMissing = false;

/**
 * Escribe el fragmento de puertos y recarga Caddy si cambió.
 * Lanza un error con mensaje claro si Caddy rechaza la configuración; en ese
 * caso se restaura el fragmento anterior y Caddy sigue con la config vigente.
 */
export async function syncCaddyPorts({ force = false } = {}) {
  if (String(process.env.CADDY_SYNC ?? "").trim() === "0") {
    return { skipped: "deshabilitado por CADDY_SYNC=0" };
  }
  if (!fs.existsSync(CADDY_CONFIG)) {
    if (!warnedMissing) {
      console.warn(
        `[caddy] No existe ${CADDY_CONFIG}; se omite la sincronización de puertos públicos.`,
      );
      warnedMissing = true;
    }
    return { skipped: "caddyfile-ausente" };
  }

  const ports = collectPublicPorts();
  const content = renderPortsFile(ports);

  let previous = null;
  try {
    previous = fs.readFileSync(CADDY_PORTS_FILE, "utf8");
  } catch {
    /* primera vez */
  }
  if (!force && previous === content) {
    // El fragmento ya está al día, pero el firewall puede haberse reiniciado
    // o limpiado a mano: el helper es idempotente y solo abre/cierra diffs.
    const firewall = await syncFirewallPorts(ports);
    return { changed: false, applied: true, ports, firewall };
  }

  try {
    fs.mkdirSync(CADDY_PORTS_DIR, { recursive: true });
    const tmp = `${CADDY_PORTS_FILE}.tmp`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, CADDY_PORTS_FILE);
  } catch (err) {
    throw httpError(
      500,
      `No se pudo escribir ${CADDY_PORTS_FILE} (${err.message}). ` +
        "Ejecuta 'sudo bash scripts/setup-caddy-ports.sh' en el servidor.",
    );
  }

  try {
    const result = await reloadCaddy();
    // El firewall se toca solo si Caddy aceptó el fragmento: así nunca
    // queda un puerto abierto sin listener ni se cierra uno en uso.
    const firewall = await syncFirewallPorts(ports);
    return { changed: true, applied: result.applied, ports, firewall };
  } catch (err) {
    try {
      if (previous === null) fs.rmSync(CADDY_PORTS_FILE, { force: true });
      else fs.writeFileSync(CADDY_PORTS_FILE, previous, "utf8");
    } catch {
      /* si tampoco se puede revertir, Caddy conserva la config anterior */
    }
    throw httpError(409, `Caddy rechazó los puertos indicados: ${err.message}`);
  }
}
