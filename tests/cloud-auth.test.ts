import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeCloudDb, cloudDb } from "../src/cloud/db";

let tmpDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let baseUrl: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-cloud-auth-"));
  process.env.FOLIO_CLOUD_HOME = tmpDir;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0 })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;
});

afterEach(() => {
  try { server?.stop(); } catch {}
  server = null;
  closeCloudDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_CLOUD_HOME;
});

test("healthz is public + returns ok", async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("v1/version is public", async () => {
  const res = await fetch(`${baseUrl}/v1/version`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.name).toBe("folio-cloud");
  expect(typeof body.version).toBe("string");
});

test("authed routes return 401 without bearer", async () => {
  const res = await fetch(`${baseUrl}/v1/auth/devices`);
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe("unauthorized");
});

test("authed routes return 401 with invalid bearer", async () => {
  const res = await fetch(`${baseUrl}/v1/auth/devices`, {
    headers: { authorization: "Bearer not-a-real-token-1234567890" },
  });
  expect(res.status).toBe(401);
});

test("pairing rejects invalid code", async () => {
  const res = await fetch(`${baseUrl}/v1/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "999999", device_name: "test" }),
  });
  expect(res.status).toBe(400);
});

test("device list + revoke flow", async () => {
  const { legacyBearerDevice } = await import("./_cloud-device");
  const { deviceId: device_id, token } = legacyBearerDevice({ name: "doomed-laptop" });

  // List shows 1 device
  const listRes = await fetch(`${baseUrl}/v1/auth/devices`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(listRes.status).toBe(200);
  const { devices } = (await listRes.json()) as { devices: { id: string; name: string }[] };
  expect(devices).toHaveLength(1);
  expect(devices[0]!.name).toBe("doomed-laptop");

  // Revoke
  const revokeRes = await fetch(`${baseUrl}/v1/auth/device/${device_id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(revokeRes.status).toBe(200);

  // Now the same token is unauthorized
  const followup = await fetch(`${baseUrl}/v1/auth/devices`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(followup.status).toBe(401);
});

// ----- sc-24120: only a box pairs, with a code bound to its key -----

test("sc-24120: createPairingCode without a box key throws", async () => {
  const { createPairingCode } = await import("../src/cloud/auth");
  expect(() => createPairingCode()).toThrow(/bound to a box key/);
  expect(() => createPairingCode("default", undefined, "")).toThrow(/bound to a box key/);
  expect(cloudDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pairing_codes").get()!.n).toBe(0);
});

test("sc-24120: an unbound code minted before the change is refused, no device created", async () => {
  // What a phone/browser code left over from before the change looks like.
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  cloudDb().run("INSERT INTO pairing_codes (code, expires_at, user_id, expected_key) VALUES ('123456', ?, 'default', NULL)", [expires]);
  const res = await fetch(`${baseUrl}/v1/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456", device_name: "iphone" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toMatch(/not bound to a box key/);
  expect(cloudDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM devices").get()!.n).toBe(0);
});

test("sc-24120: a bound code does not pair a bearer (no key in the request)", async () => {
  const { ed25519Key, boundPairingCode } = await import("./_cloud-device");
  const code = boundPairingCode(ed25519Key());
  const res = await fetch(`${baseUrl}/v1/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, device_name: "iphone" }),
  });
  expect(res.status).toBe(400);
  expect(cloudDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM devices").get()!.n).toBe(0);
});

test("sc-24120: the cloud notebook app and pull are gone", async () => {
  const { legacyBearerDevice } = await import("./_cloud-device");
  const { token } = legacyBearerDevice();
  const auth = { authorization: `Bearer ${token}` };
  // Formerly public PWA surfaces: now unknown paths behind the auth gate.
  for (const path of ["/", "/pair", "/manifest.webmanifest", "/sw.js", "/icons/folio.svg", "/n/019e2110-0000-7000-8000-000000000001"]) {
    expect((await fetch(`${baseUrl}${path}`)).status).toBe(401);
    expect((await fetch(`${baseUrl}${path}`, { headers: auth })).status).toBe(404);
  }
  for (const [method, path] of [
    ["GET", "/v1/sync/pull?since=0"],
    ["GET", "/v1/sync/live-stream?note_uuid=x"],
    ["GET", "/v1/feed"],
    ["GET", "/raw/019e2110-0000-7000-8000-000000000001"],
    ["POST", "/v1/auth/pair-code"],
  ] as const) {
    expect((await fetch(`${baseUrl}${path}`, { method, headers: auth })).status).toBe(404);
  }
  // The live-stream query-param token no longer authenticates anything.
  expect((await fetch(`${baseUrl}/v1/auth/devices?token=${token}`)).status).toBe(401);
});
