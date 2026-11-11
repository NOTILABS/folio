// sc-24117 PR C — pair-code bound to one public key (`--expect-key`).
// Backplane mints the code for a NotiBox with the box identity key it has
// pinned (devices.box_identity_key, base64 SPKI DER); the cloud then pairs
// only that key. A leaked 6-digit code cannot pair a foreign key or a bearer
// into the box's account.
import { expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { closeCloudDb, cloudDb } from "../src/cloud/db";

let tmpDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let signerSrv: { stop: () => void; port: number } | null = null;
let baseUrl: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-bound-key-"));
  process.env.FOLIO_CLOUD_HOME = join(tmpDir, "cloud");
  process.env.FOLIO_HOME = join(tmpDir, "folio");
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

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    pem: publicKey.export({ type: "spki", format: "pem" }) as string,
    derB64: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
  };
}

/** Gate stand-in (notibox /gate/folio/sign contract) signing with `k`. */
function gate(k: ReturnType<typeof p256>): string {
  signerSrv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { payload } = (await req.json()) as { payload: string };
      if (!payload.startsWith("folio-sync-v1\n")) return new Response("no", { status: 403 });
      const sig = cryptoSign("sha256", Buffer.from(payload), { key: k.privateKey, dsaEncoding: "ieee-p1363" });
      return Response.json({ sig: sig.toString("base64url"), alg: "p256", public_key: k.pem });
    },
  }) as any;
  return `http://127.0.0.1:${signerSrv!.port}/gate/folio/sign`;
}

test("bound code pairs the expected box key (base64 DER as kept by backplane)", async () => {
  const box = p256();
  const { createPairingCode } = await import("../src/cloud/auth");
  const c = createPairingCode("default", undefined, box.derB64);
  expect(c.boundKeyFp).toBe(createHash("sha256").update(Buffer.from(box.derB64, "base64")).digest("hex"));
  const { pairWithKey } = await import("../src/core/cloud-auth");
  const r = await pairWithKey(baseUrl, c.code, "notibox-f8c0-main", "dev-box", gate(box));
  expect(r.key_alg).toBe("p256");
  expect(r.token).toBeUndefined();
  const row = cloudDb().query<{ key_alg: string }, []>("SELECT key_alg FROM devices WHERE id = 'dev-box'").get()!;
  expect(row.key_alg).toBe("p256");
});

test("bound code accepts the key given as PEM too", async () => {
  const box = p256();
  const { createPairingCode } = await import("../src/cloud/auth");
  const c = createPairingCode("default", undefined, box.pem);
  const { pairWithKey } = await import("../src/core/cloud-auth");
  const r = await pairWithKey(baseUrl, c.code, "box", "dev-box-pem", gate(box));
  expect(r.key_alg).toBe("p256");
});

test("bound code refuses another key, even with a valid proof of possession", async () => {
  const box = p256();
  const thief = p256();
  const { createPairingCode } = await import("../src/cloud/auth");
  const c = createPairingCode("default", undefined, box.derB64);
  const { pairWithKey } = await import("../src/core/cloud-auth");
  await expect(pairWithKey(baseUrl, c.code, "obcy", "dev-obcy", gate(thief))).rejects.toThrow(/does not match/);
  // A local ed25519 key is just as foreign.
  await expect(pairWithKey(baseUrl, c.code, "obcy", "dev-obcy2", undefined)).rejects.toThrow(/does not match/);
  const n = cloudDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM devices").get()!;
  expect(n.n).toBe(0);
  const pc = cloudDb().query<{ used: string | null }, [string]>(
    "SELECT used_by_device_id AS used FROM pairing_codes WHERE code = ?"
  ).get(c.code)!;
  expect(pc.used).toBeNull();
  // The code is not burnt by the refusal: the right box can still pair with it.
  const r = await pairWithKey(baseUrl, c.code, "box", "dev-box", gate(box));
  expect(r.key_alg).toBe("p256");
});

test("bound code refuses a bearer (keyless) pair", async () => {
  const box = p256();
  const { createPairingCode } = await import("../src/cloud/auth");
  const c = createPairingCode("default", undefined, box.derB64);
  const res = await fetch(`${baseUrl}/v1/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: c.code, device_name: "pwa", device_id: "dev-pwa" }),
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("requires a device key");
});

test("sc-24120: unbound codes are gone — not minted, and a leftover one pairs no key", async () => {
  const { createPairingCode } = await import("../src/cloud/auth");
  expect(() => createPairingCode("default")).toThrow(/bound to a box key/);
  // A code minted before the change (expected_key NULL) is refused even for
  // a key with a valid proof of possession.
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  cloudDb().run("INSERT INTO pairing_codes (code, expires_at, user_id, expected_key) VALUES ('654321', ?, 'default', NULL)", [expires]);
  const { pairWithKey } = await import("../src/core/cloud-auth");
  await expect(pairWithKey(baseUrl, "654321", "laptop", "dev-laptop", undefined)).rejects.toThrow(/not bound to a box key/);
  expect(cloudDb().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM devices").get()!.n).toBe(0);
});

test("expected key must be a P-256 or ed25519 SPKI", async () => {
  const { normalizeExpectedKey } = await import("../src/cloud/auth");
  expect(() => normalizeExpectedKey("")).toThrow(/empty/);
  expect(() => normalizeExpectedKey("bm90LWEta2V5")).toThrow(/not a valid SPKI/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
  expect(() => normalizeExpectedKey((rsa.export({ type: "spki", format: "der" }) as Buffer).toString("base64"))).toThrow(
    /P-256 or ed25519/
  );
  const ed = generateKeyPairSync("ed25519").publicKey;
  const edB64 = (ed.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  expect(normalizeExpectedKey(ed.export({ type: "spki", format: "pem" }) as string)).toBe(edB64);
});

test("CLI `folio cloud pair-code --expect-key` prints the Bound key line backplane parses", async () => {
  server?.stop();
  server = null;
  const out: string[] = [];
  const errs: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: any[]) => void out.push(a.join(" ")));
  const error = spyOn(console, "error").mockImplementation((...a: any[]) => void errs.push(a.join(" ")));
  try {
    const { cloudCmd } = await import("../src/cli/commands/cloud");
    const box = p256();
    expect(await cloudCmd("pair-code", ["--expect-key", box.derB64])).toBe(0);
    const fp = createHash("sha256").update(Buffer.from(box.derB64, "base64")).digest("hex");
    // eslint-disable-next-line no-control-regex
    const plain = out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/Pairing code:\s*\d{6}/);
    expect(plain).toContain(`Bound key:    sha256:${fp}`);
    const code = plain.match(/Pairing code:\s*(\d{6})/)![1]!;
    const row = cloudDb().query<{ k: string }, [string]>("SELECT expected_key AS k FROM pairing_codes WHERE code = ?").get(code)!;
    expect(row.k).toBe(box.derB64);

    // sc-24120: no unbound code any more — the flag is required.
    out.length = 0;
    expect(await cloudCmd("pair-code", [])).toBe(5);
    expect(out.join("\n")).not.toContain("Pairing code");

    expect(await cloudCmd("pair-code", ["--expect-key", "zly-klucz"])).toBe(5);
    expect(await cloudCmd("pair-code", ["--expect-key"])).toBe(5);
    expect(errs.join("\n")).toContain("--expect-key");
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("migration adds pairing_codes.expected_key to a pre-PR-C cloud", async () => {
  server?.stop();
  server = null;
  closeCloudDb();
  const { Database } = await import("bun:sqlite");
  const { mkdirSync } = await import("node:fs");
  const dir = join(tmpDir, "old-cloud");
  mkdirSync(dir, { recursive: true });
  process.env.FOLIO_CLOUD_HOME = dir;
  // Fresh schema first, then drop the column the way a v0.46 cloud lacks it.
  cloudDb();
  closeCloudDb();
  const raw = new Database(join(dir, "cloud.sqlite"));
  raw.exec("ALTER TABLE pairing_codes DROP COLUMN expected_key");
  raw.close();
  const cols = cloudDb().query<{ name: string }, []>("PRAGMA table_info(pairing_codes)").all().map((c) => c.name);
  expect(cols).toContain("expected_key");
});
