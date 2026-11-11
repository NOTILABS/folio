#!/usr/bin/env bash
# Folio Cloud — first-time install on a fresh VPS. Idempotent.
#
# Assumes you've unpacked the release tarball in the current directory:
#   dist/folio-linux-x64    (compiled binary from `bun build --compile`)
#   themes/                  (bundled themes)
#   templates/               (bundled templates)
#   deploy/folio-cloud.service
#
# Run as root. Re-run is safe — won't overwrite /var/lib/folio-cloud data.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ "$EUID" -ne 0 ]; then
  echo "✗ install.sh must run as root (try: sudo $0)" >&2
  exit 1
fi

for f in themes/linen/theme.css deploy/folio-cloud.service; do
  if [ ! -e "$f" ]; then
    echo "✗ missing $f — did you unpack the release tarball?" >&2
    exit 1
  fi
done

# Binary lives at ./folio (current layout) or ./dist/folio-linux-x64 (legacy).
BINSRC=""
for cand in folio dist/folio-linux-x64; do [ -f "$cand" ] && { BINSRC="$cand"; break; }; done
[ -n "$BINSRC" ] || { echo "✗ no folio binary in tarball (looked for ./folio and dist/folio-linux-x64)" >&2; exit 1; }

# 1. Dedicated system user. No login shell, no home dir.
if ! id -u folio >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin folio
  echo "✓ created system user 'folio'"
fi

# 2. Install layout.
install -d -m 755 /opt/folio
install -d -m 755 -o folio -g folio /var/lib/folio-cloud
echo "✓ created /opt/folio + /var/lib/folio-cloud"

# 3. Binary + bundled assets. rsync --delete on themes/templates so a renamed
#    or removed theme doesn't linger on the host.
install -m 755 "$BINSRC" /opt/folio/folio
rsync -a --delete themes/ /opt/folio/themes/
rsync -a --delete templates/ /opt/folio/templates/
# og/ = OG-image sidecar (resvg.wasm + font) for link-preview cards. Guarded:
# an older tarball without it still installs; the og.png route falls back to SVG.
[ -d og ] && rsync -a --delete og/ /opt/folio/og/
echo "✓ installed binary + themes + templates to /opt/folio"

# 4. systemd unit.
install -m 644 deploy/folio-cloud.service /etc/systemd/system/folio-cloud.service
systemctl daemon-reload
echo "✓ wrote systemd unit"

# 5. Enable + start.
systemctl enable --now folio-cloud
sleep 1
systemctl --no-pager status folio-cloud | head -15

# 6. One-command deploy/upgrade helper (fetch latest release → install → restart
#    → health check). Re-runnable as `sudo folio-cloud-deploy`.
install -m 755 deploy/folio-cloud-deploy.sh /usr/local/bin/folio-cloud-deploy
echo "✓ installed /usr/local/bin/folio-cloud-deploy"

echo ""
echo "Next steps:"
echo "  1. Set FOLIO_CLOUD_PUBLIC_URL via drop-in:"
echo "       sudo systemctl edit folio-cloud"
echo "       [Service]"
echo "       Environment=FOLIO_CLOUD_PUBLIC_URL=https://cloud.example.com"
echo "       sudo systemctl restart folio-cloud"
echo "  2. Wire your reverse proxy to 127.0.0.1:8081 (see deploy/reverse-proxy.caddy.example)"
echo "  3. Onboard a box (code bound to its key, sc-24120):"
echo "       sudo -u folio /opt/folio/folio cloud pair-code --expect-key <box public key>"
