// Schema migration framework.
//
// db.ts uses a TWO-PHASE bootstrap (since v0.9.1):
//   PHASE1_SCHEMA      meta table only — always safe, no column refs anywhere
//   runMigrations()    ALTER TABLE ADD COLUMN for every column added since the
//                      db was last opened. Greenfield installs skip this loop
//                      because schema_version is seeded at HEAD before it runs.
//   PHASE2_SCHEMA      tables + indexes — at this point every column referenced
//                      by an index has either always existed or just been added
//                      by a migration. CREATE INDEX IF NOT EXISTS is safe.
//
// THE LOAD-BEARING RULE for any schema change that touches existing tables:
//
//   1. New columns go ONLY via a migration's up() — never inline in
//      PHASE1_SCHEMA or PHASE2_SCHEMA's CREATE TABLE block alone, because
//      CREATE TABLE IF NOT EXISTS is a no-op on existing tables (the new
//      column would never reach pre-existing dbs).
//
//      Caveat: also list the column in PHASE2_SCHEMA's CREATE TABLE so
//      greenfield installs get the head shape directly. The migration
//      handles upgrades; the CREATE TABLE handles fresh installs. Both
//      converge to the same schema.
//
//   2. New indexes that reference the new column go in PHASE2_SCHEMA, not
//      in the migration's up(). PHASE2 runs AFTER migrations on existing
//      dbs, so the column is guaranteed to exist by then. CREATE INDEX
//      IF NOT EXISTS in PHASE2 is the canonical place for all indexes.
//
//      Why not put the index in the migration too? Because greenfield
//      installs skip migrations entirely — the index would never get
//      created. Putting it in PHASE2 covers both paths.
//
//   3. Never edit a shipped migration's up(). Append a new entry to
//      MIGRATIONS instead. A user who's at schema_version='3' will not
//      re-run migration 1→2; if you "fix" 1→2 after shipping, users
//      on >=3 never see the fix.
//
// The v0.9.0 → v0.9.1 hotfix is the cautionary tale: notes_by_live was
// declared in BASE_SCHEMA next to the CREATE TABLE that should have added
// `live`. CREATE TABLE IF NOT EXISTS was a no-op on existing tables, so
// the column wasn't there, and CREATE INDEX hit "no such column: live"
// on every upgrade.
//
// Pattern: each migration has {from, to, up}. Runner reads
// meta.schema_version, applies any migration whose `from` matches the
// current version, bumps to `to`, repeats until no migration applies.
// Migrations must be idempotent (use PRAGMA table_info to check before
// ALTER) so a partial run + re-run still converges.

import type { Database } from "bun:sqlite";

export interface Migration {
  /** Current schema_version this migration applies to (string). */
  from: string;
  /** schema_version after `up` runs successfully. */
  to: string;
  /** What changed and why — surfaces in commit/PR review and migration log. */
  description: string;
  /** Idempotent DDL/DML. Must be safe to re-run on a partially-migrated db. */
  up: (db: Database) => void;
}

/**
 * Check whether the `notes` table already has a given column.
 * SQLite has no `ALTER TABLE ADD COLUMN IF NOT EXISTS`, so migrations
 * gate ALTER on this.
 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

export const MIGRATIONS: Migration[] = [
  {
    from: "1",
    to: "2",
    description: "Add live + last_entry_at columns to notes (v0.9.0 live notes primitive)",
    up: (db) => {
      if (!hasColumn(db, "notes", "live")) {
        db.exec("ALTER TABLE notes ADD COLUMN live INTEGER NOT NULL DEFAULT 0");
      }
      if (!hasColumn(db, "notes", "last_entry_at")) {
        db.exec("ALTER TABLE notes ADD COLUMN last_entry_at TEXT");
      }
    },
  },
  {
    from: "2",
    to: "3",
    description:
      "Add origin_device_id + owner_device_id columns to notes (multi-writer sync, W2). " +
      "origin_device_id tracks which device created the note (skip own-echo on pull); " +
      "owner_device_id is set for live notes only and gates append_entry to that device.",
    up: (db) => {
      if (!hasColumn(db, "notes", "origin_device_id")) {
        db.exec("ALTER TABLE notes ADD COLUMN origin_device_id TEXT");
      }
      if (!hasColumn(db, "notes", "owner_device_id")) {
        db.exec("ALTER TABLE notes ADD COLUMN owner_device_id TEXT");
      }
      // notes_by_origin index lives in PHASE2_SCHEMA (db.ts) — runs after
      // this migration has added the column. v0.9.1's two-phase bootstrap
      // makes this safe for greenfield (column from CREATE TABLE) and
      // upgrades (column from this ALTER) alike.
      // Backfill: existing notes were created on this device (nobody else
      // had access to ~/Folio/ prior to W2 sync). Live notes also get
      // owner_device_id = self so append_entry continues to work for them.
      // We do this BEFORE the cli/cloud paths fill in via getOrCreateDeviceId,
      // so we resolve device id here too (sync, same source of truth).
      const { getOrCreateDeviceId } = require("./config") as typeof import("./config");
      const dev = getOrCreateDeviceId();
      db.run("UPDATE notes SET origin_device_id = ? WHERE origin_device_id IS NULL", [dev.id]);
      db.run("UPDATE notes SET owner_device_id = ? WHERE live = 1 AND owner_device_id IS NULL", [dev.id]);
    },
  },
  {
    from: "3",
    to: "4",
    description:
      "Add inline_render column to notes (v0.17.0). When 1, a live note's " +
      "entries are spliced directly into body_html at /raw/ render time + " +
      "parent chrome postMessages new entries into the body iframe — no " +
      "side panel. Default 0: live notes keep using the side panel.",
    up: (db) => {
      if (!hasColumn(db, "notes", "inline_render")) {
        db.exec("ALTER TABLE notes ADD COLUMN inline_render INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    from: "4",
    to: "5",
    description:
      "Add superseded_by column to notes (v0.22 `replace` primitive). " +
      "When a note is replaced via replaceNote(), the old note's " +
      "superseded_by is set to the new note's id. The old .html file is " +
      "preserved verbatim — capability URLs stay valid — but listings, " +
      "thread views, and search hide superseded notes by default. " +
      "Null = head version. Backfill is a no-op (existing notes are all " +
      "heads since `replace` is new in this release).",
    up: (db) => {
      if (!hasColumn(db, "notes", "superseded_by")) {
        db.exec("ALTER TABLE notes ADD COLUMN superseded_by TEXT");
      }
    },
  },
  {
    from: "5",
    to: "6",
    description:
      "Add is_pinned + pinned_at columns to notes (v0.29 user-pinned notes). " +
      "is_pinned floats a note to the top of the default listing; pinned_at " +
      "is the ISO timestamp when the user toggled it on, so multiple pinned " +
      "notes sort by *when they were pinned* (not by their creation date) — " +
      "freshly pinned floats above long-pinned. NULL when not pinned. " +
      "Distinct from is_final (★ archive) and from view:pinned (entry-level " +
      "tag on live notes). Backfill is a no-op — pre-existing notes are " +
      "unpinned by default.",
    up: (db) => {
      if (!hasColumn(db, "notes", "is_pinned")) {
        db.exec("ALTER TABLE notes ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
      }
      if (!hasColumn(db, "notes", "pinned_at")) {
        db.exec("ALTER TABLE notes ADD COLUMN pinned_at TEXT");
      }
    },
  },
  {
    from: "6",
    to: "7",
    description:
      "Add session_key column to notes (sc-15149). Optional key of the agent " +
      "chat session the note was created in (e.g. a Kokpit topic). Lets a " +
      "chat client list a session's notes even when the note link was never " +
      "pasted into the conversation. NULL = unknown session — every note " +
      "created before this migration, and every note whose creator did not " +
      "pass one. Backfill is a no-op: there is no source of truth for the " +
      "session of an old note, and guessing would attach notes to the wrong " +
      "chat.",
    up: (db) => {
      if (!hasColumn(db, "notes", "session_key")) {
        db.exec("ALTER TABLE notes ADD COLUMN session_key TEXT");
      }
      // notes_by_session index lives in PHASE2_SCHEMA (db.ts) — runs after
      // this ALTER on upgrades, from CREATE TABLE on greenfield.
    },
  },
];

/**
 * Apply any pending migrations. Called from db() on connection open,
 * AFTER BASE_SCHEMA runs (so freshly-created tables have the latest shape;
 * migrations only fire on existing dbs that were created before this code).
 */
export function runMigrations(db: Database): void {
  // Ensure meta has a schema_version row. Greenfield: BASE_SCHEMA created
  // notes with the latest columns, so we can jump straight to the head
  // version. Pre-existing dbs without meta row are treated as version "1".
  let current = db
    .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get()?.value;

  if (!current) {
    // Existing db (pre-v0.9.0) that ran on the old code path — its
    // `notes` table may already have `live` if the user is running this
    // upgraded code on a fresh box. Either way, start the loop at "1"
    // and let the migration's hasColumn guard do the right thing.
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    current = "1";
  }

  // Apply migrations greedily until no match.
  // Cap iterations so a misconfigured migration ring doesn't loop forever.
  let safety = MIGRATIONS.length + 1;
  while (safety-- > 0) {
    const m = MIGRATIONS.find((mig) => mig.from === current);
    if (!m) break;
    m.up(db);
    db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [m.to]);
    current = m.to;
  }
}

/**
 * Head version. Used by db.ts after running BASE_SCHEMA on a brand-new db
 * so we don't pointlessly invoke migrations on a table that was just
 * created with the head shape.
 */
export const HEAD_VERSION = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1]!.to : "1";
