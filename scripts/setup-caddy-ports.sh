#!/usr/bin/env bash
# ------------------------------------------------------------------
# setup-caddy-ports.sh · prepara el servidor para publicar CUALQUIER puerto
# ------------------------------------------------------------------
# El panel genera un bloque de Caddy por cada puerto público adicional que
# pidas en un túnel (https://<sub>.dominio:<puerto>) y abre/cierra ese puerto
# en UFW. Este script deja el servidor listo (una sola vez, como root):
#
#   1. carpeta /etc/caddy/frpc-eds.d escribible por el usuario del panel
#   2. línea `import .../ports.caddy` en el Caddyfile (con copia de seguridad
#      y `caddy validate` antes de recargar)
#   3. helper root /usr/local/sbin/frpc-eds-ports + regla de sudoers para que
#      el panel pueda abrir puertos en UFW sin privilegios
#
# Uso:  sudo bash scripts/setup-caddy-ports.sh
# ------------------------------------------------------------------
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Ejecuta como root:  sudo bash scripts/setup-caddy-ports.sh" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CADDY_CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"
CADDY_PORTS_DIR="${CADDY_PORTS_DIR:-$(dirname "$CADDY_CONFIG")/frpc-eds.d}"
CADDY_PORTS_FILE="$CADDY_PORTS_DIR/ports.caddy"
PANEL_USER="${PANEL_USER:-frp}"
CADDY_GROUP="${CADDY_GROUP:-caddy}"
HELPER="/usr/local/sbin/frpc-eds-ports"
SUDOERS_FILE="/etc/sudoers.d/frpc-eds-ports"
STATE_DIR="/var/lib/frpc-eds"

info() { printf '  %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

echo ""
echo " FRPC-EDS · preparación de puertos públicos adicionales"
echo " -----------------------------------------------------"

command -v caddy >/dev/null 2>&1 || fail "Caddy no está instalado en este servidor"
[[ -f "$CADDY_CONFIG" ]] || fail "No existe $CADDY_CONFIG"
id -u "$PANEL_USER" >/dev/null 2>&1 || fail "No existe el usuario del panel: $PANEL_USER"
getent group "$CADDY_GROUP" >/dev/null 2>&1 || CADDY_GROUP="$PANEL_USER"

# 1) Carpeta del fragmento, escribible por el panel y legible por Caddy
install -d -m 2775 -o "$PANEL_USER" -g "$CADDY_GROUP" "$CADDY_PORTS_DIR"
if [[ ! -f "$CADDY_PORTS_FILE" ]]; then
  cat >"$CADDY_PORTS_FILE" <<'EOF'
# ------------------------------------------------------------------
# GENERADO POR FRPC-EDS — no editar a mano.
# El panel reescribe este archivo y recarga Caddy automáticamente.
# ------------------------------------------------------------------

# Sin puertos adicionales por ahora.
EOF
fi
chown "$PANEL_USER:$CADDY_GROUP" "$CADDY_PORTS_FILE"
chmod 0644 "$CADDY_PORTS_FILE"
info "Carpeta lista: $CADDY_PORTS_DIR (dueño $PANEL_USER:$CADDY_GROUP)"

# 2) Import en el Caddyfile (idempotente, con backup y validación)
if grep -q 'frpc-eds.d/' "$CADDY_CONFIG"; then
  info "El Caddyfile ya importa $CADDY_PORTS_FILE"
else
  BACKUP="$CADDY_CONFIG.bak.$(date +%Y%m%d%H%M%S)"
  cp -a "$CADDY_CONFIG" "$BACKUP"
  info "Copia de seguridad del Caddyfile: $BACKUP"
  cat >>"$CADDY_CONFIG" <<EOF

# ------------------------------------------------------------------
# Puertos públicos adicionales gestionados por el panel (FRPC-EDS).
# Un bloque por puerto en uso; se recarga solo. No editar a mano.
# ------------------------------------------------------------------
import $CADDY_PORTS_FILE
EOF
  if ! caddy validate --config "$CADDY_CONFIG" --adapter caddyfile >/dev/null 2>&1; then
    cp -a "$BACKUP" "$CADDY_CONFIG"
    fail "Caddy rechazó el Caddyfile con el import; se restauró la copia de seguridad"
  fi
  info "Caddyfile actualizado y validado"
fi

# 3) Helper root de firewall + sudoers
[[ -f "$REPO_DIR/scripts/frpc-eds-ports.sh" ]] || fail "Falta $REPO_DIR/scripts/frpc-eds-ports.sh"
install -m 0755 -o root -g root "$REPO_DIR/scripts/frpc-eds-ports.sh" "$HELPER"
info "Helper instalado: $HELPER"

TMP_SUDOERS="$(mktemp)"
cat >"$TMP_SUDOERS" <<EOF
# FRPC-EDS: permite al panel abrir/cerrar en UFW los puertos públicos
# adicionales. El helper valida el rango (1024-65535) y rechaza los puertos
# de infraestructura, así que no se concede root general.
$PANEL_USER ALL=(root) NOPASSWD: $HELPER
EOF
if ! visudo -cqf "$TMP_SUDOERS"; then
  rm -f "$TMP_SUDOERS"
  fail "La regla de sudoers generada no es válida"
fi
install -m 0440 -o root -g root "$TMP_SUDOERS" "$SUDOERS_FILE"
rm -f "$TMP_SUDOERS"
info "Regla de sudoers: $SUDOERS_FILE"

install -d -m 0755 -o root -g root "$STATE_DIR"
info "Estado del firewall: $STATE_DIR/ufw-ports"

# 4) Recargar Caddy (sin cortar conexiones)
if systemctl is-active --quiet caddy; then
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  info "Caddy recargado"
fi

# 5) Comprobación de que el panel puede usar el helper
if sudo -u "$PANEL_USER" -n sudo -n "$HELPER" list >/dev/null 2>&1; then
  info "El usuario $PANEL_USER puede ejecutar el helper (sudo sin contraseña)"
else
  echo "  AVISO: 'sudo -u $PANEL_USER -n sudo -n $HELPER list' falló. Revisa $SUDOERS_FILE" >&2
fi

if grep -qs '^NoNewPrivileges=\(yes\|true\|1\)' /etc/systemd/system/panel.service; then
  echo ""
  echo "  AVISO: panel.service tiene NoNewPrivileges=true, lo que bloquea sudo." >&2
  echo "         Comenta esa línea y ejecuta:" >&2
  echo "           sudo systemctl daemon-reload && sudo systemctl restart panel" >&2
fi

echo ""
echo " Listo. A partir de ahora cualquier puerto que escribas en"
echo " «Puertos públicos adicionales» se publica en Caddy y se abre en UFW."
echo ""
