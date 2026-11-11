import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeCloudDb, cloudDb } from "../src/cloud/db";

let tmpDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let baseUrl: string;
let token: string;

async function pair(name = "test-device"): Promise<string> {
  const { legacyPairResponse } = await import("./_cloud-device");
  const res = legacyPairResponse({ name: name });
  const body = (await res.json()) as { token: string };
  return body.token;
}

// sc-24120: no /v1/sync/pull any more — push results are read straight from
// the cloud DB.
function rows<T>(sql: string, ...params: any[]): T[] {
  return cloudDb().query(sql).all(...params) as T[];
}

function note(uuid: string, slug = "n", thread = "smoke", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid,
    slug,
    thread_id: thread,
    title: `Note ${slug}`,
    type: "research",
    body_html: `<p>body ${slug}</p>`,
    created_at: "2026-05-13T10:00:00Z",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-cloud-sync-"));
  process.env.FOLIO_CLOUD_HOME = tmpDir;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0 })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;
  token = await pair();
});

afterEach(() => {
  try { server?.stop(); } catch {}
  server = null;
  closeCloudDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_CLOUD_HOME;
});

test("push 5 notes: all land in the cloud + cursor advances", async () => {
  const notes = Array.from({ length: 5 }, (_, i) =>
    note(`019e2110-0000-7000-8000-00000000000${i}`, `n${i}`, "smoke")
  );
  const pushRes = await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  expect(pushRes.status).toBe(200);
  const pushBody = (await pushRes.json()) as { notes: unknown[]; cursor: number };
  expect(pushBody.notes).toHaveLength(5);
  expect(pushBody.cursor).toBe(5);

  const stored = rows<{ server_seq: number }>("SELECT server_seq FROM notes ORDER BY server_seq");
  expect(stored).toHaveLength(5);
  expect(stored[4]!.server_seq).toBe(5);
});

test("push is idempotent on same uuid (no duplicate)", async () => {
  const n = note("019e2110-0000-7000-8000-000000000200", "dup", "smoke");
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes: [n] }),
  });
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes: [{ ...n, title: "Note dup updated" }] }),
  });

  const stored = rows<{ uuid: string; title: string }>("SELECT uuid, title FROM notes");
  expect(stored).toHaveLength(1);
  expect(stored[0]!.title).toBe("Note dup updated");
});

test("slug collision: different uuid, same thread+slug → rename with uuid6 suffix", async () => {
  const a = note("019e2110-0000-7000-8000-000000000300", "morning-review", "t-coll");
  const b = note("019e2110-0000-7000-8000-000000000301", "morning-review", "t-coll");
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes: [a] }),
  });
  const pushBRes = await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes: [b] }),
  });
  const pushB = (await pushBRes.json()) as { notes: { uuid: string; canonical_slug: string }[] };
  expect(pushB.notes[0]!.canonical_slug).not.toBe("morning-review");
  expect(pushB.notes[0]!.canonical_slug).toMatch(/^morning-review-[a-f0-9]{6}$/);
});

test("push stamps origin_device_id from authed device (overrides client claim)", async () => {
  const n = note("019e2110-0000-7000-8000-000000000400", "origin-test", "smoke", {
    origin_device_id: "totally-fake-id-from-client",
  });
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes: [n] }),
  });
  const stored = rows<{ origin_device_id: string }>("SELECT origin_device_id FROM notes");
  expect(stored[0]!.origin_device_id).not.toBe("totally-fake-id-from-client");
  expect(stored[0]!.origin_device_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("tags land in the cloud on push", async () => {
  const n = note("019e2110-0000-7000-8000-000000000500", "tagged", "smoke", {
    tags: ["alpha", "beta", "gamma"],
  });
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes: [n] }),
  });
  const tags = rows<{ tag: string }>("SELECT tag FROM note_tags ORDER BY tag").map((r) => r.tag);
  expect(tags).toEqual(["alpha", "beta", "gamma"]);
});

test("live entry push dedups on re-push", async () => {
  const noteUuid = "019e2110-0000-7000-8000-000000000600";
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes: [note(noteUuid, "live-1", "smoke", { live: 1 })] }),
  });
  const entries = [
    { id: "ent1", note_uuid: noteUuid, ts: "2026-05-13T11:00:00Z", content_html: "<p>1</p>" },
    { id: "ent2", note_uuid: noteUuid, ts: "2026-05-13T11:01:00Z", content_html: "<p>2</p>" },
  ];
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ live_entries: entries }),
  });
  // Re-push same entries (dedup)
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ live_entries: entries }),
  });

  const stored = rows<{ id: string }>("SELECT id FROM live_entries ORDER BY ts");
  expect(stored.map((e) => e.id)).toEqual(["ent1", "ent2"]);
});

test("asset upload + GET round-trip + hash mismatch rejected", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = new TextEncoder().encode("fake png bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const upRes = await fetch(`${baseUrl}/v1/sync/assets/${hash}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-folio-filename": "chart.png",
      "x-folio-thread-id": "smoke",
      "content-type": "application/octet-stream",
    },
    body: bytes,
  });
  expect(upRes.status).toBe(200);
  const upBody = (await upRes.json()) as { hash: string; stored: boolean };
  expect(upBody.hash).toBe(hash);
  expect(upBody.stored).toBe(true);

  // Idempotent re-upload
  const upRes2 = await fetch(`${baseUrl}/v1/sync/assets/${hash}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-folio-filename": "chart.png",
      "x-folio-thread-id": "smoke",
      "content-type": "application/octet-stream",
    },
    body: bytes,
  });
  expect(upRes2.status).toBe(200);
  expect(((await upRes2.json()) as { stored: boolean }).stored).toBe(false);

  // GET returns bytes
  const getRes = await fetch(`${baseUrl}/v1/sync/assets/${hash}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(getRes.status).toBe(200);
  expect(getRes.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(bytes);

  // Hash mismatch rejected
  const wrongHash = "0".repeat(64);
  const badRes = await fetch(`${baseUrl}/v1/sync/assets/${wrongHash}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-folio-filename": "chart.png",
      "x-folio-thread-id": "smoke",
      "content-type": "application/octet-stream",
    },
    body: bytes,
  });
  expect(badRes.status).toBe(400);
});
