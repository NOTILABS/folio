<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
  <img src="assets/wordmark-light.svg" alt="folio. — visual comm for agents" width="420">
</picture>

<p>
  <a href="https://github.com/jzmudzinski/folio/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/jzmudzinski/folio?label=release&color=ff5a1f"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-2f9050"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-458%20%2F%200-2f9050">
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Bun%201.3%2B-f3b71f">
  <img alt="platforms" src="https://img.shields.io/badge/binaries-darwin--arm64%20%C2%B7%20linux--x64%20%C2%B7%20linux--arm64-555">
</p>

> Visual communication layer between AI agents and humans.

When your agent has something to show — research, comparison, technical doc, design candidates the user picks between, scorecards, color-coded findings, sortable tables, embedded interactive demos — Folio renders it as a **single standalone HTML file** on your disk, served by a local viewer, addressable from any MCP client.

**What you get:**

- 🎨 **18 themes** with structural CSS the agent uses (`.eyebrow`, `.lead`, `.pill`, `.card`, `.verdict`, …) — drop your own folder under `~/Folio/themes/` and it shows up live
- 📂 **Notes as plain HTML files** in `~/Folio/threads/<topic>/` — append-only, no database lock-in, `tar` and walk away
- 🔎 **SQLite FTS5 full-text search** with Polish-aware tokenizer + suffix stemmer
- 🧩 **MCP server** (`folio-mcp`) — **23 tools** (v0.30.2), works with OpenClaw, Claude Code, Claude Desktop, Cursor, Continue
- 🖼️ **Local viewer** at `127.0.0.1:4810` — iframe-isolated themes, lightbox, TOC with scroll spy, prev/next-in-thread, **topbar Share popover** (v0.19+) for mint-and-revoke capability URLs
- 📰 **Live notes** (v0.9+) — append-only feeds (journal, todo, ops log) that grow over time, inline-rendered (v0.17+) or in a side panel, `finalize` compiles them into a static body
- 🎛 **Iteration primitive** (v0.18+) — agent proposes N design candidates → user clicks one in a gallery → agent proposes N variants of the pick → repeat. `wait_for_pick` (v0.19.1) lets the agent block on the SSE hub so no "I clicked!" chat round-trip
- 🔗 **Capability URL shares** — `folio publish` (CLI/MCP/viewer-UI) mints a tokenized URL; share via Slack/email/Telegram with expiry, max-views, optional email binding
- 📎 **Attach assets** (images / PDFs / videos) to threads with hardened filename + extension validation
- ⚡ **Pre-compiled binaries** for darwin-arm64 / linux-x64 / linux-arm64 — no runtime dependency

> *Folio is not a knowledge base. It's the surface on which your current conversation with an agent renders. Markdown is flat — Folio is where the agent stops describing and starts showing.*

---

## See it live

**[↗ Folio rendering itself — live capability URL](https://folio.notibox.ai/p/n_nM0VOKa39NNQXqfnjhNiPqBdeE96tCJCUDcVNcf50/n/01KRNF1BYNMCEAM4HACQ6J11YY)**

A self-demo note (research type, linen theme) published via `folio publish --expires-days 0`. Opens in any browser, no login. What you'll see that this README can't show — GitHub's markdown sanitizer strips `<script>`, `<style>`, `<iframe>`, custom classes:

- the actual `linen` theme typography (Familjen Grotesk + Instrument Serif italic) and CSS variables
- the viewer chrome around the sandboxed iframe — TOC, scroll spy, reading progress, copy buttons, theme switcher, the v0.19 `↗ Share` popover
- a working **mock iteration gallery** (inline JS in the note body) — click a card, watch the "you picked X" resolution land in real time. That's the exact UX shape an agent's `wait_for_pick` long-poll sees when you click in the real gallery.
- inline SVG diagram + per-section visual chrome that Markdown can't carry

The page runs entirely inside Folio's null-origin sandboxed iframe with CSP `connect-src 'none'` + `form-action 'none'` — same security model as every other Folio note.

---

## Status

**v0.30.4 — shippable.** Stable MCP contract, 667 tests across 60 files, pre-compiled binaries for darwin-arm64 / linux-x64 / linux-arm64. Cloud + PWA + publish + iteration + project workspace + viewer share UI all ride on the same machinery — opt in to one without losing the others.

- ✅ Core flow: agent → MCP `create` → note on disk → `/n/<id>` renders
- ✅ Sync daemon (`folio sync`) mirrors `~/Folio/` to an optional cloud relay — bidirectional notes + assets + tombstones
- ✅ Read-only PWA on phone with install banner (`beforeinstallprompt` on Chrome/Edge, inline Share→Add-to-Home-Screen hint on iOS Safari)
- ✅ Live note SSE forwarding through cloud — phone watches new entries in real time; **inline-rendered live mode** (v0.17) puts entries straight in the body
- ✅ **Iteration primitive** (v0.18) — `propose_round` / `pick_variant` / `iteration_state` MCP tools + viewer gallery render with click-to-pick; cloud renders read-only
- ✅ **Viewer share UI** (v0.19) — topbar `↗ Share` popover + `/n/:id/shares` manage page; previously CLI/MCP only
- ✅ **`wait_for_pick` MCP tool** (v0.19.1) — agent long-polls Folio's SSE hub instead of waiting for the user to confirm a pick in chat
- ✅ `folio publish` mints capability URLs (or use the new viewer UI); with `--recipient` the cloud emails the link via Resend, hash-bound
- ✅ Cloud observability snapshot (`GET /v1/admin/stats` + viewer Cloud stats panel)
- ✅ Soft-delete (`folio delete`, `.trash/` with 7-day grace) plus sidebar button in the viewer
- ✅ **Append-only _per revision_** (ADR-014, relaxed v0.22+) end-to-end: a note's body bytes never change in place; documents evolve via `replace` (the `superseded_by` chain is the document's append-log, surfaced by the `list_revisions` tool + a viewer revision strip — v0.30.x), live/iteration notes via `.entries.jsonl`. Metadata edits in place via `update_metadata`; capability-URL trust intact
- ✅ `folio update` self-updates from GitHub Releases

<details>
<summary><b>Recent releases</b> — last 6 versions</summary>

| Version | Date | Highlight |
|---|---|---|
| **v0.30.4** | 2026-05-21 | Fix — the `replace` MCP tool threw on every call (built response URLs without a loaded `cfg`); now consistent with the other handlers |
| **v0.30.3** | 2026-05-21 | Docs — `AGENTS.md` / `SKILL.md` caught up to the "append-only _per revision_" model (the old "never UPDATE / no update tool" wording was false since v0.22) |
| **v0.30.2** | 2026-05-21 | Document revision history — `getRevisionChain` + `list_revisions` MCP tool + a viewer revision strip; a document visibly behaves like a versioned log |
| **v0.30.1** | 2026-05-21 | `superseded_by` now syncs across devices — dedicated `pushSupersedes` pass (a `replace` on one device finally hides the old revision on another) |
| **v0.30.0** | 2026-05-21 | Unified note classification — `src/core/note-log.ts` (`strategyOf` / `renderModeOf`) is the single source of truth for `finalize` + `pageNote` |
| **v0.29.3** | 2026-05-20 | Fix — home list rendered "Yesterday" before "Today" when a pinned note was older; pinned now render in their own section above the date groups |

Full notes: [CHANGELOG.md](CHANGELOG.md).
</details>

---

## Why Folio vs …

- **vs Claude Artifacts / OpenAI Canvas** — local-first, your filesystem, no vendor lock-in. Threads of notes (not single isolated artifacts), addressable from any MCP-capable client, not coupled to one chat product. Iteration primitive lets the agent run a multi-round design loop where you actually pick the direction — Artifacts gives you one shot.
- **vs Obsidian / SilverBullet / Notion** — HTML not Markdown, designed for agents to write and humans to read. Sandboxed iframes for embedded demos with `<script>` allowed (CSP-isolated). Append-only by design — the agent can never overwrite your prior take, only add another angle in the same thread.
- **vs a folder of `.html` files** — indexed (FTS5), themed (18 bundled), addressable (`/n/<id>`), served, MCP-wired, lifecycle-managed (30-day auto-cleanup unless `finalize`d), shareable as capability URLs (token in path, no login on the recipient side).

The product is the **filesystem + viewer + MCP contract**, not a hosted app. Every note is a valid standalone HTML file that opens in any browser, with or without Folio running.

---

## Install

**From a release** (recommended):

```bash
# Pick the right tarball for your machine
TARGET=darwin-arm64    # or linux-x64, or linux-arm64

curl -L "https://github.com/jzmudzinski/folio/releases/latest/download/folio-${TARGET}.tar.gz" \
  | tar xz -C /tmp/folio-install
cd /tmp/folio-install && ./install.sh
export PATH="$HOME/.local/folio:$PATH"      # add to your shell rc

folio init
folio serve     # http://127.0.0.1:4810
```

**From source** (you want to hack on it):

```bash
git clone https://github.com/jzmudzinski/folio.git
cd folio && bun install
bun bin/folio.ts init
bun bin/folio.ts serve
```

Requires Bun 1.3+ for source install. Release tarballs ship pre-compiled single-file binaries — no runtime dependency.

---

## How it works in 60 seconds

1. An MCP-capable agent (OpenClaw, Claude Code, Claude Desktop, Cursor, Continue, …) connects to `folio-mcp` over stdio.
2. When the agent has something visual to show — research, comparison, technical doc, interactive demo — it calls `create` with an HTML body and a theme.
3. The note lands at `~/Folio/threads/<topic>/<slug>.html` and the agent replies with `http://127.0.0.1:4810/n/<id>`.
4. You open the link in a browser. The local viewer renders the note in the chosen theme, attaches a sidebar with metadata + actions, and stays out of the way.
5. Want another angle? Tell the agent. It writes a new note in the same thread folder. The previous one stays intact (Folio is append-only). Mark the best one as "final" — it skips the 30-day auto-cleanup.

<details>
<summary><b>Two more shapes the agent can take</b></summary>

**Live notes (v0.9+).** Some notes grow over time — daily journal, todo list, ops feed. Create with `live: true`; entries land in a sidecar `.entries.jsonl` via `append_entry`. Two render modes:

- **Panel mode** (default): entries stream into a side panel beside the body iframe. The body stays static. Best when the body is the document and the feed is meta-commentary.
- **Inline mode** (v0.17, `inline: true`): entries render inside `body_html` on every viewer hit + arrive in real time via SSE → postMessage. No side panel. Best when the document IS the feed.

`finalize` compiles the feed into a static body and shuts off the live behavior.

**Iteration notes (v0.18+).** Agent generates N design candidates, user clicks one in a gallery, agent generates N variants of the pick, repeat. Tree-shaped (every variant has a `parent_variant_id`). Tool surface:

```
propose_round({ note_id, variants[], parent_variant_id? })  → { round, variant_ids[] }
wait_for_pick({ note_id, for_round, timeout_s = 60 })       ← v0.19.1
   → blocks on the SSE hub until the user clicks; resolves with { variant_id, round }
pick_variant({ note_id, variant_id })                       ← usually the viewer fires this
iteration_state({ note_id })                                → snapshot
```

`finalize` walks the picked lineage and compiles it into a "Final design" + "Iteration history" block, archiving discarded variants to `~/Folio/.trash/`.

</details>

---

## Commands

| Command | What |
|---|---|
| `folio init` | Bootstrap `~/Folio/` (or `$FOLIO_HOME`) |
| `folio new --title T --type X --html @file.html` | Create a note from an HTML fragment |
| `folio list [--type] [--thread] [--final] [--json]` | List recent notes |
| `folio search "query" [--type] [--json]` | FTS5 full-text search (Polish-aware) |
| `folio append <id> [--content @file] [--tags] [--refs]` | Append entry to a live note (ADR-020) |
| `folio finalize <id>` | Mark as final — skip auto-cleanup; live → static body |
| `folio delete <id> [--yes]` | Soft-delete to `~/Folio/.trash/` (recoverable 7d), propagates to cloud on next sync |
| `folio open <id\|slug>` | Open note URL in default browser |
| `folio export <id> [--standalone] [--out path]` | Export a single self-contained HTML |
| `folio cleanup [--dry-run]` | Trash non-final notes past expiry (30d default) |
| `folio reindex` | Rebuild FTS index from files on disk |
| `folio stats` | Counts + analytics |
| `folio serve` | Local viewer on `:4810` |
| `folio sync pair --remote <url> --code <6-digit>` | Pair this device with a Folio Cloud relay |
| `folio sync [--once] [--interval 30]` | Push/pull daemon (or one-shot) against the paired cloud |
| `folio sync status` / `unpair` | Inspect / clear local sync state |
| `folio publish <id\|thread:slug> [--expires-days 7] [--max-views N] [--allow-pick]` | Mint a capability URL share (`--allow-pick`: recipient can choose a `data-folio-pick` variant) |
| `folio shares list` / `revoke <token>` | Manage active shares |
| `folio cloud {init\|serve\|pair-code}` | Run a cloud relay (operator side) |
| `folio doctor [--offline] [--json]` | Install + storage + cloud sync diagnostics |
| `folio update [--check] [--force] [--pre] [--json]` | Self-update from GitHub releases |
| `folio version [--json]` | Print Folio version + storage / viewer / theme info (alias: `--version`, `-v`) |
| `folio-mcp` | Stdio MCP server for agent clients |

Environment: `FOLIO_HOME=/path` overrides storage root. `FOLIO_DEBUG=1` for stack traces.

---

## Agent integration

Folio is built around the MCP protocol. The server (`folio-mcp`) exposes **20 tools** (as of v0.19.1) and **6 resources** for context-loading. The server name is `folio`, so mcporter-style clients invoke them as `folio.create`, `folio.search`, etc.

<details>
<summary><b>Full tool surface</b></summary>

| Family | Tools |
|---|---|
| Core CRUD | `create`, `get`, `list`, `search`, `finalize`, `unfinalize`, `export`, `version` |
| Discovery & UX | `suggest_thread`, `list_expiring`, `list_themes` |
| Assets | `attach_asset` |
| Live notes (v0.9+) | `append_entry`, `list_entries`, `set_pinned` |
| Iteration (v0.18+) | `propose_round`, `pick_variant`, `iteration_state`, `wait_for_pick` *(v0.19.1)* |
| Capability shares | `publish` |

See [`skills/folio/SKILL.md`](skills/folio/SKILL.md) for the agent-facing usage guide.
</details>

### OpenClaw + mcporter

```bash
mcporter config add folio --command folio-mcp --scope home

# Optional: install the skill so agents know when/how to call Folio
ln -s "$HOME/.local/folio/skills/folio" "$HOME/.openclaw/workspace/skills/folio"
```

### Claude Desktop

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "folio": { "command": "folio-mcp" }
  }
}
```

### Claude Code / Cursor / Continue

Most MCP-capable clients accept the same shape: command `folio-mcp`, no args. See [`docs/mcp-setup.md`](docs/mcp-setup.md) for details.

### One-command install

`folio install` wires both the agent skill and the MCP server into a supported client. Two targets ship today:

- **`--target claude-code`** — symlinks the skill to `~/.claude/skills/folio` and adds an entry under `projects[<scope>].mcpServers.folio` in `~/.claude.json`. MCP wiring is per-project (Claude Code's model).
- **`--target openclaw`** — symlinks the skill to `~/.openclaw/workspace/skills/folio` and adds an entry under `mcp.servers.folio` in `~/.openclaw/openclaw.json`. Global, no per-project scope.
- **`--target all`** — both. Default in non-interactive mode (e.g. CI) when both clients are detected.

```bash
folio install                          # interactive: detects clients, asks if both present
folio install --target claude-code     # explicit single target
folio install --target openclaw        # explicit single target
folio install --target all             # wire to every supported target
folio install --scope ~/Projects/app   # Claude Code per-project scope (ignored for openclaw)
folio install --skill-only             # skip MCP wiring
folio install --mcp-only               # skip skill, just MCP
folio install --dry-run                # show planned changes, don't apply
folio install --yes                    # accept all prompts (skips interactive scope question)

folio uninstall                        # remove from current project (claude-code default)
folio uninstall --target all           # remove from every supported client
folio uninstall --all-scopes           # remove folio MCP from every Claude Code project
folio doctor                           # show install state for every detected target
folio doctor --json                    # machine-readable
```

What `install` touches per target:

| Target | Skill path | MCP config | Notes |
|---|---|---|---|
| `claude-code` | `~/.claude/skills/folio` (symlink) | `~/.claude.json` → `projects[<scope>].mcpServers.folio` | Per-project. Cursor / Claude Desktop are follow-ups. |
| `openclaw` | `~/.openclaw/workspace/skills/folio` (symlink) | `~/.openclaw/openclaw.json` → `mcp.servers.folio` | Global. Also strips stale `skills.load.extraDirs` entries ending in `/skills/folio`. Preserves any `env` you set (e.g. `FOLIO_HOME`). |

Both targets get atomic JSON writes with a `.folio-backup-<ts>` taken on first touch this session. After a `folio update`, install entries on every wired target are auto-refreshed so the MCP `command:` path follows the binary.

### Public URL (reverse proxy)

Folio binds to `127.0.0.1:4810` by default. When you reverse-proxy the viewer to a public host (Tailscale Funnel, Caddy, ngrok, …), agents and bots that relay note links — Telegram, email, Slack — should surface that public URL, not `localhost`. Set `viewer_public_url` in `~/Folio/folio.config.json`:

```json
{
  "theme": "linen",
  "viewer_port": 4810,
  "viewer_host": "127.0.0.1",
  "viewer_public_url": "https://notes.example.com"
}
```

Effect: `folio.create` returns `public_url` + a `response_hint` (the `MEDIA:` line) that uses it; `local_url` stays for in-process tooling. Notes' internal links are relative (`/n/<id>`), so existing notes render unchanged behind either base — no migration needed.

Without `viewer_public_url`, `public_url` / `new_public_url` / `stream_url` are `null` (never the `127.0.0.1` address, which is dead for anyone on another device) and the response carries a `share_hint`: with cloud sync paired, call `publish` and send its `/p/<token>/…` URL; unpaired, there is no external link.

### Attaching assets to notes

`folio.attach_asset` lets an agent (or bot) drop an image, PDF, or video into a thread and reference it from `body_html`. Files live next to the thread's `*.html` notes under `threads/<thread_id>/assets/`, so a single `tar` of `~/Folio/` covers them automatically.

```jsonc
// MCP call
{
  "tool": "attach_asset",
  "args": {
    "thread_id": "morning-ride-2026-05-12",
    "filename": "speed-chart.png",
    "content_base64": "iVBORw0KGgo…"     // or: "source_path": "/tmp/chart.png"
  }
}
// Response
{
  "thread_id": "morning-ride-2026-05-12",
  "filename": "speed-chart.png",
  "path":  "~/Folio/threads/morning-ride-2026-05-12/assets/speed-chart.png",
  "url":   "https://notes.example.com/t/morning-ride-2026-05-12/asset/speed-chart.png",
  "local_url": "http://127.0.0.1:4810/t/…/asset/speed-chart.png",
  "size_bytes": 23184
}
```

Hardened by design:

- Filename must match `^[a-zA-Z0-9._-]+$`, ≤200 chars, no leading/trailing dot, no `..`. Path separators are rejected.
- Extension whitelist: `jpg` / `jpeg` / `png` / `webp` / `gif` / `svg` / `pdf` / `mp4`. Anything else → `415` on GET.
- Served with `Content-Type` sniffed from extension, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=86400`.
- No implicit URL rewrite in `body_html` — the agent embeds the absolute or relative URL it received. Predictable contract, no surprise edits to the note.

Re-attaching the same filename overwrites in place (idempotent uploads). Notes themselves are still append-only.

---

## Cloud sync (optional)

`folio serve` keeps everything on `127.0.0.1:4810` — but if you want notes on your phone (offline-capable PWA) or to share a note with someone over the internet, point a small relay at an existing VPS and tie devices to it.

The relay is the same Folio binary in a different mode:

```bash
# On a VPS (the operator side) — one-shot bootstrap, all of the below:
curl -L https://github.com/jzmudzinski/folio/raw/main/deploy/bootstrap.sh \
  | sudo PUBLIC_URL=https://folio.example.com bash

# Or step-by-step if you'd rather inspect:
sudo ./deploy/install.sh        # systemd unit, bare-metal, no docker — see deploy/README.md
sudo systemctl edit folio-cloud # set FOLIO_CLOUD_PUBLIC_URL=https://folio.example.com
sudo systemctl restart folio-cloud
sudo -u folio /opt/folio/folio cloud pair-code     # first pairing code (10-min TTL)
```

```bash
# On the laptop (operator), first pair:
folio sync pair --remote https://folio.example.com --code 482910
# Or via the local viewer: http://127.0.0.1:4810/cloud (form for code paste)

# Run the daemon (in the background):
folio sync
# Or one-shot in cron / before a flight:
folio sync --once
```

Every subsequent device pairs through the UI — no SSH:

```
laptop /cloud → "Generate code for another device" → 482910
phone /pair  → enter 482910 → done
```

Phone gets `https://folio.example.com` as a PWA — install to home screen from Safari/Chrome, browse notes offline, tap a thread name to filter. Read-only by design: notes are created on the writer device, the PWA never writes.

### `folio publish` — share with someone who has no Folio

```bash
folio publish <note-id> --expires-days 7
# → https://folio.example.com/p/Hk3xQ.../n/<note-id>
folio publish thread:morning-review --max-views 50
folio shares list
folio shares revoke Hk3xQ...
```

Recipients click the link, see the note rendered in its theme. No login, no app, no account. Capability URL gets `Referrer-Policy: no-referrer` + `X-Robots-Tag: noindex` so it stays out of search indexes and external Referer logs. Token-bound expiry + max-views + revoke. Asset URLs in the body rewrite through the same `/p/<token>/` prefix so images work without paired devices.

### Diagnostics

When something looks off, `folio doctor` checks install, storage, and cloud sync state in one pass:

```bash
folio doctor                     # full report
folio doctor --offline           # skip network probes
folio doctor --json              # machine-readable
```

Surfaces the common failure modes: cloud unreachable, token rejected, last sync > 7 days, themes missing next to a compiled binary, MCP install symlinks stale.

---

## Themes

18 themes ship bundled, each with two files:

- `theme.css` — CSS variables + utility classes (`.eyebrow`, `.lead`, `.pill`, `.card`, `.verdict`, …) the agent uses for structure
- `theme.md` — prompt addendum the Skill injects so the agent matches the theme's voice and structure

Defaults: `linen` (warm cream, Familjen Grotesk + Instrument Serif italic, orange accent). Switch per-note via `create({ theme })` or globally in `~/Folio/folio.config.json`.

Drop your own folder at `~/Folio/themes/<name>/` and it appears in the viewer dropdown immediately — no restart, no rebuild.

Full theme list and contract: [`themes/README.md`](themes/README.md).

---

## Architecture

- **Bun** runtime + TypeScript (no build step in dev; `bun build --compile` for release binaries)
- **`bun:sqlite`** with FTS5 for local storage + search (Polish-aware tokenizer + suffix stemmer). Two-phase schema bootstrap with migrations between (`src/core/migrations.ts`); BASE_SCHEMA never references a column added in the same release.
- **`sanitize-html`** for agent body sanitization — forces safe sandboxes on `<iframe>` (no `allow-same-origin` ever passes through, `https:` only, `on*` handlers stripped), allows arbitrary `data-*` attributes (v0.18.2) so agent-built widgets can pair static markup with inline JS. `<script>` IS allowed at body level since v0.3 because notes render inside a null-origin sandboxed iframe with `connect-src: 'none'` + `form-action: 'none'` — isolation comes from the outer iframe + CSP, not the sanitizer.
- **Eta** templates wrap agent-supplied HTML in a theme-linked document.
- **Vanilla viewer** — server-rendered HTML + vanilla JS for the helpers (lightbox, copy-code, heading anchors, TOC with scroll spy, reading progress, theme preview switcher, prev/next in thread, print via postMessage so chrome doesn't leak into the PDF, **topbar Share popover** with outside-click/Esc dismiss).
- **SSE hub** (`src/core/sse-hub.ts`) — in-process pub/sub on every note's `.entries.jsonl`. Direct `publish` calls from MCP/CLI writers fan out instantly; `fs.watch` is the fallback for out-of-process appends. Powers live note streaming AND `wait_for_pick` (v0.19.1) — the same channel that feeds the viewer iframe also feeds the agent's long-poll.
- **Iteration primitive** (v0.18+) — `kind:variant` + `kind:pick` tagged entries on the live-notes JSONL substrate. Tree-shaped (`parent:<variant_id>` tag), pure-function state compute, finalize compiles picked lineage into a static "Final design + Iteration history" body.
- **One Folio binary, three modes:** `folio serve` (local viewer, default), `folio sync` (push/pull daemon against a cloud relay), `folio cloud serve` (the relay itself — reuses the same viewer + theme stack with bearer auth on top).
- **PWA** = stateless JS shells served by the cloud relay. Token lives in IndexedDB only; service worker SWR-caches notes for offline reads.
- **Capability URLs** are 32-byte b64url tokens server-side; scope is enforced per-request (note vs thread). Body asset URLs rewrite through `/p/<token>/` so shared notes render with images and the iframe sandbox stays null-origin. Optional recipient-binding hashes the email locally with SHA-256 — cloud stores only the hash.
- **MCP SDK** for the stdio server (`folio-mcp` over stdio for OpenClaw / Claude Desktop / Claude Code).

No React, no frontend framework, no build step at runtime. Notes are pure HTML files; the viewer renders them through an iframe so theme.css is isolated from viewer chrome.

---

## Hacking on Folio

[`AGENTS.md`](AGENTS.md) is the canonical "how to work on this codebase" guide — file layout, conventions, hard rules, common pitfalls. Read it before adding tools, themes, or viewer helpers.

Tests:
- `bun test` runs the unit suite (**458 tests across 44 files**, ~8s). Covers storage, MCP tools (incl. iteration + wait_for_pick), viewer routes (incl. share UI proxies), cloud auth + sync, schema migrators, share validation, doctor diagnostics, sanitizer.
- `bun run test:pwa` runs the Playwright headless-browser suite (~2s after first browser install via `bun run test:pwa:install`). Covers pair flow, IDB token, blob-URL iframe handshake, sandbox attribute integrity.

Branch protection on `main` means changes flow through PRs. Release flow: PR merge → `git tag v0.X.Y` on the merge commit → `git push origin v0.X.Y` triggers `.github/workflows/release.yml` which builds the three target triples and publishes a GitHub Release.

---

## License

[MIT](LICENSE).
