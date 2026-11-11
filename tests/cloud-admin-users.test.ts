/**
 * /v1/admin/* operator endpoints (v0.14+).
 *
 *  ✓ /v1/admin/whoami exposes user_id + is_operator (any authed device)
 *  ✓ Operator-only routes 403 for non-operator devices
 *  ✓ POST /v1/admin/users creates + optionally mints first pair-code
 *  ✓ PATCH /v1/admin/users/<id> renames / promotes / demotes / reactivates
 *  ✓ DELETE /v1/admin/users/<id>[?purge=1] revokes / purges
 *  ✓ POST /v1/admin/users/<id>/pair-code mints a code scoped to that user
 *  ✓ /v1/admin/users (GET) returns the global per-user breakdown
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeCloudDb, cloudDb } from "../src/cloud/db";

let tmpDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let baseUrl: string;

async function pairAs(userId: string, deviceName = `${userId}-dev`, deviceId?: string): Promise<string> {
  const { legacyPairResponse } = await import("./_cloud-device");
  const res = legacyPairResponse({ name: deviceName, userId, deviceId: deviceId ?? `01HX-${userId.toUpperCase()}-${Math.random().toString(16).slice(2,10)}` });
  return ((await res.json()) as { token: string }).token;
}

async function addUser(id: string, isOperator = false): Promise<void> {
  cloudDb().run(
    "INSERT INTO users (id, display_name, is_operator, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    [id, id, isOperator ? 1 : 0]
  );
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-admin-users-"));
  process.env.FOLIO_CLOUD_HOME = tmpDir;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0, publicUrl: "https://folio.example.com" })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;
});

afterEach(() => {
  try { server?.stop(); } catch {}
  server = null;
  closeCloudDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_CLOUD_HOME;
});

test("/v1/admin/whoami: any authed device, surfaces is_operator", async () => {
  await addUser("alice", false);
  await addUser("jarek", true);
  const aliceTok = await pairAs("alice");
  const jarekTok = await pairAs("jarek");

  const aliceMe = (await (await fetch(`${baseUrl}/v1/admin/whoami`, {
    headers: { Authorization: `Bearer ${aliceTok}` },
  })).json()) as any;
  expect(aliceMe.user_id).toBe("alice");
  expect(aliceMe.is_operator).toBe(false);

  const jarekMe = (await (await fetch(`${baseUrl}/v1/admin/whoami`, {
    headers: { Authorization: `Bearer ${jarekTok}` },
  })).json()) as any;
  expect(jarekMe.user_id).toBe("jarek");
  expect(jarekMe.is_operator).toBe(true);
});

test("/v1/admin/users: GET requires operator", async () => {
  await addUser("alice", false);
  const aliceTok = await pairAs("alice");
  const r = await fetch(`${baseUrl}/v1/admin/users`, {
    headers: { Authorization: `Bearer ${aliceTok}` },
  });
  expect(r.status).toBe(403);
});

test("/v1/admin/users: GET returns global per-user breakdown for operator", async () => {
  await addUser("jarek", true);
  await addUser("alice", false);
  const jarekTok = await pairAs("jarek");
  const r = await fetch(`${baseUrl}/v1/admin/users`, {
    headers: { Authorization: `Bearer ${jarekTok}` },
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(Array.isArray(body.users)).toBe(true);
  const ids = body.users.map((u: any) => u.id).sort();
  expect(ids).toContain("jarek");
  expect(ids).toContain("alice");
  expect(ids).toContain("default"); // schema-seeded
  const jarekRow = body.users.find((u: any) => u.id === "jarek");
  expect(jarekRow.is_operator).toBe(true);
});

test("/v1/admin/users: POST creates user, never mints a pair-code (sc-24120)", async () => {
  await addUser("jarek", true);
  const jarekTok = await pairAs("jarek");

  const r = await fetch(`${baseUrl}/v1/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jarekTok}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "bob", display_name: "Bob", mint_pair_code: true }),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.user.id).toBe("bob");
  expect(body.user.display_name).toBe("Bob");
  expect(body.user.is_operator).toBe(false);
  // mint_pair_code is ignored: an unbound code could only pair a phone.
  expect(body.pair_code).toBeUndefined();
  const codes = cloudDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pairing_codes").get()!.n;
  expect(codes).toBe(0);
});

test("/v1/admin/users: POST rejects bad id + duplicate id", async () => {
  await addUser("jarek", true);
  const jarekTok = await pairAs("jarek");

  const bad = await fetch(`${baseUrl}/v1/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jarekTok}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "BadCase" }),
  });
  expect(bad.status).toBe(400);

  await fetch(`${baseUrl}/v1/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jarekTok}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "alice" }),
  });
  const dup = await fetch(`${baseUrl}/v1/admin/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jarekTok}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "alice" }),
  });
  expect(dup.status).toBe(409);
});

test("/v1/admin/users/<id>: PATCH renames atomically + bearer survives", async () => {
  await addUser("jarek", true);
  await addUser("temp-name", false);
  const jarekTok = await pairAs("jarek");
  // Pair a device into temp-name so we can confirm bearer survives rename.
  const tempTok = await pairAs("temp-name");

  const r = await fetch(`${baseUrl}/v1/admin/users/temp-name`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${jarekTok}`, "content-type": "application/json" },
    body: JSON.stringify({ new_id: "alice" }),
  });
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).id).toBe("alice");

  // tempTok still works.
  const me = (await (await fetch(`${baseUrl}/v1/admin/whoami`, {
    headers: { Authorization: `Bearer ${tempTok}` },
  })).json()) as any;
  expect(me.user_id).toBe("alice");
});

test("/v1/admin/users/<id>: PATCH promotes / demotes via is_operator field", async () => {
  await addUser("jarek", true);
  await addUser("alice", false);
  const jarekTok = await pairAs("jarek");

  // promote
  await fetch(`${baseUrl}/v1/admin/users/alice`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${jarekTok}`, "content-type": "application/json" },
    body: JSON.stringify({ is_operator: true }),
  });
  expect(cloudDb().query<{ is_operator: number }, [string]>("SELECT is_operator FROM users WHERE id = ?").get("alice")?.is_operator).toBe(1);

  // demote
  await fetch(`${baseUrl}/v1/admin/users/alice`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${jarekTok}`, "content-type": "application/json" },
    body: JSON.stringify({ is_operator: false }),
  });
  expect(cloudDb().query<{ is_operator: number }, [string]>("SELECT is_operator FROM users WHERE id = ?").get("alice")?.is_operator).toBe(0);
});

test("/v1/admin/users/<id>: DELETE without ?purge revokes devices only", async () => {
  await addUser("jarek", true);
  await addUser("alice", false);
  const jarekTok = await pairAs("jarek");
  await pairAs("alice"); // creates 1 device for alice

  const r = await fetch(`${baseUrl}/v1/admin/users/alice`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jarekTok}` },
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.revoked_devices).toBe(1);
  expect(body.purged).toBeUndefined();

  // Alice's user row still present.
  expect(cloudDb().query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get("alice")).not.toBeNull();
});

test("/v1/admin/users/<id>: DELETE?purge=1 cascades + sets deleted_at", async () => {
  await addUser("jarek", true);
  await addUser("alice", false);
  const jarekTok = await pairAs("jarek");
  const aliceTok = await pairAs("alice");

  // Alice pushes a note so there's data to cascade.
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
    body: JSON.stringify({
      notes: [{
        uuid: "01HX-ALICE-PURGE-N1",
        slug: "n1",
        thread_id: "t1",
        title: "Alice doomed",
        type: "snippet",
        body_html: "<p>bye</p>",
        created_at: "2026-05-16T09:00:00Z",
      }],
    }),
  });

  const r = await fetch(`${baseUrl}/v1/admin/users/alice?purge=1`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jarekTok}` },
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.purged.notes).toBe(1);
  expect(body.revoked_devices).toBe(1);

  expect(cloudDb().query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM notes WHERE user_id = ?").get("alice")?.n).toBe(0);
  expect(cloudDb().query<{ deleted_at: string | null }, [string]>("SELECT deleted_at FROM users WHERE id = ?").get("alice")?.deleted_at).not.toBeNull();
});

test("operator routes 403 for non-operator devices", async () => {
  await addUser("alice", false);
  const aliceTok = await pairAs("alice");

  const tests = [
    ["GET",    "/v1/admin/users"],
    ["POST",   "/v1/admin/users"],
    ["PATCH",  "/v1/admin/users/alice"],
    ["DELETE", "/v1/admin/users/alice"],
    ["POST",   "/v1/admin/users/alice/pair-code"],
  ] as const;
  for (const [method, url] of tests) {
    const r = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Authorization: `Bearer ${aliceTok}`, "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ id: "x" }),
    });
    expect(r.status).toBe(403);
  }
});

test("PATCH reactivate: brings a deleted user back", async () => {
  await addUser("jarek", true);
  await addUser("alice", false);
  cloudDb().run("UPDATE users SET deleted_at = ? WHERE id = 'alice'", [new Date().toISOString()]);
  const jarekTok = await pairAs("jarek");

  // Without reactivate flag → 409.
  const noFlag = await fetch(`${baseUrl}/v1/admin/users/alice`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${jarekTok}`, "content-type": "application/json" },
    body: JSON.stringify({ display_name: "Alice 2.0" }),
  });
  expect(noFlag.status).toBe(409);

  // With reactivate → ok.
  const r = await fetch(`${baseUrl}/v1/admin/users/alice`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${jarekTok}`, "content-type": "application/json" },
    body: JSON.stringify({ reactivate: true, display_name: "Alice 2.0" }),
  });
  expect(r.status).toBe(200);
  const row = cloudDb()
    .query<{ deleted_at: string | null; display_name: string }, [string]>("SELECT deleted_at, display_name FROM users WHERE id = ?")
    .get("alice");
  expect(row?.deleted_at).toBeNull();
  expect(row?.display_name).toBe("Alice 2.0");
});
