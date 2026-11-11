/**
 * `folio cloud user-*` subcommands. Each command runs against a tmp cloud DB
 * via cloudCmd(); we don't shell out, just exercise the function directly.
 */

import { expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeCloudDb, cloudDb } from "../src/cloud/db";
import { ed25519Key } from "./_cloud-device";

// sc-24120: every pair-code is bound to a box key.
const BOX_KEY = ed25519Key().derB64;

let tmpDir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-user-cli-"));
  process.env.FOLIO_CLOUD_HOME = tmpDir;
  stdout = [];
  stderr = [];
  // io.ts uses console.log / console.error, so spy on those (not process.std{out,err}.write).
  spyOn(console, "log").mockImplementation((...args: any[]) => {
    stdout.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  spyOn(console, "error").mockImplementation((...args: any[]) => {
    stderr.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
});

afterEach(() => {
  (console.log as any).mockRestore?.();
  (console.error as any).mockRestore?.();
  closeCloudDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_CLOUD_HOME;
});

async function run(sub: string, args: string[] = []): Promise<number> {
  const { cloudCmd } = await import("../src/cli/commands/cloud");
  return cloudCmd(sub, args);
}

test("user-add: inserts a row, idempotent rejects duplicates", async () => {
  const rc1 = await run("user-add", ["alice"]);
  expect(rc1).toBe(0);
  const row = cloudDb()
    .query<{ id: string; display_name: string; deleted_at: string | null }, [string]>(
      "SELECT id, display_name, deleted_at FROM users WHERE id = ?"
    )
    .get("alice");
  expect(row?.id).toBe("alice");
  expect(row?.display_name).toBe("alice");
  expect(row?.deleted_at).toBeNull();

  // Re-add fails.
  const rc2 = await run("user-add", ["alice"]);
  expect(rc2).not.toBe(0);
  expect(stderr.join("")).toContain("already exists");
});

test("user-add --display sets a custom display name", async () => {
  const rc = await run("user-add", ["alice", "--display", "Alice Smith"]);
  expect(rc).toBe(0);
  const row = cloudDb()
    .query<{ display_name: string }, [string]>("SELECT display_name FROM users WHERE id = ?")
    .get("alice");
  expect(row?.display_name).toBe("Alice Smith");
});

test("user-add: kebab-case validation rejects bad ids", async () => {
  const rc = await run("user-add", ["Alice Capital"]);
  expect(rc).not.toBe(0);
  expect(stderr.join("")).toContain("kebab-case");
  expect(cloudDb().query<{ id: string }, []>("SELECT id FROM users").all().some((r) => r.id === "Alice Capital")).toBe(false);
});

test("user-list: empty table when only 'default' user exists", async () => {
  const rc = await run("user-list");
  expect(rc).toBe(0);
  // 'default' user is auto-seeded by schema bootstrap.
  expect(stdout.join("")).toContain("default");
});

test("user-list: shows added users with counts", async () => {
  await run("user-add", ["alice"]);
  await run("user-add", ["bob"]);
  stdout.length = 0;
  const rc = await run("user-list");
  expect(rc).toBe(0);
  const out = stdout.join("");
  expect(out).toContain("alice");
  expect(out).toContain("bob");
  expect(out).toContain("default");
});

test("user-list --json: machine-readable output", async () => {
  await run("user-add", ["alice"]);
  stdout.length = 0;
  const rc = await run("user-list", ["--json"]);
  expect(rc).toBe(0);
  const text = stdout.join("").trim();
  const parsed = JSON.parse(text);
  expect(parsed.users.map((u: any) => u.id).sort()).toContain("alice");
  expect(parsed.users.map((u: any) => u.id).sort()).toContain("default");
});

test("pair-code --user: required when >1 user exists; scopes the code", async () => {
  await run("user-add", ["alice"]);
  await run("user-add", ["bob"]);
  stderr.length = 0;
  // Without --user → error.
  const rc1 = await run("pair-code");
  expect(rc1).not.toBe(0);
  expect(stderr.join("")).toContain("--user");

  // With --user alice → succeeds; pairing_codes row carries user_id='alice'.
  stdout.length = 0;
  const rc2 = await run("pair-code", ["--user", "alice", "--expect-key", BOX_KEY]);
  expect(rc2).toBe(0);
  const text = stdout.join("");
  // Capture the 6-digit code from output.
  const m = text.match(/Pairing code:\s+(?:\x1b\[[0-9;]*m)*([0-9]{6})/);
  expect(m).not.toBeNull();
  const code = m![1]!;
  const row = cloudDb()
    .query<{ user_id: string }, [string]>("SELECT user_id FROM pairing_codes WHERE code = ?")
    .get(code);
  expect(row?.user_id).toBe("alice");
});

test("pair-code --user unknown id → error with hint", async () => {
  await run("user-add", ["alice"]);
  stderr.length = 0;
  const rc = await run("pair-code", ["--user", "phantom"]);
  expect(rc).not.toBe(0);
  expect(stderr.join("")).toContain("unknown user");
});

test("pair-code with single user (only 'default') works without --user", async () => {
  const rc = await run("pair-code", ["--expect-key", BOX_KEY]);
  expect(rc).toBe(0);
  const codes = cloudDb()
    .query<{ user_id: string }, []>("SELECT user_id FROM pairing_codes")
    .all();
  expect(codes).toHaveLength(1);
  expect(codes[0]!.user_id).toBe("default");
});

test("user-rename: updates id atomically across every user_id column", async () => {
  // Seed Alice + some owned rows.
  await run("user-add", ["alice"]);
  const db = cloudDb();
  db.run("INSERT INTO devices (id, name, token_hash, paired_at, user_id) VALUES ('dev1', 'a', 'h', '2026-05-01', 'alice')");
  db.run(
    `INSERT INTO notes (uuid, user_id, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
     VALUES ('n1', 'alice', 's', 't', 'T', 'snippet', '<p></p>', '2026-05-01', '2026-05-01', 'dev1', 1)`
  );

  const rc = await run("user-rename", ["alice", "jarek"]);
  expect(rc).toBe(0);

  // Old id gone, new id present.
  expect(db.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get("alice")).toBeNull();
  expect(db.query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?").get("jarek")).not.toBeNull();
  // Fan-out tables updated.
  expect(db.query<{ user_id: string }, [string]>("SELECT user_id FROM devices WHERE id = ?").get("dev1")?.user_id).toBe("jarek");
  expect(db.query<{ user_id: string }, [string]>("SELECT user_id FROM notes WHERE uuid = ?").get("n1")?.user_id).toBe("jarek");
});

test("user-rename: rejects when new id already exists", async () => {
  await run("user-add", ["alice"]);
  await run("user-add", ["bob"]);
  stderr.length = 0;
  const rc = await run("user-rename", ["alice", "bob"]);
  expect(rc).not.toBe(0);
  expect(stderr.join("")).toContain("already exists");
});

test("user-revoke without --purge: revokes devices, preserves data", async () => {
  await run("user-add", ["alice"]);
  const db = cloudDb();
  db.run("INSERT INTO devices (id, name, token_hash, paired_at, user_id) VALUES ('dev1', 'a', 'h', '2026-05-01', 'alice')");
  db.run("INSERT INTO devices (id, name, token_hash, paired_at, user_id) VALUES ('dev2', 'b', 'h2', '2026-05-01', 'alice')");
  db.run(
    `INSERT INTO notes (uuid, user_id, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
     VALUES ('n1', 'alice', 's', 't', 'T', 'snippet', '<p></p>', '2026-05-01', '2026-05-01', 'dev1', 1)`
  );

  const rc = await run("user-revoke", ["alice"]);
  expect(rc).toBe(0);
  const stillActive = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL").get("alice")?.n;
  expect(stillActive).toBe(0);
  // Notes still there.
  expect(db.query<{ uuid: string }, [string]>("SELECT uuid FROM notes WHERE uuid = ?").get("n1")).not.toBeNull();
  // User row not deleted.
  expect(db.query<{ deleted_at: string | null }, [string]>("SELECT deleted_at FROM users WHERE id = ?").get("alice")?.deleted_at).toBeNull();
});

test("user-revoke --purge --yes: cascades delete + sets users.deleted_at", async () => {
  await run("user-add", ["alice"]);
  const db = cloudDb();
  db.run("INSERT INTO devices (id, name, token_hash, paired_at, user_id) VALUES ('dev1', 'a', 'h', '2026-05-01', 'alice')");
  db.run(
    `INSERT INTO notes (uuid, user_id, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
     VALUES ('n1', 'alice', 's', 't', 'T', 'snippet', '<p></p>', '2026-05-01', '2026-05-01', 'dev1', 1)`
  );
  db.run(
    "INSERT INTO assets (hash, filename, thread_id, user_id, content_type, size_bytes, blob_path, uploaded_at) VALUES (?,?,?,?,?,?,?,?)",
    ["alicehash", "x.png", "t", "alice", "image/png", 10, "al/ic/alicehash.png", "2026-05-01T09:00:00Z"]
  );

  const rc = await run("user-revoke", ["alice", "--purge", "--yes"]);
  expect(rc).toBe(0);
  expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").get("alice")?.n).toBe(0);
  expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM notes WHERE user_id = ?").get("alice")?.n).toBe(0);
  expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM assets WHERE user_id = ?").get("alice")?.n).toBe(0);
  expect(db.query<{ deleted_at: string | null }, [string]>("SELECT deleted_at FROM users WHERE id = ?").get("alice")?.deleted_at).not.toBeNull();
});

test("regression: top-level dispatcher forwards --flag value to cloud subcommand", async () => {
  // The bug: parseArgs in src/cli/index.ts pulled --user alice into `flags`
  // before dispatch, so cloudCmd's own parseArgs never saw it. Drive through
  // main() with a full argv to confirm the reconstruction is in place.
  const { main } = await import("../src/cli/index");
  await main(["bun", "folio", "cloud", "user-add", "alice"]);
  stderr.length = 0;
  stdout.length = 0;
  const rc = await main(["bun", "folio", "cloud", "pair-code", "--user", "alice", "--expect-key", BOX_KEY]);
  expect(rc).toBe(0);
  // Output should contain the user we asked for + the minted code.
  const text = stdout.join("");
  expect(text).toContain("User:");
  expect(text).toContain("alice");
  // Verify the pairing_codes row was actually stamped with user_id=alice.
  const row = cloudDb()
    .query<{ user_id: string }, []>("SELECT user_id FROM pairing_codes ORDER BY expires_at DESC LIMIT 1")
    .get();
  expect(row?.user_id).toBe("alice");
});

test("user-promote: flips is_operator → 1; idempotent", async () => {
  await run("user-add", ["jarek"]);
  stdout.length = 0;
  const rc = await run("user-promote", ["jarek"]);
  expect(rc).toBe(0);
  expect(stdout.join("")).toContain("promoted to operator");
  const row = cloudDb()
    .query<{ is_operator: number }, [string]>("SELECT is_operator FROM users WHERE id = ?")
    .get("jarek");
  expect(row?.is_operator).toBe(1);

  // Re-promote → idempotent no-op.
  stdout.length = 0;
  const rc2 = await run("user-promote", ["jarek"]);
  expect(rc2).toBe(0);
  expect(stdout.join("")).toContain("already an operator");
});

test("user-demote: flips is_operator → 0; idempotent on non-operator", async () => {
  await run("user-add", ["alice"]);
  await run("user-promote", ["alice"]);
  stdout.length = 0;
  const rc = await run("user-demote", ["alice"]);
  expect(rc).toBe(0);
  expect(stdout.join("")).toContain("demoted from operator");
  const row = cloudDb()
    .query<{ is_operator: number }, [string]>("SELECT is_operator FROM users WHERE id = ?")
    .get("alice");
  expect(row?.is_operator).toBe(0);

  // Re-demote → idempotent no-op.
  stdout.length = 0;
  const rc2 = await run("user-demote", ["alice"]);
  expect(rc2).toBe(0);
  expect(stdout.join("")).toContain("not an operator");
});

test("user-promote: unknown user errors", async () => {
  stderr.length = 0;
  const rc = await run("user-promote", ["phantom"]);
  expect(rc).not.toBe(0);
  expect(stderr.join("")).toContain("not found");
});

test("user-list: 'role' column shows operator | active | deleted", async () => {
  await run("user-add", ["jarek"]);
  await run("user-promote", ["jarek"]);
  await run("user-add", ["alice"]);
  await run("user-add", ["bob"]);
  await run("user-revoke", ["bob", "--purge", "--yes"]);
  stdout.length = 0;
  const rc = await run("user-list", ["--json"]);
  expect(rc).toBe(0);
  const data = JSON.parse(stdout.join("").trim());
  const byId = Object.fromEntries(data.users.map((u: any) => [u.id, u]));
  expect(byId.jarek.is_operator).toBe(true);
  expect(byId.alice.is_operator).toBe(false);
  expect(byId.bob.deleted_at).not.toBeNull();
});

test("user-revoke --purge without --yes: confirmation gate refuses", async () => {
  await run("user-add", ["alice"]);
  const db = cloudDb();
  db.run(
    `INSERT INTO notes (uuid, user_id, slug, thread_id, title, type, body_html, created_at, updated_at, origin_device_id, server_seq)
     VALUES ('n1', 'alice', 's', 't', 'T', 'snippet', '<p></p>', '2026-05-01', '2026-05-01', 'dev1', 1)`
  );
  stderr.length = 0;
  const rc = await run("user-revoke", ["alice", "--purge"]);
  expect(rc).not.toBe(0);
  expect(stderr.join("")).toContain("--yes");
  // Data untouched.
  expect(db.query<{ uuid: string }, [string]>("SELECT uuid FROM notes WHERE uuid = ?").get("n1")).not.toBeNull();
});
