#!/usr/bin/env bash
# Folio Cloud — one-shot self-host bootstrap.
#
# Downloads the latest release for this architecture, runs install.sh,
# prompts for the public URL, wires the systemd drop-in, generates the
# first pairing code, and prints the reverse-proxy snippet to paste.
#
# Usage (from a fresh VPS):
#   curl -L https://github.com/jzmudzinski/folio/raw/main/deploy/bootstrap.sh \
#     | sudo PUBLIC_URL=https://cloud.example.com bash
#
# Or interactive (prompts for missing values):
#   curl -L https://github.com/jzmudzinski/folio/raw/main/deploy/bootstrap.sh | sudo bash
#
# Env overrides (skip prompts):
#   PUBLIC_URL=https://cloud.example.com     The public-facing URL for the relay
#   VERSION=v0.10.2                          Pin a specific release (default: latest)
#   FOLIO_PORT=8081                          Internal bind port (default 8081)
#
# This is one-way: if you re-run, the existing /var/lib/folio-cloud data
# survives, but the drop-in + systemd unit are overwritten. Safe to re-run
# for upgrades; for surgical changes, edit by hand.

set -euo pipefail

# ───── Pre-flight ─────────────────────────────────────────────────────────

if [ "$EUID" -ne 0 ]; then
  echo "✗ bootstrap.sh must run as root (try: sudo $0 or pipe through sudo bash)" >&2
  exit 1
fi

detect_target() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) echo "linux-x64" ;;
    Linux-aarch64|Linux-arm64) echo "linux-arm64" ;;
    Darwin-arm64) echo "darwin-arm64" ;;
    *) echo "✗ unsupported platform $(uname -s)-$(uname -m); supported: linux-x64, linux-arm64, darwin-arm64" >&2; exit 1 ;;
  esac
}
TARGET="$(detect_target)"
echo "→ detected target: ${TARGET}"

VERSION="${VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/jzmudzinski/folio/releases/latest/download/folio-${TARGET}.tar.gz"
else
  DOWNLOAD_URL="https://github.com/jzmudzinski/folio/releases/download/${VERSION}/folio-${TARGET}.tar.gz"
fi

for cmd in curl tar systemctl rsync install useradd; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "✗ required command not found: $cmd" >&2
    exit 1
  fi
done

# ───── Prompts ────────────────────────────────────────────────────────────

if [ -z "${PUBLIC_URL:-}" ]; then
  echo ""
  read -rp "Public URL the cloud will be reachable at (e.g. https://cloud.example.com): " PUBLIC_URL
fi
PUBLIC_URL="${PUBLIC_URL%/}"
if [[ ! "$PUBLIC_URL" =~ ^https?:// ]]; then
  echo "✗ PUBLIC_URL must start with http:// or https:// (got: $PUBLIC_URL)" >&2
  exit 1
fi
FOLIO_PORT="${FOLIO_PORT:-8081}"

echo ""
echo "Configuration:"
echo "  Public URL:    $PUBLIC_URL"
echo "  Bind port:     127.0.0.1:$FOLIO_PORT"
echo "  Release:       $VERSION"
echo "  Target:        $TARGET"
echo "  Data dir:      /var/lib/folio-cloud"
echo "  Binary:        /opt/folio/folio"
echo ""
read -rp "Proceed? [Y/n] " CONFIRM
if [[ "${CONFIRM,,}" =~ ^n ]]; then
  echo "aborted."
  exit 0
fi

# ───── Download + extract ────────────────────────────────────────────────

WORKDIR="$(mktemp -d -t folio-bootstrap-XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

echo ""
echo "→ downloading $DOWNLOAD_URL"
curl -fL --progress-bar "$DOWNLOAD_URL" -o folio.tar.gz
tar xzf folio.tar.gz
echo "✓ extracted to $WORKDIR"

# ───── Install (mirror of install.sh) ─────────────────────────────────────

if ! id -u folio >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin folio
  echo "✓ created system user 'folio'"
fi

install -d -m 755 /opt/folio
install -d -m 755 -o folio -g folio /var/lib/folio-cloud

# Binary lives at ./folio (current layout) or ./dist/folio-<target> (legacy).
BINSRC=""
for cand in folio "dist/folio-${TARGET}"; do [ -f "$cand" ] && { BINSRC="$cand"; break; }; done
[ -n "$BINSRC" ] || { echo "✗ no folio binary in tarball (looked for ./folio and dist/folio-${TARGET})" >&2; exit 1; }
install -m 755 "$BINSRC" /opt/folio/folio
rsync -a --delete themes/ /opt/folio/themes/
rsync -a --delete templates/ /opt/folio/templates/
# og/ = OG-image sidecar (resvg.wasm + font) for link-preview cards. Guarded:
# an older tarball without it still installs; the og.png route falls back to SVG.
[ -d og ] && rsync -a --delete og/ /opt/folio/og/
echo "✓ installed binary + themes + templates"

install -m 644 deploy/folio-cloud.service /etc/systemd/system/folio-cloud.service

mkdir -p /etc/systemd/system/folio-cloud.service.d
cat > /etc/systemd/system/folio-cloud.service.d/bootstrap.conf <<EOF
[Service]
Environment=FOLIO_CLOUD_PUBLIC_URL=$PUBLIC_URL
Environment=FOLIO_CLOUD_PORT=$FOLIO_PORT
EOF
echo "✓ wrote systemd unit + bootstrap drop-in"

systemctl daemon-reload
systemctl enable --now folio-cloud
sleep 1
systemctl --no-pager status folio-cloud | head -10

# ───── Pairing ───────────────────────────────────────────────────────────
# sc-24120: a pairing code is always bound to the key of the box it pairs,
# so there is no "first code" to print here. NotiBox backplane mints one per
# box (`folio cloud pair-code --expect-key <box key>`) during
# `notibox-folio-cloud enable`.

echo ""
echo "→ pairing: codes are minted per box with --expect-key <box key> (no generic first code)"

# ───── Reverse-proxy snippet ─────────────────────────────────────────────

HOST="$(echo "$PUBLIC_URL" | sed -E 's#https?://([^/]+).*#\1#')"
CADDY_SNIPPET="/tmp/folio-caddyfile.snippet"
cat > "$CADDY_SNIPPET" <<EOF
$HOST {
    encode gzip zstd
    reverse_proxy 127.0.0.1:$FOLIO_PORT {
        header_up X-Real-IP {remote_host}
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
    }
    log {
        output file /var/log/caddy/folio-cloud.log {
            roll_size 10mb
            roll_keep 7
        }
        format json
    }
}
EOF

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  Folio Cloud bootstrap complete."
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "Service status:    systemctl status folio-cloud"
echo "Logs:              journalctl -u folio-cloud -f"
echo "Public URL:        $PUBLIC_URL"
echo ""
echo "Two manual steps left:"
echo ""
echo "  1. DNS — make sure $HOST resolves to this server's public IP."
echo "     (curl ifconfig.me to grab the IP if you don't know it.)"
echo ""
echo "  2. Reverse proxy — append the Caddy snippet at $CADDY_SNIPPET"
echo "     to your /etc/caddy/Caddyfile and \`sudo systemctl reload caddy\`."
echo "     (For Traefik / nginx, adapt the same reverse_proxy → 127.0.0.1:$FOLIO_PORT.)"
echo ""
echo "Then on a client device (laptop):"
echo "  folio sync pair --remote $PUBLIC_URL --code <6-digit-from-above>"
echo "Or via the local viewer: http://127.0.0.1:4810/cloud"
echo ""
echo "Subsequent devices pair via:"
echo "  /cloud → 'Generate code for another device'    (no SSH required)"
