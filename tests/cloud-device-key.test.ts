// sc-24117 — device-key request signing ("folio-sync-v1"): pair with a key,
// signed requests, bearer death after pin, replay/skew/tamper rejection,
// P-256 (NotiBox gate) via a remote signer, and the bearer → key upgrade.
import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { closeCloudDb, cloudDb } from "../src/cloud/db";

let tmpDir: string;
let folioHome: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let signerSrv: { stop: () => void; port: number } | null = null;
let baseUrl: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-device-key-"));
  folioHome = join(tmpDir, "folio");
  process.env.FOLIO_CLOUD_HOME = join(tmpDir, "cloud");
  process.env.FOLIO_HOME = folioHome;
  delete process.env.FOLIO_DEVICE_KEY_PATH;
  delete process.env.FOLIO_CLOUD_SIGNER;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0 })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;
});

afterEach(() => {
  try { server?.stop(); } catch {}
  try { signerSrv?.stop(); } catch {}
  server = null;
  signerSrv = null;
  closeCloudDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_CLOUD_HOME;
  delete process.env.FOLIO_HOME;
});

async function code(): Promise<string> {
  const { createPairingCode } = await import("../src/cloud/auth");
  return createPairingCode().code;
}

test("pair with ed25519 key: no token, key file 0600, signed requests work", async () => {
  const { pairWithKey, cloudFetch, deviceKeyPath } = await import("../src/core/cloud-auth");
  const r = await pairWithKey(baseUrl, await code(), "mac-jarka", "dev-mac");
  expect(r.key_alg).toBe("ed25519");
  expect(r.token).toBeUndefined();
  expect(r.device_id).toBe("dev-mac");
  expect(statSync(deviceKeyPath()).mode & 0o777).toBe(0o600);

  const row = cloudDb().query<{ public_key: string; key_alg: string }, []>(
    "SELECT public_key, key_alg FROM devices WHERE id = 'dev-mac'"
  ).get()!;
  expect(row.key_alg).toBe("ed25519");
  expect(row.public_key).toContain("BEGIN PUBLIC KEY");

  const state = { remote: baseUrl, key_alg: "ed25519" as const, device_id: "dev-mac" };
  const get = await cloudFetch(state, `${baseUrl}/v1/sync/pull?since=0`);
  expect(get.status).toBe(200);
  const post = await cloudFetch(state, `${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deletes: [] }),
  });
  expect(post.status).toBe(200);
});

test("pair with a key requires proof of possession", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const res = await fetch(`${baseUrl}/v1/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: await code(), device_name: "x", device_id: "dev-x",
      public_key: publicKey.export({ type: "spki", format: "pem" }), key_alg: "ed25519",
    }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("signed");
});

test("pair rejects alg/key mismatch", async () => {
  const { pairWithKey } = await import("../src/core/cloud-auth");
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const res = await fetch(`${baseUrl}/v1/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: await code(), device_name: "x", device_id: "dev-x",
      public_key: publicKey.export({ type: "spki", format: "pem" }), key_alg: "ed25519",
    }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("not ed25519");
  void pairWithKey;
});

async function pairedState() {
  const { pairWithKey } = await import("../src/core/cloud-auth");
  await pairWithKey(baseUrl, await code(), "mac", "dev-1");
  return { remote: baseUrl, key_alg: "ed25519" as const, device_id: "dev-1" };
}

test("replayed request (same nonce) is rejected", async () => {
  const { signatureHeaders, localSigner } = await import("../src/core/cloud-auth");
  await pairedState();
  const url = `${baseUrl}/v1/sync/pull?since=0`;
  const h = await signatureHeaders(localSigner(), "dev-1", "GET", url, null);
  expect((await fetch(url, { headers: h })).status).toBe(200);
  expect((await fetch(url, { headers: h })).status).toBe(401);
});

test("tampered path, body, or stale timestamp is rejected", async () => {
  const { signatureHeaders, localSigner, canonicalString, sha256Hex } = await import("../src/core/cloud-auth");
  await pairedState();
  // Signed for one path, sent to another.
  const h1 = await signatureHeaders(localSigner(), "dev-1", "GET", `${baseUrl}/v1/sync/pull?since=0`, null);
  expect((await fetch(`${baseUrl}/v1/sync/pull?since=5`, { headers: h1 })).status).toBe(401);
  // Signed for one body, sent with another.
  const url = `${baseUrl}/v1/sync/push`;
  const h2 = await signatureHeaders(localSigner(), "dev-1", "POST", url, JSON.stringify({ deletes: [] }));
  const r2 = await fetch(url, { method: "POST", headers: { ...h2, "content-type": "application/json" }, body: JSON.stringify({ deletes: ["x"] }) });
  expect(r2.status).toBe(401);
  // Validly signed, but 10 minutes old.
  const ts = String(Date.now() - 10 * 60 * 1000);
  const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
  const payload = canonicalString("GET", "/v1/sync/pull?since=0", ts, nonce, sha256Hex(null));
  const sig = await localSigner().sign(payload);
  const r3 = await fetch(`${baseUrl}/v1/sync/pull?since=0`, {
    headers: { "x-folio-device": "dev-1", "x-folio-ts": ts, "x-folio-nonce": nonce, "x-folio-sig": sig },
  });
  expect(r3.status).toBe(401);
});

test("signature from another key for the same device id is rejected", async () => {
  const { canonicalString, sha256Hex } = await import("../src/core/cloud-auth");
  await pairedState();
  const { privateKey } = generateKeyPairSync("ed25519");
  const ts = String(Date.now());
  const nonce = "BBBBBBBBBBBBBBBBBBBBBB";
  const sig = cryptoSign(null, Buffer.from(canonicalString("GET", "/v1/sync/pull?since=0", ts, nonce, sha256Hex(null))), privateKey).toString("base64url");
  const r = await fetch(`${baseUrl}/v1/sync/pull?since=0`, {
    headers: { "x-folio-device": "dev-1", "x-folio-ts": ts, "x-folio-nonce": nonce, "x-folio-sig": sig },
  });
  expect(r.status).toBe(401);
});

test("revoked device cannot sign in", async () => {
  const { cloudFetch } = await import("../src/core/cloud-auth");
  const { revokeDevice } = await import("../src/cloud/auth");
  const state = await pairedState();
  revokeDevice("dev-1");
  expect((await cloudFetch(state, `${baseUrl}/v1/sync/pull?since=0`)).status).toBe(401);
});

test("pin-key: bearer device upgrades, bearer dies, state has no token", async () => {
  const { consumePairingCode } = await import("../src/cloud/auth");
  const { pinKey, cloudFetch } = await import("../src/core/cloud-auth");
  const { token } = consumePairingCode(await code(), "old-mac", "dev-old");
  const state: any = { remote: baseUrl, device_token: token };
  expect((await cloudFetch(state, `${baseUrl}/v1/sync/pull?since=0`)).status).toBe(200);

  await pinKey(state, "dev-old");
  expect(state.device_token).toBeUndefined();
  expect(state.key_alg).toBe("ed25519");
  expect(state.device_id).toBe("dev-old");

  expect((await cloudFetch(state, `${baseUrl}/v1/sync/pull?since=0`)).status).toBe(200);
  const old = await fetch(`${baseUrl}/v1/sync/pull?since=0`, { headers: { authorization: `Bearer ${token}` } });
  expect(old.status).toBe(401);
});

test("pin-key without proof of possession is refused and bearer survives", async () => {
  const { consumePairingCode } = await import("../src/cloud/auth");
  const { token } = consumePairingCode(await code(), "old-mac", "dev-old");
  const { publicKey } = generateKeyPairSync("ed25519");
  const res = await fetch(`${baseUrl}/v1/auth/pin-key`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey.export({ type: "spki", format: "pem" }), key_alg: "ed25519" }),
  });
  expect(res.status).toBe(400);
  const still = await fetch(`${baseUrl}/v1/sync/pull?since=0`, { headers: { authorization: `Bearer ${token}` } });
  expect(still.status).toBe(200);
});

test("p256 via remote signer (NotiBox gate contract), P1363 and DER both verify", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const seen: string[] = [];
  let der = false;
  signerSrv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { payload } = (await req.json()) as { payload: string };
      seen.push(payload);
      if (!payload.startsWith("folio-sync-v1\n")) return new Response("no", { status: 403 });
      const sig = cryptoSign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: der ? "der" : "ieee-p1363" });
      return Response.json({ sig: sig.toString("base64url"), alg: "p256", public_key: pubPem });
    },
  }) as any;
  const signerUrl = `http://127.0.0.1:${signerSrv!.port}/folio-sign`;
  const { pairWithKey, cloudFetch } = await import("../src/core/cloud-auth");
  const r = await pairWithKey(baseUrl, await code(), "notibox-f8c0", "dev-box", signerUrl);
  expect(r.key_alg).toBe("p256");
  expect(r.signer_url).toBe(signerUrl);
  const state = { remote: baseUrl, key_alg: "p256" as const, device_id: "dev-box", signer_url: signerUrl };
  expect((await cloudFetch(state, `${baseUrl}/v1/sync/pull?since=0`)).status).toBe(200);
  der = true;
  expect((await cloudFetch(state, `${baseUrl}/v1/sync/pull?since=0`)).status).toBe(200);
  expect(seen.every((p) => p.startsWith("folio-sync-v1\n"))).toBe(true);
  // No private key file is written on the box path.
  const { existsSync } = await import("node:fs");
  const { deviceKeyPath } = await import("../src/core/cloud-auth");
  expect(existsSync(deviceKeyPath())).toBe(false);
});

test("asset upload body (bytes) is covered by the signature", async () => {
  const { cloudFetch } = await import("../src/core/cloud-auth");
  const state = await pairedState();
  const bytes = new Uint8Array(Buffer.from("png-bytes"));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const res = await cloudFetch(state, `${baseUrl}/v1/sync/assets/${hash}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Folio-Filename": "a.png", "X-Folio-Thread-Id": "t1" },
    body: bytes,
  });
  expect(res.status).toBeLessThan(300);
});

test("legacy bearer devices (PWA, pre-sc-24117) keep working", async () => {
  const { consumePairingCode } = await import("../src/cloud/auth");
  const { token } = consumePairingCode(await code(), "iphone", undefined);
  expect(typeof token).toBe("string");
  const r = await fetch(`${baseUrl}/v1/sync/pull?since=0`, { headers: { authorization: `Bearer ${token}` } });
  expect(r.status).toBe(200);
  void readFileSync;
});
