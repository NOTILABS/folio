/**
 * sc-15149 — session_key: the agent chat session a note was created in.
 *
 * Kokpit's "Pliki i artefakty" tab and library used to see a Folio note only
 * when its link was pasted into the conversation. With session_key the chat
 * client can ask Folio for every note of its session. Contract pinned here:
 *   - v6 db (pre-migration) gains the column; old notes keep NULL and stay
 *     listable exactly as before
 *   - createNote stores a normalized key; bad keys throw before any file write
 *   - listNotes / GET /api/list / MCP list filter by it; empty key matches
 *     nothing (never "no filter")
 *   - replace carries the key to the new revision
 *   - MCP create accepts and echoes it
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { closeDb } from "../src/core/db";

let tmpDir: string;
let viewer: { stop: () => void; port: number; hostname: string } | null = null;

const KEY = "agent:main:kokpit:topic-42";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-session-key-"));
  process.env.FOLIO_HOME = tmpDir;
  closeDb();
});

afterEach(() => {
  try { viewer?.stop(); } catch {}
  viewer = null;
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_HOME;
});

async function setup() {
  const { init } = await import("../src/cli/commands/init");
  await init();
  return await import("../src/core/storage");
}

async function makeNote(title: string, session_key?: string, thread_id = "sk") {
  const { createNote } = await import("../src/core/storage");
  return await createNote({
    type: "research",
    title,
    body_html: `<p>${title}</p>`,
    thread_id,
    theme: "linen",
    session_key,
  });
}

// ─── migration ──────────────────────────────────────────────────────────

test("v6 db: migration adds session_key, old notes stay listable with NULL", async () => {
  // Create a head-shaped db, then roll it back to the v6 shape (no
  // session_key column, schema_version='6') with one note in it — what a
  // box running v0.43 has on disk.
  const storage = await setup();
  const old = await makeNote("Sprzed migracji");
  closeDb();
  const d = new Database(join(tmpDir, "index.sqlite"));
  d.exec("DROP INDEX IF EXISTS notes_by_session");
  d.exec("ALTER TABLE notes DROP COLUMN session_key");
  d.run("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
  const colsBefore = d.query<{ name: string }, []>("PRAGMA table_info(notes)").all().map((r) => r.name);
  expect(colsBefore).not.toContain("session_key");
  d.close();

  // Reopen through the app → migration 6→7 runs.
  const { db } = await import("../src/core/db");
  const cols = db().query<{ name: string }, []>("PRAGMA table_info(notes)").all().map((r) => r.name);
  expect(cols).toContain("session_key");
  const ver = db().query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
  expect(ver?.value).toBe("7");
  const idx = db().query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND name='notes_by_session'").get();
  expect(idx?.name).toBe("notes_by_session");

  const meta = storage.getNoteMeta(old.id)!;
  expect(meta.session_key).toBeNull();
  expect(storage.listNotes().map((n) => n.id)).toContain(old.id);
  expect(storage.listNotes({ session_key: KEY })).toEqual([]);
});

// ─── create + list ──────────────────────────────────────────────────────

test("createNote stores the trimmed key; default is null", async () => {
  const { getNoteMeta } = await setup();
  const a = await makeNote("Z sesją", `  ${KEY}  `);
  const b = await makeNote("Bez sesji");
  expect(a.session_key).toBe(KEY);
  expect(getNoteMeta(a.id)!.session_key).toBe(KEY);
  expect(b.session_key).toBeNull();
  expect(getNoteMeta(b.id)!.session_key).toBeNull();
  const blank = await makeNote("Pusty klucz", "   ");
  expect(blank.session_key).toBeNull();
});

test("bad session_key throws before any file is written", async () => {
  await setup();
  const threadDir = join(tmpDir, "threads", "sk-bad");
  await expect(makeNote("Za długi", "x".repeat(513), "sk-bad")).rejects.toThrow(/longer than 512/);
  await expect(makeNote("Sterujący", "agent:a\nb", "sk-bad")).rejects.toThrow(/control characters/);
  const files = existsSync(threadDir) ? readdirSync(threadDir) : [];
  expect(files).toEqual([]);
  // 512 is still fine
  const ok = await makeNote("Na granicy", "k".repeat(512), "sk-bad");
  expect(ok.session_key).toHaveLength(512);
});

test("listNotes filters by session_key across threads; empty key matches nothing", async () => {
  const { listNotes } = await setup();
  const a = await makeNote("Topik A1", KEY, "watek-1");
  const b = await makeNote("Topik A2", KEY, "watek-2");
  await makeNote("Inny topik", "agent:main:kokpit:topic-7");
  await makeNote("Bez sesji");
  const ids = listNotes({ session_key: KEY }).map((n) => n.id).sort();
  expect(ids).toEqual([a.id, b.id].sort());
  expect(listNotes({ session_key: ` ${KEY} ` }).map((n) => n.id).sort()).toEqual(ids);
  expect(listNotes({ session_key: "" })).toEqual([]);
  expect(listNotes({ session_key: "   " })).toEqual([]);
  // No filter → everything, as before.
  expect(listNotes().length).toBe(4);
});

test("replace carries session_key to the new revision; old one leaves the session list", async () => {
  const { replaceNote, listNotes } = await setup();
  const a = await makeNote("Szkic", KEY);
  const r = await replaceNote({ old_id: a.id, body_html: "<p>v2</p>" });
  expect(r.ok).toBe(true);
  expect(r.new_meta!.session_key).toBe(KEY);
  expect(listNotes({ session_key: KEY }).map((n) => n.id)).toEqual([r.new_meta!.id]);
});

// ─── viewer API ─────────────────────────────────────────────────────────

async function startViewer() {
  const cfgPath = join(tmpDir, "folio.config.json");
  const parsed = JSON.parse(readFileSync(cfgPath, "utf-8"));
  parsed.viewer_port = 0;
  writeFileSync(cfgPath, JSON.stringify(parsed));
  const { startServer } = await import("../src/viewer/server");
  viewer = (await startServer()) as any;
  return `http://${viewer!.hostname}:${viewer!.port}`;
}

test("GET /api/list?session_key= returns only that session's notes", async () => {
  await setup();
  const a = await makeNote("Notka topiku", KEY);
  await makeNote("Cudza", "agent:main:kokpit:topic-7");
  await makeNote("Stara");
  const base = await startViewer();

  const r = await fetch(`${base}/api/list?session_key=${encodeURIComponent(KEY)}`);
  expect(r.status).toBe(200);
  const rows = (await r.json()) as Array<{ id: string; session_key: string | null }>;
  expect(rows.map((n) => n.id)).toEqual([a.id]);
  expect(rows[0]!.session_key).toBe(KEY);

  const empty = await fetch(`${base}/api/list?session_key=`);
  expect(await empty.json()).toEqual([]);

  const all = await fetch(`${base}/api/list`);
  expect(((await all.json()) as unknown[]).length).toBe(3);

  const bad = await fetch(`${base}/api/list?session_key=${"x".repeat(600)}`);
  expect(bad.status).toBe(400);
});

// ─── MCP ────────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { buildServer } = await import("../src/mcp/server");
  const server = await buildServer();
  const handler = (server as any)._requestHandlers.get("tools/call");
  return await handler({ method: "tools/call", params: { name, arguments: args } });
}

test("MCP create accepts session_key, echoes it, and list filters by it", async () => {
  await setup();
  const res = await callTool("create", { type: "snippet", title: "Z MCP", body_html: "<p>x</p>", session_key: KEY });
  expect(res.isError).toBeFalsy();
  const created = JSON.parse(res.content[0].text);
  expect(created.session_key).toBe(KEY);

  await callTool("create", { type: "snippet", title: "Bez klucza", body_html: "<p>y</p>" });
  const listed = JSON.parse((await callTool("list", { session_key: KEY })).content[0].text);
  expect(listed.map((n: any) => n.id)).toEqual([created.id]);

  const bad = await callTool("create", { type: "snippet", title: "Zły", body_html: "<p>z</p>", session_key: "a\u0001b" });
  expect(bad.isError).toBe(true);
});

test("MCP tool schema advertises session_key on create and list", async () => {
  const { buildServer } = await import("../src/mcp/server");
  const server = await buildServer();
  const handler = (server as any)._requestHandlers.get("tools/list");
  const { tools } = await handler({ method: "tools/list", params: {} });
  const create = tools.find((t: any) => t.name === "create");
  const list = tools.find((t: any) => t.name === "list");
  expect(create.inputSchema.properties.session_key.type).toBe("string");
  expect(list.inputSchema.properties.session_key.type).toBe("string");
});
