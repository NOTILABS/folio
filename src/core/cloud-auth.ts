/**
 * sc-24117 — device-key request signing for the cloud relay ("folio-sync-v1").
 *
 * Why: the old model authenticated every device with a long-lived bearer
 * token stored in ~/Folio/.sync-state.json. That file travelled inside a
 * golden image, so every box cloned from it carried the same credential.
 * A signature made with a per-device private key has no shared secret on
 * the wire or in the state file: the cloud stores only the PUBLIC key
 * (`devices.public_key`), pinned once at pair time.
 *
 * Two signers:
 *   - `ed25519` (local) — laptops/desktops (Jarek's Mac). Key generated on
 *     this machine at pair / `folio sync pin-key`, PKCS#8 PEM in
 *     ~/Folio/.device-key.pem, mode 0600. Never leaves the machine.
 *   - `p256` (remote) — NotiBox. The box identity key
 *     (/var/lib/notibox/gate/box-identity.json) belongs to the gate and is
 *     not readable by the folio user, so Folio asks the gate to sign:
 *     POST <signer_url> {"payload": "<canonical string>"} →
 *     {"sig": "<base64url>", "alg": "p256", "public_key": "<SPKI PEM>"}.
 *     The gate side is notibox (sc-24117 PR C); Folio only defines the
 *     contract. The gate should refuse payloads not starting with
 *     `folio-sync-v1\n` so it is not a generic signing oracle.
 *
 * Wire format (request headers):
 *   x-folio-device: <device id>
 *   x-folio-ts:     <unix ms>
 *   x-folio-nonce:  <16 random bytes, base64url>
 *   x-folio-sig:    <base64url signature over canonical string>
 * Canonical string (UTF-8, "\n"-joined):
 *   folio-sync-v1 / METHOD / path+query / ts / nonce / sha256-hex(body)
 * P-256 signatures are IEEE-P1363 (r||s, 64 bytes) — what WebCrypto emits;
 * the cloud also accepts DER.
 *
 * Devices with neither signer (pre-sc-24117 state, browser PWA) keep the
 * bearer token. Once a key is pinned the cloud invalidates the bearer.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";
import { folioRoot } from "./config";

export const SIG_CONTEXT = "folio-sync-v1";
export type KeyAlg = "ed25519" | "p256";

/** Subset of SyncState this module reads — kept structural to avoid an import cycle with sync.ts. */
export interface CloudAuthState {
  remote: string;
  device_token?: string;
  /** Set once a key is pinned on the cloud. */
  key_alg?: KeyAlg;
  /** Cloud-side device id used in x-folio-device. */
  device_id?: string;
  /** p256 only: local gate endpoint that signs canonical strings. */
  signer_url?: string;
}

export function deviceKeyPath(): string {
  return process.env.FOLIO_DEVICE_KEY_PATH ?? join(folioRoot(), ".device-key.pem");
}

export function sha256Hex(body: Uint8Array | string | null | undefined): string {
  const h = createHash("sha256");
  if (body !== null && body !== undefined) h.update(typeof body === "string" ? Buffer.from(body, "utf8") : body);
  return h.digest("hex");
}

export function canonicalString(method: string, pathAndQuery: string, ts: string, nonce: string, bodyHashHex: string): string {
  return [SIG_CONTEXT, method.toUpperCase(), pathAndQuery, ts, nonce, bodyHashHex].join("\n");
}

/** Generate a fresh Ed25519 key, write it 0600 (atomic), return the SPKI PEM public key. */
export function generateLocalKey(path: string = deviceKeyPath()): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o600 });
  renameSync(tmp, path);
  return publicKey.export({ type: "spki", format: "pem" }) as string;
}

/** Public half of the local key, or null if there is no key file. */
export function localPublicKey(path: string = deviceKeyPath()): string | null {
  if (!existsSync(path)) return null;
  const priv = createPrivateKey(readFileSync(path, "utf-8"));
  return createPublicKey(priv).export({ type: "spki", format: "pem" }) as string;
}

export interface Signer {
  alg: KeyAlg;
  sign(payload: string): Promise<string>; // base64url
  publicKey(): Promise<string>;
}

export function localSigner(path: string = deviceKeyPath()): Signer {
  return {
    alg: "ed25519",
    async sign(payload) {
      const priv = createPrivateKey(readFileSync(path, "utf-8"));
      return cryptoSign(null, Buffer.from(payload, "utf8"), priv).toString("base64url");
    },
    async publicKey() {
      const pk = localPublicKey(path);
      if (!pk) throw new Error(`device key missing: ${path}`);
      return pk;
    },
  };
}

export function remoteSigner(url: string): Signer {
  let pub: string | null = null;
  const call = async (payload: string) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`signer ${url} → HTTP ${res.status}`);
    const out = (await res.json()) as { sig?: string; alg?: string; public_key?: string };
    if (!out.sig) throw new Error(`signer ${url}: no sig in response`);
    if (out.alg && out.alg !== "p256") throw new Error(`signer ${url}: unexpected alg ${out.alg}`);
    if (out.public_key) pub = out.public_key;
    return out.sig;
  };
  return {
    alg: "p256",
    sign: call,
    async publicKey() {
      if (!pub) await call(canonicalString("GET", "/v1/auth/whoami", String(Date.now()), "probe", sha256Hex(null)));
      if (!pub) throw new Error(`signer ${url}: no public_key in response`);
      return pub;
    },
  };
}

/** Signer for a state with a pinned key, or null when the device still uses a bearer token. */
export function signerFor(state: CloudAuthState): Signer | null {
  if (state.key_alg === "ed25519") return localSigner();
  if (state.key_alg === "p256") {
    if (!state.signer_url) throw new Error("sync state: key_alg p256 without signer_url");
    return remoteSigner(state.signer_url);
  }
  return null;
}

/** Signature headers for one request made with `signer` as device `deviceId`. */
export async function signatureHeaders(
  signer: Signer,
  deviceId: string,
  method: string,
  url: string,
  body: Uint8Array | string | null | undefined
): Promise<Record<string, string>> {
  const u = new URL(url);
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const payload = canonicalString(method, u.pathname + u.search, ts, nonce, sha256Hex(body));
  return {
    "x-folio-device": deviceId,
    "x-folio-ts": ts,
    "x-folio-nonce": nonce,
    "x-folio-sig": await signer.sign(payload),
  };
}

/** Auth headers for a cloud request: signature when a key is pinned, otherwise the legacy bearer. */
export async function cloudAuthHeaders(
  state: CloudAuthState,
  method: string,
  url: string,
  body?: Uint8Array | string | null
): Promise<Record<string, string>> {
  const signer = signerFor(state);
  if (signer) {
    if (!state.device_id) throw new Error("sync state: key pinned but device_id missing");
    return signatureHeaders(signer, state.device_id, method, url, body);
  }
  if (!state.device_token) throw new Error("sync state: neither a pinned key nor a device token");
  return { Authorization: `Bearer ${state.device_token}` };
}

/**
 * fetch() against the cloud with auth added. Body must be a string or
 * bytes (what every call site sends) so the signature covers exactly the
 * bytes on the wire.
 */
export async function cloudFetch(state: CloudAuthState, url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body as Uint8Array | string | null | undefined;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
    throw new Error("cloudFetch: body must be string or Uint8Array");
  }
  const auth = await cloudAuthHeaders(state, method, url, body);
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(auth)) headers.set(k, v);
  return fetch(url, { ...init, method, headers });
}

/** Default gate signer on a NotiBox (set by the folio-sync unit, sc-24117 PR C). */
export function defaultSignerUrl(): string | undefined {
  const v = process.env.FOLIO_CLOUD_SIGNER?.trim();
  return v ? v : undefined;
}

export interface PairResult {
  device_id: string;
  /** Present only when the cloud predates sc-24117 and ignored the key. */
  token?: string;
  key_alg?: KeyAlg;
  signer_url?: string;
}

/**
 * Pair with a device key: the key is generated here (ed25519) or held by the
 * gate (p256 via `signerUrl`), the public half goes to the cloud, and the
 * pair request is signed with it. A cloud older than sc-24117 ignores the
 * key fields and answers with a bearer token — returned as `token` so the
 * caller can still pair, and `folio sync pin-key` upgrades later.
 */
export async function pairWithKey(
  remote: string,
  code: string,
  deviceName: string,
  deviceId: string,
  signerUrl: string | undefined = defaultSignerUrl()
): Promise<PairResult> {
  let signer: Signer;
  if (signerUrl) {
    signer = remoteSigner(signerUrl);
  } else {
    if (!localPublicKey()) generateLocalKey();
    signer = localSigner();
  }
  const url = `${remote}/v1/auth/pair`;
  const body = JSON.stringify({
    code,
    device_name: deviceName,
    device_id: deviceId,
    public_key: await signer.publicKey(),
    key_alg: signer.alg,
  });
  const headers = {
    "content-type": "application/json",
    ...(await signatureHeaders(signer, deviceId, "POST", url, body)),
  };
  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    let detail = ""; try { detail = await res.text(); } catch {}
    throw new Error(`pair failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const out = (await res.json()) as { device_id: string; token?: string; key_pinned?: boolean };
  if (out.key_pinned) return { device_id: out.device_id, key_alg: signer.alg, signer_url: signerUrl };
  if (!out.token) throw new Error("pair: cloud returned neither key_pinned nor token");
  return { device_id: out.device_id, token: out.token };
}

/**
 * Move a bearer-paired device onto a key (one-time, sc-24117). Mutates and
 * returns `state`: on success key_alg/device_id/signer_url are set and
 * device_token is deleted — the cloud has already killed it. The caller
 * saves the state; if that save fails the device must re-pair.
 */
export async function pinKey<S extends CloudAuthState>(
  state: S,
  localDeviceId: string,
  signerUrl: string | undefined = defaultSignerUrl()
): Promise<S> {
  if (state.key_alg) throw new Error(`key already pinned (${state.key_alg})`);
  if (!state.device_token) throw new Error("no device token to upgrade from — re-pair instead");
  let signer: Signer;
  if (signerUrl) {
    signer = remoteSigner(signerUrl);
  } else {
    if (!localPublicKey()) generateLocalKey();
    signer = localSigner();
  }
  const url = `${state.remote}/v1/auth/pin-key`;
  const body = JSON.stringify({ public_key: await signer.publicKey(), key_alg: signer.alg });
  const headers = {
    "content-type": "application/json",
    Authorization: `Bearer ${state.device_token}`,
    ...(await signatureHeaders(signer, localDeviceId, "POST", url, body)),
  };
  const res = await fetch(url, { method: "POST", headers, body });
  if (res.status === 404) throw new Error("cloud does not support device keys yet (cloud folio predates sc-24117 — upgrade the cloud first)");
  if (!res.ok) {
    let detail = ""; try { detail = await res.text(); } catch {}
    throw new Error(`pin-key failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const out = (await res.json()) as { device_id: string; key_pinned?: boolean };
  if (!out.key_pinned) throw new Error("pin-key: cloud did not confirm key_pinned");
  state.key_alg = signer.alg;
  state.device_id = out.device_id;
  if (signerUrl) state.signer_url = signerUrl;
  else delete state.signer_url;
  delete state.device_token;
  return state;
}
