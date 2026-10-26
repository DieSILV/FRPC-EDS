import crypto from "node:crypto";
import * as store from "./store.js";

/**
 * Autenticación por token, un token distinto por servidor.
 *
 * Por qué no se usa un token distinto como `auth.token` de frp:
 * frp usa ese mismo valor como clave de cifrado del canal de control, así que
 * cliente y servidor deben compartirlo. Por tanto:
 *
 *   - `auth.token`      → token maestro interno (lo genera el panel, no se reparte)
 *   - `metadatas.auth_token` → token propio de cada servidor (lo que se reparte)
 *
 * frps llama a este panel (plugin HTTP, op `Login`) ANTES de validar el token,
 * y el panel acepta o rechaza según el token del servidor.
 */

/** frp: util.GetAuthKey(token, timestamp) = md5hex(token + timestamp) */
export function authKey(token, timestamp) {
  return crypto
    .createHash("md5")
    .update(String(token))
    .update(String(timestamp))
    .digest("hex");
}

function safeEq(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function reject(reason) {
  return { reject: true, reject_reason: reason };
}

/**
 * Los metadatos llegan en el propio mensaje en `Login`, pero en el resto de
 * operaciones (NewProxy, Ping…) van dentro de `content.user`.
 */
function metasOf(content) {
  const direct = content?.metas;
  if (direct && typeof direct === "object") return direct;
  const nested = content?.user?.metas;
  if (nested && typeof nested === "object") return nested;
  return {};
}

function tokenOf(content) {
  const metas = metasOf(content);
  return String(metas.auth_token || metas.token || metas.authToken || "");
}

function slugOf(content) {
  const metas = metasOf(content);
  return String(metas.node || metas.node_id || "").trim();
}

function ipOf(content) {
  const raw = String(content?.client_address || "");
  const idx = raw.lastIndexOf(":");
  return idx > 0 ? raw.slice(0, idx) : raw;
}

/* ------------------------------------------------------------------ */

function handleLogin(content) {
  const token = tokenOf(content);
  if (!token) {
    return reject("Falta 'metadatas.auth_token' en la configuración del cliente");
  }

  const db = store.read();
  const node = db.nodes.find((n) => safeEq(n.token, token));
  if (!node) {
    return reject("Token de servidor desconocido. Vuelve a descargar la configuración desde el panel.");
  }
  if (!node.enabled) {
    return reject(`El servidor "${node.name}" está deshabilitado en el panel`);
  }

  const slug = slugOf(content);
  if (slug && node.slug && slug !== node.slug) {
    store.recordNodeLogin(node.id, {
      ok: false,
      ip: ipOf(content),
      error: "El identificador del servidor no coincide con el token",
    });
    return reject("El identificador del servidor no coincide con su token");
  }

  store.recordNodeLogin(node.id, { ok: true, ip: ipOf(content) });
  return { reject: false, unchange: true };
}

function handleNewProxy(content) {
  const token = tokenOf(content);
  const node = token ? store.read().nodes.find((n) => safeEq(n.token, token)) : null;
  if (!node) return reject("Servidor no autorizado para crear proxies");

  const name = String(content?.name || content?.proxy_name || "");
  const db = store.read();
  // Los puertos publicos adicionales generan proxies "<tunel>__p<puerto>".
  const derived = /^(.*)__p(\d+)$/.exec(name);
  const baseName = derived ? derived[1] : name;
  const tunnel = db.tunnels.find((t) => t.name === baseName);

  if (!tunnel) {
    return reject(`El proxy "${name}" no está definido en el panel`);
  }
  if (tunnel.nodeId !== node.id) {
    return reject(`El proxy "${name}" pertenece a otro servidor`);
  }
  if (derived && !(tunnel.publicPorts || []).includes(Number(derived[2]))) {
    return reject(`El puerto ${derived[2]} no está habilitado para "${baseName}"`);
  }

  return { reject: false, unchange: true };
}

/**
 * Punto de entrada del plugin HTTP de frps.
 * Siempre responde con el objeto esperado; los rechazos usan `reject`.
 */
export function handlePluginRequest(op, content) {
  try {
    if (op === "Login") return handleLogin(content);
    if (op === "NewProxy") return handleNewProxy(content);
    return { reject: false, unchange: true };
  } catch (err) {
    return reject(`Error interno del panel: ${err.message}`);
  }
}
