/**
 * v0.12.0 → v0.13.0 migration: idempotent addition of `users` table +
 * `user_id` columns + rebuild of notes UNIQUE(user_id, thread_id, slug).
 *
 * Three angles:
 *   1. Fresh install (no pre-existing DB): CLOUD_SCHEMA is the final form,
 *      ensureMultiUserSchema is a no-op.
 *   2. Pre-v0.13 install simulated by stripping user_id and reverting the
 *      notes UNIQUE: ensureMultiUserSchema brings it up cleanly with backfill.
 *   3. Re-running the migrator on an already-migrated DB is fast no-op.
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeCloudDb, cloudDb } from "../src/cloud/db";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-mu-migrate-"));
  process.env.FOLIO_CLOUD_HOME = tmpDir;
});

afterEach(() => {
  closeCloudDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_CLOUD_HOME;
});

function hasColumn(db: Database, table: string, col: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
}

function notesUniqueSql(db: Database): string {
  return db
    .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='notes'")
    .get()?.sql ?? "";
}

test("fresh install: users table seeded with 'default'; user_id columns present", () => {
  const db = cloudDb();
  const defaultUser = db.query<{ id: string; display_name: string }, []>("SELECT id, display_name FROM users WHERE id = 'default'").get();
  expect(defaultUser?.id).toBe("default");
  expect(defaultUser?.display_name).toBe("default");
  for (const t of ["devices", "pairing_codes", "notes", "assets", "tombstones", "shares"]) {
    expect(hasColumn(db, t, "user_id")).toBe(true);
  }
  // UNIQUE on notes is the new shape.
  expect(notesUniqueSql(db)).toMatch(/UNIQUE\s*\(\s*user_id\s*,\s*thread_id\s*,\s*slug\s*\)/i);
});

test("pre-v0.13 schema migrated cleanly with backfill", () => {
  // Build a synthetic pre-v0.13 DB by hand (skipping CLOUD_SCHEMA which is
  // already the final form). Mimic the v0.12.0 shape that's running on prod.
  const dbFile = join(tmpDir, "cloud.sqlite");
  const raw = new Database(dbFile, { create: true });
  raw.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    );
    CREATE TABLE pairing_codes (
      code TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      used_by_device_id TEXT
    );
    CREATE TABLE notes (
      uuid TEXT PRIMARY KEY,
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
      UNIQUE(thread_id, slug)
    );
    CREATE TABLE note_tags (
      note_uuid TEXT NOT NULL REFERENCES notes(uuid) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (note_uuid, tag)
    );
    CREATE TABLE live_entries (
      id TEXT NOT NULL,
      note_uuid TEXT NOT NULL REFERENCES notes(uuid) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      content_html TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      occurred_at TEXT,
      refs_json TEXT NOT NULL DEFAULT '[]',
      importance INTEGER,
      source_ref TEXT,
      server_seq INTEGER NOT NULL,
      PRIMARY KEY (note_uuid, id)
    );
    CREATE TABLE assets (
      hash TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      blob_path TEXT NOT NULL,
      uploaded_at TEXT NOT NULL
    );
    CREATE TABLE tombstones (
      uuid TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      origin_device_id TEXT,
      deleted_at TEXT NOT NULL,
      server_seq INTEGER NOT NULL
    );
    CREATE TABLE shares (
      token TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      created_by_device TEXT NOT NULL REFERENCES devices(id),
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      recipient_email_hash TEXT,
      max_views INTEGER,
      view_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE server_seq (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO server_seq (id, value) VALUES (1, 4);
  `);

  // Seed some v0.12 data: a device, two notes, one asset, one share, one tombstone, one live entry.
  raw.run(
    "INSERT INTO devices (id, name, token_hash, paired_at) VALUES (?, ?, ?, ?)",
    ["dev-1", "old-laptop", "hashval", "2026-05-01T10:00:00Z"]
  );
  raw.run(
    "INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)",
    ["111111", "2026-12-31T00:00:00Z"]
  );
  raw.run(
    `INSERT INTO notes (uuid, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["n-A", "alpha", "morning", "Alpha", "research", "<p>a</p>", "2026-05-02T09:00:00Z", "2026-05-02T09:00:00Z", "dev-1", 1]
  );
  raw.run(
    `INSERT INTO notes (uuid, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["n-B", "beta", "morning", "Beta", "snippet", "<p>b</p>", "2026-05-02T10:00:00Z", "2026-05-02T10:00:00Z", "dev-1", 2]
  );
  raw.run("INSERT INTO note_tags (note_uuid, tag) VALUES (?, ?)", ["n-A", "tag-x"]);
  raw.run(
    "INSERT INTO live_entries (id, note_uuid, ts, content_html, server_seq) VALUES (?, ?, ?, ?, ?)",
    ["e-1", "n-A", "2026-05-02T09:30:00Z", "<p>entry</p>", 3]
  );
  raw.run(
    "INSERT INTO assets (hash, filename, thread_id, content_type, size_bytes, blob_path, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["sha-1", "x.png", "morning", "image/png", 100, "sh/a-/sha-1.png", "2026-05-02T09:00:00Z"]
  );
  raw.run(
    "INSERT INTO tombstones (uuid, thread_id, origin_device_id, deleted_at, server_seq) VALUES (?, ?, ?, ?, ?)",
    ["t-1", "morning", "dev-1", "2026-05-02T11:00:00Z", 4]
  );
  raw.run(
    "INSERT INTO shares (token, scope_type, scope_id, created_by_device, created_at, view_count) VALUES (?, ?, ?, ?, ?, 0)",
    ["s-1-token-long-enough", "note", "n-A", "dev-1", "2026-05-02T12:00:00Z"]
  );
  raw.close();

  // Open via the production code path — should run ensureMultiUserSchema.
  const db = cloudDb();

  // 1. users table seeded.
  expect(db.query<{ id: string }, []>("SELECT id FROM users WHERE id='default'").get()).not.toBeNull();

  // 2. user_id columns present everywhere.
  for (const t of ["devices", "pairing_codes", "notes", "assets", "tombstones", "shares"]) {
    expect(hasColumn(db, t, "user_id")).toBe(true);
  }

  // 3. Existing rows backfilled to 'default'.
  expect(db.query<{ user_id: string }, []>("SELECT user_id FROM devices WHERE id='dev-1'").get()?.user_id).toBe("default");
  expect(db.query<{ user_id: string }, []>("SELECT user_id FROM notes WHERE uuid='n-A'").get()?.user_id).toBe("default");
  expect(db.query<{ user_id: string }, []>("SELECT user_id FROM notes WHERE uuid='n-B'").get()?.user_id).toBe("default");
  expect(db.query<{ user_id: string }, []>("SELECT user_id FROM assets WHERE hash='sha-1'").get()?.user_id).toBe("default");
  expect(db.query<{ user_id: string }, []>("SELECT user_id FROM tombstones WHERE uuid='t-1'").get()?.user_id).toBe("default");
  expect(db.query<{ user_id: string }, []>("SELECT user_id FROM shares WHERE token='s-1-token-long-enough'").get()?.user_id).toBe("default");
  expect(db.query<{ user_id: string }, []>("SELECT user_id FROM pairing_codes WHERE code='111111'").get()?.user_id).toBe("default");

  // 4. Cascade tables untouched (note_tags / live_entries did NOT get cleared
  //    despite the notes-table rebuild — that's the foreign_keys=OFF guarantee).
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM note_tags").get()?.n).toBe(1);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM live_entries").get()?.n).toBe(1);

  // 5. UNIQUE on notes is the new shape.
  expect(notesUniqueSql(db)).toMatch(/UNIQUE\s*\(\s*user_id\s*,\s*thread_id\s*,\s*slug\s*\)/i);

  // 6. server_seq still has value=4 from the seed.
  expect(db.query<{ value: number }, []>("SELECT value FROM server_seq WHERE id=1").get()?.value).toBe(4);
});

test("re-opening an already-migrated DB is a no-op (fast path)", () => {
  // First open creates the schema.
  const db1 = cloudDb();
  expect(db1.query<{ id: string }, []>("SELECT id FROM users WHERE id='default'").get()).not.toBeNull();
  closeCloudDb();

  // Second open — singleton reset, file persists. ensureMultiUserSchema runs
  // again but should see all user_id columns + new UNIQUE; no rebuild.
  const db2 = cloudDb();
  expect(db2.query<{ id: string }, []>("SELECT id FROM users WHERE id='default'").get()).not.toBeNull();
  // Sanity: still the new UNIQUE.
  expect(notesUniqueSql(db2)).toMatch(/UNIQUE\s*\(\s*user_id\s*,\s*thread_id\s*,\s*slug\s*\)/i);
});

test("two users can share a (thread_id, slug) — UNIQUE now (user_id, thread_id, slug)", () => {
  const db = cloudDb();
  db.run("INSERT INTO users (id, display_name, created_at) VALUES ('alice', 'Alice', strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
  db.run("INSERT INTO users (id, display_name, created_at) VALUES ('bob', 'Bob', strftime('%Y-%m-%dT%H:%M:%fZ','now'))");

  // Alice has a morning/journal note.
  db.run(
    `INSERT INTO notes (uuid, user_id, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["n-alice", "alice", "journal", "morning", "Alice's morning", "journal", "<p>a</p>", "2026-05-02T09:00:00Z", "2026-05-02T09:00:00Z", "dev-a", 1]
  );

  // Bob can ALSO have a morning/journal note — same (thread_id, slug),
  // different user_id. Pre-v0.13 this would fail on UNIQUE(thread_id, slug).
  expect(() =>
    db.run(
      `INSERT INTO notes (uuid, user_id, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["n-bob", "bob", "journal", "morning", "Bob's morning", "journal", "<p>b</p>", "2026-05-02T09:00:00Z", "2026-05-02T09:00:00Z", "dev-b", 2]
    )
  ).not.toThrow();

  // Same (user, thread, slug) twice DOES fail.
  expect(() =>
    db.run(
      `INSERT INTO notes (uuid, user_id, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["n-alice-2", "alice", "journal", "morning", "dup", "journal", "<p>x</p>", "2026-05-02T09:00:00Z", "2026-05-02T09:00:00Z", "dev-a", 3]
    )
  ).toThrow();
});

test("createPairingCode + consumePairingCode stamps user_id end-to-end", async () => {
  cloudDb();
  const { createPairingCode, consumePairingCode } = await import("../src/cloud/auth");
  const { cloudDb: getDb } = await import("../src/cloud/db");
  const db = getDb();

  db.run("INSERT INTO users (id, display_name, created_at) VALUES ('alice', 'Alice', strftime('%Y-%m-%dT%H:%M:%fZ','now'))");

  const { code } = createPairingCode("alice");
  const { deviceId } = consumePairingCode(code, "alice-laptop", undefined);

  // The newly-paired device row carries user_id='alice'.
  const row = db.query<{ user_id: string }, [string]>(
    "SELECT user_id FROM devices WHERE id = ?"
  ).get(deviceId);
  expect(row?.user_id).toBe("alice");
});

test("v0.14 migration adds users.is_operator column with DEFAULT 0", () => {
  const db = cloudDb();
  expect(hasColumn(db, "users", "is_operator")).toBe(true);
  // Default user got is_operator = 0 from the column default.
  const row = db.query<{ is_operator: number }, []>("SELECT is_operator FROM users WHERE id = 'default'").get();
  expect(row?.is_operator).toBe(0);
});

test("pre-v0.14 users table (no is_operator) migrated by re-open", () => {
  // Build a synthetic v0.13-shape users table (no is_operator column).
  const dbFile = join(tmpDir, "cloud.sqlite");
  const raw = new Database(dbFile, { create: true });
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    INSERT INTO users (id, display_name, created_at) VALUES ('jarek', 'Jarek', '2026-05-01T10:00:00Z');
    -- All other tables need to exist for ensureMultiUserSchema's PRAGMA probes
    -- not to crash. Minimal shapes:
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL,
      paired_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
      user_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE TABLE pairing_codes (
      code TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_by_device_id TEXT,
      user_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE TABLE notes (
      uuid TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
      slug TEXT NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL,
      type TEXT NOT NULL, body_html TEXT NOT NULL, plain_text TEXT DEFAULT '',
      theme TEXT DEFAULT 'linen', theme_profile TEXT DEFAULT 'hosted',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
      is_final INTEGER DEFAULT 0, live INTEGER DEFAULT 0,
      owner_device_id TEXT, origin_device_id TEXT NOT NULL,
      word_count INTEGER DEFAULT 0, summary TEXT, server_seq INTEGER NOT NULL,
      UNIQUE(user_id, thread_id, slug)
    );
    CREATE TABLE note_tags (note_uuid TEXT, tag TEXT, PRIMARY KEY (note_uuid, tag));
    CREATE TABLE live_entries (id TEXT, note_uuid TEXT, ts TEXT, content_html TEXT, tags_json TEXT, occurred_at TEXT, refs_json TEXT, importance INTEGER, source_ref TEXT, server_seq INTEGER, PRIMARY KEY (note_uuid, id));
    CREATE TABLE assets (hash TEXT PRIMARY KEY, filename TEXT, thread_id TEXT, user_id TEXT NOT NULL DEFAULT 'default', content_type TEXT, size_bytes INTEGER, blob_path TEXT, uploaded_at TEXT);
    CREATE TABLE tombstones (uuid TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', thread_id TEXT, origin_device_id TEXT, deleted_at TEXT, server_seq INTEGER);
    CREATE TABLE shares (token TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', scope_type TEXT, scope_id TEXT, created_by_device TEXT, created_at TEXT, expires_at TEXT, revoked_at TEXT, recipient_email_hash TEXT, max_views INTEGER, view_count INTEGER);
    CREATE TABLE server_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL DEFAULT 0);
    INSERT INTO server_seq (id, value) VALUES (1, 0);
  `);
  raw.close();

  const db = cloudDb();
  expect(hasColumn(db, "users", "is_operator")).toBe(true);
  // Existing 'jarek' row migrated to is_operator=0 (default value).
  const jarek = db.query<{ is_operator: number }, []>("SELECT is_operator FROM users WHERE id = 'jarek'").get();
  expect(jarek?.is_operator).toBe(0);
});

test("authenticate() returns Device.isOperator from users.is_operator", async () => {
  cloudDb();
  const db = cloudDb();
  db.run("INSERT INTO users (id, display_name, is_operator, created_at) VALUES ('jarek', 'Jarek', 1, '2026-05-01T10:00:00Z')");
  const { createPairingCode, consumePairingCode, authenticate } = await import("../src/cloud/auth");
  const { code } = createPairingCode("jarek");
  const { token } = consumePairingCode(code, "jarek-laptop", undefined);
  const dev = authenticate(token!);
  expect(dev).not.toBeNull();
  expect(dev?.userId).toBe("jarek");
  expect(dev?.isOperator).toBe(true);
});

test("createPairingCode without --user defaults to 'default'", async () => {
  cloudDb();
  const { createPairingCode, consumePairingCode } = await import("../src/cloud/auth");
  const { cloudDb: getDb } = await import("../src/cloud/db");
  const db = getDb();

  const { code, userId } = createPairingCode(); // no userId param
  expect(userId).toBe("default");
  const { deviceId } = consumePairingCode(code, "legacy-laptop", undefined);

  const row = db.query<{ user_id: string }, [string]>(
    "SELECT user_id FROM devices WHERE id = ?"
  ).get(deviceId);
  expect(row?.user_id).toBe("default");
});

test("regression v0.18.1: v0.13-era DB (new UNIQUE, no inline_render) gets inline_render added on next boot", async () => {
  // Reproduce production bug from folio.notibox.ai: the cloud was first
  // installed at v0.13/v0.14, so its notes table was created with the new
  // UNIQUE(user_id, thread_id, slug) constraint baked in BUT without the
  // v0.17 inline_render column (which wasn't in CLOUD_SCHEMA back then).
  // The old migrator had `if (hasNewUnique) return;` BEFORE the
  // inline_render ALTER, so on every reboot the ALTER was silently
  // skipped → /raw/:uuid 500'd with "no such column: inline_render".
  //
  // This test seeds that exact pre-condition (multi-user schema + no
  // inline_render column) and asserts that opening the DB through
  // cloudDb() runs the migrator and adds the column.
  const dbFile = join(tmpDir, "cloud.sqlite");
  const raw = new Database(dbFile, { create: true });
  raw.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      is_operator INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users (id, display_name, created_at) VALUES ('default', 'default', '2026-05-01T10:00:00Z');
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT,
      user_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE TABLE pairing_codes (
      code TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      used_by_device_id TEXT,
      user_id TEXT NOT NULL DEFAULT 'default'
    );
    -- notes table built with v0.13 multi-user UNIQUE but no inline_render column.
    CREATE TABLE notes (
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
    CREATE TABLE note_tags (
      note_uuid TEXT NOT NULL REFERENCES notes(uuid) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (note_uuid, tag)
    );
    CREATE TABLE live_entries (
      id TEXT NOT NULL,
      note_uuid TEXT NOT NULL REFERENCES notes(uuid) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      content_html TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      occurred_at TEXT,
      refs_json TEXT NOT NULL DEFAULT '[]',
      importance INTEGER,
      source_ref TEXT,
      server_seq INTEGER NOT NULL,
      PRIMARY KEY (note_uuid, id)
    );
    CREATE TABLE assets (
      hash TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      blob_path TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE TABLE tombstones (
      uuid TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      origin_device_id TEXT,
      deleted_at TEXT NOT NULL,
      server_seq INTEGER NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE TABLE shares (
      token TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      created_by_device TEXT NOT NULL REFERENCES devices(id),
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      recipient_email_hash TEXT,
      max_views INTEGER,
      view_count INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE TABLE server_seq (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO server_seq (id, value) VALUES (1, 0);
  `);
  // Confirm pre-condition: inline_render absent, new UNIQUE present.
  expect(hasColumn(raw, "notes", "inline_render")).toBe(false);
  expect(notesUniqueSql(raw)).toMatch(/UNIQUE\s*\(\s*user_id\s*,\s*thread_id\s*,\s*slug\s*\)/i);
  raw.close();

  // Boot through cloudDb() — migrator should now ALWAYS reach the
  // inline_render ALTER, even when the UNIQUE rebuild branch was skipped.
  const db = cloudDb();
  expect(hasColumn(db, "notes", "inline_render")).toBe(true);

  // Default value works as expected for a row insert that doesn't set it.
  db.run(
    `INSERT INTO notes (uuid, user_id, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["n-test", "default", "x", "t", "x", "snippet", "<p>x</p>", "2026-05-14T10:00:00Z", "2026-05-14T10:00:00Z", "d-1", 1]
  );
  const row = db.query<{ inline_render: number }, [string]>("SELECT inline_render FROM notes WHERE uuid = ?").get("n-test");
  expect(row?.inline_render).toBe(0);
});
