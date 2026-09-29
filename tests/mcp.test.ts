import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/core/db";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-mcp-test-"));
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

/** Minimal sync state = "paired with a cloud" for shareHint(). */
async function pairWithCloud() {
  // auto_sync off so the create/replace write hook doesn't try to reach the fake remote.
  const { saveConfig, loadConfig } = await import("../src/core/config");
  await saveConfig({ ...(await loadConfig()), auto_sync: false });
  const { saveSyncState } = await import("../src/core/sync");
  saveSyncState({
    remote: "https://folio.example.com",
    device_token: "test-token",
    last_pulled_seq: 0,
    last_pushed_at: null,
    last_live_pushed: {},
  });
}

async function listTools() {
  const { buildServer } = await import("../src/mcp/server");
  const server = await buildServer();
  const anySvr = server as any;
  const handler = anySvr._requestHandlers.get("tools/list");
  return await handler({ method: "tools/list", params: {} });
}

async function listResources() {
  const { buildServer } = await import("../src/mcp/server");
  const server = await buildServer();
  const anySvr = server as any;
  const handler = anySvr._requestHandlers.get("resources/list");
  return await handler({ method: "resources/list", params: {} });
}

async function readResource(uri: string) {
  const { buildServer } = await import("../src/mcp/server");
  const server = await buildServer();
  const anySvr = server as any;
  const handler = anySvr._requestHandlers.get("resources/read");
  return await handler({ method: "resources/read", params: { uri } });
}

test("ListTools returns 11 folio tools", async () => {
  const res = await listTools();
  const names = res.tools.map((t: any) => t.name);
  expect(names).toContain("create");
  expect(names).toContain("get");
  expect(names).toContain("list");
  expect(names).toContain("search");
  expect(names).toContain("finalize");
  expect(names).toContain("suggest_thread");
  expect(names).toContain("list_expiring");
  expect(names).toContain("list_themes");
  expect(names).toContain("export");
  expect(names).toContain("unfinalize");
  expect(names).toContain("version");
});

test("version tool returns package.json version + system info", async () => {
  const res = await callTool("version", {});
  expect(res.isError).toBeFalsy();
  const data = JSON.parse(res.content[0].text);
  expect(data.name).toBe("folio");
  expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(typeof data.folio_root).toBe("string");
  expect(data.viewer_url).toMatch(/^http:\/\//);
  expect(data.default_theme).toBe("linen");
  expect(typeof data.default_lifespan_days).toBe("number");
});

test("list_revisions returns the chain oldest→newest with is_head flags", async () => {
  const c = await callTool("create", {
    type: "snippet",
    title: "Rev v1",
    body_html: "<p>one</p>",
    thread_id: "rev-mcp",
  });
  const { id: v1 } = JSON.parse(c.content[0].text);
  // Build the chain via storage to keep this test focused on list_revisions
  // (the replace MCP tool has its own dedicated test below).
  const { replaceNote } = await import("../src/core/storage");
  const r = await replaceNote({ old_id: v1, body_html: "<p>two</p>", title: "Rev v2" });
  const v2 = r.new_meta!.id;

  const res = await callTool("list_revisions", { id: v1 });
  expect(res.isError).toBeFalsy();
  const data = JSON.parse(res.content[0].text);
  expect(data.count).toBe(2);
  expect(data.revisions.map((x: any) => x.id)).toEqual([v1, v2]);
  expect(data.revisions[0].version).toBe(1);
  expect(data.revisions[0].is_head).toBe(false);
  expect(data.revisions[1].is_head).toBe(true);
});

test("list_revisions errors on an unknown id", async () => {
  const res = await callTool("list_revisions", { id: "NOTAREALID000000000000000" });
  expect(res.isError).toBe(true);
});

test("replace tool returns ok + valid URLs (regression: cfg must be loaded)", async () => {
  // Before v0.30.4 the replace handler called viewerLocalBaseUrl() with no
  // cfg → threw `cfg.viewer_host`. No test exercised the tool, so it shipped.
  const c = await callTool("create", { type: "snippet", title: "Orig", body_html: "<p>one</p>" });
  const { id } = JSON.parse(c.content[0].text);
  const r = await callTool("replace", { old_id: id, body_html: "<p>two</p>", title: "Revised" });
  expect(r.isError).toBeFalsy();
  const data = JSON.parse(r.content[0].text);
  expect(data.ok).toBe(true);
  expect(data.old_id).toBe(id);
  expect(typeof data.new_id).toBe("string");
  expect(data.new_local_url).toMatch(/^http:\/\/.+\/n\/.+/);
  // No viewer_public_url → no shareable URL, only the hint (sc-6716).
  expect(data.new_public_url).toBeNull();
  expect(data.share_hint).toContain("not paired");
  expect(data.old_local_url).toContain(`/n/${id}`);
});

test("replace uses viewer_public_url for new_public_url when configured", async () => {
  const { saveConfig, loadConfig } = await import("../src/core/config");
  await saveConfig({ ...(await loadConfig()), viewer_public_url: "https://notes.example.com" });
  const c = await callTool("create", { type: "snippet", title: "Orig", body_html: "<p>one</p>" });
  const { id } = JSON.parse(c.content[0].text);
  const r = await callTool("replace", { old_id: id, body_html: "<p>two</p>" });
  const data = JSON.parse(r.content[0].text);
  expect(data.new_public_url).toBe(`https://notes.example.com/n/${data.new_id}`);
  expect(data.share_hint).toBeUndefined();
});

test("replace without viewer_public_url but paired → share_hint points at publish", async () => {
  await pairWithCloud();
  const c = await callTool("create", { type: "snippet", title: "Orig", body_html: "<p>one</p>" });
  const { id } = JSON.parse(c.content[0].text);
  const r = await callTool("replace", { old_id: id, body_html: "<p>two</p>" });
  const data = JSON.parse(r.content[0].text);
  expect(data.new_public_url).toBeNull();
  expect(data.share_hint).toContain(`publish({ id: "${data.new_id}" })`);
});

test("export standalone inlines theme CSS", async () => {
  const c = await callTool("create", {
    type: "snippet",
    title: "Export test",
    body_html: "<p>hello</p>",
  });
  const { id } = JSON.parse(c.content[0].text);
  const r = await callTool("export", { id, profile: "standalone" });
  const data = JSON.parse(r.content[0].text);
  expect(data.profile).toBe("standalone");
  expect(data.html).toContain("<style>");
  expect(data.html).not.toMatch(/<link rel="stylesheet" href="\/themes/);
  expect(data.size_kb).toBeGreaterThan(0);
});

test("export hosted keeps the link tag", async () => {
  const c = await callTool("create", { type: "snippet", title: "Hosted", body_html: "<p>x</p>" });
  const { id } = JSON.parse(c.content[0].text);
  const r = await callTool("export", { id, profile: "hosted" });
  const data = JSON.parse(r.content[0].text);
  expect(data.html).toMatch(/<link rel="stylesheet" href="\/themes\/[^"]+\/theme\.css">/);
});

test("unfinalize re-arms expiry on a final note", async () => {
  const c = await callTool("create", {
    type: "snippet",
    title: "Will unfinalize",
    body_html: "<p>x</p>",
    is_final: true,
  });
  const { id } = JSON.parse(c.content[0].text);
  const g1 = await callTool("get", { id, include_body: false });
  const m1 = JSON.parse(g1.content[0].text);
  expect(m1.is_final).toBe(true);
  expect(m1.expires_at).toBeNull();
  const u = await callTool("unfinalize", { id });
  const ud = JSON.parse(u.content[0].text);
  expect(ud.ok).toBe(true);
  const g2 = await callTool("get", { id, include_body: false });
  const m2 = JSON.parse(g2.content[0].text);
  expect(m2.is_final).toBe(false);
  expect(m2.expires_at).toBeTruthy();
});

test("unfinalize on already-non-final is a no-op", async () => {
  const c = await callTool("create", { type: "snippet", title: "Not final", body_html: "<p>x</p>" });
  const { id } = JSON.parse(c.content[0].text);
  const u = await callTool("unfinalize", { id });
  const ud = JSON.parse(u.content[0].text);
  expect(ud.ok).toBe(false);
});

test("ListResources returns built-in resources + thread-per-folder", async () => {
  await callTool("create", { type: "snippet", title: "A", body_html: "<p>a</p>", thread_id: "thread-alpha" });
  await callTool("create", { type: "snippet", title: "B", body_html: "<p>b</p>", thread_id: "thread-beta" });

  const res = await listResources();
  const uris = res.resources.map((r: any) => r.uri);
  expect(uris).toContain("folio://recent");
  expect(uris).toContain("folio://final");
  expect(uris).toContain("folio://expiring");
  expect(uris).toContain("folio://threads");
  expect(uris.some((u: string) => u.startsWith("folio://thread/thread-alpha"))).toBe(true);
  expect(uris.some((u: string) => u.startsWith("folio://thread/thread-beta"))).toBe(true);
});

test("ReadResource folio://recent returns recent notes", async () => {
  await callTool("create", { type: "snippet", title: "Recent A", body_html: "<p>a</p>" });
  const r = await readResource("folio://recent");
  const data = JSON.parse(r.contents[0].text);
  expect(Array.isArray(data)).toBe(true);
  expect(data.length).toBeGreaterThanOrEqual(1);
  expect(data[0]).toHaveProperty("title");
});

test("ReadResource folio://thread/<id> returns thread notes", async () => {
  await callTool("create", { type: "snippet", title: "Note 1", body_html: "<p>1</p>", thread_id: "test-thread-r" });
  await callTool("create", { type: "snippet", title: "Note 2", body_html: "<p>2</p>", thread_id: "test-thread-r" });
  const r = await readResource("folio://thread/test-thread-r");
  const data = JSON.parse(r.contents[0].text);
  expect(data.thread_id).toBe("test-thread-r");
  expect(data.count).toBe(2);
  expect(data.notes.length).toBe(2);
});

test("create returns id + local_url", async () => {
  const res = await callTool("create", {
    type: "research",
    title: "Test Research",
    body_html: "<p class='lead'>Quick test.</p><h3>TL;DR</h3><p>It works.</p>",
    thread_id: "test-thread",
  });
  expect(res.isError).toBeFalsy();
  const data = JSON.parse(res.content[0].text);
  expect(data.id).toMatch(/^[0-9A-Z]{26}$/);
  expect(data.local_url).toContain("/n/");
  expect(data.thread_id).toBe("test-thread");
});

test("create rejects invalid type", async () => {
  const res = await callTool("create", {
    type: "invalid",
    title: "x",
    body_html: "<p>x</p>",
  });
  expect(res.isError).toBe(true);
});

// sc-6716: without viewer_public_url the local address must never pose as the
// shareable link — public_url is null and share_hint says what to do instead.
test("create without viewer_public_url, unpaired: public_url null + hint that no external link exists", async () => {
  const res = await callTool("create", { type: "snippet", title: "Default base", body_html: "<p>x</p>" });
  expect(res.isError).toBeFalsy();
  const data = JSON.parse(res.content[0].text);
  expect(data.local_url).toBe(`http://127.0.0.1:4810/n/${data.id}`);
  expect(data.public_url).toBeNull();
  expect(data.share_hint).toContain("No external link available");
  expect(data.share_hint).toContain("not paired");
  expect(data.response_hint).not.toContain("MEDIA:");
  expect(data.response_hint).not.toContain("127.0.0.1");
  expect(data.response_hint).toContain("share_hint");
});

test("create without viewer_public_url, paired with cloud: public_url null + hint to publish", async () => {
  await pairWithCloud();
  const res = await callTool("create", { type: "snippet", title: "Paired", body_html: "<p>x</p>" });
  expect(res.isError).toBeFalsy();
  const data = JSON.parse(res.content[0].text);
  expect(data.public_url).toBeNull();
  expect(data.share_hint).toContain(`publish({ id: "${data.id}" })`);
  expect(data.share_hint).toContain("127.0.0.1");
  expect(data.response_hint).not.toContain("127.0.0.1");
});

test("create uses viewer_public_url when configured", async () => {
  const { saveConfig, loadConfig } = await import("../src/core/config");
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, viewer_public_url: "https://notes.example.com" });
  const res = await callTool("create", { type: "snippet", title: "Public base", body_html: "<p>x</p>" });
  expect(res.isError).toBeFalsy();
  const data = JSON.parse(res.content[0].text);
  expect(data.public_url).toBe(`https://notes.example.com/n/${data.id}`);
  expect(data.local_url).toContain("127.0.0.1");
  expect(data.local_url).not.toContain("notes.example.com");
  expect(data.response_hint).toContain(`MEDIA:https://notes.example.com/n/${data.id}`);
  expect(data.share_hint).toBeUndefined();
});

test("create strips trailing slash from viewer_public_url", async () => {
  const { saveConfig, loadConfig } = await import("../src/core/config");
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, viewer_public_url: "https://notes.example.com/" });
  const res = await callTool("create", { type: "snippet", title: "Trailing slash", body_html: "<p>x</p>" });
  const data = JSON.parse(res.content[0].text);
  expect(data.public_url).toBe(`https://notes.example.com/n/${data.id}`);
});

test("version tool exposes both viewer_url and public_url", async () => {
  const { saveConfig, loadConfig } = await import("../src/core/config");
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, viewer_public_url: "https://notes.example.com" });
  const res = await callTool("version", {});
  const data = JSON.parse(res.content[0].text);
  expect(data.viewer_url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(data.public_url).toBe("https://notes.example.com");
});

test("version tool: public_url null when viewer_public_url is not set", async () => {
  const res = await callTool("version", {});
  const data = JSON.parse(res.content[0].text);
  expect(data.viewer_url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(data.public_url).toBeNull();
});

test("search after create finds the note", async () => {
  await callTool("create", {
    type: "research",
    title: "Embeddings comparison",
    body_html: "<p>RAG via OpenAI ada-3 vs Voyage AI vs lokalny gte-small.</p>",
    thread_id: "embeddings",
  });
  const res = await callTool("search", { query: "ada" });
  const hits = JSON.parse(res.content[0].text);
  expect(hits.length).toBeGreaterThanOrEqual(1);
  expect(hits[0].snippet).toContain("<mark>");
});

test("suggest_thread returns proposed slug when no match", async () => {
  const res = await callTool("suggest_thread", { title: "Brand new topic" });
  const data = JSON.parse(res.content[0].text);
  expect(data.matches).toEqual([]);
  expect(data.proposed_new_thread).toBe("brand-new-topic");
});

test("suggest_thread returns existing thread when title matches", async () => {
  await callTool("create", {
    type: "research",
    title: "RAG vs Fine-Tuning",
    body_html: "<p>x</p>",
    thread_id: "rag-vs-finetuning",
  });
  // AND across tokens: use a query whose every word appears in the title.
  const res = await callTool("suggest_thread", { title: "RAG Fine-Tuning" });
  const data = JSON.parse(res.content[0].text);
  expect(data.matches?.length).toBeGreaterThanOrEqual(1);
  expect(data.matches[0].thread_id).toBe("rag-vs-finetuning");
});

test("list_themes shows linen as default", async () => {
  const res = await callTool("list_themes", {});
  const data = JSON.parse(res.content[0].text);
  expect(data.default).toBe("linen");
  const names = data.themes.map((t: any) => t.name);
  expect(names).toContain("linen");
  expect(names).toContain("folio");
});

test("finalize clears expiry; list_expiring excludes it", async () => {
  const created = await callTool("create", {
    type: "snippet",
    title: "About to expire",
    body_html: "<p>x</p>",
  });
  const { id } = JSON.parse(created.content[0].text);

  // Simulate "near expiry" by NOT finalizing; default expiry is 30d so within 7d filter returns nothing
  // Make sure the API works at least syntactically:
  const expiring = await callTool("list_expiring", { within_days: 60 });
  const arr = JSON.parse(expiring.content[0].text);
  expect(Array.isArray(arr)).toBe(true);

  // Finalize and re-check
  await callTool("finalize", { id });
  const expiring2 = await callTool("list_expiring", { within_days: 60 });
  const arr2 = JSON.parse(expiring2.content[0].text);
  const foundFinalized = arr2.find((n: any) => n.id === id);
  expect(foundFinalized).toBeUndefined();
});

test("get with include_body=true returns body_html", async () => {
  const created = await callTool("create", {
    type: "snippet",
    title: "Get me",
    body_html: "<p>Hello there from agent</p>",
  });
  const { id } = JSON.parse(created.content[0].text);
  const got = await callTool("get", { id });
  const data = JSON.parse(got.content[0].text);
  expect(data.title).toBe("Get me");
  expect(data.body_html).toContain("Hello there");
});

// ── body_path: read large bodies from a file server-side (bypass tool-call truncation) ──

test("create reads body from body_path (server-side file)", async () => {
  const { writeFileSync } = require("node:fs");
  const marker = "BODYPATH_" + Math.random().toString(36).slice(2);
  const bodyFile = join(tmpDir, "big-body.html");
  writeFileSync(bodyFile, `<p>${marker}</p>`);
  const res = await callTool("create", { type: "snippet", title: "From file", body_path: bodyFile, thread_id: "bp" });
  expect(res.isError).toBeFalsy();
  const { id } = JSON.parse(res.content[0].text);
  const got = await callTool("get", { id });
  expect(JSON.parse(got.content[0].text).body_html).toContain(marker);
});

test("create rejects both body_html and body_path", async () => {
  const res = await callTool("create", { type: "snippet", title: "Both", body_html: "<p>x</p>", body_path: join(tmpDir, "x.html"), thread_id: "bp" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("exactly one");
});

test("create rejects neither body_html nor body_path", async () => {
  const res = await callTool("create", { type: "snippet", title: "Neither", thread_id: "bp" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("exactly one");
});

test("create errors when body_path does not exist", async () => {
  const res = await callTool("create", { type: "snippet", title: "Ghost", body_path: join(tmpDir, "nope.html"), thread_id: "bp" });
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("does not exist");
});

test("replace reads new body from body_path", async () => {
  const { writeFileSync } = require("node:fs");
  const c = await callTool("create", { type: "snippet", title: "Orig", body_html: "<p>orig</p>", thread_id: "bp" });
  const { id } = JSON.parse(c.content[0].text);
  const marker = "REPLACED_" + Math.random().toString(36).slice(2);
  const bodyFile = join(tmpDir, "new-body.html");
  writeFileSync(bodyFile, `<p>${marker}</p>`);
  const res = await callTool("replace", { old_id: id, body_path: bodyFile });
  expect(res.isError).toBeFalsy();
  const { new_id } = JSON.parse(res.content[0].text);
  const got = await callTool("get", { id: new_id });
  expect(JSON.parse(got.content[0].text).body_html).toContain(marker);
});
