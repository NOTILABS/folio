// End-to-end live note lifecycle through the MCP tool surface.
// Exercises: create live → append entries → list_entries → mutate via
// refs + state:done → set_pinned → finalize → assert .html body rewritten,
// jsonl moved to .trash/, db rows flipped is_final=1 / live=0.

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, db } from "../src/core/db";
import { entriesPath } from "../src/core/live";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-live-storage-"));
  process.env.FOLIO_HOME = tmpDir;
  const { init } = await import("../src/cli/commands/init");
  await init();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { buildServer } = await import("../src/mcp/server");
  const server = await buildServer();
  const anySvr = server as any;
  const handler = anySvr._requestHandlers.get("tools/call");
  if (!handler) throw new Error("CallTool handler not registered");
  return await handler({ method: "tools/call", params: { name, arguments: args } });
}

async function createLive(title: string): Promise<{ id: string; path: string }> {
  const r = await callTool("create", {
    type: "journal",
    title,
    body_html: "",
    live: true,
    thread_id: "test-live",
  });
  expect(r.isError).toBeFalsy();
  const data = JSON.parse(r.content[0].text);
  return { id: data.id, path: data.path };
}

// ───── create + lifecycle ────────────────────────────────────────────────

test("create live note: empty body_html allowed; live flag persists; stream_url returned", async () => {
  const r = await callTool("create", { type: "journal", title: "Daily ops", body_html: "", live: true });
  expect(r.isError).toBeFalsy();
  const data = JSON.parse(r.content[0].text);
  expect(data.live).toBe(true);
  expect(data.local_stream_url).toContain(`/n/${data.id}/stream`);
  // No viewer_public_url → no shareable stream URL (sc-6716).
  expect(data.stream_url).toBeNull();
});

test("create live note: stream_url uses viewer_public_url when configured", async () => {
  const { saveConfig, loadConfig } = await import("../src/core/config");
  await saveConfig({ ...(await loadConfig()), viewer_public_url: "https://notes.example.com" });
  const r = await callTool("create", { type: "journal", title: "Public feed", body_html: "", live: true });
  const data = JSON.parse(r.content[0].text);
  expect(data.stream_url).toBe(`https://notes.example.com/n/${data.id}/stream`);
});

test("create non-live rejects empty body_html", async () => {
  const r = await callTool("create", { type: "snippet", title: "X", body_html: "" });
  expect(r.isError).toBe(true);
});

test("non-live note has no stream_url in create response", async () => {
  const r = await callTool("create", { type: "snippet", title: "X", body_html: "<p>x</p>" });
  const data = JSON.parse(r.content[0].text);
  expect(data.local_stream_url).toBeUndefined();
  expect(data.stream_url).toBeUndefined();
  expect(data.live).toBe(false);
});

test("append_entry writes to .entries.jsonl alongside note", async () => {
  const { id, path: notePath } = await createLive("Append test");
  const r = await callTool("append_entry", {
    note_id: id,
    content_html: "<p>first entry</p>",
    tags: ["state:open", "urgent"],
  });
  expect(r.isError).toBeFalsy();
  const data = JSON.parse(r.content[0].text);
  expect(data.entry_id).toMatch(/^[a-z0-9]{10}$/);
  expect(data.entry_count).toBe(1);

  const jsonl = entriesPath(join(tmpDir, notePath));
  expect(existsSync(jsonl)).toBe(true);
  const lines = readFileSync(jsonl, "utf-8").trim().split("\n");
  expect(lines.length).toBe(1);
  const entry = JSON.parse(lines[0]!);
  expect(entry.content_html).toContain("first entry");
  expect(entry.tags).toContain("state:open");
});

test("append_entry updates notes.last_entry_at", async () => {
  const { id } = await createLive("Last entry tracking");
  const beforeRow = db().query<any, [string]>("SELECT last_entry_at FROM notes WHERE id = ?").get(id);
  expect(beforeRow?.last_entry_at).toBeNull();

  await callTool("append_entry", { note_id: id, content_html: "<p>a</p>" });
  const afterRow = db().query<any, [string]>("SELECT last_entry_at FROM notes WHERE id = ?").get(id);
  expect(afterRow?.last_entry_at).toBeString();
});

test("list_entries returns all entries with compiled tag sets", async () => {
  const { id } = await createLive("List test");
  await callTool("append_entry", { note_id: id, content_html: "<p>todo 1</p>", tags: ["state:open"] });
  const r2 = await callTool("append_entry", { note_id: id, content_html: "<p>todo 2</p>", tags: ["state:open"] });
  const e2 = JSON.parse(r2.content[0].text);
  // Mutator: mark second entry as done via chain
  await callTool("append_entry", { note_id: id, content_html: "", tags: ["state:done"], refs: [e2.entry_id] });

  const r = await callTool("list_entries", { note_id: id });
  const data = JSON.parse(r.content[0].text);
  expect(data.total).toBe(3); // includes the empty mutator
  const second = data.entries.find((e: any) => e.id === e2.entry_id);
  expect(second.state).toBe("done"); // compiled, not raw
});

test("list_entries filters by since", async () => {
  const { id } = await createLive("Since test");
  await callTool("append_entry", { note_id: id, content_html: "<p>old</p>" });
  // Pause to ensure ts differs
  await new Promise((res) => setTimeout(res, 20));
  const midTs = new Date().toISOString();
  await new Promise((res) => setTimeout(res, 20));
  await callTool("append_entry", { note_id: id, content_html: "<p>new</p>" });

  const r = await callTool("list_entries", { note_id: id, since: midTs });
  const data = JSON.parse(r.content[0].text);
  expect(data.returned).toBe(1);
  expect(data.entries[0].content_html).toContain("new");
});

test("set_pinned diff: pin two, then re-pin a third — old ones unpinned", async () => {
  const { id } = await createLive("Pin test");
  const a = JSON.parse((await callTool("append_entry", { note_id: id, content_html: "<p>a</p>" })).content[0].text);
  const b = JSON.parse((await callTool("append_entry", { note_id: id, content_html: "<p>b</p>" })).content[0].text);
  const c = JSON.parse((await callTool("append_entry", { note_id: id, content_html: "<p>c</p>" })).content[0].text);

  await callTool("set_pinned", { note_id: id, entry_ids: [a.entry_id, b.entry_id] });
  let listing = JSON.parse((await callTool("list_entries", { note_id: id })).content[0].text);
  const pinnedIds = listing.entries.filter((e: any) => e.pinned && e.rendered).map((e: any) => e.id);
  expect(pinnedIds.sort()).toEqual([a.entry_id, b.entry_id].sort());

  // Now pin only c — a + b should get unpinned
  await callTool("set_pinned", { note_id: id, entry_ids: [c.entry_id] });
  listing = JSON.parse((await callTool("list_entries", { note_id: id })).content[0].text);
  const stillPinned = listing.entries.filter((e: any) => e.pinned && e.rendered).map((e: any) => e.id);
  expect(stillPinned).toEqual([c.entry_id]);
});

test("finalize on live note: compiles body, moves jsonl to trash, flips is_final", async () => {
  const { id, path: notePath } = await createLive("Finalize me");
  await callTool("append_entry", { note_id: id, content_html: "<p>visible entry</p>", tags: ["state:open"] });
  await callTool("append_entry", { note_id: id, content_html: "<p>another</p>", tags: ["urgent"] });

  const r = await callTool("finalize", { id });
  expect(r.isError).toBeFalsy();

  const noteFile = readFileSync(join(tmpDir, notePath), "utf-8");
  expect(noteFile).toContain("visible entry");
  expect(noteFile).toContain("another");
  expect(noteFile).toContain('class="entry');

  const jsonl = entriesPath(join(tmpDir, notePath));
  expect(existsSync(jsonl)).toBe(false); // moved
  expect(existsSync(join(tmpDir, ".trash", `${id}.entries.jsonl`))).toBe(true);

  const row = db().query<any, [string]>("SELECT is_final, live FROM notes WHERE id = ?").get(id);
  expect(row?.is_final).toBe(1);
  expect(row?.live).toBe(0);
});

test("finalize is idempotent: re-running on final note is a no-op", async () => {
  const { id } = await createLive("Idempotent");
  await callTool("append_entry", { note_id: id, content_html: "<p>x</p>" });
  await callTool("finalize", { id });
  const r2 = await callTool("finalize", { id });
  expect(r2.isError).toBeFalsy();
  // Should return ok regardless
  const row = db().query<any, [string]>("SELECT is_final, live FROM notes WHERE id = ?").get(id);
  expect(row?.is_final).toBe(1);
  expect(row?.live).toBe(0);
});

test("finalize on non-live note still flips is_final without touching jsonl", async () => {
  const r = await callTool("create", { type: "snippet", title: "Regular", body_html: "<p>plain</p>" });
  const data = JSON.parse(r.content[0].text);
  await callTool("finalize", { id: data.id });
  const row = db().query<any, [string]>("SELECT is_final, live FROM notes WHERE id = ?").get(data.id);
  expect(row?.is_final).toBe(1);
  expect(row?.live).toBe(0);
});
