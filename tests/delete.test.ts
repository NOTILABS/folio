import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/core/db";
import { closeCloudDb } from "../src/cloud/db";

let homeDir: string;
let cloudHomeDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let token: string;
let baseUrl: string;
let selfDeviceId: string;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "folio-delete-home-"));
  cloudHomeDir = mkdtempSync(join(tmpdir(), "folio-delete-cloud-"));
  process.env.FOLIO_HOME = homeDir;
  process.env.FOLIO_CLOUD_HOME = cloudHomeDir;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0 })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;
  const { init } = await import("../src/cli/commands/init");
  await init();
  const { getOrCreateDeviceId } = await import("../src/core/config");
  selfDeviceId = getOrCreateDeviceId().id;
  const { legacyPairResponse } = await import("./_cloud-device");
  const pairRes = legacyPairResponse({ name: "test", deviceId: selfDeviceId });
  token = ((await pairRes.json()) as { token: string }).token;
  const { saveSyncState } = await import("../src/core/sync");
  saveSyncState({
    remote: baseUrl,
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

test("deleteNote: file moved to .trash/, status='trashed', FTS row removed", async () => {
  const { createNote, deleteNote, getNoteMeta } = await import("../src/core/storage");
  const { db } = await import("../src/core/db");

  const note = await createNote({
    type: "snippet",
    title: "To delete",
    body_html: "<p>doomed</p>",
    thread_id: "del-test",
  });
  const filePath = join(homeDir, note.path);
  expect(existsSync(filePath)).toBe(true);

  const res = deleteNote(note.id);
  expect(res.ok).toBe(true);

  // File is gone from original location, trash holds it.
  expect(existsSync(filePath)).toBe(false);
  expect(existsSync(join(homeDir, ".trash", note.id, "note.html"))).toBe(true);

  // DB status flipped; getNoteMeta filters status='active'.
  expect(getNoteMeta(note.id)).toBeNull();
  const row = db()
    .query<{ status: string }, [string]>("SELECT status FROM notes WHERE id = ?")
    .get(note.id);
  expect(row?.status).toBe("trashed");

  // FTS row removed → search doesn't surface it.
  const fts = db()
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM notes_fts WHERE id = ?")
    .get(note.id);
  expect(fts?.n).toBe(0);
});

test("deleteNote: unknown id returns not-found", async () => {
  const { deleteNote } = await import("../src/core/storage");
  const res = deleteNote("01HXNONE");
  expect(res.ok).toBe(false);
  expect(res.reason).toBe("not-found");
});

test("deleteNote: live note also archives its .entries.jsonl", async () => {
  const { createNote, deleteNote } = await import("../src/core/storage");
  const { appendEntry, entriesPath } = await import("../src/core/live");

  const note = await createNote({
    type: "journal",
    title: "Doomed live",
    body_html: "<p>chrome</p>",
    thread_id: "del-live",
    live: true,
  });
  const jsonl = entriesPath(join(homeDir, note.path));
  appendEntry(jsonl, { content_html: "<p>entry 1</p>" });
  expect(existsSync(jsonl)).toBe(true);

  deleteNote(note.id);

  expect(existsSync(jsonl)).toBe(false);
  expect(existsSync(join(homeDir, ".trash", note.id, "entries.jsonl"))).toBe(true);
});

test("sync pushes deletion: cloud row removed after local delete + syncOnce", async () => {
  const { createNote, deleteNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { cloudDb } = await import("../src/cloud/db");

  // 1. Create + sync — cloud has the note.
  const note = await createNote({
    type: "snippet",
    title: "Sync then delete",
    body_html: "<p>x</p>",
    thread_id: "sync-del",
  });
  let state = loadSyncState()!;
  await syncOnce(state);

  expect(
    cloudDb()
      .query<{ uuid: string }, [string]>("SELECT uuid FROM notes WHERE uuid = ?")
      .get(note.id)
  ).not.toBeNull();

  // 2. Local delete + sync — cloud row removed.
  deleteNote(note.id);
  state = loadSyncState()!;
  const r = await syncOnce(state);
  expect(r.deleted).toBe(1);

  expect(
    cloudDb()
      .query<{ uuid: string }, [string]>("SELECT uuid FROM notes WHERE uuid = ?")
      .get(note.id)
  ).toBeNull();

  // 3. Re-running sync is idempotent: cursor advanced, nothing to push again.
  const r2 = await syncOnce(state);
  expect(r2.deleted).toBe(0);
});

test("CLI folio delete: happy path with --yes bypasses prompt", async () => {
  const { createNote } = await import("../src/core/storage");
  const { deleteCmd } = await import("../src/cli/commands/delete");

  const note = await createNote({
    type: "snippet",
    title: "Via CLI",
    body_html: "<p>x</p>",
    thread_id: "cli-del",
  });
  const code = await deleteCmd({ id: note.id, yes: true });
  expect(code).toBe(0);

  expect(existsSync(join(homeDir, note.path))).toBe(false);
  expect(existsSync(join(homeDir, ".trash", note.id, "note.html"))).toBe(true);
});

test("delete push: second sync after a local delete is a no-op", async () => {
  // Create + sync own note, then delete locally + sync, then sync AGAIN —
  // nothing comes back (no pull since sc-24120) and the note stays gone.
  const { createNote, getNoteMeta, deleteNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  const note = await createNote({
    type: "snippet",
    title: "Own delete cycle",
    body_html: "<p>x</p>",
    thread_id: "tombstones",
  });
  await syncOnce(loadSyncState()!);

  deleteNote(note.id);
  const r1 = await syncOnce(loadSyncState()!);
  expect(r1.deleted).toBe(1);
  expect(r1.deletes_applied).toBe(0); // own delete, not via tombstone

  const r2 = await syncOnce(loadSyncState()!);
  expect(r2.deletes_applied).toBe(0);
  expect(getNoteMeta(note.id)).toBeNull(); // still gone, idempotent
});

test("viewer /api/notes/:id/delete: POST returns deleted + soft-deletes the note", async () => {
  // Spin up a viewer alongside the cloud server (port 0).
  const { writeFileSync, readFileSync } = await import("node:fs");
  const cfgPath = join(homeDir, "folio.config.json");
  const parsed = JSON.parse(readFileSync(cfgPath, "utf-8"));
  parsed.viewer_port = 0;
  writeFileSync(cfgPath, JSON.stringify(parsed));

  const { createNote } = await import("../src/core/storage");
  const note = await createNote({
    type: "snippet",
    title: "via viewer",
    body_html: "<p>x</p>",
    thread_id: "viewer-del",
  });

  const { startServer } = await import("../src/viewer/server");
  const viewer = (await startServer()) as any;
  try {
    const res = await fetch(
      `http://${viewer.hostname}:${viewer.port}/api/notes/${note.id}/delete`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string };
    expect(body.deleted).toBe(note.id);

    // File moved.
    expect(existsSync(join(homeDir, note.path))).toBe(false);
    expect(existsSync(join(homeDir, ".trash", note.id, "note.html"))).toBe(true);

    // Second delete returns 404 (already trashed, getNoteMeta returns null).
    const res2 = await fetch(
      `http://${viewer.hostname}:${viewer.port}/api/notes/${note.id}/delete`,
      { method: "POST" }
    );
    expect(res2.status).toBe(404);
  } finally {
    try { viewer.stop(); } catch {}
  }
});
