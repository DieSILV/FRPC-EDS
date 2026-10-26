#!/usr/bin/env bash
# Instala frpc/frps en bin/frp (Linux/macOS)
set -euo pipefail

VERSION="${1:-0.71.1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin/frp"
mkdir -p "$BIN"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7l) ARCH="arm" ;;
  *) ARCH="amd64" ;;
esac

NAME="frp_${VERSION}_${OS}_${ARCH}"
URL="https://github.com/fatedier/frp/releases/download/v${VERSION}/${NAME}.tar.gz"

echo "Descargando $URL"
TMP="$(mktemp -d)"
curl -fsSL "$URL" -o "$TMP/frp.tar.gz"
tar -xzf "$TMP/frp.tar.gz" -C "$TMP"
cp "$TMP/$NAME/frpc" "$TMP/$NAME/frps" "$BIN/"
chmod +x "$BIN/frpc" "$BIN/frps"
rm -rf "$TMP"

echo "Instalado en $BIN"
"$BIN/frpc" -v
