# FRPC-EDS

Servidor **FRP (frps)** con **panel de control** para publicar servicios de
servidores Linux y Windows en subdominios, autohospedado (sin ngrok ni límites
de túneles).

```
             Internet  ──  *.eds.dev
                              │
                    ┌─────────▼──────────┐
                    │  Droplet / VPS     │
                    │  ┌──────────────┐  │
                    │  │ Caddy (TLS)  │  │
                    │  └──────┬───────┘  │
                    │         │ :8080    │
                    │  ┌──────▼───────┐  │
                    │  │ frps  :7000  │  │  ← este proyecto
                    │  └──────┬───────┘  │
                    │  ┌──────▼───────┐  │
                    │  │ panel :7800  │  │
                    │  └──────────────┘  │
                    └─────────┬──────────┘
                              │ túnel frp cifrado
             ┌────────────────┴────────────────┐
             ▼                                 ▼
   Servidor Linux (frpc)             Servidor Windows (frpc)
   localhost:3000 / :8000            localhost:8000 (qpos)
```

Un servidor central hace de **punto de entrada**; cada servidor cliente ejecuta
`frpc` con la configuración que el panel le genera y publica sus servicios
locales bajo `https://<subdominio>.eds.dev`.

---

## Características

- **Servidor FRP + panel en un solo proyecto**: sin dependencias npm, sin build
  (Node ≥ 20 usando solo módulos nativos).
- **Panel web**: CRUD de servidores y túneles, estado en vivo (online/offline,
  conexiones, tráfico del día) leyendo la API de administración de frps.
- **Genera la configuración** de frps y de cada cliente (`frpc.toml`).
- **Instaladores listos**: `install.sh` (Linux + systemd) y `install.ps1`
  (Windows) con la config embebida.
- **Token propio por servidor** (sin usuario/contraseña), validado por frps y
  revocable individualmente.
- **Agente local gestionado**: arranca/para/reinicia `frpc` como proceso hijo,
  con logs en streaming (SSE) y recarga en caliente (`/api/reload`).
- **Login simple** con cookie firmada (HMAC-SHA256) y límite de intentos.
- **TLS**: compatible con Caddy (wildcard o bajo demanda) y nginx.

## Requisitos

| Componente      | Versión                                         |
| --------------- | ----------------------------------------------- |
| Node.js         | ≥ 20.12 (probado en 24.x)                       |
| frp (frps/frpc) | 0.71.x (el instalador baja la 0.71.1)           |
| Dominio         | con registro DNS **wildcard** `*` → IP servidor |
| Puerto 80/443   | libres en el servidor (si usas proxy TLS)       |

## Inicio rápido (local)

```bash
# 1. Binarios de frp
npm run frp:install           # Windows
# bash scripts/install-frp.sh # Linux/macOS

# 2. Panel
cp .env.example .env          # edita PANEL_PASSWORD
npm start                     # http://127.0.0.1:7800
```

Entra con `PANEL_USER` / `PANEL_PASSWORD`, ve a la pestaña **Servidor**,
configura el dominio base y guarda. El panel escribe:

```
data/runtime/frps.toml            # configuración del servidor FRP
data/runtime/<nodeId>/frpc.toml   # configuración de cada cliente
```

Arranca frps con la config generada:

```bash
npm run frps
```

> En local, si el puerto 80 está ocupado (por ejemplo por WAMP/Apache), usa
> `vhostHTTPPort = 8080` y prueba con
> `curl -H "Host: qpos.eds.dev" http://127.0.0.1:8080`.

## Autenticación: un token por servidor

No hay usuarios ni contraseñas para los clientes: **cada servidor tiene su
token**.

```
Servidor A ── token A ──┐
Servidor B ── token B ──┼──► frps ──► panel (/api/frp/plugin, op Login)
Servidor C ── token C ──┘
```

Por qué no se usa un token distinto como `auth.token` de frp: frp usa ese
mismo valor como **clave de cifrado del canal de control**, así que frps y frpc
deben compartirlo. Por eso el panel mantiene dos niveles:

| Token | Dónde vive | Quién lo ve |
| --- | --- | --- |
| **Maestro** (`auth.token`) | `frps.toml` + cada `frpc.toml` | interno, lo inyecta el panel |
| **Del servidor** (`metadatas.auth_token`) | `frpc.toml` de ese servidor | es el que reparte |

En cada conexión frps llama al plugin del panel (`[[httpPlugins]]`, op `Login`)
*antes* de validar el token. El panel comprueba el token del servidor y:

- lo **acepta** si existe, está habilitado y el identificador coincide;
- lo **rechaza** si el token no es de ningún servidor registrado;
- además valida en `NewProxy` que cada proxy pertenezca a ese servidor.

**Regenerar el token de un servidor** (`Servidores` → *Token y config* →
*Regenerar*) invalida solo a ese servidor; el resto sigue funcionando.

> ⚠️ El plugin exige que el panel esté en marcha: si el panel cae, ningún
> cliente nuevo puede autenticarse (falla cerrado). Los túneles ya establecidos
> siguen activos.

## Flujo de uso

1. **Servidores** → *Agregar servidor* (uno por máquina que publicará algo).
   También puedes saltarte este paso: en *Nuevo túnel* elige
   **«+ Servidor nuevo…»** y escribe el nombre; el servidor se crea al vuelo.
2. Descarga `install.sh` / `install.ps1` y ejecútalo **en esa máquina**:
   instala `frpc` y lo deja como servicio (`frpc-eds`).
   El instalador añade además una **auto-sincronización**: cada 60 s el cliente
   descarga su `frpc.toml` desde el panel (con su propio token) y reinicia frpc
   solo si cambió. **No hay que volver a descargar nada** al crear túneles.
3. **Túneles** → *Nuevo túnel*: servidor, tipo (`http`/`https`/`tcp`/`udp`),
   subdominio, destino local (`127.0.0.1:8000`).
4. El túnel aparece como *en línea* cuando el cliente conecta y frps lo registra.

Cada lista tiene **buscador** y muestra la **fecha de alta** de cada túnel y
servidor. Los subdominios `central`, `www`, `panel`, `admin`, `api`, `ns1`-`ns3`,
`mail` y `ftp` están reservados.

Para el nodo **local** (donde corre el panel), pestaña **Agente local** →
*Iniciar agente*: el panel lanza `frpc` y aplica los cambios de túneles en
caliente.

## Pestañas del panel

| Pestaña            | Contenido                                                        |
| ------------------ | ---------------------------------------------------------------- |
| **Túneles**        | Estado, URL pública, destino, tráfico, pausar/editar/eliminar    |
| **Servidores**     | Nodos, descarga de configs e instaladores                        |
| **Agente local**   | Control del proceso `frpc` de este host + logs en vivo           |
| **Servidor**       | Dominio base, puertos, API admin, token, `frps.toml`, checklist  |

## Estructura

```
src/
  index.js     servidor HTTP, estático, sesión, arranque
  api.js       rutas /api/*, generadores de instaladores
  store.js     persistencia (data/db.json, escritura atómica) + validación
  toml.js      generación de frps.toml / frpc.toml
  runtime.js   escritura de configs en data/runtime/
  frpauth.js   plugin de frps: valida el token de cada servidor
  agent.js     proceso frpc local, logs, reload, reintentos
  frps.js      cliente de la API de administración de frps
  auth.js      cookie firmada, scrypt, rate limit
  router.js    router con parámetros
public/        UI (HTML/CSS/JS sin frameworks)
scripts/       instaladores de frp, arranque de frps, mock, smoke test
deploy/        systemd, Caddy, nginx, runbook de DigitalOcean
```

## API

Todas las rutas requieren sesión salvo `/api/login`, `/api/logout`,
`/api/session` y `/api/tls/ask`.

| Método      | Ruta                                              | Descripción                  |
| ----------- | ------------------------------------------------- | ---------------------------- |
| POST        | `/api/login`                                      | `{user, password}`           |
| GET         | `/api/overview`                                   | Todo el estado para el panel |
| GET         | `/api/status`                                     | Estado ligero (polling)      |
| GET/POST    | `/api/nodes`                                      | Listar / crear servidor      |
| PUT/DELETE  | `/api/nodes/:id`                                  | Editar / eliminar            |
| GET         | `/api/nodes/:id/frpc.toml`                        | Descargar config             |
| GET         | `/api/nodes/:id/install.sh` \| `install.ps1`      | Instaladores                 |
| POST        | `/api/nodes/:id/token`                            | Regenerar token del servidor |
| POST        | `/api/frp/plugin`                                 | Plugin de auth para frps     |
| GET/POST    | `/api/tunnels`                                    | Listar / crear túnel         |
| PUT/DELETE  | `/api/tunnels/:id`                                | Editar / eliminar            |
| GET/PUT     | `/api/settings`                                   | Configuración del servidor   |
| POST        | `/api/settings/test-frps`                         | Probar la API admin          |
| GET         | `/api/agent/logs/stream`                          | Logs en vivo (SSE)           |
| GET         | `/api/tls/ask`                                    | Autorización TLS on-demand   |

## Pruebas

```bash
# 1. Mock de la API de frps (mismo esquema que frp 0.71.x)
node scripts/mock-frps-api.js

# 2. Panel con contraseña de prueba
#    PowerShell: $env:PANEL_PASSWORD="test-1234"; node src/index.js
npm start

# 3. Smoke tests del API
powershell -File scripts/smoke-test.ps1          # flujo base
powershell -File scripts/smoke-test-clients.ps1  # multiserver + instaladores
powershell -File scripts/smoke-test-tokens.ps1   # tokens y plugin de frps
```

## Seguridad

- El panel escucha en `127.0.0.1` por defecto: accede por túnel SSH
  (`ssh -L 7800:127.0.0.1:7800 user@ip`) o publícalo con TLS y contraseña fuerte.
- **Tokens por servidor**, no compartidos: revocar uno no afecta a los demás.
  El token maestro (interno) nunca se reparte: solo aparece en las configs que
  genera el panel.
- No expongas `7500` (API admin de frps) ni `8080` (vhost HTTP) a Internet.
- El instalador avisa si Windows Defender bloquea los binarios (ver abajo).

## Problemas conocidos

**Windows Defender marca frp como virus.** Es un falso positivo habitual en
binarios Go (`Trojan:Win32/Kepavll`, `Wacatac`). El zip queda bloqueado y
`Expand-Archive` falla. Soluciones: añadir una exclusión de carpeta en
*Seguridad de Windows → Protección antivirus → Exclusiones*, o instalar frp en
el servidor Linux.

**Los subdominios no resuelven.** Falta el registro DNS wildcard `*`, o el
`subDomainHost` no coincide con el dominio configurado.

**Un túnel figura "sin conexión".** El `frpc` de ese servidor no está corriendo o
su configuración es antigua: vuelve a descargar `frpc.toml` y reinicia
`frpc-eds`.

**Cambié ajustes del servidor y no surten efecto.** El panel solo escribe
`frps.toml`; reinicia el servicio: `sudo systemctl restart frps`.

**Un servidor no conecta y en el panel no aparece su último login.** Comprueba
que el token del `frpc.toml` coincide con el del panel (`Servidores` →
*Token y config*). Si regeneraste el token, vuelve a desplegar la configuración.

**Ningún cliente conecta tras reiniciar.** Verifica que el panel esté arriba:
frps valida los tokens contra `http://127.0.0.1:7800/api/frp/plugin`.

## Producción

Runbook completo para DigitalOcean (DNS wildcard, ufw, systemd, Caddy, nginx):
**[deploy/README.md](deploy/README.md)**.
