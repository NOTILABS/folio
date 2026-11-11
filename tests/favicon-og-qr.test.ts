/**
 * Favicon (local viewer), OG image + QR code (cloud capability URLs).
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeCloudDb } from "../src/cloud/db";
import { closeDb } from "../src/core/db";

let tmpDir: string;
let cloudHome: string;
let cloud: { stop: () => void; port: number; hostname: string } | null = null;
let viewer: { stop: () => void; port: number; hostname: string } | null = null;
let cloudUrl = "";
let viewerUrl = "";

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-favog-home-"));
  cloudHome = mkdtempSync(join(tmpdir(), "folio-favog-cloud-"));
  process.env.FOLIO_HOME = tmpDir;
  process.env.FOLIO_CLOUD_HOME = cloudHome;
});

afterEach(() => {
  try { cloud?.stop(); } catch {}
  try { viewer?.stop(); } catch {}
  cloud = null; viewer = null;
  closeCloudDb();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(cloudHome, { recursive: true, force: true });
  delete process.env.FOLIO_HOME;
  delete process.env.FOLIO_CLOUD_HOME;
});

test("local viewer /favicon.svg + /favicon.ico both serve the brand SVG", async () => {
  const { init } = await import("../src/cli/commands/init");
  await init();
  const { writeFileSync, readFileSync } = await import("node:fs");
  const cfgPath = join(tmpDir, "folio.config.json");
  const parsed = JSON.parse(readFileSync(cfgPath, "utf-8"));
  parsed.viewer_port = 0;
  writeFileSync(cfgPath, JSON.stringify(parsed));
  const { startServer } = await import("../src/viewer/server");
  viewer = (await startServer()) as any;
  viewerUrl = `http://${viewer!.hostname}:${viewer!.port}`;

  for (const p of ["/favicon.svg", "/favicon.ico"]) {
    const r = await fetch(`${viewerUrl}${p}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("svg+xml");
    const body = await r.text();
    expect(body).toContain("<svg");
    expect(body).toContain("#ff5a1f"); // brand orange dot
    expect(body).toContain(">f<");      // the "f" glyph
    expect(body).toContain(">.<");      // the orange period
  }
});

test("local viewer shell HTML includes <link rel=icon> pointing at /favicon.svg", async () => {
  const { init } = await import("../src/cli/commands/init");
  await init();
  const { writeFileSync, readFileSync } = await import("node:fs");
  const cfgPath = join(tmpDir, "folio.config.json");
  const parsed = JSON.parse(readFileSync(cfgPath, "utf-8"));
  parsed.viewer_port = 0;
  writeFileSync(cfgPath, JSON.stringify(parsed));
  const { startServer } = await import("../src/viewer/server");
  viewer = (await startServer()) as any;
  viewerUrl = `http://${viewer!.hostname}:${viewer!.port}`;

  const html = await fetch(`${viewerUrl}/`).then((r) => r.text());
  expect(html).toContain('rel="icon"');
  expect(html).toContain('href="/favicon.svg"');
  expect(html).toContain('type="image/svg+xml"');
});

async function makeShareForOgQr() {
  const { startCloudServer } = await import("../src/cloud/server");
  cloud = (await startCloudServer({ port: 0, publicUrl: "https://folio.example.com" })) as any;
  cloudUrl = `http://${cloud!.hostname}:${cloud!.port}`;
  const { legacyPairResponse } = await import("./_cloud-device");
  const pairRes = legacyPairResponse({ name: "test", deviceId: "01HX-OG-TEST-DEV-00X" });
  const { token } = (await pairRes.json()) as { token: string };

  await fetch(`${cloudUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      notes: [{
        uuid: "01HXOGNOTE0001",
        slug: "og-test",
        thread_id: "demo-thread",
        title: "An open-graph test note with a moderately long title",
        type: "research",
        theme: "linen",
        body_html: "<p>hello og</p>",
        created_at: "2026-05-15T10:00:00Z",
      }],
    }),
  });

  const shareRes = await fetch(`${cloudUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: "01HXOGNOTE0001" }),
  });
  const share = (await shareRes.json()) as { token: string; url: string };
  return share;
}

test("/p/<token>/og.svg returns an SVG with the note title + brand", async () => {
  const share = await makeShareForOgQr();
  const r = await fetch(`${cloudUrl}/p/${share.token}/og.svg`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("svg+xml");
  const svg = await r.text();
  expect(svg).toContain("<svg");
  expect(svg).toContain('viewBox="0 0 1200 630"');
  // Title surfaces (may be word-wrapped but the words must appear).
  expect(svg).toContain("open-graph test");
  // Scope chip + brand wordmark present.
  expect(svg.toLowerCase()).toContain("note");
  expect(svg).toContain(">folio<");
  expect(svg).toContain("#ff5a1f"); // accent dot in wordmark
});

test("/p/<token>/og.svg honors theme accent — terminal theme produces different stripe", async () => {
  await makeShareForOgQr();
  // Push a second note in terminal theme + make a share over it.
  const { legacyPairResponse } = await import("./_cloud-device");
  const pairRes = legacyPairResponse({ name: "t2", deviceId: "01HX-OG-TEST-DEV-22X" });
  const { token } = (await pairRes.json()) as { token: string };
  await fetch(`${cloudUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      notes: [{
        uuid: "01HXOGNOTE0002",
        slug: "og-term",
        thread_id: "terminal-stuff",
        title: "Terminal theme note",
        type: "technical",
        theme: "terminal",
        body_html: "<p>x</p>",
        created_at: "2026-05-15T10:05:00Z",
      }],
    }),
  });
  const shareRes = await fetch(`${cloudUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: "01HXOGNOTE0002" }),
  });
  const share = (await shareRes.json()) as { token: string };
  const svg = await (await fetch(`${cloudUrl}/p/${share.token}/og.svg`)).text();
  expect(svg).toContain("#22c55e"); // terminal theme green stripe
});

test("/p/<token>/og.svg 410 for expired share", async () => {
  const share = await makeShareForOgQr();
  // Expire it via direct DB poke.
  const { cloudDb } = await import("../src/cloud/db");
  cloudDb().run("UPDATE shares SET expires_at = '2020-01-01T00:00:00Z' WHERE token = ?", [share.token]);
  const r = await fetch(`${cloudUrl}/p/${share.token}/og.svg`);
  expect(r.status).toBe(410);
});

test("/p/<token>/qr.svg returns an SVG QR encoding the share URL", async () => {
  const share = await makeShareForOgQr();
  const r = await fetch(`${cloudUrl}/p/${share.token}/qr.svg`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("svg+xml");
  const svg = await r.text();
  expect(svg).toContain("<svg");
  // qrcode library outputs <path> with "M..." instructions for the dark modules.
  expect(svg).toContain("<path");
});

test("/p/<token>/qr.svg 410 for expired share", async () => {
  const share = await makeShareForOgQr();
  const { cloudDb } = await import("../src/cloud/db");
  cloudDb().run("UPDATE shares SET expires_at = '2020-01-01T00:00:00Z' WHERE token = ?", [share.token]);
  const r = await fetch(`${cloudUrl}/p/${share.token}/qr.svg`);
  expect(r.status).toBe(410);
});

test("renderSharedNotePage includes og:image / twitter:card meta", async () => {
  const share = await makeShareForOgQr();
  const html = await (await fetch(`${cloudUrl}/p/${share.token}/n/01HXOGNOTE0001`)).text();
  expect(html).toContain('property="og:title"');
  expect(html).toContain('property="og:image"');
  expect(html).toContain('property="og:type"');
  expect(html).toContain('property="og:url"');
  expect(html).toContain('name="twitter:card"');
  expect(html).toContain('content="summary_large_image"');
  expect(html).toContain(`/p/${share.token}/og.png`); // og:image is the PNG, not SVG
  expect(html).toContain('content="image/png"');
  expect(html).toContain("An open-graph test note");
});

test("renderSharedThreadPage includes og + twitter meta", async () => {
  const share = await makeShareForOgQr();
  // Re-create as thread-scoped share for this test.
  const { legacyPairResponse } = await import("./_cloud-device");
  const pairRes = legacyPairResponse({ name: "t3", deviceId: "01HX-OG-TEST-DEV-33X" });
  const { token } = (await pairRes.json()) as { token: string };
  const threadShareRes = await fetch(`${cloudUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "thread", scope_id: "demo-thread" }),
  });
  const threadShare = (await threadShareRes.json()) as { token: string };

  const html = await (await fetch(`${cloudUrl}/p/${threadShare.token}/t/demo-thread`)).text();
  expect(html).toContain('property="og:title"');
  expect(html).toContain("Thread:");
  expect(html).toContain(`/p/${threadShare.token}/og.png`);
});

test("/p/<token>/og.png returns a rasterized PNG (image/png + PNG magic bytes)", async () => {
  const share = await makeShareForOgQr();
  const r = await fetch(`${cloudUrl}/p/${share.token}/og.png`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/png");
  const buf = new Uint8Array(await r.arrayBuffer());
  expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]); // ‰PNG
  // A card with rendered title text is far larger than the empty-canvas (~5KB)
  // case — this guards against a regression where the font fails to load.
  expect(buf.length).toBeGreaterThan(8000);
});

test("/p/<token>/og.png 410 for expired share", async () => {
  const share = await makeShareForOgQr();
  const { cloudDb } = await import("../src/cloud/db");
  cloudDb().run("UPDATE shares SET expires_at = '2020-01-01T00:00:00Z' WHERE token = ?", [share.token]);
  const r = await fetch(`${cloudUrl}/p/${share.token}/og.png`);
  expect(r.status).toBe(410);
});

test("generateOgPng rasterizes the card with text (PNG magic + non-trivial size)", async () => {
  const { generateOgPng } = await import("../src/cloud/og");
  const png = await generateOgPng({
    title: "Rośliny doniczkowe — pielęgnacja i podlewanie",
    theme: "linen",
    scope_type: "note",
    thread_id: "rosliny",
  });
  expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(png.length).toBeGreaterThan(8000); // text rendered, not a blank canvas
});
