/**
 * Auth primitives + bearer middleware for the cloud relay.
 *
 * Token model:
 * - 32 random bytes, base64url-encoded → 43-char string (no padding).
 * - The plaintext token is returned ONCE to the device at pair time; only its
 *   SHA-256 hash is persisted server-side. Revocation = `UPDATE devices SET
 *   revoked_at = now WHERE id = ?`. Lost tokens = pair a new device.
 *
 * Pairing flow:
 * 1. Admin runs `folio cloud pair-code` on the server → 6-digit code, 10min TTL.
 * 2. Device hits POST /v1/auth/pair with `{code, device_name}`.
 * 3. Server validates code, creates device row + token, returns
 *    `{device_id, token}`. Plaintext token only travels once over TLS.
 *
 * Bearer middleware:
 * - Look up Authorization: Bearer <token> → sha256 → devices.token_hash.
 * - Reject if no match, or if device.revoked_at IS NOT NULL.
 * - On hit, throttle-update devices.last_seen_at (≥60s gap) and inject
 *   req.device into route context.
 *
 * Unauthed paths: /healthz, /manifest.webmanifest (PWA discovery, W3), /pair
 * (PWA pairing screen, W3), /p/:token/* (capability URLs, W4 — own validator).
 */

import { Database } from "bun:sqlite";
import { cloudDb, nextSeq as _unusedNext } from "./db";
import { randomBytes, createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { canonicalString, SIG_CONTEXT, type KeyAlg } from "../core/cloud-auth";

// UUIDv7 generator — time-sortable, used for device.id and elsewhere across
// the cloud-mvp work. RFC 9562. Format: 48 bits unix-ms timestamp, then 4 bits
// version (7), 12 bits random, 2 bits variant (10), then 62 bits random.
export function uuidv7(): string {
  const buf = randomBytes(16);
  const ts = Date.now();
  // 48 bits timestamp
  buf[0] = (ts / 2 ** 40) & 0xff;
  buf[1] = (ts / 2 ** 32) & 0xff;
  buf[2] = (ts / 2 ** 24) & 0xff;
  buf[3] = (ts / 2 ** 16) & 0xff;
  buf[4] = (ts / 2 ** 8) & 0xff;
  buf[5] = ts & 0xff;
  // version 7 in high nibble of byte 6
  buf[6] = (0x70 | (buf[6]! & 0x0f)) & 0xff;
  // variant 10 in high two bits of byte 8
  buf[8] = (0x80 | (buf[8]! & 0x3f)) & 0xff;
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Generate a fresh bearer token (43 chars base64url, no padding). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of a token, hex-encoded — what we persist. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Generate a 6-digit pairing code (zero-padded). 1 in 1M collision chance per gen. */
export function generatePairingCode(): string {
  const n = randomBytes(3).readUIntBE(0, 3) % 1000000;
  return n.toString(10).padStart(6, "0");
}

const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface CreatePairingCodeResult {
  code: string;
  expiresAt: string; // ISO 8601
  userId: string;    // which account the new device will join (v0.13+)
}

/**
 * Create a new pairing code. Caller is expected to print it on the server
 * console (NOT log it to journald with default settings, but for one-user MVP
 * we accept that — the code is short-lived and the journal is local).
 *
 * `userId` (v0.13+) determines which account the new device joins. Defaults
 * to 'default' so the v0.12-era code path (no --user flag) keeps working
 * against the seeded 'default' user.
 */
export function createPairingCode(
  userId: string = "default",
  db: Database = cloudDb()
): CreatePairingCodeResult {
  // Clean up expired codes opportunistically — cheap, prevents indefinite growth.
  db.run("DELETE FROM pairing_codes WHERE expires_at < ?", [new Date().toISOString()]);
  // Retry once on the astronomically unlikely PK collision.
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    try {
      db.run("INSERT INTO pairing_codes (code, expires_at, user_id) VALUES (?, ?, ?)", [code, expiresAt, userId]);
      return { code, expiresAt, userId };
    } catch (e: any) {
      if (!/UNIQUE constraint/i.test(e?.message ?? "")) throw e;
      // collision: retry
    }
  }
  throw new Error("failed to allocate pairing code after retries — pairing_codes table possibly full");
}

export interface ConsumePairingResult {
  deviceId: string;
  /** Plaintext bearer, returned once. Null when the device paired with a key (sc-24117). */
  token: string | null;
}

/** sc-24117: public key a device pins at pair time (already verified by the caller). */
export interface PairKey {
  publicKeyPem: string;
  alg: KeyAlg;
}

/**
 * Atomically consume a pairing code and create a device row. Idempotent on
 * the code: once used, the same code returns the same device on re-consume
 * (within TTL) — but the token is regenerated, invalidating any prior token
 * from that code. Reason: prevents an attacker who sniffed the first token
 * from continuing to use it if the legitimate device re-pairs.
 *
 * `clientDeviceId` is optional but strongly recommended: when supplied, the
 * cloud uses the client's stable local id (from FolioConfig.device_id) as
 * the canonical device id on this side too. This way `origin_device_id`
 * stamped server-side at push time matches what the client tracks locally,
 * so own-echo skip works on pull. If omitted (legacy clients), the cloud
 * falls back to generating its own UUIDv7 — but then the client must
 * accept and store this id locally to keep the two sides in sync.
 *
 * Throws if code unknown or expired.
 */
export function consumePairingCode(
  code: string,
  deviceName: string,
  clientDeviceId?: string,
  db: Database = cloudDb(),
  key?: PairKey
): ConsumePairingResult {
  const row = db
    .query<{ code: string; expires_at: string; used_by_device_id: string | null; user_id: string }, [string]>(
      "SELECT code, expires_at, used_by_device_id, user_id FROM pairing_codes WHERE code = ?"
    )
    .get(code);
  if (!row) throw new Error("invalid pairing code");
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error("pairing code expired");

  const token = generateToken();
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    let deviceId: string;
    const pin = (id: string) =>
      db.run("UPDATE devices SET public_key = ?, key_alg = ? WHERE id = ?", [key?.publicKeyPem ?? null, key?.alg ?? null, id]);
    if (row.used_by_device_id) {
      // Re-pair through the SAME code: rotate token on the existing row.
      // user_id stays as it was at first pair — the code's user_id is
      // re-applied defensively in case the code was somehow re-purposed.
      deviceId = row.used_by_device_id;
      db.run(
        "UPDATE devices SET token_hash = ?, name = ?, paired_at = ?, revoked_at = NULL, user_id = ? WHERE id = ?",
        [tokenHash, deviceName, now, row.user_id, deviceId]
      );
      pin(deviceId);
    } else {
      // Fresh code. Use the client-supplied device_id when present; otherwise
      // the cloud generates its own (legacy/missing-id path).
      //
      // UPSERT, not INSERT: the client may already have a devices row from a
      // prior pair attempt (e.g. user retried after a "unauthorized" issue —
      // their PWA still has the same device_id in IndexedDB). UNIQUE on
      // devices.id would reject a re-INSERT. Treat re-pair-with-fresh-code as
      // "rotate token, clear revoked_at, refresh name + paired_at, anchor
      // user_id to the code's user_id". The attacker who steals a device_id
      // still needs a valid pairing code (10-min TTL, server-minted) to do
      // anything with it.
      deviceId = clientDeviceId && clientDeviceId.length > 0 ? clientDeviceId : uuidv7();
      db.run(
        `INSERT INTO devices (id, name, token_hash, paired_at, user_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           token_hash = excluded.token_hash,
           name = excluded.name,
           paired_at = excluded.paired_at,
           revoked_at = NULL,
           user_id = excluded.user_id`,
        [deviceId, deviceName, tokenHash, now, row.user_id]
      );
      db.run("UPDATE pairing_codes SET used_by_device_id = ? WHERE code = ?", [deviceId, code]);
      pin(deviceId);
    }
    return deviceId;
  });
  const deviceId = tx();
  // With a pinned key the bearer we just hashed is never handed out, so it
  // is dead on arrival — the device can only authenticate by signature.
  return { deviceId, token: key ? null : token };
}

export interface Device {
  id: string;
  name: string;
  userId: string;        // which account this device belongs to (v0.13+)
  isOperator: boolean;   // mirror of users.is_operator (v0.14+)
  pairedAt: string;
  lastSeenAt: string | null;
}

/**
 * Resolve a bearer token (raw, from the header) to a device. Returns null if
 * unknown, expired, or revoked. Updates last_seen_at if the previous touch was
 * more than 60s ago (cheap throttle to avoid write per request).
 *
 * Joins on users.is_operator so route handlers can check `device.isOperator`
 * inline rather than running a second query per request.
 */
export function authenticate(token: string, db: Database = cloudDb()): Device | null {
  if (!token || token.length < 16) return null;
  const tokenHash = hashToken(token);
  const row = db
    .query<
      {
        id: string;
        name: string;
        user_id: string;
        paired_at: string;
        last_seen_at: string | null;
        revoked_at: string | null;
        is_operator: number | null;
      },
      [string]
    >(
      `SELECT d.id, d.name, d.user_id, d.paired_at, d.last_seen_at, d.revoked_at,
              u.is_operator
         FROM devices d
         LEFT JOIN users u ON u.id = d.user_id
        WHERE d.token_hash = ?`
    )
    .get(tokenHash);
  if (!row) return null;
  if (row.revoked_at) return null;
  const now = Date.now();
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  if (now - lastSeen > 60_000) {
    db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [new Date(now).toISOString(), row.id]);
  }
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    isOperator: row.is_operator === 1,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Pull bearer token out of an Authorization header. */
export function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** Mark a device revoked (immediate effect on next request). */
export function revokeDevice(id: string, db: Database = cloudDb()): void {
  db.run("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [
    new Date().toISOString(),
    id,
  ]);
}

/**
 * List active (non-revoked) devices. For GET /v1/auth/devices.
 *
 * `userId` filter (v0.13+): when supplied, returns only that user's devices.
 * Callers in the route layer pass `device.userId` so a caller doesn't see
 * other users' device names through this endpoint. Omitting the filter is
 * an operator-only path (CLI `folio cloud user-list` builds on this).
 */
export function listDevices(userId?: string, db: Database = cloudDb()): Device[] {
  const sql = userId
    ? `SELECT d.id, d.name, d.user_id, d.paired_at, d.last_seen_at, u.is_operator
         FROM devices d LEFT JOIN users u ON u.id = d.user_id
        WHERE d.revoked_at IS NULL AND d.user_id = ? ORDER BY d.paired_at DESC`
    : `SELECT d.id, d.name, d.user_id, d.paired_at, d.last_seen_at, u.is_operator
         FROM devices d LEFT JOIN users u ON u.id = d.user_id
        WHERE d.revoked_at IS NULL ORDER BY d.paired_at DESC`;
  type Row = { id: string; name: string; user_id: string; paired_at: string; last_seen_at: string | null; is_operator: number | null };
  const rows = userId
    ? db.query<Row, [string]>(sql).all(userId)
    : db.query<Row, []>(sql).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    userId: r.user_id,
    isOperator: r.is_operator === 1,
    pairedAt: r.paired_at,
    lastSeenAt: r.last_seen_at,
  }));
}

/**
 * Paths that bypass bearer auth. /healthz for liveness probes;
 * /manifest.webmanifest + /pair for PWA bootstrap (W3); /p/:token/... for
 * capability URLs (W4, which have their own share validator).
 */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/healthz") return true;
  if (pathname === "/v1/version") return true;
  if (pathname === "/manifest.webmanifest") return true;
  // App shell is public — it contains no data, only a JS bootstrap that
  // reads the token from IndexedDB on the client. If no token, the shell
  // redirects to /pair. If token present, it fetches /v1/feed (authed).
  if (pathname === "/") return true;
  if (pathname === "/pair") return true;
  // /n/:uuid is ALSO a public JS shell (W3-fix-2): it reads the bearer
  // token from IDB client-side and fetches /raw/:uuid with auth. This
  // avoids the SW-controllerchange race on first navigation after install.
  // The outer page leaks nothing (just the uuid in the URL, no content).
  if (pathname.startsWith("/n/")) return true;
  // /t/:thread_id — same JS-shell pattern as /n/. Public page that fetches
  // its data via /v1/feed?thread= with the bearer token from IDB. Note that
  // /t/:thread_id/asset/:filename is ALSO public — body_html in rendered
  // notes references assets by relative path, and sub-resource fetches
  // from a sandboxed null-origin iframe can't easily carry bearer headers.
  // Asset URLs aren't enumerable without knowing thread_id + filename, and
  // the cloud's data is content the user explicitly pushed there — same
  // posture as the local viewer where assets are served auth-less from disk.
  if (pathname.startsWith("/t/")) return true;
  // /u/:user/t/:thread/asset/:file — v0.13+ per-user public asset route.
  // Same posture as /t/.../asset/... (sub-resource for sandboxed iframes),
  // pinned to user namespace so cross-user collisions can't leak bytes.
  if (pathname.startsWith("/u/")) return true;
  if (pathname.startsWith("/p/")) return true;
  // POST /v1/auth/pair is the entry point — also unauthed.
  if (pathname === "/v1/auth/pair") return true;
  // Icons + service worker served unauth for PWA bootstrap (W3).
  if (pathname.startsWith("/icons/")) return true;
  if (pathname === "/sw.js") return true;
  return false;
}

// ----- sc-24117: device-key request signing ("folio-sync-v1") -----

/** Accepted clock skew between device and cloud, both directions. */
export const SIG_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Parse + validate a public key for `alg`. Returns the normalized SPKI PEM
 * or throws. Rejects RSA, other curves, and alg/key mismatches so a device
 * cannot pin something the verifier would treat differently later.
 */
export function normalizePublicKey(pem: string, alg: string): { pem: string; alg: KeyAlg; key: KeyObject } {
  if (alg !== "ed25519" && alg !== "p256") throw new Error("key_alg must be ed25519 or p256");
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error("public_key is not a valid SPKI PEM");
  }
  if (alg === "ed25519" && key.asymmetricKeyType !== "ed25519") throw new Error("public_key is not ed25519");
  if (alg === "p256") {
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("public_key is not P-256");
    }
  }
  return { pem: key.export({ type: "spki", format: "pem" }) as string, alg, key };
}

/** Verify one signature over `payload`. P-256 accepts IEEE-P1363 (64 bytes, WebCrypto) and DER. */
export function verifyPayload(key: KeyObject, alg: KeyAlg, payload: string, sigB64url: string): boolean {
  let sig: Buffer;
  try {
    sig = Buffer.from(sigB64url, "base64url");
  } catch {
    return false;
  }
  if (sig.length === 0) return false;
  const data = Buffer.from(payload, "utf8");
  try {
    if (alg === "ed25519") return cryptoVerify(null, data, key, sig);
    const dsaEncoding = sig.length === 64 ? "ieee-p1363" : "der";
    return cryptoVerify("sha256", data, { key, dsaEncoding }, sig);
  } catch {
    return false;
  }
}

export interface SignedParts {
  deviceId: string;
  ts: string;
  nonce: string;
  sig: string;
}

/** Signature headers off a request, or null when it isn't a signed request. */
export function extractSignature(req: Request): SignedParts | null {
  const sig = req.headers.get("x-folio-sig");
  if (!sig) return null;
  return {
    deviceId: req.headers.get("x-folio-device") ?? "",
    ts: req.headers.get("x-folio-ts") ?? "",
    nonce: req.headers.get("x-folio-nonce") ?? "",
    sig,
  };
}

/** Canonical string for a received request — must match the client's cloudAuthHeaders. */
export function canonicalForRequest(req: Request, parts: SignedParts, body: Uint8Array): string {
  const u = new URL(req.url);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return canonicalString(req.method, u.pathname + u.search, parts.ts, parts.nonce, bodyHash);
}

/** Freshness check shared by authenticateSigned and the pair / pin-key handlers. */
export function signatureFresh(parts: SignedParts, now = Date.now()): boolean {
  if (!/^\d{10,16}$/.test(parts.ts)) return false;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(parts.nonce)) return false;
  return Math.abs(now - Number(parts.ts)) <= SIG_MAX_SKEW_MS;
}

// Replay guard: a (device, nonce) pair is accepted once inside the skew
// window. In-memory is enough — the cloud is a single process, and after a
// restart the timestamp window bounds what could be replayed to 5 minutes
// of requests already seen over TLS.
const seenNonces = new Map<string, number>();
function claimNonce(deviceId: string, nonce: string, now: number): boolean {
  if (seenNonces.size > 50_000) {
    for (const [k, exp] of seenNonces) if (exp < now) seenNonces.delete(k);
  }
  const k = `${deviceId}:${nonce}`;
  const exp = seenNonces.get(k);
  if (exp !== undefined && exp >= now) return false;
  seenNonces.set(k, now + 2 * SIG_MAX_SKEW_MS);
  return true;
}

/**
 * Resolve a signed request to a device. Null when the device has no pinned
 * key, is revoked, the timestamp is stale, the nonce was already used, or
 * the signature doesn't verify. Same last_seen_at throttle as authenticate().
 */
export function authenticateSigned(req: Request, parts: SignedParts, body: Uint8Array, db: Database = cloudDb()): Device | null {
  const now = Date.now();
  if (!parts.deviceId || !signatureFresh(parts, now)) return null;
  const row = db
    .query<
      {
        id: string; name: string; user_id: string; paired_at: string; last_seen_at: string | null;
        revoked_at: string | null; is_operator: number | null; public_key: string | null; key_alg: string | null;
      },
      [string]
    >(
      `SELECT d.id, d.name, d.user_id, d.paired_at, d.last_seen_at, d.revoked_at, u.is_operator,
              d.public_key, d.key_alg
         FROM devices d LEFT JOIN users u ON u.id = d.user_id
        WHERE d.id = ?`
    )
    .get(parts.deviceId);
  if (!row || row.revoked_at || !row.public_key || !row.key_alg) return null;
  let key: KeyObject;
  try {
    key = createPublicKey(row.public_key);
  } catch {
    return null;
  }
  if (!verifyPayload(key, row.key_alg as KeyAlg, canonicalForRequest(req, parts, body), parts.sig)) return null;
  if (!claimNonce(row.id, parts.nonce, now)) return null;
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  if (now - lastSeen > 60_000) {
    db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [new Date(now).toISOString(), row.id]);
  }
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    isOperator: row.is_operator === 1,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Proof of possession for pair / pin-key: the request must be signed with
 * the key being pinned, as `deviceId` (null = don't check the header: on
 * pin-key the bearer already identifies the device, and a legacy client may
 * not know the cloud-side id). Throws with a short reason.
 */
export function verifyProofOfPossession(req: Request, body: Uint8Array, deviceId: string | null, key: KeyObject, alg: KeyAlg): void {
  const parts = extractSignature(req);
  if (!parts) throw new Error("request must be signed with the key being pinned");
  if (deviceId !== null && parts.deviceId !== deviceId) throw new Error("x-folio-device does not match device_id");
  if (!signatureFresh(parts)) throw new Error("signature timestamp out of window");
  if (!verifyPayload(key, alg, canonicalForRequest(req, parts, body), parts.sig)) throw new Error("signature does not verify");
  if (!claimNonce(deviceId ?? parts.deviceId, parts.nonce, Date.now())) throw new Error("nonce already used");
}

/**
 * Pin a public key on an existing device and kill its bearer: token_hash
 * is overwritten with the hash of a token nobody ever sees. From here on
 * the device authenticates only by signature (sc-24117).
 */
export function pinDeviceKey(deviceId: string, publicKeyPem: string, alg: KeyAlg, db: Database = cloudDb()): void {
  db.run("UPDATE devices SET public_key = ?, key_alg = ?, token_hash = ? WHERE id = ? AND revoked_at IS NULL", [
    publicKeyPem,
    alg,
    hashToken(generateToken()),
    deviceId,
  ]);
}

export { SIG_CONTEXT };
