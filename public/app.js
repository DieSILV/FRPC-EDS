/* ==================================================================
   FRPC-EDS — lógica del panel
   ================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  data: null,
  tab: "tunnels",
  logs: [],
  es: null,
  timer: null,
  frpsConfig: null,
  filters: { tunnels: "", nodes: "", access: "" },
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .2s";
    setTimeout(() => el.remove(), 220);
  }, 3200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copiado al portapapeles");
  } catch {
    toast("No se pudo copiar", "bad");
  }
}

/* ------------------------------------------------------------------ */
/* Cliente de API                                                      */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const init = { method: options.method || "GET", headers: {} };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Sesión expirada");
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Carga y refresco                                                    */
/* ------------------------------------------------------------------ */

async function refresh(silent = false) {
  state.data = await api("/api/overview");
  renderHeader();
  renderStats();
  renderTunnels();
  renderNodes();
  if (state.tab === "access") renderAccess();
  if (!silent) {
    if (state.tab === "agent") renderAgent();
    if (state.tab === "server") renderServer();
  } else if (state.tab === "agent") {
    updateAgentBits();
  }
}

function renderView(tab) {
  if (tab === "tunnels") {
    renderStats();
    renderTunnels();
  }
  if (tab === "nodes") renderNodes();
  if (tab === "access") renderAccess();
  if (tab === "agent") renderAgent();
  if (tab === "server") renderServer();
}

async function afterMutation(message, { toastOk = true } = {}) {
  if (toastOk && message) toast(message);
  await refresh(false);
  renderView(state.tab);
}

/* ------------------------------------------------------------------ */
/* Render: cabecera y estadísticas                                     */
/* ------------------------------------------------------------------ */

function renderHeader() {
  const { frps, settings } = state.data;
  const pill = $("#frps-pill");

  if (frps.online) {
    pill.className = "pill ok";
    pill.innerHTML = `<span class="dot online"></span> FRPS ${esc(frps.version || "")} en línea`;
    pill.title = `API ${frps.adminBase}`;
  } else {
    pill.className = "pill bad";
    pill.innerHTML = `<span class="dot error"></span> FRPS sin respuesta`;
    pill.title = frps.error || "No se pudo contactar la API de administración";
  }

  $("#domain-chip").textContent = settings.subDomainHost
    ? `*.${settings.subDomainHost}`
    : "sin dominio base";
}

function renderStats() {
  const { stats, settings } = state.data;
  const cards = [
    {
      cls: "accent",
      label: "Túneles activos",
      value: `${stats.online}<small> / ${stats.total}</small>`,
    },
    { cls: "info", label: "Servidores", value: String(stats.nodes) },
    { cls: "", label: "Conexiones ahora", value: String(stats.curConns) },
    {
      cls: "warn",
      label: "Tráfico hoy",
      value: `<span style="font-size:19px">↓ ${fmtBytes(stats.trafficIn)}</span>
              <div class="tiny muted">↑ ${fmtBytes(stats.trafficOut)}</div>`,
    },
  ];

  $("#stats").innerHTML = cards
    .map(
      (c) => `<div class="stat ${c.cls}">
        <div class="label">${esc(c.label)}</div>
        <div class="value">${c.value}</div>
      </div>`,
    )
    .join("");

  const alerts = [];
  if (!settings.subDomainHost) {
    alerts.push(`<div class="banner warn"><span>⚠️</span><div>
      Todavía no hay <strong>dominio base</strong> configurado, así que los subdominios no se pueden resolver.
      <button class="btn sm ghost" data-act="goto-server">Configurar</button></div></div>`);
  }
  if (!state.data.frps.online) {
    alerts.push(`<div class="banner bad"><span>⛔</span><div>
      No se puede contactar el servidor FRP en <code class="mono">${esc(state.data.frps.adminBase)}</code>.
      <span class="tiny">${esc(state.data.frps.error || "")}</span>
      <button class="btn sm ghost" data-act="goto-server">Revisar</button></div></div>`);
  }
  const localNode = state.data.nodes.find((n) => n.mode === "local");
  const localTunnels = state.data.tunnels.filter((t) => t.enabled && t.nodeId === localNode?.id);
  if (localNode && localTunnels.length && state.data.agent.status !== "running") {
    alerts.push(`<div class="banner warn"><span>💡</span><div>
      <strong>${localTunnels.length}</strong> túnel(es) están asignados a <strong>este droplet</strong> y el agente local está detenido.
      Si esos servicios están en otra máquina (la de cada empresa), edita el túnel y elige su servidor.
      <button class="btn sm ghost" data-act="goto-agent">Abrir agente local</button></div></div>`);
  }
  $("#tunnel-alerts").innerHTML = alerts.join("");
}

/* ------------------------------------------------------------------ */
/* Render: túneles                                                     */
/* ------------------------------------------------------------------ */

function tunnelRow(t) {
  const statusDot = t.online ? "online" : t.enabled ? "offline" : "offline";
  const statusText = t.online ? "en línea" : t.enabled ? "sin conexión" : "deshabilitado";
  const target = `${t.localIP}:${t.localPort}`;
  const traffic = fmtBytes((t.todayTrafficIn || 0) + (t.todayTrafficOut || 0));

  return `<tr data-id="${esc(t.id)}">
    <td>
      <div class="cell-title"><span class="dot ${statusDot}"></span>${esc(t.name)}</div>
      <div class="cell-sub">${esc(t.nodeName)} · <span class="badge ${esc(t.type)}">${esc(t.type)}</span>${(t.ipAllow || []).length ? " · 🔒" : ""}</div>
    </td>
    <td data-label="URL">${
      t.url
        ? `<a class="mono" href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.url.replace(/^https?:\/\//, ""))}</a>` +
          (t.extraUrls || [])
            .map(
              (u) =>
                `<div class="cell-sub mono"><a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(u.replace(/^https?:\/\//, ""))}</a></div>`,
            )
            .join("")
        : '<span class="muted">—</span>'
    }</td>
    <td class="mono" data-label="Destino">${esc(target)}</td>
    <td data-label="Estado"><span class="badge ${t.online ? "ok" : "off"}">${esc(statusText)}</span></td>
    <td class="mono tiny" data-label="Alta" title="Fecha de alta">${esc(fmtDate(t.createdAt))}</td>
    <td class="mono tiny" data-label="Tráfico">${traffic}${t.curConns ? ` · ${t.curConns} conn` : ""}</td>
    <td>
      <div class="row-actions">
        ${t.url ? `<button class="btn sm ghost" data-act="copy-url" data-id="${esc(t.id)}">URL</button>` : ""}
        <button class="btn sm primary" data-act="node-config" data-id="${esc(t.nodeId)}">Instalar</button>
        <button class="btn sm ghost" data-act="edit-tunnel" data-id="${esc(t.id)}">Editar</button>
        <button class="btn sm ghost" data-act="toggle-tunnel" data-id="${esc(t.id)}">${t.enabled ? "Pausar" : "Activar"}</button>
        <button class="btn sm danger" data-act="delete-tunnel" data-id="${esc(t.id)}">Eliminar</button>
      </div>
    </td>
  </tr>`;
}

function renderTunnels() {
  const { tunnels } = state.data;
  const q = state.filters.tunnels.trim().toLowerCase();
  const list = q
    ? tunnels.filter((t) =>
        [t.name, t.subdomain, t.url, t.nodeName, String(t.localPort), t.notes]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : tunnels;

  $("#tunnels-sub").textContent = tunnels.length ? `(${list.length} de ${tunnels.length})` : "";

  if (!tunnels.length) {
    $("#tunnels-body").innerHTML = `<div class="empty">
      <h3>Sin túneles todavía</h3>
      <p>Un túnel conecta un puerto local de un servidor con un subdominio público. Crea el primero para empezar.</p>
      <button class="btn primary" data-act="new-tunnel">+ Nuevo túnel</button>
    </div>`;
    return;
  }

  if (!list.length) {
    $("#tunnels-body").innerHTML = `<div class="empty"><h3>Sin resultados</h3><p>Ningún túnel coincide con “${esc(state.filters.tunnels)}”.</p></div>`;
    return;
  }

  $("#tunnels-body").innerHTML = `<div class="table-wrap"><table class="table wide">
    <thead><tr>
      <th>Túnel</th><th>URL pública</th><th>Destino local</th><th>Estado</th><th>Alta</th><th>Tráfico hoy</th><th></th>
    </tr></thead>
    <tbody>${list.map(tunnelRow).join("")}</tbody>
  </table></div>`;
}

/* ------------------------------------------------------------------ */
/* Render: servidores                                                  */
/* ------------------------------------------------------------------ */

function nodeRow(n) {
  const isLocal = n.mode === "local";
  const last = n.lastLoginAt ? fmtDate(n.lastLoginAt) : "sin conexiones";
  return `<tr data-id="${esc(n.id)}">
    <td>
      <div class="cell-title"><span class="dot ${isLocal ? "online" : "offline"}"></span>${esc(n.name)}</div>
      <div class="cell-sub">${isLocal ? "frpc en este host" : "Servidor remoto"} · ${esc(n.slug)} · ${esc(last)}</div>
    </td>
    <td data-label="Tipo"><span class="badge ${isLocal ? "ok" : "off"}">${isLocal ? "local" : "remoto"}</span></td>
    <td class="mono tiny" data-label="Túneles">${n.onlineCount}/${n.tunnelCount}</td>
    <td class="mono tiny" data-label="Alta" title="Fecha de alta">${esc(fmtDate(n.createdAt))}</td>
    <td>
      <div class="row-actions">
        <button class="btn sm primary" data-act="node-config" data-id="${esc(n.id)}">Token y config</button>
        <button class="btn sm ghost" data-act="edit-node" data-id="${esc(n.id)}">Renombrar</button>
        ${
          isLocal
            ? ""
            : `<button class="btn sm danger" data-act="delete-node" data-id="${esc(n.id)}">Eliminar</button>`
        }
      </div>
    </td>
  </tr>`;
}

function renderNodes() {
  const { nodes } = state.data;
  const q = state.filters.nodes.trim().toLowerCase();
  const list = q
    ? nodes.filter((n) =>
        [n.name, n.slug, n.mode]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : nodes;

  if (!list.length) {
    $("#nodes-body").innerHTML = `<div class="empty"><h3>Sin resultados</h3><p>Ningún servidor coincide con “${esc(state.filters.nodes)}”.</p></div>`;
    return;
  }

  $("#nodes-body").innerHTML = `<div class="table-wrap"><table class="table">
    <thead><tr><th>Servidor</th><th>Tipo</th><th>Túneles</th><th>Alta</th><th></th></tr></thead>
    <tbody>${list.map(nodeRow).join("")}</tbody>
  </table></div>`;
}

/* ------------------------------------------------------------------ */
/* Render: accesos (listas blancas / negras)                           */
/* ------------------------------------------------------------------ */

function accessRow(t) {
  const allow = (t.ipAllow || []).length;
  const deny = (t.ipDeny || []).length;
  const auth = t.basicAuth?.user ? `sí (${t.basicAuth.user})` : "—";
  return `<tr data-id="${esc(t.id)}">
    <td>
      <div class="cell-title">${allow ? "🔒 " : ""}${esc(t.name)}</div>
      <div class="cell-sub">${esc(t.nodeName)} · ${esc(t.url ? t.url.replace(/^https?:\/\//, "") : "—")}${(t.blockedPaths || []).length ? " · 🚫 rutas bloqueadas" : ""}</div>
    </td>
    <td class="mono tiny" data-label="Lista blanca">${allow ? esc((t.ipAllow || []).join(", ")) : '<span class="muted">abierto (cualquiera)</span>'}</td>
    <td class="mono tiny" data-label="Lista negra">${deny ? esc((t.ipDeny || []).join(", ")) : '<span class="muted">—</span>'}</td>
    <td class="tiny" data-label="Basic Auth">${esc(auth)}</td>
    <td>
      <div class="row-actions">
        <button class="btn sm primary" data-act="edit-access" data-id="${esc(t.id)}">Editar accesos</button>
      </div>
    </td>
  </tr>`;
}

function renderAccess() {
  const { tunnels, nodes } = state.data;
  const q = state.filters.access.trim().toLowerCase();
  const list = q
    ? tunnels.filter((t) =>
        [t.name, t.url, t.nodeName, (t.ipAllow || []).join(" "), (t.ipDeny || []).join(" ")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : tunnels;

  if (!list.length) {
    $("#access-body").innerHTML = `<div class="empty"><h3>Sin resultados</h3><p>${
      q ? `Ningún túnel coincide con “${esc(state.filters.access)}”.` : "Crea un túnel para configurar sus accesos."
    }</p></div>`;
  } else {
    $("#access-body").innerHTML = `<div class="table-wrap"><table class="table wide">
      <thead><tr><th>Túnel</th><th>Lista blanca</th><th>Lista negra</th><th>Basic Auth</th><th></th></tr></thead>
      <tbody>${list.map(accessRow).join("")}</tbody>
    </table></div>`;
  }

  $("#access-nodes").innerHTML = `<div class="table-wrap"><table class="table">
    <thead><tr><th>Máquina</th><th>IPs autorizadas</th><th></th></tr></thead>
    <tbody>${nodes
      .map(
        (n) => `<tr data-id="${esc(n.id)}">
      <td>
        <div class="cell-title">${esc(n.name)}</div>
        <div class="cell-sub">${n.mode === "local" ? "este droplet" : `remota · ${esc(n.slug)}`}</div>
      </td>
      <td class="mono tiny" data-label="IPs autorizadas">${
        (n.allowedIps || []).length
          ? esc((n.allowedIps || []).join(", "))
          : '<span class="muted">cualquiera con su token</span>'
      }</td>
      <td><button class="btn sm ghost" data-act="edit-node-access" data-id="${esc(n.id)}">Editar</button></td>
    </tr>`,
      )
      .join("")}</tbody>
  </table></div>`;
}

/* ------------------------------------------------------------------ */
/* Render: agente local                                                */
/* ------------------------------------------------------------------ */

const AGENT_LABEL = {
  stopped: ["detenido", ""],
  starting: ["iniciando…", "starting"],
  running: ["en ejecución", "online"],
  stopping: ["deteniendo…", "starting"],
  error: ["error", "error"],
};

function logLine(entry) {
  const time = new Date(entry.t).toLocaleTimeString("es-ES");
  return `<div class="log-line ${esc(entry.stream)}"><time>${esc(time)}</time><span class="txt">${esc(entry.line)}</span></div>`;
}

function renderLogs() {
  const box = $("#log-box");
  if (!box) return;
  box.innerHTML = state.logs.length
    ? state.logs.map(logLine).join("")
    : '<div class="log-line"><span class="txt muted">Sin actividad todavía.</span></div>';
  box.scrollTop = box.scrollHeight;
}

function updateAgentBits() {
  const agent = state.data.agent;
  const [label, dotCls] = AGENT_LABEL[agent.status] || [agent.status, ""];
  const text = $("#agent-status-text");
  if (text) text.innerHTML = `<span class="dot ${dotCls}"></span> ${esc(label)}`;

  const actions = $("#agent-actions");
  if (actions) {
    actions.innerHTML = agent.pid
      ? `<button class="btn ghost" data-act="agent-restart">Reiniciar</button>
         <button class="btn danger" data-act="agent-stop">Detener</button>`
      : `<button class="btn primary" data-act="agent-start">Iniciar agente</button>`;
  }
}

function renderAgent() {
  const agent = state.data.agent;
  const [label, dotCls] = AGENT_LABEL[agent.status] || [agent.status, ""];

  $("#agent-actions").innerHTML = agent.pid
    ? `<button class="btn ghost" data-act="agent-restart">Reiniciar</button>
       <button class="btn danger" data-act="agent-stop">Detener</button>`
    : `<button class="btn primary" data-act="agent-start">Iniciar agente</button>`;

  $("#agent-body").innerHTML = `
    <div class="stats">
      <div class="stat ${agent.status === "running" ? "accent" : "warn"}">
        <div class="label">Estado</div>
        <div class="value" style="font-size:17px" id="agent-status-text">
          <span class="dot ${dotCls}"></span> ${esc(label)}
        </div>
      </div>
      <div class="stat"><div class="label">PID</div><div class="value" style="font-size:18px">${agent.pid ?? "—"}</div></div>
      <div class="stat"><div class="label">Iniciado</div><div class="value" style="font-size:15px">${esc(fmtDate(agent.startedAt))}</div></div>
      <div class="stat"><div class="label">Reinicios</div><div class="value" style="font-size:18px">${agent.restarts}</div></div>
    </div>
    <div class="form-grid" style="margin-top:14px">
      <div class="field">
        <label>Binario</label>
        <div class="mono tiny muted">${esc(agent.binary || "no detectado")}</div>
      </div>
      <div class="field">
        <label>Configuración</label>
        <div class="mono tiny muted">${esc(agent.configPath || "—")}</div>
      </div>
      <div class="field">
        <label>Última salida</label>
        <div class="mono tiny muted">${esc(agent.lastExit || "—")} ${agent.exitedAt ? `· ${esc(fmtDate(agent.exitedAt))}` : ""}</div>
      </div>
    </div>`;

  renderLogs();
}

/* ------------------------------------------------------------------ */
/* Render: servidor (configuración)                                    */
/* ------------------------------------------------------------------ */

function renderServer() {
  const s = state.data.settings;
  const view = $("#view-server");

  view.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Configuración del servidor</h2>
        <div class="card-actions">
          <button class="btn ghost" data-act="test-frps">Probar conexión</button>
          <button class="btn primary" data-act="save-settings">Guardar cambios</button>
        </div>
      </div>
      <form class="card-body form-grid" id="settings-form" autocomplete="off">
        <div class="grid-2">
          <div class="field">
            <label>Dirección pública (los clientes se conectan aquí)</label>
            <input type="text" name="serverAddr" class="mono" value="${esc(s.serverAddr)}" />
            <span class="hint">IP o dominio donde corre frps, visible desde fuera.</span>
          </div>
          <div class="field">
            <label>Dominio base para subdominios</label>
            <input type="text" name="subDomainHost" class="mono" value="${esc(s.subDomainHost)}" placeholder="eds.dev" />
            <span class="hint">Con subdominio <code>qpos</code> se publica en <code>qpos.${esc(s.subDomainHost || "eds.dev")}</code>.</span>
          </div>
        </div>

        <div class="grid-2">
          <div class="field"><label>Puerto del túnel (bindPort)</label><input type="number" name="bindPort" value="${s.bindPort}" /></div>
          <div class="field"><label>Puerto HTTP virtual</label><input type="number" name="vhostHTTPPort" value="${s.vhostHTTPPort}" /></div>
          <div class="field"><label>Puerto HTTPS virtual</label><input type="number" name="vhostHTTPSPort" value="${s.vhostHTTPSPort}" /><span class="hint">0 = desactivado (si terminas TLS en Caddy/nginx).</span></div>
          <div class="field"><label>Esquema de las URLs públicas</label>
            <select name="publicScheme">
              <option value="http" ${s.publicScheme === "http" ? "selected" : ""}>http</option>
              <option value="https" ${s.publicScheme === "https" ? "selected" : ""}>https</option>
            </select>
          </div>
        </div>

        <div class="grid-2">
          <div class="field"><label>API admin frps · host</label><input type="text" name="adminHost" class="mono" value="${esc(s.adminApi.host)}" /></div>
          <div class="field"><label>API admin frps · puerto</label><input type="number" name="adminPort" value="${s.adminApi.port}" /></div>
          <div class="field"><label>API admin frps · usuario</label><input type="text" name="adminUser" value="${esc(s.adminApi.user)}" /></div>
          <div class="field"><label>API admin frps · contraseña</label><input type="text" name="adminPassword" class="mono" value="${esc(s.adminApi.password)}" /></div>
        </div>

        <label class="check">
          <input type="checkbox" name="autoRestart" ${s.autoRestart ? "checked" : ""} />
          Reiniciar automáticamente el agente local si se cae
        </label>

        <div class="field">
          <label>Token maestro interno (auth.token)</label>
          <div class="input-group">
            <input type="text" class="mono" value="${esc(s.authToken)}" readonly />
            <span class="suffix"><button class="btn sm ghost" type="button" data-act="regen-token">Regenerar</button></span>
          </div>
          <span class="hint">frp lo usa también como clave del canal de control, así que frps y frpc lo comparten: el panel lo genera y lo inyecta en cada configuración. El token que reparte a cada servidor está en la pestaña <strong>Servidores</strong>. Regenerarlo obliga a redesplegar todos los clientes.</span>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Servidor FRP (frps)</h2>
        <div class="card-actions">
          <button class="btn ghost" data-act="copy-frps">Copiar config</button>
          <a class="btn ghost" href="/api/server/frps.toml">Descargar frps.toml</a>
          <button class="btn ghost" data-act="reload-frps">Ver config</button>
        </div>
      </div>
      <pre class="log-box" id="frps-config" style="height:260px">${esc(state.frpsConfig || "# Pulsa «Ver config» para cargar el frps.toml generado")}</pre>
    </div>

    <div class="card">
      <div class="card-head"><h2>Puesta en marcha</h2></div>
      <div class="card-body form-grid">
        <div class="banner"><span>1</span><div><strong>DNS wildcard</strong> — crea un registro <code class="mono">A</code> para <code class="mono">*.${esc(s.subDomainHost || "tudominio.com")}</code> apuntando a <code class="mono">${esc(s.serverAddr)}</code>. Sin esto los subdominios no resuelven.</div></div>
        <div class="banner"><span>2</span><div><strong>Puertos abiertos</strong> — <code class="mono">${s.bindPort}/tcp</code> (túneles), <code class="mono">${s.vhostHTTPPort || "—"}/tcp</code> HTTP${s.vhostHTTPSPort ? ` y <code class="mono">${s.vhostHTTPSPort}/tcp</code> HTTPS` : ""}.</div></div>
        <div class="banner"><span>3</span><div><strong>Arranca frps</strong> — <code class="mono">npm run frps</code> para pruebas; en producción usa el servicio de <code class="mono">deploy/</code>.</div></div>
        <div class="banner"><span>4</span><div><strong>Panel siempre disponible</strong> — frps valida el token de cada servidor contra el panel (<code class="mono">/api/frp/plugin</code>). Si el panel está caído, ningún cliente puede conectarse.</div></div>
        <div class="banner"><span>5</span><div><strong>HTTPS</strong> — para certificados automáticos coloca Caddy o nginx delante de frps (ver <code class="mono">deploy/</code>). frps no emite certificados por sí solo.</div></div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Modales                                                             */
/* ------------------------------------------------------------------ */

function closeModal() {
  $("#modal-root").innerHTML = "";
}

function openModal({ title, body, submitLabel = "Guardar", onSubmit, hideCancel = false }) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="icon-btn" type="button" data-close>✕</button>
        </div>
        <form class="modal-body">
          ${body}
          <div class="modal-foot">
            ${hideCancel ? "" : '<button class="btn ghost" type="button" data-close>Cancelar</button>'}
            <button class="btn primary" type="submit">${esc(submitLabel)}</button>
          </div>
        </form>
      </div>
    </div>`;

  const form = $("form", root);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      await onSubmit(form);
      closeModal();
    } catch (err) {
      toast(err.message, "bad");
      submit.disabled = false;
    }
  });

  const first = form.querySelector("input:not([readonly]), select, textarea");
  if (first) first.focus();
}

function openTunnelModal(tunnel) {
  const { nodes, settings } = state.data;
  const local = nodes.find((n) => n.mode === "local") || nodes[0];
  const hasRemote = nodes.some((n) => n.mode !== "local");
  const current = tunnel || {
    // Por defecto se propone crear el servidor de la empresa: no queremos que
    // todos los túneles acaben en el nodo local por descuido.
    nodeId: hasRemote ? local?.id : "__new",
    name: "",
    type: "http",
    localIP: "127.0.0.1",
    localPort: "",
    subdomain: "",
    customDomains: [],
    remotePort: "",
    enabled: true,
    healthCheck: false,
    notes: "",
  };

  const options =
    nodes
      .map(
        (n) =>
          `<option value="${esc(n.id)}" ${current.nodeId === n.id ? "selected" : ""}>${esc(n.name)}${n.mode === "local" ? " (local)" : ""}</option>`,
      )
      .join("") + `<option value="__new" ${current.nodeId === "__new" ? "selected" : ""}>+ Servidor nuevo…</option>`;

  openModal({
    title: tunnel ? `Editar túnel · ${tunnel.name}` : "Nuevo túnel",
    submitLabel: tunnel ? "Guardar cambios" : "Crear túnel",
    body: `
      <div class="grid-2">
        <div class="field">
          <label>Servidor</label>
          <select name="nodeId">${options}</select>
        </div>
        <div class="field">
          <label>Tipo</label>
          <select name="type">
            ${["http", "https", "tcp", "udp"]
              .map((t) => {
                const off = t === "https" && !settings.vhostHTTPSPort;
                return `<option value="${t}" ${current.type === t ? "selected" : ""} ${off ? "disabled" : ""}>${t.toUpperCase()}${off ? " (requiere puerto HTTPS virtual)" : ""}</option>`;
              })
              .join("")}
          </select>
        </div>
      </div>

      <div class="field is-hidden" data-new-server>
        <label>Nombre del servidor nuevo</label>
        <input type="text" name="newServerName" placeholder="VPS Lima, PC oficina…" maxlength="60" />
        <span class="hint">Se da de alta ahora mismo y el túnel pasa a ese servidor. Luego descargas su instalador en «Servidores».</span>
      </div>

      <div class="field">
        <label>Nombre del túnel</label>
        <input type="text" name="name" class="mono" value="${esc(current.name)}" placeholder="qpos" />
        <span class="hint">Identificador único en el servidor (letras, números, guiones).</span>
      </div>

      <div class="field" data-when="http">
        <label>Subdominio</label>
        <div class="input-group">
          <input type="text" name="subdomain" class="mono" value="${esc(current.subdomain)}" placeholder="qpos" />
          <span class="suffix">.${esc(settings.subDomainHost || "tudominio.com")}</span>
        </div>
      </div>

      <div class="field" data-when="http">
        <label>Dominios personalizados (opcional)</label>
        <input type="text" name="customDomains" class="mono" value="${esc((current.customDomains || []).join(", "))}" placeholder="app.otrodominio.com" />
        <span class="hint">Separados por coma. Deben apuntar a este servidor.</span>
      </div>

      <div class="field" data-when="http">
        <label>Puertos públicos adicionales (opcional)</label>
        <input type="text" name="publicPorts" class="mono" value="${esc((current.publicPorts || []).join(", "))}" placeholder="3001, 4173" />
        <span class="hint">Se publican como https://sub.dominio:PUERTO con TLS. Habilitados: 3000, 3001, 4173, 5173.</span>
      </div>

      <div class="grid-2">
        <div class="field">
          <label>IP / host local</label>
          <input type="text" name="localIP" class="mono" value="${esc(current.localIP)}" />
        </div>
        <div class="field">
          <label>Puerto local</label>
          <input type="number" name="localPort" min="1" max="65535" value="${esc(current.localPort)}" placeholder="8000" />
        </div>
      </div>

      <div class="field" data-when="tcp">
        <label>Puerto remoto (en el servidor FRP)</label>
        <div class="input-group">
          <input type="number" name="remotePort" min="1" max="65535" value="${esc(current.remotePort || "")}" placeholder="6100" />
          <span class="suffix"><button class="btn sm ghost" type="button" data-act="suggest-port">Sugerir</button></span>
        </div>
      </div>

      <label class="check">
        <input type="checkbox" name="healthCheck" ${current.healthCheck ? "checked" : ""} />
        Health check TCP cada 10 s (marca el túnel como caído si el servicio no responde)
      </label>

      <label class="check">
        <input type="checkbox" name="enabled" ${current.enabled ? "checked" : ""} />
        Túnel habilitado
      </label>

      <div class="field">
        <label>Notas (opcional)</label>
        <input type="text" name="notes" value="${esc(current.notes)}" maxlength="200" />
      </div>`,
    onSubmit: async (form) => {
      const fd = new FormData(form);
      const nodeId = String(fd.get("nodeId") || "");
      const payload = {
        name: fd.get("name"),
        type: fd.get("type"),
        subdomain: fd.get("subdomain") || "",
        customDomains: fd.get("customDomains") || "",
        publicPorts: fd.get("publicPorts") || "",
        localIP: fd.get("localIP"),
        localPort: Number(fd.get("localPort")),
        remotePort: Number(fd.get("remotePort") || 0),
        healthCheck: fd.get("healthCheck") === "on",
        enabled: fd.get("enabled") === "on",
        notes: fd.get("notes") || "",
      };
      if (nodeId === "__new") {
        const newServerName = String(fd.get("newServerName") || "").trim();
        if (!newServerName) throw new Error("Escribe el nombre del servidor nuevo");
        payload.newServerName = newServerName;
      } else {
        payload.nodeId = nodeId;
      }
      if (tunnel) {
        await api(`/api/tunnels/${tunnel.id}`, { method: "PUT", body: payload });
      } else {
        await api("/api/tunnels", { method: "POST", body: payload });
      }
      await afterMutation(
        tunnel
          ? "Túnel actualizado"
          : payload.newServerName
            ? "Túnel creado · servidor nuevo dado de alta"
            : "Túnel creado",
      );
    },
  });

  // Visibilidad de campos según el tipo
  const form = $("#modal-root form");
  const nodeSelect = form.querySelector('[name="nodeId"]');
  const newServerField = form.querySelector("[data-new-server]");
  if (nodeSelect && newServerField) {
    const syncNode = () =>
      newServerField.classList.toggle("is-hidden", nodeSelect.value !== "__new");
    nodeSelect.addEventListener("change", syncNode);
    syncNode();
  }

  const typeSelect = form.querySelector('[name="type"]');
  const sync = () => {
    const isWeb = typeSelect.value === "http" || typeSelect.value === "https";
    form.querySelectorAll("[data-when]").forEach((el) => {
      const kind = el.dataset.when;
      el.classList.toggle("is-hidden", kind === "http" ? !isWeb : isWeb);
    });
  };
  typeSelect.addEventListener("change", sync);
  sync();
}

function openNodeModal(node) {
  const hasLocal = state.data.nodes.some((n) => n.mode === "local");

  openModal({
    title: node ? `Renombrar · ${node.name}` : "Agregar servidor",
    submitLabel: node ? "Guardar" : "Agregar",
    body: `
      <div class="field">
        <label>Nombre</label>
        <input type="text" name="name" value="${esc(node?.name || "")}" placeholder="Servidor de desarrollo" required maxlength="60" />
      </div>

      ${ipListField("allowedIps", "IPs autorizadas del servidor (opcional)", node?.allowedIps, "Si pones alguna, esta máquina solo podrá conectar desde esas IPs. Vacío = cualquiera con el token.", "38.137.206.45")}
      ${
        node
          ? ""
          : `<div class="field">
              <label>Tipo</label>
              <select name="mode">
                <option value="remote" selected>Remoto (otra máquina con frpc)</option>
                <option value="local" ${hasLocal ? "disabled" : ""}>Local (este host, gestionado por el panel)</option>
              </select>
              <span class="hint">El servidor local es donde el panel puede arrancar frpc como proceso.</span>
            </div>`
      }`,
    onSubmit: async (form) => {
      const fd = new FormData(form);
      if (node) {
        await api(`/api/nodes/${node.id}`, {
          method: "PUT",
          body: { name: fd.get("name"), allowedIps: readIpList(form, "allowedIps") },
        });
      } else {
        await api("/api/nodes", {
          method: "POST",
          body: {
            name: fd.get("name"),
            mode: fd.get("mode") || "remote",
            allowedIps: readIpList(form, "allowedIps"),
          },
        });
      }
      await afterMutation(node ? "Servidor actualizado" : "Servidor agregado");
    },
  });
  bindIpLists($("#modal-root form"));
}

function ipChip(value) {
  return `<span class="ip-chip" data-value="${esc(value)}">${esc(value)}<button type="button" class="ip-x" aria-label="Quitar">×</button></span>`;
}

/** Campo de lista de IPs como registros individuales (chips), no texto con comas. */
function ipListField(name, label, values, hint, placeholder) {
  return `<div class="field">
    <label>${esc(label)}</label>
    <div class="iplist" data-iplist="${esc(name)}">
      <div class="iplist-chips">${(values || []).map(ipChip).join("")}</div>
      <input type="text" class="mono" data-iplist-input placeholder="${esc(placeholder || "Añadir IP o rango y pulsar Enter")}" />
    </div>
    <span class="hint">${esc(hint || "")}</span>
  </div>`;
}

function bindIpLists(form) {
  if (!form) return;
  form.querySelectorAll("[data-iplist]").forEach((box) => {
    const input = box.querySelector("[data-iplist-input]");
    const chips = box.querySelector(".iplist-chips");
    const add = (raw) => {
      const value = String(raw || "").trim();
      if (!value) return;
      const dup = [...chips.querySelectorAll(".ip-chip")].some((c) => c.dataset.value === value);
      if (!dup) chips.insertAdjacentHTML("beforeend", ipChip(value));
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        add(input.value);
        input.value = "";
      } else if (event.key === "Backspace" && !input.value) {
        const last = chips.lastElementChild;
        if (last) last.remove();
      }
    });
    input.addEventListener("blur", () => {
      add(input.value);
      input.value = "";
    });
    box.addEventListener("click", (event) => {
      const x = event.target.closest(".ip-x");
      if (x) x.closest(".ip-chip").remove();
    });
  });
}

/** Lee los chips de una lista de IPs del formulario. */
function readIpList(form, name) {
  const box = form.querySelector(`[data-iplist="${name}"]`);
  if (!box) return [];
  return [...box.querySelectorAll(".ip-chip")].map((c) => c.dataset.value);
}

function bindPmaToggle(form) {
  const box = form.querySelector('[name="pma"]');
  if (!box) return;
  const chips = form.querySelector('[data-iplist="blockedPaths"] .iplist-chips');
  if (!chips) return;
  box.addEventListener("change", () => {
    const has = [...chips.querySelectorAll(".ip-chip")].some(
      (c) => c.dataset.value === "/phpmyadmin",
    );
    if (box.checked && !has) chips.insertAdjacentHTML("beforeend", ipChip("/phpmyadmin"));
    if (!box.checked && has) {
      [...chips.querySelectorAll(".ip-chip")]
        .filter((c) => c.dataset.value === "/phpmyadmin")
        .forEach((c) => c.remove());
    }
  });
}

function openAccessModal(tunnel) {
  openModal({
    title: `Accesos · ${tunnel.name}`,
    submitLabel: "Guardar accesos",
    body: `
      <div class="banner"><span>🔐</span><div>
        Se aplica a <code class="mono">${esc(tunnel.url || tunnel.name)}</code>.
        Acepta IP exacta o rango CIDR IPv4 (ej. <code class="mono">190.40.0.0/16</code>).
      </div></div>

      ${ipListField("ipAllow", "IPs permitidas · lista blanca", tunnel.ipAllow, "Si pones alguna, solo esas IPs pueden entrar.", "38.137.206.45")}

      ${ipListField("ipDeny", "IPs bloqueadas · lista negra", tunnel.ipDeny, "Tienen prioridad sobre la lista blanca.", "1.2.3.4")}

      <div class="grid-2">
        <div class="field">
          <label>Usuario (Basic Auth)</label>
          <input type="text" name="basicUser" value="${esc(tunnel.basicAuth?.user || "")}" autocomplete="off" placeholder="cliente" />
        </div>
        <div class="field">
          <label>Contraseña</label>
          <input type="text" name="basicPass" class="mono" value="${esc(tunnel.basicAuth?.password || "")}" autocomplete="off" />
        </div>
      </div>
      <span class="hint" style="margin-top:-8px">Con usuario, el navegador pide credenciales antes de entrar.</span>

      <label class="check">
        <input type="checkbox" name="pma" ${(tunnel.blockedPaths || []).includes("/phpmyadmin") ? "checked" : ""} />
        Bloquear phpMyAdmin
      </label>

      ${ipListField(
        "blockedPaths",
        "Rutas bloqueadas (por prefijo)",
        tunnel.blockedPaths,
        "Se bloquea la ruta y todo lo que cuelgue de ella. Ej: /admin, /server-status",
        "/phpmyadmin",
      )}`,
    onSubmit: async (form) => {
      const fd = new FormData(form);
      await api(`/api/tunnels/${tunnel.id}`, {
        method: "PUT",
        body: {
          ipAllow: readIpList(form, "ipAllow"),
          ipDeny: readIpList(form, "ipDeny"),
          blockedPaths: readIpList(form, "blockedPaths"),
          basicAuth: {
            user: fd.get("basicUser") || "",
            password: fd.get("basicPass") || "",
          },
        },
      });
      await afterMutation("Accesos actualizados");
    },
  });
  bindIpLists($("#modal-root form"));
  bindPmaToggle($("#modal-root form"));
}

function openNodeAccessModal(node) {
  openModal({
    title: `IPs autorizadas · ${node.name}`,
    submitLabel: "Guardar",
    body: `
      <div class="banner"><span>🖥️</span><div>
        Limita desde qué IP puede conectar el <code class="mono">frpc</code> de esta máquina.
        Aunque el token se filtre, no servirá desde otra IP.
      </div></div>
      ${ipListField("allowedIps", "IPs autorizadas (opcional)", node.allowedIps, "Vacío = cualquiera que tenga el token de esta máquina.", "38.137.206.45")}`,
    onSubmit: async (form) => {
      await api(`/api/nodes/${node.id}`, {
        method: "PUT",
        body: { allowedIps: readIpList(form, "allowedIps") },
      });
      await afterMutation("IPs del servidor actualizadas");
    },
  });
  bindIpLists($("#modal-root form"));
}

function openNodeConfigModal(node) {
  const base = `/api/nodes/${node.id}`;
  openModal({
    title: `Token y configuración · ${node.name}`,
    submitLabel: "Cerrar",
    body: `
      <div class="banner">
        <span>🔑</span>
        <div>
          Cada servidor tiene su <strong>propio token</strong>. Regenerarlo solo afecta a este
          servidor; los demás siguen funcionando.
        </div>
      </div>

      <div class="field">
        <label>Token de este servidor (<code>metadatas.auth_token</code>)</label>
        <input type="text" class="mono" readonly value="${esc(node.token)}" />
        <span class="hint">Identificador: <code>${esc(node.slug)}</code></span>
      </div>

      <div class="row-actions" style="justify-content:flex-start">
        <button class="btn sm ghost" type="button" data-act="copy-node-token" data-id="${esc(node.id)}">Copiar token</button>
        <button class="btn sm danger" type="button" data-act="rotate-node-token" data-id="${esc(node.id)}">Regenerar token</button>
      </div>

      <div class="field">
        <label>1. Descarga la configuración</label>
        ${
          node.mode === "local"
            ? `<div class="banner"><span>💡</span><div>
                Este es <strong>el droplet del panel</strong>. Su frpc lo arranca el propio panel desde
                <em>Agente local</em>. Su configuración <strong>no</strong> debe instalarse en otras máquinas:
                crea un servidor para cada empresa y usa su instalador.
                <button class="btn sm ghost" type="button" data-act="goto-agent">Abrir agente local</button>
              </div></div>`
            : `<div class="grid-2">
                <a class="btn ghost" href="${base}/frpc.toml">frpc.toml</a>
                ${
                  state.data?.capabilities?.windowsExe === false
                    ? `<a class="btn ghost" href="${base}/install.ps1">Instalador Windows (.ps1)</a>`
                    : `<a class="btn primary" href="${base}/install.exe">Instalador Windows (.exe)</a>
                       <a class="btn ghost" href="${base}/install.ps1">Script .ps1 (alternativa)</a>`
                }
                <a class="btn ghost" href="${base}/install.sh">Instalador Linux</a>
              </div>`
        }
      </div>

      <div class="field" ${node.mode === "local" ? 'style="display:none"' : ""}>
        <label>2. Ejecútala en el servidor</label>
        <div class="hint">
          Windows: doble clic en <code class="mono">install-frpc-${esc(node.id)}.exe</code> (solo UAC;
          frpc queda <strong>en segundo plano</strong>, sin ventanas)<br />
          Windows (alternativa): <code class="mono">powershell -ExecutionPolicy Bypass -File install-frpc.ps1</code><br />
          Linux: <code class="mono">sudo bash install-frpc.sh</code>
        </div>
      </div>
    `,
    onSubmit: async () => undefined,
    hideCancel: true,
  });
}

/* ------------------------------------------------------------------ */
/* Acciones                                                            */
/* ------------------------------------------------------------------ */
async function handleAction(act, el) {
  const id = el.dataset.id;

  switch (act) {
    case "new-tunnel":
      return openTunnelModal(null);

    case "edit-tunnel": {
      const tunnel = state.data.tunnels.find((t) => t.id === id);
      if (tunnel) openTunnelModal(tunnel);
      return;
    }

    case "toggle-tunnel": {
      const tunnel = state.data.tunnels.find((t) => t.id === id);
      if (!tunnel) return;
      await api(`/api/tunnels/${id}`, { method: "PUT", body: { enabled: !tunnel.enabled } });
      return afterMutation(tunnel.enabled ? "Túnel pausado" : "Túnel activado");
    }

    case "delete-tunnel": {
      const tunnel = state.data.tunnels.find((t) => t.id === id);
      if (!tunnel) return;
      if (!confirm(`¿Eliminar el túnel "${tunnel.name}"?`)) return;
      await api(`/api/tunnels/${id}`, { method: "DELETE" });
      return afterMutation("Túnel eliminado");
    }

    case "copy-url": {
      const tunnel = state.data.tunnels.find((t) => t.id === id);
      if (tunnel?.url) await copyText(tunnel.url);
      return;
    }

    case "new-node":
      return openNodeModal(null);

    case "node-config": {
      const node = state.data.nodes.find((n) => n.id === id);
      if (node) openNodeConfigModal(node);
      return;
    }

    case "edit-access": {
      const tunnel = state.data.tunnels.find((t) => t.id === id);
      if (tunnel) openAccessModal(tunnel);
      return;
    }

    case "edit-node-access": {
      const node = state.data.nodes.find((n) => n.id === id);
      if (node) openNodeAccessModal(node);
      return;
    }

    case "copy-node-token": {
      const node = state.data.nodes.find((n) => n.id === id);
      if (node) await copyText(node.token);
      return;
    }

    case "rotate-node-token": {
      const node = state.data.nodes.find((n) => n.id === id);
      if (!node) return;
      if (
        !confirm(
          `¿Regenerar el token de "${node.name}"? Su configuración actual dejará de autenticar hasta que la vuelvas a desplegar.`,
        )
      ) {
        return;
      }
      const res = await api(`/api/nodes/${id}/token`, { method: "POST", body: {} });
      await refresh(false);
      renderView(state.tab);
      openNodeConfigModal(res.node);
      toast("Token regenerado");
      return;
    }

    case "edit-node": {
      const node = state.data.nodes.find((n) => n.id === id);
      if (node) openNodeModal(node);
      return;
    }

    case "delete-node": {
      const node = state.data.nodes.find((n) => n.id === id);
      if (!node) return;
      if (!confirm(`¿Eliminar "${node.name}" y todos sus túneles?`)) return;
      await api(`/api/nodes/${id}`, { method: "DELETE" });
      return afterMutation("Servidor eliminado");
    }

    case "agent-start": {
      const res = await api("/api/agent/start", { method: "POST", body: {} });
      state.logs = [];
      await afterMutation("Agente iniciado");
      return res;
    }

    case "agent-stop":
      await api("/api/agent/stop", { method: "POST", body: {} });
      return afterMutation("Agente detenido");

    case "agent-restart":
      await api("/api/agent/restart", { method: "POST", body: {} });
      return afterMutation("Agente reiniciado");

    case "goto-server":
      return switchTab("server");

    case "goto-agent":
      return switchTab("agent");

    case "save-settings": {
      const form = $("#settings-form");
      const fd = new FormData(form);
      await api("/api/settings", {
        method: "PUT",
        body: {
          serverAddr: fd.get("serverAddr"),
          subDomainHost: fd.get("subDomainHost"),
          bindPort: Number(fd.get("bindPort")),
          vhostHTTPPort: Number(fd.get("vhostHTTPPort")),
          vhostHTTPSPort: Number(fd.get("vhostHTTPSPort")),
          publicScheme: fd.get("publicScheme"),
          autoRestart: fd.get("autoRestart") === "on",
          adminApi: {
            host: fd.get("adminHost"),
            port: Number(fd.get("adminPort")),
            user: fd.get("adminUser"),
            password: fd.get("adminPassword"),
          },
        },
      });
      state.frpsConfig = null;
      return afterMutation("Configuración guardada");
    }

    case "test-frps": {
      const res = await api("/api/settings/test-frps", { method: "POST", body: {} });
      if (res.online) {
        toast(`FRPS en línea · ${res.proxies.length} proxies · v${res.info?.version || "?"}`);
      } else {
        toast(`Sin conexión: ${res.error}`, "bad");
      }
      return;
    }

    case "regen-token": {
      if (!confirm("Regenerar el token invalida las configuraciones ya descargadas. ¿Continuar?")) return;
      await api("/api/settings", { method: "PUT", body: { regenerateToken: true } });
      state.frpsConfig = null;
      return afterMutation("Token regenerado");
    }

    case "reload-frps": {
      const res = await fetch("/api/server/frps.toml");
      state.frpsConfig = await res.text();
      const pre = $("#frps-config");
      if (pre) pre.textContent = state.frpsConfig;
      return;
    }

    case "copy-frps": {
      if (!state.frpsConfig) {
        const res = await fetch("/api/server/frps.toml");
        state.frpsConfig = await res.text();
      }
      return copyText(state.frpsConfig);
    }

    case "suggest-port": {
      const res = await api("/api/tunnels/suggest-port");
      const input = $("#modal-root input[name='remotePort']");
      if (input) input.value = res.remotePort;
      return;
    }

    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Navegación                                                          */
/* ------------------------------------------------------------------ */

function switchTab(tab) {
  state.tab = tab;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab}`));
  renderView(tab);
}

/* ------------------------------------------------------------------ */
/* Registro de eventos (SSE)                                           */
/* ------------------------------------------------------------------ */

function appendLog(entry) {
  const box = document.getElementById("log-box");
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const empty = box.querySelector(".muted");
  if (empty && box.childElementCount === 1) box.innerHTML = "";
  box.insertAdjacentHTML("beforeend", logLine(entry));
  while (box.childElementCount > 400) box.firstElementChild.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function startLogStream() {
  if (state.es) return;
  const es = new EventSource("/api/agent/logs/stream");
  es.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data);
      state.logs.push(entry);
      if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
      appendLog(entry);
    } catch {
      /* ignorar */
    }
  };
  es.onerror = () => {
    es.close();
    if (state.es === es) state.es = null;
    // Reconecta solo (p. ej. si el panel se reinicia)
    setTimeout(() => {
      if (!state.es) startLogStream();
    }, 5000);
  };
  state.es = es;
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

document.addEventListener("click", async (event) => {
  const close = event.target.closest("[data-close]");
  if (close) {
    closeModal();
    return;
  }
  if (event.target.classList.contains("modal-backdrop")) {
    closeModal();
    return;
  }

  const action = event.target.closest("[data-act]");
  if (!action) return;
  event.preventDefault();
  try {
    await handleAction(action.dataset.act, action);
  } catch (err) {
    toast(err.message, "bad");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

$("#tabs").addEventListener("click", (event) => {
  const btn = event.target.closest(".tab");
  if (btn) switchTab(btn.dataset.tab);
});

$("#btn-logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: {} });
  } catch {
    /* ignorar */
  }
  location.href = "/login";
});

async function boot() {
  try {
    await refresh(false);
  } catch (err) {
    toast(err.message, "bad");
    return;
  }

  try {
    const history = await api("/api/agent/logs");
    state.logs = (history.logs || []).slice(-400);
    if (state.tab === "agent") renderLogs();
  } catch {
    /* sin historial */
  }

  startLogStream();

  const tunnelsSearch = $("#tunnels-search");
  if (tunnelsSearch) {
    tunnelsSearch.addEventListener("input", () => {
      state.filters.tunnels = tunnelsSearch.value;
      renderTunnels();
    });
  }

  const nodesSearch = $("#nodes-search");
  if (nodesSearch) {
    nodesSearch.addEventListener("input", () => {
      state.filters.nodes = nodesSearch.value;
      renderNodes();
    });
  }

  const accessSearch = $("#access-search");
  if (accessSearch) {
    accessSearch.addEventListener("input", () => {
      state.filters.access = accessSearch.value;
      renderAccess();
    });
  }

  state.timer = setInterval(() => {
    if (document.querySelector(".modal")) return;
    refresh(true).catch(() => undefined);
  }, 6000);
}

boot();
