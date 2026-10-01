/**
 * sc-7749: `publish` right after `create` must not fail with
 * "400 note not found" just because the note hasn't been synced yet.
 *
 * Real cloud relay in-process (same fixture as sync-assets.test.ts), auto_sync
 * off so no background tick pushes the note — the race is deterministic.
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/core/db";
import { closeCloudDb } from "../src/cloud/db";

let homeDir: string;
let cloudHomeDir: string;
let server: { stop: (force?: boolean) => void; port: number; hostname: string } | null = null;
let baseUrl: string;
let token: string;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "folio-publish-home-"));
  cloudHomeDir = mkdtempSync(join(tmpdir(), "folio-publish-cloud-"));
  process.env.FOLIO_HOME = homeDir;
  process.env.FOLIO_CLOUD_HOME = cloudHomeDir;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0 })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;
  const { init } = await import("../src/cli/commands/init");
  await init();
  const { saveConfig, loadConfig, getOrCreateDeviceId } = await import("../src/core/config");
  await saveConfig({ ...(await loadConfig()), auto_sync: false });
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  const pairRes = await fetch(`${baseUrl}/v1/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, device_name: "test", device_id: getOrCreateDeviceId().id }),
  });
  token = ((await pairRes.json()) as { token: string }).token;
  const { saveSyncState } = await import("../src/core/sync");
  saveSyncState({
    remote: baseUrl,
    device_token: token,
    last_pulled_seq: 0,
    last_pushed_at: null,
    last_live_pushed: {},
  });
});

afterEach(() => {
  try { server?.stop(true); } catch {}
  server = null;
  closeDb();
  closeCloudDb();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cloudHomeDir, { recursive: true, force: true });
  delete process.env.FOLIO_HOME;
  delete process.env.FOLIO_CLOUD_HOME;
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { buildServer } = await import("../src/mcp/server");
  const srv = (await buildServer()) as any;
  const handler = srv._requestHandlers.get("tools/call");
  return await handler({ method: "tools/call", params: { name, arguments: args } });
}

/** The share URL carries the cloud's configured public host; the test cloud
 *  listens on an ephemeral port, so fetch the same path there. */
function onTestCloud(url: string): string {
  const u = new URL(url);
  return `${baseUrl}${u.pathname}`;
}

test("race precondition: freshly created note is unknown to the cloud (raw POST → 400 note not found)", async () => {
  const created = JSON.parse(
    (await callTool("create", { type: "snippet", title: "Race", body_html: "<p>race</p>" })).content[0].text
  );
  const res = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: created.id }),
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("note not found");
});

test("MCP: create → immediate publish → URL works from outside (no auth)", async () => {
  const created = JSON.parse(
    (await callTool("create", { type: "snippet", title: "Publish right away", body_html: "<p>hello sc-7749</p>" }))
      .content[0].text
  );
  const pub = await callTool("publish", { id: created.id });
  expect(pub.isError).toBeFalsy();
  const data = JSON.parse(pub.content[0].text);
  expect(data.scope_id).toBe(created.id);
  expect(data.url).toContain(`/p/`);
  expect(data.url).toContain(`/n/${created.id}`);
  expect(data.url).not.toContain("127.0.0.1:4810");

  // "From outside" = a plain GET, no device token, no cookies.
  const page = await fetch(onTestCloud(data.url));
  expect(page.status).toBe(200);
  const raw = await fetch(onTestCloud(data.url).replace(`/n/${created.id}`, `/raw/${created.id}`));
  expect(raw.status).toBe(200);
  expect(await raw.text()).toContain("hello sc-7749");
});

test("MCP: create → immediate publish of the thread scope also syncs first", async () => {
  const created = JSON.parse(
    (await callTool("create", { type: "snippet", title: "Thread share", thread_id: "sc7749-thread", body_html: "<p>t</p>" }))
      .content[0].text
  );
  const pub = await callTool("publish", { id: created.thread_id, scope_type: "thread" });
  expect(pub.isError).toBeFalsy();
  const data = JSON.parse(pub.content[0].text);
  expect(data.scope_type).toBe("thread");
  const page = await fetch(onTestCloud(data.url));
  expect(page.status).toBe(200);
});

test("CLI: folio publish right after create prints a working URL", async () => {
  const created = JSON.parse(
    (await callTool("create", { type: "snippet", title: "CLI publish", body_html: "<p>cli</p>" })).content[0].text
  );
  const { publishCmd } = await import("../src/cli/commands/publish");
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  (process.stdout as any).write = (s: any) => { captured += String(s); return true; };
  console.log = (...a: any[]) => { captured += a.join(" ") + "\n"; };
  let code: number;
  try {
    code = await publishCmd({ id: created.id, jsonOut: true });
  } finally {
    (process.stdout as any).write = origWrite;
    console.log = origLog;
  }
  expect(code).toBe(0);
  const out = JSON.parse(captured.slice(captured.indexOf("{")));
  const page = await fetch(onTestCloud(out.url));
  expect(page.status).toBe(200);
});

test("cloud not responding → 'try again in a moment', never 'note not found'", async () => {
  const { createShareSynced } = await import("../src/core/publish");
  // Port 1 on loopback: connection refused, i.e. no cloud at all.
  const r = await createShareSynced(
    { remote: "http://127.0.0.1:1", device_token: "x", last_pulled_seq: 0, last_pushed_at: null, last_live_pushed: {} },
    { scope_type: "note", scope_id: "01TESTTESTTESTTESTTESTTEST" },
    { timeoutMs: 600 }
  );
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.kind).toBe("unreachable");
  expect(r.message).toContain("try again in a moment".replace(/^t/, "T"));
  expect(r.message).not.toContain("not found");
  expect(r.attempts).toBeGreaterThan(1);
});

test("cloud answering 503 → unreachable after retries, same wording", async () => {
  const down = Bun.serve({ port: 0, fetch: () => new Response("upstream down", { status: 503 }) });
  try {
    const { createShareSynced } = await import("../src/core/publish");
    const r = await createShareSynced(
      { remote: `http://127.0.0.1:${down.port}`, device_token: "x", last_pulled_seq: 0, last_pushed_at: null, last_live_pushed: {} },
      { scope_type: "note", scope_id: "01TESTTESTTESTTESTTESTTEST" },
      { timeoutMs: 600 }
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("unreachable");
    expect(r.message).toContain("HTTP 503");
    expect(r.message).toContain("Try again in a moment");
  } finally {
    down.stop(true);
  }
});

test("note never reaches the cloud within the limit → bounded wait, clear message", async () => {
  const { createShareSynced } = await import("../src/core/publish");
  const { loadSyncState } = await import("../src/core/sync");
  let syncCalls = 0;
  const t0 = Date.now();
  const r = await createShareSynced(
    loadSyncState()!,
    { scope_type: "note", scope_id: "01NEVERSYNCEDNEVERSYNCEDNE" },
    { timeoutMs: 1500, syncStep: async () => { syncCalls++; return true; } }
  );
  expect(Date.now() - t0).toBeLessThan(6000);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.kind).toBe("not_synced");
  expect(syncCalls).toBeGreaterThan(0);
  expect(r.message).toContain("not in the cloud yet");
  expect(r.message).toContain("Try again in a moment");
});

test("other cloud errors are returned at once, no sync, no retry", async () => {
  const { createShareSynced } = await import("../src/core/publish");
  const { loadSyncState } = await import("../src/core/sync");
  let syncCalls = 0;
  const r = await createShareSynced(
    loadSyncState()!,
    { scope_type: "bogus", scope_id: "x" },
    { timeoutMs: 5000, syncStep: async () => { syncCalls++; return true; } }
  );
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.kind).toBe("rejected");
  expect(r.attempts).toBe(1);
  expect(syncCalls).toBe(0);
  expect(r.message).toContain("HTTP 400");
});
