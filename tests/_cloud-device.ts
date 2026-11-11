// Test fixtures for Folio Cloud devices after sc-24120.
//
// The cloud no longer mints unbound pairing codes and refuses to consume one,
// so a test can no longer get a bearer through `createPairingCode()` +
// `POST /v1/auth/pair`. Two ways in remain:
//
//   - `legacyBearerDevice()` — a device row with a live bearer, exactly what a
//     device paired before sc-24120 (or before sc-24117 key pinning) looks
//     like in production. Those keep authenticating until revoked; tests that
//     only need "an authed caller" use this.
//   - `boundPairingCode()` + a real key — the one remaining pairing path
//     (NotiBox box key pinned by backplane, `pair-code --expect-key`).
//
// Not a *.test.ts file, so `bun test` does not run it on its own.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Database } from "bun:sqlite";
import { cloudDb } from "../src/cloud/db";
import { createPairingCode, generateToken, hashToken, uuidv7 } from "../src/cloud/auth";

export interface LegacyDevice {
  deviceId: string;
  token: string;
}

/** Insert an active bearer device for `userId` and return its token. The user
 *  row is created when missing (the cloud seeds only 'default'). */
export function legacyBearerDevice(
  opts: { name?: string; userId?: string; deviceId?: string; db?: Database } = {}
): LegacyDevice {
  const db = opts.db ?? cloudDb();
  const userId = opts.userId ?? "default";
  const deviceId = opts.deviceId ?? uuidv7();
  const token = generateToken();
  const now = new Date().toISOString();
  db.run(
    "INSERT OR IGNORE INTO users (id, display_name, is_operator, created_at) VALUES (?, ?, 0, ?)",
    [userId, userId, now]
  );
  db.run(
    `INSERT INTO devices (id, name, token_hash, paired_at, user_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, name = excluded.name,
       paired_at = excluded.paired_at, revoked_at = NULL, user_id = excluded.user_id`,
    [deviceId, opts.name ?? "test-device", hashToken(token), now, userId]
  );
  return { deviceId, token };
}

export interface TestKey {
  privateKey: KeyObject;
  pem: string;
  /** base64 SPKI DER — what backplane passes as `--expect-key`. */
  derB64: string;
}

export function ed25519Key(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    pem: publicKey.export({ type: "spki", format: "pem" }) as string,
    derB64: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
  };
}

/** Mint a code bound to `key` (the only kind the cloud accepts since sc-24120). */
export function boundPairingCode(key: Pick<TestKey, "derB64">, userId = "default", db?: Database): string {
  return createPairingCode(userId, db ?? cloudDb(), key.derB64).code;
}

/** `legacyBearerDevice()` wrapped as the JSON Response the old bearer
 *  `POST /v1/auth/pair` returned (`{device_id, token}`), so fixtures that
 *  parsed that response keep reading it unchanged. */
export function legacyPairResponse(
  opts: { name?: string; userId?: string; deviceId?: string; db?: Database } = {}
): Response {
  const d = legacyBearerDevice(opts);
  return Response.json({ device_id: d.deviceId, token: d.token });
}

/** A code bound to THIS device's local ed25519 key (created under
 *  FOLIO_HOME when missing) — what a client pairing through `pairWithKey`
 *  without a remote signer presents. */
export async function localBoundCode(userId = "default"): Promise<string> {
  const { localPublicKey, generateLocalKey } = await import("../src/core/cloud-auth");
  if (!localPublicKey()) generateLocalKey();
  return createPairingCode(userId, cloudDb(), localPublicKey()!).code;
}
