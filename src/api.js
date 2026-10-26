import fs from "node:fs";
import path from "node:path";
import { Router } from "./router.js";
import { httpError } from "./errors.js";
import * as store from "./store.js";
import { agent } from "./agent.js";
import { getStatus } from "./frps.js";
import { buildFrpcToml, buildFrpsToml } from "./toml.js";
import { handlePluginRequest } from "./frpauth.js";
import { RUNTIME_DIR } from "./config.js";
import { writeFrpsConfig, writeAllNodeConfigs, writeNodeConfig } from "./runtime.js";
import {
  checkCredentials,
  createSession,
  sessionCookie,
  clearSessionCookie,
  loginAllowed,
  registerFailure,
  registerSuccess,
} from "./auth.js";

const PUBLIC_PATHS = new Set([
  "/api/login",
  "/api/logout",
  "/api/session",
  "/api/tls/ask",
  "/api/frp/plugin",
]);
const FRP_VERSION = "0.71.1";

/* ------------------------------------------------------------------ */
/* Helpers de respuesta                                                */
/* ------------------------------------------------------------------ */

function send(ctx, status, data, headers = {}) {
  const body = JSON.stringify(data ?? null);
  ctx.res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  ctx.res.end(body);
  return true;
}

function download(ctx, filename, content) {
  ctx.res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  ctx.res.end(content);
}

/* ------------------------------------------------------------------ */
/* Vistas y agregados                                                  */
/* ------------------------------------------------------------------ */

function finishTunnel(db, tunnel, proxies) {
  const frp = proxies.get(tunnel.name);
  return {
    ...tunnel,
    url: store.tunnelUrl(tunnel, db.settings),
    nodeName: db.nodes.find((n) => n.id === tunnel.nodeId)?.name || "—",
    online: Boolean(frp && frp.status === "online"),
    frpStatus: frp?.status || "offline",
    curConns: frp?.curConns ?? 0,
    todayTrafficIn: frp?.todayTrafficIn ?? 0,
    todayTrafficOut: frp?.todayTrafficOut ?? 0,
    lastStartTime: frp?.lastStartTime || null,
    lastCloseTime: frp?.lastCloseTime || null,
  };
}

async function buildOverview(session) {
  const db = store.read();
  const status = await getStatus(db.settings);

  const tunnels = db.tunnels.map((t) => finishTunnel(db, t, status.proxies));
  const nodes = db.nodes.map((n) => ({
    ...n,
    tunnelCount: db.tunnels.filter((t) => t.nodeId === n.id).length,
    onlineCount: tunnels.filter((t) => t.nodeId === n.id && t.online).length,
  }));

  let trafficIn = 0;
  let trafficOut = 0;
  let curConns = 0;
  for (const proxy of status.proxies.values()) {
    trafficIn += proxy.todayTrafficIn || 0;
    trafficOut += proxy.todayTrafficOut || 0;
    curConns += proxy.curConns || 0;
  }

  return {
    user: session?.u || null,
    settings: db.settings,
    nodes,
    tunnels,
    agent: agent.snapshot(),
    frps: {
      online: status.online,
      error: status.error,
      version: status.info?.version || null,
      clientCounts: status.info?.clientCounts ?? null,
      totalTrafficIn: status.info?.totalTrafficIn ?? null,
      totalTrafficOut: status.info?.totalTrafficOut ?? null,
      proxyTypeCount: status.info?.proxyTypeCount ?? null,
      adminBase: `${db.settings.adminApi.host}:${db.settings.adminApi.port}`,
    },
    stats: {
      total: tunnels.length,
      online: tunnels.filter((t) => t.online).length,
      nodes: nodes.length,
      trafficIn,
      trafficOut,
      curConns,
    },
  };
}

/** Regenera la config del nodo y la aplica si es el nodo local en ejecución. */
async function afterTunnelChange(nodeId) {
  writeNodeConfig(nodeId);
  const local = store.localNode();
  if (local && local.id === nodeId && agent.running) {
    await agent.applyConfig();
  }
}

function buildInstallScript(node, toml) {
  return `# ------------------------------------------------------------------
# FRPC-EDS — instalación del cliente para "${node.name}"
# Generado el ${new Date().toISOString()}
#
# Uso (PowerShell):
#   powershell -ExecutionPolicy Bypass -File install-frpc.ps1
# ------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$Version = '${FRP_VERSION}'
$Dir = Join-Path $env:USERPROFILE 'frpc-eds'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$name = "frp_\${Version}_windows_\${arch}"

if (-not (Test-Path (Join-Path $Dir 'frpc.exe'))) {
  Write-Host "Descargando frp $Version ($arch)..."
  $zip = Join-Path $env:TEMP "$name.zip"
  Invoke-WebRequest -Uri "https://github.com/fatedier/frp/releases/download/v\${Version}/\${name}.zip" -OutFile $zip
  try {
    Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
  } catch {
    Write-Host ""
    Write-Host "No se pudo extraer el zip. Windows Defender bloquea a menudo los" -ForegroundColor Yellow
    Write-Host "binarios de frp (falso positivo generico). Anade una exclusion de" -ForegroundColor Yellow
    Write-Host "carpeta en Seguridad de Windows > Proteccion antivirus > Exclusiones" -ForegroundColor Yellow
    Write-Host "y vuelve a ejecutar este script." -ForegroundColor Yellow
    throw
  }
  Copy-Item (Join-Path $env:TEMP "$name\\frpc.exe") $Dir -Force
  Write-Host "frpc instalado en $Dir"
}

$config = @'
${toml.trimEnd()}
'@
# Sin BOM: algunos parsers TOML fallan con el BOM de PowerShell 5.1
$configPath = Join-Path $Dir 'frpc.toml'
[System.IO.File]::WriteAllText($configPath, $config, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Configuración escrita en $configPath"
Write-Host "Iniciando frpc (Ctrl+C para detener)..."
& (Join-Path $Dir 'frpc.exe') -c $configPath
`;
}

function buildLinuxInstallScript(node, toml) {
  const safeName = String(node.name).replace(/["\r\n]/g, " ").slice(0, 60);
  return `#!/usr/bin/env bash
# ------------------------------------------------------------------
# FRPC-EDS - cliente para "${safeName}" (${node.id})
# Generado el ${new Date().toISOString()}
#
# Instala frpc en /opt/frpc-eds y lo deja como servicio systemd (frpc-eds).
# Uso:  sudo bash install-frpc.sh
# ------------------------------------------------------------------
set -euo pipefail

VERSION="0.71.1"
DIR="/opt/frpc-eds"
mkdir -p "$DIR"

ARCH="amd64"
case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7l|armv6l) ARCH="arm" ;;
esac

if [ ! -x "$DIR/frpc" ]; then
  NAME="frp_"$VERSION"_linux_"$ARCH
  echo "Descargando $NAME..."
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v$VERSION/$NAME.tar.gz" -o "$TMP/frp.tgz"
  tar -xzf "$TMP/frp.tgz" -C "$TMP"
  install -m 0755 "$TMP/$NAME/frpc" "$DIR/frpc"
  rm -rf "$TMP"
fi

cat > "$DIR/frpc.toml" <<'FRPCONF'
${toml.trimEnd()}
FRPCONF
chmod 600 "$DIR/frpc.toml"

cat > /etc/systemd/system/frpc-eds.service <<'FRPUNIT'
[Unit]
Description=FRPC-EDS client (${safeName})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/frpc-eds/frpc -c /opt/frpc-eds/frpc.toml
Restart=always
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
FRPUNIT

systemctl daemon-reload
systemctl enable --now frpc-eds
echo ""
echo "Servicio frpc-eds iniciado:"
systemctl --no-pager --lines=15 status frpc-eds || true
`;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export function buildApiRouter() {
  const r = new Router();

  /* --- Autenticación --------------------------------------------- */

  r.post("/api/login", (ctx) => {
    const ip = ctx.req.socket.remoteAddress || "desconocida";
    if (!loginAllowed(ip)) {
      throw httpError(429, "Demasiados intentos fallidos. Espera unos minutos.");
    }
    const { user = "", password = "" } = ctx.body || {};
    if (!checkCredentials(String(user), String(password))) {
      registerFailure(ip);
      throw httpError(401, "Usuario o contraseña incorrectos");
    }
    registerSuccess(ip);
    const token = createSession(String(user));
    const secure =
      String(ctx.req.headers["x-forwarded-proto"] || "").includes("https") ||
      Boolean(ctx.req.socket.encrypted);
    return send(
      ctx,
      200,
      { ok: true, user: String(user) },
      { "set-cookie": sessionCookie(token, secure) },
    );
  });

  r.post("/api/logout", (ctx) =>
    send(ctx, 200, { ok: true }, { "set-cookie": clearSessionCookie() }),
  );

  r.get("/api/session", (ctx) =>
    send(ctx, 200, { authenticated: Boolean(ctx.session), user: ctx.session?.u || null }),
  );

  /* --- Estado ----------------------------------------------------- */

  r.get("/api/overview", async (ctx) => send(ctx, 200, await buildOverview(ctx.session)));

  r.get("/api/status", async (ctx) => {
    const overview = await buildOverview(ctx.session);
    return send(ctx, 200, {
      frps: overview.frps,
      agent: overview.agent,
      stats: overview.stats,
      tunnels: overview.tunnels.map((t) => ({
        id: t.id,
        online: t.online,
        frpStatus: t.frpStatus,
        curConns: t.curConns,
        todayTrafficIn: t.todayTrafficIn,
        todayTrafficOut: t.todayTrafficOut,
        lastStartTime: t.lastStartTime,
      })),
    });
  });

  /* --- Servidores (nodos) ----------------------------------------- */

  r.get("/api/nodes", (ctx) => send(ctx, 200, { nodes: store.listNodes() }));

  r.post("/api/nodes", (ctx) => send(ctx, 201, { node: store.createNode(ctx.body || {}) }));

  r.post("/api/nodes/:id/token", async (ctx) => {
    const node = store.rotateNodeToken(ctx.params.id);
    writeNodeConfig(node.id);
    if (node.mode === "local" && agent.running) {
      await agent.applyConfig().catch(() => undefined);
    }
    return send(ctx, 200, { node });
  });

  r.put("/api/nodes/:id", (ctx) =>
    send(ctx, 200, { node: store.updateNode(ctx.params.id, ctx.body || {}) }),
  );

  r.delete("/api/nodes/:id", (ctx) => {
    const node = store.deleteNode(ctx.params.id);
    fs.rmSync(path.join(RUNTIME_DIR, node.id), { recursive: true, force: true });
    return send(ctx, 200, { ok: true, node });
  });

  r.get("/api/nodes/:id/frpc.toml", (ctx) => {
    const db = store.read();
    const node = db.nodes.find((n) => n.id === ctx.params.id);
    if (!node) throw httpError(404, "Servidor no encontrado");
    const tunnels = db.tunnels.filter((t) => t.nodeId === node.id);
    return download(ctx, `frpc-${node.id}.toml`, buildFrpcToml(db.settings, node, tunnels));
  });

  r.get("/api/nodes/:id/install.ps1", (ctx) => {
    const db = store.read();
    const node = db.nodes.find((n) => n.id === ctx.params.id);
    if (!node) throw httpError(404, "Servidor no encontrado");
    const tunnels = db.tunnels.filter((t) => t.nodeId === node.id);
    const toml = buildFrpcToml(db.settings, node, tunnels);
    return download(ctx, "install-frpc.ps1", buildInstallScript(node, toml));
  });

  r.get("/api/nodes/:id/install.sh", (ctx) => {
    const db = store.read();
    const node = db.nodes.find((n) => n.id === ctx.params.id);
    if (!node) throw httpError(404, "Servidor no encontrado");
    const tunnels = db.tunnels.filter((t) => t.nodeId === node.id);
    const toml = buildFrpcToml(db.settings, node, tunnels);
    return download(ctx, "install-frpc.sh", buildLinuxInstallScript(node, toml));
  });

  /**
   * Plugin HTTP de frps: frps lo llama en cada Login y NewProxy.
   * Solo se acepta desde loopback (frps corre en el mismo host que el panel).
   */
  r.post("/api/frp/plugin", (ctx) => {
    const ip = ctx.req.socket.remoteAddress || "";
    const isLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
    if (!isLocal) return send(ctx, 403, { reject: true, reject_reason: "forbidden" });

    const body = ctx.body || {};
    const op = String(ctx.searchParams.get("op") || body.op || "");
    const result = handlePluginRequest(op, body.content || {});
    return send(ctx, 200, result);
  });

  /**
   * Endpoint `ask` para TLS on-demand de Caddy: solo autoriza certificados
   * para subdominios que correspondan a un túnel habilitado.
   * Solo se acepta desde loopback (Caddy corre en el mismo host).
   */
  r.get("/api/tls/ask", (ctx) => {
    const ip = ctx.req.socket.remoteAddress || "";
    const isLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
    if (!isLocal) return send(ctx, 403, { error: "forbidden" });

    const domain = String(ctx.searchParams.get("domain") || "").toLowerCase();
    const db = store.read();
    const allowed = db.tunnels.some(
      (t) =>
        t.enabled &&
        ((t.subdomain &&
          db.settings.subDomainHost &&
          `${t.subdomain}.${db.settings.subDomainHost}` === domain) ||
          (t.customDomains || []).includes(domain)),
    );
    return send(ctx, allowed ? 200 : 403, { domain, allowed });
  });

  /* --- Túneles ---------------------------------------------------- */

  r.get("/api/tunnels", (ctx) => send(ctx, 200, { tunnels: store.listTunnels() }));

  r.get("/api/tunnels/suggest-port", (ctx) =>
    send(ctx, 200, { remotePort: store.suggestRemotePort() }),
  );

  r.post("/api/tunnels", async (ctx) => {
    const tunnel = store.createTunnel(ctx.body || {});
    await afterTunnelChange(tunnel.nodeId);
    return send(ctx, 201, { tunnel });
  });

  r.put("/api/tunnels/:id", async (ctx) => {
    const tunnel = store.updateTunnel(ctx.params.id, ctx.body || {});
    await afterTunnelChange(tunnel.nodeId);
    return send(ctx, 200, { tunnel });
  });

  r.delete("/api/tunnels/:id", async (ctx) => {
    const tunnel = store.deleteTunnel(ctx.params.id);
    await afterTunnelChange(tunnel.nodeId);
    return send(ctx, 200, { ok: true, tunnel });
  });

  /* --- Configuración del servidor --------------------------------- */

  r.get("/api/settings", (ctx) => send(ctx, 200, { settings: store.getSettings() }));

  r.put("/api/settings", async (ctx) => {
    store.updateSettings(ctx.body || {});
    writeFrpsConfig();
    writeAllNodeConfigs();
    if (agent.running) await agent.applyConfig().catch(() => undefined);
    return send(ctx, 200, { settings: store.getSettings() });
  });

  r.post("/api/settings/test-frps", async (ctx) => {
    const current = store.getSettings();
    const overrides = ctx.body?.adminApi;
    const settings = overrides
      ? { ...current, adminApi: { ...current.adminApi, ...overrides } }
      : current;
    const status = await getStatus(settings, { force: true });
    return send(ctx, 200, {
      online: status.online,
      error: status.error,
      info: status.info,
      proxies: [...status.proxies.keys()],
    });
  });

  r.get("/api/server/frps.toml", (ctx) => {
    writeFrpsConfig();
    return download(ctx, "frps.toml", buildFrpsToml(store.getSettings()));
  });

  /* --- Agente local ----------------------------------------------- */

  r.get("/api/agent", (ctx) => send(ctx, 200, { agent: agent.snapshot() }));

  r.get("/api/agent/logs", (ctx) => send(ctx, 200, { logs: agent.logs }));

  r.post("/api/agent/start", async (ctx) => {
    const nodeId = ctx.body?.nodeId || store.localNode()?.id;
    return send(ctx, 200, { agent: await agent.start(nodeId) });
  });

  r.post("/api/agent/stop", async (ctx) => send(ctx, 200, { agent: await agent.stop() }));

  r.post("/api/agent/restart", async (ctx) => send(ctx, 200, { agent: await agent.restart() }));

  r.get("/api/agent/logs/stream", (ctx) => {
    const res = ctx.res;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": conectado\n\n");

    const onLog = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
    const unsubscribe = agent.subscribe(onLog);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);

    ctx.req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
      try {
        res.end();
      } catch {
        /* ya cerrado */
      }
    });
    return true;
  });

  return {
    async handle(ctx) {
      const hit = r.match(ctx.req.method, ctx.pathname);
      if (!hit) return false;

      ctx.params = hit.params;

      if (!PUBLIC_PATHS.has(ctx.pathname) && !ctx.session) {
        return send(ctx, 401, { error: "Sesión no válida o expirada" });
      }

      await hit.handler(ctx);
      return true;
    },
  };
}
