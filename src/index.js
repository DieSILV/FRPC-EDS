import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { env, PUBLIC_DIR, RUNTIME_DIR, frpcBinary } from "./config.js";
import { buildApiRouter } from "./api.js";
import { getSession } from "./auth.js";
import { agent } from "./agent.js";
import { writeFrpsConfig, writeAllNodeConfigs } from "./runtime.js";
import * as store from "./store.js";

const api = buildApiRouter();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function setSecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
  );
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("No encontrado");
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

function serveStatic(pathname, res) {
  const relative = path.normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return notFound(res);
  }
  if (stat.isDirectory()) return notFound(res);
  return serveFile(res, filePath);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") return resolve(null);
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error("Cuerpo de la petición demasiado grande"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("JSON inválido en el cuerpo"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const session = getSession(req);

    if (!pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
      if (pathname === "/login") {
        if (session) return redirect(res, "/");
        return serveFile(res, path.join(PUBLIC_DIR, "login.html"));
      }
      if (pathname === "/" || pathname === "/index.html") {
        if (!session) return redirect(res, "/login");
        return serveFile(res, path.join(PUBLIC_DIR, "index.html"));
      }
      return serveStatic(pathname, res);
    }

    const body = await readBody(req);
    const ctx = {
      req,
      res,
      pathname,
      searchParams: url.searchParams,
      body,
      session,
    };

    const handled = await api.handle(ctx);
    if (!handled) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Ruta no encontrada" }));
    }
  } catch (err) {
    const status = err?.status || 500;
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err?.message || "Error interno del servidor" }));
    } else {
      try {
        res.end();
      } catch {
        /* conexión ya cerrada */
      }
    }
    if (status >= 500) console.error("[panel]", err);
  }
});

server.listen(env.port, env.host, () => {
  // Genera las configuraciones al arrancar para que el frps local pueda usarlas.
  try {
    writeFrpsConfig();
    writeAllNodeConfigs();
  } catch (err) {
    console.warn(`[panel] No se pudieron generar las configuraciones: ${err.message}`);
  }

  const binary = frpcBinary();
  const settings = store.getSettings();

  console.log("");
  console.log("  FRPC-EDS · panel de control");
  console.log("  ----------------------------");
  console.log(`  Panel:      http://${env.host}:${env.port}`);
  console.log(`  Usuario:    ${env.user}`);
  console.log(`  Dominio:    ${settings.subDomainHost || "(sin configurar)"}`);
  console.log(`  frps API:   ${settings.adminApi.host}:${settings.adminApi.port}`);
  console.log(`  frpc:       ${fs.existsSync(binary) ? binary : "NO INSTALADO → npm run frp:install"}`);
  console.log(`  Configs:    ${RUNTIME_DIR}`);
  if (env.password === "cambiar-esta-clave") {
    console.log("");
    console.log("  ⚠  Estás usando la contraseña por defecto.");
    console.log("     Define PANEL_PASSWORD en .env antes de exponer el panel.");
  }
  console.log("");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  El puerto ${env.port} ya está en uso.`);
    console.error("  Cambia PANEL_PORT en .env o detén el proceso que lo ocupa.\n");
    process.exit(1);
  }
  throw err;
});

async function shutdown(signal) {
  console.log(`\n[panel] ${signal}: cerrando…`);
  try {
    await agent.stop();
  } catch {
    /* ignorar */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
