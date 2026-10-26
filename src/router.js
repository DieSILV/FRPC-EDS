/**
 * Router mínimo con soporte de parámetros (:id) para el servidor HTTP nativo.
 */

function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/[.+*?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return "/([^/]+)";
    });
  return { re: new RegExp(`^${source}/?$`), keys };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const { re, keys } = compile(pattern);
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) {
    return this.add("GET", p, h);
  }

  post(p, h) {
    return this.add("POST", p, h);
  }

  put(p, h) {
    return this.add("PUT", p, h);
  }

  delete(p, h) {
    return this.add("DELETE", p, h);
  }

  /** Devuelve { handler, params } o null. */
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.re.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return null;
  }
}
