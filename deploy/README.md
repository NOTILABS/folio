# Folio Cloud deploy

Deploy `folio cloud serve` as a systemd service on an existing VPS, no docker.

## Why bare-metal

Folio's binary is standalone (`bun build --compile` ships a single executable
with no runtime deps). systemd hardening (`ProtectSystem=strict`, dedicated
`folio` user, `ReadWritePaths=/var/lib/folio-cloud`) gives blast radius
comparable to a container without the docker daemon overhead.

Folio-cloud doesn't execute agent HTML on the server — it stores and serves
it for a sandboxed iframe in the reader's browser. Container vs bare doesn't
change the threat model for what runs in someone's browser.

## Build the release tarball (dev machine)

```bash
# Cross-compile from darwin-arm64 or linux-x64 to linux-x64:
bun build --compile --target=bun-linux-x64 ./bin/folio.ts --outfile dist/folio-linux-x64

# Pack everything install.sh needs:
tar czf folio-cloud-deploy.tar.gz \
  dist/folio-linux-x64 \
  themes/ \
  templates/ \
  deploy/folio-cloud.service \
  deploy/install.sh \
  deploy/update.sh \
  deploy/reverse-proxy.caddy.example \
  deploy/README.md
```

## First-time install on VPS

**Easiest — one-shot bootstrap** (downloads release + installs + prompts for public URL + generates first pairing code in one go):

```bash
ssh vps
curl -L https://github.com/jzmudzinski/folio/raw/main/deploy/bootstrap.sh | sudo bash
# (or set PUBLIC_URL=https://cloud.example.com to skip the prompt)
```

That covers detection (linux-x64 / linux-arm64), fetching the latest release tarball, running `install.sh`, writing the systemd drop-in with your public URL, restarting the service, generating the first pairing code, and printing a Caddy snippet to paste into your Caddyfile. You still do the DNS A-record + Caddy reload yourself — those are too environment-specific to automate safely.

**Manual** (if you want to inspect every step):

```bash
scp folio-cloud-deploy.tar.gz vps:/tmp/
ssh vps
cd /tmp && mkdir folio-deploy && tar xzf folio-cloud-deploy.tar.gz -C folio-deploy
cd folio-deploy
sudo ./deploy/install.sh
```

`install.sh`:
1. Creates `folio` system user (no login shell)
2. Installs binary to `/opt/folio/folio`, themes/templates alongside
3. Creates `/var/lib/folio-cloud/` (owned by `folio`)
4. Drops `folio-cloud.service`, reloads systemd, `enable --now`

## Set public URL

```bash
sudo systemctl edit folio-cloud
# Add:
#   [Service]
#   Environment=FOLIO_CLOUD_PUBLIC_URL=https://cloud.example.com
sudo systemctl restart folio-cloud
```

## Wire reverse proxy

Caddy example in `reverse-proxy.caddy.example`. Replace `cloud.example.com`
with your subdomain. Folio-cloud binds `127.0.0.1:8081` by default — never
expose it directly to the internet; always reach it through your TLS-
terminating proxy.

## Onboard a box

Only a NotiBox box pairs (sc-24120), and only with the key it was minted for:

```bash
sudo -u folio /opt/folio/folio cloud pair-code --expect-key <box public key, base64 SPKI DER or PEM>
# → prints a 6-digit code (10 min TTL) and "Bound key: sha256:<hex>"
```

On NotiBox this is automatic: `notibox-folio-cloud enable` gets the code from
backplane and runs `folio sync pair`. The box signs every request with its key
(no bearer). Phone/browser pairing and the cloud notebook app (PWA) are gone.

## Update to a newer release

**One command** (recommended — installed by `install.sh` as `/usr/local/bin/folio-cloud-deploy`):

```bash
sudo folio-cloud-deploy            # fetch latest release for this arch → install → restart → health check
sudo folio-cloud-deploy --check    # report current vs latest, change nothing
sudo FOLIO_VERSION=v0.32.0 folio-cloud-deploy   # pin a release (rollback)
```

It resolves the latest `jzmudzinski/folio` tag, skips if already current
(`--force` to override), downloads `folio-<arch>.tar.gz`, runs the same install
steps as below, restarts `folio-cloud`, then health-checks the bind port. For a
private repo, export `GH_TOKEN` first.

**Manual** (inspect every step):

```bash
scp folio-cloud-deploy.tar.gz vps:/tmp/
ssh vps
cd /tmp && rm -rf folio-deploy && mkdir folio-deploy && tar xzf folio-cloud-deploy.tar.gz -C folio-deploy
cd folio-deploy
sudo ./deploy/update.sh
```

`update.sh` (and `folio-cloud-deploy`) overwrites `/opt/folio/folio` +
themes/templates + restarts the service. Data in `/var/lib/folio-cloud/` is
untouched.

## Test cloud changes locally first

Before pushing a new build to the VPS, run the cloud relay on the dev
machine and exercise the changes against it. Saves the `bun build` →
`scp` → `systemctl restart` round-trip on every iteration.

```bash
# Terminal 1 — local cloud relay on a sandboxed data dir + non-default port.
FOLIO_CLOUD_HOME=/tmp/folio-cloud-dev \
FOLIO_CLOUD_PORT=18081 \
FOLIO_CLOUD_PUBLIC_URL=http://127.0.0.1:18081 \
bun bin/folio.ts cloud serve

# Terminal 2 — pair this laptop against the LOCAL cloud (separate from prod).
# The code must be bound to the key this laptop will present (sc-24120):
# its local ed25519 device key (folio uses ~/Folio/.device-key.pem as is).
[ -f ~/Folio/.device-key.pem ] || (umask 077 && openssl genpkey -algorithm ed25519 -out ~/Folio/.device-key.pem)
FOLIO_CLOUD_HOME=/tmp/folio-cloud-dev bun bin/folio.ts cloud pair-code --expect-key "$(openssl pkey -in ~/Folio/.device-key.pem -pubout)"
# → prints a code

# In a browser: http://127.0.0.1:4810/cloud → paste http://127.0.0.1:18081
# + the code → laptop is paired against the dev cloud.

# Iterate: edit code, restart `bun bin/folio.ts cloud serve`, retry.
```

When done:
```bash
rm -rf /tmp/folio-cloud-dev      # wipe dev cloud state
# `folio sync unpair` from the laptop if it picked up the dev token
```

Most W3 fixes (SW lifecycle, blob URL handshake, layout bugs) reproduce
locally without ever touching the VPS. Reserve `scp + update.sh` for the
final pass after everything works headless.

## Operational notes

- **Logs:** `journalctl -u folio-cloud -f`
- **Status:** `systemctl status folio-cloud`
- **Stop:** `sudo systemctl stop folio-cloud` (resumable: `start`)
- **Disable autostart:** `sudo systemctl disable folio-cloud`
- **Memory cap:** unit sets `MemoryMax=512M`. Adjust via drop-in if you run
  larger payloads.
- **Backup:** `/var/lib/folio-cloud/` holds the cloud SQLite + assets blob
  tree. Ensure your VPS snapshot policy covers it, or add Litestream to
  replicate to S3/R2.
- **Port:** internal `:8081`. Conflicts with litellm only if litellm is also
  on `:8081` — by default it's `:8080`, so the two coexist.
