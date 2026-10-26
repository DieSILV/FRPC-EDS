/**
 * Generadores de configuración TOML para frps y frpc.
 * Sintaxis verificada contra frps_full_example.toml / frpc_full_example.toml (frp v0.71.x).
 */

import { env } from "./config.js";

/** Cadena TOML segura (los escapes de JSON son válidos en TOML básico). */
const q = (v) => JSON.stringify(String(v ?? ""));

export function buildFrpsToml(s) {
  const L = [];
  L.push("# ------------------------------------------------------------------");
  L.push("# Servidor FRP generado por FRPC-EDS");
  L.push("# Arranque rapido: npm run frps");
  L.push("# Como servicio: ver deploy/frps.service o deploy/docker-compose.yml");
  L.push("# ------------------------------------------------------------------");
  L.push('bindAddr = "0.0.0.0"');
  L.push(`bindPort = ${s.bindPort}`);
  if (s.vhostHTTPPort > 0) L.push(`vhostHTTPPort = ${s.vhostHTTPPort}`);
  if (s.vhostHTTPSPort > 0) L.push(`vhostHTTPSPort = ${s.vhostHTTPSPort}`);
  if (s.subDomainHost) L.push(`subDomainHost = ${q(s.subDomainHost)}`);
  L.push("");
  L.push("# Token maestro interno: frp lo usa tambien para cifrar el canal de control.");
  L.push("# No se reparte a los clientes; cada servidor tiene su propio token abajo.");
  L.push('auth.method = "token"');
  L.push(`auth.token = ${q(s.authToken)}`);
  L.push("");
  L.push("# API de administracion: el panel la consulta para leer el estado");
  L.push('webServer.addr = "127.0.0.1"');
  L.push(`webServer.port = ${s.adminApi.port}`);
  L.push(`webServer.user = ${q(s.adminApi.user)}`);
  L.push(`webServer.password = ${q(s.adminApi.password)}`);
  L.push("");
  L.push('log.to = "./frps.log"');
  L.push('log.level = "info"');
  L.push("log.maxDays = 7");
  L.push("");
  L.push("# Plugin de autenticacion: valida el token propio de cada servidor.");
  L.push("# OJO: debe ir AL FINAL. En TOML, cualquier clave escrita despues de");
  L.push("# [[httpPlugins]] se interpreta como parte de esa tabla.");
  L.push("[[httpPlugins]]");
  L.push('name = "frpc-eds-auth"');
  L.push(`addr = "127.0.0.1:${env.port}"`);
  L.push('path = "/api/frp/plugin"');
  L.push('ops = ["Login", "NewProxy"]');
  L.push("");
  return L.join("\n");
}

export function buildFrpcToml(s, node, tunnels) {
  const L = [];
  L.push(`# Cliente FRP - servidor "${node.name}" (${node.id})`);
  L.push(`# Generado por FRPC-EDS el ${new Date().toISOString()}`);
  L.push("");
  L.push(`serverAddr = ${q(s.serverAddr)}`);
  L.push(`serverPort = ${s.bindPort}`);
  L.push("");
  L.push('auth.method = "token"');
  L.push(`auth.token = ${q(s.authToken)}`);
  L.push("");
  L.push("# Token propio de este servidor (el panel lo valida en cada conexion)");
  L.push(`metadatas.auth_token = ${q(node.token)}`);
  L.push(`metadatas.node = ${q(node.slug)}`);
  L.push("");
  L.push("transport.tls.enable = true");
  L.push("# Reconexion: detecta caidas de red en ~30 s y NO termina si el servidor");
  L.push("# no responde al arrancar (reintenta indefinidamente).");
  L.push("transport.heartbeatInterval = 10");
  L.push("transport.heartbeatTimeout = 30");
  L.push("loginFailExit = false");
  L.push('log.level = "info"');
  L.push("log.maxDays = 3");

  if (node.mode === "local") {
    L.push("");
    L.push("# API local de administracion (permite recargar en caliente desde el panel)");
    L.push('webServer.addr = "127.0.0.1"');
    L.push(`webServer.port = ${s.frpcAdminPort}`);
    L.push('webServer.user = "admin"');
    L.push(`webServer.password = ${q(s.frpcAdminPassword)}`);
  }

  const active = (tunnels || []).filter((t) => t.enabled);
  if (active.length === 0) {
    L.push("");
    L.push("# Sin proxies habilitados todavia.");
  }

  for (const t of active) {
    L.push("");
    L.push("[[proxies]]");
    L.push(`name = ${q(t.name)}`);
    L.push(`type = ${q(t.type)}`);
    L.push(`localIP = ${q(t.localIP)}`);
    L.push(`localPort = ${t.localPort}`);

    if (t.type === "http" || t.type === "https") {
      if (t.subdomain) L.push(`subdomain = ${q(t.subdomain)}`);
      if (t.customDomains?.length) {
        L.push(`customDomains = [${t.customDomains.map(q).join(", ")}]`);
      }
      if (t.basicAuth?.user) {
        L.push(`httpUser = ${q(t.basicAuth.user)}`);
        L.push(`httpPassword = ${q(t.basicAuth.password || "")}`);
      }
      // frps reconstruye X-Forwarded-Proto como "http" (la conexión Caddy->frps
      // es HTTP). Con requestHeaders se aplica DESPUÉS, así que aquí corregimos
      // el esquema para que la app genere URLs https y no haya mixed content.
      // Solo los proxies `http` soportan requestHeaders (los `https` no).
      if (t.type === "http" && s.publicScheme === "https") {
        L.push('requestHeaders.set.X-Forwarded-Proto = "https"');
        L.push('requestHeaders.set.X-Forwarded-Port = "443"');
      }
    } else {
      L.push(`remotePort = ${t.remotePort}`);
    }

    if (t.healthCheck) {
      L.push('healthCheck.type = "tcp"');
      L.push("healthCheck.intervalSeconds = 10");
      L.push("healthCheck.timeoutSeconds = 3");
      L.push("healthCheck.maxFailed = 3");
    }

    if (t.notes) L.push(`metadatas.note = ${q(t.notes)}`);

    // Puertos publicos adicionales: Caddy termina TLS en https://<host>:<puerto>
    // y reenvía a 127.0.0.1:(puerto+10000), que es este proxy TCP.
    for (const port of t.publicPorts || []) {
      L.push("");
      L.push(`# Puerto publico ${port} (https://<host>:${port})`);
      L.push("[[proxies]]");
      L.push(`name = ${q(`${t.name}__p${port}`)}`);
      L.push('type = "tcp"');
      L.push(`localIP = ${q(t.localIP)}`);
      L.push(`localPort = ${port}`);
      L.push(`remotePort = ${port + 10000}`);
    }
  }

  L.push("");
  return L.join("\n");
}
