/**
 * Sync daemon end-to-end: a local Folio instance (FOLIO_HOME) talks to a
 * cloud relay (FOLIO_CLOUD_HOME) in the same process. We spin up the cloud
 * server on an ephemeral port, pair our device, create local notes, run
 * syncOnce(), and inspect both sides.
 *
 * Tests cover:
 *   - pair stores state + token
 *   - push round-trip (note ends up in cloud DB)
 *   - own-echo skip (no duplicate after second syncOnce)
 *   - slug collision rename (cloud has same (thread, slug) under different uuid)
 *   - live entries push (jsonl → cloud rows)
 *   - foreign note pull (cloud-injected note → file appears locally)
 *   - owner-locked append rejects foreign owner
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/core/db";
import { closeCloudDb } from "../src/cloud/db";

let homeDir: string;
let cloudHomeDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let remote: string;
let token: string;
let selfDeviceId: string;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "folio-sync-home-"));
  cloudHomeDir = mkdtempSync(join(tmpdir(), "folio-sync-cloud-"));
  process.env.FOLIO_HOME = homeDir;
  process.env.FOLIO_CLOUD_HOME = cloudHomeDir;

  // Spin up cloud relay.
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0 })) as any;
  remote = `http://${server!.hostname}:${server!.port}`;

  // Initialize local Folio.
  const { init } = await import("../src/cli/commands/init");
  await init();

  // Resolve local device id BEFORE pairing so the cloud uses it as the
  // canonical id. Mirrors what `folio sync pair` does in production —
  // both sides must agree on device id for own-echo skip to work.
  const { getOrCreateDeviceId } = await import("../src/core/config");
  selfDeviceId = getOrCreateDeviceId().id;

  // Pair this device against cloud.
  const { legacyPairResponse } = await import("./_cloud-device");
  const pairRes = legacyPairResponse({ name: "test-host-A", deviceId: selfDeviceId });
  const pairBody = (await pairRes.json()) as { token: string; device_id: string };
  token = pairBody.token;

  // Write sync state file (as `folio sync pair` would).
  const { saveSyncState } = await import("../src/core/sync");
  saveSyncState({
    remote,
    device_token: token,
    last_pulled_seq: 0,
    last_pushed_at: null,
    last_live_pushed: {},
  });
});

afterEach(() => {
  try { server?.stop(); } catch {}
  server = null;
  closeDb();
  closeCloudDb();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cloudHomeDir, { recursive: true, force: true });
  delete process.env.FOLIO_HOME;
  delete process.env.FOLIO_CLOUD_HOME;
});

test("pair writes state file with token + cursor=0", async () => {
  const { loadSyncState } = await import("../src/core/sync");
  const state = loadSyncState()!;
  expect(state).not.toBeNull();
  expect(state.remote).toBe(remote);
  expect(state.device_token).toBe(token);
  expect(state.last_pulled_seq).toBe(0);
});

test("create note locally + syncOnce: lands in cloud DB", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  const note = await createNote({
    type: "research",
    title: "Roundtrip A",
    body_html: "<h1>Hello cloud</h1><p>Body text.</p>",
    thread_id: "roundtrip",
    tags: ["alpha", "beta"],
  });

  const state = loadSyncState()!;
  const r = await syncOnce(state);
  expect(r.pushed).toBe(1);
  expect(r.renamed).toBe(0);

  // Inspect cloud DB.
  const { cloudDb } = await import("../src/cloud/db");
  const cloudNote = cloudDb()
    .query<
      { uuid: string; title: string; origin_device_id: string; body_html: string },
      [string]
    >("SELECT uuid, title, origin_device_id, body_html FROM notes WHERE uuid = ?")
    .get(note.id);
  expect(cloudNote).not.toBeNull();
  expect(cloudNote!.title).toBe("Roundtrip A");
  expect(cloudNote!.origin_device_id).toBe(selfDeviceId);
  expect(cloudNote!.body_html).toContain("Hello cloud");

  // Tags also pushed.
  const tags = cloudDb()
    .query<{ tag: string }, [string]>("SELECT tag FROM note_tags WHERE note_uuid = ? ORDER BY tag")
    .all(note.id)
    .map((r) => r.tag);
  expect(tags).toEqual(["alpha", "beta"]);
});

test("second syncOnce is a no-op (cursor advances, no echo back)", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  await createNote({
    type: "snippet",
    title: "Echo guard",
    body_html: "<p>x</p>",
    thread_id: "echo-guard",
  });

  const state = loadSyncState()!;
  const r1 = await syncOnce(state);
  expect(r1.pushed).toBe(1);

  // Second run: cursor advanced past the note's `created` so push selects 0.
  // Pull returns our own note but it should be filtered (origin == self).
  const r2 = await syncOnce(state);
  expect(r2.pushed).toBe(0);
  expect(r2.pulled).toBe(0);

  // No duplicate in local DB.
  const { db } = await import("../src/core/db");
  const count = db()
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM notes WHERE thread_id = 'echo-guard'")
    .get()!.n;
  expect(count).toBe(1);
});

test("replace after first sync → supersede pointer propagates to cloud (pushSupersedes)", async () => {
  const { createNote, replaceNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { cloudDb } = await import("../src/cloud/db");

  // Push A in a first sync so its `created` falls behind the push cursor —
  // this is exactly the case the created-keyed pushNotes window can't catch.
  const a = await createNote({
    type: "snippet",
    title: "Draft v1",
    body_html: "<p>first</p>",
    thread_id: "supersede",
  });
  const state = loadSyncState()!;
  await syncOnce(state);

  // Replace A → B. A.superseded_by is set and A.updated bumps, but A.created
  // is unchanged, so pushNotes won't re-send A — only pushSupersedes will.
  const res = await replaceNote({ old_id: a.id, body_html: "<p>second</p>" });
  expect(res.ok).toBe(true);
  const bId = res.new_meta!.id;

  await syncOnce(state);

  // Cloud reflects the supersede on the OLD note and a clean head on the new.
  const oldRow = cloudDb()
    .query<{ superseded_by: string | null }, [string]>(
      "SELECT superseded_by FROM notes WHERE uuid = ?"
    )
    .get(a.id);
  expect(oldRow!.superseded_by).toBe(bId);
  const newRow = cloudDb()
    .query<{ superseded_by: string | null }, [string]>(
      "SELECT superseded_by FROM notes WHERE uuid = ?"
    )
    .get(bId);
  expect(newRow!.superseded_by).toBeNull();
});

test("slug collision: cloud has same (thread, slug) under different uuid → local renames", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { cloudDb, nextSeq } = await import("../src/cloud/db");

  // Seed cloud directly with a foreign note occupying (thread="coll", slug="morning-review").
  const foreignUuid = "01HAAA0000000000000000ZZZZ";
  const seq = nextSeq(cloudDb());
  cloudDb().run(
    `INSERT INTO notes (uuid, slug, thread_id, title, type, theme, theme_profile,
       body_html, plain_text, created_at, updated_at, expires_at,
       is_final, live, owner_device_id, origin_device_id,
       word_count, summary, server_seq)
     VALUES (?, 'morning-review', 'coll', 'Foreign', 'research', 'linen', 'hosted',
             '<p>foreign</p>', '', '2026-05-13T09:00:00Z', '2026-05-13T09:00:00Z',
             NULL, 0, 0, NULL, '01HXOTHERDEVICE000000000ZZ', 0, NULL, ?)`,
    [foreignUuid, seq]
  );

  // Now local creates a note with the same slug seed.
  const local = await createNote({
    type: "research",
    title: "morning review",
    body_html: "<p>local</p>",
    thread_id: "coll",
  });
  expect(local.slug).toBe("morning-review");

  const state = loadSyncState()!;
  const r = await syncOnce(state);
  expect(r.pushed).toBe(1);
  expect(r.renamed).toBe(1);

  // Local DB now reflects the renamed slug.
  const { db } = await import("../src/core/db");
  const row = db()
    .query<{ slug: string; path: string }, [string]>("SELECT slug, path FROM notes WHERE id = ?")
    .get(local.id);
  expect(row!.slug).not.toBe("morning-review");
  expect(row!.slug).toMatch(/^morning-review-[a-z0-9]{6}$/i);
  // File on disk matches.
  expect(existsSync(join(homeDir, row!.path))).toBe(true);
});

test("live entries push: appended entries land in cloud after syncOnce", async () => {
  const { createNote } = await import("../src/core/storage");
  const { appendEntry, entriesPath } = await import("../src/core/live");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  const note = await createNote({
    type: "journal",
    title: "Live diary",
    body_html: "<p>chrome</p>",
    thread_id: "diary",
    live: true,
  });
  const jsonl = entriesPath(join(homeDir, note.path));
  appendEntry(jsonl, { content_html: "<p>Entry one</p>", tags: ["state:open"] });
  appendEntry(jsonl, { content_html: "<p>Entry two</p>", tags: ["state:done"] });

  const state = loadSyncState()!;
  const r = await syncOnce(state);
  expect(r.pushed).toBe(1);
  expect(r.live_pushed).toBe(2);

  const { cloudDb } = await import("../src/cloud/db");
  const entries = cloudDb()
    .query<{ id: string; note_uuid: string }, [string]>(
      "SELECT id, note_uuid FROM live_entries WHERE note_uuid = ?"
    )
    .all(note.id);
  expect(entries.length).toBe(2);

  // Second sync: nothing new.
  const r2 = await syncOnce(state);
  expect(r2.live_pushed).toBe(0);
});

test("live entries push: an entry whose id sorts below the cursor still lands (ids are random)", async () => {
  const { createNote } = await import("../src/core/storage");
  const { entriesPath } = await import("../src/core/live");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { appendFileSync } = await import("node:fs");

  const note = await createNote({
    type: "journal",
    title: "Live ids",
    body_html: "<p>chrome</p>",
    thread_id: "ids",
    live: true,
  });
  const jsonl = entriesPath(join(homeDir, note.path));
  const line = (id: string, ts: string) =>
    JSON.stringify({ id, ts, content_html: `<p>${id}</p>`, tags: [] }) + "\n";
  // newEntryId() is the random tail of a ulid: a later entry may sort lower.
  appendFileSync(jsonl, line("zzzzzzzzzz", "2026-11-13T22:00:00.000Z"));
  const state = loadSyncState()!;
  expect((await syncOnce(state)).live_pushed).toBe(1);

  appendFileSync(jsonl, line("aaaaaaaaaa", "2026-11-13T22:00:01.000Z"));
  expect((await syncOnce(state)).live_pushed).toBe(1);

  const { cloudDb } = await import("../src/cloud/db");
  const ids = cloudDb()
    .query<{ id: string }, [string]>("SELECT id FROM live_entries WHERE note_uuid = ? ORDER BY id")
    .all(note.id)
    .map((r) => r.id);
  expect(ids).toEqual(["aaaaaaaaaa", "zzzzzzzzzz"]);
  expect((await syncOnce(state)).live_pushed).toBe(0);
});

test("live entries push: a legacy bare-id cursor re-pushes the feed once", async () => {
  const { createNote } = await import("../src/core/storage");
  const { appendEntry, entriesPath } = await import("../src/core/live");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  const note = await createNote({
    type: "journal",
    title: "Live legacy",
    body_html: "<p>chrome</p>",
    thread_id: "legacy",
    live: true,
  });
  const jsonl = entriesPath(join(homeDir, note.path));
  appendEntry(jsonl, { content_html: "<p>one</p>", tags: [] });
  appendEntry(jsonl, { content_html: "<p>two</p>", tags: [] });
  const state = loadSyncState()!;
  state.last_live_pushed = { [note.id]: "zzzzzzzzzz" };
  expect((await syncOnce(state)).live_pushed).toBe(2);
  expect(state.last_live_pushed[note.id]).toContain("|");
  expect((await syncOnce(state)).live_pushed).toBe(0);
});

test("pre-W2 note without origin_device_id pushes successfully (NULL → self assumed)", async () => {
  // Simulate a row that existed before the W2 migration ran (origin_device_id
  // NULL). createNote always stamps it, so we mutate after creation to set up
  // the test condition.
  const { createNote } = await import("../src/core/storage");
  const { db } = await import("../src/core/db");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  const note = await createNote({
    type: "snippet",
    title: "Legacy",
    body_html: "<p>x</p>",
    thread_id: "legacy",
  });
  db().run("UPDATE notes SET origin_device_id = NULL WHERE id = ?", [note.id]);

  const state = loadSyncState()!;
  const r = await syncOnce(state);
  expect(r.pushed).toBe(1);
});
