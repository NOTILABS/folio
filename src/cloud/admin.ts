/**
 * Operator endpoints — /v1/admin/* handlers.
 *
 * Authorization model:
 *   - GET /v1/admin/whoami           any authed device (reveals own user_id +
 *                                    display_name + is_operator; lets the
 *                                    local viewer decide whether to render
 *                                    the operator dashboard).
 *   - everything else                operator only (device.isOperator === true),
 *                                    else 403.
 *
 * Bootstrap: the cloud has no operators on a fresh v0.14 install — the
 * operator must be promoted explicitly via `folio cloud user-promote <id>`
 * (SSH-side CLI). After the first operator exists, every operator action
 * can be done from the local viewer; no further SSH needed.
 *
 * Stateless mutation helpers (`updateUser`, `deleteUser`, `mintPairCodeFor`)
 * live here too so the CLI subcommands can call the same code path as the
 * HTTP endpoints — single source of truth for the rename / promote / purge
 * semantics.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { cloudDb, cloudAssetsDir } from "./db";
import type { Device } from "./auth";

export interface WhoamiResponse {
  user_id: string;
  display_name: string;
  is_operator: boolean;
  device_id: string;
  device_name: string;
}

export function whoami(device: Device, db: Database = cloudDb()): WhoamiResponse {
  const row = db
    .query<{ display_name: string; is_operator: number }, [string]>(
      "SELECT display_name, is_operator FROM users WHERE id = ?"
    )
    .get(device.userId);
  return {
    user_id: device.userId,
    display_name: row?.display_name ?? device.userId,
    is_operator: row?.is_operator === 1,
    device_id: device.id,
    device_name: device.name,
  };
}

export interface CreateUserInput {
  id: string;
  display_name?: string;
  is_operator?: boolean;
}

export interface CreateUserResult {
  user: { id: string; display_name: string; is_operator: boolean; created_at: string };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class AdminError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function createUser(input: CreateUserInput, db: Database = cloudDb()): CreateUserResult {
  if (!ID_PATTERN.test(input.id)) {
    throw new AdminError(400, "id must be kebab-case (a-z, 0-9, hyphens), starting alphanumeric");
  }
  const existing = db
    .query<{ id: string; deleted_at: string | null }, [string]>("SELECT id, deleted_at FROM users WHERE id = ?")
    .get(input.id);
  if (existing) {
    if (existing.deleted_at) {
      throw new AdminError(409, `user '${input.id}' was deleted — reactivate via PATCH with {reactivate:true}`);
    }
    throw new AdminError(409, `user '${input.id}' already exists`);
  }
  const displayName = (input.display_name?.trim() || input.id);
  const isOp = input.is_operator ? 1 : 0;
  const createdAt = new Date().toISOString();
  db.run(
    "INSERT INTO users (id, display_name, is_operator, created_at) VALUES (?, ?, ?, ?)",
    [input.id, displayName, isOp, createdAt]
  );
  return {
    user: { id: input.id, display_name: displayName, is_operator: isOp === 1, created_at: createdAt },
  };
}

export interface PatchUserInput {
  new_id?: string;
  display_name?: string;
  is_operator?: boolean;
  reactivate?: boolean;
}

export function patchUser(targetId: string, input: PatchUserInput, db: Database = cloudDb()): { id: string } {
  const existing = db
    .query<{ id: string; deleted_at: string | null; is_operator: number }, [string]>(
      "SELECT id, deleted_at, is_operator FROM users WHERE id = ?"
    )
    .get(targetId);
  if (!existing) throw new AdminError(404, `user '${targetId}' not found`);
  if (existing.deleted_at && !input.reactivate) {
    throw new AdminError(409, `user '${targetId}' is deleted — pass {reactivate:true} to PATCH`);
  }

  let finalId = targetId;

  db.transaction(() => {
    if (input.reactivate) {
      db.run("UPDATE users SET deleted_at = NULL WHERE id = ?", [targetId]);
    }
    if (typeof input.display_name === "string" && input.display_name.trim()) {
      db.run("UPDATE users SET display_name = ? WHERE id = ?", [input.display_name.trim(), targetId]);
    }
    if (typeof input.is_operator === "boolean") {
      db.run("UPDATE users SET is_operator = ? WHERE id = ?", [input.is_operator ? 1 : 0, targetId]);
    }
    if (typeof input.new_id === "string" && input.new_id !== targetId) {
      if (!ID_PATTERN.test(input.new_id)) {
        throw new AdminError(400, "new_id must be kebab-case");
      }
      const collide = db.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get(input.new_id);
      if (collide) throw new AdminError(409, `user '${input.new_id}' already exists`);
      db.run(
        `INSERT INTO users (id, display_name, is_operator, created_at, deleted_at)
           SELECT ?, display_name, is_operator, created_at, deleted_at FROM users WHERE id = ?`,
        [input.new_id, targetId]
      );
      db.run("UPDATE devices       SET user_id = ? WHERE user_id = ?", [input.new_id, targetId]);
      db.run("UPDATE pairing_codes SET user_id = ? WHERE user_id = ?", [input.new_id, targetId]);
      db.run("UPDATE notes         SET user_id = ? WHERE user_id = ?", [input.new_id, targetId]);
      db.run("UPDATE assets        SET user_id = ? WHERE user_id = ?", [input.new_id, targetId]);
      db.run("UPDATE tombstones    SET user_id = ? WHERE user_id = ?", [input.new_id, targetId]);
      db.run("UPDATE shares        SET user_id = ? WHERE user_id = ?", [input.new_id, targetId]);
      db.run("DELETE FROM users WHERE id = ?", [targetId]);
      finalId = input.new_id;
    }
  })();

  return { id: finalId };
}

export interface DeleteUserResult {
  revoked_devices: number;
  purged?: { notes: number; assets: number; shares: number; tombstones: number };
}

export function deleteUser(targetId: string, opts: { purge?: boolean }, db: Database = cloudDb()): DeleteUserResult {
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?")
    .get(targetId);
  if (!existing) throw new AdminError(404, `user '${targetId}' not found`);

  if (!opts.purge) {
    const now = new Date().toISOString();
    const n = db
      .run("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, targetId])
      .changes ?? 0;
    return { revoked_devices: n };
  }

  // Purge cascade — read blob paths first so we can unlink files.
  const counts = db
    .query<{ notes: number; assets: number; shares: number; tombstones: number }, [string, string, string, string]>(
      `SELECT
        (SELECT COUNT(*) FROM notes WHERE user_id = ?) AS notes,
        (SELECT COUNT(*) FROM assets WHERE user_id = ?) AS assets,
        (SELECT COUNT(*) FROM shares WHERE user_id = ?) AS shares,
        (SELECT COUNT(*) FROM tombstones WHERE user_id = ?) AS tombstones`
    )
    .get(targetId, targetId, targetId, targetId)!;
  const blobPaths = db
    .query<{ blob_path: string }, [string]>("SELECT blob_path FROM assets WHERE user_id = ?")
    .all(targetId)
    .map((r) => r.blob_path);
  let revokedDevices = 0;
  db.transaction(() => {
    revokedDevices = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").get(targetId)?.n ?? 0;
    db.run("DELETE FROM shares     WHERE user_id = ?", [targetId]);
    db.run("DELETE FROM notes      WHERE user_id = ?", [targetId]);
    db.run("DELETE FROM assets     WHERE user_id = ?", [targetId]);
    db.run("DELETE FROM tombstones WHERE user_id = ?", [targetId]);
    db.run("DELETE FROM pairing_codes WHERE user_id = ?", [targetId]);
    db.run("DELETE FROM devices    WHERE user_id = ?", [targetId]);
    db.run("UPDATE users SET deleted_at = ? WHERE id = ?", [new Date().toISOString(), targetId]);
  })();
  for (const rel of blobPaths) {
    try {
      const abs = join(cloudAssetsDir(), rel);
      if (existsSync(abs)) unlinkSync(abs);
    } catch {}
  }
  return { revoked_devices: revokedDevices, purged: counts };
}
