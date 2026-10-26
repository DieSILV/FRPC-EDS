import { frpcBinary } from "./config.js";

const TYPES = ["http", "https", "tcp", "udp", "tcpmux"];

let cache = { at: 0, key: "", value: null };

export function adminBase(settings) {
  return `http://${settings.adminApi.host}:${settings.adminApi.port}`;
}

function authHeader(settings) {
  const { user, password } = settings.adminApi;
  if (!user) return {};
  return {
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
  };
}

async function getJson(url, settings, timeout = 2500) {
  const res = await fetch(url, {
    headers: authHeader(settings),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

/**
 * Estado del frps leído desde su API de administración.
 * Devuelve { online, error, info, proxies: Map<name, proxy> }.
 * Cachea 2s para no saturar la API con el polling del panel.
 */
export async function getStatus(settings, { force = false } = {}) {
  const key = adminBase(settings);
  if (!force && cache.value && cache.key === key && Date.now() - cache.at < 2000) {
    return cache.value;
  }

  let value;
  try {
    const info = await getJson(`${key}/api/serverinfo`, settings);
    const lists = await Promise.all(
      TYPES.map((type) =>
        getJson(`${key}/api/proxy/${type}`, settings).catch(() => ({ proxies: [] })),
      ),
    );
    const proxies = new Map();
    for (const list of lists) {
      for (const proxy of list?.proxies || []) {
        proxies.set(proxy.name, proxy);
      }
    }
    value = { online: true, error: null, info, proxies };
  } catch (err) {
    value = {
      online: false,
      error: err?.message || String(err),
      info: null,
      proxies: new Map(),
    };
  }

  cache = { at: Date.now(), key, value };
  return value;
}

export function frpcPath() {
  return frpcBinary();
}
