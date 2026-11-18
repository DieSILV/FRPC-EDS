#!/usr/bin/env bash
# ------------------------------------------------------------------
# frpc-eds-ports · helper root del firewall para FRPC-EDS
#
# Lo ejecuta el panel (usuario sin privilegios) mediante sudo y una regla
# en /etc/sudoers.d/frpc-eds-ports. Valida cada puerto antes de tocar UFW:
#   · solo 1024-65535
#   · nunca los puertos de infraestructura (SSH, web, admin, frps, panel)
#
# Uso:
#   frpc-eds-ports sync 4174 5173   # deja abiertos EXACTAMENTE esos puertos
#   frpc-eds-ports list             # puertos abiertos por el panel
#
# El estado se guarda en /var/lib/frpc-eds/ufw-ports para no cerrar nunca
# reglas que no haya creado el propio panel.
# ------------------------------------------------------------------
set -euo pipefail

STATE_DIR="/var/lib/frpc-eds"
STATE_FILE="$STATE_DIR/ufw-ports"

# Puertos de infraestructura: se rechazan siempre.
RESERVED=" 22 80 443 2019 7000 7800 8080 8443 "

log() { printf '%s\n' "$*" >&2; }

die() {
  log "$*"
  exit 64
}

valid_port() {
  local raw="$1"
  [[ "$raw" =~ ^[0-9]{1,5}$ ]] || return 1
  local n=$((10#$raw))
  (( n >= 1024 && n <= 65535 )) || return 1
  [[ "$RESERVED" == *" $n "* ]] && return 1
  return 0
}

read_state() {
  [[ -f "$STATE_FILE" ]] || return 0
  tr -s '[:space:]' '\n' <"$STATE_FILE" | grep -E '^[0-9]{1,5}$' | sort -n | uniq || true
}

write_state() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$*" | tr -s '[:space:]' '\n' | grep -E '^[0-9]{1,5}$' >"$STATE_FILE.tmp" || true
  mv -f "$STATE_FILE.tmp" "$STATE_FILE"
}

ufw_available() {
  command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'
}

cmd_sync() {
  local -a desired=()
  local p
  for p in "$@"; do
    valid_port "$p" || die "puerto no permitido: $p"
    desired+=("$((10#$p))")
  done

  if ! ufw_available; then
    log "ufw no está instalado o está inactivo; no hay reglas que cambiar"
    write_state "${desired[*]:-}"
    return 0
  fi

  local -A want=() have=()
  for p in ${desired[@]+"${desired[@]}"}; do want["$p"]=1; done
  while read -r p; do
    [[ -n "$p" ]] && have["$p"]=1
  done < <(read_state)

  local changed=0
  for p in "${!want[@]}"; do
    if [[ -z "${have[$p]:-}" ]]; then
      ufw allow "$p/tcp" >/dev/null 2>&1 || die "ufw no pudo abrir el puerto $p"
      log "abierto $p/tcp"
      changed=1
    fi
  done
  for p in "${!have[@]}"; do
    if [[ -z "${want[$p]:-}" ]]; then
      ufw --force delete allow "$p/tcp" >/dev/null 2>&1 || true
      log "cerrado $p/tcp"
      changed=1
    fi
  done

  write_state "${desired[*]:-}"
  (( changed )) || log "sin cambios"
}

[[ $EUID -eq 0 ]] || die "este helper debe ejecutarse como root"

cmd="${1:-}"
[[ $# -gt 0 ]] && shift

case "$cmd" in
  sync) cmd_sync "$@" ;;
  list) read_state ;;
  *) die "uso: frpc-eds-ports {sync [puerto...]|list}" ;;
esac
