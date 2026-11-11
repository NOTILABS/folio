/**
 * 3-user isolation: Alice / Bob / Carol all paired to one cloud, each
 * device's bearer scopes every read + write to its own user_id.
 *
 *  ✓ Same (thread_id, slug) works across users (no UNIQUE collision).
 *  ✓ Pushed rows land in the pushing device's user_id partition only.
 *  ✓ /v1/admin/stats shows only the caller's user's counts.
 *  ✓ Capability URL works cross-user (URL is the credential, no Folio acct).
 *  (sc-24120: /v1/feed, /v1/sync/pull, authed /raw, /n shell and
 *  /v1/auth/pair-code are gone.)
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeCloudDb, cloudDb } from "../src/cloud/db";

let tmpDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let baseUrl: string;

async function addUser(id: string, display = id): Promise<void> {
  cloudDb().run(
    "INSERT INTO users (id, display_name, created_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    [id, display]
  );
}

async function pairAs(userId: string, deviceName = `${userId}-laptop`, deviceId?: string): Promise<string> {
  const { legacyPairResponse } = await import("./_cloud-device");
  const res = legacyPairResponse({ name: deviceName, userId, deviceId: deviceId ?? `01HX${userId.toUpperCase().padEnd(8, "X")}DEVICE0000000` });
  return ((await res.json()) as { token: string }).token;
}

async function push(token: string, notes: any[]): Promise<any> {
  const res = await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  return res.json();
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-multi-user-"));
  process.env.FOLIO_CLOUD_HOME = tmpDir;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0, publicUrl: "https://folio.example.com" })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;
  await addUser("alice", "Alice");
  await addUser("bob", "Bob");
  await addUser("carol", "Carol");
});

afterEach(() => {
  try { server?.stop(); } catch {}
  server = null;
  closeCloudDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_CLOUD_HOME;
});

test("two users can have the same (thread_id, slug) — UNIQUE is per-user", async () => {
  const aliceTok = await pairAs("alice");
  const bobTok = await pairAs("bob");

  const aliceResp = await push(aliceTok, [{
    uuid: "01HXALICE000000000000000",
    slug: "alpha",
    thread_id: "morning",
    title: "Alice morning",
    type: "journal",
    body_html: "<p>alice</p>",
    created_at: "2026-05-15T08:00:00Z",
  }]);
  expect(aliceResp.notes).toHaveLength(1);
  expect(aliceResp.notes[0].canonical_slug).toBe("alpha");

  const bobResp = await push(bobTok, [{
    uuid: "01HXBOB0000000000000000X",
    slug: "alpha",
    thread_id: "morning",
    title: "Bob morning",
    type: "journal",
    body_html: "<p>bob</p>",
    created_at: "2026-05-15T08:30:00Z",
  }]);
  // Bob keeps his slug 'alpha' (no rename) — Alice's row is in a different user_id partition.
  expect(bobResp.notes[0].canonical_slug).toBe("alpha");
});

test("push lands each user's rows in their own user_id partition", async () => {
  const aliceTok = await pairAs("alice");
  const bobTok = await pairAs("bob");

  await push(aliceTok, [{
    uuid: "01HXALICE-PULL-1",
    slug: "p1",
    thread_id: "x",
    title: "A1",
    type: "snippet",
    body_html: "<p>a1</p>",
    created_at: "2026-05-15T09:00:00Z",
  }]);
  await push(bobTok, [{
    uuid: "01HXBOB-PULL-1",
    slug: "p1",
    thread_id: "x",
    title: "B1",
    type: "snippet",
    body_html: "<p>b1</p>",
    created_at: "2026-05-15T09:05:00Z",
  }]);

  const owned = (u: string) =>
    cloudDb().query<{ uuid: string }, [string]>("SELECT uuid FROM notes WHERE user_id = ?").all(u).map((r) => r.uuid);
  expect(owned("alice")).toEqual(["01HXALICE-PULL-1"]);
  expect(owned("bob")).toEqual(["01HXBOB-PULL-1"]);
});

test("/v1/admin/stats is per-user — Bob sees 0 of Alice's data", async () => {
  const aliceTok = await pairAs("alice");
  const bobTok = await pairAs("bob");
  await push(aliceTok, [
    {
      uuid: "01HXALICE-S1",
      slug: "s1",
      thread_id: "ops",
      title: "A1",
      type: "snippet",
      body_html: "<p>a</p>",
      created_at: "2026-05-15T09:00:00Z",
    },
    {
      uuid: "01HXALICE-S2",
      slug: "s2",
      thread_id: "ops",
      title: "A2",
      type: "snippet",
      body_html: "<p>a2</p>",
      created_at: "2026-05-15T09:05:00Z",
    },
  ]);

  const aliceStats = (await (await fetch(`${baseUrl}/v1/admin/stats`, {
    headers: { Authorization: `Bearer ${aliceTok}` },
  })).json()) as any;
  expect(aliceStats.user_id).toBe("alice");
  expect(aliceStats.counts.notes).toBe(2);
  expect(aliceStats.counts.devices_active).toBe(1);

  const bobStats = (await (await fetch(`${baseUrl}/v1/admin/stats`, {
    headers: { Authorization: `Bearer ${bobTok}` },
  })).json()) as any;
  expect(bobStats.user_id).toBe("bob");
  expect(bobStats.counts.notes).toBe(0);
  expect(bobStats.counts.devices_active).toBe(1); // own device only
});

test("/v1/auth/devices is per-user — Alice sees her devices only", async () => {
  const aliceTok = await pairAs("alice", "alice-laptop");
  await pairAs("alice", "alice-phone", "01HXALICE-PHONE-DEV0000");
  await pairAs("bob", "bob-laptop");

  const aliceDevs = (await (await fetch(`${baseUrl}/v1/auth/devices`, {
    headers: { Authorization: `Bearer ${aliceTok}` },
  })).json()) as { devices: { name: string; userId?: string }[] };
  expect(aliceDevs.devices).toHaveLength(2);
  expect(aliceDevs.devices.map((d) => d.name).sort()).toEqual(["alice-laptop", "alice-phone"]);
});

test("capability URL works cross-user: Alice shares with Bob, Bob reads it", async () => {
  const aliceTok = await pairAs("alice");
  const uuid = "01HXSHARE-X-USR";
  await push(aliceTok, [{
    uuid,
    slug: "shared",
    thread_id: "shared",
    title: "Shared",
    type: "research",
    body_html: "<p>shared bytes</p>",
    created_at: "2026-05-15T09:00:00Z",
  }]);

  // Alice mints a capability URL for the note.
  const shareRes = (await (await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: uuid }),
  })).json()) as { token: string; url: string };

  // Bob (or anyone) hits the capability URL — works regardless of Bob's account.
  const r = await fetch(`${baseUrl}/p/${shareRes.token}/n/${uuid}`);
  expect(r.status).toBe(200);

  // The /raw/ behind it also works through the capability scope.
  const raw = await fetch(`${baseUrl}/p/${shareRes.token}/raw/${uuid}`);
  expect(raw.status).toBe(200);
  expect(await raw.text()).toContain("shared bytes");
});

test("Bob cannot create a share over Alice's note (uuid leaked)", async () => {
  const aliceTok = await pairAs("alice");
  const bobTok = await pairAs("bob");
  const uuid = "01HXALICE-PRIV";
  await push(aliceTok, [{
    uuid,
    slug: "priv",
    thread_id: "priv",
    title: "Private",
    type: "research",
    body_html: "<p>priv</p>",
    created_at: "2026-05-15T09:00:00Z",
  }]);

  // Bob attempts to publish a share for Alice's note.
  const r = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bobTok}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: uuid }),
  });
  expect(r.status).toBe(400);
  const body = (await r.json()) as { error: string };
  expect(body.error).toContain("not found");
});

test("Bob cannot push a delete against Alice's uuid (silently skipped)", async () => {
  const aliceTok = await pairAs("alice");
  const bobTok = await pairAs("bob");
  const uuid = "01HXALICE-PROTECTED";
  await push(aliceTok, [{
    uuid,
    slug: "p",
    thread_id: "p",
    title: "Protected",
    type: "snippet",
    body_html: "<p>p</p>",
    created_at: "2026-05-15T09:00:00Z",
  }]);

  const r = await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bobTok}`, "content-type": "application/json" },
    body: JSON.stringify({ deletes: [uuid] }),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { deletes: string[] };
  expect(body.deletes).toHaveLength(0); // silent skip — Alice's note still alive

  // Confirm Alice's note still exists.
  const stillThere = cloudDb().query<{ user_id: string }, [string]>("SELECT user_id FROM notes WHERE uuid = ?").get(uuid);
  expect(stillThere?.user_id).toBe("alice");
});

test("asset URL /u/<user>/.../ pinned to that user — wrong user 404s", async () => {
  const aliceTok = await pairAs("alice");
  const bobTok = await pairAs("bob");

  // Both users push assets with same (thread, filename).
  const bytes = new TextEncoder().encode("alice's bytes");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await fetch(`${baseUrl}/v1/sync/assets/${hash}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${aliceTok}`,
      "content-type": "application/octet-stream",
      "x-folio-filename": "shared-name.png",
      "x-folio-thread-id": "morning",
    },
    body: bytes,
  });

  const bobBytes = new TextEncoder().encode("bob's bytes — same filename");
  const bobHash = createHash("sha256").update(bobBytes).digest("hex");
  await fetch(`${baseUrl}/v1/sync/assets/${bobHash}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bobTok}`,
      "content-type": "application/octet-stream",
      "x-folio-filename": "shared-name.png",
      "x-folio-thread-id": "morning",
    },
    body: bobBytes,
  });

  // /u/alice/... serves Alice's bytes.
  const aliceGet = await fetch(`${baseUrl}/u/alice/t/morning/asset/shared-name.png`);
  expect(aliceGet.status).toBe(200);
  expect(new Uint8Array(await aliceGet.arrayBuffer())).toEqual(bytes);

  // /u/bob/... serves Bob's.
  const bobGet = await fetch(`${baseUrl}/u/bob/t/morning/asset/shared-name.png`);
  expect(bobGet.status).toBe(200);
  expect(new Uint8Array(await bobGet.arrayBuffer())).toEqual(bobBytes);

  // /u/<unknown>/... 404s.
  const phantom = await fetch(`${baseUrl}/u/phantom-user/t/morning/asset/shared-name.png`);
  expect(phantom.status).toBe(404);

  // Legacy /t/<thread>/asset/<file> with collision now 404s (was a leak risk).
  const legacy = await fetch(`${baseUrl}/t/morning/asset/shared-name.png`);
  expect(legacy.status).toBe(404);
});

test("legacy /t/<thread>/asset/<file> still serves single-user (single-tenant compat)", async () => {
  const aliceTok = await pairAs("alice");
  const bytes = new TextEncoder().encode("only-alice");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await fetch(`${baseUrl}/v1/sync/assets/${hash}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${aliceTok}`,
      "content-type": "application/octet-stream",
      "x-folio-filename": "solo.png",
      "x-folio-thread-id": "solo-thread",
    },
    body: bytes,
  });
  // No collision → legacy route works.
  const r = await fetch(`${baseUrl}/t/solo-thread/asset/solo.png`);
  expect(r.status).toBe(200);
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
  // New route works too.
  const r2 = await fetch(`${baseUrl}/u/alice/t/solo-thread/asset/solo.png`);
  expect(r2.status).toBe(200);
});

test("Bob cannot push live entries against Alice's note", async () => {
  const aliceTok = await pairAs("alice");
  const bobTok = await pairAs("bob");
  const uuid = "01HXALICE-LIVE";
  await push(aliceTok, [{
    uuid,
    slug: "live",
    thread_id: "live",
    title: "Live note",
    type: "journal",
    body_html: "<p>live</p>",
    created_at: "2026-05-15T09:00:00Z",
    live: 1,
    owner_device_id: null,
  }]);

  // Bob tries to spam entries into Alice's live note.
  const r = await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bobTok}`, "content-type": "application/json" },
    body: JSON.stringify({
      live_entries: [{
        id: "01HXBOB-ENTRY",
        note_uuid: uuid,
        ts: "2026-05-15T09:01:00Z",
        content_html: "<p>spam</p>",
      }],
    }),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { live_entries: any[] };
  expect(body.live_entries).toHaveLength(0); // silent skip — owner mismatch
});
