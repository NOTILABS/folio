/**
 * Asset sync end-to-end: a local Folio attaches an asset (writes a file
 * to ~/Folio/threads/<thread>/assets/), creates a note referencing it,
 * syncs to a cloud relay. After sync:
 *   - asset bytes are in cloud (idempotent on re-sync)
 *   - public GET /t/<thread>/asset/<filename> serves them
 *   - capability URL render rewrites asset refs through /p/<token>/...
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { closeDb } from "../src/core/db";
import { closeCloudDb } from "../src/cloud/db";

let homeDir: string;
let cloudHomeDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let baseUrl: string;
let token: string;
let selfDeviceId: string;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "folio-assets-home-"));
  cloudHomeDir = mkdtempSync(join(tmpdir(), "folio-assets-cloud-"));
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

function dropAsset(thread: string, filename: string, bytes: Uint8Array): string {
  const dir = join(homeDir, "threads", thread, "assets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

test("extractAssetRefs: catches relative + absolute, dedupes, validates filename", async () => {
  const { extractAssetRefs } = await import("../src/core/sync");
  const html = `
    <img src="/t/morning/asset/photo.png" alt="x">
    <a href="https://notes.example.com/t/morning/asset/doc.pdf">pdf</a>
    <img src="/t/morning/asset/photo.png" alt="dup">
    <img src="/t/other/asset/x.jpg">
    <img src="/t/morning/asset/../etc/passwd">
  `;
  const refs = extractAssetRefs(html);
  // ../ filename should be rejected by isSafeAssetFilename.
  expect(refs).toContainEqual({ thread_id: "morning", filename: "photo.png" });
  expect(refs).toContainEqual({ thread_id: "morning", filename: "doc.pdf" });
  expect(refs).toContainEqual({ thread_id: "other", filename: "x.jpg" });
  // No duplicates (photo.png appears twice in HTML).
  const photoCount = refs.filter((r) => r.filename === "photo.png").length;
  expect(photoCount).toBe(1);
  // Path traversal filtered.
  expect(refs.some((r) => r.filename.includes(".."))).toBe(false);
});

test("sync push uploads referenced assets to cloud, idempotent on re-sync", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { cloudDb } = await import("../src/cloud/db");

  const bytes = new TextEncoder().encode("png bytes here");
  const hash = dropAsset("photos", "shot.png", bytes);

  await createNote({
    type: "research",
    title: "With asset",
    body_html: `<p>here:</p><img src="/t/photos/asset/shot.png" alt="x">`,
    thread_id: "photos",
  });

  const state = loadSyncState()!;
  const r1 = await syncOnce(state);
  expect(r1.pushed).toBe(1);
  expect(r1.assets_pushed).toBe(1);

  const cloudRow = cloudDb()
    .query<{ hash: string; size_bytes: number }, [string]>(
      "SELECT hash, size_bytes FROM assets WHERE hash = ?"
    )
    .get(hash);
  expect(cloudRow).not.toBeNull();
  expect(cloudRow!.size_bytes).toBe(bytes.byteLength);

  // Second sync: same asset already there → assets_pushed = 0.
  const r2 = await syncOnce(state);
  expect(r2.assets_pushed).toBe(0);
});

test("GET /t/<thread>/asset/<file> is public (no Authorization needed)", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  const bytes = new TextEncoder().encode("public png bytes");
  dropAsset("gallery", "pic.png", bytes);
  await createNote({
    type: "snippet",
    title: "G",
    body_html: `<img src="/t/gallery/asset/pic.png">`,
    thread_id: "gallery",
  });
  await syncOnce(loadSyncState()!);

  const r = await fetch(`${baseUrl}/t/gallery/asset/pic.png`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("png");
  const back = new Uint8Array(await r.arrayBuffer());
  expect(back).toEqual(bytes);
});

test("missing local file: sync push doesn't crash, asset uploaded=0", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  // Note references a phantom asset (no local file).
  await createNote({
    type: "snippet",
    title: "Phantom asset",
    body_html: `<img src="/t/ghost/asset/nope.png">`,
    thread_id: "ghost",
  });
  const r = await syncOnce(loadSyncState()!);
  expect(r.pushed).toBe(1); // note still pushed
  expect(r.assets_pushed).toBe(0); // asset was missing
});

test("capability URL render rewrites asset refs through /p/<token>/...", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  const bytes = new TextEncoder().encode("share bytes");
  dropAsset("shared-thread", "image.png", bytes);
  const note = await createNote({
    type: "research",
    title: "Share me",
    body_html: `<p>look:</p><img src="/t/shared-thread/asset/image.png" alt="x">`,
    thread_id: "shared-thread",
  });
  await syncOnce(loadSyncState()!);

  // Create a share over the note.
  const shareRes = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: note.id, expires_in_days: 7 }),
  });
  const { token: shareToken } = (await shareRes.json()) as { token: string };

  // /p/<token>/raw/<uuid> body should rewrite the img src.
  const raw = await fetch(`${baseUrl}/p/${shareToken}/raw/${note.id}`);
  expect(raw.status).toBe(200);
  const body = await raw.text();
  expect(body).toContain(`/p/${shareToken}/t/shared-thread/asset/image.png`);
  expect(body).not.toMatch(/src=["']\/t\/shared-thread/);

  // The capability asset URL works.
  const asset = await fetch(`${baseUrl}/p/${shareToken}/t/shared-thread/asset/image.png`);
  expect(asset.status).toBe(200);
  expect(new Uint8Array(await asset.arrayBuffer())).toEqual(bytes);
});

test("capability asset: scope mismatch rejected (wrong thread)", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  dropAsset("alpha-t", "a.png", new TextEncoder().encode("a"));
  dropAsset("beta-t", "b.png", new TextEncoder().encode("b"));
  await createNote({
    type: "snippet",
    title: "alpha",
    body_html: `<img src="/t/alpha-t/asset/a.png">`,
    thread_id: "alpha-t",
  });
  await createNote({
    type: "snippet",
    title: "beta",
    body_html: `<img src="/t/beta-t/asset/b.png">`,
    thread_id: "beta-t",
  });
  await syncOnce(loadSyncState()!);

  // Share is thread-scoped on alpha-t.
  const shareRes = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "thread", scope_id: "alpha-t" }),
  });
  const { token: shareToken } = (await shareRes.json()) as { token: string };

  // Alpha asset accessible.
  expect((await fetch(`${baseUrl}/p/${shareToken}/t/alpha-t/asset/a.png`)).status).toBe(200);
  // Beta asset rejected (out of scope).
  expect((await fetch(`${baseUrl}/p/${shareToken}/t/beta-t/asset/b.png`)).status).toBe(404);
});

test("public asset 404 for unknown (thread, filename)", async () => {
  const r = await fetch(`${baseUrl}/t/nonexistent/asset/missing.png`);
  expect(r.status).toBe(404);
});

test("push uploads own assets; nothing is pulled back (no pull since sc-24120)", async () => {
  const { createNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");

  const bytes = new TextEncoder().encode("own-bytes");
  dropAsset("own-thread", "mine.png", bytes);
  await createNote({
    type: "snippet",
    title: "Mine",
    body_html: '<img src="/t/own-thread/asset/mine.png">',
    thread_id: "own-thread",
  });
  const r = await syncOnce(loadSyncState()!);
  expect(r.pushed).toBe(1);
  expect(r.assets_pushed).toBe(1);
  expect(r.assets_pulled).toBe(0);
});

test("delete cascade: orphan asset bytes removed when last referrer goes", async () => {
  const { createNote, deleteNote } = await import("../src/core/storage");
  const { loadSyncState, syncOnce } = await import("../src/core/sync");
  const { cloudDb, cloudAssetsDir } = await import("../src/cloud/db");

  // Drop an asset + create two notes referencing it. Sync both up.
  const bytes = new TextEncoder().encode("cascade-test bytes");
  const hash = dropAsset("photos-cascade", "shared.png", bytes);
  const n1 = await createNote({
    type: "snippet",
    title: "Refs A",
    body_html: `<img src="/t/photos-cascade/asset/shared.png">`,
    thread_id: "photos-cascade",
  });
  const n2 = await createNote({
    type: "snippet",
    title: "Refs B",
    body_html: `<img src="/t/photos-cascade/asset/shared.png">`,
    thread_id: "photos-cascade",
  });
  await syncOnce(loadSyncState()!);

  // Asset is on cloud.
  expect(
    cloudDb()
      .query<{ hash: string }, [string]>("SELECT hash FROM assets WHERE hash = ?")
      .get(hash),
  ).not.toBeNull();
  const { existsSync, readdirSync } = await import("node:fs");
  // blob_path = ab/cd/<hash>.png — let's find any file in cloudAssetsDir.
  // Easier: re-query for the blob_path.
  const blobPath = cloudDb()
    .query<{ blob_path: string }, [string]>("SELECT blob_path FROM assets WHERE hash = ?")
    .get(hash)!.blob_path;
  const abs = join(cloudAssetsDir(), blobPath);
  expect(existsSync(abs)).toBe(true);

  // Delete n1: asset is STILL referenced by n2, so cloud should keep it.
  deleteNote(n1.id);
  await syncOnce(loadSyncState()!);
  expect(
    cloudDb()
      .query<{ hash: string }, [string]>("SELECT hash FROM assets WHERE hash = ?")
      .get(hash),
  ).not.toBeNull();
  expect(existsSync(abs)).toBe(true);

  // Delete n2: now zero referrers — cloud should sweep the asset.
  deleteNote(n2.id);
  await syncOnce(loadSyncState()!);
  expect(
    cloudDb()
      .query<{ hash: string }, [string]>("SELECT hash FROM assets WHERE hash = ?")
      .get(hash),
  ).toBeNull();
  expect(existsSync(abs)).toBe(false);
});
