import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, env } from "./config.js";

export const COOKIE_NAME = "eds_session";
const SECRET_FILE = path.join(DATA_DIR, ".session-secret");

let secret = env.sessionSecret;

function getSecret() {
  if (secret) return secret;
  try {
    secret = fs.readFileSync(SECRET_FILE, "utf8").trim();
  } catch {
    /* aún no existe */
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  }
  return secret;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Hash de contraseña con scrypt (sal fija: solo se comparan hashes en memoria). */
function digest(value) {
  return crypto.scryptSync(String(value), "frpc-eds", 32);
}

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Comprueba usuario + contraseña del panel contra la configuración. */
export function checkCredentials(user, password) {
  const okUser = safeEqual(digest(user), digest(env.user));
  const okPass = safeEqual(digest(password), digest(env.password));
  return okUser && okPass;
}

/** Crea el token de sesión: payload firmado con HMAC-SHA256. */
export function createSession(user) {
  const payload = {
    u: user,
    exp: Date.now() + env.sessionHours * 3600 * 1000,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
  if (!safeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Sesión válida de la petición, o null. */
export function getSession(req) {
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}

export function sessionCookie(token, secure = false) {
  const maxAge = Math.round(env.sessionHours * 3600);
  const flags = [`Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=${maxAge}`];
  if (secure) flags.push("Secure");
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${flags.join("; ")}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ------------------------------------------------------------------ */
/* Limitador simple de intentos de login                               */
/* ------------------------------------------------------------------ */

const attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export function loginAllowed(ip) {
  const entry = attempts.get(ip);
  if (!entry) return true;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(ip);
    return true;
  }
  return entry.count < MAX_ATTEMPTS;
}

export function registerFailure(ip) {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
  } else {
    entry.count += 1;
  }
}

export function registerSuccess(ip) {
  attempts.delete(ip);
}
