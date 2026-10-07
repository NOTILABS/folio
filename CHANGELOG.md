# Changelog

All notable changes per release. The latest version is documented in [README.md](README.md). Older entries here for reference.

## Unreleased

**Added — `session_key`: which chat a note was created in (sc-15149).** A chat client (NotiBox Kokpit) listed a topic's Folio notes only when their link had been pasted into the conversation; a note the agent created without pasting the URL was invisible there. Now the creator can pass the key of its chat session and the client asks Folio for that session's notes.

### Added

- **Schema v7**: nullable `notes.session_key` + partial index `notes_by_session`. Migration 6→7 only adds the column — older notes stay `NULL` (no backfill: there is no source of truth for an old note's session) and behave exactly as before.
- **MCP `create`**: optional `session_key` (trimmed; > 512 chars or control characters → error, nothing written). Echoed in the response.
- **MCP `list`** and **`GET /api/list`**: `session_key` filter. Present-but-empty matches nothing (never "no filter"); invalid → `400` on the HTTP route.
- **`replace`**: the new revision inherits the old one's `session_key`.
- **CLI `folio new --session-key <key>`**.
- Not synced to the cloud: a session key only means something to the box that runs the agent.

## v0.43.0 — 2026-09-29

**Changed — no more `127.0.0.1` posing as a shareable link (sc-6716).** Without `viewer_public_url`, `create` returned `public_url` = `local_url` = `http://127.0.0.1:4810/n/<id>` and a `response_hint` telling the agent to send it as `MEDIA:` — even with cloud sync paired. Relayed to a phone or another LAN, that link is dead. Now the local address is never presented as public.

### Changed

- **MCP `create`**: `public_url` is `null` when `viewer_public_url` is not set (was: the local URL). A new **`share_hint`** field says what to do instead: paired with a cloud → call `publish({ id })` and send its `/p/<token>/n/<id>` URL; not paired → there is no external link. `response_hint` no longer contains a `MEDIA:` line with `127.0.0.1`. Live notes: `stream_url` is `null` in the same case (`local_stream_url` unchanged).
- **MCP `replace`**: `new_public_url` is `null` without `viewer_public_url`, plus `share_hint` for the new id.
- **MCP `version`**: `public_url` is `null` without `viewer_public_url`.
- **MCP `attach_asset`**: `url` is the relative `/t/<thread>/asset/<file>` path without `viewer_public_url` (was: absolute `127.0.0.1` URL) — the form `body_html` should use anyway.
- **CLI `folio new --json`** now also returns `public_url` (same rule) and `share_hint`; the text output prints the hint under the local URL.
- `local_url` / `new_local_url` / `local_stream_url` stay as before (back-compat). With `viewer_public_url` set, nothing changes.
- New `viewerShareableBaseUrl(cfg)` (config) returns the configured public base or `null`; `viewerPublicBaseUrl` keeps its local fallback for the viewer's startup banner only. `shareHint(id)` (sync) builds the hint from the pairing state.
- Skill (step 7 of SKILL.md, reference/assets.md), README and docs/mcp-setup.md: a link for a human is never `127.0.0.1` / `localhost` — `publish` first.

## v0.40.1 — 2026-05-30

**Fixed — sidebar collapse fallout on smaller screens.** v0.40.0 shrank the sidebar's *width* to 40px on collapse, which made content wrap inside the strip and surfaced a scrollbar; on narrower screens the sidebar also jumped to full width and pushed the note below it. This patch makes the sidebar behave like a real drawer at every width — sliding off to the left on collapse, with no wrapping, no scrollbar in the strip, and no layout jump.

### Fixed

- **Sidebar content slides off to the left on collapse** instead of shrinking width. Content lives in a new `.side-content` wrapper (`min-width: 360px`) that animates `transform: translateX(-100%)` + `opacity`; `.note-side` gets `overflow: hidden` in the collapsed state. No more text wrap inside the 40px strip, no more vertical scrollbar.
- **No more "sidebar jumps to full width" on small screens.** Removed two `@media` rules (`max-width: 720px` and a second hidden inside `max-width: 860px`) that re-stacked the layout to a single column. The drawer pattern now applies at every width.
- **Right padding inside the sidebar restored.** Padding moved from `.note-side` onto `.side-content` (with `box-sizing: border-box`) so the wrapper's `min-width: 360px` doesn't push content right up against the border. The action card, pin toggle, and TOC items get their breathing room back.
- **Stale explicit-expanded preference no longer pins the sidebar open.** Only an explicit **collapse** is persisted (as `"1"`); clicking *expand* now removes the pref instead of writing `"0"`, so a smaller screen auto-collapses again on the next load. Any legacy `"0"` is cleaned on first load.

### Changed

- Auto-collapse breakpoint **1024px → 1280px** (most laptops also benefit).
- New debounced (120 ms) `resize` listener re-evaluates the auto-collapse default while dragging the window across the breakpoint, so users don't get stranded with a sidebar that suddenly dominates the viewport.

## v0.40.0 — 2026-05-30

**Added — sidebar collapse toggle on note pages, with auto-collapse on smaller screens.** A small chevron at the top of `.note-side` toggles between the full 360px column and a 40px strip, freeing reading room without taking the user to a separate layout. Animated.

### Added

- **`.side-toggle` button** at the top of every note's sidebar. Click toggles `.note-shell.is-side-collapsed`, which flips `--side-w` from `360px` → `40px` (CSS variable driving `grid-template-columns`). Transition: `grid-template-columns 220ms ease` + sidebar-content `opacity 130ms`. The chevron rotates 180° in the collapsed state. `aria-expanded` / `aria-label` update both at load and on click.
- **Auto-collapse on smaller screens.** Initial state: an explicit `localStorage["folio-side-collapsed"]` preference wins; otherwise the sidebar starts collapsed when `matchMedia("(max-width: 1024px)")` matches. Stacked-mobile (≤720px) layout is untouched and the toggle is hidden there (the sidebar is already a top strip).
- A short `.no-anim` window on first paint suppresses the transition so the initial state lands without sliding in from the full width.

## v0.39.0 — 2026-05-28

**Added — `body_path` on `create` / `replace`, so large note bodies aren't truncated.** A big `body_html` passed inline can be silently cut off by the agent runtime before it reaches Folio (the MCP tool-call argument size ceiling) — an agent trying to save a ~50KB transcript would get a truncated note and start improvising disk-write hacks. Folio itself has no body-size limit; the bottleneck was the inline argument.

### Added

- **`create` and `replace` accept `body_path`** — an absolute path Folio reads **server-side**, bypassing the tool-call argument size limit entirely. Mutually exclusive with `body_html`; provide exactly one. Sanitized identically. Use it for transcripts, long docs, pasted logs — write the HTML to a file and point Folio at it.
- The skill (SKILL.md) now tells agents to reach for `body_path` on large bodies instead of cramming `body_html`.

### Changed

- `body_html` is no longer a *required* schema field on `create`/`replace` (since `body_path` is the alternative); the handlers enforce that exactly one is given, with clear errors (`Provide exactly one of: body_html, body_path.`, `body_path does not exist: …`).

## v0.38.0 — 2026-05-27

**Fixed — `folio install --target openclaw` now installs the skill as a copy, not a symlink, so OpenClaw actually loads it.** OpenClaw's skill loader rejects any skill whose realpath escapes its workspace root (a supply-chain "symlink-escape" guard). Folio installed its skill as a symlink into `/opt/folio/<ver>/skills/folio` — outside the root — so OpenClaw silently skipped it (`"reason":"symlink-escape" … "Skipping escaped skill path outside its configured root."`). The agent got the MCP tools but **zero guidance** from SKILL.md/STYLEBOOK/examples. This quietly affected the whole OpenClaw fleet.

### Fixed

- For the `openclaw` target, the skill **and** the `folio-event-watcher` hook are installed as **copied directories** (`cp -rL`), not symlinks — the only form OpenClaw's loader accepts when the bundle lives outside the workspace. Other OpenClaw skills (gog, 1password, …) are already real dirs; Folio was the lone symlink.
- The copied dir is stamped with a `.folio-version` marker. Reinstall and `folio update` detect version drift and re-copy (idempotent: same version → noop); a legacy symlink is detected and replaced by a copy.
- `folio doctor` now reports an OpenClaw skill copy as `ok (copy, vX)`, flags a leftover symlink as `wrong-target` (re-install to fix), and a version-drifted copy as `stale`. (Previously it mislabelled the correct copy as `wrong-target` and suggested a "refresh" that re-broke it.)
- `folio uninstall --target openclaw` removes the copied skill/hook dirs (a directory without the Folio marker is left untouched).

### Internal

- New `copyDir` / `rmDir` plan actions in the install engine (apply in the shared `applyPlan`).

## v0.37.0 — 2026-05-26

**Changed — live-note todo entries render as a checklist, not a log.** Entries carrying a `state:*` tag (i.e. tasks) now show as a checklist row in the Feed view: a checkbox reflecting the state, the task text as the main line, and the timestamp + remaining tags demoted below. Plain entries (journals, logs, no `state:`) keep the timestamp-led feed layout — only todos change.

### Changed

- Feed-view `state:*` entries render `<button class="entry-check">` + `.entry-body` (content over a demoted meta) instead of a timestamp-led log line. The checkbox shows ✓ (done), ✕ (cancelled), a dot (in_progress), or empty (open); done/cancelled strike through the text. The redundant `state:*` pill is dropped from the row. Styling lives in `entries-css.ts`, so it applies to the inline feed, the server initial paint, and finalized notes alike.
- The Feed checkbox is **clickable** — it posts the same `folio-feed` move the Kanban view uses, so toggling a task persists (and is readable by the agent via `list_entries`).

### Fixed

- A tag-only follow-up (a `state:*` change with empty content) now updates the referenced task row in place instead of appending an empty entry to the feed.

### Notes

- Inline live notes only this release; panel-mode feeds keep the prior look.

## v0.36.0 — 2026-05-25

**Added — `folio install` can wire the Claude Code MCP globally (every project), and a bare install now asks.** Previously the installer only ever wrote a per-project entry (`projects[<cwd>].mcpServers.folio`), so Folio had to be re-installed in each repo. You can now install it once at user/global scope.

### Added

- **`--global` flag** on `folio install` / `folio uninstall` (Claude Code target) → writes the single top-level `mcpServers.folio` in `~/.claude.json`, available in **every** project, instead of a per-project entry.
- **Bare interactive `folio install` prompts** for scope: *"Install Folio's MCP globally for Claude Code (available in every project)? [Y/n]"* — default global; `n` falls back to the per-project directory prompt. Non-interactive (`--yes` / piped stdin) keeps the previous per-project (cwd) default, so scripts are unaffected.
- Global scope is handled across the whole lifecycle: `uninstall --global` (and `uninstall --all-scopes`, which now also sweeps the global entry), `folio doctor` lists it as scope `global`, and `folio update`'s refresh re-points the global entry's command to the new binary.

## v0.35.0 — 2026-05-25

**Added — link-preview cards now render as PNG, so shared links unfurl with an image.** Capability share pages (`/p/<token>/n/:id` and `/t/:thread`) already emitted an `og:image`, but it pointed at an **SVG** — which X/Twitter, Slack, Discord, iMessage, and Facebook/LinkedIn refuse to render, so previews showed a title with no card. `og:image` now points at a rasterized **PNG**.

### Added

- **`/p/<token>/og.png`** — the OG card (theme accent, scope chip, title, `folio.` wordmark) rasterized from the existing SVG via `@resvg/resvg-wasm`. The `og:image` / `twitter:image` meta on shared note and thread pages now point here (`image/png`). The `og.svg` route stays as a fallback, and `og.png` itself degrades to SVG if the rasterizer is unavailable.
- **`og:description` / `twitter:description`** on shared note pages, sourced from the note summary (truncated). Threads carry a note-count description.
- **`og/` sidecar** shipped beside the binary (resolved via `config.bundledOgDir()`): `resvg.wasm` + the bundled brand font `FamiljenGrotesk.ttf` (OFL) — resvg-wasm has no system fonts, so card text needs a provided face. Loaded lazily at first render; **not** embedded in the binary, so the CLI stays lean.

### Notes

- Takes effect after a cloud redeploy (`sudo folio-cloud-deploy`) — the binary + `og/` sidecar ship to `/opt/folio`.
- Unaffected: only `/p/<token>` capability links unfurl; the authed per-user `/n/:id` page is a JS shell behind auth (previewer bots get a redirect).

## v0.34.3 — 2026-05-23

**Fix — images broke on `set`-scoped shares ("Include linked notes").** A set share grants a bundle of notes that can span threads, but the capability **asset** route's scope check only matched the **root note's** thread. An image living in a *linked* note's (different) thread returned "not found" — the note rendered, only its `<img>` was broken.

### Fixed

- The `/p/<token>/t/<thread>/asset/<file>` scope check now accepts an asset whose thread is the thread of **any** note the set grants (`share_notes`), not just the root note. Thread- and note-scoped shares are unchanged.

## v0.34.2 — 2026-05-23

**Fix — `set`-scoped shares ("Include linked notes") returned "not found".** A set share is anchored at its root note, so it must land on `/p/<token>/n/<root-uuid>`. Three spots built the capability path with `scope_type === "note" ? "n" : "t"`, routing anything not exactly `"note"` — including `"set"` — to `/t/`, where `validateShareAccess` rejects a note uuid as a thread. Most visible after a recipient confirmed their email: the redirect went to `/t/<uuid>` → not found.

### Fixed

- Confirm-recipient redirect, `qr.svg` URL, and the `/v1/shares` list URL now use `scope_type === "thread" ? "t" : "n"` (matching the share-creation path) — thread → `/t/`, note **and set** → `/n/`. Existing set shares work once deployed; no need to recreate them.

## v0.34.1 — 2026-05-23

**Fix — the Share popover could slide off the bottom of the screen.** The `position:fixed` Share popover is anchored to the sidebar trigger; it was repositioned only on open and had no height cap, so when its content grew after opening (publish result, error message, the "active shares" manage bar) — or on a short window — part of it ended up below the viewport.

### Fixed

- `.share-pop` now caps its height to `calc(100vh - 24px)` with `overflow-y:auto` (scrolls internally as a last resort; the left arrow is preserved via `overflow-x:hidden`), and `positionNearTrigger()` re-runs whenever the popover's height changes (publish result, `showError`, manage-bar toggle) — so the popover always stays fully on-screen.
- New e2e `tests/pwa/share-popover.e2e.ts` drives the real local viewer in a short window and asserts the popover is fully within the viewport.

## v0.34.0 — 2026-05-23

**Share recipients can pick a variant.** Shared notes were read-only ("owner picks"). Now a capability-URL recipient — the client you send the link to — can choose between options. Mark each option in a `comparison` note body with `data-folio-pick="<id>"` (+ optional `data-folio-pick-label`), publish with `--allow-pick`, and the recipient gets a "Wybieram ten" button per block. Their choice is recorded as a soft signal and surfaces in your Share manager.

### Added

- **`data-folio-pick` convention + opt-in `allow_pick` shares.** Per-share opt-in via `folio publish <id> --allow-pick`, the `publish` API's `allow_pick`, or the viewer Share popover's **"Let recipient pick a variant"** checkbox. The cloud injects a pick affordance into every `[data-folio-pick]` block on the recipient's view; inert on read-only shares and on the local viewer.
- **`POST /p/:token/pick`** (`src/cloud/server.ts`) — validates the share is live + `allow_pick` + in-scope (plus the recipient cookie for email-bound shares), then records to the new **`share_picks`** table. `allow_pick` + `picks` now ride on `/v1/share` + `/v1/shares`.
- **Owner-side surfacing** — `/n/:id/shares` shows *"Client picked: X"* per share; last-pick-wins, `pick_count` tracks changes of mind.
- **Tests** — 9 unit (`cloud-shares.test.ts`) + 2 browser e2e (`tests/pwa/share-pick.e2e.ts`).

### Notes

- **Deliberately separate from `iteration` notes.** A pick here is a one-shot preference — it does NOT drive the iteration state machine, `wait_for_pick`, or any agent reaction; the owner just *sees* it. For "agent reacts to the pick" (generate the next round, refine), use a real `iteration` note + `propose_round`.
- **Architecture** — the body iframe is null-origin + CSP `connect-src 'none'`, so it `postMessage`s the pick to the parent `/n` page, which `POST`s it to the cloud (mirrors the local viewer's `iteration-pick` split). No client→local back-channel.
- **Schema** — `shares.allow_pick` + `share_picks` added via idempotent ALTER / `CREATE TABLE IF NOT EXISTS`; existing cloud DBs upgrade on next boot, pre-existing shares stay read-only.

## v0.33.0 — 2026-05-22

**Auto-sync when paired — no more manual `folio sync`.** A sync daemon already existed (`folio sync`), but you had to start and keep it running as a separate process; the viewer didn't sync, and agent-created notes waited for a manual sync (the v0.32 "must be synced first" friction). Now, when paired, sync happens in the background.

### Added

- **`autoSyncTick()`** (`src/core/sync.ts`) — best-effort background sync: no-op when unpaired or `auto_sync` is off; honours the same `.sync.lock` as the standalone daemon (a tick is skipped if one is running); never throws. **`scheduleAutoSync()`** debounces it (coalesces rapid writes; unref'd so it never keeps a process alive).
- **`folio serve` runs a background sync loop** when paired + `auto_sync` (every 30s). The interval is cleared on `server.stop()` so it never outlives the process.
- **MCP sync-on-write**: `create` / `replace` / `append_entry` / `finalize` schedule a debounced sync, so agent output is pushed to the cloud within ~1.5s — a hub published with `include_linked` now finds its linked notes already up.
- **`auto_sync` config flag** (`FolioConfig`, default `true`). Set `false` to require explicit `folio sync`. The standalone daemon still works for headless deploys.

### Notes

- Conflict-free by construction (append-only) and lock-guarded, so the viewer loop, the MCP hook, and a standalone daemon coexist without double-work.
- No new privacy surface: pairing is already the opt-in to the relay; `auto_sync:false` keeps push-on-demand.

### Tests

- New `tests/auto-sync.test.ts` (4): unpaired no-op, disabled no-op, lock-skip (daemon coexistence), debounce-never-throws. Full suite **681 pass**.

## v0.32.0 — 2026-05-22

**Share a note *and* the notes it links to.** Publishing a hub/index note used to share only that one note — its `/n/<id>` links 403'd for the recipient (capability URLs grant a single scope; the v0.31.1 caveat). New **`set` share scope** grants the note *plus* the notes it links to. Opt in with the Share popover's **"Include linked notes"** checkbox or `publish({ include_linked: true })`.

### Added

- **`set` share scope** (`src/cloud/shares.ts`, `src/cloud/db.ts`). New `share_notes(token, note_uuid)` table holds the bundle membership. `createShare({scope_type:"set"})` computes the linked set and snapshots it; `validateShareAccess` gates `/p/<token>/n/<uuid>` by membership. Threads aren't grantable through a set (it's a note bundle).
- **`computeLinkedNoteSet(rootUuid, userId, db, {maxDepth, cap})`** — follows `/n/<id>` links in note bodies transitively (default depth 3, cap 50), cloud-side over synced bodies. Cycle-safe; skips dangling/foreign links (no leak); only the creator's own notes are included.
- **`publish` MCP tool** gains `include_linked` → `set` scope; response carries `note_count` (root + linked).
- **Viewer Share popover** gains an **"Include linked notes"** checkbox; the success line shows the bundle size ("Published · N notes (this + N−1 linked)").

### Changed

- The cloud `/v1/share` handler accepts `scope_type:"set"`; `set` shares land at the root note (`/p/<token>/n/<root>`). The viewer share proxy maps `include_linked` → `set`.
- **`skills/folio/STYLEBOOK.md`** — the published-hub caveat now points at `include_linked` instead of "publish at thread scope".

### Notes

- **Snapshot, not live**: the set is frozen at publish time — re-share to pick up new links (editing the note doesn't silently widen an existing share). Linked notes must be synced to the cloud to be included.
- **Consent**: the checkbox is off by default and the result states how many notes the bundle grants, so sharing a bundle is explicit.

### Tests

- New `tests/share-set.test.ts` (4): transitive/cycle-safe/bounded link set, dangling-link skip, membership-gated access, thread-request denial. Full suite **677 pass**.

## v0.31.1 — 2026-05-22

**Cross-note links break out of the iframe + survive publish.** When a note links to another Folio doc (`/n/<id>`, `/p/<slug>`, `/t/<thread>`, `/tag/…`), the click used to navigate the note's own sandboxed body iframe — loading the entire viewer *inside* the note ("Folio-in-Folio"). And a full-domain link (`http://127.0.0.1:4810/n/…`) died the moment the note was opened on another host or as a published capability URL. Now internal links break out to the **top** window and resolve against the **current scope**.

### Changed

- **`src/viewer/note-bootstrap.ts`** — new `attachInternalLinks()`: delegated, capture-phase click handler that relays internal-link clicks to the parent as `{ns:'folio', type:'navigate', href}` (the sandbox has no `allow-top-navigation`, so postMessage is the only route). Same-host full URLs are normalised to their path; modifier-clicks/cross-host links fall through to the existing new-tab behaviour.
- **`src/viewer/render.ts`** — `pageNote` parent gains a `navigate` case: validates the path is internal (`^/(n|p|t|tag|threads)`) and navigates the **top** viewer window.
- **`src/cloud/render.ts`** — the `/raw` body (`renderStandaloneNote`) gets the same interceptor; the capability page (`renderSharedNotePage`) navigate handler **prefixes `/p/<token>`** so links stay inside the granted scope; the PWA `/n/` shell (`renderNotePage`) navigates root-relative.
- **`skills/folio/STYLEBOOK.md` + `SKILL.md`** — agents must write cross-note links **root-relative** (`/n/<id>`), never with a host; documents the publish-scope caveat (a note-scope share 403s on links to other notes — publish hubs at thread/project scope).

### Tests

- New `tests/internal-links.test.ts` (5): bootstrap relays navigate; local `pageNote` parent handles it; all three cloud shells (raw interceptor, capability token-prefix, PWA root-relative) present. E2E-verified in a real viewer (clicked an `/n/` link → top window navigated, no nesting). Full suite **673 pass**.

## v0.31.0 — 2026-05-22

**Project workspace shows notes, not just threads.** The `/p/<slug>` dashboard used to render one card per thread (count + latest) — to reach a specific note you clicked the thread, then the note. Now each thread card lists **its notes inside it**, each row clicking straight through to `/n/<id>` (one click). Recent activity is demoted to the bottom. Design picked from a 3-variant Folio iteration (variant C). Render-only — `getProjectDashboard` already returned `threadGroups[].notes`.

### Changed

- **`pageProject`** (`src/viewer/render.ts`): the "All threads" card grid → a **Threads** section of per-thread cards, each with a header (thread name links to `/t/<thread>`, plus count · latest · ★ final) and its notes listed as rows inside (`type` badge · title · ago, with `● live` / `★` flags). Each row links to `/n/<id>?from=project:<slug>`. Section order is now Slots → Pending → **Threads** → **Recent activity** (activity moved from 3rd to last). New `.proj-tcard` / `.proj-nrow` styles replace `.proj-thread`.
- **`skills/folio/SKILL.md`**: the `/p/<slug>` description updated to reflect notes-inside-cards.

### Tests

- `tests/project-dashboard.test.ts` (+1): asserts thread cards render note rows linking to `/n/<id>`, the card header links to `/t/<thread>`, and Recent activity sorts below the Threads section. Full suite **668 pass**.

## v0.30.6 — 2026-05-22

**Skill: warn agents not to translate tag keywords.** The Language note tells agents to match trigger *intents* in any language — but a multilingual agent could "helpfully" localize a tag prefix (`projekt:` instead of `project:`), which silently breaks grouping: the note still lands under `/tag/projekt:<slug>` but `/p/<slug>` stays empty (the workspace matches the literal ASCII `project:`).

### Changed (skill docs only)

- **`skills/folio/SKILL.md`** — added a callout in the project-tag section: keep every code-interpreted namespace verbatim ASCII — `project:`, `slot:`, `state:`, `view:pinned` — plus the canonical `state:` values (`open` / `in_progress` / `done` / `cancelled`, matched literally by the kanban lanes). Only the prose *inside* an entry gets translated.

## v0.30.5 — 2026-05-22

**Skill examples made product-neutral.** Folio is a general visual-communication layer (hardware-agnostic), but the skill's worked examples had all been written while dogfooding on one product (NotiBox / Jetson / cameras / `notibox.ai` hosts). That biases an agent's mental model toward "Folio is a device/edge thing" — exactly the wrong frame for a tool meant to work in any context. Examples only; no behavior, triggers, or description changed.

### Changed (skill docs only)

- **`skills/folio/SKILL.md`** — presentation example "Project NotiBox-Jetson / 12 cameras · 4 sites · 1 NotiBox per site" → "Project Atlas / 3 teams · 14 services · 1 launch"; the whole slot-workflow walkthrough re-based from `project:notibox-jetson` (cameras, "wire up cam-2") to a generic software project `project:web-redesign` ("add the password-reset flow").
- **`skills/folio/STYLEBOOK.md`** — Mermaid sequence-diagram example re-based from `Klient (LAN)` → `vendor.notibox.ai` to `User (web)` → `api.example.com` (kept the `#40;…#41;` paren-escape demonstration).
- **`skills/folio/reference/assets.md`** — example asset URLs `my-zeszyt.local` / `my-zeszyt.notibox.ai` → `my-folio.example.com`.

Real infrastructure references (the `folio.notibox.ai` live demo in the README, deploy comments in `src/`) are left as-is — those are the maintainer's actual hosting, not part of the product's definition.

## v0.30.4 — 2026-05-21

**Fix: the `replace` MCP tool threw on every call.** The handler built its response URLs with `viewerLocalBaseUrl()` and a hand-rolled `viewer_public_url` fallback but passed **no `cfg` argument** — so `cfg.viewer_host` threw on first access. Every other handler (`create`, `version`, `attach_asset`) passes a loaded `cfg`; this one didn't, and no test exercised the tool, so it shipped (surfaced while testing Phase 3). The storage primitive `replaceNote` was always fine — only the MCP tool's URL-building was broken.

### Fixed

- **`replace` MCP tool** (`src/mcp/server.ts`): loads `cfg` via `loadConfig()` and uses `viewerLocalBaseUrl(cfg)` / `viewerPublicBaseUrl(cfg)` (the latter already encapsulates the `viewer_public_url`-or-local fallback), consistent with the other handlers.

### Tests

- `tests/mcp.test.ts` (+1): the `replace` tool returns `ok:true` + well-formed local/public URLs — a regression guard for the missing-`cfg` bug. Full suite **667 pass**.

## v0.30.3 — 2026-05-21

**Docs caught up to the mutation model — Phase 4 (final phase).** The ADR-014 language in `AGENTS.md` still said "agents only CREATE, never UPDATE / no `folio.update` tool / no in-place mutation" — false since v0.22 (`replace`, `update_metadata`) and stale after the v0.30.x unification. Rewritten to the accurate invariant. No production code touched.

### Changed (docs only)

- **`AGENTS.md`** — the ADR-014 passages now state the real invariant: **append-only _per revision_** (a note's body bytes never change in place; a note evolves by appending — `replace` for documents via the `superseded_by` chain, `.entries.jsonl` for live/iteration). Clarified that `finalize` and `update_metadata` are the two `.html` rewrites that *preserve* body bytes (body evolution only via `replace`). Added `note-log.ts` to the directory map (the one classifier) and corrected the stale "15 tools" → 23.
- **`skills/folio/SKILL.md`** — added `list_revisions` to the tool list and the mutation decision tree ("show me previous versions"), plus a note that the `replace` chain is inspectable (a document behaves like a versioned log), not lost.

Full suite **666 pass** (doc-only; no test changes).

## v0.30.2 — 2026-05-21

**Document revision history surfaced — `list_revisions` + viewer strip.** Phase 3 of the mutation-model unification. The `superseded_by` chain a document accumulates through `replace` was already an append-only log of immutable revisions — but it was invisible: old revisions are hidden everywhere and there was no way to see the version history. This surfaces it, so a document visibly behaves like a versioned log. Identity and capability-URL semantics are unchanged — each revision keeps its own immutable `/n/<id>`.

### Added

- **`getRevisionChain(id)`** (`src/core/storage.ts`) — returns the full chain a note belongs to, oldest → newest (head last), from any id in it. Walks to the head, then backward via the `notes_by_superseded` index. A never-replaced note yields a single-element chain (itself); `maxHops` guards corrupt data.
- **`list_revisions` MCP tool** — returns `{ note_id, count, revisions: [{ id, version, title, created, word_count, is_head }] }`. Read-only. Lets an agent see prior versions before `replace`, or reference an older revision.
- **Viewer revision strip** (`src/viewer/render.ts` `pageNote`) — when a note is part of a chain (length > 1), the note-side panel shows linked `v1 · v2 · …` chips, current highlighted, head marked ★. Single-revision notes (the common case) render nothing. Each chip links to that revision's own `/n/<id>`.

### Tests

- `tests/replace.test.ts` (+4): `getRevisionChain` single + multi-revision resolved from any id in the chain; viewer strip present for a chain (current/head marked) and absent for a single note.
- `tests/mcp.test.ts` (+2): `list_revisions` chain shape + `is_head` flags; unknown-id error. `tests/live-mcp.test.ts`: tool count 22 → 23.
- Full suite **666 pass**.

### Known issue (pre-existing, not addressed here)

- The `replace` **MCP tool** builds response URLs via `viewerLocalBaseUrl()` before `await loadConfig()`, so on a cold config cache it can throw `cfg.viewer_host`. Surfaced while testing; left for a separate fix since it's unrelated to this change and out of scope.

## v0.30.1 — 2026-05-21

**Fix: `superseded_by` now syncs across devices.** Phase 2 of the mutation-model unification. Before this, a `replace` on one device never hid the old revision on another — the supersede pointer lived only in the local DB and was absent from the sync payload. And adding it to the payload alone wasn't enough: `pushNotes` selects by `created`, but `replaceNote()` bumps the old note's `updated` (not `created`), so the old note was never re-pushed. Fixed with a dedicated push pass that mirrors `pushDeletes`.

### Added

- **`pushSupersedes()`** (`src/core/sync.ts`) — a separate push pass with its own `updated`-keyed cursor (`last_supersede_pushed_at` in `SyncState`), exactly like `pushDeletes`. Re-pushes the full payload of any active note whose `superseded_by` is set; the cloud `INSERT…ON CONFLICT` upserts the pointer, so there's no "must already exist on cloud" ordering dependency. Wired into `syncOnce` after `pushNotes`.
- Shared **`buildNotePayloads()`** helper + `NotePushRow` type + `NOTE_PUSH_COLUMNS` constant so `pushNotes` and `pushSupersedes` can't drift on which columns they send.

### Changed

- **`superseded_by` threaded through the wire**: `PushNotePayload` / `PullNote` (`src/core/sync.ts`), the pull upsert in `applyPulledNote`, the cloud `PushNote` / `PullNote` shapes + push INSERT + pull SELECT (`src/cloud/sync.ts`), and the cloud `notes` schema + idempotent ALTER (`src/cloud/db.ts`). Optional on the pull side for back-compat with older cloud builds (defaults null).

### Scope note

- Deliberately narrow to supersede pointers. The same `created`-cursor gap means `finalize` / `is_pinned` updates to already-synced notes also don't propagate — but `finalize` propagation is intentionally per-device (`src/core/storage.ts`), so general metadata-update sync is left as a separate decision rather than turned on as a side effect.

### Tests

- `tests/sync-daemon.test.ts` (+2): replace-after-first-sync propagates the pointer to the cloud DB via `pushSupersedes`; a foreign superseded note pulled from cloud writes `superseded_by` locally and is hidden from default listings. Full suite **660 pass**.

## v0.30.0 — 2026-05-21

**Unified note classification — `note-log.ts`.** Phase 1 of the mutation-model unification (C-minimal; design notes in the `folio-model-edytowalnosci` thread). The "which substrate is this note, and how does it render" decision was implicit boolean logic duplicated across `storage.ts finalize()` and `render.ts pageNote()` — the "keep four in sync" hazard called out in AGENTS.md. It now lives in one place. Pure refactor: zero behavior change.

### Added

- **`src/core/note-log.ts`** — single source of truth for note classification:
  - **`strategyOf(note)`** → `document | feed | iteration` — the durable substrate. Checks `live` before `type`, faithful to `finalize()`'s historical order; a finalized former-live note (`live=0`) classifies as `document`.
  - **`renderModeOf(note)`** → `document | live-panel | live-inline | iteration-gallery` — the viewer branch. Folds in `is_final` so finalized feed/iteration notes collapse to a static `document` (no live chrome, no gallery auto-refresh).
  - Doc comment carries the substrate-model table (document → `superseded_by` chain; feed/iteration → `entries.jsonl` + the pure compile functions) — the conceptual home for the unification.

### Changed

- **`finalize()`** (`src/core/storage.ts`) dispatches the feed/iteration compile step through `strategyOf` instead of inline `if (note.live) … else if (type === "iteration")`.
- **`pageNote()`** (`src/viewer/render.ts`) computes one `renderModeOf(note)` instead of scattered `isLive` / `isInlineLive` / `type === "iteration"` checks.

### Tests

- New `tests/note-log.test.ts` (12 tests): `live`-before-`type` precedence, finalized feed/iteration collapse to `document`, all four render modes. Full suite **658 pass**.

## v0.29.3 — 2026-05-20

**Fix: home list rendered "Yesterday" before "Today" when a pinned note was older.** Regression from v0.29.0. `listNotes` sorts `is_pinned DESC, pinned_at DESC, created DESC`, so a pinned older note floats to the front of the array; `pageList` built its date groups by `Map` insertion order, so a pinned note from yesterday seeded the "Yesterday" group first and it rendered above "Today".

### Fixed

- **`pageList`** (`src/viewer/render.ts`): pinned notes now render in their own **📌 Pinned** section above the date groups (and are excluded from their date group — no duplication). Date groups are sorted strictly newest-first by the freshest note in each, independent of `Map` insertion order, so a future change to the `listNotes` sort can't perturb section order again. New order: `Pinned → Today → Yesterday → This week → This month → Older`.

### Tests

- New `tests/home-list-order.test.ts` (3 tests): Today-before-Yesterday with a pinned yesterday note, pinned note not duplicated into its date group, plain (no-pin) date ordering.

## v0.29.2 — 2026-05-20

**Diagram authoring guidance for agents.** Agents were defaulting to ASCII-art `<pre>` boxes for architecture/sequence/flow diagrams. Folio notes render in a real browser — they should use real graphics. Adds an explicit ladder to the Folio skill so future notes reach for proper diagrams.

### Changed (skill docs only — no code)

- **`skills/folio/STYLEBOOK.md`** — new **"Diagrams — don't default to ASCII art"** section with a pick-by-need ladder: Mermaid (cheapest, declarative, CDN) for static diagrams → D3/Cytoscape (data as a JS object) for interactive → hand-authored inline `<svg>` for offline-guaranteed → ASCII only for genuinely-textual cases. Documents the verified sandbox facts: Mermaid works out of the box (`<pre>` entity-escaping is decoded by the browser in `.textContent`, which `mermaid.run()` reads — no decode boilerplate needed; the earlier assumption that it breaks was wrong), the `#40;`/`#41;` escape for parens in labels, and the CSP `connect-src 'none'` constraint (libs must render from inline data, CDN script load is fine).
- **`skills/folio/SKILL.md`** — anti-pattern entry against ASCII-art diagrams pointing at the stylebook ladder.

## v0.29.1 — 2026-05-19

**Readable header tag chips.** The popular-tag filter bar (`.v-tagbar`) had been inheriting only padding/font-size from `.tag-chip` — every other visual rule was scoped to `.tag-cloud`, so chips in the header rendered as plain unstyled text. Result: `kind:bug3 klient:acme3 project:folio5…` ran together as one unreadable string.

### Fixed

- **Header tag chips now reuse the side-panel `.side-tags .tg` pill aesthetic** (`src/viewer/render.ts`): monospace, muted background, line border, namespace prefix dimmed (`ns:` in muted gray), value bolded, count separated by a thin vertical divider. Hover → orange border. Active (when filtering by that tag) → inverted dark fill, namespace prefix in amber.

## v0.29.0 — 2026-05-19

**User-pinned notes.** New `is_pinned` flag floats notes to the top of the default listing, plus a `📌 Pinned N` filter chip alongside `Final ★ N`. Distinct from `is_final` (archive) and `view:pinned` (entry-level tag on live notes).

### Added

#### Schema (v5→v6 migration)
- **`notes.is_pinned INTEGER NOT NULL DEFAULT 0`** + **`notes.pinned_at TEXT NULL`** (`src/core/migrations.ts`). Partial index `notes_by_pinned` on `pinned_at DESC WHERE is_pinned = 1` keeps the float-to-top sort cheap. Cloud side gets the same columns via idempotent ALTER (`src/cloud/db.ts`).

#### Storage + API
- **`updateNoteMetadata({is_pinned})`** (`src/core/storage.ts`) stamps `pinned_at = now()` on true, clears it on false. Pin-only updates skip the file rewrite path entirely — no body regenerate, no FTS touch, just an UPDATE.
- **`listNotes`** default sort is now `is_pinned DESC, pinned_at DESC, created DESC` — pinned float to the top, freshest pin above long-pinned. Skipped when `thread_id` is set so thread views stay chronological.
- New **`is_pinned`** filter option on `ListOptions`.
- **`replaceNote()`** carries the pin forward to the new head and clears it on the old superseded row — polishing a pinned note doesn't lose the pin.
- **`POST /api/notes/:id/metadata`** accepts `is_pinned` in the patch body; response includes `is_pinned` + `pinned_at`.
- **`GET /?pinned=1`** filters the home list to pinned only.

#### Viewer UI
- **📌 Pinned N filter chip** in the home filter bar (`render.ts:filterBar`), next to `★ Final` and `⏱ Expiring 7d`. Hidden when count is zero.
- **📌 indicator** in the eyebrow of the hero card (with `pinned` border accent) and as a prefix on row entries — same orange as the chip for visual parity.
- **Pin-to-top toggle** in the note's side panel under the "Mark as final" action card. Optimistic flip on click with rollback on API failure; toast confirms ("📌 Pinned to top" / "Unpinned").

#### Sync wire (cloud + local)
- `PushNote` / `PullNote` carry `is_pinned` + `pinned_at` (`src/core/sync.ts`, `src/cloud/sync.ts`). Cloud `ON CONFLICT` upsert + pull SELECT include both fields. Older cloud builds without these columns are tolerated via `?? 0` / `?? null` defaults on the receive side.
- **Note:** edit-sync of existing notes is a pre-existing limitation (push uses `created > cursor`); pin-state on freshly created notes propagates correctly. Edit-sync, when it ships, will carry pin-state for free.

### Tests
- New `tests/pinned-notes.test.ts` (9 tests) covers: default unpinned, pin stamps timestamp, unpin clears it, pin-only update doesn't touch the .html file, default sort floats pinned to top with `pinned_at` ordering, thread view stays chronological, `replaceNote` carries pin forward, no-change detection.
- `tests/migrations.test.ts` head schema_version assertion bumped to "6".

## v0.28.0 — 2026-05-19

**Three UX fixes from real usage** — newest-first feeds, project dedup on the continue rail, and tags promoted to the header bar. All surface-level; no schema change.

### Changed

#### Feeds render newest-first (within each section)
- **`renderFeedHtml()`** (`src/core/feed-render.ts`) reverses entries within both pinned and non-pinned sections before emitting HTML. `compile()` upstream still sorts ASC for correct ref application; the reverse is display-only. Matches Slack / RSS / Twitter convention.
- **`PANEL_RENDER_JS`** (`src/viewer/live-panel.ts`) applies the same `.slice().reverse()` to compiled entries before re-rendering the panel.
- **`INLINE_FEED_BOOTSTRAP_JS`** (`src/core/feed-render.ts`) `appendNewEntry()` now inserts before the first existing entry instead of appending, so live SSE deliveries land at the top of their section.

#### Continue rail caps at 4 and collapses project threads
- **`listContinueRail()`** over-fetches `limit × 4` (capped 40), enriches per-thread as before, then **collapses every thread sharing a `project:<slug>` tag into one tile** with aggregated `touch_count` + `score` (sum) and `last_touch` (max). Threads without a project tag stay individual.
- New `kind: "project" | "thread"` discriminator on `ContinueRailItem`. Project tiles always click to `/p/<slug>`; thread tiles keep the prior routing (pending iteration → `/n/<iter-id>`, else `/n/<latest>`).
- New `member_thread_count` field — `1` for thread items; ≥1 for project items (visible as `project · N threads` chip).
- **Visual:** project tiles get `.is-project` class — soft orange gradient background, `▦` glyph in the top-right corner, slug rendered as the primary title in orange. Thread tiles look unchanged.
- **Cap reduced from 5 → 4** in `server.ts` so cards fit on one row at typical viewer width.

#### Popular tags promoted to header bar
- New **`tagBar(popularTags, activeTag)`** helper in `src/viewer/render.ts` renders a `.v-tagbar` strip directly under the type/status filter row. Sort order: **namespaced tags first** (those carrying `:` — `project:`, `slot:`, `kind:`, `state:`, etc., they lead to organized data), **then non-namespaced**, both alphabetical within their bucket.
- Old bottom-of-list "Tags · N popular" section removed to avoid duplication.
- Horizontal-scroll fallback under 720px viewport via existing `.fp` flex-shrink rules.

### Tests
- `tests/v028-fixes.test.ts` (+11 tests) — feed DESC sort within pinned + rest, panel/inline reverse sentinels, project dedup + score aggregation, rail caps at 4 cards, `.is-project` tile shape, tag bar position, namespaced-first tag sort, bottom-list dedup confirmed.
- `tests/continue-rail.test.ts` (1 updated, 1 added) — updates for the v0.28 project tile shape; new test for 3-way project collapse with member counts.
- Full suite: 634 tests across 57 files, all passing (was 622).

### Migration notes
- No schema change. Existing notes / events / threads work unchanged.
- Anyone with a heavily-tagged Folio will notice the homepage compresses: tag chips moved up, bottom of the list is shorter, continue rail consolidates project threads. Click targets that already pointed at `/p/<slug>` are unchanged; thread-level click-throughs to `/n/<id>` work as before for non-project items.
- The `pending_iteration_id` priority routing now applies only to thread tiles. Project tiles always go to `/p/<slug>` first — the project dashboard surfaces "Pending picks" cards as a separate section, so it's still one extra click to the iteration. Acceptable trade for not having three "ProjectFoo" rail cards.

## v0.27.0 — 2026-05-18

**Phase 1 finishing touches** — three quality-of-life wins on top of the v0.24-v0.26 project workspace push: drag-and-drop on kanban cards, slide thumbnails sidebar in presentation mode, and inline-mode kanban (todo notes with `inline: true` now also get the Feed | Kanban toggle).

### Added

#### Drag-and-drop on kanban cards (panel mode)
- Cards carry `draggable="true"`; lanes accept drop via `dragover` / `drop` event handlers.
- Visual feedback: card gets `.is-dragging` (opacity + scale-down); target lane gets `.is-drop-target` (inset orange ring + accent header color).
- Same-lane drop is a no-op (no API roundtrip for "nothing changed").
- Different-lane drop fires the same `move` postMessage as the move buttons → chrome → `POST /api/notes/:id/entries` → SSE redelivers → card moves lane in real time.
- Move buttons stay (keyboard / touch fallback when DnD isn't ergonomic).

#### Slide thumbnails sidebar (presentation mode)
- Left rail with miniaturized slide previews. Each shows slide number + first heading / text sample. Current slide highlighted via `.is-current` (orange border + soft glow).
- Click thumb → jumps to slide N. Enter / Space activates focused thumb (keyboard accessible).
- New `T` key: toggle rail visibility. Preference persists in `localStorage` under `folio-pres-thumbs`.
- Rail auto-hides in fullscreen (CSS hooks on `body.is-fullscreen`, set by the new `fullscreenchange` listener).
- Body uses CSS grid (`grid-template-columns: 140px 1fr`) when rail visible; degrades to single-column flow in fullscreen.

#### Inline-mode kanban
- Live notes with `inline: true` (the default for journals / todos) now also get the Feed | Kanban toggle, sitting just above the `<section data-folio-live-feed>` placeholder. Hidden by default; surfaces automatically when at least one entry carries a `state:*` tag.
- Body iframe runs a client-side mirror of `core/live.ts compile()` to derive `compiled_tags` + `state` + `pinned` from the raw entry stream. Same compile rule the panel mode uses.
- Per-note localStorage key `folio-inline-view:<note-id>` persists the toggle choice across reloads.
- 4 lanes (Open / In progress / Done / Cancelled) with per-card move buttons + drag-and-drop (mirrors panel mode's DnD wiring).
- Move click → `postMessage` to chrome with `{ns:'folio-feed', type:'move', entry_id, state}`. Chrome forwards to `POST /api/notes/:id/entries`. SSE re-delivers the new entry → kanban recompiles + lanes redraw automatically.

### Changed
- `INLINE_FEED_BOOTSTRAP_JS` in `src/core/feed-render.ts` extended ~6× — gains the compile function, kanban renderer, toggle UI mount, DnD wiring. Feed-view append path is unchanged.
- `/raw/:id` handler injects `<script>window.__folioInlineNoteId = …</script>` for inline-rendered live notes so the bootstrap knows its own note id (used for the localStorage key + future inline-only flows).
- Inline-live chrome script in `pageNote` (the parent-side EventSource forwarder) now also listens for `move` messages from the body iframe and forwards them to the entries endpoint. Same forwarding contract as panel mode.
- `<iframe class="note-iframe">` carries `allow="fullscreen"` (was added in v0.26 for presentation; this just notes it's universal — works for any future fullscreen-using note).

### Tests
- `tests/kanban-dnd-thumbs-inline.test.ts` (+12 tests):
  - **Panel DnD:** `draggable="true"` attribute on cards, `data-lane-state` on lanes, dragstart/dragover/dragleave/drop bound, `.is-dragging` + `.is-drop-target` CSS, same-lane no-op guard
  - **Slide thumbnails:** `.thumbs-rail` + `.thumb` + `.thumb.is-current` CSS, JS builds rail / wires T key / persists in localStorage, `fullscreenchange` listener toggles `body.is-fullscreen`, end-to-end `GET /raw/` of a presentation note injects rail markup builder
  - **Inline kanban:** bootstrap includes compile + 4 lanes + DnD wiring, uses `__folioInlineNoteId`, `/raw/` bakes the noteId script, chrome script forwards moves to `/api/notes/:id/entries`
- Full suite: 622 tests across 56 files, all passing (was 610).

### Why
Closes the Phase 1 polish loop. DnD makes kanban feel native (touchable on iPad too). Slide thumbnails make a long deck navigable without counting slides. Inline kanban brings the same view to where most todo notes actually live (since `slot:todo` defaults to `inline: true`). After v0.27 every Phase 1 surface has the UX it deserves; the spec for Phase 2 (Gantt / cross-note embed) can wait on real dogfooding feedback.

## v0.26.0 — 2026-05-18

**Presentation mode: `type: "presentation"`.** Phase 1 step 3 — closes the last gap from the [living-docs research](http://127.0.0.1:4810/n/01KRY7WZEV499TDWXGJH57JH4A). A presentation note's body_html is a sequence of `<section class="slide">` blocks; the viewer hides all but the current and adds keyboard nav + fullscreen + speaker mode.

### Added
- **`"presentation"` in `NoteType` union** (`src/core/types.ts`) + the `ALLOWED_TYPES` allow-list in `src/mcp/server.ts`. Existing list views / filters automatically pick it up. No template, no schema change — agents put `<section class="slide">` blocks directly in `body_html` (usually with `theme: "plain"` for per-slide layout freedom).
- **`src/viewer/presentation-render.ts`** with `PRESENTATION_CSS` + `PRESENTATION_JS`. Render-time inject in the `/raw/:id` handler when `note.type === "presentation"`: CSS hides non-current slides (`.slide:not(.is-current)` style is `display: none`); JS handles navigation. Generic across themes — agents pick the per-slide look themselves.
- **Keyboard nav inside the slide iframe**:
  - `← / →` / `Space` / `Enter` / `PageDown` / `PageUp` / `Backspace` — prev / next
  - `Home` / `End` — first / last
  - `1`-`9` — jump to slide N
  - `F` — toggle fullscreen via `requestFullscreen()` on `<html>` (works because `<iframe>` now carries `allow="fullscreen"`)
  - `S` — toggle speaker mode (reveals `<aside class="notes">` blocks inside the current slide, marks the slide with a "SPEAKER MODE" badge)
- **Click-to-advance**: clicking right half of slide → next, left half → prev. Skips clicks on `<a>` / `<button>` / `<input>` / `<textarea>` / `<select>` / `<label>` so interactive demos inside slides keep working.
- **Bottom-right `.slide-nav` overlay**: shows `current/total` slide counter + key hints (`←/→` / `F` / `S`). `pointer-events: none` so it never steals clicks.
- **Empty-state hint**: when a presentation note has no `<section class="slide">` blocks at all, the script injects a centered italic message telling the agent to add them. Beats a silent blank page.
- **`<iframe class="note-iframe">` carries `allow="fullscreen"`** on every note (not just presentations) so fullscreen API works from any inline `<script>`.

### SKILL update
- New row in the `Choosing type` table: `"slide deck", "presentation", "talk", "pokaż mi to w prezentacji"` → `presentation`.
- Presentation skeleton example (cover slide + content slide + speaker notes) shown inline.

### Tests
- `tests/presentation-mode.test.ts` (+9 tests) — createNote accepts `type: "presentation"`; `listNotes({type: "presentation"})` filter works; `/raw/:id` injects CSS + JS for presentation notes; non-presentation notes do NOT get the script (regression guard); presentation note with no slides shows empty-state hint; `<iframe class="note-iframe">` always has `allow="fullscreen"`; PRESENTATION_JS handles arrows/digits/F/S/`isContentEditable` skip; PRESENTATION_CSS includes slide visibility + speaker rules + nav overlay; NoteType union round-trip stores `"presentation"`.
- Full suite: 610 tests across 55 files, all passing (was 601).

### Why
With v0.24 surfacing `slot:presentation` and v0.25 closing the kanban-todo gap, the only remaining Phase 1 win was the slide deck shape — previously a `theme: "plain"` + hand-rolled JS workaround. v0.26 makes it a native type with consistent kbd nav across decks.

### Phase 1 complete
With this release, Phase 1 of the project-workspace plan ships:
- v0.24 → rich `/p/<slug>` dashboard + `slot:<name>` convention
- v0.25 → kanban view for live todo notes
- v0.26 → presentation mode with `type: "presentation"`

Phase 2 (Gantt / timeline primitive + cross-note embedding) waits for real dogfooding feedback after a few weeks of Phase 1 use.

## v0.25.0 — 2026-05-18

**Kanban view for live notes with state:* tagged entries.** Phase 1 step 2 of the [project-workspace plan](http://127.0.0.1:4810/n/01KRY7WZEV499TDWXGJH57JH4A). Live-note panel iframe gets a `Feed | Kanban` toggle; the kanban mode shows 4 swim-lanes by compiled state (open / in_progress / done / cancelled) and per-card move buttons that fire a tag-only follow-up entry. Same JSONL substrate; one new render mode + one new endpoint.

### Added
- **`POST /api/notes/:id/entries`** viewer endpoint. JSON body `{ content_html?, tags?, refs?, importance?, source_ref? }`. Same validation as MCP `append_entry`: note must be live + not final, refs must point at existing entries. On success: `{ ok: true, entry_id, ts }`. Logs `live_entry_appended` with `via: "viewer"` so analytics can tell viewer-driven appends from MCP/CLI appends.
- **Panel iframe `Feed | Kanban` toggle** in `src/viewer/live-panel.ts`. Hidden by default; revealed when the compiled feed contains at least one entry with a `state:*` tag (matches the SKILL convention for todos). Choice persists in `localStorage` under `folio-panel-view:<note-id>` per note.
- **Kanban renderer** in the panel iframe. Four lanes (Open / In progress / Done / Cancelled) plus a header count per lane. Each card shows the entry's HTML body, ISO-prefix timestamp, optional `★ pinned` marker, and a row of move buttons (`→ in prog` / `→ done` / `✕ cancel` / `↶ reopen`) tailored to the lane. Done-lane cards get strikethrough; cancelled cards get dimmed.
- **Move button → chrome → endpoint pipeline.** Clicking a move button postMessages `{ns:'folio-feed', type:'move', entry_id, state}` up to chrome; chrome fetches `POST /api/notes/:id/entries` with a tag-only follow-up (`{tags: ["state:<new>"], refs: [entry_id]}`). SSE re-delivers the new entry to the panel and the card "moves" lane in real time via the existing compile pipeline.
- **`panelIframeSrcdoc` signature** gains `noteId: string` so the panel can build the localStorage key and the move-message payload. Existing call site in `pageNote` passes `note.id`.

### Tests
- `tests/kanban-view.test.ts` (+15 tests) — `panelIframeSrcdoc` embeds noteId/toggle/kanban container/localStorage key, four-lane shape, move button data attrs, `LIVE_CHROME_JS` forwards moves to the entries endpoint with `state:* + refs`. Endpoint: append round-trip, tag-only follow-up (kanban move) round-trip, unknown refs → 400, non-live → 400 (with `is_final` check first so finalized live notes show the "final" error), bad id → 404, `live_entry_appended` event records `via: "viewer"`. End-to-end: `GET /n/:id` of a live note embeds the panel iframe with `window.__folioPanelNoteId` baked in.
- Full suite: 601 tests across 54 files, all passing (was 586).

### Not changed
- **Inline-mode live notes** (the `inline: true` flavor — entries rendered inside body_html) keep the feed-only view for now. The kanban toggle currently lives in the panel mode only. Inline mode kanban is a v0.26 candidate — the renderer module here is already shared-ready.
- **MCP `append_entry`** unchanged. The viewer endpoint is a thin parallel path with the same contract — both call into the same `live.appendEntry()` helper.
- **`state:*` tag values** are still convention space. The kanban renderer recognizes the four states from SKILL.md (open / in_progress / done / cancelled); other values land in the open lane by default. `snoozed` is rendered as a generic pill but not yet given its own lane — under review.

### Why
Continuing the project-workspace push: with v0.24 surfacing `slot:todo` as a canonical doc card on `/p/<slug>`, the actual todo work happens inside that note. The flat feed view is fine for chronological log items but doesn't match how users think about open / in-progress / done work. Kanban view closes that gap on the existing JSONL substrate.

## v0.24.0 — 2026-05-18

**Project workspace as a dashboard, not a list.** Phase 0 + Phase 1 step 1 of the [Folio-as-project-workspace plan](http://127.0.0.1:4810/n/01KRY7WZEV499TDWXGJH57JH4A). Introduces a `slot:<name>` tag convention for canonical living docs (roadmap / todo / changelog / release-notes / vision / hub / presentation / gantt) and rebuilds `/p/<slug>` to surface them as first-class cards above the existing thread list.

### Added

#### Phase 0 — SKILL convention
- **`slot:<name>` tag convention** documented in `skills/folio/SKILL.md` under "Project tag" section. Standard slot names: `roadmap`, `todo`, `changelog`, `release-notes`, `vision`, `hub`, `presentation`, `gantt`. Each slot has a recommended note type + mutation pattern (replace-on-revise for canonical docs, append-only feed for changelogs, live + state:* for todos). Workflow examples + anti-pattern (don't make "Roadmap v2" with a duplicate slot tag — `replace` the existing head instead).

#### Phase 1 — `getProjectDashboard()` + rich `/p/<slug>`
- **`getProjectDashboard(slug, opts?)`** in `src/core/storage.ts`. Returns `{ slug, slots, pendingIterations, recentActivity, threadGroups, totalNotes, slotWarnings }`. Pure SQL — one query per facet, bounded by limits.
  - **Slots**: every active head note carrying both `project:<slug>` AND a `slot:*` tag. Grouped by slot name; head = most-recently-updated. Collisions tracked in `slotWarnings`. Each `SlotEntry` exposes `head: NoteMeta` + `excerpt: string` (first ~280 chars of plain text from the body).
  - **`pendingIterations`**: non-finalized iteration notes tagged with the project — "round waiting on a pick".
  - **`recentActivity`**: last 20 events from threads in this project, within 14 days (both configurable).
  - **`STANDARD_SLOTS` constant** + `StandardSlot` type for the recommended slot names.
- **`pageProject(dashboard)` rebuilt** in `src/viewer/render.ts`. New sections, top→bottom: **Canonical docs** (slot cards with icon + title + excerpt + meta + optional `+N dupes` warning) → **Pending picks** (iteration-flag cards in orange) → **Recent activity** (thin event timeline with icon + linked description + ago) → **All threads** (existing card grid, condensed). Signature changed from `(slug, groups, totalNotes)` to `(dashboard: ProjectDashboard)`.

### Changed
- `pageProject()` is no longer a flat thread list — it's a dashboard. The thread cards still appear below as the last section. Empty projects show the same "tag a note with `project:<slug>`" prompt as before.
- `GET /p/<slug>` calls `getProjectDashboard()` instead of `listProjectThreads()` directly (the latter is still exported and used elsewhere).

### Tests
- `tests/project-dashboard.test.ts` (+14 tests) — empty project shape, slot detection, slot ordering (STANDARD_SLOTS first / unknowns alpha), duplicate-slot warning + head-by-updated tiebreaker, excerpt strips HTML and caps at 280 chars, slot detection skips superseded notes, pending iterations (and the finalize→clear flow), activity scoped to project threads only, activity limit honored, viewer renders slot cards + pending cards + activity timeline + empty state + dupe warning badge.
- Full suite: 586 tests across 53 files, all passing (was 572).

### Migration notes
- No schema change. `tags`, `notes`, and `events` tables carry everything `getProjectDashboard()` reads.
- Existing projects don't need to retag — they just won't surface slot cards until the user (or agent) starts using `slot:<name>` tags. The thread list below is identical to v0.20+.
- For first-time setup of a project: `create` the roadmap with `tags: ["project:<slug>", "slot:roadmap"]`; `create` the todo with `live: true, inline: true, tags: ["project:<slug>", "slot:todo"]`. Subsequent updates use `replace` for the roadmap, `append_entry` for the todo.

### Why
[Living docs research note](http://127.0.0.1:4810/n/01KRY7WZEV499TDWXGJH57JH4A) audited what's needed for Folio to host a whole project end-to-end. 7 of 11 artifact types already have a sensible primitive; the gap was project workspace surfacing canonical docs. Phase 0 (SKILL convention) + Phase 1 step 1 (rich `/p/`) close it without new primitives. Phase 1 steps 2-3 (kanban for live todos, presentation mode) follow in v0.25-v0.26.

## v0.23.0 — 2026-05-18

**Continue where you left off — homepage rail.** Coming back to Folio used to mean scrolling a flat created-DESC list of 94 notes to find the project you actually worked on last. v0.23.0 adds a soft-orange band above the list with up to 5 cards for the threads you've actively touched in the last 7 days, ordered by `recency × frequency`. Click a card and you're back in the project workspace (or directly in the pending iteration round). Zero new user actions; the score is computed from the events table that's been running since v0.7.

### Added
- **`listContinueRail({ limit, window_days })`** in `src/core/storage.ts`. Returns up to `limit` (default 5, capped 20) head threads, ranked by `SUM(1 / (days_since_touch + 1))` over touches in the last `window_days` (default 7, capped 60). Touch kinds: `note_created`, `note_viewed`, `note_finalized`, `live_entry_appended`. Per-thread enrichment: latest head note id + title, project slug if any note carries `project:<slug>`, pending-iteration flag (any non-finalized iteration note in the thread). All in pure SQL — no JSONL reads per item, no view-cache rebuild.
- **`logNoteView(noteId, threadId)`** — debounced view tracker called by the viewer's `/n/:id` handler. Drops the call if a `note_viewed` event for the same note already exists within the last 30 minutes (so tab refreshes don't game the score). Debounce window is checked against the events table itself — correct across server restarts, no in-memory cache to invalidate.
- **`renderContinueRail(items)`** in `src/viewer/render.ts` + CSS. Rail is a `.v-rail` section with up to 5 `<a class="v-rail-card">` links above the date-grouped notes list. Soft orange gradient band visually separates "what's hot" from "everything ordered by created". First card carries `.hot` (subtle box-shadow). Per-card meta shows time-ago + touch count + score (e.g. `2h ago · 5 touches · ★ 3.2`); a thread with a pending iteration shows `iteration · pending pick` pill instead.
- **Click routing** (priority order): pending iteration → `/n/<iteration-id>` (one click to the decision gallery) → project tag → `/p/<slug>` (workspace view) → fallback `/n/<latest-head-id>` (the document itself).

### Changed
- **`GET /n/:id`** now calls `logNoteView()` (debounced) instead of `logEvent("note_viewed", …)` (raw). Net effect for the events log: at most one `note_viewed` per (note, 30-min window) instead of one per page load. Score quality up; events table growth down.
- **`pageList()` signature** gains optional `continueRail: ContinueRailItem[]` last arg (defaults to `[]`). Existing callers continue to work. Rail only renders on the bare home view (no `activeType`/`activeStatus`/`activeTag`); filtered views deliberately don't show it.

### Tests
- `tests/continue-rail.test.ts` (+17 tests) covering: empty state, recency × frequency ordering, `limit` honored, project-slug extraction, pending-iteration flag + clearing on `finalize`, superseded-aware head resolution, decay (5-day-old event scores below today's), `logNoteView` debounce (3 calls → 1 event), debounce window expiry (rewinding ts re-arms), rail HTML present on `/`, rail HIDDEN on `/?type=research`, rail HIDDEN on empty DB, click routing for pending-iteration / project-tag / fallback cases, and end-to-end debounce when fetching `/n/:id` twice.
- Full suite: 572 tests across 52 files, all passing (was 555).

### Why
Per the design analysis in [Append-only paradigm note](http://127.0.0.1:4810/n/01KRXDPS5ET30PGZCYT8QDJ2E4) + the [navigation iteration round](http://127.0.0.1:4810/n/01KRY18STDZAB4CGAY8C1RK94N) where the user picked option #1 (`continue-rail`) over sidebar / dashboard / Cmd-K / pinned / activity-sort alternatives. Detailed mockup + plan: [v2 continue-rail note](http://127.0.0.1:4810/n/01KRY1MCN2WRZHVTHKPE1W3QMQ).

### Migration notes
- No schema change. `events` table has carried `kind` + `thread_id` since v0.7; the rail's SQL just reads it differently. Greenfield installs work immediately; existing installs see a useful rail after a few touches (each `note_created` from before this release counts retroactively).
- `package.json` bumps to `0.23.0` (new feature → minor).

## v0.22.3 — 2026-05-18

**Iteration gallery responsiveness.** Six dense mockups in a single round forced the user into 3×2 thumbnails too small to compare side-by-side. v0.22.3 adds a 1c/2c/3c density toolbar with auto-default picked from variant count + content size, per-note localStorage persistence, graduated viewport breakpoints, and adaptive card aspect ratio.

### Added
- **Density toolbar** (`▭ / ▭▭ / ▭▭▭`) in `.iter-gallery__head`. Click switches columns; choice persists in localStorage under `folio-iter-density:<note-id>` so re-opening the same note resumes the user's preferred view.
- **Auto-default density** computed server-side per round: `>=4 variants AND avg content_html >=6kB → 1-col` (full-width, 16/9 preview, min 340px tall); `>=4 OR >=6kB → 2-col` (4/3 preview); else `3-col` (compact 3/2, current default).
- **Graduated viewport breakpoints**: 3-col gracefully drops to 2 at ≤960px; everything collapses to 1 col at ≤640px (was the only breakpoint pre-v0.22.3).
- **Adaptive card aspect ratio** tied to density via `data-cols` attribute on `.iter-gallery__grid`: 3-col keeps `3/2`, 2-col goes `4/3`, 1-col goes `16/9` with `min-height: 340px` so heavy mockups have real room.

### Tests
- `tests/iteration-viewer.test.ts` (+4 tests, 17 total) — density toolbar HTML present, auto-density picks 3 for compact / 2 for many-but-light / 1 for many+heavy variants, bootstrap script wires localStorage persistence.
- Full suite: 555 tests across 51 files, all passing (was 551).

### Why
User generated 6 navigation-direction mockups; gallery rendered them at 280×186 each — too small to read the wireframes. The fix is layout-only (no protocol or schema changes); existing notes auto-pick a sane default and the user can override.

## v0.22.2 — 2026-05-18

**Inline metadata editing replaces the popover; SKILL clarified.** The v0.22.1 popover was a stopgap — modeled on Share, full form with Save button, page reload. It worked but felt heavy for what is mostly typo fixes and tag adjustments. v0.22.2 swaps it for direct manipulation in the sidebar and clarifies the mutation contract for agents.

### Added (inline UI)
- **Click-to-edit title.** The sidebar H1 gets `class="editable-title" data-note-id` + `tabindex="0"`. Click or focus → `contenteditable=true`; Enter saves; Esc cancels; blur saves. Empty/whitespace title is rejected with a toast. Saving uses the existing `POST /api/notes/:id/metadata`.
- **Tag chips with × remove + autocomplete add.** Each existing tag renders as `<span class="tag-chip">` with a tiny `×` remove button. Clicking × auto-saves the smaller list. A trailing `+ add tag` input filters from a server-embedded `popularTags` list (`listPopularTags(100, 1)` baked at render time — no extra `/api/tags` round-trip per keystroke); Up/Down navigate suggestions, Enter commits. Typing a value that doesn't match any existing tag offers a `+ create "<value>"` affordance.
- **Theme dropdown "Save as default" link.** The inline `<select class="theme-switch">` keeps its preview-on-change behavior (still uses the `?theme=X` URL param for the iframe), but now a `✓ Save as default` link appears next to it whenever the dropdown value differs from the saved theme. Click persists via the metadata endpoint and reloads.
- **`window.__folioToast(msg, isError)` global** — small toast helper used by all three inline editors for save errors / "Title cannot be empty" / etc. Auto-dismisses after 1.8s.

### Removed
- The `✎ Edit metadata` button in `.side-aux`.
- `editMetadataPopoverHtml()`, `editMetadataPopoverJs()`, and the `.edit-pop*` CSS block — all replaced by `inlineMetadataEditorJs()` (single concentrated handler for title + tags + toast; theme save link is wired alongside the existing preview logic in `noteScript`).

### SKILL restructured per Anthropic's [Skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- **SKILL.md trimmed 597 → 240 lines** (under the 500-line soft cap). Long sections moved out to `skills/folio/reference/*.md`:
  - `live-notes.md` (~104 lines) — render modes, tool surface, chain-of-entries, tag conventions
  - `iteration-notes.md` (~109 lines) — propose_round/wait_for_pick workflow, variant content_html, SVG-for-logos skeleton
  - `themes.md` (~32 lines) — full theme picker table
  - `assets.md` (~120 lines) — attach_asset, relative-URL rule, generating images (SVG vs raster vs external)
- **References one level deep from SKILL.md** — no chained `a → b → c` lookups, matching the best-practices "Avoid deeply nested references" guidance.
- **Reference files >100 lines carry their own ToC** at the top.
- **Frontmatter description tightened** to third-person, what+when, with mutation contract spelled out. New form: *"Creates visually-rich HTML knowledge artifacts in Folio (folio-mcp). Use when… Body changes flow through the `replace` MCP tool (agent-only); metadata… via `update_metadata`."* (~580 chars, under the 1024 limit).
- **New section "Mutation surfaces"** with a 3-row table (body / metadata / live entries) and a decision tree mapping user phrases to the right tool. Explicitly names the user-facing inline editors so the agent doesn't intrude on jobs the user can do faster.
- **Mandatory-loop step 7 rewritten** — three-branch rule (body → `replace`; metadata → `update_metadata` or hand off to inline editor; different artifact → `create` with same thread). The previous "do NOT edit the old one — ADR-014 append-only" wording was a v0.21 promise under v0.22.
- **Anti-pattern bullet** updated: "Refusing to edit because Folio is append-only" is now the anti-pattern, with supported paths spelled out.

### Tests
- `tests/viewer-edit-metadata.test.ts` rewritten (+5 tests, 13 total) — `editable-title` h1 with data-note-id, `tag-editor` with chip+×+add+suggest, `theme-save` link present and hidden by default, `inlineMetadataEditorJs` embeds popularTags + handles `ArrowDown` navigation + posts to the metadata endpoint, regression guard that the v0.22.1 popover is gone (`id="edit-trigger"`, `id="edit-pop"` not in output). Endpoint cases (happy path, theme rewrites HTML link, no-change, unknown-theme, bad id) unchanged from v0.22.1.
- Full suite: 551 tests across 51 files, all passing (was 546).

### Not changed
- Endpoint `POST /api/notes/:id/metadata` unchanged — it's the substrate; the UI on top swapped.
- Body editing in the viewer remains intentionally absent. No textarea, no rich-text editor, no contenteditable on the article. Body changes flow through the agent via `replace`. This is what the SKILL now spells out.

## v0.22.1 — 2026-05-18

**Edit metadata popover in the viewer.** v0.22.0 shipped the `updateNoteMetadata()` storage function + `update_metadata` MCP tool + `folio edit` CLI but no in-browser UI — users could only edit metadata from the agent or the terminal. v0.22.1 fills the gap with a popover modeled on the Share popover.

### Added
- **`✎ Edit metadata` button** in `.side-aux` (sits above the Copy / Share / Hand-off / Delete actions on every `/n/:id` page). Click opens a popover anchored to the trigger via `getBoundingClientRect()` (same dynamic-position pattern as Share since v0.21.2).
- **Popover form** with title input, comma-separated tags input, theme dropdown, `Final` checkbox. Inputs are prefilled to current values. Save submits only the fields that changed (diffed against the initial snapshot), so a no-touch Save shows a "No changes to save" hint instead of round-tripping to the server.
- **POST `/api/notes/:id/metadata`** in `src/viewer/server.ts`. JSON body accepts any subset of `{title, tags, theme, is_final}`; calls `updateNoteMetadata()` and returns `{ok, updated_fields, meta}` on success, `{ok:false, reason}` with status 400 (unknown theme), 404 (unknown id), or 200 (no-change — a benign info response, not an error).
- **`editMetadataPopoverHtml()` + `editMetadataPopoverJs()`** helpers in `src/viewer/render.ts`, alongside the Share popover helpers. Share/Edit popovers use distinct DOM ids so they don't collide; CSS reuses the same shape (320px width vs 280px for Share — tag input + theme dropdown wanted a bit more room).

### Changed
- The inline theme dropdown in the sidebar (`<select class="theme-switch">`) stays unchanged — still preview-only via `?theme=X` URL param. Permanent theme changes go through the popover. This separation avoids the "did my click just save or just preview?" ambiguity.

### Tests
- `tests/viewer-edit-metadata.test.ts` (+8 tests) — `#edit-trigger` + `#edit-pop` present with prefilled values, JS posts to `/api/notes/:id/metadata` and reloads on success, happy path returns updated meta, theme change rewrites both the DB row and the on-disk HTML `<link>`, no-change returns `ok:false reason:'no-change'` with 200, unknown theme returns 400, bad id returns 404.
- Full suite: 546 tests across 51 files, all passing (was 538).

### Not included (deliberate)
- **Replace UI is still CLI/MCP only.** A "Replace body" textarea in the viewer is a bigger surface (large free-form editor, theme-aware paste handling) and waits for a focused pass. `folio replace <id> --html @file` and the `replace` MCP tool both ship in v0.22.0 already.
- **Click-to-edit on the article title.** The H1 lives inside the body iframe and the parent chrome can't reach it (null-origin sandbox); editing happens via the popover only.

## v0.22.0 — 2026-05-18

**Selective append-only relaxation: metadata editable + `replace` primitive.** Based on the design analysis [Append-only w Folio — czy paradygmat się broni], ADR-014's pure append-only model was found to be inconsistently enforced (live notes already mutate via chain-of-refs) and generated ~30% noise across ~94 real notes — typically v2/v3/v4 versions of the same document, where the only delta was a typo, a tweak, or a sanitizer fix. v0.22.0 ships Step 1 (metadata edits) + Step 2 (`replace` primitive) of the recommended graduated relaxation. Body files remain immutable; the new mutability is metadata-only + supersede pointers.

### Step 1 — metadata is editable

- **`updateNoteMetadata({id, title?, tags?, theme?, is_final?})`** in `src/core/storage.ts`. Edits title / tags / theme / `is_final` in place. The HTML file is regenerated atomically (body extracted via `extractBodyHtml`, re-injected through `renderNote` with new metadata) — no body bytes change. FTS index refreshes. Empty/whitespace title rejected as no-change. Unknown theme returns `{ok:false, reason:"unknown-theme"}`. `is_final` flip routes through `finalize()` / `unfinalize()` so the side effects (live → compiled body, iteration → frozen rounds, expires_at reset) keep their one canonical implementation.
- **`update_metadata` MCP tool** (`src/mcp/server.ts`). Same shape; returns the fresh meta + list of `updated_fields`. The existing `unfinalize` MCP handler was simplified to call the new `unfinalize()` storage function (extracted from inline SQL).
- **`folio edit <id> [--title T] [--theme X] [--tags "a,b,c"] [--final|--unfinal]`** CLI command (`src/cli/commands/edit.ts`). Mutually-exclusive `--final` / `--unfinal` flag pair.

### Step 2 — `replace` primitive

- **New DB column `notes.superseded_by TEXT`** added via migration v4→v5 (`src/core/migrations.ts`) + present in `PHASE2_SCHEMA` for greenfield. Partial index `notes_by_superseded ON notes(superseded_by) WHERE superseded_by IS NOT NULL` covers default-listing filters.
- **`replaceNote({old_id, body_html, title?, tags?, theme?})`** in storage. Creates a new note in the same thread (inheriting type/theme/tags/title from old by default), then sets `old.superseded_by = new.id`. Old `.html` file stays on disk verbatim — capability URLs that pointed at `/n/<old-id>` still resolve to the original content. `already-superseded` guard prevents accidental fork (a chain stays linear).
- **`resolveHeadOfChain(id)`** walks the supersede pointers forward up to 10 hops. Used by the viewer banner.
- **Default-filter listings hide superseded notes.** `listNotes` (+ new `include_superseded?` opt-in), `searchNotes` (+ opt-in), `listNotesByTag`, `listThreads`, `listProjectThreads` (via tag listing) all skip notes with `superseded_by IS NOT NULL`. Thread count in `/threads` reflects head versions only — a 4-note thread collapsed via `replace` shows as `count=1`, which matches the user's mental model.
- **Viewer supersede banner.** `pageNote` renders an indigo-tinted banner on the old URL: *"↻ Replaced — this version has been superseded — [new title] is the current head"* with a direct link. The head note (most recent) has no banner.
- **`replace` MCP tool** + **`folio replace <id> --html @path [--title T] [--theme X] [--tags "a,b"]`** CLI.
- **`note_superseded` event** logged for analytics (carries old_id, new_id, old_title, new_title, thread_id, type).

### Not changed (deliberately)
- **ADR-014 still binds for body bytes.** No edit-in-place tool. The plain-text shape of a published `/n/<id>` is forever — `replace` creates a new URL.
- **`iteration` and `technical` notes still benefit from the existing append-only flow** (variants and ADR drafts are points). `replace` is the right tool for `snippet` / `comparison` / `research` polish — the analysis spells out the per-type calibration in the verdict.
- **Cloud sync schema unchanged.** Superseded notes still push/pull as ordinary notes; cloud-side filtering of supersede chains is deferred (would need a cloud migrator entry + cloud render changes). Practical impact: local viewer hides superseded versions; the public/relayed cloud view shows all versions until cloud catches up. Capability URL trust holds either way (immutable files).

### Tests
- `tests/update-metadata.test.ts` (+13 tests) — title/tags/theme/`is_final` change paths, multi-field combined update, FTS refresh, live note `is_final` compiles entries, no-change / not-found / unknown-theme error reasons, title trim, `updated` timestamp bump.
- `tests/replace.test.ts` (+14 tests) — `superseded_by` set, old `.html` byte-identical after replace, inherit-by-default, overrides applied, listings/search/tag/thread filters hide superseded by default, `include_superseded` reveals them, `already-superseded` and `not-found` errors, `resolveHeadOfChain` walks multi-hop chains, viewer banner present on old URL + absent on head, `note_superseded` event logged.
- `tests/migrations.test.ts` (3 updated) — head schema version bumped from "4" to "5".
- `tests/live-mcp.test.ts` (1 updated) — tool count 20 → 22 (adds `update_metadata` + `replace`).
- Full suite: 538 tests across 50 files, all passing (was 511).

### Migration notes
- Existing dbs auto-migrate on next open: `ALTER TABLE notes ADD COLUMN superseded_by TEXT` (column defaults to NULL — all existing notes are heads). No data loss, no manual step.
- `package.json` bumps to 0.22.0. Tool count in MCP discovery reports 22.

## v0.21.3 — 2026-05-18

**`plain` theme gets a permissive sanitizer.** The plain theme's contract is "the agent owns the visual identity for this note." But the strict allowlist was still stripping safe HTML5 tags like `<b>`, `<i>`, `<u>`, `<s>`, `<q>` along with their `id`s — breaking agent-built widgets that did `getElementById('counter')` against a `<b id="counter">` placeholder. v0.21.3 plumbs a new `mode: "permissive"` option through `sanitize()` that `createNote()` opts into automatically whenever `theme === "plain"`. Other themes are unchanged.

### Changed
- **`sanitize(html, { mode: "permissive" })`** allows every HTML5 tag and attribute, but still scrubs the escape vectors that don't come for free from the iframe sandbox + CSP: on*-handlers stripped from every element, `javascript:` rejected in any URL attribute (`href`/`src`/`action`/`formaction`/`xlink:href`/`background`/`poster`/`data`/`ping`/`cite`/`manifest`/`longdesc`), iframe `sandbox` normalized (allow-same-origin always removed, default flags injected when absent). Side-effecting head-y tags — `<meta http-equiv="refresh">`, `<link rel="stylesheet" href>`, `<base href>`, `<noscript>`, `<title>` — are dropped with their content via `exclusiveFilter`. `<head>`/`<html>`/`<body>` wrappers pass through (inert under the sandbox). Existing case-preserving parser flag (`lowerCaseAttributeNames: false`, `lowerCaseTags: false`) reused so SVG case-sensitive attrs survive.
- **`createNote()` in `src/core/storage.ts`** detects `theme === "plain"` and passes `mode: "permissive"` to `sanitize()`. Every other theme keeps the strict default allowlist — including the `data-*` wildcard, SVG attr maps, iframe transformTags, and form-control surface that prior releases shipped. Live-note `append_entry` keeps the default mode (entries land on whatever theme the note declares, but the entry body is short HTML the strict mode handles fine).

### Tests
- `tests/plain-theme.test.ts` (+6 tests, 10 total) — permissive keeps `<b id="...">`/`<i>`/`<u>`/`<s>`/`<q>` while default strips them; permissive strips `on*`-handlers and `javascript:` URLs from `<a href>`/`<img src>`/`<div onmouseover>`; permissive drops `<meta>`/`<link>`/`<base>`/`<noscript>` and their contents; iframe sandbox still has `allow-same-origin` removed even in permissive mode; createNote with `theme: "plain"` lets a `<b id="counter">` round-trip end to end; createNote with `theme: "linen"` still strips `<b>` (regression guard against accidentally widening default mode).
- Full suite: 511 tests across 48 files, all passing.

### Why
An agent generating an interactive force-directed knowledge graph on the plain theme hit `Cannot set properties of null (setting 'textContent')` because the `<b id="kg-stats-edges">` placeholder it referenced was sanitized away. The plain theme's prompt addendum already promises "Plain has none [of the standard themes' opinions]" — the sanitizer was the last surviving opinion. v0.21.3 makes the contract consistent.

## v0.21.2 — 2026-05-17

Two viewer chrome polish changes following up on v0.21.1.

### Changed
- **Share popover anchors next to its trigger.** v0.21.1 moved the Share trigger into the sidebar but kept the popover at a fixed top-right viewport position — visually disconnected from the click. v0.21.2 positions the popover dynamically: on open, the bootstrap JS reads `trigger.getBoundingClientRect()` and sets inline `top` / `left` so the popover floats just to the right of the trigger. Arrow triangle moves to the left edge, vertical offset set via a `--share-pop-arrow-top` CSS variable so it always points at the trigger's center. Clamps to viewport bounds when the trigger sits low (long sidebar).
- **Topbar "Cloud" → "Sync"; ☁ icon dropped.** The route stays `/cloud` (no redirect needed; existing bookmarks unaffected), but the label is now `Sync` — matches what users actually do there (push/pull). Pre-v0.21.2 label was `☁ Cloud` from when the page was just status-only.

### Tests
- `tests/viewer-shares.test.ts` (+1) — Share popover JS contains `positionNearTrigger` + `getBoundingClientRect` + `--share-pop-arrow-top`.
- `tests/viewer-cloud-ui.test.ts` (1 updated) — topbar Sync link present, ☁ + old "Cloud" label removed.

## v0.21.1 — 2026-05-17

**"Hand off to agent" button + Share trigger moved into the sidebar.** Two viewer chrome changes that group all per-note actions in one place.

### Added
- **`↗ Hand off to agent` button** in `.side-aux`. Click → copies a minimal note reference to the clipboard: URL + title + thread + type + a one-line instruction telling the receiving agent to call `folio.get` for the full body. User pastes the payload into any agent chat. Zero deep links, no per-host URL schemes — works in every agent surface (Claude Code, OpenClaw, ChatGPT, etc.). Visual confirmation on copy ("✓ Copied — paste into your agent chat") that reverts after 1.8s.

### Changed
- **Share trigger moved from topbar to sidebar.** Pre-v0.21.1 the `↗ Share` button lived in the topbar nav (v0.19.0 design). In v0.21.1 it joins the other per-note actions in `.side-aux` (Copy plain / Copy markdown / Raw HTML / Print / **Share publicly** / **Hand off to agent** / Delete). Topbar stays for cross-page nav only (Notes / Threads / Stats / Cloud). The Share popover content + behavior is unchanged — still fixed-position top-right, same form, same active-dot indicator (now next to the sidebar label).
- `topbar()` signature: third arg `shareForId` is now ignored. Old callers keep working as before — the param is just a no-op.

### Tests
- `tests/viewer-shares.test.ts` (+3 tests, 14 total) — Share trigger sits inside `.side-aux` not `v-nav`, topbar nav specifically lacks share-trigger, Hand off button present with all metadata data-* attrs, inline JS contains the expected clipboard payload template strings.

## v0.21.0 — 2026-05-16

**OpenClaw hook integration.** Closes the long-parked future feature: agents hosted in OpenClaw now see Folio events surface in their context on every user turn — without any per-session wiring. `folio install --target openclaw` automates the whole setup (hook directory symlink + config entry); the existing skill + MCP install paths are unchanged.

### Architecture (see `docs/openclaw-integration.md`)

Three integration shapes were evaluated; v0.21.0 ships the simplest. **Option A — polling-on-message hook**: OpenClaw `message:received` fires → hook polls `~/Folio/threads/*/*.entries.jsonl` since last-seen cursor → filters meaningful entries (`kind:pick` / `kind:variant` / `state:done` / `view:pinned`) → pushes summary into the agent's context for this turn. Bounded execution, no daemons, no sockets. Resilient to OpenClaw restarts (cursor on disk). Future options (bridge daemon for autonomous loops between turns) deferred to v0.22+; full rationale in the ADR.

### Added

- **`hooks/openclaw/folio-event-watcher/`** — reference hook implementation in the repo. `HOOK.md` with OpenClaw frontmatter declaring `events: ["message:received"]`; `handler.ts` implementing the polling + filtering + cursor logic (~150 LOC, includes types for the OpenClaw event object).
- **`bundledHooksDir()`** in `src/core/config.ts` — sibling to `bundledSkillsDir()`. Resolves the hooks dir via `FOLIO_BUNDLED_HOOKS_DIR` env override → execPath sibling → dev fallback. Tarball includes `hooks/` so `folio install` on a release binary finds it.
- **`folio install --target openclaw` extension** — when the skill flag is on (default), also symlinks `~/.openclaw/hooks/folio-event-watcher/` → `<bundledHooksDir>/openclaw/folio-event-watcher/` and writes `hooks.internal.entries["folio-event-watcher"].enabled = true` to `~/.openclaw/openclaw.json`. Hook lifecycle follows the skill flag — `--mcp-only` skips the hook; `--skill-only` keeps it.
- **`folio uninstall --target openclaw`** — mirror: removes the symlink + the config entry. Refuses to remove a hook directory that isn't a symlink (manually installed).
- **`folio doctor --target openclaw`** — reports hook state alongside skill + MCP. New states: `ok`, `missing`, `wrong-target`, `disabled` (symlink in place but config flag is false), `stale` (symlink target missing).
- **`CheckReport.hook` field** — typed optional field on the install check report. Other targets (Claude Code) don't ship hooks; the field stays undefined for them.

### Tests
- `tests/install-openclaw.test.ts` (+7 tests, 29 total) — install creates hook symlink + writes enabled flag, check reports ok/missing/disabled states, uninstall removes both, `--skill-only` keeps the hook, `--mcp-only` skips it.

### Documentation
- **`docs/openclaw-integration.md`** — ADR-shape: problem, Folio event surfaces, three integration architectures (polling-on-message / bridge daemon / hybrid), trade-offs that drove option A, future work for option B/C.

## v0.20.2 — 2026-05-15

**Iteration gallery auto-refreshes when the next round lands.** Before this release, after the user picked a variant the gallery showed *"Waiting for the agent to propose round N+1…"* and stayed there until the user manually refreshed. The new round was live on disk — the viewer just wasn't watching. Now it watches.

### Fixed
- **`/n/:id/stream` accepts iteration notes.** Pre-v0.20.2 the SSE endpoint gated strictly on `note.live === true` and returned 404 for iteration notes (which carry `live=0` despite using the same JSONL substrate). Widened gate: a note is streamable when `live === true` OR `type === "iteration"`. Existing live-note behavior unchanged; iteration notes now plug into the same hub.
- **Iteration body iframe auto-reloads on `kind:variant` SSE entries.** When `type === "iteration" && !is_final`, pageNote injects a chrome-side `EventSource` subscriber that watches the JSONL stream. On any new `kind:variant` entry (= a new round just landed via `propose_round`) it sets the body iframe's `src` with a cache-buster, triggering a fresh render that shows the new gallery. `kind:pick` entries are skipped — the existing click → POST → reload path already handles pick refreshes; reloading again from SSE would double-flash. Initial backlog burst on connect is suppressed via a 250ms quiet window so opening the page doesn't immediately reload it.

### Tests
- `tests/iteration-viewer.test.ts` (+4 tests, 13 total) — SSE endpoint accepts iteration notes, still 404s on plain snippet, iteration page emits the EventSource subscriber JS, plain pages don't.
- `tests/live-viewer.test.ts` (1 updated) — pre-v0.20.2 error message *"not a live note"* changed to *"not streamable"* to reflect the wider gate.

## v0.20.1 — 2026-05-15

**Sidebar navigation on list pages + context-aware notes.** Caught a real SKILL.md overpromise: I'd claimed earlier "the viewer aggregates tags in the sidebar" but `/tag/:slug` had no sidebar — only a flat list of notes. Users with multi-thread projects had no way to navigate between notes within a tag/project context. The fix is a left sidebar on list pages (mirroring `.note-shell`'s 2-column shape) plus `?from=…` context propagation so individual note pages know which list they came from.

### Added
- **`.list-shell` 2-column layout** for `/tag/:slug` and `/p/:slug`. Sticky scrollable left sidebar (300px) listing items; main content on the right. Mobile collapses to single column with sidebar pinned at top.
- **Sidebar nav on `/tag/:slug`** — every note tagged appears as a list item with title + type pill + age. Click navigates to `/n/<id>?from=tag:<slug>`.
- **Sidebar nav on `/p/:slug`** — notes grouped under thread-name section headers (`research · 3`, `onboarding · 1`); within each section, individual notes link with `?from=project:<slug>`.
- **Context-aware `/n/:id?from=tag:X` and `?from=project:Y`** — when the agent or user arrives via a tagged context, pageNote overrides:
  - "Back to list" → goes to `/tag/:slug` or `/p/:slug` instead of `/`
  - prev/next buttons → walk the list (not thread siblings)
  - sidebar's "Version" line → `In tag` / `In project` with position label "X of N"

Without `?from=`, behavior is unchanged — thread-based prev/next + "Back to list" → homepage.

### Tests
- `tests/project-grouping.test.ts` (5 new tests, 12 total) — sidebar markup on `/tag/`, `/p/`, context-aware nav on `/n/?from=tag:`, `/n/?from=project:`, no-regression for `/n/` without `?from=`.

## v0.20.0 — 2026-05-15

**Project grouping.** Until v0.20 Folio had no first-class abstraction for "a project spanning many threads". Users coming from Obsidian-style folders (one folder = one project, multiple files inside) had to think in flat threads where every `thread_id` is one doc + its iterations. The fix is a **convention + viewer surface** combo — no schema change, no thread-hierarchy refactor, just a tag pattern and a page that groups by it.

### Added — convention
- **`project:<slug>` tag.** The agent puts this tag on every note belonging to a project (research, decisions, design, ops log, technical specs — all carry the same `project:repcoach-fit` tag). SKILL.md gains a new "Project tag" subsection making this the load-bearing pattern.

### Added — viewer
- **`GET /p/:slug`** — project workspace page. Groups every note tagged `project:<slug>` by `thread_id`, renders one card per thread with note count + latest activity + ★ final count + latest note's type pill. Empty state when no notes carry the tag tells the user to ask the agent to add it.
- **`GET /api/p/:slug`** — JSON variant for tooling. Returns `{ groups: [{ thread_id, noteCount, finalCount, latestCreated, notes[] }], totalNotes }`.

### Added — storage
- **`listProjectThreads(projectSlug, limit?)`** in `src/core/storage.ts`. Calls `listNotesByTag('project:<slug>')`, groups by `thread_id`, sorts threads by latest activity descending. Returns the same shape `/api/p/:slug` exposes.

### Tests
- `tests/project-grouping.test.ts` (new, 7 tests) — empty state, cross-thread grouping with counts, finalCount aggregation, sort-by-latest, leak prevention (other projects + untagged notes), full viewer round-trip (HTML + JSON), 400 on empty slug.

### Why not hierarchical thread_ids?
The alternative was nesting threads under projects (`/threads/repcoach-fit/logo/...`). That would have required: filesystem walker changes, sync push/pull schema changes, slug validation rewrite, capability URL routing changes. Tag + view gets the same UX with zero schema migration and clean cohabitation with the existing flat thread model.

## v0.19.5 — 2026-05-15

Single-line SKILL.md fix shipped because it materially changes agent routing in production.

### Changed — `skills/folio/SKILL.md`

Removed the `"Daily notes / projects manually managed in Obsidian"` line from the NO anti-triggers list. Real-world bug report: a paired-chat agent asked to generate **project research** correctly created a Folio research note but then appended *"the full project description goes to Obsidian"* — splitting one deliverable across two systems. Root cause: SKILL was explicitly telling agents reading top-down that **projects** belong to Obsidian, which conflicts with Folio's own research / technical / thread model that handles project work natively (one thread per project, append-only siblings as the project evolves).

It's not Folio's job to tell users where their personal-knowledge-management lives. Removed the line. Other Obsidian-aware skills (if loaded alongside Folio in a stack like notibox / OpenClaw) can make their own routing claims; Folio stays in its lane.

## v0.19.4 — 2026-05-15

Docs-only release to push the SKILL.md changes into the release tarball — the SKILL ships bundled in `dist/skills/folio/SKILL.md` and is what agents load via `folio install --target {claude-code,openclaw}`. The binary itself is unchanged from v0.19.3.

### Changed — `skills/folio/SKILL.md`

**Iteration discoverability fix (PR #48).** Real-world bug: a paired-chat agent received a textbook iteration prompt ("przygotuj 6 wariantów logotypu, ja wybiorę któryś, na podstawie którego rozwiniesz") and answered with 6 logo proposals inline in chat, then (when nudged) made a regular note instead of an iteration note. Audit found five structural holes that made iteration invisible to agents reading the SKILL top-down:

- `Choosing type` decision table now lists `iteration` as the first row with a decision-order preface ("1: N candidates for picking? 2: append-only feed? 3: static").
- YES triggers at top include iteration-shaped phrases ("N wariantów", "show me N versions", "I'll pick one", "design candidates").
- Iteration section's `When to use` expanded into a bilingual PL/EN phrase-mapping table (logo / hero / email / onboarding / palette / poster / app icon).
- Full inline-SVG variant `content_html` skeleton added — agents now have a copy-paste template for logo / icon iteration.
- Mandatory loop step 4 grew a "BEFORE writing body_html, decide the SHAPE" branch listing single / live / iteration with an explicit warning against inlining N variants.

**New "Generating images from scratch" section (PR #48).** Triggered by a separate report: agent embedded image URLs that didn't render (the agent's local `viewer_public_url` host wasn't reachable from the recipient's Tailscale Funnel endpoint). Three valid paths documented — (1) inline SVG preferred for vector, (2) `attach_asset` for raster bytes, (3) verified external HTTPS URL only when proven to exist. Four anti-patterns called out, including hallucinating image URLs and inlining base64.

**"Relative URLs are usually right" subsection in Attaching assets (PR #48).** Use `/t/<thread>/asset/<filename>` inside body_html, not the absolute `url` from `attach_asset` response. Absolute URLs break when the recipient browses through a different host than `viewer_public_url` (reverse proxy, Tailscale Funnel, capability URL on another cloud). The relative form renders against current origin and survives every host the rewriter knows about.

**SKILL trim (PR #49).** Net cut 617 → 525 lines (−15%). Removed pre-iteration content that was self-duplicating ("Editing → new note" section that duplicated Mandatory loop step 7), internal QA leftovers (`Pre-merge test`), and bloat that pointed to better sources (long Stylebook HTML examples → reference `STYLEBOOK.md`; theme-table `Why` column → reference `list_themes` prompt_addendum).

## v0.19.3 — 2026-05-15

Inline SVG diagrams were getting silently destroyed by the sanitizer. Agent-authored architecture diagrams, flowcharts, mini-charts — all stripped of typography, geometry, and arrowheads, then rendered as a pile of unpositioned `<text>` and `<line>` tags. Caught in dogfood of the showcase note's "How it gets to you" diagram: user reported it was illegible; the v2 redesign was equally broken because the bug was in the sanitizer, not the SVG markup.

### Fixed
- **sanitize-html → htmlparser2 was lowercasing both tag names and attribute names by default.** SVG is case-sensitive: `viewBox`, `markerWidth`, `refX`, `gradientUnits` (attrs) and `<linearGradient>`, `<radialGradient>` (tags) are ignored by browsers when lowercased. Set `parser: { lowerCaseAttributeNames: false, lowerCaseTags: false }`. HTML5 tag/attribute names are case-insensitive (browsers normalize at parse time) so this is a no-op for non-SVG content.
- **`ALLOWED_TAGS` was missing `<defs>`, `<marker>`, `<ellipse>`, `<use>`, `<symbol>`, `<linearGradient>`, `<radialGradient>`, `<stop>`.** Arrow markers (every flow diagram needs them) were stripped entirely. Now allowed; `<foreignObject>` stays out (defense in depth — it can host arbitrary HTML/JS).
- **`ALLOWED_ATTRIBUTES` had no entries for `<g>`, `<text>`, `<tspan>`** and incomplete entries for `<svg>` / `<path>` / `<rect>` / `<line>` / `<circle>`. So `font-size`, `font-family`, `text-anchor`, `stroke-width`, `stroke-dasharray`, `opacity`, `marker-end`, `transform`, and all the SVG paint + typography attrs got dropped. Now per-element comprehensive allow-lists covering geometry + paint + typography + markers + clipping.

### Tests
- `tests/sanitize-svg.test.ts` (new, 10 tests) — `viewBox` case-preservation, `<defs>`/`<marker>` survival, text positioning + typography, group-level styles, line/rect with strokes and dasharray, gradients (linearGradient + stop), `<foreignObject>` still stripped, full agent-authored architecture-diagram round-trip.

## v0.19.2 — 2026-05-15

Two real bugs surfaced when shipping the v0.19.1 showcase note + testing `wait_for_pick` on a multi-process setup.

### Fixed
- **Sync push truncated notes with nested `<article>` elements.** `extractBodyHtml` in `src/core/sync.ts` used a non-greedy regex (`<article...>([\s\S]*?)</article>`) that stopped at the FIRST nested `</article>` instead of the wrapper's. Notes with agent-authored `<article>` elements (iteration cards, blog-style sections) got truncated at the first inner close on push; cloud-served renders were ~half the size of local. Fix: use `lastIndexOf('</article>')` to find the wrapper's true close — the template emits exactly one wrapper article after the agent body, so `lastIndexOf` is unambiguous. Other sites with the same regex pattern (`finalizeLive`, `finalizeIteration`, viewer + cloud iteration splices) still use non-greedy — they're inside `.replace()` callbacks where the truncation would be visible differently; sweep deferred to a follow-up.
- **`wait_for_pick` never resolved on cross-process picks (the "wait_for_pick zawisł" report).** The SSE hub's only change-detection path was `fs.watch`. Within a single process the in-process `publish()` fast path covers writes, but across processes (MCP server's agent runs `wait_for_pick`; viewer process appends the pick on user click) the only bridge is `fs.watch` — which on macOS is flaky enough to swallow rapid events. Fix: every channel with active subscribers now also runs a 500ms polling `drainAndEmit`. `fs.watch` + direct `publish()` stay as fast paths; the poll guarantees delivery within ~500ms even when both miss. Offset check inside `drainAndEmit` prevents duplicates when more than one path observes the same append. Timer is `unref()`'d so it never keeps the process alive past explicit unsubscribe.

### Tests
- `tests/extract-body-html.test.ts` (new, 6 tests) — covers simple bodies, nested articles (single + deeply nested), missing wrapper fallback, the exact showcase-note shape that broke.
- `tests/sse-hub-polling.test.ts` (new, 4 tests) — simulates cross-process appends via direct `fs.appendFileSync` (skipping `publish()`); verifies single + multiple sequential pickups within the poll interval, no-duplicate guarantee, and that unsubscribe stops both the watcher and the poll timer.

## v0.19.1 — 2026-05-15

New MCP tool `wait_for_pick` — closes the manual seam in the iteration workflow. Before: agent calls `propose_round`, waits for the user to type "kliknąłem" in chat, then calls `iteration_state`. After: agent calls `propose_round` then `wait_for_pick({note_id, for_round: N, timeout_s: 60})`, which blocks on Folio's SSE hub until the user clicks a variant and resolves with the winning `variant_id` directly. Tool count: 19 → 20.

### Added
- **`wait_for_pick` MCP tool.** Long-polls Folio's `src/core/sse-hub.ts` for `kind:pick` entries on the given note. Race-window safe: pre-subscribe state check returns immediately if the round is already picked (covers the case where the user clicks between `propose_round` returning and `wait_for_pick` getting called). Returns `{picked: true, variant_id, round}` on success or `{picked: false, timeout: true, current_round}` on timeout. Default timeout 60s; clamped to [1s, 300s].
- **SKILL section "Iteration notes (v0.18.0+)"** restored + updated with the new `wait_for_pick` workflow as the load-bearing usage pattern.

### Architecture
- Single new function in `src/core/iteration.ts`; thin dispatch case in `src/mcp/server.ts`. No schema migration. Builds on the SSE hub Folio already maintains for live notes (`subscribe` + `publish`); the iteration `pickVariant` writer was already calling `publish`, so no producer-side changes needed.
- Finalized notes return `{picked: false}` (not the lineage) — finalize archives the JSONL to `.trash/`, so the lineage isn't reachable through this API; agent should switch to reading the compiled body_html. Locked-in via test.

### Tests
- `tests/iteration-wait.test.ts` (new, 10 tests) — covers SSE pickup of matching round, filtering on `for_round`, ignoring non-pick entries, fast-path immediate returns (already picked, finalized), timeout shape, error paths, and an end-to-end MCP integration via `buildServer()`.

## v0.19.0 — 2026-05-15

Capability URL sharing now has a viewer UI. Previously: CLI (`folio publish`) and MCP tool (`publish`) only — viewer notes had no Share button at all, so anyone using only the local viewer didn't know the feature existed. Designed in two rounds via the v0.18 iteration primitive (B · topbar-popover → B3 · minimal+manage-link). Three placement concepts compared, three popover variations refined, picked one direction, shipped.

### Added
- **Topbar `↗ Share` button on note pages.** Opens a popover with the same form fields as the CLI (`expires_in_days`, `max_views`, optional `recipient`). On submit, calls a new viewer-side proxy endpoint that forwards to the cloud's `/v1/share`. Result URL renders inline with copy + revoke buttons. Outside-click / Esc dismiss the popover.
- **Active-shares indicator.** Orange dot beside the Share label lights up when the note has live capability URLs — at-a-glance signal that the note is already published somewhere. Count comes from a GET fired on page load (silent failure when cloud is unreachable).
- **`/n/:id/shares` manage page.** Full list view linked from the popover's `manage →` bar. Each share rendered as a card with URL (with copy), created/expires dates, view counter (`N / max` or `N / ∞`), recipient hash (truncated), and a revoke button. Empty + not-paired states inline. Reached from the popover, not navigation — discovered after first publish.
- **Three new viewer API endpoints** — `POST /api/notes/:id/shares`, `GET /api/notes/:id/shares`, `DELETE /api/notes/:id/shares/:token`. Auth comes from `~/Folio/.sync-state.json` (same source the CLI uses); recipient email is hashed locally before the cloud sees it. Not-paired returns 412 with structured `{code: "NOT_PAIRED"}` so the UI can guide the user to `/cloud`.

### Tests
- `tests/viewer-shares.test.ts` (new, 11 tests) — covers unpaired states for all three verbs, full paired round-trip against an in-process mock cloud, recipient hashing, note page topbar markup, manage page empty / populated / unpaired renders.

## v0.18.2 — 2026-05-15

### Fixed
- **Arbitrary `data-*` attributes survived only on Folio's own elements.** The sanitizer's global allow-list listed specific `data-folio-*` + `data-entry-id` entries but no wildcard, despite a comment in the code claiming "arbitrary data-* for agent-built interactive widgets". Agents wiring static markup to inline JS via `data-tab` / `data-panel` / `data-foo` hooks had those attrs silently stripped at create time — JS handlers then read `null` from `getAttribute('data-tab')` and broke. First-hand observation: tabs in the public-sharing interactive guide didn't switch. Sanitizer config switched to a `data-*` wildcard (via sanitize-html's native syntax); existing Folio-internal hooks (`data-folio-content`, `data-folio-live-feed`, `data-entry-id`, etc.) continue to work as before. Two regression tests added: arbitrary `data-tab` / `data-panel` / `data-foo` survive; Folio-internal `data-folio-*` still survives.

### Known limitations (documented, not changed)
- **Boolean attributes without values** (`<section hidden>`, `<button disabled>` when used purely as a flag) are stripped by sanitize-html upstream. Agents needing initial-hidden state should use a CSS class (`.is-hidden { display: none }`) or write the attribute with an explicit value (`hidden="hidden"`). Test added so the behavior is locked in.

## v0.18.1 — 2026-05-14

### Fixed
- **Cloud `/raw/:uuid` 500 on every note** for clouds first installed at v0.13–v0.14. The v0.17 `inline_render` column-add lived inside the v0.12→v0.13 UNIQUE-rebuild branch in `ensureMultiUserSchema`, behind an `if (hasNewUnique) return;` early-return. Clouds created with the v0.13+ schema directly (multi-user UNIQUE present from day one — e.g. `folio.notibox.ai`) skipped the rebuild → never ran the ALTER → every `/raw/:uuid` SELECT failed with `no such column: inline_render`. Migrator restructured so the inline_render block now runs on every boot, after any rebuild path. Regression test in `tests/cloud-multi-user-migration.test.ts` reproduces the v0.13-era seed shape and asserts the column lands.

### Hotfix without upgrade
Affected operators can patch in place: `sqlite3 <cloud.db> "ALTER TABLE notes ADD COLUMN inline_render INTEGER NOT NULL DEFAULT 0;"` then restart the service. v0.18.1 fixes it for new boots; the hotfix is idempotent with the migrator.

## v0.18.0 — 2026-05-14

New note type primitive: **`iteration`** — for design-iteration workflows where the agent generates N candidates, the user clicks one, the agent generates N variants of the pick, repeat. Tree-shaped (every variant has a `parent_variant_id` pointing at the round-winner that spawned it), append-only on the live-entries JSONL substrate.

### Added
- **`iteration` note type.** `create({ type: "iteration", title, body_html, thread_id })`. body_html is chrome only (h1 + intro); variants live in entries, not in body.
- **Three new MCP tools** — `propose_round({ note_id, variants[], parent_variant_id? })` returning `{ round, variant_ids[] }`; `pick_variant({ note_id, variant_id })` returning `{ round, variant_id, rejected_variant_ids[] }`; `iteration_state({ note_id })` returning `{ rounds[], lineage[], current_round, is_finalized }`. Tool count: 16 → 19.
- **Gallery renderer.** Viewer `/raw/:id` for iteration notes swaps the article body for a server-rendered grid of variant cards, each in its own sandboxed sub-iframe so per-variant CSS/JS stays isolated. Click-to-pick wired via parent-iframe `postMessage` → `POST /api/notes/:id/iter/pick` → iframe reload. Empty / waiting / multi-round breadcrumb states all handled.
- **Cloud-side rendering.** Cloud `/raw/:uuid` renders the same gallery but read-only (no pick buttons, no click handlers — picks happen on the device that owns the note). Iteration entries now sync to cloud via the existing `live_entries` push pipeline.
- **`finalize` for iteration notes.** Compiles the picked lineage into a static artifact (Final design block + Iteration history list), archives the JSONL (including discarded variants) to `~/Folio/.trash/`. Permissive — finalize with no picks writes a "no design selected" stub instead of erroring, mirroring `finalizeLive` behavior on empty notes.

### Migration / compatibility
- No schema migration. Iteration notes reuse the v0.9 `live_entries` JSONL + cloud table.
- Sync push query updated: previously gated on `live = 1`, now also pushes notes WHERE `type = 'iteration'`. Cloud's accept path was already type-agnostic — no cloud changes required for sync.
- Existing live notes / journal / snippet / research / comparison / technical flows are unchanged.

### SKILL
- New "Iteration notes" section with workflow, tool surface, and labeling guidance.
- `iteration` row added to the type-selection table.

## v0.17.2 — 2026-05-14

### Fixed
- **Auto-delete banner only when ≤7 days from expiry.** Previously it showed for every non-final note from creation (29d → 1d), so users learned to ignore it. The 7-day threshold matches `list_expiring` and the topbar "Expiring 7d" chip — the banner is load-bearing again.
- **Bouncy few-px scrollbar on note pages.** `.note-shell` / `.note-side` / `.note-main` assumed a 60px topbar but actual height can be 64-65px depending on font rendering. `body.note-page` now has `overflow: hidden`; the iframe wrap + side panel each scroll internally so nothing legitimate is hidden.

## v0.17.1 — 2026-05-14

Drop the silly `<button>` strip + adjacent form-control bans. Sanitizer was being conservative-by-default in a setup where the actual threat model already neutralizes the entire class of risk: notes render in a sandboxed null-origin iframe with `form-action 'none'` + `connect-src 'none'` + `on*` handlers stripped. Static `<button>` is no different from `<div>` for security purposes; the createElement workaround was security theatre.

### Added (sanitizer allow-list)
- **Form controls in static HTML:** `<button>`, `<input>`, `<select>`, `<option>`, `<optgroup>`, `<textarea>`, `<label>`, `<form>`, `<fieldset>`, `<legend>`, `<output>`, `<progress>`, `<meter>`. With pragmatic attribute allow-lists (`type` / `name` / `value` / `disabled` / `placeholder` / `required` / `min` / `max` / `step` / `pattern` / etc.).
- **Accessibility attrs:** `role`, `tabindex`, `title`, `hidden`, and 25 standard `aria-*` attributes allowed globally on any element. Screen reader support for interactive widgets, no asterisks needed.

### Docs
- **SKILL.md** + **STYLEBOOK.md** updated — old "build via createElement" workaround for form controls replaced with the natural static-HTML pattern. SKILL example now shows a button + input directly in body_html with click handler in `<script>`.
- **MCP `create` tool description** updated — previously claimed `<style>` was forbidden (stale since v0.15) and didn't mention form controls. Now accurate.

### Safety check

Triple-locked threat model is unchanged:
- Sandboxed null-origin iframe (no `allow-same-origin`) — no parent reach, no cookies, no localStorage
- CSP `form-action 'none'` — submissions blocked at the policy layer, regardless of `action` attribute
- CSP `connect-src 'none'` — fetch/XHR/WebSocket all blocked, so runtime-built code can't exfil either
- `on*` handler attributes stripped by sanitize-html as before

`<button>` and friends are structural elements with zero exfil surface in this configuration. They've been on the SKILL's "build via JS" workaround list since v0.3 with no actual security justification.

## v0.17.0 — 2026-05-14

**Inline-rendered live notes** — entries render INSIDE body_html (not in a side panel). The note body grows as you append. Cloud-side runtime changes — VPS deploy needs `sudo ./deploy/update.sh`.

### Added
- **`create({live:true, inline:true})`** — new flag on MCP `create` + CLI `folio new --inline`. Side panel is suppressed for inline notes; entries appear directly in the note document. Body_html should contain a `<section data-folio-live-feed></section>` placeholder where entries land; if omitted, Folio auto-injects one at the end of body. `inline` is ignored when `live=false`.
- **Server-side entry compile.** Local viewer `/raw/:uuid` and cloud `/raw/:uuid` both splice the current feed into `<section data-folio-live-feed>` on every GET. Recipient opens the note — sees all entries immediately, even without a SSE-connected chrome. New entries during the session arrive via SSE → parent → postMessage → body iframe.
- **`src/core/feed-render.ts`** — shared helper (`renderEntryHtml`, `renderFeedHtml`, `spliceFeedIntoBody`, `INLINE_FEED_BOOTSTRAP_JS`) used by both `finalize()` and the inline `/raw/` path. Single source of truth for the entry HTML shape.
- **Schema v3 → v4** — `notes.inline_render INTEGER NOT NULL DEFAULT 0`. Local viewer migration in `src/core/migrations.ts`; cloud-side ALTER ADD COLUMN in `ensureMultiUserSchema()`. Sync push/pull payloads carry `inline_render` so the flag rides along to phone PWA and back.
- **Sanitizer allows `data-folio-live-feed`** (and `data-entry-id`) on any element so the placeholder + compiled entry articles survive `sanitize-html`.

### Fixed
- **SKILL clarity around live note UX.** SKILL.md "Live notes" section now states "Two render modes" and walks the agent through picking inline vs panel. Adds an explicit rule: don't tell the user "feed refreshes via SSE" without saying WHERE (body vs side panel) — that's where humans get confused.

### Notes for operators

Cloud-side runtime change — `sudo ./deploy/update.sh` on the VPS. Existing live notes default to panel mode (`inline_render=0` from the migration). To upgrade a note to inline, recreate it with `inline:true` and re-append the entries — schema is append-only so there's no in-place flip. Most new live notes (journal, todo, log) should default to inline.

## v0.16.0 — 2026-05-14

Three polish items around sharing + branding. Cloud-side runtime changes — VPS deploy needs `sudo ./deploy/update.sh` for the new `/p/<token>/og.svg` + `/qr.svg` routes.

### Added
- **Favicon for local viewer.** New routes `/favicon.svg` + `/favicon.ico` (both serve the same SVG with `image/svg+xml`), `<link rel="icon">` + `<link rel="apple-touch-icon">` injected into the viewer `shell()` template. Brand icon ("f" + orange dot, square, 96px corner radius) extracted to `src/core/brand.ts` so favicon + PWA icon never drift. Fixes the `GET /favicon.ico 404` console noise.
- **Open Graph image for shared notes.** New module `src/cloud/og.ts` generates a 1200×630 SVG card with the note title, scope chip (`note` / `thread`), theme-accent stripe down the left edge, and the `folio.` wordmark in the bottom-left. Served at `/p/<token>/og.svg`. `renderSharedNotePage` + `renderSharedThreadPage` inject the full OG meta set: `og:title` / `og:type` / `og:image` (+ dimensions + image:type) / `og:url` / `og:site_name`, plus `twitter:card=summary_large_image`. Slack / Telegram / iMessage / Discord / Twitter unfurl the link with a real preview instead of a bare URL.
- **QR code for capability URLs.** New module `src/cloud/qr.ts` (wraps the `qrcode` npm package in SVG-string mode, brand-colored ink/bg). Served at `/p/<token>/qr.svg`. `folio publish` output gains a `QR code` line pointing at the URL — paste it in chat or open in browser, scan with phone camera, lands on the share page.

### Notes for operators

Cloud-side runtime change — `sudo ./deploy/update.sh` on the VPS. Existing share links continue working unchanged; the new routes layer on alongside.

Recipient-bound shares: `og.svg` is publicly fetchable so social previewers can render the unfurl card (otherwise the link preview shows just the URL string). The note title surfaces in the OG, matching Notion / Google Docs behaviour where the title leaks via link preview but content stays behind the email confirmation gate. If a future use case wants to suppress title for bound shares, gate `og.svg` in `handleCapabilityRoute` on cookie state.

## v0.15.1 — 2026-05-14

Two follow-ups to v0.15.0.

### Fixed
- **`window.print()` / `alert()` / `confirm()` / `prompt()` now work inside notes.** All three note-iframe spots (local viewer, capability URL render, PWA `/n/:uuid` shell) gain `allow-modals` in their `sandbox` attribute. Without it, Chromium silently logs "Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword is not set." Sanitizer's `DEFAULT_IFRAME_SANDBOX` updated to match for body-embedded iframes. Threat model unchanged — modals can annoy but can't exfiltrate (CSP `connect-src 'none'` still holds; null-origin sandbox still holds). SW bumped to `folio-pwa-9` to evict cached `/n/:uuid` HTML with the old sandbox attr.

### Docs
- **`skills/folio/SKILL.md`** updated for the plain theme that landed in v0.15.0:
  - New `plain` row in the theme matrix (custom layout / poster / ASCII art / experimental viz)
  - `<style>` rule softened from strict `❌` to `⚠️ — allowed since v0.15 but default to theme.css classes; reach for a body-level <style> block only when plain is in play or utilities don't fit`
  - `style=` rule notes the `plain` exception

## v0.15.0 — 2026-05-14

`plain` theme — almost-bare canvas for notes that want their own visual identity. Sanitizer now preserves `<style>` blocks at body level, so agents can write idiomatic HTML with a local stylesheet inside the note. No cloud-side runtime changes — pure local + skill update; the cloud just serves whatever the agent put in body_html.

### Added
- **`themes/plain/`** (new bundled theme). 60 lines of `theme.css`: CSS reset, body padding, fluid headings, sensible defaults for `<table>` / `<pre>` / `<code>` / `<blockquote>` / `<img>`, dark-mode pairing via `@media (prefers-color-scheme: dark)`. **No** `.eyebrow` / `.lead` / `.card` / `.cards` / `.pill` / `.verdict` — that's the point. Agent owns the per-note visual identity.
- **`<style>` tag allowed at body level** (`src/core/sanitize.ts` ALLOWED_TAGS). Notes render in a sandboxed null-origin iframe with `connect-src 'none'`, so CSS injection is bounded — no network exfiltration, no parent-window reach. Inline `style="..."` attrs were already allowed; this is just a smaller, more idiomatic surface for the same capability.
- **STYLEBOOK update** in `skills/folio/SKILL.md` / `STYLEBOOK.md`: new "Plain" entry in the theme tone matrix + expected pattern (a `<style>` block at the top of body_html). Old `❌ <style> in body_html` rule downgraded to `⚠️ — use sparingly, prefer theme.css classes for non-plain themes`.

### When to use the plain theme

The agent should reach for `plain` when the user asks for something visually idiosyncratic — a poster, a fake terminal, a custom diagram, an ASCII map, an experimental data viz — anything the standard utility classes would fight rather than support. For `research` / `comparison` / `technical` / `journal` shape the existing themes (`linen` / `folio` / `newsroom` / …) still win — they keep the user's Folio visually coherent across notes.

### Safety note

The threat model is unchanged. Every note still renders inside a sandboxed null-origin iframe with `script-src 'self' 'unsafe-inline' https:` + `connect-src 'none'` + `frame-ancestors 'self'`. CSS in body-level `<style>` can't fetch external URLs that would leak data (CSP blocks `background: url(...)` to non-same-origin), can't reach the parent window's DOM, can't read cookies or localStorage. The creative freedom is creative, not security.

## v0.14.0 — 2026-05-14

Operator UI for the multi-user cloud. Every CLI subcommand (`folio cloud user-add / user-rename / user-revoke / user-promote / pair-code --user`) now has a clickable equivalent in the local viewer's `/cloud` page, gated by `users.is_operator`. Six new HTTP endpoints + a viewer proxy + a PWA identity hint. Cloud-side runtime changes — VPS deploys need `sudo ./deploy/update.sh` and an explicit `folio cloud user-promote <id>` to designate the first operator.

### Added
- **`users.is_operator INTEGER NOT NULL DEFAULT 0`** column (v4 → v5 migration, idempotent ADD COLUMN on pre-v14 DBs). New CLI: `folio cloud user-promote <id>` / `user-demote <id>`. Display surfaced in `user-list` "role" column (operator / active / deleted). Multiple operators allowed.
- **`/v1/admin/*` operator endpoints.** `GET /whoami` (any device, returns user_id + display + is_operator). Operator-only: `GET /users` (global per-user breakdown), `POST /users` (create + optional first pair-code), `PATCH /users/:id` (rename · promote · demote · reactivate), `DELETE /users/:id[?purge=1]` (revoke / cascade purge), `POST /users/:id/pair-code` (mint for target user). Non-operator devices get `403`. All mutations share code with the CLI subcommands via the new `src/cloud/admin.ts` module.
- **Viewer proxy `/api/cloud/admin/*`.** Same bearer-laundering pattern as `/api/cloud/stats`: the viewer process holds the token from `.sync-state.json` and forwards the request body. Page JS calls these with no Authorization header.
- **Operator dashboard in `/cloud`.** Local viewer's `/cloud` page calls `/api/cloud/admin/whoami` on load and renders the new Operator panel only when `is_operator=true`. Click a user row to expand a detail panel (stats grid + actions: mint pair-code, rename, promote/demote, revoke devices, purge cascade). `+ Add user` opens an inline form with the option to mint the first pair-code in the same request. Purge requires typing the user id as a confirmation gate.
- **PWA identity hint.** Top bar now shows `signed in as <display> · sign out` once the bearer is in IndexedDB. Tap "sign out" → confirms → clears IDB token + caches → redirects to `/pair`. SW version bumped to `folio-pwa-8`.

### Notes for operators

After deploying v0.14.0, designate the first operator (otherwise the new admin endpoints return 403 for everyone):

```bash
sudo -u folio /opt/folio/folio cloud user-promote jarek
```

From that point on, the local viewer's `/cloud` page shows the operator panel for that user's devices — no more SSH needed to onboard new accounts. The CLI subcommands keep working (single source of truth in `src/cloud/admin.ts`), so either path is fine.

## v0.13.1 — 2026-05-14

Hotfix for v0.13.0's CLI dispatcher: top-level `parseArgs` consumed `--flag value` pairs into `flags` before dispatch, so `folio cloud pair-code --user alice` reached `cloudCmd` with no flags and errored with "--user required". Local tests passed because they called `cloudCmd` directly; only the actual binary invocation triggered it.

### Fixed
- **`folio cloud <sub> --flag …` now reaches the subcommand handler.** Dispatcher reconstructs `--flag value` and bare `--flag` pairs from `flags` and appends them to `cloudCmd`'s args. Affects every cloud subcommand that takes flags (`pair-code --user`, `user-add --display`, `user-list --json`, `user-revoke --purge --yes`). New regression test in `tests/cloud-user-cli.test.ts` drives through `main()` end-to-end.

## v0.13.0 — 2026-05-14

Multi-user cloud relay. One `folio.notibox.ai` instance now serves any number of independent users — each user pairs their Notibox + laptop + phone, and the cloud filters every read/write by user_id so accounts are invisible to each other. Cloud-side runtime changes — VPS deploys need `sudo ./deploy/update.sh`. Existing v0.12 paired devices keep working: the migration auto-runs and backfills to a single `default` user, which the operator can rename via the new CLI.

### Added
- **Multi-user partitioning across the cloud DB.** New `users` table; `user_id NOT NULL` column on devices / pairing_codes / notes / assets / tombstones / shares. Every authed query in `src/cloud/server.ts`, `sync.ts`, `shares.ts`, `stats.ts` now filters by `device.user_id` derived from the bearer. UNIQUE on notes flipped from `(thread_id, slug)` to `(user_id, thread_id, slug)` — Alice and Bob can both have a `morning` thread. Cross-user push/pull/raw/feed/admin-stats/share returns "not found" symmetrically (no leakage of uuid existence).
- **Idempotent v0.12 → v0.13 migrator** in `cloudDb()`. PRAGMA `table_info(devices)` canary detects pre-v0.13 schemas; `ALTER TABLE ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'` fills every existing row in one statement; notes table rewritten under `PRAGMA foreign_keys = OFF` to swap the UNIQUE constraint without cascading the `note_tags` + `live_entries` FKs. Defensive: bails with a diagnostic if duplicate (user_id, thread_id, slug) groups would block the rebuild.
- **Per-user asset namespace.** New public route `GET /u/<user>/t/<thread>/asset/<file>` pins lookup to `assets.user_id`. `renderStandaloneNote` rewrites body_html refs `/t/<thread>/asset/<file>` → `/u/<user>/t/<thread>/asset/<file>` on serve so iframes always load the right user's bytes. Legacy `/t/<thread>/asset/<file>` route preserved for single-tenant compat — resolves only when exactly one user owns the (thread, filename) tuple, else 404. SW version bumped to `folio-pwa-7` to invalidate cached old-shape URLs.
- **CLI `folio cloud user-*`** (operator, server-side). Four new subcommands:
  - `folio cloud user-add <id> [--display "Name"]` — provision a new account. Kebab-case validation, idempotency, `--reactivate` flag for previously-deleted ids.
  - `folio cloud user-list [--json]` — per-user table: devices, notes, live entries, assets (count + bytes), shares, last seen. Operator's whole-cloud view, not exposed via HTTP.
  - `folio cloud user-rename <old> <new>` — atomic rename across all six user_id columns + the users row. Bearer tokens unaffected.
  - `folio cloud user-revoke <id> [--purge --yes]` — without flags, revokes all user's devices (data preserved). With `--purge --yes`, cascades delete on notes/assets/tombstones/shares + sets `users.deleted_at`. Confirmation gate requires explicit `--yes` to avoid accidental data loss.
- **`folio cloud pair-code --user <id>`** required when more than one user exists. Single-user installs keep the v0.12 invocation (no flag). Mints codes with `pairing_codes.user_id` set; consuming a code stamps the new device into that user's namespace.
- **Per-user `/v1/admin/stats`.** HTTP endpoint scoped to caller's user; Alice and Bob each see only their own counts. Operator CLI `user-list` retains the global view.

### Security
- **Cross-user push rejection.** `handlePush` ownership checks on every note/live_entry/delete: foreign-uuid pushes silently skipped (idempotent); cross-user live_entries fail the owner check; cross-user deletes log nothing and pass through unchanged. A leaked bearer can only damage its own user's data.
- **Capability URLs pinned to share.user_id.** Note/asset lookups behind `/p/<token>/...` join on `share.user_id` so a leaked token from user A can never resolve to user B's note even if a uuid collision is engineered.
- **`/v1/auth/devices` and `/v1/auth/device/:id` revocation** scoped to caller's user. Operator does cross-user revoke via the CLI, never via the API.

### Notes for operators

```bash
# 1. Deploy (replaces binary, restarts service, runs migration on first DB open)
sudo ./deploy/update.sh    # or manually: install -m 755 folio /opt/folio/folio + restart

# 2. Verify migration
sudo -u folio /opt/folio/folio cloud user-list
# → default | display=default | 1 device | N notes | ...

# 3. Rename the seeded user (optional — keeps things readable)
sudo -u folio /opt/folio/folio cloud user-rename default jarek

# 4. Add a new user
sudo -u folio /opt/folio/folio cloud user-add alice --display "Alice"
sudo -u folio /opt/folio/folio cloud pair-code --user alice
# → hand the 6-digit code to Alice over Signal / SMS / phone

# Alice pairs (her own machine)
folio sync pair --remote https://folio.notibox.ai --code <code>
```

Existing v0.12 clients keep syncing without changes — they never see any user_id in the wire protocol; the cloud derives it from the bearer. Capability URL recipients (no Folio install) are unaffected; URLs continue to work cross-user.

## v0.12.0 — 2026-05-14

Multi-feature polish: install UX, observability, asset pull, real email delivery. Cloud-side runtime changes — VPS deploys need `sudo ./deploy/update.sh` to pick up `/v1/admin/stats`, plaintext-email passthrough on `/v1/share`, and the new PWA install banner. Optional email setup: set `RESEND_API_KEY` + `FOLIO_MAIL_FROM` on the cloud to wire outbound delivery; without them the share endpoint still works and reports `email_skipped="no-mailer"` so the CLI can surface a clear status line.

### Added
- **iOS / Chrome / Edge install banner.** PWA home page now captures `beforeinstallprompt` on browsers that fire it (Chrome/Edge/Samsung) and shows an inline `Install` button. iOS Safari — which doesn't fire that event — gets a dedicated hint: "Tap the Share icon, then 'Add to Home Screen'." Hidden whenever the app is already running standalone (`display-mode: standalone` or legacy `navigator.standalone`); dismissible for the session. SW bumped to `folio-pwa-6`.
- **`GET /v1/admin/stats` (authed) + viewer Cloud stats panel.** Read-only observability snapshot: note/live-entry/asset/share/tombstone counts, DB + asset bytes, per-device `last_seen_at` / `last_pushed_at` / `note_count`, top 20 threads. Local viewer's `/cloud` page gets a new "Cloud stats" card that fetches this when paired, with a refresh button. Bearer token never leaves the local process — viewer proxies via `GET /api/cloud/stats`.
- **Pull-side asset download.** When `syncOnce` pulls a foreign-origin note, the daemon scans its `body_html` for `/t/<thread>/asset/<file>` refs and downloads any bytes missing locally via the cloud's public asset endpoint. Sync output gains `assets_pulled=N`. Idempotent (existing non-empty files skipped) and validated against the same `isSafeAssetFilename` allowlist used on push.
- **Real email delivery for `folio publish --recipient`.** Cloud relay now ships a pluggable mailer (`src/cloud/mailer.ts`) with two providers: **Resend** (HTTP-only — no SMTP lib dep; set `RESEND_API_KEY` + `FOLIO_MAIL_FROM`) and **console** (opt-in dev logger via `FOLIO_MAIL_DEV=1`). `POST /v1/share` accepts `recipient_email` plaintext alongside the existing `recipient_email_hash`; server derives + persists only the hash and uses plaintext for the outbound message. Response includes `email_sent` / `email_skipped` / `email_error` so the CLI can show a clear status line. Mismatched hash/plaintext pairs are rejected. Recipient confirmation flow (HttpOnly cookie gate) is unchanged.

### Improved
- **Sync output adds asset direction arrows** — `assets↑=N` (pushed) `assets↓=N` (pulled) in the daemon's per-iteration log line and the local `/cloud` page's sync result panel. Easier to tell at a glance whether you're publishing or consuming bytes on a given run.
- **Cloud stats endpoint is on every release** — even before paging numbers matter, the per-device "last push / last seen" view makes it trivial to spot a phone that's been offline for weeks or a revoked laptop still listed.

### Notes for operators

Production VPS needs `sudo ./deploy/update.sh` to pick up the cloud changes. To enable outbound email, add to `/etc/folio-cloud/folio-cloud.env`:

```
RESEND_API_KEY=re_yourkeyhere
FOLIO_MAIL_FROM=Folio <folio@yourdomain.tld>
```

Then `sudo systemctl restart folio-cloud`. The Resend "From" domain has to be verified in Resend first — otherwise sends fail and the CLI surfaces the API error. Skipping these vars leaves the share endpoint fully functional minus delivery; capability URLs work as before.

## v0.11.0 — 2026-05-14

Multi-device + sharing maturity. Five post-MVP backlog items + token-hygiene polish. This release has cloud-side runtime changes — VPS deploys need `sudo ./deploy/update.sh` (or a re-run of `bootstrap.sh`) to pick up SSE forwarding, tombstones, recipient binding, and asset cascade.

### Added
- **Cross-device delete tombstones.** Delete on laptop A used to leave laptop B's local copy intact (pull silently missed the gap past the cursor). Cloud now keeps a `tombstones` table, pull returns rows since the caller's cursor, and `applyPulledTombstones` calls `storage.deleteNote` on foreign-origin entries. Own-echo skipped via `origin_device_id`. Sync output gains `deletes_applied=N`.
- **Live note SSE forward through cloud.** New `GET /v1/sync/live-stream?note_uuid=<uuid>` endpoint with `text/event-stream` fan-out from `handlePush.live_entries`. Token accepted via Bearer header OR `?token=` query param (EventSource limitation). PWA `/n/:uuid` shell auto-opens the stream when `X-Folio-Live: 1` is set on `/raw/`, renders a live panel below the iframe. New entries appear in real time with pulsing-orange indicator. Heartbeat every 25s keeps proxies happy.
- **`folio publish --recipient bob@example.com`.** Capability URL bound to a SHA-256 hash of the recipient's email. First visit hits a confirmation form; on email match, server sets a path-scoped HttpOnly cookie. Plaintext email never leaves the publishing client. Reduces blast radius of a leaked URL — both URL and email need to leak before content shows.
- **`deploy/bootstrap.sh`** — one-shot self-host bootstrap. `curl | sudo PUBLIC_URL=https://cloud.example.com bash` downloads the latest release for the target triple, runs `install.sh`, writes the systemd drop-in, generates the first pairing code, and prints the Caddy snippet to paste. Subsequent device pairings still go through `/cloud` UI without SSH.
- **Asset cleanup cascade on delete.** When `handlePush.deletes` removes a note, the cloud scans referenced assets and unlinks any blob with zero remaining referrers (LIKE-scan on body_html across all active notes). Storage reclaim is automatic; `accepted.assets_deleted` in the push response reports what went.

### Improved
- **Token hygiene at pair time.** `~/Folio/.sync-state.json` is now written with `mode 0600` (atomic-rename preserves it). `folio sync pair` output shows only a `AvAE…glEQ` fingerprint instead of nudging the full bearer onto a screen-share or paste-to-chat trap.
- **Release flow documented** with the canonical bump → push branch → PR → merge → pull → tag sequence in CONTRIBUTING.md. Branch protection rationale spelled out (kept on `main`, paid off when an accidental `git add -A` snuck a pnpm-lock.yaml in).

### Notes for operators

Production VPS needs `sudo ./deploy/update.sh` to pick up the cloud changes. Existing v0.10.x clients keep working against a v0.10.x cloud (the new pull tombstones field is optional in the typed response), but you'll want the new endpoints for SSE + recipient binding to actually function.

## v0.10.2 — 2026-05-14

Maintenance + dev-loop quality. No cloud-side runtime changes; existing VPS deploys don't need an update for this release. Local binary picks up:

### Added
- **Playwright PWA test suite.** `bun run test:pwa` drives a real headless Chromium against a real cloud relay, exercises the pair flow, IDB token plumbing, blob-URL iframe handshake, and sandbox attribute integrity. Catches the class of bugs that took multiple deploy/redeploy cycles during W3.
- **`folio doctor` storage + cloud sections.** Bumps install-state-only doctor to a full diagnostic: `folio_home` / `index.sqlite` / bundled themes existence, plus (when paired) cloud reachability, token validity, last-push recency. `--offline` skips network probes; `--json` machine-readable. Auto-emits warnings for unreachable cloud, revoked token, stale (>7d) sync.
- **Upgrade-path integration tests.** `tests/migrations.test.ts` now covers v0.9.1 → v0.10.x (the W2 origin/owner_device_id migration) end-to-end with byte-for-byte previous-version db construction. Plus a v0.8.0 → v0.10.x hop test that exercises both migrations in order. Codifies the regression-test pattern for future schema work.
- **Pre-release maintainer checklist** in CONTRIBUTING.md — seven items including the "first-time-user walkthrough" pass that would have caught delete + TOC + sync UI + print bugs before they hit users.

### Fixed
- **Print outputs only the note body.** Sidebar's "↗ Print / PDF" used to print the full viewer chrome (topbar, sidebar). Now parent posts `{ns:'folio',type:'print'}` to the iframe, which prints itself — clean PDF export.

### Docs
- README refreshed to v0.10.x feature set (cloud sync, PWA, publish, delete, doctor, sync UI). CHANGELOG.md added with v0.7.2+ entries.
- deploy/README.md gains "Test cloud changes locally first" section explaining the FOLIO_CLOUD_PORT=18081 dev-cloud workflow.
- src/core/migrations.ts header comment spells out the two-phase bootstrap discipline: new columns in migrations, new indexes in PHASE2_SCHEMA, never edit a shipped migration.

## v0.10.1 — 2026-05-13

### Added
- **`folio doctor`** extended with `Storage` and `Cloud sync` sections. Checks `folio_home` / `index.sqlite` / bundled themes + templates existence; for paired devices probes cloud reachability + token validity, tracks `last_pushed_at` recency, surfaces actionable warnings (unreachable, token rejected, stale sync). `--offline` skips network probes; `--json` machine-readable.
- **Local viewer `/cloud` page** with two modes: pair form (paste URL + code) when not paired, status + actions (sync now, generate code for new device, unpair) when paired. Backed by `/api/sync/{state,pair,pair-code,run,unpair}` endpoints — bearer token never enters page JS.
- **PWA "+ Add another device"** panel on home — generates pair codes via the new `POST /v1/auth/pair-code` cloud endpoint (authed). Closes the SSH-to-server gap for every device after the first.
- **Topbar ☁ Cloud link** in the local viewer.

### Fixed
- **Print outputs the note, not the chrome.** Previously `window.print()` printed the outer viewer (topbar + sidebar visible in PDF). Now parent posts `{ns:'folio',type:'print'}` to the iframe and the iframe prints itself — clean note-only output.

### Tests
- 270/270 unit (+6 doctor + cloud, +others)
- 6 Playwright headless-browser tests for PWA flows

## v0.10.0 — 2026-05-13

Four-weekend cloud-mvp sprint. Folio becomes a multi-device system.

### Added
- **Cloud Relay (W1).** Bun HTTP server that paired devices push notes + assets to. Bare-metal systemd deploy (`deploy/install.sh`, `update.sh`, Caddy snippet). Single binary + `ProtectSystem=strict` for blast radius comparable to a container, half the moving parts.
- **Sync daemon (W2).** `folio sync pair --remote --code` then `folio sync` as a daemon (or `--once` for cron). Bidirectional push/pull with monotonic cursors for notes + deletes + live entries. Slug collision rename on push + defensive rename on pull. Live notes are owner-locked: foreign live notes can't be appended-to locally; create your own in the same thread instead.
- **Schema v3.** `origin_device_id` + `owner_device_id` columns on notes. UUIDv7-like ULIDs already cross-device unique so no identity migration. Migration in `src/core/migrations.ts` adds the columns; PHASE2 of the two-phase bootstrap creates the index after.
- **PWA (W3).** Phone (or any browser) installs Folio from `/pair`, reads at `/`. App shell is public, contentless JS that reads token from IndexedDB → fetches `/v1/feed` for the list. `/n/:uuid` is a JS shell that explicit-fetches `/raw/:uuid` with auth header and loads it into a sandboxed iframe via blob URL — no SW dependency for auth, no race on first install. Server-side search + thread navigation + native tap-targets + offline cache via SW.
- **`folio publish` (W4).** Capability URLs at `/p/<token>/n/<uuid>` and `/p/<token>/t/<thread>/`. Token is the credential — scope-checked + expiry-checked + max_views-checked on every hit. Asset URLs in shared notes rewritten through `/p/<token>/` so images work without paired devices.
- **`folio shares list|revoke`** for managing active shares.
- **MCP `folio.publish` tool** so agents share a note inline after `create()`.
- **Asset sync.** Sync daemon scans body_html for `/t/<thread>/asset/<file>` refs, HEAD then POST missing assets to `/v1/sync/assets/<hash>`. Public route `/t/<thread>/asset/<file>` serves the bytes (sub-resource fetches from null-origin iframes can't carry bearer headers). Capability-scoped variant gates by token. Backfill scans all active notes so existing assets eventually catch up.
- **`folio delete`** (CLI + viewer sidebar button). Soft-delete to `~/Folio/.trash/` (recoverable 7 days). Sync push propagates the delete to cloud (cascade clears `note_tags` + `live_entries`). Append-only semantics preserved: agents still can't delete via MCP — this is human-only, like `finalize`.
- **TOC depth dropped to h1/h2** because three depths were visual noise. Deeper headings still get anchor IDs via `attachAnchors()` so deep-link URLs continue to work.

### Known scope cuts (post-MVP)
- Pull-side asset download (only writer→cloud direction works; multi-laptop pulls don't auto-fetch bytes)
- Cross-device delete tombstones (delete on A doesn't auto-remove on B; per-device cleanup for now)
- Live note SSE forward (phone shows last-synced snapshot, not the live feed)
- Magic-link recipient binding for shares (column reserved, not exercised)
- `folio cloud bootstrap` one-command self-host (deploy/install.sh exists; the bootstrap wrapper that wires it interactively does not)

## v0.9.1 — 2026-05-12

Hotfix for v0.9.0's upgrade-path crash. Pre-v0.9.0 dbs hit `no such column: live` because `CREATE INDEX IF NOT EXISTS notes_by_live` ran before the migration added the column.

### Fixed
- **Two-phase schema bootstrap.** `PHASE1_SCHEMA` (PRAGMAs + meta) → `runMigrations()` → `PHASE2_SCHEMA` (tables + indexes). Migrations between phases mean every column referenced by an index in PHASE2 is guaranteed to exist.
- New columns now go via `migrations.ts` `up()`; indexes referencing them live in `PHASE2_SCHEMA`. Codified as a convention in `migrations.ts` and `db.ts` header comments.

## v0.9.0 — 2026-05-12

### Added
- **Live notes (ADR-020).** Append-only journal primitive. `create({live:true})` produces a note with a sidecar `<slug>.entries.jsonl`. `folio append <id>` / MCP `append_entry` adds lines. Viewer chrome streams entries via SSE. `finalize` compiles the feed into a static body and flips the note out of live mode.
- MCP tools: `append_entry`, `list_entries`, `set_pinned`.

## v0.8.0 — 2026-05-12

### Added
- **`folio install --target openclaw`** + `--target all`. One-command install across detected MCP clients (Claude Code + OpenClaw). Atomic JSON edits with `.folio-backup-<ts>` taken on first touch.
- **`folio doctor`** (initial). Shows install state per target, warns about broken skill symlinks / stale MCP entries / multiple folio binaries on PATH.

## v0.7.2 — 2026-05-12

### Docs
- Killed the pre-v0.3 "no script in body_html" atavism in `skills/folio/SKILL.md`. Scripts are allowed at body level since v0.3; isolation comes from the outer sandboxed iframe + CSP, not the sanitizer.

## Earlier

`v0.7.x` and below: see git log for details. The repo went public on 2026-05-12 with v0.8.0 as the first announced version; v0.1 through v0.7 were the pre-public iterations.
