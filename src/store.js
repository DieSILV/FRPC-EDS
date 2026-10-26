import fs from "node:fs";
import crypto from "node:crypto";
import { DB_FILE } from "./config.js";
import { httpError } from "./errors.js";

export const TUNNEL_TYPES = ["http", "https", "tcp", "udp"];

/**
 * Puertos públicos extra que Caddy sabe terminar con TLS (ver /etc/caddy/Caddyfile).
 * Cada uno se publica como https://<subdominio>.<dominio>:<puerto>
 */
export const SUPPORTED_PUBLIC_PORTS = [3000, 3001, 4173, 5173];

/* ------------------------------------------------------------------ */
/* Listas de IPs (listas blanca/negra)                                 */
/* ------------------------------------------------------------------ */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIp(value) {
  if (IPV4_RE.test(value)) return value.split(".").every((n) => Number(n) <= 255);
  return value.includes(":") && /^[0-9a-f:.]+$/i.test(value);
}

/** Acepta "1.2.3.4", "1.2.3.0/24" o "2001:db8::1" separados por coma/espacio. */
export function parseIpList(input) {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(/[\s,;]+/);
  const out = [];
  for (const item of raw) {
    const value = String(item).trim();
    if (!value) continue;
    const [addr, bits] = value.split("/");
    if (!isValidIp(addr)) throw httpError(400, `Dirección IP no válida: ${value}`);
    if (bits !== undefined) {
      const n = Number(bits);
      if (!Number.isInteger(n) || n < 0 || n > (addr.includes(":") ? 128 : 32)) {
        throw httpError(400, `Máscara no válida: ${value}`);
      }
    }
    if (!out.includes(value)) out.push(value);
  }
  return out.slice(0, 200);
}

function ipv4ToInt(ip) {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  return (((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0);
}

/** ¿La IP cumple la regla? Soporta IP exacta y CIDR IPv4. */
export function ipMatches(ip, rule) {
  const value = String(ip || "").trim().replace(/^::ffff:/i, "");
  const [net, bitsRaw] = String(rule).split("/");
  const bits = bitsRaw === undefined ? null : Number(bitsRaw);
  if (!net.includes(":")) {
    const a = ipv4ToInt(value);
    const b = ipv4ToInt(net);
    if (a === null || b === null) return false;
    if (bits === null) return a === b;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }
  if (bits === null) return value.toLowerCase() === net.toLowerCase();
  return false;
}

export function ipListMatches(rules, ip) {
  return (rules || []).some((rule) => ipMatches(ip, rule));
}

/**
 * Subdominios que no puede usar un túnel: el panel (central), la web
 * principal (www/apex) y los nombres de infraestructura DNS/servicios.
 */
export const RESERVED_SUBDOMAINS = new Set([
  "www",
  "central",
  "panel",
  "admin",
  "api",
  "ns1",
  "ns2",
  "ns3",
  "mail",
  "ftp",
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const PROXY_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const HOST_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

const nowISO = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
const newSecret = () => crypto.randomBytes(24).toString("hex");

const str = (v, dflt) => (typeof v === "string" ? v : dflt);
const num = (v, dflt, min = 0, max = 65535) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

export function defaultSettings() {
  return {
    serverAddr: "127.0.0.1",
    bindPort: 7000,
    vhostHTTPPort: 80,
    vhostHTTPSPort: 443,
    subDomainHost: "",
    publicScheme: "http",
    panelUrl: "",
    authToken: newSecret(),
    adminApi: { host: "127.0.0.1", port: 7500, user: "admin", password: newSecret() },
    frpcAdminPort: 7400,
    frpcAdminPassword: newSecret(),
    autoRestart: true,
  };
}

function slugify(name) {
  const base = String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "servidor";
}

function uniqueSlug(db, name, ignoreId) {
  const base = slugify(name);
  const used = new Set(db.nodes.filter((n) => n.id !== ignoreId).map((n) => n.slug));
  if (!used.has(base)) return base;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${base}-${i}`.slice(0, 36);
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${newSecret().slice(0, 6)}`;
}

function makeNode(db, name, mode) {
  return {
    id: newId("node"),
    name,
    mode,
    enabled: true,
    slug: uniqueSlug(db, name),
    token: newSecret(),
    createdAt: nowISO(),
  };
}

let cached = null;

function ensure(db) {
  db.version = 1;
  const d = defaultSettings();

  db.settings = db.settings || {};
  const s = db.settings;
  s.serverAddr = str(s.serverAddr, d.serverAddr).trim() || d.serverAddr;
  s.bindPort = num(s.bindPort, d.bindPort, 1);
  s.vhostHTTPPort = num(s.vhostHTTPPort, d.vhostHTTPPort, 0);
  s.vhostHTTPSPort = num(s.vhostHTTPSPort, d.vhostHTTPSPort, 0);
  s.subDomainHost = str(s.subDomainHost, "").trim().toLowerCase();
  s.publicScheme = s.publicScheme === "https" ? "https" : "http";
  s.panelUrl = str(s.panelUrl, "").trim().replace(/\/+$/, "");
  s.authToken = str(s.authToken, "").trim() || d.authToken;
  s.frpcAdminPort = num(s.frpcAdminPort, d.frpcAdminPort, 1);
  s.frpcAdminPassword = str(s.frpcAdminPassword, "").trim() || d.frpcAdminPassword;
  s.autoRestart = s.autoRestart !== false;
  s.adminApi = s.adminApi && typeof s.adminApi === "object" ? s.adminApi : {};
  s.adminApi.host = str(s.adminApi.host, "127.0.0.1").trim() || "127.0.0.1";
  s.adminApi.port = num(s.adminApi.port, 7500, 1);
  s.adminApi.user = str(s.adminApi.user, "admin");
  s.adminApi.password = str(s.adminApi.password, "").trim() || d.adminApi.password;

  db.nodes = Array.isArray(db.nodes) ? db.nodes : [];
  for (const n of db.nodes) {
    n.mode = n.mode === "local" ? "local" : "remote";
    n.enabled = n.enabled !== false;
    n.name = str(n.name, "Servidor").trim() || "Servidor";
    if (!n.id) n.id = newId("node");
    if (!n.token) n.token = newSecret();
    if (!n.slug) n.slug = uniqueSlug(db, n.name, n.id);
    n.allowedIps = Array.isArray(n.allowedIps) ? n.allowedIps.map(String) : [];
    n.lastLoginAt = str(n.lastLoginAt, "");
    n.lastLoginIp = str(n.lastLoginIp, "");
    n.lastLoginError = str(n.lastLoginError, "");
  }
  const locals = db.nodes.filter((n) => n.mode === "local");
  if (locals.length > 1) {
    // Solo se permite un nodo local; degrada los sobrantes.
    for (const extra of locals.slice(1)) extra.mode = "remote";
  }
  if (locals.length === 0) db.nodes.unshift(makeNode(db, "Este servidor", "local"));

  db.tunnels = Array.isArray(db.tunnels) ? db.tunnels : [];
  for (const t of db.tunnels) {
    t.type = TUNNEL_TYPES.includes(t.type) ? t.type : "http";
    t.enabled = t.enabled !== false;
    t.localIP = str(t.localIP, "127.0.0.1");
    t.localPort = num(t.localPort, 80, 1);
    t.remotePort = t.remotePort == null ? null : num(t.remotePort, null, 1);
    t.publicPorts = Array.isArray(t.publicPorts)
      ? t.publicPorts.map((p) => Number(p)).filter((p) => SUPPORTED_PUBLIC_PORTS.includes(p))
      : [];
    t.subdomain = str(t.subdomain, "").trim().toLowerCase();
    t.customDomains = Array.isArray(t.customDomains) ? t.customDomains : [];
    t.healthCheck = t.healthCheck === true;
    t.notes = str(t.notes, "");
    t.ipAllow = Array.isArray(t.ipAllow) ? t.ipAllow.map(String) : [];
    t.ipDeny = Array.isArray(t.ipDeny) ? t.ipDeny.map(String) : [];
  }

  return db;
}

/** Lee la base de datos (cacheada en memoria). */
export function read() {
  if (cached) return cached;
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    db = { version: 1, settings: {}, nodes: [], tunnels: [] };
  }
  cached = ensure(db);
  return cached;
}

/** Persiste el estado actual (escritura atómica). */
export function save(db) {
  const target = db || cached;
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(target, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
  cached = target;
}

/** Mutación transaccional simple. */
export function mutate(fn) {
  const db = read();
  const out = fn(db);
  save(db);
  return out;
}

export const getSettings = () => read().settings;
export const listNodes = () => read().nodes;
export const listTunnels = () => read().tunnels;
export const getNode = (id) => read().nodes.find((n) => n.id === id) || null;
export const getTunnel = (id) => read().tunnels.find((t) => t.id === id) || null;

/* ------------------------------------------------------------------ */
/* Servidores (nodos)                                                  */
/* ------------------------------------------------------------------ */

export function createNode(input = {}) {
  const name = String(input.name || "").trim();
  if (!name) throw httpError(400, "El nombre del servidor es obligatorio");
  if (name.length > 60) throw httpError(400, "El nombre es demasiado largo");
  const mode = input.mode === "local" ? "local" : "remote";
  return mutate((db) => {
    if (mode === "local" && db.nodes.some((n) => n.mode === "local")) {
      throw httpError(409, "Ya existe un servidor local (el que ejecuta este panel)");
    }
    const node = makeNode(db, name, mode);
    node.allowedIps = parseIpList(input.allowedIps);
    db.nodes.push(node);
    return node;
  });
}

/** Token propio y único de un servidor; el cliente lo envía en metadatas. */
export function rotateNodeToken(id) {
  return mutate((db) => {
    const node = db.nodes.find((n) => n.id === id);
    if (!node) throw httpError(404, "Servidor no encontrado");
    node.token = newSecret();
    node.lastLoginError = "";
    return node;
  });
}

/** Registra el último intento de conexión de un servidor. */
export function recordNodeLogin(id, info = {}) {
  const node = read().nodes.find((n) => n.id === id);
  if (!node) return;
  node.lastLoginAt = nowISO();
  node.lastLoginIp = String(info.ip || "");
  node.lastLoginError = info.ok ? "" : String(info.error || "Token rechazado");
  save();
}

export function updateNode(id, input = {}) {
  return mutate((db) => {
    const node = db.nodes.find((n) => n.id === id);
    if (!node) throw httpError(404, "Servidor no encontrado");
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw httpError(400, "El nombre es obligatorio");
      node.name = name;
    }
    if (input.enabled !== undefined) node.enabled = input.enabled !== false;
    if (input.allowedIps !== undefined) node.allowedIps = parseIpList(input.allowedIps);
    return node;
  });
}

export function deleteNode(id) {
  return mutate((db) => {
    const node = db.nodes.find((n) => n.id === id);
    if (!node) throw httpError(404, "Servidor no encontrado");
    if (node.mode === "local") {
      throw httpError(400, "El servidor local no se puede eliminar (es donde corre el panel)");
    }
    db.nodes = db.nodes.filter((n) => n.id !== id);
    db.tunnels = db.tunnels.filter((t) => t.nodeId !== id);
    return node;
  });
}

export const localNode = () => read().nodes.find((n) => n.mode === "local") || null;

/* ------------------------------------------------------------------ */
/* Túneles                                                             */
/* ------------------------------------------------------------------ */

function parseDomainList(input) {
  if (Array.isArray(input)) return input.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (typeof input === "string") {
    return input
      .split(/[\s,;]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

/** Lista de puertos públicos adicionales (validada contra los soportados). */
function parsePublicPorts(input) {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const value = String(raw).trim();
    if (!value) continue;
    const n = Number(value);
    if (!SUPPORTED_PUBLIC_PORTS.includes(n)) {
      throw httpError(
        400,
        `El puerto ${value} no está habilitado. Disponibles: ${SUPPORTED_PUBLIC_PORTS.join(", ")}`,
      );
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function normalizeTunnel(db, input, existing) {
  let nodeId = String(input.nodeId ?? existing?.nodeId ?? "");
  if (!nodeId) {
    nodeId = (db.nodes.find((n) => n.mode === "local") || db.nodes[0])?.id || "";
  }
  if (!db.nodes.some((n) => n.id === nodeId)) throw httpError(400, "Selecciona un servidor válido");

  const type = TUNNEL_TYPES.includes(input.type) ? input.type : existing?.type || "http";

  // frps rechaza los proxies `https` si no hay vhost HTTPS configurado:
  //   "type [https] not supported when vhost https port is not set"
  if (type === "https" && !db.settings.vhostHTTPSPort) {
    throw httpError(
      400,
      "El tipo HTTPS requiere «Puerto HTTPS virtual» en la pestaña Servidor. Para una web normal usa HTTP: Caddy ya pone el candado.",
    );
  }

  const localIP = String(input.localIP ?? existing?.localIP ?? "127.0.0.1").trim();
  if (!HOST_RE.test(localIP)) throw httpError(400, "La IP/host local no es válida");

  const localPort = Number(input.localPort ?? existing?.localPort);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw httpError(400, "El puerto local debe estar entre 1 y 65535");
  }

  let subdomain = "";
  let customDomains = [];
  let remotePort = null;
  let publicPorts = [];
  let ipAllow = [];
  let ipDeny = [];

  if (type === "http" || type === "https") {
    subdomain = String(input.subdomain ?? existing?.subdomain ?? "").trim().toLowerCase();
    if (subdomain && !SLUG_RE.test(subdomain)) {
      throw httpError(400, "El subdominio solo admite letras, números y guiones (sin puntos)");
    }
    if (subdomain && RESERVED_SUBDOMAINS.has(subdomain)) {
      throw httpError(
        400,
        `El subdominio "${subdomain}" está reservado para el panel/DNS. Usa otro nombre.`,
      );
    }
    customDomains = parseDomainList(input.customDomains ?? existing?.customDomains ?? []);
    for (const d of customDomains) {
      if (!DOMAIN_RE.test(d)) throw httpError(400, `El dominio "${d}" no es válido`);
    }
    if (!subdomain && customDomains.length === 0) {
      throw httpError(400, "Indica un subdominio o al menos un dominio personalizado");
    }
    if (subdomain && !db.settings.subDomainHost) {
      throw httpError(400, "Configura primero el dominio base en la pestaña Servidor");
    }
    const clash = db.tunnels.find(
      (t) =>
        t.id !== existing?.id &&
        (t.type === "http" || t.type === "https") &&
        ((subdomain && t.subdomain === subdomain) ||
          t.customDomains?.some((d) => customDomains.includes(d))),
    );
    if (clash) throw httpError(409, `El dominio ya está usado por el túnel "${clash.name}"`);

    publicPorts = parsePublicPorts(input.publicPorts ?? existing?.publicPorts ?? []);
    ipAllow = parseIpList(input.ipAllow ?? existing?.ipAllow ?? []);
    ipDeny = parseIpList(input.ipDeny ?? existing?.ipDeny ?? []);
  } else {
    remotePort = Number(input.remotePort ?? existing?.remotePort ?? 0);
    if (!Number.isInteger(remotePort) || remotePort < 0 || remotePort > 65535) {
      throw httpError(400, "El puerto remoto debe estar entre 1 y 65535");
    }
    if (remotePort > 0) {
      const clash = db.tunnels.find(
        (t) => t.id !== existing?.id && t.type === type && t.remotePort === remotePort,
      );
      if (clash) throw httpError(409, `El puerto remoto ${remotePort} ya lo usa "${clash.name}"`);
    }
  }

  let name = String(input.name ?? existing?.name ?? "").trim().toLowerCase();
  if (!name) name = subdomain || customDomains[0]?.split(".")[0] || `${type}-${localPort}`;
  name = name.replace(/[^a-z0-9_.-]/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!PROXY_NAME_RE.test(name)) throw httpError(400, "El nombre del túnel no es válido");

  const nameClash = db.tunnels.find((t) => t.id !== existing?.id && t.name === name);
  if (nameClash) throw httpError(409, `Ya existe un túnel con el nombre "${name}"`);

  const basicAuth = input.basicAuth ?? existing?.basicAuth ?? { user: "", password: "" };
  const user = String(basicAuth.user ?? "").trim();

  return {
    nodeId,
    name,
    type,
    localIP,
    localPort,
    subdomain,
    customDomains,
    remotePort: type === "http" || type === "https" ? null : remotePort,
    publicPorts,
    ipAllow,
    ipDeny,
    enabled: (input.enabled ?? existing?.enabled ?? true) !== false,
    healthCheck: (input.healthCheck ?? existing?.healthCheck ?? false) === true,
    basicAuth: { user, password: user ? String(basicAuth.password ?? "") : "" },
    notes: String(input.notes ?? existing?.notes ?? "").slice(0, 200),
  };
}

export function createTunnel(input = {}) {
  return mutate((db) => {
    const t = normalizeTunnel(db, input, null);
    const tunnel = { id: newId("tun"), ...t, createdAt: nowISO() };
    db.tunnels.push(tunnel);
    return tunnel;
  });
}

export function updateTunnel(id, input = {}) {
  return mutate((db) => {
    const tunnel = db.tunnels.find((t) => t.id === id);
    if (!tunnel) throw httpError(404, "Túnel no encontrado");
    Object.assign(tunnel, normalizeTunnel(db, input, tunnel));
    return tunnel;
  });
}

export function deleteTunnel(id) {
  return mutate((db) => {
    const tunnel = db.tunnels.find((t) => t.id === id);
    if (!tunnel) throw httpError(404, "Túnel no encontrado");
    db.tunnels = db.tunnels.filter((t) => t.id !== id);
    return tunnel;
  });
}

/** Siguiente puerto remoto libre sugerido para tcp/udp. */
export function suggestRemotePort() {
  const db = read();
  const used = new Set(db.tunnels.map((t) => t.remotePort).filter(Boolean));
  for (let p = 6100; p < 65000; p++) if (!used.has(p)) return p;
  return 6100;
}

/* ------------------------------------------------------------------ */
/* Configuración del servidor                                          */
/* ------------------------------------------------------------------ */

export function updateSettings(patch = {}) {
  return mutate((db) => {
    const s = db.settings;

    if (patch.serverAddr !== undefined) {
      const v = String(patch.serverAddr).trim();
      if (!v) throw httpError(400, "La dirección pública del servidor es obligatoria");
      s.serverAddr = v;
    }
    if (patch.bindPort !== undefined) s.bindPort = num(patch.bindPort, s.bindPort, 1);
    if (patch.vhostHTTPPort !== undefined) {
      s.vhostHTTPPort = num(patch.vhostHTTPPort, s.vhostHTTPPort, 0);
    }
    if (patch.vhostHTTPSPort !== undefined) {
      s.vhostHTTPSPort = num(patch.vhostHTTPSPort, s.vhostHTTPSPort, 0);
    }
    if (patch.subDomainHost !== undefined) {
      const v = String(patch.subDomainHost)
        .trim()
        .toLowerCase()
        .replace(/^\*\./, "")
        .replace(/\.$/, "");
      if (v && !DOMAIN_RE.test(v)) {
        throw httpError(400, "El dominio base no es válido (ejemplo: eds.dev)");
      }
      s.subDomainHost = v;
    }
    if (patch.publicScheme !== undefined) {
      s.publicScheme = patch.publicScheme === "https" ? "https" : "http";
    }
    if (patch.panelUrl !== undefined) {
      s.panelUrl = String(patch.panelUrl || "")
        .trim()
        .replace(/\/+$/, "");
    }
    if (patch.frpcAdminPort !== undefined) {
      s.frpcAdminPort = num(patch.frpcAdminPort, s.frpcAdminPort, 1);
    }
    if (patch.autoRestart !== undefined) s.autoRestart = patch.autoRestart !== false;

    if (patch.adminApi && typeof patch.adminApi === "object") {
      if (patch.adminApi.host !== undefined) {
        s.adminApi.host = String(patch.adminApi.host).trim() || "127.0.0.1";
      }
      if (patch.adminApi.port !== undefined) {
        s.adminApi.port = num(patch.adminApi.port, s.adminApi.port, 1);
      }
      if (patch.adminApi.user !== undefined) s.adminApi.user = String(patch.adminApi.user);
      if (patch.adminApi.password !== undefined) {
        s.adminApi.password = String(patch.adminApi.password);
      }
    }

    if (patch.regenerateToken) s.authToken = newSecret();
    if (patch.regenerateAdminPassword) s.adminApi.password = newSecret();
    if (patch.regenerateFrpcAdminPassword) s.frpcAdminPassword = newSecret();

    return s;
  });
}

/* ------------------------------------------------------------------ */
/* Utilidades de presentación                                          */
/* ------------------------------------------------------------------ */

export function tunnelUrl(t, s = getSettings()) {
  const scheme = s.publicScheme === "https" ? "https" : "http";
  if (t.type === "http" || t.type === "https") {
    const domain = t.customDomains?.[0] || (t.subdomain && s.subDomainHost ? `${t.subdomain}.${s.subDomainHost}` : "");
    return domain ? `${scheme}://${domain}` : "";
  }
  return s.serverAddr && t.remotePort ? `${t.type}://${s.serverAddr}:${t.remotePort}` : "";
}
