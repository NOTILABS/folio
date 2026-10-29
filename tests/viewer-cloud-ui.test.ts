/**
 * /cloud page in local viewer + /api/sync/* endpoints.
 *
 * Spins up BOTH the cloud relay (port 0) AND the local viewer (port 0)
 * in the same process, then exercises pair → state → pair-code → run →
 * unpair through the local API.
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/core/db";
import { closeCloudDb } from "../src/cloud/db";

let homeDir: string;
let cloudHomeDir: string;
let cloud: { stop: () => void; port: number; hostname: string } | null = null;
let viewer: { stop: () => void; port: number; hostname: string } | null = null;
let cloudUrl: string;
let viewerUrl: string;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "folio-vc-home-"));
  cloudHomeDir = mkdtempSync(join(tmpdir(), "folio-vc-cloud-"));
  process.env.FOLIO_HOME = homeDir;
  process.env.FOLIO_CLOUD_HOME = cloudHomeDir;

  const { startCloudServer } = await import("../src/cloud/server");
  cloud = (await startCloudServer({ port: 0 })) as any;
  cloudUrl = `http://${cloud!.hostname}:${cloud!.port}`;

  const { init } = await import("../src/cli/commands/init");
  await init();
  // Force ephemeral viewer port via config.
  const cfgPath = join(homeDir, "folio.config.json");
  const parsed = JSON.parse(readFileSync(cfgPath, "utf-8"));
  parsed.viewer_port = 0;
  writeFileSync(cfgPath, JSON.stringify(parsed));
  const { startServer } = await import("../src/viewer/server");
  viewer = (await startServer()) as any;
  viewerUrl = `http://${viewer!.hostname}:${viewer!.port}`;
});

afterEach(() => {
  try { viewer?.stop(); } catch {}
  try { cloud?.stop(); } catch {}
  cloud = null; viewer = null;
  closeDb();
  closeCloudDb();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cloudHomeDir, { recursive: true, force: true });
  delete process.env.FOLIO_HOME;
  delete process.env.FOLIO_CLOUD_HOME;
});

test("GET /cloud (not paired) renders pair form", async () => {
  const r = await fetch(`${viewerUrl}/cloud`);
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain("Pair this device");
  expect(html).toContain('id="cloud-remote"');
  expect(html).toContain('id="cloud-code"');
  expect(html).toContain("/api/sync/pair");
});

test("GET /api/sync/state (not paired) returns paired=false", async () => {
  const r = await fetch(`${viewerUrl}/api/sync/state`);
  const body = (await r.json()) as { paired: boolean; device_id: string };
  expect(body.paired).toBe(false);
  expect(body.device_id).toBeTruthy();
});

test("POST /api/sync/pair: full pair flow via local viewer", async () => {
  // Operator-side: generate a code on the cloud.
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();

  // Now hit the LOCAL viewer's pair endpoint, which talks to cloud for us.
  const r = await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code, device_name: "via-viewer" }),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { ok: boolean; device_id: string };
  expect(body.ok).toBe(true);

  // .sync-state.json now exists.
  const { loadSyncState } = await import("../src/core/sync");
  const state = loadSyncState();
  expect(state).not.toBeNull();
  expect(state!.remote).toBe(cloudUrl);
  // sc-24117: viewer pairing pins an ed25519 device key — no bearer on disk.
  expect(state!.key_alg).toBe("ed25519");
  expect(state!.device_token).toBeUndefined();

  // /cloud now renders the paired view.
  const cloudPage = await fetch(`${viewerUrl}/cloud`);
  const html = await cloudPage.text();
  expect(html).toContain("Paired with");
  expect(html).toContain("Sync now");
  expect(html).toContain("Generate code for another device");
});

test("POST /api/sync/pair-code (paired) returns a code; (unpaired) 400", async () => {
  // Unpaired first.
  const r1 = await fetch(`${viewerUrl}/api/sync/pair-code`, { method: "POST" });
  expect(r1.status).toBe(400);

  // Pair, then ask for a fresh code via the local viewer.
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code, device_name: "operator" }),
  });

  const r2 = await fetch(`${viewerUrl}/api/sync/pair-code`, { method: "POST" });
  expect(r2.status).toBe(200);
  const body = (await r2.json()) as { code: string; expires_at: string };
  expect(body.code).toMatch(/^[0-9]{6}$/);
});

test("POST /api/sync/run: ran after pair, returns counter shape", async () => {
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code }),
  });

  // Make a note so push has something to do.
  const { createNote } = await import("../src/core/storage");
  await createNote({
    type: "snippet",
    title: "via-ui",
    body_html: "<p>x</p>",
    thread_id: "via-ui",
  });

  const r = await fetch(`${viewerUrl}/api/sync/run`, { method: "POST" });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { pushed: number; pulled: number };
  expect(body.pushed).toBe(1);
  expect(body.pulled).toBe(0);
});

test("POST /api/sync/unpair clears local state", async () => {
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code }),
  });
  expect((await fetch(`${viewerUrl}/api/sync/state`).then((r) => r.json())).paired).toBe(true);

  const r = await fetch(`${viewerUrl}/api/sync/unpair`, { method: "POST" });
  expect(r.status).toBe(200);
  expect((await fetch(`${viewerUrl}/api/sync/state`).then((r) => r.json())).paired).toBe(false);
});

test("POST /api/sync/pair with bad code returns 502 with cloud's error", async () => {
  const r = await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code: "999999" }),
  });
  expect(r.status).toBe(502);
  const body = (await r.json()) as { error: string };
  expect(body.error).toContain("pair failed");
});

test("v0.21.2: topbar has Sync link (renamed from Cloud, icon dropped)", async () => {
  const html = await fetch(`${viewerUrl}/`).then((r) => r.text());
  // URL stays /cloud (route unchanged) but the label is now "Sync" and the
  // ☁ icon is gone. Test the v-nav block specifically so we don't match
  // "Cloud" appearing in unrelated copy elsewhere on the page.
  expect(html).toContain('href="/cloud"');
  const navMatch = html.match(/<nav class="v-nav">([\s\S]*?)<\/nav>/);
  expect(navMatch).not.toBeNull();
  expect(navMatch![1]).toContain(">Sync</a>");
  expect(navMatch![1]).not.toContain("☁");
  expect(navMatch![1]).not.toContain(">Cloud<");
});

test("GET /api/cloud/stats (unpaired) returns 400", async () => {
  const r = await fetch(`${viewerUrl}/api/cloud/stats`);
  expect(r.status).toBe(400);
});

test("GET /api/cloud/stats (paired) proxies cloud admin stats", async () => {
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code, device_name: "for-stats" }),
  });
  const r = await fetch(`${viewerUrl}/api/cloud/stats`);
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.cloud.name).toBe("folio-cloud");
  expect(body.counts.devices_active).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(body.devices)).toBe(true);
});

test("/cloud (paired) renders Operator card placeholder + bootstrap JS", async () => {
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code }),
  });
  const html = await fetch(`${viewerUrl}/cloud`).then((r) => r.text());
  // Markup present even when JS hasn't decided whether to reveal it.
  expect(html).toContain('id="operator-card"');
  expect(html).toContain('id="add-user-form"');
  expect(html).toContain('id="op-users-table"');
  // JS calls whoami + admin/users.
  expect(html).toContain("/api/cloud/admin/whoami");
  expect(html).toContain("/api/cloud/admin");
});

test("/api/cloud/admin/whoami: proxies to cloud, returns operator flag", async () => {
  const { createPairingCode } = await import("../src/cloud/auth");
  // Pre-seed cloud user as operator.
  const { cloudDb } = await import("../src/cloud/db");
  cloudDb().run("UPDATE users SET is_operator = 1 WHERE id = 'default'");
  const { code } = createPairingCode();
  await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code }),
  });
  const r = await fetch(`${viewerUrl}/api/cloud/admin/whoami`);
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.user_id).toBe("default");
  expect(body.is_operator).toBe(true);
});

test("/api/cloud/admin/* (unpaired): 400", async () => {
  const r = await fetch(`${viewerUrl}/api/cloud/admin/users`);
  expect(r.status).toBe(400);
});

test("/api/cloud/admin/users (non-operator): 403 surfaced from cloud", async () => {
  // pair as default user, who's NOT an operator (default is_operator = 0).
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code }),
  });
  const r = await fetch(`${viewerUrl}/api/cloud/admin/users`);
  expect(r.status).toBe(403);
});

test("/api/cloud/admin/users (operator): POST creates user", async () => {
  const { cloudDb } = await import("../src/cloud/db");
  cloudDb().run("UPDATE users SET is_operator = 1 WHERE id = 'default'");
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code }),
  });

  const r = await fetch(`${viewerUrl}/api/cloud/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "bob", mint_pair_code: true }),
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.user.id).toBe("bob");
  expect(body.pair_code.code).toMatch(/^[0-9]{6}$/);

  // Bearer never made it to page JS — the call had no Authorization header.
  // The viewer process handled the laundering.
});

test("/cloud (paired) renders Cloud stats panel that loads via /api/cloud/stats", async () => {
  const { createPairingCode } = await import("../src/cloud/auth");
  const { code } = createPairingCode();
  await fetch(`${viewerUrl}/api/sync/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ remote: cloudUrl, code }),
  });
  const html = await fetch(`${viewerUrl}/cloud`).then((r) => r.text());
  expect(html).toContain("Cloud stats");
  expect(html).toContain('id="cloud-stats-body"');
  expect(html).toContain("/api/cloud/stats");
});
