/**
 * `folio cloud {init|serve|pair-code|user-add|user-list|user-rename|user-revoke}`
 * — operator-facing cloud relay CLI. Runs ON the cloud server (SSH side),
 * not the user's laptop. Each subcommand opens cloudDb() directly so no
 * HTTP round-trip is needed.
 *
 * Subcommands:
 *   init        Idempotent first-run setup of data dir + DB schema.
 *   serve       Long-running process. Env: FOLIO_CLOUD_HOME / _PORT / _HOST
 *               / _PUBLIC_URL. Runs until SIGTERM/SIGINT.
 *   pair-code [--user <id>] [--expect-key <base64 SPKI DER|PEM>]
 *               Mint a 6-digit code (10-min TTL). --user required when more
 *               than one user exists in the cloud. --expect-key binds the
 *               code to one public key (sc-24117: NotiBox box identity from
 *               backplane); pairing with any other key or a bearer fails.
 *   user-add <id> [--display "Name"]
 *               Provision a new user account (no auth state; auth lives on
 *               devices). Operator hands a pair-code over a side channel.
 *   user-list   Per-user counts (devices, notes, assets bytes, last seen).
 *               Operator-only global view; HTTP /v1/admin/stats stays scoped
 *               to the caller's own user.
 *   user-rename <old> <new>
 *               Rename a user id across every table atomically. Bearer
 *               tokens unaffected.
 *   user-revoke <id> [--purge [--yes]]
 *               Revoke all of user's devices. --purge cascades delete on
 *               notes/assets/tombstones/shares + sets users.deleted_at.
 *               --yes skips the confirmation prompt.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cloudDataDir, cloudDb, cloudDbPath, cloudAssetsDir } from "../../cloud/db";
import { createPairingCode } from "../../cloud/auth";
import { startCloudServer } from "../../cloud/server";
import { buildGlobalStats } from "../../cloud/stats";
import { c, out, err } from "../io";

export async function cloudCmd(sub: string | undefined, args: string[]): Promise<number> {
  switch (sub) {
    case "init":         return cloudInitVerbose();
    case "serve":        return cloudServe();
    case "pair-code":    return cloudPairCode(args);
    case "user-add":     return userAdd(args);
    case "user-list":    return userList(args);
    case "user-rename":  return userRename(args);
    case "user-revoke":  return userRevoke(args);
    case "user-promote": return userPromote(args, true);
    case "user-demote":  return userPromote(args, false);
    default:
      err("Usage: folio cloud {init|serve|pair-code [--user <id>]|user-add <id> [--display \"Name\"]|user-list [--json]|user-rename <old> <new>|user-revoke <id> [--purge --yes]|user-promote <id>|user-demote <id>}");
      return 1;
  }
}

/** Silent idempotent init — called from every other subcommand. */
function ensureCloudReady(): void {
  const dir = cloudDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  const assetsDir = cloudAssetsDir();
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true, mode: 0o755 });
  cloudDb();
}

/** Verbose first-run setup — only the `init` subcommand prints. */
function cloudInitVerbose(): number {
  const dir = cloudDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  const assetsDir = cloudAssetsDir();
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true, mode: 0o755 });
  cloudDb();
  out(c.cyan("✓ Folio Cloud initialized"));
  out(`  Data dir: ${dir}`);
  out(`  DB:       ${cloudDbPath()}`);
  out(`  Assets:   ${assetsDir}`);
  out("");
  out(`Next: ${c.cyan("folio cloud user-add <name>")} then ${c.cyan("folio cloud pair-code --user <name>")} to onboard.`);
  return 0;
}

async function cloudServe(): Promise<number> {
  ensureCloudReady();
  const server = startCloudServer();
  out(c.cyan(`✓ Folio Cloud listening on ${server.hostname}:${server.port}`));
  const pub = process.env.FOLIO_CLOUD_PUBLIC_URL;
  if (pub) out(`  Public URL: ${pub}`);
  out(c.dim("  Ctrl-C to stop"));
  const stop = (sig: string) => {
    out(c.dim(`\n  received ${sig}, stopping`));
    server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  await new Promise<void>(() => {});
  return 0;
}

/** Walk a flat args array looking for `--flag value` pairs. Returns {map, positional}. */
function parseArgs(args: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function cloudPairCode(args: string[]): number {
  ensureCloudReady();
  const { flags } = parseArgs(args);
  const db = cloudDb();

  // When multiple users exist, --user is required so the operator can't
  // accidentally mint a 'default'-scoped code that pairs into the wrong
  // account. Single-user installs keep the v0.12 behaviour: no flag needed.
  const users = db.query<{ id: string }, []>("SELECT id FROM users WHERE deleted_at IS NULL").all().map((r) => r.id);
  let userId: string;
  if (typeof flags.user === "string") {
    userId = flags.user;
    if (!users.includes(userId)) {
      err(c.err(`✗ unknown user '${userId}'. Known: ${users.join(", ") || "(none)"}\n`));
      err(c.dim(`  Add a user first: folio cloud user-add ${userId}\n`));
      return 3;
    }
  } else if (users.length > 1) {
    err(c.err(`✗ --user <id> required when more than one user exists.\n`));
    err(c.dim(`  Known users: ${users.join(", ")}\n`));
    err(c.dim(`  Example: folio cloud pair-code --user ${users[0]}\n`));
    return 4;
  } else {
    userId = users[0] ?? "default";
  }

  let expectKey: string | undefined;
  if (flags["expect-key"] !== undefined) {
    if (typeof flags["expect-key"] !== "string") {
      err(c.err("✗ --expect-key needs a value (base64 SPKI DER or PEM)\n"));
      return 5;
    }
    expectKey = flags["expect-key"];
  }
  let res: ReturnType<typeof createPairingCode>;
  try {
    res = createPairingCode(userId, undefined, expectKey);
  } catch (e: any) {
    err(c.err(`✗ ${e?.message ?? e}\n`));
    return 5;
  }
  const { code, expiresAt, boundKeyFp } = res;
  out("");
  out(`  Pairing code: ${c.bold(c.cyan(code))}`);
  out(`  User:         ${c.bold(userId)}`);
  out(`  Expires:      ${c.dim(expiresAt)}`);
  // Machine-read by backplane /api/folio/pair-code: the line proves this
  // cloud enforced the binding (an older folio ignores the flag silently).
  if (boundKeyFp) out(`  Bound key:    sha256:${boundKeyFp}`);
  out("");
  out(c.dim("  Use within 10 minutes:"));
  out(c.dim(`    curl -X POST $CLOUD/v1/auth/pair \\`));
  out(c.dim(`      -d '{"code":"${code}","device_name":"<name>","device_id":"<ULID>"}'`));
  return 0;
}

function userAdd(args: string[]): number {
  ensureCloudReady();
  const { flags, positional } = parseArgs(args);
  const id = positional[0];
  if (!id) {
    err(c.err("✗ Usage: folio cloud user-add <id> [--display \"Name\"]\n"));
    return 2;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    err(c.err("✗ user id must be kebab-case (lowercase a-z, 0-9, hyphens), starting with alphanumeric.\n"));
    return 3;
  }
  const displayName = typeof flags.display === "string" ? flags.display : id;
  const db = cloudDb();
  const existing = db
    .query<{ id: string; deleted_at: string | null }, [string]>(
      "SELECT id, deleted_at FROM users WHERE id = ?"
    )
    .get(id);
  if (existing) {
    if (existing.deleted_at) {
      if (flags.reactivate === true) {
        db.run("UPDATE users SET deleted_at = NULL, display_name = ? WHERE id = ?", [displayName, id]);
        out(c.ok(`✓ user '${id}' reactivated`));
        return 0;
      }
      err(c.err(`✗ user '${id}' was previously deleted. Pass --reactivate to bring it back.\n`));
      return 4;
    }
    err(c.err(`✗ user '${id}' already exists.\n`));
    return 5;
  }
  db.run(
    "INSERT INTO users (id, display_name, created_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    [id, displayName]
  );
  out(c.ok(`✓ user '${id}' created (display: ${displayName})`));
  out("");
  out(`  Next: ${c.cyan(`folio cloud pair-code --user ${id}`)}`);
  return 0;
}

function bytesHuman(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function userList(args: string[]): number {
  ensureCloudReady();
  const { flags } = parseArgs(args);
  const stats = buildGlobalStats(process.env.FOLIO_CLOUD_PUBLIC_URL ?? "");
  if (flags.json === true) {
    out(JSON.stringify(stats, null, 2));
    return 0;
  }
  if (stats.users.length === 0) {
    out(c.dim("No users."));
    return 0;
  }
  // Plain text table — keep columns narrow so it fits a 100-col terminal.
  const cols = ["id", "display", "devices", "notes", "live", "assets", "shares", "last_seen", "role"];
  const widths = [16, 16, 7, 6, 5, 16, 7, 19, 10];
  const headerLine = cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  out(c.dim(headerLine));
  out(c.dim("-".repeat(headerLine.length)));
  for (const u of stats.users) {
    const devicesCell = u.devices_revoked > 0 ? `${u.devices}/-${u.devices_revoked}` : `${u.devices}`;
    const assetsCell = `${u.assets} (${bytesHuman(u.assets_bytes)})`;
    const lastSeen = u.last_seen_at ? u.last_seen_at.slice(0, 19).replace("T", " ") : "—";
    const role = u.deleted_at ? c.dim("deleted") : (u.is_operator ? c.bold("operator") : "active");
    out(
      [
        u.id.padEnd(widths[0]!),
        u.display_name.slice(0, widths[1]!).padEnd(widths[1]!),
        devicesCell.padEnd(widths[2]!),
        String(u.notes).padEnd(widths[3]!),
        String(u.live_entries).padEnd(widths[4]!),
        assetsCell.slice(0, widths[5]!).padEnd(widths[5]!),
        String(u.shares_active).padEnd(widths[6]!),
        lastSeen.padEnd(widths[7]!),
        role,
      ].join("  ")
    );
  }
  out("");
  out(c.dim(`  Cloud DB: ${bytesHuman(stats.storage.db_bytes)}`));
  return 0;
}

function userRename(args: string[]): number {
  ensureCloudReady();
  const { positional } = parseArgs(args);
  const oldId = positional[0];
  const newId = positional[1];
  if (!oldId || !newId) {
    err(c.err("✗ Usage: folio cloud user-rename <old-id> <new-id>\n"));
    return 2;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(newId)) {
    err(c.err("✗ new id must be kebab-case (lowercase a-z, 0-9, hyphens), starting with alphanumeric.\n"));
    return 3;
  }
  const db = cloudDb();
  const oldRow = db.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get(oldId);
  if (!oldRow) {
    err(c.err(`✗ user '${oldId}' not found.\n`));
    return 4;
  }
  const newRow = db.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get(newId);
  if (newRow) {
    err(c.err(`✗ user '${newId}' already exists.\n`));
    return 5;
  }
  db.transaction(() => {
    db.run("INSERT INTO users (id, display_name, created_at, deleted_at) SELECT ?, display_name, created_at, deleted_at FROM users WHERE id = ?", [newId, oldId]);
    db.run("UPDATE devices       SET user_id = ? WHERE user_id = ?", [newId, oldId]);
    db.run("UPDATE pairing_codes SET user_id = ? WHERE user_id = ?", [newId, oldId]);
    db.run("UPDATE notes         SET user_id = ? WHERE user_id = ?", [newId, oldId]);
    db.run("UPDATE assets        SET user_id = ? WHERE user_id = ?", [newId, oldId]);
    db.run("UPDATE tombstones    SET user_id = ? WHERE user_id = ?", [newId, oldId]);
    db.run("UPDATE shares        SET user_id = ? WHERE user_id = ?", [newId, oldId]);
    db.run("DELETE FROM users WHERE id = ?", [oldId]);
  })();
  out(c.ok(`✓ user renamed: '${oldId}' → '${newId}' (bearer tokens unchanged)`));
  return 0;
}

function userRevoke(args: string[]): number {
  ensureCloudReady();
  const { flags, positional } = parseArgs(args);
  const id = positional[0];
  if (!id) {
    err(c.err("✗ Usage: folio cloud user-revoke <id> [--purge --yes]\n"));
    return 2;
  }
  const db = cloudDb();
  const user = db.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get(id);
  if (!user) {
    err(c.err(`✗ user '${id}' not found.\n`));
    return 3;
  }
  if (!flags.purge) {
    const n = db.run("UPDATE devices SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND revoked_at IS NULL", [id]).changes ?? 0;
    out(c.ok(`✓ user '${id}' devices revoked (${n} active → revoked). Data preserved.`));
    out(c.dim(`  To delete the user's data too: folio cloud user-revoke ${id} --purge --yes`));
    return 0;
  }
  // --purge confirmation gate (unless --yes given).
  const counts = db
    .query<{ notes: number; assets: number; shares: number; tombstones: number }, [string, string, string, string]>(
      `SELECT
        (SELECT COUNT(*) FROM notes WHERE user_id = ?) AS notes,
        (SELECT COUNT(*) FROM assets WHERE user_id = ?) AS assets,
        (SELECT COUNT(*) FROM shares WHERE user_id = ?) AS shares,
        (SELECT COUNT(*) FROM tombstones WHERE user_id = ?) AS tombstones`
    )
    .get(id, id, id, id)!;
  if (flags.yes !== true) {
    err(c.err(`✗ --purge will permanently delete ${counts.notes} notes, ${counts.assets} assets, ${counts.shares} shares, ${counts.tombstones} tombstones for user '${id}'.\n`));
    err(c.dim(`  Re-run with --yes to confirm: folio cloud user-revoke ${id} --purge --yes\n`));
    return 4;
  }
  // Read blob_paths BEFORE we drop the rows so we can unlink files.
  const assetPaths = db
    .query<{ blob_path: string }, [string]>("SELECT blob_path FROM assets WHERE user_id = ?")
    .all(id)
    .map((r) => r.blob_path);
  db.transaction(() => {
    // FK ON DELETE CASCADE handles note_tags + live_entries; we drop notes
    // explicitly so the cascade fires.
    db.run("DELETE FROM shares     WHERE user_id = ?", [id]);
    db.run("DELETE FROM notes      WHERE user_id = ?", [id]);
    db.run("DELETE FROM assets     WHERE user_id = ?", [id]);
    db.run("DELETE FROM tombstones WHERE user_id = ?", [id]);
    db.run("DELETE FROM pairing_codes WHERE user_id = ?", [id]);
    db.run("DELETE FROM devices    WHERE user_id = ?", [id]);
    db.run("UPDATE users SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [id]);
  })();
  // Unlink asset blobs on disk. Best-effort — orphan bytes are scarier than
  // a one-off filesystem leak, but we try.
  for (const rel of assetPaths) {
    try {
      const abs = join(cloudAssetsDir(), rel);
      if (existsSync(abs)) unlinkSync(abs);
    } catch {}
  }
  out(c.ok(`✓ user '${id}' purged: ${counts.notes} notes, ${counts.assets} assets, ${counts.shares} shares, ${counts.tombstones} tombstones removed.`));
  return 0;
}

function userPromote(args: string[], promote: boolean): number {
  ensureCloudReady();
  const { positional } = parseArgs(args);
  const id = positional[0];
  const verb = promote ? "promote" : "demote";
  if (!id) {
    err(c.err(`✗ Usage: folio cloud user-${verb} <id>\n`));
    return 2;
  }
  const db = cloudDb();
  const user = db.query<{ id: string; is_operator: number }, [string]>("SELECT id, is_operator FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
  if (!user) {
    err(c.err(`✗ user '${id}' not found (or deleted).\n`));
    return 3;
  }
  const currentlyOp = user.is_operator === 1;
  if (promote && currentlyOp) {
    out(c.dim(`user '${id}' is already an operator — nothing to do.`));
    return 0;
  }
  if (!promote && !currentlyOp) {
    out(c.dim(`user '${id}' is not an operator — nothing to do.`));
    return 0;
  }
  db.run("UPDATE users SET is_operator = ? WHERE id = ?", [promote ? 1 : 0, id]);
  out(c.ok(`✓ user '${id}' ${promote ? "promoted to operator" : "demoted from operator"}`));
  if (promote) {
    out(c.dim(`  '${id}'s devices can now call /v1/admin/* routes from the local viewer.`));
  }
  return 0;
}
