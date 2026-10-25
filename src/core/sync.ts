/**
 * Sync daemon — bidirectional push/pull between a device's local ~/Folio/ and
 * a Folio Cloud relay (src/cloud/server.ts). W2 of the cloud-mvp sprint.
 *
 * Boundaries:
 *   - This module owns the WIRE PROTOCOL with the cloud (push/pull JSON
 *     payloads, asset hashing, cursors) and the SYNC STATE file.
 *   - It does NOT own the daemon loop, signal handling, or CLI flags — those
 *     live in src/cli/commands/sync.ts.
 *
 * Append-only data model carries 80% of the multi-writer story for free:
 *   - Notes are immutable HTML files → no edit conflicts ever.
 *   - Note IDs are ULIDs assigned client-side at create → cross-device unique.
 *   - Tags are sets → union merge.
 *   - Live entries are content-addressed by (note_id, entry_id) on the cloud
 *     side → idempotent re-push.
 *
 * What sync handles explicitly:
 *   - Own-echo: pulled notes whose origin_device_id == self are skipped.
 *   - Slug collisions: server rewrites slug on conflict and returns the
 *     canonical name; we rename the local .html file + update the DB row.
 *   - Cursor: monotonic int from cloud's server_seq. Stored per-remote in
 *     ~/Folio/.sync-state.json.
 *   - Asset bytes: push (writer→cloud) scans body_html for asset refs and
 *     uploads via /v1/sync/assets/<hash>; pull (cloud→reader) scans pulled
 *     body_html and downloads missing bytes via the public /t/<id>/asset/
 *     endpoint. Pull-side download is idempotent: skip if the local file
 *     already exists with non-zero size.
 *
 * What we DO NOT sync in W2 MVP:
 *   - Finalize / expiry / cleanup state changes after the initial push.
 *     Today, finalize on device A doesn't propagate to device B. Pickup
 *     when the user reports it as painful.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { db } from "./db";
import { folioRoot, threadsDir, threadAssetsDir, getOrCreateDeviceId, configPath, isSafeAssetFilename, loadConfig } from "./config";
import { renderNote } from "./templates";
import { getTheme } from "./themes";
import { plNormalize } from "./slug";
import { extractText } from "./text";
import { entriesPath, readEntries } from "./live";
import type { LiveEntry } from "./types";

// ----- State file -----

const SYNC_STATE_FILENAME = ".sync-state.json";
const LOCK_FILENAME = ".sync.lock";

export interface SyncState {
  remote: string;
  device_token: string;
  last_pulled_seq: number;
  last_pushed_at: string | null; // ISO; null on first run
  /** Per-note last entry id pushed to cloud, for incremental live-entry push. */
  last_live_pushed: Record<string, string>;
  /** ISO timestamp of the most recent trashed-note `updated` field we've
   *  pushed a delete for. Decoupled from last_pushed_at because a delete
   *  bumps `updated` but doesn't bump `created`, so the active-notes cursor
   *  wouldn't move past it. Null on first run. */
  last_delete_pushed_at?: string | null;
  /** ISO timestamp of the most recent superseded note's `updated` we've
   *  pushed a supersede pointer for. Separate cursor for the same reason as
   *  deletes: replaceNote() bumps `updated` (not `created`) on the OLD note,
   *  so the created-keyed active-notes window in pushNotes never re-sends it.
   *  Null on first run. */
  last_supersede_pushed_at?: string | null;
  /** sc-24117: `sync_scope: "shared"` snapshot tracking — every local note
   *  uuid currently believed to be on the cloud because it's covered by one
   *  of this device's active shares, mapped to the `updated` value as of
   *  that push. Unlike `last_pushed_at` (a monotonic cursor), this can't be a
   *  cursor: a note can enter coverage long after its `created`/`updated`
   *  (an old note gets shared), so we need per-note "have we pushed the
   *  CURRENT version" state, not a watermark. Also doubles as the purge set:
   *  a key no longer in computed coverage (revoked, expired, deleted
   *  locally) gets pushed as a `delete` and dropped from this map. Optional
   *  so pre-sc-24117 state files (and `sync_scope: "all"` users, who never
   *  touch it) keep validating. */
  shared_pushed?: Record<string, string>;
}

function statePath(): string {
  return join(folioRoot(), SYNC_STATE_FILENAME);
}

function lockPath(): string {
  return join(folioRoot(), LOCK_FILENAME);
}

export function loadSyncState(): SyncState | null {
  if (!existsSync(statePath())) return null;
  try {
    return JSON.parse(readFileSync(statePath(), "utf-8")) as SyncState;
  } catch {
    return null;
  }
}

/**
 * Instruction for the agent when there is no externally reachable base URL
 * (no `viewer_public_url`), so `public_url` is null. A link that opens
 * outside this machine then only comes from a capability share (`publish`,
 * /p/<token>/n/<id>) — the cloud's own /n/<uuid> needs a paired browser.
 * Without cloud pairing there is no external link at all. `via` picks the
 * wording: MCP tool call vs CLI command.
 */
export function shareHint(id: string, via: "mcp" | "cli" = "mcp"): string {
  const local = "local_url (127.0.0.1) opens only on this machine";
  if (loadSyncState()) {
    const how = via === "mcp"
      ? `call publish({ id: "${id}" }) and send the url from its response`
      : `run \`folio publish ${id}\` and send the URL it prints`;
    return `No public viewer URL configured; ${local}. For a link that opens anywhere else, ${how}.`;
  }
  return `No external link available: no viewer_public_url and Folio is not paired with a cloud (folio sync pair). ${local} — don't send it to anyone reading elsewhere.`;
}

export function saveSyncState(state: SyncState): void {
  const p = statePath();
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  // Atomic write via tmp + rename. chmod 600 BEFORE the rename so the file
  // never appears in its final path with broader permissions — protects
  // the bearer token from world-readable umasks. On Windows chmod is a
  // no-op; the file lives in the user's home anyway.
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

// ----- Lock file -----

export class LockHeldError extends Error {
  constructor(pid: number) {
    super(`folio sync already running (pid ${pid})`);
  }
}

export function acquireLock(): void {
  const p = lockPath();
  if (existsSync(p)) {
    try {
      const raw = readFileSync(p, "utf-8");
      const pid = Number(raw.split("\n")[0]);
      if (Number.isFinite(pid) && pid > 0) {
        // Check if the process is still alive — if not, the lock is stale.
        try {
          process.kill(pid, 0);
          throw new LockHeldError(pid);
        } catch (e: any) {
          if (e instanceof LockHeldError) throw e;
          // ESRCH = process not found → stale lock, fall through to overwrite.
        }
      }
    } catch (e: any) {
      if (e instanceof LockHeldError) throw e;
      // Malformed lock file — overwrite.
    }
  }
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${process.pid}\n${new Date().toISOString()}\n`);
}

export function releaseLock(): void {
  const p = lockPath();
  if (existsSync(p)) {
    try {
      const raw = readFileSync(p, "utf-8");
      const pid = Number(raw.split("\n")[0]);
      if (pid === process.pid) {
        // Only release if we hold it.
        try { require("node:fs").unlinkSync(p); } catch {}
      }
    } catch {}
  }
}

// ----- HTTP helpers -----

async function http<T = unknown>(
  method: "GET" | "POST" | "DELETE" | "HEAD",
  url: string,
  token: string,
  body?: unknown
): Promise<T | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  let init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    (init as any).body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch {}
    throw new Error(`${method} ${url} → HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  if (method === "HEAD" || res.status === 204) return null;
  return (await res.json()) as T;
}

// ----- Asset extraction + push -----

/**
 * Find every asset reference in a body_html fragment.
 *
 * Looks for `(?:href|src)="…/t/<thread_id>/asset/<filename>"` patterns. Matches
 * both relative URLs (`/t/X/asset/foo.png`) and absolute ones from
 * viewer_public_url (`https://notes.example.com/t/X/asset/foo.png`). The
 * (thread_id, filename) pair is the only thing the cloud needs to serve the
 * file under its own host.
 *
 * Filename validation: `isSafeAssetFilename` — same allowlist enforced by
 * MCP attach_asset. Refs that don't match are silently skipped (don't fail
 * the entire push for one malformed image link).
 */
export interface AssetRef {
  thread_id: string;
  filename: string;
}
export function extractAssetRefs(bodyHtml: string): AssetRef[] {
  const re = /(?:href|src)\s*=\s*["']([^"']*)\/t\/([^/"']+)\/asset\/([^"'?#]+)["']/g;
  const seen = new Set<string>();
  const out: AssetRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml)) !== null) {
    const thread_id = decodeURIComponent(m[2]!);
    const filename = decodeURIComponent(m[3]!);
    if (!isSafeAssetFilename(filename)) continue;
    const key = `${thread_id}/${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ thread_id, filename });
  }
  return out;
}

/**
 * Make sure every asset referenced by `notes` is present on the cloud
 * before the notes themselves are pushed. Idempotent — content-addressed
 * uploads dedupe; the HEAD pre-check skips unchanged files.
 *
 * Skipping silently on read errors (file missing locally) so a single
 * borked image doesn't stop the entire push. The cloud will 404 on the
 * image when rendered, same end-state as today.
 */
export async function ensureAssetsOnCloud(
  state: SyncState,
  notes: { body_html: string; thread_id: string }[]
): Promise<{ uploaded: number; skipped: number }> {
  let uploaded = 0;
  let skipped = 0;
  // Collect unique (thread_id, filename) refs across all notes.
  const seen = new Set<string>();
  const refs: AssetRef[] = [];
  for (const n of notes) {
    for (const r of extractAssetRefs(n.body_html)) {
      // The asset URL might reference a different thread_id than the note
      // (cross-thread linking is allowed). Trust the URL's thread_id.
      const key = `${r.thread_id}/${r.filename}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(r);
    }
  }

  for (const r of refs) {
    const abs = join(threadAssetsDir(r.thread_id), r.filename);
    if (!existsSync(abs)) { skipped++; continue; }
    let bytes: Uint8Array;
    let hash: string;
    try {
      const buf = readFileSync(abs);
      bytes = new Uint8Array(buf);
      hash = createHash("sha256").update(buf).digest("hex");
    } catch {
      skipped++;
      continue;
    }
    // HEAD: skip upload if cloud already has these bytes.
    try {
      const head = await fetch(`${state.remote}/v1/sync/assets/${hash}`, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${state.device_token}` },
      });
      if (head.ok) { skipped++; continue; }
    } catch {
      // Network error — try POST anyway; it'll fail similarly if the network is dead.
    }
    const res = await fetch(`${state.remote}/v1/sync/assets/${hash}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.device_token}`,
        "Content-Type": "application/octet-stream",
        "X-Folio-Filename": r.filename,
        "X-Folio-Thread-Id": r.thread_id,
      },
      body: bytes,
    });
    if (res.ok) uploaded++;
    else skipped++;
  }
  return { uploaded, skipped };
}

// ----- Body extraction -----

/**
 * Pull the agent body_html out of a wrapped note file. The local file is
 * the FULL HTML rendered via templates/_base.html.eta, wrapping the body
 * in `<article data-folio-content>…</article>`. Push payload sends only
 * the inner body so cloud can re-wrap with its own theme.css inline.
 *
 * Nested-article-safe: agent bodies frequently contain `<article>` elements
 * (iteration cards, blog-style sections, etc.). A non-greedy regex would
 * stop at the FIRST inner `</article>` and silently truncate. We instead
 * locate the wrapper opener via regex, then take everything up to the LAST
 * `</article>` in the file — the template always emits the wrapper close
 * after every nested one, so lastIndexOf is unambiguous.
 *
 * History (v0.19.2 fix): the non-greedy `*?` regex was truncating the
 * showcase note at the first iter-card on cloud push (delivered ~16KB of
 * a ~30KB rendered note).
 *
 * Falls back to the whole file if the wrapper marker is missing.
 */
export function extractBodyHtml(fullHtml: string): string {
  const openMatch = fullHtml.match(/<article[^>]*data-folio-content[^>]*>/);
  if (!openMatch || openMatch.index === undefined) return fullHtml;
  const start = openMatch.index + openMatch[0].length;
  const end = fullHtml.lastIndexOf("</article>");
  if (end <= start) return fullHtml;
  return fullHtml.slice(start, end).trim();
}

// ----- Push payload builder -----

interface PushNotePayload {
  uuid: string;
  slug: string;
  thread_id: string;
  title: string;
  type: string;
  theme: string;
  theme_profile: string;
  body_html: string;
  plain_text: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  is_final: 0 | 1;
  live: 0 | 1;
  owner_device_id: string | null;
  inline_render: 0 | 1;
  is_pinned: 0 | 1;
  pinned_at: string | null;
  /** v0.30.1: supersede chain pointer (id of the note that replaced this
   *  one), or null for a head note. Carried so a re-push via pushSupersedes
   *  upserts it onto the cloud row. */
  superseded_by: string | null;
  tags: string[];
  summary: string | null;
  word_count: number;
}

interface PushLiveEntryPayload {
  id: string;
  note_uuid: string;
  ts: string;
  content_html: string;
  tags: string[];
  occurred_at: string | null;
  refs: string[];
  importance: number | null;
  source_ref: string | null;
}

interface PushAcceptedResp {
  notes: { uuid: string; canonical_slug: string }[];
  live_entries: { id: string; note_uuid: string }[];
  cursor: number;
}

interface PullResp {
  notes: PullNote[];
  live_entries: PullLiveEntry[];
  tombstones?: PullTombstone[]; // Optional for back-compat with older cloud builds
  assets: unknown[];
  cursor: number;
}

interface PullTombstone {
  uuid: string;
  thread_id: string;
  origin_device_id: string | null;
  deleted_at: string;
  server_seq: number;
}

interface PullNote {
  uuid: string;
  slug: string;
  thread_id: string;
  title: string;
  type: string;
  theme: string;
  theme_profile: string;
  body_html: string;
  plain_text: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  is_final: 0 | 1;
  live: 0 | 1;
  owner_device_id: string | null;
  origin_device_id: string;
  inline_render?: 0 | 1;
  /** v0.29: optional — older cloud builds don't send these. Default to
   *  unpinned on the consumer side. */
  is_pinned?: 0 | 1;
  pinned_at?: string | null;
  /** v0.30.1: optional — older cloud builds don't send it; default null. */
  superseded_by?: string | null;
  tags: string[];
  summary: string | null;
  word_count: number;
  server_seq: number;
}

interface PullLiveEntry {
  id: string;
  note_uuid: string;
  ts: string;
  content_html: string;
  tags: string[];
  occurred_at: string | null;
  refs: string[];
  importance: number | null;
  source_ref: string | null;
  server_seq: number;
}

// ----- Push step -----

export interface SyncStepResult {
  pushed: number;
  pulled: number;
  live_pushed: number;
  live_pulled: number;
  renamed: number;
  deleted: number;
  /** Cross-device deletes applied via tombstones on this pull. Distinct from
   *  `deleted`, which counts THIS device's outgoing pushed deletes. */
  deletes_applied: number;
  assets_pushed: number;
  /** Asset bytes downloaded from cloud for pulled (foreign-origin) notes
   *  whose body_html references files this device didn't have locally. */
  assets_pulled: number;
}

/**
 * Push deletions of locally-trashed notes to the cloud. Independent cursor
 * (`last_delete_pushed_at`) because a delete bumps `updated` but not
 * `created`, so it'd be invisible to pushNotes' active-notes window.
 */
export async function pushDeletes(state: SyncState, selfDeviceId: string): Promise<number> {
  const cursor = state.last_delete_pushed_at ?? "1970-01-01T00:00:00Z";
  const rows = db()
    .query<{ id: string; updated: string }, [string, string]>(
      `SELECT id, updated FROM notes
        WHERE status = 'trashed'
          AND (origin_device_id IS NULL OR origin_device_id = ?)
          AND updated > ?
        ORDER BY updated ASC
        LIMIT 100`
    )
    .all(selfDeviceId, cursor);
  if (rows.length === 0) return 0;
  const uuids = rows.map((r) => r.id);
  await http<{ deletes: string[]; cursor: number }>(
    "POST",
    `${state.remote}/v1/sync/push`,
    state.device_token,
    { deletes: uuids }
  );
  state.last_delete_pushed_at = rows.reduce((acc, r) => (r.updated > acc ? r.updated : acc), cursor);
  return uuids.length;
}

// Shared row shape + column list + payload builder for the two note-push
// passes (pushNotes by `created`, pushSupersedes by `updated`). One source so
// the passes can't drift on which columns they send.
interface NotePushRow {
  id: string;
  slug: string;
  path: string;
  title: string;
  type: string;
  theme: string;
  theme_profile: string;
  thread_id: string;
  is_final: number;
  live: number;
  created: string;
  updated: string;
  expires_at: string | null;
  word_count: number;
  summary: string | null;
  origin_device_id: string | null;
  owner_device_id: string | null;
  inline_render: number;
  is_pinned: number;
  pinned_at: string | null;
  superseded_by: string | null;
}

const NOTE_PUSH_COLUMNS =
  `id, slug, path, title, type, theme, theme_profile, thread_id,
          is_final, live, created, updated, expires_at, word_count, summary,
          origin_device_id, owner_device_id, inline_render, is_pinned, pinned_at,
          superseded_by`;

function buildNotePayloads(rows: NotePushRow[]): PushNotePayload[] {
  return rows.map((r) => {
    const tags = db()
      .query<{ tag: string }, [string]>("SELECT tag FROM tags WHERE note_id = ?")
      .all(r.id)
      .map((t) => t.tag);
    const fullHtml = readFileSync(join(folioRoot(), r.path), "utf-8");
    const body_html = extractBodyHtml(fullHtml);
    const stats = extractText(body_html);
    return {
      uuid: r.id,
      slug: r.slug,
      thread_id: r.thread_id,
      title: r.title,
      type: r.type,
      theme: r.theme,
      theme_profile: r.theme_profile,
      body_html,
      plain_text: stats.body.slice(0, 8192),
      created_at: r.created,
      updated_at: r.updated,
      expires_at: r.expires_at,
      is_final: (r.is_final ? 1 : 0) as 0 | 1,
      live: (r.live ? 1 : 0) as 0 | 1,
      owner_device_id: r.owner_device_id,
      inline_render: (r.inline_render ? 1 : 0) as 0 | 1,
      is_pinned: (r.is_pinned ? 1 : 0) as 0 | 1,
      pinned_at: r.pinned_at,
      superseded_by: r.superseded_by,
      tags,
      summary: r.summary,
      word_count: r.word_count,
    };
  });
}

export async function pushNotes(state: SyncState, selfDeviceId: string): Promise<{ pushed: number; renamed: number; assets_pushed: number }> {
  // Notes to push: own origin (or unset = pre-W2, assumed own) AND newer than cursor.
  const cursor = state.last_pushed_at ?? "1970-01-01T00:00:00Z";
  const rows = db()
    .query<NotePushRow, [string, string]>(
      `SELECT ${NOTE_PUSH_COLUMNS}
         FROM notes
        WHERE status = 'active'
          AND (origin_device_id IS NULL OR origin_device_id = ?)
          AND created > ?
        ORDER BY created ASC
        LIMIT 50`
    )
    .all(selfDeviceId, cursor);

  // Asset backfill runs every sync regardless of whether new notes are
  // being pushed. Necessary for the "asset sync added later" upgrade case:
  // cursor sits past old notes that have assets the cloud never received.
  // ensureAssetsOnCloud is internally idempotent (HEAD pre-check), so this
  // is one cheap pass per sync.
  const allBodies = db()
    .query<{ body_path: string; thread_id: string }, []>(
      "SELECT path AS body_path, thread_id FROM notes WHERE status = 'active'"
    )
    .all()
    .map((r) => {
      try {
        return {
          body_html: readFileSync(join(folioRoot(), r.body_path), "utf-8"),
          thread_id: r.thread_id,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is { body_html: string; thread_id: string } => x !== null);
  const assetResult = await ensureAssetsOnCloud(state, allBodies);

  if (rows.length === 0) return { pushed: 0, renamed: 0, assets_pushed: assetResult.uploaded };

  const payloads: PushNotePayload[] = buildNotePayloads(rows);

  const resp = await http<PushAcceptedResp>("POST", `${state.remote}/v1/sync/push`, state.device_token, {
    notes: payloads,
  });
  if (!resp) throw new Error("push: empty response");

  // Apply rename map. Server returns canonical_slug for every accepted note.
  let renamed = 0;
  for (const r of resp.notes) {
    const local = rows.find((x) => x.id === r.uuid);
    if (!local) continue;
    if (r.canonical_slug !== local.slug) {
      const oldAbs = join(folioRoot(), local.path);
      const newRel = join("threads", local.thread_id, `${r.canonical_slug}.html`);
      const newAbs = join(folioRoot(), newRel);
      if (existsSync(oldAbs) && !existsSync(newAbs)) {
        renameSync(oldAbs, newAbs);
      }
      db().run("UPDATE notes SET slug = ?, path = ? WHERE id = ?", [r.canonical_slug, newRel, r.uuid]);
      renamed++;
    }
  }

  // Advance cursor to the last note we just pushed.
  const maxCreated = payloads.reduce((acc, p) => (p.created_at > acc ? p.created_at : acc), state.last_pushed_at ?? "");
  if (maxCreated) state.last_pushed_at = maxCreated;

  return { pushed: payloads.length, renamed, assets_pushed: assetResult.uploaded };
}

// ----- Push supersedes -----

/**
 * Push supersede pointers — a SEPARATE pass with its own `updated`-keyed
 * cursor, exactly like pushDeletes. replaceNote() sets superseded_by on the
 * OLD (already-pushed) note and bumps `updated` but not `created`, so the
 * created-keyed window in pushNotes never re-sends it; without this pass a
 * `replace` on one device never hides the old revision on another. Re-pushes
 * the full note payload (body is immutable) so the cloud INSERT…ON CONFLICT
 * upserts superseded_by with no "must already exist on cloud" ordering
 * dependency.
 */
export async function pushSupersedes(state: SyncState, selfDeviceId: string): Promise<number> {
  const cursor = state.last_supersede_pushed_at ?? "1970-01-01T00:00:00Z";
  const rows = db()
    .query<NotePushRow, [string, string]>(
      `SELECT ${NOTE_PUSH_COLUMNS}
         FROM notes
        WHERE status = 'active'
          AND superseded_by IS NOT NULL
          AND (origin_device_id IS NULL OR origin_device_id = ?)
          AND updated > ?
        ORDER BY updated ASC
        LIMIT 100`
    )
    .all(selfDeviceId, cursor);
  if (rows.length === 0) return 0;
  const payloads = buildNotePayloads(rows);
  const resp = await http<PushAcceptedResp>("POST", `${state.remote}/v1/sync/push`, state.device_token, {
    notes: payloads,
  });
  if (!resp) throw new Error("pushSupersedes: empty response");
  state.last_supersede_pushed_at = rows.reduce((acc, r) => (r.updated > acc ? r.updated : acc), cursor);
  return payloads.length;
}

// ----- Push live entries -----

export async function pushLiveEntries(
  state: SyncState,
  selfDeviceId: string,
  allowedIds?: Set<string>
): Promise<number> {
  // Live notes owned by this device.
  // Push entries for both live notes (v0.9+) and iteration notes (v0.18+).
  // Iteration notes reuse the JSONL substrate to store variants/picks, so
  // they need the same sync treatment even though live=0 on them.
  // sc-24117: `allowedIds` narrows this to a `sync_scope: "shared"` coverage
  // set — entries for a live note outside the shared snapshot must not leak.
  let notes = db()
    .query<{ id: string; path: string }, [string]>(
      `SELECT id, path FROM notes
        WHERE (live = 1 OR type = 'iteration') AND status = 'active'
          AND (owner_device_id IS NULL OR owner_device_id = ?)`
    )
    .all(selfDeviceId);
  if (allowedIds) notes = notes.filter((n) => allowedIds.has(n.id));

  const allEntries: PushLiveEntryPayload[] = [];
  const lastByNote: Record<string, string> = { ...(state.last_live_pushed ?? {}) };

  for (const n of notes) {
    const jsonlPath = entriesPath(join(folioRoot(), n.path));
    if (!existsSync(jsonlPath)) continue;
    const entries = readEntries(jsonlPath);
    const lastPushed = state.last_live_pushed?.[n.id] ?? "";
    // Entry ids are time-sortable (ulid suffix). Push everything after lastPushed.
    // For a fresh sync, lastPushed = "" so we push all.
    const fresh = entries.filter((e) => e.id > lastPushed);
    for (const e of fresh) {
      allEntries.push({
        id: e.id,
        note_uuid: n.id,
        ts: e.ts,
        content_html: e.content_html,
        tags: e.tags,
        occurred_at: e.occurred_at ?? null,
        refs: e.refs ?? [],
        importance: e.importance ?? null,
        source_ref: e.source_ref ?? null,
      });
    }
    // Track the highest id we'll push (lexicographic ulid sort = chronological).
    if (fresh.length > 0) {
      const maxId = fresh.reduce((acc, e) => (e.id > acc ? e.id : acc), lastPushed);
      lastByNote[n.id] = maxId;
    }
  }

  if (allEntries.length === 0) return 0;

  // Push in chunks of 200 to keep request bodies reasonable.
  const CHUNK = 200;
  for (let i = 0; i < allEntries.length; i += CHUNK) {
    const slice = allEntries.slice(i, i + CHUNK);
    await http<PushAcceptedResp>("POST", `${state.remote}/v1/sync/push`, state.device_token, {
      live_entries: slice,
    });
  }

  state.last_live_pushed = lastByNote;
  return allEntries.length;
}

// ----- Asset pull -----

/**
 * For each (thread_id, filename) pair, ensure the bytes live at
 * ~/Folio/threads/<thread>/assets/<filename>. Hits the cloud's public
 * `/t/<thread>/asset/<file>` endpoint — no bearer header needed (the route
 * is public for sub-resource fetches from sandboxed iframes; we benefit
 * here from the same property).
 *
 * Idempotent: existing non-empty files are left alone. Filename safety is
 * checked before any disk write (mirrors push-side guard against path
 * traversal via crafted body_html refs). Network/disk errors on a single
 * asset are logged-via-skip and don't fail the rest of the batch.
 */
export async function pullAssets(
  state: SyncState,
  refs: AssetRef[]
): Promise<{ downloaded: number; skipped: number }> {
  let downloaded = 0;
  let skipped = 0;
  for (const r of refs) {
    if (!isSafeAssetFilename(r.filename)) { skipped++; continue; }
    const dir = threadAssetsDir(r.thread_id);
    const abs = join(dir, r.filename);
    try {
      const st = statSync(abs);
      if (st.size > 0) { skipped++; continue; }
    } catch {
      // Missing — proceed to download.
    }
    let res: Response;
    try {
      res = await fetch(
        `${state.remote}/t/${encodeURIComponent(r.thread_id)}/asset/${encodeURIComponent(r.filename)}`
      );
    } catch {
      skipped++;
      continue;
    }
    if (!res.ok) { skipped++; continue; }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      skipped++;
      continue;
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${abs}.tmp`;
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, abs);
      downloaded++;
    } catch {
      skipped++;
    }
  }
  return { downloaded, skipped };
}

// ----- Pull step -----

export async function pullNotes(state: SyncState, selfDeviceId: string): Promise<{ pulled: number; live_pulled: number; deletes_applied: number; assets_pulled: number }> {
  const url = `${state.remote}/v1/sync/pull?since=${state.last_pulled_seq}`;
  const resp = await http<PullResp>("GET", url, state.device_token);
  if (!resp) throw new Error("pull: empty response");

  let pulled = 0;
  // Collect asset refs from every foreign-origin note we apply, so we can
  // batch-download bytes after the note files land. Deduped by (thread,
  // filename) inside pullAssets — extractAssetRefs already dedupes per note,
  // and assets are content-addressed enough that re-fetching across notes
  // would just be wasted bytes.
  const foreignAssetRefs: AssetRef[] = [];
  const foreignSeen = new Set<string>();
  for (const n of resp.notes) {
    // Skip own echo — we know what we sent.
    if (n.origin_device_id === selfDeviceId) continue;
    await applyPulledNote(n);
    pulled++;
    for (const r of extractAssetRefs(n.body_html)) {
      const key = `${r.thread_id}/${r.filename}`;
      if (foreignSeen.has(key)) continue;
      foreignSeen.add(key);
      foreignAssetRefs.push(r);
    }
  }
  const assetPull = foreignAssetRefs.length > 0
    ? await pullAssets(state, foreignAssetRefs)
    : { downloaded: 0, skipped: 0 };

  let live_pulled = 0;
  for (const e of resp.live_entries) {
    // Determine owner of the parent note. If it's ours (own-echo of our own
    // entry), skip. Otherwise append to local jsonl with dedup.
    const own = db()
      .query<{ origin_device_id: string | null }, [string]>(
        "SELECT origin_device_id FROM notes WHERE id = ?"
      )
      .get(e.note_uuid);
    if (own && own.origin_device_id === selfDeviceId) continue;
    if (applyPulledLiveEntry(e)) live_pulled++;
  }

  // Apply tombstones: foreign devices deleted these notes; mirror locally so
  // the laptop's view matches the cloud truth. Own deletes propagated via
  // pushDeletes already moved the file to .trash and flipped status, so
  // re-applying is a no-op (storage.deleteNote returns not-found gracefully).
  let deletes_applied = 0;
  for (const t of resp.tombstones ?? []) {
    if (t.origin_device_id === selfDeviceId) continue; // own echo
    const { deleteNote } = await import("./storage");
    const res = deleteNote(t.uuid);
    if (res.ok) deletes_applied++;
  }

  state.last_pulled_seq = resp.cursor;
  return { pulled, live_pulled, deletes_applied, assets_pulled: assetPull.downloaded };
}

async function applyPulledNote(n: PullNote): Promise<void> {
  // 1. Render full HTML for local viewer consumption.
  const themeObj = await getTheme(n.theme);
  if (!themeObj) {
    // Theme missing locally — fall back to linen so the file still renders.
    const fallback = await getTheme("linen");
    if (!fallback) throw new Error(`Neither requested theme '${n.theme}' nor 'linen' found locally`);
  }
  const theme_css = themeObj ? themeObj.css : "";
  const fullHtml = renderNote({
    id: n.uuid,
    type: n.type as any,
    title: n.title,
    body_html: n.body_html,
    theme: n.theme,
    theme_css,
    theme_profile: (n.theme_profile as any) ?? "hosted",
    tags: n.tags,
    thread_id: n.thread_id,
    created: n.created_at,
    updated: n.updated_at,
    is_final: !!n.is_final,
  });

  // 2. Resolve local slug, defending against conflicts. The cloud may send a
  //    note whose (thread, slug) collides with an EXISTING local note that
  //    was created here before sync — local createNote couldn't know about
  //    the foreign one. Mirror the server-side rule: append <uuid6> suffix.
  //    Idempotent: a re-pull of the same uuid keeps the same renamed slug.
  let slug = n.slug;
  const taken = db()
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM notes WHERE thread_id = ? AND slug = ? AND id != ?"
    )
    .get(n.thread_id, slug, n.uuid);
  if (taken) {
    slug = `${n.slug}-${n.uuid.replace(/-/g, "").slice(0, 6).toLowerCase()}`;
  }

  // 3. Write file. Directory tree is per-thread.
  const targetDir = join(threadsDir(), n.thread_id);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const relPath = join("threads", n.thread_id, `${slug}.html`);
  const absPath = join(folioRoot(), relPath);
  const tmpPath = `${absPath}.tmp`;
  writeFileSync(tmpPath, fullHtml, "utf-8");
  renameSync(tmpPath, absPath);

  // 3. Upsert into DB.
  const stats = extractText(n.body_html);
  const d = db();
  d.transaction(() => {
    d.run(
      `INSERT INTO notes (
         id, slug, path, title, type, theme, theme_profile, thread_id,
         is_final, created, updated, expires_at, word_count, summary, status,
         live, last_entry_at, origin_device_id, owner_device_id, inline_render,
         is_pinned, pinned_at, superseded_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug,
         path = excluded.path,
         title = excluded.title,
         type = excluded.type,
         theme = excluded.theme,
         theme_profile = excluded.theme_profile,
         thread_id = excluded.thread_id,
         is_final = excluded.is_final,
         updated = excluded.updated,
         expires_at = excluded.expires_at,
         word_count = excluded.word_count,
         summary = excluded.summary,
         live = excluded.live,
         origin_device_id = excluded.origin_device_id,
         owner_device_id = excluded.owner_device_id,
         inline_render = excluded.inline_render,
         is_pinned = excluded.is_pinned,
         pinned_at = excluded.pinned_at,
         superseded_by = excluded.superseded_by`,
      [
        n.uuid,
        slug,
        relPath,
        n.title,
        n.type,
        n.theme,
        n.theme_profile,
        n.thread_id,
        n.is_final ? 1 : 0,
        n.created_at,
        n.updated_at,
        n.expires_at,
        n.word_count,
        n.summary,
        n.live ? 1 : 0,
        n.origin_device_id,
        n.owner_device_id,
        (n.inline_render ?? 0) ? 1 : 0,
        (n.is_pinned ?? 0) ? 1 : 0,
        n.pinned_at ?? null,
        n.superseded_by ?? null,
      ]
    );
    // Tag set replace.
    d.run("DELETE FROM tags WHERE note_id = ?", [n.uuid]);
    for (const tag of n.tags) {
      d.run("INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)", [n.uuid, tag]);
    }
    // FTS upsert.
    d.run("DELETE FROM notes_fts WHERE id = ?", [n.uuid]);
    d.run(
      "INSERT INTO notes_fts (id, title, headings, body, tags) VALUES (?, ?, ?, ?, ?)",
      [
        n.uuid,
        plNormalize(n.title),
        plNormalize(stats.headings),
        plNormalize(stats.body),
        plNormalize(n.tags.join(" ")),
      ]
    );
  })();
}

function applyPulledLiveEntry(e: PullLiveEntry): boolean {
  // Need the note's local path to find its sidecar jsonl.
  const note = db()
    .query<{ path: string }, [string]>("SELECT path FROM notes WHERE id = ?")
    .get(e.note_uuid);
  if (!note) {
    // Entry arrived before its parent note. Cloud's monotonic seq should
    // prevent this, but be defensive: skip silently — entry will reappear
    // on next pull (cursor doesn't advance for this entry until note lands).
    return false;
  }
  const jsonl = entriesPath(join(folioRoot(), note.path));
  // Dedup: skip if entry id already present in jsonl.
  if (existsSync(jsonl)) {
    const existing = readEntries(jsonl);
    if (existing.some((x) => x.id === e.id)) return false;
  } else {
    if (!existsSync(dirname(jsonl))) mkdirSync(dirname(jsonl), { recursive: true });
  }
  const entry: LiveEntry = {
    id: e.id,
    ts: e.ts,
    content_html: e.content_html,
    tags: e.tags,
  };
  if (e.occurred_at) entry.occurred_at = e.occurred_at;
  if (e.refs && e.refs.length > 0) entry.refs = e.refs;
  if (e.importance != null) entry.importance = e.importance as 1 | 2 | 3 | 4 | 5;
  if (e.source_ref) entry.source_ref = e.source_ref;
  appendFileSync(jsonl, JSON.stringify(entry) + "\n", "utf-8");
  return true;
}

// ----- Shared sync scope (sc-24117) -----
//
// `sync_scope: "shared"` turns the cloud from a full mirror into a
// publish-only relay: only notes covered by this device's own active shares
// ever leave the box, and the box never pulls (it is always the source of
// truth). Device-side auth (device_token / `replace` of device_id, part B
// of sc-24117) is NOT touched here — this is purely "what gets pushed".

export interface ShareScope {
  scope_type: "note" | "thread" | "set";
  scope_id: string;
}

/** Walk a note's replace chain forward (this note → whoever superseded it →
 *  ...), including the starting id, up to `capSteps` hops. Deliberately
 *  local to sync.ts (not storage.ts's getRevisionChain/resolveHeadOfChain)
 *  so this module doesn't need a core/storage dependency; stops at the
 *  first missing/trashed link so a broken chain yields a shorter — never
 *  wrong — list. */
function forwardChainIds(startId: string, capSteps = 50): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = startId;
  let steps = 0;
  while (cur && !seen.has(cur) && steps < capSteps) {
    const row = db()
      .query<{ id: string; superseded_by: string | null }, [string]>(
        `SELECT id, superseded_by FROM notes WHERE id = ? AND status = 'active'`
      )
      .get(cur);
    if (!row) break;
    seen.add(row.id);
    out.push(row.id);
    cur = row.superseded_by;
    steps++;
  }
  return out;
}

/** Local analog of cloud/shares.ts `computeLinkedNoteSet` — same /n/<id>
 *  link extraction, maxDepth + cap, but reading THIS device's notes table +
 *  HTML files instead of the cloud's body_html column (so a `sync_scope:
 *  "shared"` device can compute what a 'set' share covers without ever
 *  pulling). Returns uuids reachable from `rootId`, excluding the root. */
const LOCAL_NOTE_LINK_RE = /\/n\/([0-9A-Za-z][0-9A-Za-z-]{7,})/g;

function localLinkedNoteSet(rootId: string, maxDepth = 3, cap = 50): string[] {
  const seen = new Set<string>([rootId]);
  const out: string[] = [];
  let frontier: string[] = [rootId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0 && out.length < cap; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const row = db()
        .query<{ path: string }, [string]>(`SELECT path FROM notes WHERE id = ? AND status = 'active'`)
        .get(id);
      if (!row) continue;
      let html = "";
      try {
        html = readFileSync(join(folioRoot(), row.path), "utf-8");
      } catch {
        continue;
      }
      LOCAL_NOTE_LINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LOCAL_NOTE_LINK_RE.exec(html)) !== null) {
        const linkedId = m[1]!;
        if (seen.has(linkedId)) continue;
        seen.add(linkedId);
        const exists = db()
          .query<{ id: string }, [string]>(`SELECT id FROM notes WHERE id = ? AND status = 'active'`)
          .get(linkedId);
        if (!exists) continue; // dangling link — nothing to push
        out.push(linkedId);
        next.push(linkedId);
        if (out.length >= cap) break;
      }
      if (out.length >= cap) break;
    }
    frontier = next;
  }
  return out;
}

/**
 * The set of local note uuids a share scope grants cloud visibility to —
 * the client-side "coverage" computation `sync_scope: "shared"` pushes
 * against. Mirrors the cloud's own share semantics (computeLinkedNoteSet,
 * validateShareAccess's forward-chain pass) but runs against THIS device's
 * notes table:
 *
 *   - note:   the note + its forward replace-chain. Old `/p/<token>/n/<id>`
 *             links must keep resolving after a `replace`, so the whole
 *             chain needs to be on the cloud, not just the current head.
 *   - thread: every active note (any revision) with this thread_id — a new
 *             note in an already-shared thread is covered the moment it's
 *             created, no separate share needed.
 *   - set:    the root + every note reachable via /n/<id> links (same rule
 *             as the cloud's computeLinkedNoteSet), each with its own
 *             forward chain.
 */
export function computeScopeCoverage(scope: ShareScope): string[] {
  const covered = new Set<string>();
  if (scope.scope_type === "note") {
    for (const id of forwardChainIds(scope.scope_id)) covered.add(id);
  } else if (scope.scope_type === "thread") {
    const rows = db()
      .query<{ id: string }, [string]>(`SELECT id FROM notes WHERE thread_id = ? AND status = 'active'`)
      .all(scope.scope_id);
    for (const r of rows) covered.add(r.id);
  } else {
    // "set"
    const members = [scope.scope_id, ...localLinkedNoteSet(scope.scope_id)];
    for (const member of members) {
      for (const id of forwardChainIds(member)) covered.add(id);
    }
  }
  return Array.from(covered);
}

interface RemoteShareSummary {
  token: string;
  scope_type: "note" | "thread" | "set";
  scope_id: string;
  expires_at: string | null;
}

/**
 * GET /v1/shares, filtered to this device's non-expired shares (the cloud's
 * `listShares` also returns already-expired rows — filtering is the
 * client's job, same as the cloud itself does at read time in
 * `validateShareAccess`). Deliberately does NOT catch network/HTTP errors:
 * per sc-24117, a failed shares lookup must abort the shared-scope sync
 * rather than being treated as "zero shares", which would purge every
 * snapshot off the cloud on a transient outage.
 */
export async function fetchActiveShares(state: SyncState): Promise<RemoteShareSummary[]> {
  const resp = await http<{ shares: RemoteShareSummary[] }>(
    "GET",
    `${state.remote}/v1/shares`,
    state.device_token
  );
  if (!resp) throw new Error("GET /v1/shares: empty response");
  const now = Date.now();
  return resp.shares.filter((s) => !s.expires_at || new Date(s.expires_at).getTime() > now);
}

/**
 * Push the current snapshot of a single share scope, independent of the
 * normal `pushNotes` cursor — so a brand-new share (or a `replace` on an
 * already-shared note) reaches the cloud immediately instead of waiting for
 * the next full sync tick. Shared by `createShareSynced` (publish, before
 * `POST /v1/share`) and the `sync_scope: "shared"` branch of `syncOnce`.
 *
 * Idempotent against `state.shared_pushed`: only notes whose `updated`
 * differs from the last recorded push are re-sent. Mutates `state` but does
 * NOT call `saveSyncState` — `syncOnce` persists once at the end of its
 * tick; `createShareSynced` skips it deliberately (the next real sync tick
 * reconciles either way, and publish is latency-sensitive).
 */
export async function pushScopeSnapshot(
  state: SyncState,
  scope: ShareScope,
  selfDeviceId?: string
): Promise<{ pushed: number; assets_pushed: number; live_pushed: number }> {
  const self = selfDeviceId ?? getOrCreateDeviceId().id;
  const coveredIds = computeScopeCoverage(scope);
  if (coveredIds.length === 0) return { pushed: 0, assets_pushed: 0, live_pushed: 0 };
  state.shared_pushed = state.shared_pushed ?? {};

  const placeholders = coveredIds.map(() => "?").join(",");
  const rows = db()
    .query<NotePushRow, any[]>(
      `SELECT ${NOTE_PUSH_COLUMNS} FROM notes WHERE status = 'active' AND id IN (${placeholders})`
    )
    .all(...coveredIds);

  const stale = rows.filter((r) => state.shared_pushed![r.id] !== r.updated);
  let pushed = 0;
  const CHUNK = 50;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const slice = stale.slice(i, i + CHUNK);
    const payloads = buildNotePayloads(slice);
    const resp = await http<PushAcceptedResp>("POST", `${state.remote}/v1/sync/push`, state.device_token, {
      notes: payloads,
    });
    if (!resp) throw new Error("pushScopeSnapshot: empty response");
    for (const r of slice) state.shared_pushed![r.id] = r.updated;
    pushed += slice.length;
  }

  // Assets referenced by the covered notes' bodies — every call, not just
  // when something changed, same reasoning as pushNotes' backfill pass.
  const bodies = rows
    .map((r) => {
      try {
        return {
          body_html: extractBodyHtml(readFileSync(join(folioRoot(), r.path), "utf-8")),
          thread_id: r.thread_id,
        };
      } catch {
        return null;
      }
    })
    .filter((x): x is { body_html: string; thread_id: string } => x !== null);
  const assetResult = await ensureAssetsOnCloud(state, bodies);

  const coveredSet = new Set(coveredIds);
  const live_pushed = await pushLiveEntries(state, self, coveredSet);

  return { pushed, assets_pushed: assetResult.uploaded, live_pushed };
}

/**
 * Remove `shared_pushed` entries whose uuid is no longer in `coveredIds` —
 * pushes a `delete` for each (same mechanism as `pushDeletes`, creates a
 * cloud tombstone) so a revoked/expired/locally-deleted note's snapshot
 * disappears from the cloud instead of lingering forever.
 */
export async function purgeSharedCoverage(
  state: SyncState,
  coveredIds: Set<string>
): Promise<{ deleted: number }> {
  state.shared_pushed = state.shared_pushed ?? {};
  const stale = Object.keys(state.shared_pushed).filter((id) => !coveredIds.has(id));
  if (stale.length === 0) return { deleted: 0 };
  await http("POST", `${state.remote}/v1/sync/push`, state.device_token, { deletes: stale });
  for (const id of stale) delete state.shared_pushed![id];
  return { deleted: stale.length };
}

/**
 * Recompute this device's full share coverage and purge anything that fell
 * out — called right after a successful revoke (CLI `folio shares revoke`,
 * the viewer's revoke endpoint) so the cloud snapshot disappears immediately
 * instead of waiting for the next sync tick. Callers are expected to treat
 * this as best-effort (swallow errors): the revoke itself already succeeded
 * against the cloud, and the next periodic `syncOnce` tick is the safety net
 * that retries the purge if this one fails (e.g. GET /v1/shares flaking).
 */
export async function purgeSharedAfterRevoke(state: SyncState): Promise<{ deleted: number }> {
  const shares = await fetchActiveShares(state);
  const coveredUnion = new Set<string>();
  for (const s of shares) {
    for (const id of computeScopeCoverage(s)) coveredUnion.add(id);
  }
  const result = await purgeSharedCoverage(state, coveredUnion);
  saveSyncState(state);
  return result;
}

/**
 * `sync_scope: "shared"` sync step: publish-only. Pushes ONLY the snapshot
 * covered by this device's active shares (never a blanket `pushNotes`),
 * purges whatever fell out of coverage since the last tick, and skips
 * `pullNotes` entirely — the cloud is a one-way publish relay in this mode,
 * never a source the box reads back from. A failed `GET /v1/shares`
 * propagates (see `fetchActiveShares`) so the whole tick fails instead of
 * silently purging every snapshot.
 */
async function syncOnceShared(state: SyncState, selfDeviceId: string): Promise<SyncStepResult> {
  const shares = await fetchActiveShares(state);
  let pushed = 0;
  let assets_pushed = 0;
  let live_pushed = 0;
  const coveredUnion = new Set<string>();
  for (const s of shares) {
    const r = await pushScopeSnapshot(state, s, selfDeviceId);
    pushed += r.pushed;
    assets_pushed += r.assets_pushed;
    live_pushed += r.live_pushed;
    for (const id of computeScopeCoverage(s)) coveredUnion.add(id);
  }
  const purgeR = await purgeSharedCoverage(state, coveredUnion);
  saveSyncState(state);
  return {
    pulled: 0,
    live_pulled: 0,
    pushed,
    renamed: 0,
    live_pushed,
    deleted: purgeR.deleted,
    deletes_applied: 0,
    assets_pushed,
    assets_pulled: 0,
  };
}

// ----- One-shot step driver -----

export async function syncOnce(state: SyncState): Promise<SyncStepResult> {
  const self = getOrCreateDeviceId();
  const cfg = await loadConfig();
  if (cfg.sync_scope === "shared") {
    return syncOnceShared(state, self.id);
  }
  // Push first, pull second. Reasoning: if a local note collides with a
  // remote note on (thread, slug), pushing first lets the server return a
  // canonical_slug and we rename locally. The subsequent pull won't conflict
  // because our local slug has changed. (applyPulledNote also handles the
  // reverse case defensively, but this ordering avoids the dance when it can.)
  const pushR = await pushNotes(state, self.id);
  const liveR = await pushLiveEntries(state, self.id);
  const deletedR = await pushDeletes(state, self.id);
  // Supersede pointers ride after the main note push (which created any
  // brand-new heads) but the full-payload re-push is order-independent
  // anyway thanks to INSERT…ON CONFLICT on the cloud.
  const supersededR = await pushSupersedes(state, self.id);
  const pullR = await pullNotes(state, self.id);
  saveSyncState(state);
  return {
    pulled: pullR.pulled,
    live_pulled: pullR.live_pulled,
    pushed: pushR.pushed + supersededR,
    renamed: pushR.renamed,
    live_pushed: liveR,
    deleted: deletedR,
    deletes_applied: pullR.deletes_applied,
    assets_pushed: pushR.assets_pushed,
    assets_pulled: pullR.assets_pulled,
  };
}

// ----- Auto-sync (v0.33) -----

/**
 * Best-effort background sync used by the auto-sync surfaces — the `folio
 * serve` loop and the MCP sync-on-write hook. No-op when not paired or
 * `auto_sync` is disabled. Honours the same `.sync.lock` as the standalone
 * daemon: if another syncer holds it, this tick is skipped silently. Never
 * throws — offline/transient errors are swallowed (the caller is a background
 * tick, not a user-facing command). Returns the step result on success, or
 * null when it no-op'd / skipped / failed.
 */
export async function autoSyncTick(): Promise<SyncStepResult | null> {
  const cfg = await loadConfig();
  if (cfg.auto_sync === false) return null;
  const state = loadSyncState();
  if (!state) return null; // not paired
  try {
    acquireLock();
  } catch {
    return null; // a daemon or another tick is mid-sync — skip, no double work
  }
  try {
    const r = await syncOnce(state);
    return r;
  } catch {
    return null;
  } finally {
    releaseLock();
  }
}

let _autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a debounced background sync — the MCP sync-on-write hook. Coalesces
 * rapid writes (e.g. several append_entry calls) into one sync shortly after
 * the last one. Fire-and-forget; never throws. unref'd so a pending sync never
 * keeps an otherwise-idle process alive.
 */
export function scheduleAutoSync(delayMs = 1500): void {
  if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
  _autoSyncTimer = setTimeout(() => {
    _autoSyncTimer = null;
    void autoSyncTick();
  }, delayMs);
  (_autoSyncTimer as any)?.unref?.();
}
