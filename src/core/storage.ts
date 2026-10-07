import { ulid } from "ulid";
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { db, logEvent } from "./db";
import { folioRoot, threadsDir, notesDir, loadConfig, getOrCreateDeviceId } from "./config";
import { slugify, plNormalize, plStem } from "./slug";
import { sanitize } from "./sanitize";
import { extractText } from "./text";
import { renderNote } from "./templates";
import { getTheme } from "./themes";
import { extractBodyHtml } from "./sync";
import type { CreateNoteInput, NoteMeta, SearchHit, NoteType, RenderProfile } from "./types";
import { strategyOf } from "./note-log";

function isoNow(): string {
  return new Date().toISOString();
}

function isoPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function uniqueSlug(slug: string, dir: string): string {
  let candidate = slug;
  let n = 2;
  while (existsSync(join(dir, `${candidate}.html`))) {
    candidate = `${slug}-${n}`;
    n++;
  }
  return candidate;
}

/** sc-15149: upper bound for a session key. OpenClaw keys are ~100 chars
 *  (`agent:<id>:<channel>:<…>`); the cap only stops garbage, not real keys. */
export const SESSION_KEY_MAX = 512;

/**
 * sc-15149: canonical form of an optional session key. Trimmed; empty or
 * missing → null. Rejects (throws) instead of truncating: a cut key would
 * silently file the note under a session that does not exist, and the
 * chat would never find it.
 */
export function normalizeSessionKey(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new Error("session_key must be a string");
  const key = raw.trim();
  if (!key) return null;
  if (key.length > SESSION_KEY_MAX) throw new Error(`session_key longer than ${SESSION_KEY_MAX} chars`);
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new Error("session_key contains control characters");
  return key;
}

export async function createNote(input: CreateNoteInput): Promise<NoteMeta> {
  // Validate before touching the filesystem — a bad key must not leave an
  // orphan .html behind.
  const session_key = normalizeSessionKey(input.session_key);
  const cfg = await loadConfig();
  const theme = input.theme ?? cfg.theme;
  const theme_profile: RenderProfile = input.theme_profile ?? "hosted";
  const thread_id = input.thread_id ?? slugify(input.title);
  const slugBase = slugify(input.title);

  // For inline-rendered live notes, ensure body_html has a place to
  // splice entries. If the agent didn't include the placeholder, append
  // one at the end before sanitize. The data-folio-live-feed attribute
  // is preserved by the sanitizer (data-* attrs are allowed globally).
  let bodyHtmlIn = input.body_html;
  if ((input.live ?? false) && (input.inline ?? false) && !/data-folio-live-feed/.test(bodyHtmlIn)) {
    bodyHtmlIn += `\n<section data-folio-live-feed></section>`;
  }

  // Sanitize body. The `plain` theme opts agents into full-HTML control —
  // permissive mode allows tags like <b>/<i>/<u> and all attributes that the
  // strict default list would strip, but still scrubs on*-handlers,
  // javascript: URLs, and head-y tags. The iframe sandbox + CSP remain the
  // real isolation boundary, same as for every other theme.
  const sanitizeMode = theme === "plain" ? "permissive" : "default";
  const { html: cleanBody, drops } = sanitize(bodyHtmlIn, { mode: sanitizeMode });

  // Extract text for FTS + analytics
  const stats = extractText(cleanBody);

  // Theme CSS (for standalone profile only; hosted resolves at serve time)
  const themeObj = await getTheme(theme);
  if (!themeObj) throw new Error(`Theme not found: ${theme}`);

  // ID + paths
  const id = ulid();
  const targetDir = join(threadsDir(), thread_id);
  ensureDir(targetDir);
  const slug = uniqueSlug(slugBase, targetDir);
  const filePath = join(targetDir, `${slug}.html`);
  const created = isoNow();
  const is_final = input.is_final ?? false;
  const live = input.live ?? false;
  // inline_render is meaningful only when live=true. Silently ignored on
  // non-live notes (rather than erroring) so a flag-passing agent doesn't
  // need a branch.
  const inline_render = live && (input.inline ?? false);
  // Live notes auto-expire based on inactivity, not absolute age. Set
  // expires_at to the lifespan default at creation; list_expiring uses
  // last_entry_at (NULL initially) for the actual idle check.
  const expires_at = is_final ? null : isoPlusDays(cfg.default_lifespan_days);

  // Render full HTML
  const fullHtml = renderNote({
    id,
    type: input.type,
    title: input.title,
    body_html: cleanBody,
    theme,
    theme_css: themeObj.css,
    theme_profile,
    tags: input.tags ?? [],
    thread_id,
    created,
    updated: created,
    is_final,
  });

  // Atomic write
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, fullHtml, "utf-8");
  renameSync(tmpPath, filePath);

  const relPath = relative(folioRoot(), filePath);

  // Device identity (W2): stamp origin on every note; owner only for live.
  const device = getOrCreateDeviceId();
  const origin_device_id = device.id;
  const owner_device_id = live ? device.id : null;

  // DB upsert
  const d = db();
  d.transaction(() => {
    d.run(
      `INSERT INTO notes (id, slug, path, title, type, theme, theme_profile, thread_id, is_final, created, updated, expires_at, word_count, summary, status, live, last_entry_at, origin_device_id, owner_device_id, inline_render, session_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?)`,
      [id, slug, relPath, input.title, input.type, theme, theme_profile, thread_id, is_final ? 1 : 0, created, created, expires_at, stats.word_count, stats.summary, live ? 1 : 0, origin_device_id, owner_device_id, inline_render ? 1 : 0, session_key]
    );
    for (const tag of input.tags ?? []) {
      d.run("INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)", [id, tag]);
    }
    d.run(
      "INSERT INTO notes_fts (id, title, headings, body, tags) VALUES (?, ?, ?, ?, ?)",
      [
        id,
        plNormalize(input.title),
        plNormalize(stats.headings),
        plNormalize(stats.body),
        plNormalize((input.tags ?? []).join(" ")),
      ]
    );
  })();

  logEvent(
    "note_created",
    {
      type: input.type,
      theme,
      theme_profile,
      body_size_kb: Math.round(fullHtml.length / 1024),
      plain_text_size: stats.body.length,
      word_count: stats.word_count,
      class_count: stats.class_count,
      inline_style_count: stats.inline_style_count,
      sanitizer_drops: drops,
      thread_id,
      live,
    },
    id,
    thread_id
  );

  return {
    id,
    slug,
    path: relPath,
    title: input.title,
    type: input.type,
    theme,
    theme_profile,
    thread_id,
    is_final,
    live,
    last_entry_at: null,
    created,
    updated: created,
    expires_at,
    word_count: stats.word_count,
    summary: stats.summary,
    tags: input.tags ?? [],
    origin_device_id,
    owner_device_id,
    inline_render,
    superseded_by: null,
    is_pinned: false,
    pinned_at: null,
    session_key,
  };
}

export function getNoteMeta(id: string): NoteMeta | null {
  const row = db()
    .query<Record<string, any>, [string]>(
      `SELECT * FROM notes WHERE id = ? AND status = 'active'`
    )
    .get(id);
  if (!row) return null;
  return rowToMeta(row);
}

export function getNoteBySlug(slug: string): NoteMeta | null {
  const row = db()
    .query<Record<string, any>, [string]>(
      `SELECT * FROM notes WHERE slug = ? AND status = 'active' ORDER BY created DESC LIMIT 1`
    )
    .get(slug);
  if (!row) return null;
  return rowToMeta(row);
}

export function readNoteHtml(meta: NoteMeta): string {
  return readFileSync(join(folioRoot(), meta.path), "utf-8");
}

export interface ListOptions {
  type?: NoteType;
  thread_id?: string;
  tag?: string;
  is_final?: boolean;
  /** v0.29: when true, return only pinned notes. When false/undefined,
   *  pinned float to the top of the result (see ORDER BY below). The
   *  "pinned only" filter is what the 📌 chip in the viewer's filter
   *  bar binds to. */
  is_pinned?: boolean;
  /** When true, return only non-final notes expiring within 7 days, soonest
   *  first. Pushed into SQL (not post-filtered) so it scans ALL notes — the
   *  expiring ones are the oldest, which a recency-ordered LIMIT window would
   *  otherwise exclude. Binds to the "⏱ Expiring 7d" chip. */
  expiring?: boolean;
  limit?: number;
  offset?: number;
  /** v0.22: include notes that have been replaced via the `replace` primitive.
   *  Default false — most listing surfaces (the home page, /tag, /p, thread
   *  views) want only the head version. Set true for an "all versions" view
   *  or for cloud sync (which must mirror both heads and superseded rows). */
  include_superseded?: boolean;
  /** sc-15149: only notes created in this agent chat session. Exact match
   *  on the normalized key; notes without a session never match. */
  session_key?: string;
}

export function listNotes(opts: ListOptions = {}): NoteMeta[] {
  const where: string[] = ["notes.status = 'active'"];
  const params: any[] = [];
  // Tag filter via JOIN to the indexed tags table (tags_by_tag covers it)
  const joinClause = opts.tag ? "JOIN tags ON tags.note_id = notes.id" : "";
  if (opts.tag) {
    where.push("tags.tag = ?");
    params.push(opts.tag);
  }
  if (opts.type) {
    where.push("notes.type = ?");
    params.push(opts.type);
  }
  if (opts.thread_id) {
    where.push("notes.thread_id = ?");
    params.push(opts.thread_id);
  }
  if (opts.session_key !== undefined) {
    // Normalized like on create so " key " finds "key"; an empty key would
    // mean "no filter" and dump the whole Folio — match nothing instead.
    const key = normalizeSessionKey(opts.session_key);
    where.push(key === null ? "0" : "notes.session_key = ?");
    if (key !== null) params.push(key);
  }
  if (opts.is_final !== undefined) {
    where.push("notes.is_final = ?");
    params.push(opts.is_final ? 1 : 0);
  }
  if (opts.is_pinned !== undefined) {
    where.push("notes.is_pinned = ?");
    params.push(opts.is_pinned ? 1 : 0);
  }
  if (opts.expiring) {
    where.push("notes.is_final = 0 AND notes.expires_at IS NOT NULL AND notes.expires_at < datetime('now', '+7 days')");
  }
  if (!opts.include_superseded) {
    where.push("notes.superseded_by IS NULL");
  }
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  // v0.29: float pinned to the top. Among pinned, newest-pinned first
  // (pinned_at DESC); among unpinned, newest first (created DESC).
  // Skip the pinned bias when we're scoping to a single thread — the
  // thread view is a chronological history and shouldn't reorder.
  const orderBy = opts.thread_id
    ? "notes.created DESC"
    : opts.expiring
    ? "notes.expires_at ASC"
    : "notes.is_pinned DESC, notes.pinned_at DESC, notes.created DESC";
  const sql = `SELECT notes.* FROM notes ${joinClause} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = db()
    .query<Record<string, any>, any[]>(sql)
    .all(...params, limit, offset);
  return rows.map(rowToMeta);
}

export interface SearchOptions {
  query: string;
  limit?: number;
  type?: NoteType;
  include_superseded?: boolean;
}

export function searchNotes(opts: SearchOptions): SearchHit[] {
  const limit = opts.limit ?? 20;
  const ftsQuery = escapeFtsQuery(opts.query);
  if (!ftsQuery) return [];
  // Use FTS BM25 with column weights: title 5, headings 3, body 1, tags 4
  const sql = `
    SELECT
      notes.id, notes.slug, notes.title, notes.type, notes.thread_id, notes.is_final, notes.created,
      bm25(notes_fts, 5.0, 3.0, 1.0, 4.0) AS score,
      snippet(notes_fts, 3, '<mark>', '</mark>', '…', 16) AS snippet,
      'fts' AS matched_columns
    FROM notes_fts
    JOIN notes ON notes.id = notes_fts.id
    WHERE notes_fts MATCH ?
      AND notes.status = 'active'
      ${opts.include_superseded ? "" : "AND notes.superseded_by IS NULL"}
      ${opts.type ? "AND notes.type = ?" : ""}
    ORDER BY score
    LIMIT ?
  `;
  const params: any[] = [ftsQuery];
  if (opts.type) params.push(opts.type);
  params.push(limit);
  const rows = db()
    .query<any, any[]>(sql)
    .all(...params);
  logEvent("search_query", { query_len: opts.query.length, results_count: rows.length, top_score: rows[0]?.score ?? null });
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    type: r.type as NoteType,
    thread_id: r.thread_id,
    is_final: r.is_final === 1,
    created: r.created,
    score: r.score,
    snippet: r.snippet,
    matched_columns: r.matched_columns,
  }));
}

/** Update notes.last_entry_at after a successful append. */
export function updateLastEntryAt(id: string, ts: string): void {
  db().run("UPDATE notes SET last_entry_at = ?, updated = ? WHERE id = ?", [ts, isoNow(), id]);
}

/**
 * Soft-delete a note: move file to ~/Folio/.trash/<id>/note.html, mark
 * status='trashed', remove from FTS so search doesn't return it.
 *
 * Recoverable for `trash_grace_days` (default 7) via the existing cleanup
 * flow — move file back + reindex. After that, `folio cleanup` hard-deletes
 * the DB row + files.
 *
 * ADR-014 (append-only) stance: this is a HUMAN-initiated boundary
 * crossing, same as finalize(). Agents have no MCP tool to delete —
 * iterations create new sibling notes, period. The CLI / viewer expose
 * this for the human operator.
 *
 * Sync: the sync daemon picks up status='trashed' notes via a separate
 * cursor and propagates DELETEs to the cloud relay; cloud cascades to
 * tags + live_entries. Other devices that have this note locally will
 * still see it until they too run `folio delete` (no auto-propagation
 * via pull — same scope cut as W2 finalize: cleanup is per-device).
 */
export function deleteNote(id: string): { ok: boolean; reason?: "not-found" } {
  const note = getNoteMeta(id);
  if (!note) return { ok: false, reason: "not-found" };

  const root = folioRoot();
  const absPath = join(root, note.path);
  const trashDir = join(root, ".trash", id);

  // Idempotent prep: trash dir.
  if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });

  // Move .html if present (best effort — concurrent deletes can race).
  if (existsSync(absPath)) {
    try { renameSync(absPath, join(trashDir, "note.html")); } catch {}
  }

  // Live notes have a sidecar .entries.jsonl; archive it too.
  const jsonl = absPath.replace(/\.html$/, ".entries.jsonl");
  if (existsSync(jsonl)) {
    try { renameSync(jsonl, join(trashDir, "entries.jsonl")); } catch {}
  }

  const d = db();
  d.transaction(() => {
    d.run("UPDATE notes SET status = 'trashed', updated = ? WHERE id = ?", [isoNow(), id]);
    d.run("DELETE FROM notes_fts WHERE id = ?", [id]);
  })();

  logEvent("note_deleted", { reason: "manual", thread_id: note.thread_id }, id, note.thread_id);
  return { ok: true };
}

/**
 * Editable metadata fields for an existing note (v0.22+). Body stays
 * immutable — that's ADR-014. The fields here are presentation-level only:
 * title (rendered into <title> + <h1>-adjacent metadata), tags (rendered
 * into <meta name="folio:tags">), theme (drives the <link rel="stylesheet">
 * + theme.css resolution), is_final (the keep-from-cleanup flag).
 *
 * Why these and not body: each of these is something the user could see
 * during a typical "polish" pass without rewriting the content. Editing
 * title/tags/theme doesn't violate the "capability URL trust" contract —
 * a recipient seeing /n/<id> still sees the same prose, just possibly with
 * a different chrome/title.
 */
export interface UpdateMetadataInput {
  id: string;
  title?: string;
  tags?: string[];
  theme?: string;
  is_final?: boolean;
  /** v0.29: toggle pinned-to-top. true sets is_pinned=1 + pinned_at=now();
   *  false sets is_pinned=0 + pinned_at=NULL. No body rewrite needed —
   *  pin state isn't rendered into the .html file (it's only a listing/UI
   *  signal), so this never touches disk. */
  is_pinned?: boolean;
}

export interface UpdateMetadataResult {
  ok: boolean;
  reason?: "not-found" | "no-change" | "unknown-theme";
  updated_fields?: Array<"title" | "tags" | "theme" | "is_final" | "is_pinned">;
  meta?: NoteMeta;
}

/**
 * Update title/tags/theme/is_final on an existing note. Body is preserved
 * verbatim (extracted from the on-disk HTML, then re-injected through
 * renderNote with the new metadata). HTML file is rewritten atomically.
 *
 * `is_final` flip routes through the existing finalize/unfinalize paths
 * when relevant (live notes get their entries compiled into body, iteration
 * notes get round freezing) — those are not cheap metadata edits and we
 * want to keep one canonical place for that logic.
 *
 * Returns `{ok:false, reason}` for missing note, unknown theme, or a fully
 * no-op call. Otherwise `{ok:true, updated_fields, meta}` with the fresh
 * meta row reflecting the change.
 */
export async function updateNoteMetadata(input: UpdateMetadataInput): Promise<UpdateMetadataResult> {
  const note = getNoteMeta(input.id);
  if (!note) return { ok: false, reason: "not-found" };

  const wantsTitle = typeof input.title === "string" && input.title.trim() !== "" && input.title !== note.title;
  const wantsTags = Array.isArray(input.tags) && !sameStringSet(input.tags, note.tags);
  const wantsTheme = typeof input.theme === "string" && input.theme !== note.theme;
  const wantsFinal = typeof input.is_final === "boolean" && input.is_final !== note.is_final;
  const wantsPinned = typeof input.is_pinned === "boolean" && input.is_pinned !== note.is_pinned;

  if (!wantsTitle && !wantsTags && !wantsTheme && !wantsFinal && !wantsPinned) {
    return { ok: false, reason: "no-change" };
  }

  // Pin flip is cheap: just an UPDATE on is_pinned + pinned_at. No body
  // rewrite (pin state isn't rendered into the .html), no finalize
  // machinery. Handle it before the rest so the post-update meta reflects
  // the pin state. Pin-only updates skip the file rewrite path entirely.
  if (wantsPinned) {
    const pinnedAt = input.is_pinned ? isoNow() : null;
    db().run(
      "UPDATE notes SET is_pinned = ?, pinned_at = ?, updated = ? WHERE id = ?",
      [input.is_pinned ? 1 : 0, pinnedAt, isoNow(), input.id],
    );
  }

  // Pin-only fast path: nothing else to do — no file rewrite, no FTS
  // update, no tag rewrite. Log + return.
  if (wantsPinned && !wantsTitle && !wantsTags && !wantsTheme && !wantsFinal) {
    const fresh = getNoteMeta(input.id)!;
    logEvent(
      "note_metadata_updated",
      { thread_id: fresh.thread_id, changed: ["is_pinned"], from: { is_pinned: note.is_pinned }, to: { is_pinned: fresh.is_pinned } },
      fresh.id,
      fresh.thread_id,
    );
    return { ok: true, updated_fields: ["is_pinned"], meta: fresh };
  }

  // is_final flip uses the finalize/unfinalize machinery — handle it first
  // so the rest of the update operates on the post-finalize meta state
  // (live → compiled-into-body, iteration → rounds frozen).
  if (wantsFinal) {
    if (input.is_final) finalize(input.id);
    else await unfinalize(input.id);
  }

  // Re-read meta after the finalize/unfinalize side effect.
  const fresh = getNoteMeta(input.id)!;
  const newTitle = wantsTitle ? input.title!.trim() : fresh.title;
  const newTags = wantsTags ? (input.tags as string[]).map((t) => String(t).trim()).filter(Boolean) : fresh.tags;
  const newTheme = wantsTheme ? input.theme! : fresh.theme;

  if (wantsTheme) {
    const themeObj = await getTheme(newTheme);
    if (!themeObj) return { ok: false, reason: "unknown-theme" };
  }

  const absPath = join(folioRoot(), fresh.path);
  const fullHtml = readFileSync(absPath, "utf-8");
  const body = extractBodyHtml(fullHtml);
  const updated = isoNow();
  const themeObj = (await getTheme(newTheme))!;

  const regenerated = renderNote({
    id: fresh.id,
    type: fresh.type,
    title: newTitle,
    body_html: body,
    theme: newTheme,
    theme_css: themeObj.css,
    theme_profile: fresh.theme_profile,
    tags: newTags,
    thread_id: fresh.thread_id,
    created: fresh.created,
    updated,
    is_final: fresh.is_final,
  });

  const tmpPath = `${absPath}.tmp`;
  writeFileSync(tmpPath, regenerated, "utf-8");
  renameSync(tmpPath, absPath);

  const stats = extractText(body);
  const d = db();
  d.transaction(() => {
    d.run(
      "UPDATE notes SET title = ?, theme = ?, updated = ?, word_count = ?, summary = ? WHERE id = ?",
      [newTitle, newTheme, updated, stats.word_count, stats.summary, fresh.id],
    );
    if (wantsTags) {
      d.run("DELETE FROM tags WHERE note_id = ?", [fresh.id]);
      for (const tag of newTags) {
        d.run("INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)", [fresh.id, tag]);
      }
    }
    d.run(
      "UPDATE notes_fts SET title = ?, headings = ?, body = ?, tags = ? WHERE id = ?",
      [
        plNormalize(newTitle),
        plNormalize(stats.headings),
        plNormalize(stats.body),
        plNormalize(newTags.join(" ")),
        fresh.id,
      ],
    );
  })();

  const changed: Array<"title" | "tags" | "theme" | "is_final" | "is_pinned"> = [];
  if (wantsTitle) changed.push("title");
  if (wantsTags) changed.push("tags");
  if (wantsTheme) changed.push("theme");
  if (wantsFinal) changed.push("is_final");
  if (wantsPinned) changed.push("is_pinned");

  const finalMeta = getNoteMeta(fresh.id)!;
  logEvent(
    "note_metadata_updated",
    {
      thread_id: fresh.thread_id,
      changed,
      from: { title: note.title, theme: note.theme, tags: note.tags, is_final: note.is_final, is_pinned: note.is_pinned },
      to: { title: newTitle, theme: newTheme, tags: newTags, is_final: fresh.is_final, is_pinned: finalMeta.is_pinned },
    },
    fresh.id,
    fresh.thread_id,
  );

  return { ok: true, updated_fields: changed, meta: finalMeta };
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Replace a note's body in-place — except not really (per ADR-014, body
 * files stay immutable). The actual mechanic:
 *   1. createNote() a new note in the same thread with the new body. The
 *      new note gets its own ULID, its own .html file, its own capability
 *      URL. Inherits type / theme / tags / title from the old note unless
 *      overridden.
 *   2. UPDATE the OLD note's `superseded_by` to point at the new id. The
 *      old .html file stays on disk verbatim — any /n/<old-id> link
 *      already shared keeps showing the old content.
 *   3. The viewer hides superseded notes from thread listings, tag pages,
 *      search results, and the main list. Visiting the old URL directly
 *      shows a "this version was replaced by [new title]" banner.
 *
 * Use this when the user says "fix this" / "polish it" / "different
 * version" for the kinds of notes where the old draft is noise (snippet,
 * comparison, research). Don't use for iteration / technical notes where
 * variant history is part of the value — for those, the create-new-in-same-
 * thread pattern is still the right answer.
 */
export interface ReplaceNoteInput {
  /** Note id to supersede. */
  old_id: string;
  /** New body HTML. Sanitized exactly like createNote — and inherits the
   *  theme's permissive/strict choice from the resolved theme. */
  body_html: string;
  /** Override title. Default: inherit from old note. */
  title?: string;
  /** Override tags. Default: inherit from old note. */
  tags?: string[];
  /** Override theme. Default: inherit from old note. */
  theme?: string;
}

export interface ReplaceNoteResult {
  ok: boolean;
  reason?: "not-found" | "already-superseded";
  new_meta?: NoteMeta;
  old_id?: string;
}

export async function replaceNote(input: ReplaceNoteInput): Promise<ReplaceNoteResult> {
  const old = getNoteMeta(input.old_id);
  if (!old) return { ok: false, reason: "not-found" };
  if (old.superseded_by != null) {
    return { ok: false, reason: "already-superseded" };
  }

  // createNote handles sanitize, file write, db insert, FTS index. We
  // inherit by default so callers don't have to re-pass every field.
  const newMeta = await createNote({
    type: old.type,
    title: input.title ?? old.title,
    body_html: input.body_html,
    theme: input.theme ?? old.theme,
    theme_profile: old.theme_profile,
    thread_id: old.thread_id,
    tags: input.tags ?? old.tags,
    // sc-15149: a revision belongs to the same chat as the draft it replaces.
    session_key: old.session_key ?? undefined,
  });

  // Mark old as superseded. Atomic — old.html stays on disk untouched
  // (immutable contract holds), only the metadata row gains the pointer.
  // Carry the pin forward: if the old note was pinned, the new head
  // inherits is_pinned + pinned_at, and the old row loses the pin (so it
  // doesn't double-count in the 📌 filter — superseded rows are hidden
  // anyway but this keeps the data consistent).
  const d = db();
  d.transaction(() => {
    d.run(
      "UPDATE notes SET superseded_by = ?, updated = ?, is_pinned = 0, pinned_at = NULL WHERE id = ?",
      [newMeta.id, isoNow(), input.old_id],
    );
    if (old.is_pinned) {
      d.run(
        "UPDATE notes SET is_pinned = 1, pinned_at = ? WHERE id = ?",
        [old.pinned_at ?? isoNow(), newMeta.id],
      );
    }
  })();

  logEvent(
    "note_superseded",
    {
      thread_id: old.thread_id,
      type: old.type,
      replaced_with: newMeta.id,
      old_title: old.title,
      new_title: newMeta.title,
    },
    input.old_id,
    old.thread_id,
  );

  return { ok: true, new_meta: newMeta, old_id: input.old_id };
}

/**
 * Walk the supersede chain forward from a note until we reach a head
 * (superseded_by IS NULL) or the chain breaks. Used by the viewer when
 * showing the "this was replaced by..." banner on an old URL — we want
 * to point at the CURRENT head, not an intermediate that's also been
 * superseded.
 */
export function resolveHeadOfChain(id: string, maxHops = 10): NoteMeta | null {
  let cur: NoteMeta | null = getNoteMeta(id);
  let hops = 0;
  while (cur && cur.superseded_by && hops < maxHops) {
    const next: NoteMeta | null = getNoteMeta(cur.superseded_by);
    if (!next) break;
    cur = next;
    hops += 1;
  }
  return cur;
}

/**
 * Return the full revision chain a note belongs to, oldest → newest (the
 * current head is last). Walks forward to the head via resolveHeadOfChain,
 * then walks BACKWARD — the predecessor of a note is whoever's superseded_by
 * points at it — collecting every revision. A note that was never replaced
 * (and is no one's replacement) yields a single-element chain: itself.
 *
 * This is the document's append-only log under C-minimal: each entry is an
 * immutable note with its own .html + capability URL; `replace` appends a new
 * head. maxHops guards against a cycle in corrupt data. Backed by the
 * notes_by_superseded index for the reverse lookup.
 */
export function getRevisionChain(id: string, maxHops = 100): NoteMeta[] {
  const head = resolveHeadOfChain(id);
  if (!head) return [];
  const chain: NoteMeta[] = [head];
  let cur: NoteMeta = head;
  let hops = 0;
  while (hops < maxHops) {
    const predRow = db()
      .query<{ id: string }, [string]>(
        `SELECT id FROM notes WHERE superseded_by = ? AND status = 'active' LIMIT 1`
      )
      .get(cur.id);
    if (!predRow) break;
    const pred = getNoteMeta(predRow.id);
    if (!pred) break;
    chain.push(pred);
    cur = pred;
    hops += 1;
  }
  return chain.reverse();
}

/**
 * Reverse finalize: re-arm auto-cleanup countdown on a note. Used by both
 * the MCP `unfinalize` tool and `updateNoteMetadata` when is_final flips
 * from true to false. Idempotent — calling on an already-non-final note
 * is a no-op that returns false.
 */
export async function unfinalize(id: string): Promise<boolean> {
  const note = getNoteMeta(id);
  if (!note || !note.is_final) return false;
  const cfg = await loadConfig();
  db().run(
    "UPDATE notes SET is_final = 0, expires_at = datetime(?, '+' || ? || ' days'), updated = ? WHERE id = ?",
    [note.created, cfg.default_lifespan_days, isoNow(), id],
  );
  logEvent("note_unfinalized", { thread_id: note.thread_id, via: "storage" }, id, note.thread_id);
  return true;
}

export function finalize(id: string): boolean {
  const note = getNoteMeta(id);
  if (!note) return false;
  // Idempotent: re-finalize is a no-op (also covers race conditions where
  // two callers attempt finalize simultaneously).
  if (note.is_final) return true;

  const ageDays = Math.floor((Date.now() - new Date(note.created).getTime()) / 86400000);

  // Dispatch the "compile feed → static body" step by substrate. strategyOf
  // checks live before type (matching this function's historical order), so
  // a live note routes to finalizeLive and a non-live iteration note to
  // finalizeIteration. document notes need no compile step.
  const strategy = strategyOf(note);
  if (strategy === "feed") {
    finalizeLive(note);
  } else if (strategy === "iteration") {
    finalizeIteration(note);
  }

  db().run(
    "UPDATE notes SET is_final = 1, live = 0, expires_at = NULL, updated = ? WHERE id = ?",
    [isoNow(), id],
  );
  logEvent(
    "note_finalized",
    { age_days_at_finalize: ageDays, was_live: note.live, was_iteration: note.type === "iteration" },
    id,
    note.thread_id,
  );
  return true;
}

/**
 * Live-note finalize: read the .entries.jsonl sidecar, compile to
 * <article class="entry [state-*]">…</article> blocks, replace the note's
 * <article data-folio-content>…</article> body inline, atomic-rename
 * temp file over the .html. Move the jsonl to ~/Folio/.trash/ so it's
 * archived but no longer streamed.
 *
 * Per ADR-014: this is the explicit boundary where in-place mutation
 * of a note's .html is allowed. finalize = "freeze the live feed into
 * the static body and stop being live."
 *
 * Per ADR-017: emits a `note_finalized_live` event with entries_compiled
 * count + summed sanitizer_drops from the original append events
 * (already counted; we don't re-emit per entry).
 *
 * No content re-sanitization: each entry.content_html was sanitized on
 * append_entry. The wrapper HTML we generate here is server-trusted —
 * adding a second sanitize pass would risk mangling already-valid
 * content for no security gain.
 */
function finalizeLive(note: NoteMeta): void {
  const { entriesPath, readEntries, compileRendered } = require("./live") as typeof import("./live");
  const absPath = join(folioRoot(), note.path);
  const jsonl = entriesPath(absPath);
  const rawEntries = readEntries(jsonl);
  const compiled = compileRendered(rawEntries);
  const totalEntries = rawEntries.length;
  const renderedCount = compiled.length;

  // Build the compiled body. Each entry becomes:
  //   <article class="entry [state-*] [pinned]" data-entry-id="…">
  //     <header class="meta">…tags + time…</header>
  //     <div class="content">{content_html — already sanitized}</div>
  //   </article>
  // entries-css.ts ships the baseline; themes can override.
  // Pinned entries float to the top in a <section class="entries-pinned">.
  const pinned = compiled.filter((c) => c.pinned);
  const rest = compiled.filter((c) => !c.pinned);

  const renderTag = (t: string): string => {
    const safe = String(t).replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch] ?? ch);
    return `<span class="pill info">${safe}</span>`;
  };

  const renderEntry = (c: typeof compiled[number]): string => {
    const cls = ["entry"];
    if (c.pinned) cls.push("pinned");
    if (c.state) cls.push(`state-${c.state}`);
    const tagsHtml = c.compiled_tags.map(renderTag).join(" ");
    const timeHtml = `<time datetime="${c.ts}">${c.ts}</time>`;
    return [
      `<article class="${cls.join(" ")}" data-entry-id="${c.id}">`,
      `  <header class="meta">${timeHtml} ${tagsHtml}</header>`,
      `  <div class="content">${c.content_html}</div>`,
      `</article>`,
    ].join("\n");
  };

  const pinnedHtml = pinned.length > 0
    ? `<section class="entries-pinned"><h3>Pinned</h3>\n${pinned.map(renderEntry).join("\n")}\n</section>`
    : "";
  const restHtml = rest.length > 0
    ? `<section class="entries-feed">\n${rest.map(renderEntry).join("\n")}\n</section>`
    : "";
  const compiledBody = [pinnedHtml, restHtml].filter(Boolean).join("\n");

  // Replace <article data-folio-content>…</article> inline. The _base.html.eta
  // emits exactly one such block per note (the user's body wrapped).
  const existing = readFileSync(absPath, "utf-8");
  const replaced = existing.replace(
    /(<article[^>]*data-folio-content[^>]*>)[\s\S]*?(<\/article>)/,
    `$1\n${compiledBody}\n$2`,
  );
  const tmpPath = `${absPath}.tmp`;
  writeFileSync(tmpPath, replaced, "utf-8");
  renameSync(tmpPath, absPath);

  // Move the jsonl to .trash/. Use a name that includes the note id so
  // multiple finalized notes don't collide.
  if (existsSync(jsonl)) {
    const trashDir = join(folioRoot(), ".trash");
    ensureDir(trashDir);
    const trashPath = join(trashDir, `${note.id}.entries.jsonl`);
    renameSync(jsonl, trashPath);
  }

  logEvent(
    "note_finalized_live",
    {
      entries_total: totalEntries,
      entries_rendered: renderedCount,
      pinned_count: pinned.length,
    },
    note.id,
    note.thread_id,
  );
}

/**
 * Iteration finalize (v0.18+): collapse the design-iteration tree into a
 * static artifact. The compiled body shows:
 *   1. The final picked variant's content as the "Final design" (full,
 *      not sandboxed — content was sanitized at append_entry time, and
 *      the wrapping HTML we add is server-trusted).
 *   2. An "Iteration history" section listing every round's pick in
 *      order, each with its label + round number, so the artifact
 *      records HOW the final design was reached without dragging in all
 *      the discarded variants.
 *
 * If no pick exists yet (open round abandoned, or no rounds at all), we
 * write a "no design selected" placeholder rather than erroring — same
 * permissive stance as finalizeLive on an entries-less note.
 *
 * The JSONL is moved to .trash/ — same archival pattern as live notes.
 * Discarded sibling variants live there if a future tool needs them.
 */
function finalizeIteration(note: NoteMeta): void {
  const { entriesPath, readEntries } = require("./live") as typeof import("./live");
  const { computeIterationState } = require("./iteration") as typeof import("./iteration");
  const absPath = join(folioRoot(), note.path);
  const jsonl = entriesPath(absPath);
  const rawEntries = existsSync(jsonl) ? readEntries(jsonl) : [];
  const state = computeIterationState(note.id, rawEntries, false);

  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const lineage = state.lineage;
  const finalPick = lineage.length > 0 ? lineage[lineage.length - 1]! : null;

  const finalDesignHtml = finalPick
    ? `<section class="iter-final">
  <header class="iter-final__head"><span class="eyebrow">Final design · Round ${finalPick.round}${finalPick.label ? ` · ${esc(finalPick.label)}` : ""}</span></header>
  <div class="iter-final__content">${finalPick.content_html}</div>
</section>`
    : `<section class="iter-final iter-final--empty">
  <p class="lead">No design was selected — this iteration was abandoned before a final pick.</p>
</section>`;

  const historyHtml = lineage.length > 0
    ? `<section class="iter-history">
  <h2>Iteration history</h2>
  <ol class="iter-history__list">
${lineage.map((v) => `    <li><strong>Round ${v.round}</strong>${v.label ? ` · ${esc(v.label)}` : ""}</li>`).join("\n")}
  </ol>
  <p class="iter-history__note">${lineage.length} round${lineage.length === 1 ? "" : "s"}, ${state.rounds.length} total batch${state.rounds.length === 1 ? "" : "es"} considered. Discarded variants archived to <code>.trash/</code>.</p>
</section>`
    : "";

  const compiledBody = [finalDesignHtml, historyHtml].filter(Boolean).join("\n");

  const existing = readFileSync(absPath, "utf-8");
  // Preserve the agent's chrome (whatever was in body_html at create time)
  // and append the compiled final + history. The original chrome usually
  // has a title/intro that's still relevant on the static artifact.
  const replaced = existing.replace(
    /(<article[^>]*data-folio-content[^>]*>)([\s\S]*?)(<\/article>)/,
    (_m, open, chrome, close) => `${open}${chrome}\n${compiledBody}\n${close}`,
  );
  const tmpPath = `${absPath}.tmp`;
  writeFileSync(tmpPath, replaced, "utf-8");
  renameSync(tmpPath, absPath);

  // Archive the JSONL so discarded variants are recoverable.
  if (existsSync(jsonl)) {
    const trashDir = join(folioRoot(), ".trash");
    ensureDir(trashDir);
    const trashPath = join(trashDir, `${note.id}.entries.jsonl`);
    renameSync(jsonl, trashPath);
  }

  logEvent(
    "note_finalized_iteration",
    {
      rounds_total: state.rounds.length,
      picks_made: lineage.length,
      had_final_pick: finalPick !== null,
    },
    note.id,
    note.thread_id,
  );
}

export interface ReindexResult {
  ok: number;
  failed: Array<{ id: string; error: string }>;
}

/**
 * Rebuild FTS index for all active notes from their HTML files on disk.
 * Use after tokenizer or normalization changes.
 */
export async function reindexAll(): Promise<ReindexResult> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const d = db();
  let ok = 0;
  const failed: ReindexResult["failed"] = [];

  const notes = d
    .query<{ id: string; path: string; title: string }, []>(
      "SELECT id, path, title FROM notes WHERE status = 'active'"
    )
    .all();

  for (const n of notes) {
    try {
      const html = readFileSync(join(folioRoot(), n.path), "utf-8");
      const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
      const bodySrc = articleMatch ? articleMatch[1] : html;
      const stats = extractText(bodySrc);
      const tags = d
        .query<{ tag: string }, [string]>("SELECT tag FROM tags WHERE note_id = ? ORDER BY tag")
        .all(n.id)
        .map((r) => r.tag);
      d.transaction(() => {
        d.run("DELETE FROM notes_fts WHERE id = ?", [n.id]);
        d.run(
          "INSERT INTO notes_fts (id, title, headings, body, tags) VALUES (?, ?, ?, ?, ?)",
          [
            n.id,
            plNormalize(n.title),
            plNormalize(stats.headings),
            plNormalize(stats.body),
            plNormalize(tags.join(" ")),
          ]
        );
        d.run("UPDATE notes SET word_count = ?, summary = ? WHERE id = ?", [
          stats.word_count,
          stats.summary,
          n.id,
        ]);
      })();
      ok++;
    } catch (e: any) {
      failed.push({ id: n.id, error: e?.message ?? String(e) });
    }
  }

  return { ok, failed };
}

export interface CleanupResult {
  trashed: Array<{ id: string; title: string; path: string; age_days: number }>;
  hard_deleted: Array<{ id: string; path: string }>;
  dry_run: boolean;
}

/**
 * Phase 1: non-final notes past `expires_at` → move to ~/Folio/.trash/<id>/.
 * Phase 2: trash entries older than `trash_grace_days` → unlink files (and remove DB row).
 *
 * Returns counts and what was moved/deleted. `dry_run` skips filesystem changes
 * but still reports what would happen.
 */
export async function cleanup(opts: { dry_run?: boolean; trash_grace_days?: number } = {}): Promise<CleanupResult> {
  const { existsSync, mkdirSync, renameSync, unlinkSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = folioRoot();
  const trashRoot = join(root, ".trash");
  const dry = opts.dry_run ?? false;
  const trash_grace_days = opts.trash_grace_days ?? 7;

  const d = db();
  const trashed: CleanupResult["trashed"] = [];
  const hard_deleted: CleanupResult["hard_deleted"] = [];

  // Phase 1
  const expired = d
    .query<{ id: string; title: string; path: string; created: string }, []>(
      `SELECT id, title, path, created FROM notes
       WHERE status = 'active' AND is_final = 0 AND expires_at IS NOT NULL
         AND expires_at < datetime('now')`
    )
    .all();

  for (const row of expired) {
    const ageDays = Math.floor((Date.now() - new Date(row.created).getTime()) / 86400000);
    trashed.push({ id: row.id, title: row.title, path: row.path, age_days: ageDays });
    if (dry) continue;
    const fullPath = join(root, row.path);
    if (existsSync(fullPath)) {
      const trashDir = join(trashRoot, row.id);
      mkdirSync(trashDir, { recursive: true });
      try {
        renameSync(fullPath, join(trashDir, "note.html"));
      } catch {
        // best-effort
      }
    }
    d.run("UPDATE notes SET status = 'trashed', updated = ? WHERE id = ?", [new Date().toISOString(), row.id]);
    logEvent("note_deleted", { reason: "auto", age_days: ageDays }, row.id);
  }

  // Phase 2: hard delete trash older than grace
  // Find DB rows in 'trashed' status updated > N days ago
  const stale = d
    .query<{ id: string; path: string }, [number]>(
      `SELECT id, path FROM notes
       WHERE status = 'trashed' AND updated < datetime('now', '-' || ? || ' days')`
    )
    .all(trash_grace_days);
  for (const row of stale) {
    hard_deleted.push({ id: row.id, path: row.path });
    if (dry) continue;
    const trashFile = join(trashRoot, row.id);
    try { rmSync(trashFile, { recursive: true, force: true }); } catch {}
    d.run("DELETE FROM notes WHERE id = ?", [row.id]); // FK cascade removes tags
    d.run("DELETE FROM notes_fts WHERE id = ?", [row.id]);
  }

  return { trashed, hard_deleted, dry_run: dry };
}

export function listThreads(query?: string, limit = 200): { thread_id: string; count: number; latest: string; final_count: number }[] {
  // v0.22: thread index counts/latest reflect only head notes (superseded
  // versions hide from the listing — a 3-note thread that's been collapsed
  // via `replace` shows as a 1-note thread, which is what the user expects).
  if (!query?.trim()) {
    return db()
      .query<{ thread_id: string; count: number; latest: string; final_count: number }, [number]>(
        `SELECT thread_id, COUNT(*) AS count, MAX(created) AS latest, SUM(is_final) AS final_count
         FROM notes WHERE status = 'active' AND superseded_by IS NULL
         GROUP BY thread_id ORDER BY latest DESC LIMIT ?`
      )
      .all(limit);
  }
  // Match against either thread_id (slug substring) OR any note title in the thread (FTS).
  const norm = plNormalize(query).toLowerCase().trim();
  const ftsQuery = escapeFtsQuery(query);
  const slugLike = `%${norm.replace(/\s+/g, "%")}%`;
  if (!ftsQuery) {
    return db()
      .query<{ thread_id: string; count: number; latest: string; final_count: number }, [string, number]>(
        `SELECT thread_id, COUNT(*) AS count, MAX(created) AS latest, SUM(is_final) AS final_count
         FROM notes WHERE status = 'active' AND superseded_by IS NULL AND lower(thread_id) LIKE ?
         GROUP BY thread_id ORDER BY latest DESC LIMIT ?`
      )
      .all(slugLike, limit);
  }
  // Threads where slug matches OR any note title matches FTS.
  const scoped = ftsQuery.split(" ").map((t) => `title:${t}`).join(" ");
  return db()
    .query<{ thread_id: string; count: number; latest: string; final_count: number }, [string, string, number]>(
      `WITH matched_ids AS (
         SELECT id FROM notes_fts WHERE notes_fts MATCH ?
       )
       SELECT n.thread_id,
              COUNT(*) AS count,
              MAX(n.created) AS latest,
              SUM(n.is_final) AS final_count
       FROM notes n
       WHERE n.status = 'active' AND n.superseded_by IS NULL
         AND (lower(n.thread_id) LIKE ? OR n.thread_id IN (
             SELECT DISTINCT n2.thread_id FROM notes n2 JOIN matched_ids m ON m.id = n2.id
                WHERE n2.status = 'active' AND n2.superseded_by IS NULL
         ))
       GROUP BY n.thread_id
       ORDER BY latest DESC
       LIMIT ?`
    )
    .all(scoped, slugLike, limit);
}

/**
 * v0.23 — "Continue where you left off" data.
 *
 * Score per thread = sum of decayed weights for every touch in the window:
 *   weight(touch) = 1 / (days_since_touch + 1)
 * so a touch today scores 1.0, yesterday 0.5, six days ago ~0.14. Multiple
 * touches accumulate. The thread surfaces with whichever (recency × frequency)
 * mix the user actually generated — no manual pinning, no ML.
 *
 * Touches we count: note_created (write), note_finalized (decision),
 * live_entry_appended (continuous work on a feed), note_viewed (user
 * actually opened the note in the viewer). View tracking is debounced
 * 30 min per (note × day) so refreshing a tab doesn't game the score —
 * see logNoteView() below.
 *
 * Per-thread enrichment after scoring: latest head note (title + id),
 * project slug if any note in the thread carries a project:<slug> tag,
 * and a pending-iteration flag (any non-finalized iteration note in the
 * thread). The rail click target uses these — project → /p/<slug>,
 * pending iteration → /n/<latest-iteration-id>, otherwise /n/<latest>.
 */
export type ContinueRailKind = "project" | "thread";

export interface ContinueRailItem {
  /** v0.28 — distinguishes a project aggregate (multiple threads under one
   *  project:<slug> tag collapsed into one tile) from a standalone thread
   *  with no project tag. The renderer picks the click target + meta line
   *  based on kind. */
  kind: ContinueRailKind;
  /** For kind="thread": the actual thread_id. For kind="project": the
   *  latest member thread_id (kept for analytics + back-compat with code
   *  that grouped by this). */
  thread_id: string;
  /** Latest head note id across the thread (or across all project members
   *  for a project tile). Used as fallback link when project_slug is null
   *  and there's no pending iteration. */
  latest_note_id: string;
  /** Display title — head note's title for thread items, project slug for
   *  project items. */
  title: string;
  /** Non-null only when this tile represents a project. */
  project_slug: string | null;
  /** v0.28 — count of threads collapsed into this tile (1 for thread
   *  items; >=1 for project items, can be 1 if the project has only one
   *  active thread). */
  member_thread_count: number;
  touch_count: number;
  score: number;
  last_touch: string;
  has_pending_iteration: boolean;
  pending_iteration_id: string | null;
}

const RAIL_EVENT_KINDS = ["note_created", "note_viewed", "note_finalized", "live_entry_appended"] as const;

export function listContinueRail(opts?: { limit?: number; window_days?: number }): ContinueRailItem[] {
  const limit = Math.max(1, Math.min(20, opts?.limit ?? 5));
  const windowDays = Math.max(1, Math.min(60, opts?.window_days ?? 7));
  const d = db();

  // v0.28 — over-fetch so we have enough scored threads to collapse by
  // project before trimming to the final limit. Cap at 40 — any larger
  // and the per-thread enrichment cost adds up.
  const overFetch = Math.min(40, Math.max(limit, limit * 4));

  // Step 1 — score every thread that received a tracked event in the window.
  // INNER JOIN to notes keeps the score limited to threads with at least one
  // surviving head note (drops fully-deleted or fully-superseded threads).
  const scored = d
    .query<{ thread_id: string; touches_7d: number; last_touch: string; score: number }, [string, number]>(
      `WITH window_events AS (
         SELECT e.thread_id, e.ts, e.kind
         FROM events e
         WHERE e.ts > datetime('now', ?)
           AND e.kind IN ('note_created', 'note_viewed', 'note_finalized', 'live_entry_appended')
           AND e.thread_id IS NOT NULL
       )
       SELECT we.thread_id,
              COUNT(*) AS touches_7d,
              MAX(we.ts) AS last_touch,
              SUM(1.0 / (julianday('now') - julianday(we.ts) + 1)) AS score
       FROM window_events we
       WHERE EXISTS (
         SELECT 1 FROM notes n
         WHERE n.thread_id = we.thread_id
           AND n.status = 'active'
           AND n.superseded_by IS NULL
       )
       GROUP BY we.thread_id
       ORDER BY score DESC
       LIMIT ?`,
    )
    .all(`-${windowDays} days`, overFetch);

  if (scored.length === 0) return [];

  // Step 2 — per-thread enrichment. One query each; total ≤ overFetch threads.
  const enriched = scored.map((t): ContinueRailItem => {
    const latest = d
      .query<{ id: string; title: string }, [string]>(
        `SELECT id, title FROM notes
         WHERE thread_id = ? AND status = 'active' AND superseded_by IS NULL
         ORDER BY created DESC LIMIT 1`,
      )
      .get(t.thread_id);
    const projectRow = d
      .query<{ tag: string }, [string]>(
        `SELECT tt.tag FROM tags tt
         JOIN notes n ON n.id = tt.note_id
         WHERE n.thread_id = ? AND n.status = 'active' AND n.superseded_by IS NULL
           AND tt.tag LIKE 'project:%'
         ORDER BY n.created DESC LIMIT 1`,
      )
      .get(t.thread_id);
    const pendingIter = d
      .query<{ id: string }, [string]>(
        `SELECT id FROM notes
         WHERE thread_id = ? AND type = 'iteration' AND is_final = 0
           AND status = 'active' AND superseded_by IS NULL
         ORDER BY created DESC LIMIT 1`,
      )
      .get(t.thread_id);
    return {
      kind: "thread",
      thread_id: t.thread_id,
      latest_note_id: latest?.id ?? "",
      title: latest?.title ?? t.thread_id,
      project_slug: projectRow ? projectRow.tag.slice("project:".length) : null,
      member_thread_count: 1,
      touch_count: t.touches_7d,
      score: t.score,
      last_touch: t.last_touch,
      has_pending_iteration: pendingIter != null,
      pending_iteration_id: pendingIter?.id ?? null,
    };
  });

  // Step 3 — collapse threads sharing the same project:<slug> into one
  // "project" tile. A project with one active thread still becomes a
  // project tile (single visual style for project work; click routes to
  // /p/<slug> regardless of underlying thread count). Threads without a
  // project tag stay as standalone "thread" items.
  const byProject = new Map<string, ContinueRailItem[]>();
  const standalone: ContinueRailItem[] = [];
  for (const item of enriched) {
    if (item.project_slug) {
      const arr = byProject.get(item.project_slug) ?? [];
      arr.push(item);
      byProject.set(item.project_slug, arr);
    } else {
      standalone.push(item);
    }
  }

  const collapsed: ContinueRailItem[] = [];
  for (const [slug, items] of byProject.entries()) {
    // Sort members so we can pick the freshest underlying thread as the
    // canonical "latest" for the tile.
    items.sort((a, b) => b.last_touch.localeCompare(a.last_touch));
    const top = items[0]!;
    const totalScore = items.reduce((acc, i) => acc + i.score, 0);
    const totalTouches = items.reduce((acc, i) => acc + i.touch_count, 0);
    const pending = items.find((i) => i.has_pending_iteration) ?? null;
    collapsed.push({
      kind: "project",
      thread_id: top.thread_id,
      latest_note_id: top.latest_note_id,
      title: slug,
      project_slug: slug,
      member_thread_count: items.length,
      touch_count: totalTouches,
      score: totalScore,
      last_touch: top.last_touch,
      has_pending_iteration: pending != null,
      pending_iteration_id: pending?.pending_iteration_id ?? null,
    });
  }

  // Step 4 — interleave + sort by score DESC; trim to final limit.
  const merged = [...collapsed, ...standalone];
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

/**
 * Debounced view tracker. Called by the /n/:id viewer route. Logs a
 * `note_viewed` event for the rail score, but at most once per
 * (note × 30-minute window) — a user refreshing a tab three times in
 * five minutes counts as one touch, not three. The debounce window is
 * checked against the events table itself so we don't need a separate
 * cache (and it's correct across server restarts).
 *
 * Cheap: one SELECT + maybe one INSERT per page view.
 */
export function logNoteView(noteId: string, threadId: string): void {
  const recentRow = db()
    .query<{ ts: string }, [string]>(
      `SELECT ts FROM events
       WHERE note_id = ? AND kind = 'note_viewed'
         AND ts > datetime('now', '-30 minutes')
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(noteId);
  if (recentRow) return; // debounced — already counted within the last 30 min
  logEvent("note_viewed", { thread_id: threadId, via: "viewer" }, noteId, threadId);
}

export function suggestThread(title: string, limit = 5): { thread_id: string; example_title: string; count: number }[] {
  const ftsQuery = escapeFtsQuery(title);
  if (!ftsQuery) return [];
  // Scope match to title column via FTS5 column filter. Order by recency of the
  // most recent matching note in each thread; bm25 isn't reliable under aggregation
  // here so we keep the SQL simple and robust.
  const scoped = ftsQuery.split(" ").map((t) => `title:${t}`).join(" ");
  return db()
    .query<{ thread_id: string; example_title: string; count: number }, [string, number]>(
      `SELECT notes.thread_id,
              (SELECT n2.title FROM notes n2
                 WHERE n2.thread_id = notes.thread_id AND n2.status='active'
                 ORDER BY n2.created DESC LIMIT 1) AS example_title,
              COUNT(*) AS count
       FROM notes_fts JOIN notes ON notes.id = notes_fts.id
       WHERE notes_fts MATCH ? AND notes.status = 'active'
       GROUP BY notes.thread_id
       ORDER BY MAX(notes.created) DESC
       LIMIT ?`
    )
    .all(scoped, limit);
}

export function listPopularTags(limit = 20, minCount = 2): { tag: string; count: number }[] {
  return db()
    .query<{ tag: string; count: number }, [number, number]>(
      `SELECT t.tag, COUNT(*) AS count
         FROM tags t
         JOIN notes n ON n.id = t.note_id
        WHERE n.status = 'active'
        GROUP BY t.tag
       HAVING count >= ?
        ORDER BY count DESC, t.tag ASC
        LIMIT ?`
    )
    .all(minCount, limit);
}

export function listNotesByTag(tag: string, limit = 200): NoteMeta[] {
  const rows = db()
    .query<Record<string, any>, [string, number]>(
      `SELECT n.* FROM notes n
         JOIN tags t ON t.note_id = n.id
        WHERE n.status = 'active' AND n.superseded_by IS NULL AND t.tag = ?
        ORDER BY n.created DESC
        LIMIT ?`
    )
    .all(tag, limit);
  return rows.map(rowToMeta);
}

/**
 * Project grouping (v0.20+). Returns notes tagged `project:<slug>` grouped
 * by their thread_id, sorted by most-recently-updated thread first.
 *
 * Each group is a thread that has at least one note in the project — the
 * note may also carry other tags. Threads with zero project-tagged notes
 * don't appear, even if they share a name slug. The grouping is
 * tag-driven, not folder-driven.
 *
 * Use case: user's mental model is "project = many docs / threads"; this
 * helper turns that into a list of threads instead of the flat tag view
 * `/tag/<slug>` gives.
 */
export interface ProjectThreadGroup {
  thread_id: string;
  notes: NoteMeta[];   // ordered desc by created (latest first)
  noteCount: number;
  finalCount: number;
  latestCreated: string;
}

export function listProjectThreads(projectSlug: string, limit = 500): {
  groups: ProjectThreadGroup[];
  totalNotes: number;
} {
  const tag = `project:${projectSlug}`;
  const notes = listNotesByTag(tag, limit);
  const byThread = new Map<string, NoteMeta[]>();
  for (const n of notes) {
    const arr = byThread.get(n.thread_id) ?? [];
    arr.push(n);
    byThread.set(n.thread_id, arr);
  }
  const groups: ProjectThreadGroup[] = [];
  for (const [thread_id, threadNotes] of byThread.entries()) {
    // Already came in created-desc order from listNotesByTag — keep it.
    groups.push({
      thread_id,
      notes: threadNotes,
      noteCount: threadNotes.length,
      finalCount: threadNotes.filter((n) => n.is_final).length,
      latestCreated: threadNotes[0]!.created,
    });
  }
  groups.sort((a, b) => b.latestCreated.localeCompare(a.latestCreated));
  return { groups, totalNotes: notes.length };
}

/**
 * v0.24 — project workspace dashboard data.
 *
 * Wraps listProjectThreads with three additional facets the rich
 * `/p/<slug>` view renders as cards above the thread list:
 *
 *   - `slots`: canonical living documents per the slot:<name> tag
 *     convention. One head note per slot (most recent wins on collision;
 *     `slot_warnings` reports the duplicates so the user can clean up).
 *     Each slot exposes the head NoteMeta + a body excerpt for preview.
 *
 *   - `pendingIterations`: iteration notes tagged with this project that
 *     are not finalized — i.e. there's a round waiting on a pick. The
 *     dashboard card invites the user to click → resolve.
 *
 *   - `recentActivity`: last N events scoped to this project's threads
 *     in the configurable window (default 14 days). One row per event,
 *     newest first. Used for the "what's been happening" timeline.
 *
 *   - `threadGroups`: the existing listProjectThreads data, returned so
 *     the renderer can show "all threads" below the dashboard cards
 *     without doing a second SQL pass.
 *
 * All queries are bounded: at most one INSERT-equivalent SELECT per
 * slot, plus a single events scan limited by the window+limit.
 */
export const STANDARD_SLOTS = [
  "roadmap",
  "todo",
  "changelog",
  "release-notes",
  "vision",
  "hub",
  "presentation",
  "gantt",
] as const;
export type StandardSlot = typeof STANDARD_SLOTS[number];

export interface SlotEntry {
  name: string;            // slot name without the "slot:" prefix
  head: NoteMeta;          // current head note for this slot in this project
  excerpt: string;         // first ~280 chars of plain text, for the card preview
  duplicates: number;      // how many additional candidates carried the same slot tag (collision count)
}

export interface ProjectActivityEvent {
  kind: string;
  ts: string;
  note_id: string | null;
  thread_id: string | null;
  data: Record<string, unknown> | null;
}

export interface ProjectDashboard {
  slug: string;
  slots: SlotEntry[];                // ordered by STANDARD_SLOTS list, then any unknown slots alpha-sorted
  pendingIterations: NoteMeta[];     // non-finalized iteration notes
  recentActivity: ProjectActivityEvent[];
  threadGroups: ProjectThreadGroup[];
  totalNotes: number;
  slotWarnings: Array<{ slot: string; count: number }>;  // slots with >1 head note (cleanup hint)
}

export function getProjectDashboard(projectSlug: string, opts?: {
  activityDays?: number;
  activityLimit?: number;
}): ProjectDashboard {
  const activityDays = Math.max(1, Math.min(60, opts?.activityDays ?? 14));
  const activityLimit = Math.max(1, Math.min(100, opts?.activityLimit ?? 20));
  const projectTag = `project:${projectSlug}`;
  const d = db();

  // ── slot detection ────────────────────────────────────────────────────
  // Pull every note that carries BOTH project:<slug> AND a slot:* tag.
  // Group by slot name, head = most-recently-updated non-superseded one.
  type SlotRow = { note_id: string; slot_tag: string };
  const slotRows = d
    .query<SlotRow, [string]>(
      `SELECT DISTINCT t1.note_id, t1.tag AS slot_tag
       FROM tags t1
       JOIN tags t2 ON t2.note_id = t1.note_id
       JOIN notes n ON n.id = t1.note_id
       WHERE t1.tag LIKE 'slot:%'
         AND t2.tag = ?
         AND n.status = 'active'
         AND n.superseded_by IS NULL`,
    )
    .all(projectTag);

  const slotCandidates = new Map<string, NoteMeta[]>();
  for (const row of slotRows) {
    const meta = getNoteMeta(row.note_id);
    if (!meta) continue;
    const slotName = row.slot_tag.slice("slot:".length);
    const arr = slotCandidates.get(slotName) ?? [];
    arr.push(meta);
    slotCandidates.set(slotName, arr);
  }

  const slots: SlotEntry[] = [];
  const slotWarnings: Array<{ slot: string; count: number }> = [];
  // Pick head per slot: newest by updated, breaking ties on created.
  for (const [name, candidates] of slotCandidates.entries()) {
    candidates.sort((a, b) => {
      const tCmp = b.updated.localeCompare(a.updated);
      return tCmp !== 0 ? tCmp : b.created.localeCompare(a.created);
    });
    const head = candidates[0]!;
    if (candidates.length > 1) {
      slotWarnings.push({ slot: name, count: candidates.length - 1 });
    }
    slots.push({ name, head, excerpt: slotExcerpt(head), duplicates: candidates.length - 1 });
  }
  // Order: STANDARD_SLOTS first (in declared order), then any non-standard slots alpha-sorted.
  slots.sort((a, b) => {
    const ai = STANDARD_SLOTS.indexOf(a.name as StandardSlot);
    const bi = STANDARD_SLOTS.indexOf(b.name as StandardSlot);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.name.localeCompare(b.name);
  });

  // ── pending iterations ────────────────────────────────────────────────
  const pendingIterRows = d
    .query<Record<string, any>, [string]>(
      `SELECT n.* FROM notes n
       JOIN tags t ON t.note_id = n.id
       WHERE n.type = 'iteration'
         AND n.is_final = 0
         AND n.status = 'active'
         AND n.superseded_by IS NULL
         AND t.tag = ?
       ORDER BY n.updated DESC`,
    )
    .all(projectTag);
  const pendingIterations = pendingIterRows.map(rowToMeta);

  // ── recent activity ───────────────────────────────────────────────────
  // Scope events to threads that have at least one note carrying the
  // project tag. We pull the set of thread_ids first (small) then filter
  // events by IN that set — cheaper than a join.
  const projectThreadIds = d
    .query<{ thread_id: string }, [string]>(
      `SELECT DISTINCT n.thread_id FROM notes n
       JOIN tags t ON t.note_id = n.id
       WHERE t.tag = ? AND n.status = 'active'`,
    )
    .all(projectTag)
    .map((r) => r.thread_id);

  let recentActivity: ProjectActivityEvent[] = [];
  if (projectThreadIds.length > 0) {
    const placeholders = projectThreadIds.map(() => "?").join(",");
    const eventRows = d
      .query<{ kind: string; ts: string; note_id: string | null; thread_id: string | null; data: string | null }, any[]>(
        `SELECT kind, ts, note_id, thread_id, data
         FROM events
         WHERE thread_id IN (${placeholders})
           AND ts > datetime('now', '-' || ? || ' days')
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(...projectThreadIds, activityDays, activityLimit);
    recentActivity = eventRows.map((r) => ({
      kind: r.kind,
      ts: r.ts,
      note_id: r.note_id,
      thread_id: r.thread_id,
      data: r.data ? safeParseJson(r.data) : null,
    }));
  }

  // ── thread groups (reuse existing helper) ─────────────────────────────
  const { groups, totalNotes } = listProjectThreads(projectSlug);

  return {
    slug: projectSlug,
    slots,
    pendingIterations,
    recentActivity,
    threadGroups: groups,
    totalNotes,
    slotWarnings,
  };
}

/**
 * Pull a short plain-text excerpt from a note's HTML body for slot
 * preview cards. Reads the on-disk file via readNoteHtml so we get the
 * sanitized rendered body, strips tags, collapses whitespace, caps at
 * ~280 chars. Cheap enough to call once per slot per dashboard load.
 */
function slotExcerpt(meta: NoteMeta, maxChars = 280): string {
  try {
    const html = readNoteHtml(meta);
    // Pull the article body, strip tags + scripts/styles, collapse whitespace.
    const m = html.match(/<article[^>]*data-folio-content[^>]*>([\s\S]*?)<\/article>/);
    const inner = m && m[1] ? m[1] : html;
    const stripped = inner
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    if (stripped.length <= maxChars) return stripped;
    // Cut on a word boundary.
    const cut = stripped.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trim() + "…";
  } catch {
    return "";
  }
}

function safeParseJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
}

export function stats(): Record<string, any> {
  const d = db();
  return {
    total: d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notes WHERE status = 'active'").get()?.n ?? 0,
    final: d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notes WHERE is_final = 1 AND status = 'active'").get()?.n ?? 0,
    expiring_7d: d
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM notes WHERE is_final = 0 AND status = 'active' AND expires_at < datetime('now', '+7 days')"
      )
      .get()?.n ?? 0,
    by_type: d
      .query<{ type: string; n: number }, []>(
        "SELECT type, COUNT(*) AS n FROM notes WHERE status = 'active' GROUP BY type ORDER BY n DESC"
      )
      .all(),
    threads: d.query<{ n: number }, []>("SELECT COUNT(DISTINCT thread_id) AS n FROM notes WHERE status = 'active'").get()?.n ?? 0,
    analytics: {
      avg_class_match: d
        .query<{ avg: number }, []>(
          `SELECT AVG(CAST(json_extract(data,'$.class_count') AS REAL) /
                       NULLIF(CAST(json_extract(data,'$.class_count') AS REAL) +
                              CAST(json_extract(data,'$.inline_style_count') AS REAL), 0)) AS avg
           FROM events WHERE kind = 'note_created'`
        )
        .get()?.avg ?? null,
      total_events: d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0,
    },
  };
}

function rowToMeta(row: Record<string, any>): NoteMeta {
  const tags = db()
    .query<{ tag: string }, [string]>("SELECT tag FROM tags WHERE note_id = ? ORDER BY tag")
    .all(row.id)
    .map((r) => r.tag);
  return {
    id: row.id,
    slug: row.slug,
    path: row.path,
    title: row.title,
    type: row.type as NoteType,
    theme: row.theme,
    theme_profile: row.theme_profile as RenderProfile,
    thread_id: row.thread_id,
    is_final: row.is_final === 1,
    live: row.live === 1,
    last_entry_at: row.last_entry_at ?? null,
    created: row.created,
    updated: row.updated,
    expires_at: row.expires_at,
    word_count: row.word_count,
    summary: row.summary,
    tags,
    origin_device_id: row.origin_device_id ?? null,
    owner_device_id: row.owner_device_id ?? null,
    inline_render: row.inline_render === 1,
    superseded_by: row.superseded_by ?? null,
    is_pinned: row.is_pinned === 1,
    pinned_at: row.pinned_at ?? null,
    session_key: row.session_key ?? null,
  };
}

function escapeFtsQuery(q: string): string {
  // 1. Normalize PL (ł→l, ą→a, etc.) — symmetry with FTS insert
  // 2. Split on whitespace AND hyphens (unicode61 splits "Fine-Tuning" → fine, tuning)
  // 3. Strip non-word chars
  // 4. Stem each token (PL suffix stripper) — only at query, NOT index, so:
  //    - snippet still shows real words
  //    - prefix-match catches more inflections ("wyboru" → "wybor*" matches "wybór")
  const tokens = plNormalize(q)
    .trim()
    .split(/[\s\-]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase())
    .filter(Boolean)
    .map(plStem);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}*`).join(" ");
}
