/**
 * `folio sync` — pair/init or run the daemon.
 *
 * Subcommands implicit via flags:
 *   folio sync pair --remote https://cloud.example.com --code 482910 [--name laptop]
 *     → Consumes pairing code, writes device_token + remote to .sync-state.json.
 *
 *   folio sync [--once] [--interval 30]
 *     → Pull + push + push-live in a loop. --once exits after one iteration
 *       (useful for cron). Default interval 30s.
 *
 *   folio sync status
 *     → Print sync state file contents (without revealing the token).
 *
 *   folio sync unpair
 *     → Revoke this device on the cloud (best effort) + delete local state.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { c, out, err } from "../io";
import {
  acquireLock,
  releaseLock,
  loadSyncState,
  saveSyncState,
  syncOnce,
  LockHeldError,
  type SyncState,
} from "../../core/sync";
import { getOrCreateDeviceId } from "../../core/config";
import { cloudFetch, pairWithKey, pinKey, defaultSignerUrl, deviceKeyPath } from "../../core/cloud-auth";

export interface SyncOpts {
  sub?: string;
  remote?: string;
  code?: string;
  name?: string;
  /** sc-24117: gate signer URL (NotiBox, p256). Default: $FOLIO_CLOUD_SIGNER; none = local ed25519 key. */
  signer?: string;
  once?: boolean;
  interval?: number;
  jsonOut?: boolean;
}

export async function syncCmd(opts: SyncOpts): Promise<number> {
  switch (opts.sub) {
    case "pair":
      return pairCmd(opts);
    case "status":
      return statusCmd(opts);
    case "unpair":
      return unpairCmd(opts);
    case "pin-key":
      return pinKeyCmd(opts);
    case undefined:
    case "":
    case "run":
      return runCmd(opts);
    default:
      err(c.err(`✗ Unknown sync subcommand: ${opts.sub}\n`));
      err("Usage: folio sync {pair|status|unpair|pin-key|run}\n");
      return 1;
  }
}

async function pairCmd(opts: SyncOpts): Promise<number> {
  if (!opts.remote) { err(c.err("✗ --remote required\n")); return 2; }
  if (!opts.code) { err(c.err("✗ --code required (run `folio cloud pair-code` on the server)\n")); return 2; }
  const remote = opts.remote.replace(/\/+$/, "");
  const name = opts.name ?? hostname();
  // Resolve local device_id BEFORE pairing so cloud stores the same id we
  // use locally. Without this the two sides drift and own-echo skip breaks.
  const localDev = getOrCreateDeviceId();

  // sc-24117: pair with a device key (local ed25519, or the gate's p256
  // via --signer / $FOLIO_CLOUD_SIGNER). No shared token lands on disk.
  let paired;
  try {
    paired = await pairWithKey(remote, opts.code, name, localDev.id, opts.signer ?? defaultSignerUrl());
  } catch (e: any) {
    err(c.err(`✗ ${e?.message ?? e}\n`));
    return 3;
  }
  const state: SyncState = {
    remote,
    device_id: paired.device_id,
    last_pulled_seq: 0,
    last_pushed_at: null,
    last_live_pushed: {},
  };
  if (paired.key_alg) {
    state.key_alg = paired.key_alg;
    if (paired.signer_url) state.signer_url = paired.signer_url;
  } else {
    state.device_token = paired.token;
  }
  saveSyncState(state); // saves chmod 600 — see saveSyncState in core/sync.ts
  const dev = getOrCreateDeviceId();
  out(c.ok("✓") + ` Paired with ${c.cyan(remote)}`);
  out(`  device_id:  ${c.dim(paired.device_id)}`);
  out(`  local id:   ${c.dim(dev.id)}`);
  if (paired.key_alg) {
    const where = paired.signer_url ? `signed by ${paired.signer_url}` : `key in ${deviceKeyPath()}, mode 0600`;
    out(`  auth:       ${c.dim(`${paired.key_alg} device key (${where})`)}`);
  } else {
    // Output a short fingerprint of the token for human verification without
    // exposing the full bearer. Cloud predates device keys → bearer fallback.
    out(`  token fp:   ${c.dim(tokenFingerprint(paired.token!))} ${c.dim("(stored in ~/Folio/.sync-state.json, mode 0600)")}`);
    out(c.warn("  ! cloud does not support device keys yet — paired with a bearer token; run `folio sync pin-key` after the cloud upgrade"));
  }
  out("");
  out(c.dim("  Run `folio sync` to start the daemon, or `folio sync --once` for cron mode."));
  return 0;
}

/**
 * Short visual fingerprint of a bearer token — first 4 + last 4 chars
 * with the middle elided. Enough for the user to see "the same token is
 * in my state file" without exposing anything an attacker could replay.
 * Plain truncation (first 8) would leak more on its own — a fingerprint
 * with elision signals "this is NOT the full token" visually.
 */
function tokenFingerprint(token: string): string {
  if (token.length < 12) return "…";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * sc-24117: one-time upgrade of a bearer-paired device to a device key.
 * After it the cloud refuses the old token and .sync-state.json holds no
 * credential at all (the private key is in ~/Folio/.device-key.pem, 0600,
 * or stays inside the NotiBox gate with --signer).
 */
async function pinKeyCmd(opts: SyncOpts): Promise<number> {
  const state = loadSyncState();
  if (!state) { err(c.err("✗ Not paired. Run: folio sync pair --remote <url> --code <6-digit>\n")); return 2; }
  if (state.key_alg) { out(c.dim(`Already on a device key (${state.key_alg}) — nothing to do.`)); return 0; }
  const localDev = getOrCreateDeviceId();
  try {
    await pinKey(state, localDev.id, opts.signer ?? defaultSignerUrl());
  } catch (e: any) {
    err(c.err(`✗ ${e?.message ?? e}\n`));
    return 3;
  }
  saveSyncState(state);
  out(c.ok("✓") + ` Device key pinned on ${c.cyan(state.remote)} (${state.key_alg}); bearer token revoked and removed from .sync-state.json`);
  return 0;
}

async function statusCmd(opts: SyncOpts): Promise<number> {
  const state = loadSyncState();
  if (!state) {
    out(c.dim("Not paired. Run: folio sync pair --remote <url> --code <6-digit>"));
    return 0;
  }
  if (opts.jsonOut) {
    out(JSON.stringify({
      remote: state.remote,
      paired: true,
      auth: state.key_alg ? `key:${state.key_alg}` : "bearer",
      last_pulled_seq: state.last_pulled_seq,
      last_pushed_at: state.last_pushed_at,
      live_notes_tracked: Object.keys(state.last_live_pushed ?? {}).length,
    }, null, 2));
    return 0;
  }
  const dev = getOrCreateDeviceId();
  out(c.bold("Folio sync status"));
  out(`  remote:              ${c.cyan(state.remote)}`);
  out(`  auth:                ${state.key_alg ? `${state.key_alg} device key` : c.warn("bearer token (run `folio sync pin-key`)")}`);
  out(`  device_id:           ${dev.id} (${dev.name})`);
  out(`  last_pulled_seq:     ${state.last_pulled_seq}`);
  out(`  last_pushed_at:      ${state.last_pushed_at ?? c.dim("(never)")}`);
  out(`  live notes tracked:  ${Object.keys(state.last_live_pushed ?? {}).length}`);
  return 0;
}

async function unpairCmd(_opts: SyncOpts): Promise<number> {
  const state = loadSyncState();
  if (!state) {
    out(c.dim("Not paired — nothing to unpair."));
    return 0;
  }
  // Look up our device id from the server's perspective so we can DELETE.
  try {
    const listRes = await cloudFetch(state, `${state.remote}/v1/auth/devices`, {
    });
    if (listRes.ok) {
      const { devices } = (await listRes.json()) as { devices: { id: string; name: string }[] };
      const me = devices.find((d) => d.name === hostname());
      if (me) {
        await cloudFetch(state, `${state.remote}/v1/auth/device/${me.id}`, {
          method: "DELETE",
        });
        out(c.ok("✓") + ` Revoked device ${c.dim(me.id)} on ${state.remote}`);
      }
    }
  } catch {
    out(c.dim("(could not contact server — local state cleared anyway)"));
  }
  try { unlinkSync(`${require("../../core/config").folioRoot()}/.sync-state.json`); } catch {}
  out(c.ok("✓") + " Local sync state cleared.");
  return 0;
}

async function runCmd(opts: SyncOpts): Promise<number> {
  const state = loadSyncState();
  if (!state) {
    err(c.err("✗ Not paired. Run: folio sync pair --remote <url> --code <6-digit>\n"));
    return 2;
  }
  try {
    acquireLock();
  } catch (e: any) {
    if (e instanceof LockHeldError) {
      err(c.err(`✗ ${e.message}\n`));
      err(c.dim("  If sure no other folio sync is running, remove ~/Folio/.sync.lock and retry.\n"));
      return 3;
    }
    throw e;
  }

  const interval = opts.interval ?? 30;
  const once = opts.once ?? false;

  // Clean shutdown on signals — important under systemd or supervisord.
  let stopping = false;
  const onSignal = (sig: string) => {
    if (stopping) return;
    stopping = true;
    out(c.dim(`\n  received ${sig}, finishing current iteration...`));
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  try {
    do {
      try {
        const r = await syncOnce(state);
        if (r.pulled || r.pushed || r.live_pulled || r.live_pushed || r.renamed || r.deleted || r.deletes_applied || r.assets_pushed || r.assets_pulled) {
          out(
            `${c.dim(new Date().toISOString())} ` +
              `pulled=${r.pulled} pushed=${r.pushed} ` +
              `live_pulled=${r.live_pulled} live_pushed=${r.live_pushed} ` +
              `renamed=${r.renamed} deleted=${r.deleted} deletes_applied=${r.deletes_applied} ` +
              `assets↑=${r.assets_pushed} assets↓=${r.assets_pulled}`
          );
        }
      } catch (e: any) {
        // Transient network errors should not crash the daemon — log and retry.
        err(c.err(`  ${new Date().toISOString()} sync error: ${e?.message ?? e}\n`));
        if (process.env.FOLIO_DEBUG) console.error(e);
      }
      if (once || stopping) break;
      await new Promise<void>((resolve) => setTimeout(resolve, interval * 1000));
    } while (!stopping);
  } finally {
    releaseLock();
  }
  return 0;
}
