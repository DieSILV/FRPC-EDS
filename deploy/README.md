# Despliegue en DigitalOcean

Arquitectura objetivo:

```
                     Internet
                        │  *.nexus-pro.pe
                        ▼
        ┌───────────────────────────────┐
        │ Droplet Ubuntu (DigitalOcean) │
        │                               │
        │  Caddy :80/:443  ──TLS──┐     │
        │                         ▼     │
        │              frps :8080 (vhost HTTP) :7000 (túneles)
        │              panel :7800 (solo localhost)
        └───────────────┬───────────────┘
                        │  frp (tunel cifrado)
        ┌───────────────┴───────────────┐
        ▼                               ▼
  Servidor Linux (frpc)          Servidor Windows (frpc)
  localhost:3000                 localhost:8000
```

> **Importante:** frps **no emite certificados TLS** para los vhosts.
> Los proxies `http` se sirven por `vhostHTTPPort`; el HTTPS lo aporta
> Caddy/nginx delante (o Cloudflare). Los proxies de tipo `https` en frp
> significan "el servicio local ya habla TLS", no "frps añade TLS".

---

## 1. Crear el droplet

- Ubuntu 24.04 LTS, 1 vCPU / 1 GB es suficiente para decenas de túneles.
- IP pública del droplet del panel: **`137.184.226.242`**.

## 2. DNS

Dominio base del proyecto: **`nexus-pro.pe`** (zona ya creada en
DigitalOcean → *Networking → Domains*).

En esa zona debe existir:

| Tipo | Nombre | Valor             | TTL |
| ---- | ------ | ----------------- | --- |
| A    | `*`    | `137.184.226.242` | 300 |
| A    | `@`    | `167.172.133.217` | 300 |
| CNAME| `www`  | `nexus-pro.pe`    | 300 |

El registro **wildcard `*`** es lo que hace que `cualquiercosa.nexus-pro.pe`
llegue al droplet del panel. Sin él, los subdominios no resuelven.

> El wildcard **no** cubre el apex (`nexus-pro.pe`) ni dos niveles
> (`a.b.nexus-pro.pe`). frp solo genera subdominios de un nivel, así que el
> apex puede seguir apuntando a otro servidor (la web principal) sin que
> choque con los túneles.

Verifica tras propagarse:

```bash
dig +short qpos.nexus-pro.pe     # → 137.184.226.242
dig +short central.nexus-pro.pe  # → 137.184.226.242
```

**No hace falta ningún registro extra para `central.nexus-pro.pe`**: es un
subdominio de un nivel, así que lo cubre el wildcard `*`. Los túneles de los
clientes usan *otros* nombres (`qpos`, `leo`, `app`…); el panel y el DNS se
reservan `central`, `www`, `panel`, `admin`, `api`, `ns1`, `ns2`, `ns3`, `mail`
y `ftp` (el panel los rechaza si los intentas usar en un túnel).

## 3. Firewall

```bash
ufw allow 22/tcp          # SSH
ufw allow 80,443/tcp      # HTTP/HTTPS públicos
ufw allow 7000/tcp        # frp: conexión de los clientes
ufw enable
```

**No** abras `7800` (panel) ni `7500` (API admin de frps) ni `8080`.
Deben quedar en localhost.

Si usas *Cloud Firewalls* de DigitalOcean, aplica la misma regla.

## 4. Preparar el servidor

```bash
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Usuario sin privilegios
sudo useradd --system --create-home --shell /usr/sbin/nologin frp

# Proyecto
sudo mkdir -p /opt/frpc-eds
sudo chown frp:frp /opt/frpc-eds
# sube el proyecto (git clone / scp / rsync) a /opt/frpc-eds
sudo -u frp git clone <tu-repo> /opt/frpc-eds   # o rsync -av ./ frp@ip:/opt/frpc-eds

# Binarios de frp
cd /opt/frpc-eds
sudo -u frp bash scripts/install-frp.sh
```

### `.env`

```bash
sudo -u frp cp .env.example .env
sudo -u frp nano .env
```

```ini
PANEL_HOST=127.0.0.1      # solo accesible desde el propio servidor
PANEL_PORT=7800
PANEL_USER=admin
PANEL_PASSWORD=<contraseña larga y aleatoria>
SESSION_HOURS=12
```

## 5. Servicios systemd

```bash
sudo cp deploy/frps.service deploy/panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frps panel
sudo systemctl status frps panel --no-pager
```

Los logs: `journalctl -u frps -f` y `journalctl -u panel -f`.

## 6. Acceso al panel

**Opción A — túnel SSH (más seguro, sin exponer nada):**

```bash
ssh -L 7800:127.0.0.1:7800 root@137.184.226.242
# luego abre http://127.0.0.1:7800 en tu equipo
```

**Opción B — publicarlo con Caddy** en `central.nexus-pro.pe`
(ya incluido en `deploy/Caddyfile`). El panel detecta `X-Forwarded-Proto`
y marca la cookie como `Secure`.

## 7. TLS para los subdominios (Caddy)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Copia `deploy/Caddyfile` a `/etc/caddy/Caddyfile` y elige una opción:

- **A (recomendada):** certificado wildcard `*.nexus-pro.pe` con DNS-01.
  Requiere Caddy con el plugin de DigitalOcean:
  ```bash
  xcaddy build --with github.com/caddy-dns/digitalocean
  export DO_AUTH_TOKEN=...   # token de DO con scope read/write en DNS
  ```
- **B (sin plugins):** TLS bajo demanda por subdominio. Caddy consulta
  `http://127.0.0.1:7800/api/tls/ask` y solo emite certificado si el
  subdominio corresponde a un túnel habilitado.

```bash
sudo systemctl reload caddy
```

## 8. Configurar el panel

Entra al panel y en la pestaña **Servidor**:

| Campo                       | Valor                                          |
| --------------------------- | ---------------------------------------------- |
| Dirección pública           | `137.184.226.242`                               |
| Dominio base                | `nexus-pro.pe`                                  |
| Puerto del túnel            | `7000`                                         |
| Puerto HTTP virtual         | `8080`                                         |
| Puerto HTTPS virtual        | `0` (Caddy termina TLS)                        |
| Esquema de URLs públicas    | `https`                                        |

Pulsa **Guardar cambios** y reinicia frps para aplicar el `frps.toml`:

```bash
sudo systemctl restart frps
```

### Plugin de autenticación

El `frps.toml` generado incluye:

```toml
[[httpPlugins]]
name = "frpc-eds-auth"
addr = "127.0.0.1:7800"
path = "/api/frp/plugin"
ops = ["Login", "NewProxy"]
```

frps consulta al panel en cada conexión para validar el **token propio de cada
servidor**. Consecuencias:

- El panel debe estar siempre en marcha (`systemctl enable panel`). Si cae,
  ningún cliente nuevo puede autenticarse (falla cerrado).
- El plugin solo acepta peticiones desde loopback; no lo expongas a Internet.
- Si cambias `PANEL_PORT`, vuelve a guardar la configuración del servidor para
  regenerar el `frps.toml` y reinicia frps.

### Endurecer frps (opcional, recomendado)

Añade al `data/runtime/frps.toml`:

```toml
# El vhost HTTP solo escucha en localhost: obliga a pasar por Caddy
proxyBindAddr = "127.0.0.1"
```

⚠️ Esto también afecta a los proxies `tcp`/`udp` (sus `remotePort` quedarían
en localhost). Úsalo solo si todos tus túneles son `http`/`https`.

## 9. Conectar los servidores cliente

En la pestaña **Servidores** → *Agregar servidor*, y luego descarga:

- **Linux:** `install.sh` → `sudo bash install-frpc.sh`
  Instala `frpc` en `/opt/frpc-eds` y crea el servicio `frpc-eds`.
- **Windows:** `install.ps1` → `powershell -ExecutionPolicy Bypass -File install-frpc.ps1`
- **Manual:** `frpc.toml` para copiarlo donde ya tengas frpc.

Estado en el cliente:

```bash
systemctl status frpc-eds
journalctl -u frpc-eds -f
```

## 10. Crear los túneles

Pestaña **Túneles** → *Nuevo túnel*:

- Servidor: el nodo donde corre el servicio.
- Tipo `http`, subdominio `qpos`, destino `127.0.0.1:8000`.
- Resultado: `https://qpos.nexus-pro.pe` (vía Caddy) → `qpos.nexus-pro.pe:8080` en frps.

Los cambios en túneles del **servidor local** se aplican en caliente
(`/api/reload` de frpc). Los de nodos remotos requieren re-descargar el
`frpc.toml` / volver a ejecutar el instalador en ese servidor.

---

## Notas

- **Token por servidor**: cada servidor recibe su propio token
  (`metadatas.auth_token`) al descargar su configuración. Regenerarlo desde el
  panel invalida solo a ese servidor.
- **Token maestro**: `auth.token` es compartido porque frp lo usa también como
  clave del canal de control; lo genera el panel y no se reparte a mano.
- **Nombres de proxy únicos**: el panel los hace únicos porque frps los usa
  como clave global.
- **Verificación**: `curl -H "Host: qpos.nexus-pro.pe" http://127.0.0.1:8080`
  en el droplet prueba el enrutamiento de frps sin pasar por DNS.

---

## Alta real (droplet `137.184.226.242`)

Estado instalado el 2026-10-26:

| Componente | Detalle |
| --- | --- |
| Node.js | 22.23.4 (`/usr/bin/node`, vía NodeSource) |
| Caddy | 2.11.7 (repo oficial de Cloudsmith, servicio `caddy`) |
| frp | 0.71.1 en `/home/FRPC-EDS/bin/frp` |
| Usuario | `frp` (sin shell), dueño del proyecto |
| Enlace | `/opt/frpc-eds` → `/home/FRPC-EDS` |
| Servicios | `panel`, `frps`, `caddy` (todos `enabled`) |
| Certificados | **TLS bajo demanda** (HTTP-01) — Opción B |
| Firewall | ufw activo: `22`, `80/443`, `7000` |

Se usó la **Opción B (on-demand)** porque no hay token de la API de
DigitalOcean en el servidor. Ventaja: SSL para todos los subdominios sin
credenciales. Limitación: un certificado por subdominio (no wildcard).

### Pasar a wildcard (Opción A) más adelante

```bash
caddy add-package github.com/caddy-dns/digitalocean
systemctl restart caddy
export DO_AUTH_TOKEN=<token con read/write en DNS>
```

Y sustituir en `/etc/caddy/Caddyfile` el bloque `https://` por:

```caddyfile
*.nexus-pro.pe {
	tls {
		dns digitalocean {env.DO_AUTH_TOKEN}
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
}
```

### Credenciales del panel

Las genera la instalación y viven en `/home/FRPC-EDS/.env` (modo `600`):

```bash
sudo grep -E 'PANEL_(USER|PASSWORD)' /home/FRPC-EDS/.env
```

