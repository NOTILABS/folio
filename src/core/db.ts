import { Database } from "bun:sqlite";
import { dbPath } from "./config";
import { runMigrations, HEAD_VERSION } from "./migrations";

// Two-phase schema bootstrap. The split matters whenever a future schema
// version adds a new column AND an index that references that column:
//   Phase 1 — minimal: PRAGMAs + meta table only. Always safe to run first.
//   (migrations) — bring pre-existing dbs up to head: ALTER TABLE adds
//                  columns, CREATE INDEX adds indexes that depend on them.
//   Phase 2 — full: CREATE TABLE IF NOT EXISTS for tables that don't yet
//                   exist on greenfield installs, plus all CREATE INDEX
//                   IF NOT EXISTS for indexes that may have been added
//                   by migrations on existing dbs (no-op if already
//                   created by a migration).
//
// Why not just one BASE_SCHEMA? CREATE INDEX IF NOT EXISTS can't gate on
// "column may not exist yet" — it raises before the migration has had a
// chance to ALTER TABLE. v0.9.0 shipped a one-phase BASE_SCHEMA and
// crashed on `notes_by_live` for every db that predated v0.9.0. v0.9.1
// fixes by running migrations between the two phases.

const PHASE1_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const PHASE2_SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'linen',
  theme_profile TEXT NOT NULL DEFAULT 'hosted',
  thread_id TEXT NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  expires_at TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  live INTEGER NOT NULL DEFAULT 0,
  last_entry_at TEXT,
  -- W2 multi-writer sync: device id that created the note, and (for live
  -- notes only) the device id allowed to append entries. Both populated by
  -- createNote() and backfilled by migrations.ts v2→v3.
  origin_device_id TEXT,
  owner_device_id TEXT,
  -- v0.17 inline-rendered live notes: when 1, entries are spliced into
  -- body_html at /raw/ render time (server-side) + new entries arrive via
  -- parent→iframe postMessage. When 0 (default), live note body stays
  -- static and entries render in the side panel. Migration v3→v4 adds
  -- the column to pre-existing dbs.
  inline_render INTEGER NOT NULL DEFAULT 0,
  -- v0.22 replace primitive: id of the note that replaced this one, or
  -- NULL if this note is the head version. Default listings filter
  -- WHERE superseded_by IS NULL so the thread view stays clean after a
  -- replace. The old .html file stays on disk for capability-URL stability.
  -- Migration v4→v5 adds the column to pre-existing dbs.
  superseded_by TEXT,
  -- v0.29 user-pinned notes: 1 = pinned to top of the default listing,
  -- 0 = not pinned. pinned_at is the ISO timestamp the user toggled it on
  -- so multiple pinned notes sort by *when they were pinned* (freshly
  -- pinned floats above long-pinned). NULL when is_pinned=0. Distinct
  -- from is_final (★ archive, no auto-cleanup) and from view:pinned
  -- (entry-level tag on live notes). Migration v5→v6 adds these to
  -- pre-existing dbs.
  is_pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at TEXT,
  -- sc-15149: key of the agent chat session the note was created in
  -- (optional, NULL for older notes). Chat clients list a session's notes
  -- by it. Migration v6→v7 adds the column to pre-existing dbs.
  session_key TEXT
);
CREATE INDEX IF NOT EXISTS notes_by_type ON notes(type, created DESC);
CREATE INDEX IF NOT EXISTS notes_by_thread ON notes(thread_id, created DESC);
CREATE INDEX IF NOT EXISTS notes_by_created ON notes(created DESC);
CREATE INDEX IF NOT EXISTS notes_by_expires ON notes(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_by_live ON notes(live, last_entry_at) WHERE live = 1;
-- v2→v3: needs origin_device_id column which is added by the migration
-- BEFORE this phase runs. Greenfield installs get the column from the
-- CREATE TABLE above, then this index.
CREATE INDEX IF NOT EXISTS notes_by_origin ON notes(origin_device_id);
-- v4→v5: covers the WHERE superseded_by IS NULL filter that every default
-- listing query now carries. Partial index keeps it small (most notes are
-- heads). Greenfield gets the column from CREATE TABLE; pre-existing dbs
-- get it from the v4→v5 migration which runs before this CREATE INDEX.
CREATE INDEX IF NOT EXISTS notes_by_superseded ON notes(superseded_by) WHERE superseded_by IS NOT NULL;
-- v0.29: partial index for the default-listing sort. Almost no notes are
-- pinned, so the index stays tiny and the "float pinned to top" sort is
-- O(pinned) instead of a full table scan + ORDER BY.
CREATE INDEX IF NOT EXISTS notes_by_pinned ON notes(pinned_at DESC) WHERE is_pinned = 1;
-- sc-15149: per-session listing (GET /api/list?session_key=…). Partial —
-- notes without a session never hit this lookup. Column comes from the
-- v6→v7 migration on upgrades, from CREATE TABLE on greenfield.
CREATE INDEX IF NOT EXISTS notes_by_session ON notes(session_key, created DESC) WHERE session_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_by_tag ON tags(tag);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  id UNINDEXED,
  title,
  headings,
  body,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  note_id TEXT,
  thread_id TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_by_kind_ts ON events(kind, ts DESC);
CREATE INDEX IF NOT EXISTS events_by_note ON events(note_id, ts DESC);
`;

let _db: Database | null = null;

export function db(): Database {
  if (_db) return _db;
  _db = new Database(dbPath(), { create: true });

  // Phase 1: bootstrap — meta table only. Always safe; never references
  // anything that a future migration might add.
  _db.exec(PHASE1_SCHEMA);

  // Greenfield install: no schema_version row yet. Pin to HEAD so the
  // migration loop is a no-op (Phase 2 below creates the latest shape).
  // Pre-existing dbs already have schema_version='1' from older code.
  const row = _db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  if (!row) {
    _db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [HEAD_VERSION]);
  }

  // Migrations between phases: pre-existing dbs get ALTER TABLE for any
  // missing columns BEFORE Phase 2 tries to CREATE INDEX on those columns.
  runMigrations(_db);

  // Phase 2: full schema. CREATE TABLE IF NOT EXISTS is a no-op on
  // existing tables; CREATE INDEX IF NOT EXISTS is a no-op when an
  // earlier migration already created the index. By the time we reach
  // here, every column referenced by every index exists.
  _db.exec(PHASE2_SCHEMA);

  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

export function logEvent(
  kind: string,
  data: Record<string, unknown> = {},
  noteId?: string,
  threadId?: string
): void {
  db().run(
    "INSERT INTO events (ts, kind, note_id, thread_id, data) VALUES (?, ?, ?, ?, ?)",
    [new Date().toISOString(), kind, noteId ?? null, threadId ?? null, JSON.stringify(data)]
  );
}
