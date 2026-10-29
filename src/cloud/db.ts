/**
 * Cloud relay storage — separate SQLite DB from the local viewer's index.sqlite.
 *
 * Lives at $FOLIO_CLOUD_HOME/cloud.sqlite (default /var/lib/folio-cloud/cloud.sqlite).
 * Schema mirrors the per-device local schema where it makes sense (notes,
 * note_tags, live_entries) but adds device + auth + share tables that have no
 * local counterpart.
 *
 * One database connection per process via singleton. WAL mode for concurrent
 * readers; the push/pull paths are short transactions, so no contention in
 * practice for one-user MVP scale.
 *
 * IMPORTANT: this DB is rebuildable from canonical state, but ONLY if you push
 * all notes from every device again. Treat it as authoritative once it's the
 * sync hub. Backups: bind mount /var/lib/folio-cloud included in VPS snapshot
 * policy, or Litestream → S3/R2 as add-on.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export function cloudDataDir(): string {
  return process.env.FOLIO_CLOUD_HOME?.trim() || "/var/lib/folio-cloud";
}

export function cloudDbPath(): string {
  return join(cloudDataDir(), "cloud.sqlite");
}

export function cloudAssetsDir(): string {
  return join(cloudDataDir(), "assets");
}

// `tombstones` design rationale (referenced inside the SQL below):
// When a device pushes a delete, handlePush does the hard DELETE on notes
// (cascade clears tags + live_entries) AND inserts a row in tombstones.
// handlePull returns tombstones whose server_seq is past the caller's
// cursor, so another device's pull learns about deletions that originated
// elsewhere. Separate table (vs deleted_at column on notes) keeps every
// existing SELECT against notes unchanged — no WHERE deleted_at IS NULL
// in /raw/, /n/, /t/, /v1/feed, share scope validation, etc.
//
// GC: rows survive indefinitely for MVP. Devices may sit offline for weeks,
// and the cursor model means a re-connecting device must still see deletes
// that happened in its absence. If the table grows painfully (>1M rows),
// add a periodic sweep that drops rows older than the longest-cursor of
// any active device — out of scope for first cut.

// `users` + `user_id` partitioning (v0.13.0):
// Every table that holds user-owned data carries a NOT NULL `user_id` column,
// default 'default' so the v0.12.0 → v0.13.0 migration is a single ADD COLUMN.
// Every cloud-side query joins on `device.user_id` so paired devices only ever
// see their own user's rows. The `users` table itself is a thin row (id,
// display, created_at) — no auth state lives there (token_hash stays on
// devices). All filtering happens application-side; no FK constraints (kept
// off so that user-revoke --purge can do its cascade explicitly and tests
// can seed tables in any order). The 'default' seed exists so that fresh DBs
// don't need a separate bootstrap step and existing rows backfill cleanly.

const CLOUD_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Users (v0.13.0+). One row per operator-provisioned account. No password —
-- bearer tokens live on devices. user-add via CLI; no self-service registration.
-- is_operator (v0.14.0+): when 1, the user's devices can call /v1/admin/*
-- routes (create/rename/revoke other users, list cloud-wide stats). Set via
-- 'folio cloud user-promote <id>' or unset via user-demote. Multiple
-- operators allowed — mirrors how systems with multiple admins work.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- kebab-case: 'jarek', 'alice', 'bob'
  display_name TEXT NOT NULL,
  is_operator INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
INSERT OR IGNORE INTO users (id, display_name, created_at)
  VALUES ('default', 'default', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Paired client devices. One row per laptop/notibox/phone the user pairs.
-- token_hash stores SHA-256 of the bearer token (token itself never persisted).
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,           -- UUIDv7
  name TEXT NOT NULL,            -- user-visible (hostname, "iphone", ...)
  token_hash TEXT NOT NULL,      -- hex sha-256 of bearer token
  paired_at TEXT NOT NULL,       -- ISO 8601
  last_seen_at TEXT,             -- updated on each authed request (throttled)
  revoked_at TEXT,               -- null = active; set = denies all requests
  user_id TEXT NOT NULL DEFAULT 'default',
  public_key TEXT,               -- sc-24117: SPKI PEM; set = requests signed, bearer dead
  key_alg TEXT                   -- sc-24117: 'ed25519' | 'p256'
);
CREATE INDEX IF NOT EXISTS devices_by_token ON devices(token_hash) WHERE revoked_at IS NULL;
-- user-specific indexes created by ensureMultiUserSchema() so the bootstrap
-- order works on pre-v0.13 DBs where user_id columns don't exist yet.

-- One-shot pairing codes printed by the server admin and consumed by a new
-- device. 10 minute TTL. used_by_device_id pins which device claimed the code
-- (idempotent re-pairs return the same device). user_id determines which
-- account the newly-paired device joins; carried from the code minter.
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,         -- 6-digit string, zero-padded
  expires_at TEXT NOT NULL,      -- ISO 8601
  used_by_device_id TEXT,        -- null until claimed; set when device pairs
  user_id TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS pairing_codes_by_exp ON pairing_codes(expires_at);

-- Notes (mirror of local schema, plus origin_device_id for multi-writer and
-- user_id for multi-user partitioning). uuid is the cross-device stable
-- identity; slug is a display-only label that may be renamed on conflict.
CREATE TABLE IF NOT EXISTS notes (
  uuid TEXT PRIMARY KEY,         -- UUIDv7, generated client-side at create
  user_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'linen',
  theme_profile TEXT NOT NULL DEFAULT 'hosted',
  body_html TEXT NOT NULL,
  plain_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  is_final INTEGER NOT NULL DEFAULT 0,
  live INTEGER NOT NULL DEFAULT 0,
  owner_device_id TEXT,          -- non-null for live notes only (W2 owner-locked)
  origin_device_id TEXT NOT NULL,
  inline_render INTEGER NOT NULL DEFAULT 0, -- v0.17: entries spliced into body_html at /raw/ render
  -- v0.29 user-pinned notes (parallel to local notes.is_pinned/pinned_at).
  -- Synced so a pin on device A shows up on device B. Pre-existing rows
  -- default to unpinned; idempotent ALTER below handles upgrades.
  is_pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at TEXT,
  -- v0.30.1: supersede chain pointer (parallel to local notes.superseded_by).
  -- Synced so a replace on device A hides the old revision on device B.
  -- Pre-existing rows default to NULL (head); idempotent ALTER below upgrades.
  superseded_by TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  server_seq INTEGER NOT NULL,   -- monotonic per-row, used for pull cursor
  UNIQUE(user_id, thread_id, slug) -- enforces collision rename per-user (v0.13)
);
CREATE INDEX IF NOT EXISTS notes_by_thread ON notes(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notes_by_seq ON notes(server_seq);
CREATE INDEX IF NOT EXISTS notes_by_origin ON notes(origin_device_id, server_seq);

CREATE TABLE IF NOT EXISTS note_tags (
  note_uuid TEXT NOT NULL REFERENCES notes(uuid) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_uuid, tag)
);
CREATE INDEX IF NOT EXISTS note_tags_by_tag ON note_tags(tag);

-- Live note entries (mirror of local .entries.jsonl, but row-per-entry).
-- Owner-locked at the note level (notes.owner_device_id), so all entries for
-- a given note share the same origin device. server_seq monotonic across all
-- entries cloud-wide (separate from notes.server_seq).
CREATE TABLE IF NOT EXISTS live_entries (
  id TEXT NOT NULL,              -- entry id (8-char ulid from src/core/live.ts)
  note_uuid TEXT NOT NULL REFERENCES notes(uuid) ON DELETE CASCADE,
  ts TEXT NOT NULL,              -- ISO 8601, server-time append
  content_html TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT,              -- optional event time
  refs_json TEXT NOT NULL DEFAULT '[]',
  importance INTEGER,            -- 1..5 or null
  source_ref TEXT,
  server_seq INTEGER NOT NULL,
  PRIMARY KEY (note_uuid, id)    -- dedup is per-note
);
CREATE INDEX IF NOT EXISTS live_entries_by_seq ON live_entries(server_seq);

-- Content-addressed asset storage. hash is SHA-256 hex of bytes; blob_path is
-- relative to cloudAssetsDir() (e.g. "ab/cd/abcd...png" sharded for fs perf).
-- One asset row per unique content hash; thread_id is recorded for backup/
-- export grouping but not enforced as a foreign key — same bytes can be
-- referenced by many threads. user_id added v0.13 — for now one row per
-- (hash) with the first uploader's user_id stamped; cross-user dedup would
-- require asset_refs(hash, user_id, ...) which is post-MVP.
CREATE TABLE IF NOT EXISTS assets (
  hash TEXT PRIMARY KEY,         -- sha256 hex (64 chars)
  filename TEXT NOT NULL,        -- agent-supplied, sanitized by isSafeAssetFilename
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  blob_path TEXT NOT NULL,       -- relative to cloudAssetsDir()
  uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_by_thread ON assets(thread_id);

-- Tombstones: see comment block above CLOUD_SCHEMA constant in this file
-- for the design rationale. tl;dr — separate table avoids adding a
-- "WHERE deleted_at IS NULL" filter to every existing notes query.
CREATE TABLE IF NOT EXISTS tombstones (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  thread_id TEXT NOT NULL,
  origin_device_id TEXT,
  deleted_at TEXT NOT NULL,
  server_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tombstones_by_seq ON tombstones(server_seq);

-- Capability-URL shares (filled in W4; schema-ready in W1).
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,        -- 32-byte url-safe random (43 chars base64url)
  user_id TEXT NOT NULL DEFAULT 'default',
  scope_type TEXT NOT NULL,      -- 'note' | 'thread' | 'set' (v0.32)
  scope_id TEXT NOT NULL,        -- note uuid or thread_id ('set' → root note uuid)
  created_by_device TEXT NOT NULL REFERENCES devices(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,               -- null = forever
  revoked_at TEXT,
  recipient_email_hash TEXT,     -- optional, hex sha-256(email)
  max_views INTEGER,             -- null = unlimited
  view_count INTEGER NOT NULL DEFAULT 0,
  -- v0.34: when 1, recipients of this share may register a NON-authoritative
  -- variant preference (POST /p/:token/pick → share_picks). Opt-in per share;
  -- pre-existing rows default to 0 (read-only, as before).
  allow_pick INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shares_by_scope ON shares(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS shares_by_expires ON shares(expires_at) WHERE expires_at IS NOT NULL;

-- v0.32: membership for 'set'-scoped shares. A set token grants read access
-- to exactly these note uuids (the shared note + the notes it links to,
-- snapshotted at create time). Cascade-free: revoke leaves rows (token is the
-- credential; revoked_at on the share row gates access). One row per granted
-- note; PK dedupes.
CREATE TABLE IF NOT EXISTS share_notes (
  token TEXT NOT NULL,
  note_uuid TEXT NOT NULL,
  PRIMARY KEY (token, note_uuid)
);
CREATE INDEX IF NOT EXISTS share_notes_by_token ON share_notes(token);

-- v0.34: soft variant preferences registered by share recipients. NOT
-- authoritative — deliberately separate from live_entries / iteration
-- kind:pick so it never touches the append-only "first pick wins" state
-- machine. The capability token is the credential (link = authority); no
-- recipient identity is required. One row per (token, note); last pick wins,
-- pick_count records how many times the recipient changed their mind. Cleaned
-- up alongside the share on revoke --purge; orphan rows are harmless (the
-- share row gates whether anyone can still write).
CREATE TABLE IF NOT EXISTS share_picks (
  token TEXT NOT NULL,
  note_uuid TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  variant TEXT NOT NULL,
  label TEXT,
  picked_at TEXT NOT NULL,
  pick_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (token, note_uuid)
);
CREATE INDEX IF NOT EXISTS share_picks_by_token ON share_picks(token);

-- Server-wide sequence counter. Notes and live_entries draw from this so that
-- a single monotonic int suffices as pull cursor across both. Bumped under
-- transaction at each insert.
CREATE TABLE IF NOT EXISTS server_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO server_seq (id, value) VALUES (1, 0);
`;

let _db: Database | null = null;

export function cloudDb(): Database {
  if (_db) return _db;
  const dir = cloudDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  const dbFile = cloudDbPath();
  if (!existsSync(dirname(dbFile))) mkdirSync(dirname(dbFile), { recursive: true });
  _db = new Database(dbFile, { create: true });
  _db.exec(CLOUD_SCHEMA);
  ensureMultiUserSchema(_db);
  return _db;
}

/**
 * Idempotent migrator for v0.12.0 → v0.13.0. Old DBs have no `user_id` columns
 * and the old `UNIQUE(thread_id, slug)` on notes; bring them up to the form
 * defined by CLOUD_SCHEMA above. Re-running on an already-migrated DB is a
 * fast no-op (canary probe on devices.user_id, sqlite_master check on notes
 * for the new UNIQUE clause). Both probes use PRAGMA / sqlite_master, no
 * writes on the happy path.
 *
 * FK note: we have ON DELETE CASCADE from note_tags + live_entries → notes.
 * DROP TABLE notes would cascade-clear those during rebuild — so we disable
 * foreign_keys for the rebuild block and re-enable after. PRAGMA pragmas
 * must sit outside transactions, so the order is:
 *   PRAGMA foreign_keys = OFF
 *   BEGIN
 *     rebuild
 *     PRAGMA foreign_key_check  -- validates inside the tx
 *   COMMIT
 *   PRAGMA foreign_keys = ON
 */
function ensureMultiUserSchema(db: Database): void {
  // v0.14: users.is_operator column. Detect first because if the users table
  // was created BEFORE this column existed, the CREATE TABLE IF NOT EXISTS
  // above keeps the old shape. ALTER TABLE adds the column with DEFAULT 0
  // so every existing row is a non-operator (operator must be explicitly
  // promoted via `folio cloud user-promote <id>`).
  const userCols = db.query<{ name: string }, []>("PRAGMA table_info(users)").all();
  if (!userCols.some((c) => c.name === "is_operator")) {
    db.exec("ALTER TABLE users ADD COLUMN is_operator INTEGER NOT NULL DEFAULT 0");
  }

  const deviceCols = db.query<{ name: string }, []>("PRAGMA table_info(devices)").all();
  const devicesHaveUserId = deviceCols.some((c) => c.name === "user_id");

  if (!devicesHaveUserId) {
    // Old schema — add user_id columns. NOT NULL DEFAULT 'default' fills
    // every existing row in one statement; FK from `users(id)` is implicit
    // by application convention, not declared, so no FK rebuild required.
    db.transaction(() => {
      db.exec(`
        ALTER TABLE devices       ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE pairing_codes ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE notes         ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE assets        ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE tombstones    ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE shares        ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
      `);
    })();
  }

  // User-specific indexes — kept out of CLOUD_SCHEMA so pre-v0.13 bootstrap
  // doesn't trip on missing user_id columns. Idempotent re-create.
  db.exec(`
    CREATE INDEX IF NOT EXISTS devices_by_user ON devices(user_id);
    CREATE INDEX IF NOT EXISTS notes_by_user_thread ON notes(user_id, thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS notes_by_user_seq ON notes(user_id, server_seq);
    CREATE INDEX IF NOT EXISTS assets_by_user_thread ON assets(user_id, thread_id);
    CREATE INDEX IF NOT EXISTS tombstones_by_user_seq ON tombstones(user_id, server_seq);
    CREATE INDEX IF NOT EXISTS shares_by_user ON shares(user_id, created_at DESC);
  `);

  // Detect whether the UNIQUE constraint on `notes` is already the new
  // shape. sqlite_master.sql holds the original CREATE TABLE statement.
  // If yes, skip the UNIQUE rebuild — but ALWAYS continue past it to the
  // per-version ALTER blocks below (inline_render, future columns).
  const tblRow = db
    .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='notes'")
    .get();
  const tblSql = tblRow?.sql ?? "";
  const hasNewUnique =
    /UNIQUE\s*\(\s*user_id\s*,\s*thread_id\s*,\s*slug\s*\)/i.test(tblSql);
  if (!hasNewUnique) {

  // Rebuild notes with UNIQUE(user_id, thread_id, slug). Defensive checks
  // first: bail out (with diagnostic) if existing rows would collide under
  // the new constraint — single-tenant data should never trigger this, but
  // a botched manual import could.
  const dups = db
    .query<{ user_id: string; thread_id: string; slug: string; n: number }, []>(
      "SELECT user_id, thread_id, slug, COUNT(*) AS n FROM notes GROUP BY user_id, thread_id, slug HAVING COUNT(*) > 1"
    )
    .all();
  if (dups.length > 0) {
    throw new Error(
      `notes UNIQUE rebuild blocked by ${dups.length} duplicate (user_id, thread_id, slug) groups: ${JSON.stringify(dups.slice(0, 5))}`
    );
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE notes_new (
          uuid TEXT PRIMARY KEY,
          user_id TEXT NOT NULL DEFAULT 'default',
          slug TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          title TEXT NOT NULL,
          type TEXT NOT NULL,
          theme TEXT NOT NULL DEFAULT 'linen',
          theme_profile TEXT NOT NULL DEFAULT 'hosted',
          body_html TEXT NOT NULL,
          plain_text TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT,
          is_final INTEGER NOT NULL DEFAULT 0,
          live INTEGER NOT NULL DEFAULT 0,
          owner_device_id TEXT,
          origin_device_id TEXT NOT NULL,
          word_count INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          server_seq INTEGER NOT NULL,
          UNIQUE(user_id, thread_id, slug)
        );
        INSERT INTO notes_new
          SELECT uuid, user_id, slug, thread_id, title, type, theme, theme_profile,
                 body_html, plain_text, created_at, updated_at, expires_at,
                 is_final, live, owner_device_id, origin_device_id,
                 word_count, summary, server_seq
            FROM notes;
        DROP TABLE notes;
        ALTER TABLE notes_new RENAME TO notes;
        CREATE INDEX notes_by_thread ON notes(thread_id, created_at DESC);
        CREATE INDEX notes_by_seq ON notes(server_seq);
        CREATE INDEX notes_by_origin ON notes(origin_device_id, server_seq);
        CREATE INDEX notes_by_user_thread ON notes(user_id, thread_id, created_at DESC);
        CREATE INDEX notes_by_user_seq ON notes(user_id, server_seq);
      `);
      const violations = db
        .query<{ table: string; rowid: number; parent: string; fkid: number }, []>(
          "PRAGMA foreign_key_check"
        )
        .all();
      if (violations.length > 0) {
        throw new Error(
          `notes rebuild left FK violations: ${JSON.stringify(violations.slice(0, 5))}`
        );
      }
    })();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  } // end if (!hasNewUnique) — UNIQUE rebuild block

  // sc-24117: devices.public_key + key_alg (device-key request signing).
  // Same unconditional idempotent-ALTER pattern as inline_render below.
  {
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(devices)").all();
    if (!cols.some((c) => c.name === "public_key")) db.exec("ALTER TABLE devices ADD COLUMN public_key TEXT");
    if (!cols.some((c) => c.name === "key_alg")) db.exec("ALTER TABLE devices ADD COLUMN key_alg TEXT");
  }

  // v0.17: notes.inline_render. ALWAYS runs (outside the UNIQUE-rebuild
  // branch above) so clouds created with v0.13+ schema directly — which
  // skip the rebuild — still get the column. Runs AFTER any rebuild that
  // did happen so the column survives the table swap. Idempotent.
  //
  // History (v0.18.1 fix): this block originally sat below an
  // `if (hasNewUnique) return;` early-return, which silently skipped
  // the ALTER on any cloud that didn't need a v0.12→v0.13 rebuild.
  // Symptom on folio.notibox.ai: every /raw/:uuid GET returned
  // `{"error":"no such column: inline_render"}`.
  const notesCols = db.query<{ name: string }, []>("PRAGMA table_info(notes)").all();
  if (notesCols.length > 0 && !notesCols.some((c) => c.name === "inline_render")) {
    db.exec("ALTER TABLE notes ADD COLUMN inline_render INTEGER NOT NULL DEFAULT 0");
  }
  // v0.29: notes.is_pinned + pinned_at. Same idempotent-ALTER pattern as
  // inline_render above — runs unconditionally so any cloud DB picks up
  // the columns on next boot. Pre-existing rows default to unpinned.
  if (notesCols.length > 0 && !notesCols.some((c) => c.name === "is_pinned")) {
    db.exec("ALTER TABLE notes ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
  }
  if (notesCols.length > 0 && !notesCols.some((c) => c.name === "pinned_at")) {
    db.exec("ALTER TABLE notes ADD COLUMN pinned_at TEXT");
  }
  // v0.30.1: notes.superseded_by. Same idempotent-ALTER pattern — any cloud
  // DB picks up the column on next boot; pre-existing rows default to NULL.
  if (notesCols.length > 0 && !notesCols.some((c) => c.name === "superseded_by")) {
    db.exec("ALTER TABLE notes ADD COLUMN superseded_by TEXT");
  }
  // v0.34: shares.allow_pick. Same idempotent-ALTER pattern — pre-existing
  // shares default to 0 (read-only). share_picks is a CREATE TABLE IF NOT
  // EXISTS in CLOUD_SCHEMA, so it needs no ALTER here.
  const shareCols = db.query<{ name: string }, []>("PRAGMA table_info(shares)").all();
  if (shareCols.length > 0 && !shareCols.some((c) => c.name === "allow_pick")) {
    db.exec("ALTER TABLE shares ADD COLUMN allow_pick INTEGER NOT NULL DEFAULT 0");
  }
}

export function closeCloudDb(): void {
  _db?.close();
  _db = null;
}

/**
 * Atomically bump and return the next monotonic sequence number. Use this for
 * every notes or live_entries insert so that pull cursors are stable across
 * the union of both tables.
 */
export function nextSeq(db: Database): number {
  const row = db
    .query<{ value: number }, []>("UPDATE server_seq SET value = value + 1 WHERE id = 1 RETURNING value")
    .get();
  if (!row) throw new Error("server_seq row missing — DB not initialized");
  return row.value;
}
