/**
 * sc-24117 part A — `sync_scope: "shared"` ("publish-only" sync).
 *
 * In this mode `syncOnce` must push ONLY the notes covered by this device's
 * own active shares (note/thread/set, including the replace-chain / linked
 * set rules the cloud itself enforces) and must never `pullNotes` — the box
 * stays the source of truth, the cloud is a one-way publish relay.
 *
 * Fixtures mirror tests/sync-daemon.test.ts and tests/publish-sync.test.ts:
 * a real cloud relay (src/cloud/server.ts) in-process, a real paired device,
 * real local storage under a temp FOLIO_HOME.
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/core/db";
import { closeCloudDb } from "../src/cloud/db";

let homeDir: string;
let cloudHomeDir: string;
let server: { stop: (force?: boolean) => void; port: number; hostname: string } | null = null;
let baseUrl: string;
let token: string;
let selfDeviceId: string;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "folio-shared-home-"));
  cloudHomeDir = mkdtempSync(join(tmpdir(), "folio-shared-cloud-"));
  process.env.FOLIO_HOME = homeDir;
  process.env.FOLIO_CLOUD_HOME = cloudHomeDir;

  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0 })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;

  const { init } = await import("../src/cli/commands/init");
  await init();

  const { getOrCreateDeviceId, saveConfig, loadConfig } = await import("../src/core/config");
  selfDeviceId = getOrCreateDeviceId().id;
  await saveConfig({ ...(await loadConfig()), auto_sync: false, sync_scope: "shared" });

  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  const pairRes = await fetch(`${baseUrl}/v1/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, device_name: "test", device_id: selfDeviceId }),
  });
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
  try { server?.stop(true); } catch {}
  server = null;
  closeDb();
  closeCloudDb();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cloudHomeDir, { recursive: true, force: true });
  delete process.env.FOLIO_HOME;
  delete process.env.FOLIO_CLOUD_HOME;
});

/** The share URL carries the cloud's configured public host; the test cloud
 *  listens on an ephemeral port, so fetch the same path there. */
function onTestCloud(url: string): string {
  const u = new URL(url);
  return `${baseUrl}${u.pathname}`;
}

async function cloudHasNote(uuid: string): Promise<boolean> {
  const { cloudDb } = await import("../src/cloud/db");
  return !!cloudDb().query<{ uuid: string }, [string]>("SELECT uuid FROM notes WHERE uuid = ?").get(uuid);
}

test("shared: unshared note never reaches the cloud; shared note does", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { createShareSynced } = await import("../src/core/publish");

  const shared = await createNote({ type: "snippet", title: "Shared", body_html: "<p>shared</p>", thread_id: "a" });
  const secret = await createNote({ type: "snippet", title: "Secret", body_html: "<p>secret</p>", thread_id: "b" });

  const state = loadSyncState()!;
  const pub = await createShareSynced(state, { scope_type: "note", scope_id: shared.id });
  expect(pub.ok).toBe(true);

  await syncOnce(state);

  expect(await cloudHasNote(shared.id)).toBe(true);
  expect(await cloudHasNote(secret.id)).toBe(false);
});

test("shared: viewer \"Share\" (POST /api/notes/:id/shares) pushes the unshared note's snapshot first", async () => {
  // QA finding on PR #114: the viewer proxied straight to /v1/share, so in
  // shared mode an unshared note was never in the cloud → 502 note not found.
  const { createNote } = await import("../src/core/storage");
  const { saveConfig, loadConfig } = await import("../src/core/config");
  await saveConfig({ ...(await loadConfig()), viewer_port: 0 });
  const note = await createNote({ type: "snippet", title: "Viewer", body_html: "<p>v</p>", thread_id: "v" });
  const other = await createNote({ type: "snippet", title: "Other", body_html: "<p>o</p>", thread_id: "o" });

  const { startServer } = await import("../src/viewer/server");
  const viewer = (await startServer()) as any;
  try {
    const r = await fetch(`http://${viewer.hostname}:${viewer.port}/api/notes/${note.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expires_in_days: 7 }),
    });
    expect(r.status).toBe(200);
    const data = (await r.json()) as { token: string };
    expect(typeof data.token).toBe("string");
    expect(await cloudHasNote(note.id)).toBe(true);
    expect(await cloudHasNote(other.id)).toBe(false);
  } finally {
    viewer.stop(true);
  }
});

test("shared: publishing an old note works even though the (unused) push cursor is far in the future", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState } = await import("../src/core/sync");
  const { createShareSynced } = await import("../src/core/publish");

  const note = await createNote({ type: "snippet", title: "Old", body_html: "<p>old note</p>", thread_id: "c" });

  const state = loadSyncState()!;
  // Simulate a cursor that's already way past this note's `created` — in
  // full-mirror ("all") mode this would make pushNotes skip it forever.
  // Shared-scope coverage isn't cursor-based, so this must have no effect.
  state.last_pushed_at = "2999-01-01T00:00:00.000Z";

  const pub = await createShareSynced(state, { scope_type: "note", scope_id: note.id });
  expect(pub.ok).toBe(true);
  expect(await cloudHasNote(note.id)).toBe(true);
});

test("shared: replace of a shared note → new version on cloud; old /p/:token/n/:old link renders the new content", async () => {
  const { createNote, replaceNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { createShareSynced } = await import("../src/core/publish");

  const a = await createNote({ type: "snippet", title: "v1", body_html: "<p>first version</p>", thread_id: "rev" });
  const state = loadSyncState()!;
  const pub = await createShareSynced(state, { scope_type: "note", scope_id: a.id });
  expect(pub.ok).toBe(true);
  const shareUrl = (pub as any).body.url as string;
  expect(shareUrl).toContain(`/n/${a.id}`);

  const res = await replaceNote({ old_id: a.id, body_html: "<p>second version</p>" });
  expect(res.ok).toBe(true);
  const b = res.new_meta!.id;

  await syncOnce(state);
  expect(await cloudHasNote(b)).toBe(true);

  // Old link, unchanged format, now serves the new head's content.
  const nPage = await fetch(onTestCloud(shareUrl));
  expect(nPage.status).toBe(200);
  const rawUrl = onTestCloud(shareUrl).replace(`/n/${a.id}`, `/raw/${a.id}`);
  const raw = await fetch(rawUrl);
  expect(raw.status).toBe(200);
  const rawText = await raw.text();
  expect(rawText).toContain("second version");
  expect(rawText).not.toContain("first version");
});

test("shared: a new note in an already-shared thread is covered at the next sync", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { createShareSynced } = await import("../src/core/publish");

  const a1 = await createNote({ type: "snippet", title: "first", body_html: "<p>a1</p>", thread_id: "shared-thread" });
  const state = loadSyncState()!;
  const pub = await createShareSynced(state, { scope_type: "thread", scope_id: "shared-thread" });
  expect(pub.ok).toBe(true);
  await syncOnce(state);
  expect(await cloudHasNote(a1.id)).toBe(true);

  const a2 = await createNote({ type: "snippet", title: "second", body_html: "<p>a2</p>", thread_id: "shared-thread" });
  expect(await cloudHasNote(a2.id)).toBe(false); // not yet, no sync tick ran

  await syncOnce(state);
  expect(await cloudHasNote(a2.id)).toBe(true);
});

test("shared: revoke purges the snapshot immediately (no waiting for next tick)", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce, purgeSharedAfterRevoke } = await import("../src/core/sync");
  const { createShareSynced } = await import("../src/core/publish");
  const { cloudDb } = await import("../src/cloud/db");

  const note = await createNote({ type: "snippet", title: "Revoke me", body_html: "<p>x</p>", thread_id: "rev2" });
  const state = loadSyncState()!;
  const pub = await createShareSynced(state, { scope_type: "note", scope_id: note.id });
  expect(pub.ok).toBe(true);
  const shareToken = (pub as any).body.token as string;
  await syncOnce(state);
  expect(await cloudHasNote(note.id)).toBe(true);

  const revokeRes = await fetch(`${baseUrl}/v1/share/${shareToken}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(revokeRes.ok).toBe(true);

  await purgeSharedAfterRevoke(state);

  expect(await cloudHasNote(note.id)).toBe(false);
  const tomb = cloudDb()
    .query<{ uuid: string }, [string]>("SELECT uuid FROM tombstones WHERE uuid = ?")
    .get(note.id);
  expect(tomb).not.toBeNull();
});

test("shared: an expired share's coverage is purged on the next sync tick", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { createShareSynced } = await import("../src/core/publish");
  const { cloudDb } = await import("../src/cloud/db");

  const note = await createNote({ type: "snippet", title: "Expiring", body_html: "<p>x</p>", thread_id: "exp" });
  const state = loadSyncState()!;
  const pub = await createShareSynced(state, { scope_type: "note", scope_id: note.id });
  expect(pub.ok).toBe(true);
  const shareToken = (pub as any).body.token as string;
  await syncOnce(state);
  expect(await cloudHasNote(note.id)).toBe(true);

  // Force expiry — `listShares` returns expired rows too (by design), the
  // client is supposed to filter them out before computing coverage.
  cloudDb().run("UPDATE shares SET expires_at = ? WHERE token = ?", ["2000-01-01T00:00:00.000Z", shareToken]);

  await syncOnce(state);
  expect(await cloudHasNote(note.id)).toBe(false);
});

test("shared: a GET /v1/shares failure aborts the sync and purges nothing", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, saveSyncState, syncOnce } = await import("../src/core/sync");
  const { createShareSynced } = await import("../src/core/publish");

  const note = await createNote({ type: "snippet", title: "Protected", body_html: "<p>x</p>", thread_id: "guard" });
  const state = loadSyncState()!;
  const pub = await createShareSynced(state, { scope_type: "note", scope_id: note.id });
  expect(pub.ok).toBe(true);
  await syncOnce(state); // establishes a real, persisted shared_pushed entry
  expect(await cloudHasNote(note.id)).toBe(true);

  const goodToken = state.device_token;
  state.device_token = "not-a-real-token";
  saveSyncState(state);

  await expect(syncOnce(state)).rejects.toThrow();

  // Nothing was purged: the note is still on the cloud, and the persisted
  // state still remembers it as pushed.
  expect(await cloudHasNote(note.id)).toBe(true);
  const { loadSyncState: reload } = await import("../src/core/sync");
  const reloaded = reload()!;
  expect(reloaded.shared_pushed?.[note.id]).toBeDefined();

  state.device_token = goodToken; // restore, in case of further assertions
});

test("shared: never pulls — a foreign device's cloud note does not land locally", async () => {
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { cloudDb, nextSeq } = await import("../src/cloud/db");

  const foreignUuid = "01HFOREIGN0000000000000ZZ";
  const seq = nextSeq(cloudDb());
  cloudDb().run(
    `INSERT INTO notes (uuid, slug, thread_id, title, type, theme, theme_profile,
       body_html, plain_text, created_at, updated_at, expires_at,
       is_final, live, owner_device_id, origin_device_id,
       word_count, summary, server_seq)
     VALUES (?, 'foreign-note', 'foreign-thread', 'Foreign', 'research', 'linen', 'hosted',
             '<p>from another device</p>', '', '2026-05-13T10:00:00Z', '2026-05-13T10:00:00Z',
             NULL, 0, 0, NULL, '01HXOTHERDEVICE000000000ZZ', 0, NULL, ?)`,
    [foreignUuid, seq]
  );

  const state = loadSyncState()!;
  const r = await syncOnce(state);
  expect(r.pulled).toBe(0);

  const { db } = await import("../src/core/db");
  const row = db().query<{ id: string }, [string]>("SELECT id FROM notes WHERE id = ?").get(foreignUuid);
  expect(row).toBeNull();
});

test("all (default, unaffected): sync_scope omitted still pushes everything (no shares needed)", async () => {
  const { saveConfig, loadConfig } = await import("../src/core/config");
  await saveConfig({ ...(await loadConfig()), sync_scope: "all" });

  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  const note = await createNote({ type: "snippet", title: "Mirrored", body_html: "<p>x</p>", thread_id: "mirror" });
  const state = loadSyncState()!;
  const r = await syncOnce(state);
  expect(r.pushed).toBe(1);
  expect(await cloudHasNote(note.id)).toBe(true);
});

// ─── Cloud-side regression: shares created before this change ─────────────
// Rows inserted directly via SQL, the way they'd already exist in a
// pre-sc-24117 database — including a share with no `expires_at` at all.
// Must keep resolving under the exact same `/p/<token>/...` link shape.

test("regression: pre-existing note/thread/set shares (raw SQL rows) still render", async () => {
  const { cloudDb, nextSeq } = await import("../src/cloud/db");
  const db = cloudDb();
  db.run(
    "INSERT INTO devices (id, name, token_hash, paired_at, user_id) VALUES ('legacy-dev','d','h','2020-01-01T00:00:00Z','default')"
  );

  function seedNote(uuid: string, thread: string, body: string, supersededBy: string | null = null) {
    db.run(
      `INSERT INTO notes (uuid, slug, thread_id, title, type, theme, theme_profile,
         body_html, plain_text, created_at, updated_at, expires_at, is_final, live,
         owner_device_id, origin_device_id, superseded_by, word_count, summary, server_seq)
       VALUES (?, ?, ?, ?, 'technical', 'linen', 'hosted', ?, '', '2020-01-01T00:00:00Z',
         '2020-01-01T00:00:00Z', NULL, 0, 0, NULL, 'legacy-dev', ?, 0, NULL, ?)`,
      [uuid, uuid.toLowerCase(), thread, `Note ${uuid}`, body, supersededBy, nextSeq(db)]
    );
  }

  const OLD = "01LEGACYOLD0000000000000O1";
  const HEAD = "01LEGACYHEAD000000000000H1";
  const THREADNOTE = "01LEGACYTHREAD00000000TN1";
  const ROOT = "01LEGACYROOT0000000000RT1";
  const LINKED = "01LEGACYLINKED000000000LK1";

  seedNote(HEAD, "legacy-note-thread", "<p>new content</p>");
  seedNote(OLD, "legacy-note-thread", "<p>old content</p>", HEAD);
  seedNote(THREADNOTE, "legacy-thread", "<p>thread note</p>");
  seedNote(ROOT, "legacy-set-thread", `<p><a href="/n/${LINKED}">link</a></p>`);
  seedNote(LINKED, "legacy-set-thread", "<p>linked note</p>");

  // Legacy rows: no `expires_at`, no explicit `allow_pick` — relies on the
  // column defaults, same as a row written before either feature existed.
  const noteToken = "legacyNoteToken_".padEnd(43, "x");
  const threadToken = "legacyThreadToken".padEnd(43, "y");
  const setToken = "legacySetToken__".padEnd(43, "z");
  db.run(
    `INSERT INTO shares (token, user_id, scope_type, scope_id, created_by_device, created_at)
     VALUES (?, 'default', 'note', ?, 'legacy-dev', '2020-01-01T00:00:00Z')`,
    [noteToken, OLD]
  );
  db.run(
    `INSERT INTO shares (token, user_id, scope_type, scope_id, created_by_device, created_at)
     VALUES (?, 'default', 'thread', 'legacy-thread', 'legacy-dev', '2020-01-01T00:00:00Z')`,
    [threadToken]
  );
  db.run(
    `INSERT INTO shares (token, user_id, scope_type, scope_id, created_by_device, created_at)
     VALUES (?, 'default', 'set', ?, 'legacy-dev', '2020-01-01T00:00:00Z')`,
    [setToken, ROOT]
  );
  db.run("INSERT OR IGNORE INTO share_notes (token, note_uuid) VALUES (?, ?), (?, ?)", [setToken, ROOT, setToken, LINKED]);

  // Note share at the OLD (superseded) uuid resolves to HEAD's content.
  const notePage = await fetch(`${baseUrl}/p/${noteToken}/raw/${OLD}`);
  expect(notePage.status).toBe(200);
  const noteBody = await notePage.text();
  expect(noteBody).toContain("new content");
  expect(noteBody).not.toContain("old content");

  // Thread share still resolves.
  const threadPage = await fetch(`${baseUrl}/p/${threadToken}/t/legacy-thread`);
  expect(threadPage.status).toBe(200);

  // Set share still covers the linked note.
  const setRootPage = await fetch(`${baseUrl}/p/${setToken}/raw/${ROOT}`);
  expect(setRootPage.status).toBe(200);
  const setLinkedPage = await fetch(`${baseUrl}/p/${setToken}/raw/${LINKED}`);
  expect(setLinkedPage.status).toBe(200);
});
