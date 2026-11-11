/**
 * Tests for GET /v1/admin/stats — read-only observability snapshot.
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeCloudDb } from "../src/cloud/db";

let tmpDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let baseUrl: string;
let token = "";

async function pair(deviceName = "test", deviceId = "01HXTESTDEV0000000000000000"): Promise<string> {
  const { legacyPairResponse } = await import("./_cloud-device");
  const res = legacyPairResponse({ name: deviceName, deviceId: deviceId });
  const { token: t } = (await res.json()) as { token: string };
  return t;
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-admin-stats-"));
  process.env.FOLIO_CLOUD_HOME = tmpDir;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0, publicUrl: "https://folio.example.com" })) as any;
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

test("/v1/admin/stats requires auth", async () => {
  const res = await fetch(`${baseUrl}/v1/admin/stats`);
  expect(res.status).toBe(401);
});

test("/v1/admin/stats returns zero-state snapshot on fresh cloud", async () => {
  const res = await fetch(`${baseUrl}/v1/admin/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.cloud).toBeDefined();
  expect(body.cloud.name).toBe("folio-cloud");
  expect(typeof body.cloud.version).toBe("string");
  expect(body.cloud.public_url).toBe("https://folio.example.com");
  expect(body.counts).toBeDefined();
  expect(body.counts.notes).toBe(0);
  expect(body.counts.live_entries).toBe(0);
  expect(body.counts.assets).toBe(0);
  expect(body.counts.devices_active).toBe(1); // we just paired
  expect(body.counts.devices_revoked).toBe(0);
  expect(body.counts.tombstones).toBe(0);
  expect(body.storage.db_bytes).toBeGreaterThan(0); // SQLite file exists
  expect(body.storage.assets_bytes).toBe(0);
  expect(body.devices).toHaveLength(1);
  expect(body.devices[0].name).toBe("test");
  expect(body.devices[0].note_count).toBe(0);
  expect(body.threads).toHaveLength(0);
});

test("/v1/admin/stats reflects pushed notes + live entries + assets", async () => {
  // Push 2 notes, one live, one final.
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      notes: [
        {
          uuid: "01HXNOTE001",
          slug: "note-1",
          thread_id: "ops",
          title: "Note 1",
          type: "research",
          body_html: "<p>one</p>",
          created_at: "2026-05-10T10:00:00Z",
          is_final: 1,
        },
        {
          uuid: "01HXNOTE002",
          slug: "note-2",
          thread_id: "ops",
          title: "Note 2",
          type: "journal",
          body_html: "<p>two</p>",
          created_at: "2026-05-11T10:00:00Z",
          live: 1,
          owner_device_id: "01HXTESTDEV0000000000000000",
        },
      ],
      live_entries: [
        {
          id: "01HXENTRY01",
          note_uuid: "01HXNOTE002",
          ts: "2026-05-11T10:01:00Z",
          content_html: "<p>entry</p>",
          tags: [],
        },
      ],
    }),
  });

  // Push an asset.
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await fetch(`${baseUrl}/v1/sync/assets/${hash}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-folio-filename": "tiny.png",
      "x-folio-thread-id": "ops",
    },
    body: bytes,
  });

  // Issue a share.
  await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: "01HXNOTE001" }),
  });

  const res = await fetch(`${baseUrl}/v1/admin/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as any;
  expect(body.counts.notes).toBe(2);
  expect(body.counts.notes_live).toBe(1);
  expect(body.counts.notes_final).toBe(1);
  expect(body.counts.live_entries).toBe(1);
  expect(body.counts.assets).toBe(1);
  expect(body.counts.shares_active).toBe(1);
  expect(body.counts.shares_total).toBe(1);
  expect(body.storage.assets_bytes).toBe(8);
  expect(body.devices).toHaveLength(1);
  expect(body.devices[0].note_count).toBe(2);
  expect(body.devices[0].last_pushed_at).toBeTruthy();
  expect(body.threads).toHaveLength(1);
  expect(body.threads[0].thread_id).toBe("ops");
  expect(body.threads[0].count).toBe(2);
});

test("/v1/admin/stats counts tombstones after a delete", async () => {
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      notes: [
        {
          uuid: "01HXTOMB001",
          slug: "doomed",
          thread_id: "trash-test",
          title: "Doomed",
          type: "research",
          body_html: "<p>bye</p>",
          created_at: "2026-05-12T10:00:00Z",
        },
      ],
    }),
  });
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ deletes: ["01HXTOMB001"] }),
  });

  const res = await fetch(`${baseUrl}/v1/admin/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as any;
  expect(body.counts.notes).toBe(0);
  expect(body.counts.tombstones).toBe(1);
});
