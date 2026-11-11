import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { closeCloudDb } from "../src/cloud/db";

let tmpDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let baseUrl: string;
let token: string;
let publicBase: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-cloud-shares-"));
  process.env.FOLIO_CLOUD_HOME = tmpDir;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0, publicUrl: "https://share.example.com" })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;
  publicBase = "https://share.example.com";

  const { legacyPairResponse } = await import("./_cloud-device");
  const pairRes = legacyPairResponse({ name: "publisher", deviceId: "01HXPUBDEVICE000000000XXXX" });
  token = ((await pairRes.json()) as { token: string }).token;

  // Seed two notes in two threads so scope tests have material.
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      notes: [
        {
          uuid: "01HXNOTE001",
          slug: "alpha",
          thread_id: "alpha-thread",
          title: "Alpha",
          type: "research",
          body_html: "<h1>Alpha</h1>",
          created_at: "2026-05-13T10:00:00Z",
        },
        {
          uuid: "01HXNOTE002",
          slug: "beta",
          thread_id: "alpha-thread",
          title: "Beta",
          type: "snippet",
          body_html: "<h1>Beta</h1>",
          created_at: "2026-05-13T10:05:00Z",
        },
        {
          uuid: "01HXNOTE003",
          slug: "gamma",
          thread_id: "other-thread",
          title: "Gamma",
          type: "snippet",
          body_html: "<h1>Gamma</h1>",
          created_at: "2026-05-13T10:10:00Z",
        },
      ],
    }),
  });
});

afterEach(() => {
  try { server?.stop(); } catch {}
  server = null;
  closeCloudDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_CLOUD_HOME;
});

async function createShare(body: Record<string, unknown>): Promise<{
  token: string;
  url: string;
  expires_at: string | null;
  max_views: number | null;
}> {
  const res = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json() as any;
}

test("POST /v1/share creates a note-scoped share", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001", expires_in_days: 7 });
  expect(s.token.length).toBeGreaterThan(20);
  expect(s.url).toBe(`${publicBase}/p/${s.token}/n/01HXNOTE001`);
  expect(s.expires_at).toBeTruthy();
  expect(new Date(s.expires_at!).getTime()).toBeGreaterThan(Date.now());
});

test("POST /v1/share rejects unknown note id", async () => {
  const res = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: "01HXNONEXISTENT" }),
  });
  expect(res.status).toBe(400);
});

test("POST /v1/share creates a thread-scoped share", async () => {
  const s = await createShare({ scope_type: "thread", scope_id: "alpha-thread", expires_in_days: 7 });
  expect(s.url).toBe(`${publicBase}/p/${s.token}/t/alpha-thread`);
});

test("/p/<token>/n/<uuid> renders note publicly (no auth header)", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  const r = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`);
  expect(r.status).toBe(200);
  expect(r.headers.get("x-robots-tag")).toContain("noindex");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  const body = await r.text();
  expect(body).toContain(`src="/p/${s.token}/raw/01HXNOTE001"`);
  expect(body).not.toContain("allow-same-origin");
});

test("/p/<token>/raw/<uuid> renders body with locked CSP", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  const r = await fetch(`${baseUrl}/p/${s.token}/raw/01HXNOTE001`);
  expect(r.status).toBe(200);
  const csp = r.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("connect-src 'none'");
  expect(r.headers.get("x-robots-tag")).toContain("noindex");
  const body = await r.text();
  expect(body).toContain("<h1>Alpha</h1>");
});

test("/p/<token>/n/<other-uuid> rejected (scope mismatch)", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  const r = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE002`);
  expect(r.status).toBe(404);
});

test("thread-scoped token grants access to any note in that thread, not others", async () => {
  const s = await createShare({ scope_type: "thread", scope_id: "alpha-thread" });
  // Notes within thread: OK
  const inThread = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE002`);
  expect(inThread.status).toBe(200);
  // Note in different thread: rejected
  const outOfThread = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE003`);
  expect(outOfThread.status).toBe(404);
  // Thread index itself: OK
  const threadView = await fetch(`${baseUrl}/p/${s.token}/t/alpha-thread`);
  expect(threadView.status).toBe(200);
  const body = await threadView.text();
  expect(body).toContain("Alpha");
  expect(body).toContain("Beta");
  expect(body).not.toContain("Gamma");
  // Other thread: rejected
  const otherThread = await fetch(`${baseUrl}/p/${s.token}/t/other-thread`);
  expect(otherThread.status).toBe(404);
});

test("revoke immediately invalidates the share", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  const before = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`);
  expect(before.status).toBe(200);

  const del = await fetch(`${baseUrl}/v1/share/${s.token}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(del.status).toBe(200);
  expect(((await del.json()) as { revoked: string | null }).revoked).toBe(s.token);

  const after = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`);
  expect(after.status).toBe(404);
});

test("expired share returns 410 Gone", async () => {
  // Direct DB poke to backdate expires_at — simulates a real expiry.
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001", expires_in_days: 1 });
  const { cloudDb } = await import("../src/cloud/db");
  cloudDb().run("UPDATE shares SET expires_at = ? WHERE token = ?", ["2000-01-01T00:00:00Z", s.token]);
  const r = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`);
  expect(r.status).toBe(410);
});

test("max_views caps total accesses", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001", max_views: 2 });
  expect((await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`)).status).toBe(200);
  expect((await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`)).status).toBe(200);
  // Third hit blocked.
  expect((await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`)).status).toBe(404);
});

test("/v1/shares lists active shares for the device", async () => {
  await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  await createShare({ scope_type: "thread", scope_id: "alpha-thread" });
  const r = await fetch(`${baseUrl}/v1/shares`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await r.json()) as { shares: { scope_id: string; scope_type: string }[] };
  expect(body.shares).toHaveLength(2);
  const sids = body.shares.map((s) => s.scope_id).sort();
  expect(sids).toEqual(["01HXNOTE001", "alpha-thread"]);
});

test("/v1/shares filters by scope_id", async () => {
  await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  await createShare({ scope_type: "note", scope_id: "01HXNOTE002" });
  const r = await fetch(`${baseUrl}/v1/shares?scope_id=01HXNOTE001`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await r.json()) as { shares: { scope_id: string }[] };
  expect(body.shares).toHaveLength(1);
  expect(body.shares[0]!.scope_id).toBe("01HXNOTE001");
});

test("invalid token format returns 404 (no info leak)", async () => {
  expect((await fetch(`${baseUrl}/p/short/n/01HXNOTE001`)).status).toBe(404);
  expect((await fetch(`${baseUrl}/p/${"x".repeat(43)}/n/01HXNOTE001`)).status).toBe(404);
});

test("non-GET on capability route returns 405", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  const r = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`, { method: "POST" });
  expect(r.status).toBe(405);
});

test("recipient-bound share: gated by email confirmation form, cookie unlocks", async () => {
  const { createHash } = await import("node:crypto");
  const emailHash = createHash("sha256").update("bob@example.com", "utf8").digest("hex");

  const s = await createShare({
    scope_type: "note",
    scope_id: "01HXNOTE001",
    recipient_email_hash: emailHash,
  });

  // First visit (no cookie) → email-confirmation form.
  const r1 = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`);
  expect(r1.status).toBe(200);
  const body1 = await r1.text();
  expect(body1).toContain("Recipient email");
  expect(body1).toContain(`/p/${s.token}/confirm-recipient`);
  // Note content NOT leaked.
  expect(body1).not.toContain("<h1>Alpha</h1>");

  // Wrong email → still shows the form, with an error, no cookie.
  const wrong = await fetch(`${baseUrl}/p/${s.token}/confirm-recipient`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=eve@example.com",
  });
  expect(wrong.status).toBe(200);
  expect(wrong.headers.get("set-cookie")).toBeNull();
  expect(await wrong.text()).toContain("doesn't match");

  // Correct email → 303 redirect + Set-Cookie scoped to /p/<token>/.
  const ok = await fetch(`${baseUrl}/p/${s.token}/confirm-recipient`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=bob@example.com",
    redirect: "manual",
  });
  expect(ok.status).toBe(303);
  expect(ok.headers.get("location")).toBe(`/p/${s.token}/n/01HXNOTE001`);
  const setCookie = ok.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain(`folio_share_${s.token}=1`);
  expect(setCookie).toContain(`Path=/p/${s.token}/`);
  expect(setCookie).toContain("HttpOnly");

  // Subsequent GET with the cookie → content renders.
  const r2 = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`, {
    headers: { cookie: `folio_share_${s.token}=1` },
  });
  expect(r2.status).toBe(200);
  const body2 = await r2.text();
  expect(body2).not.toContain("Recipient email");
  expect(body2).toContain(`src="/p/${s.token}/raw/01HXNOTE001"`);
});

test("recipient-bound: case-insensitive email match (Bob@EXAMPLE.COM == bob@example.com)", async () => {
  const { createHash } = await import("node:crypto");
  // Hash is computed from the lowercased form on the publish side.
  const emailHash = createHash("sha256").update("bob@example.com", "utf8").digest("hex");
  const s = await createShare({
    scope_type: "note",
    scope_id: "01HXNOTE001",
    recipient_email_hash: emailHash,
  });
  const ok = await fetch(`${baseUrl}/p/${s.token}/confirm-recipient`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=Bob%40EXAMPLE.COM",
    redirect: "manual",
  });
  expect(ok.status).toBe(303);
});

test("recipient-bound: confirm-recipient route 404s if share isn't recipient-bound", async () => {
  // Vanilla share (no recipient_email_hash) — POST should 404.
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  const r = await fetch(`${baseUrl}/p/${s.token}/confirm-recipient`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=anyone@example.com",
  });
  expect(r.status).toBe(404);
});

test("vanilla share (no recipient): no confirmation form, content renders directly", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  const r = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`);
  expect(r.status).toBe(200);
  const body = await r.text();
  expect(body).not.toContain("Recipient email");
  expect(body).toContain(`src="/p/${s.token}/raw/01HXNOTE001"`);
});

test("creating share without auth is rejected", async () => {
  const r = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: "01HXNOTE001" }),
  });
  expect(r.status).toBe(401);
});

// ─── v0.34: recipient variant picks (allow_pick) ──────────────────────────

async function pick(token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/p/${token}/pick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function listSharesFor(scopeId: string): Promise<any[]> {
  const r = await fetch(`${baseUrl}/v1/shares?scope_id=${encodeURIComponent(scopeId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return ((await r.json()) as { shares: any[] }).shares;
}

test("allow_pick share injects the pick affordance into /raw; plain share does not", async () => {
  const pickable = await createShare({ scope_type: "note", scope_id: "01HXNOTE001", allow_pick: true });
  expect((pickable as any).allow_pick).toBe(true);
  const r1 = await fetch(`${baseUrl}/p/${pickable.token}/raw/01HXNOTE001`);
  const html1 = await r1.text();
  expect(html1).toContain("folio-pick-btn");

  const plain = await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  const r2 = await fetch(`${baseUrl}/p/${plain.token}/raw/01HXNOTE001`);
  const html2 = await r2.text();
  expect(html2).not.toContain("folio-pick-btn");
});

test("data-folio-pick markers in the body survive to the shared /raw view", async () => {
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      notes: [
        {
          uuid: "01HXNOTE100",
          slug: "variants",
          thread_id: "alpha-thread",
          title: "Variants",
          type: "comparison",
          body_html:
            '<div class="card" data-folio-pick="A" data-folio-pick-label="Kierunek A"><h3>A</h3></div>' +
            '<div class="card" data-folio-pick="B"><h3>B</h3></div>',
          created_at: "2026-05-13T11:00:00Z",
        },
      ],
    }),
  });
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE100", allow_pick: true });
  const r = await fetch(`${baseUrl}/p/${s.token}/raw/01HXNOTE100`);
  const html = await r.text();
  expect(html).toContain('data-folio-pick="A"');
  expect(html).toContain('data-folio-pick-label="Kierunek A"');
  expect(html).toContain("folio-pick-btn");
});

test("parent /n page wires the share-pick POST listener", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001", allow_pick: true });
  const r = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`);
  const html = await r.text();
  expect(html).toContain("share-pick");
  expect(html).toContain("/pick");
});

test("POST /p/:token/pick records a preference (last-pick-wins) and owner sees it", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001", allow_pick: true });

  const r1 = await pick(s.token, { note_uuid: "01HXNOTE001", variant: "A", label: "Kierunek A" });
  expect(r1.status).toBe(200);
  expect(((await r1.json()) as any).variant).toBe("A");

  // change of mind → last write wins, pick_count increments
  const r2 = await pick(s.token, { note_uuid: "01HXNOTE001", variant: "B", label: "Kierunek B" });
  expect(r2.status).toBe(200);

  const shares = await listSharesFor("01HXNOTE001");
  const mine = shares.find((x) => x.token === s.token);
  expect(mine.allow_pick).toBe(true);
  expect(mine.picks.length).toBe(1);
  expect(mine.picks[0].variant).toBe("B");
  expect(mine.picks[0].label).toBe("Kierunek B");
  expect(mine.picks[0].pick_count).toBe(2);
  expect(mine.picks[0].note_uuid).toBe("01HXNOTE001");
});

test("POST /p/:token/pick is rejected when the share has no allow_pick (404)", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001" });
  const r = await pick(s.token, { note_uuid: "01HXNOTE001", variant: "A" });
  expect(r.status).toBe(404);
});

test("POST /p/:token/pick rejects an out-of-scope note (403, nothing recorded)", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001", allow_pick: true });
  // NOTE003 exists + same user, but lives in another thread → out of a
  // note-scoped share's scope.
  const r = await pick(s.token, { note_uuid: "01HXNOTE003", variant: "A" });
  expect(r.status).toBe(403);
  const shares = await listSharesFor("01HXNOTE001");
  const mine = shares.find((x) => x.token === s.token);
  expect(mine.picks.length).toBe(0);
});

test("POST /p/:token/pick requires a variant (400)", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001", allow_pick: true });
  const r = await pick(s.token, { note_uuid: "01HXNOTE001" });
  expect(r.status).toBe(400);
});

test("thread-scoped allow_pick share accepts a pick on a member note", async () => {
  const s = await createShare({ scope_type: "thread", scope_id: "alpha-thread", allow_pick: true });
  const r = await pick(s.token, { note_uuid: "01HXNOTE002", variant: "X", label: "Wariant X" });
  expect(r.status).toBe(200);
  const shares = await listSharesFor("alpha-thread");
  const mine = shares.find((x) => x.token === s.token);
  expect(mine.picks.length).toBe(1);
  expect(mine.picks[0].note_uuid).toBe("01HXNOTE002");
  expect(mine.picks[0].variant).toBe("X");
});

test("POST /p/:token/pick on a revoked share is rejected", async () => {
  const s = await createShare({ scope_type: "note", scope_id: "01HXNOTE001", allow_pick: true });
  const del = await fetch(`${baseUrl}/v1/share/${s.token}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(del.ok).toBe(true);
  const r = await pick(s.token, { note_uuid: "01HXNOTE001", variant: "A" });
  expect(r.status).toBe(404);
});

// ─── 'set' scope path routing (regression: set must land on /n/, not /t/) ──

test("set-scoped recipient share: email confirm redirects to /n/, not /t/", async () => {
  // Regression: the confirm-recipient redirect (and qr/list URLs) used
  // `scope_type === "note" ? "n" : "t"`, sending 'set' shares to /t/<note-uuid>
  // → validateShareAccess rejects a note uuid as a thread → "not found".
  const emailHash = createHash("sha256").update("client@example.com", "utf8").digest("hex");
  const s = await createShare({ scope_type: "set", scope_id: "01HXNOTE001", recipient_email_hash: emailHash });
  const res = await fetch(`${baseUrl}/p/${s.token}/confirm-recipient`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "client@example.com" }),
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`/p/${s.token}/n/01HXNOTE001`);
});

test("set-scoped share is listed with an /n/ url (not /t/)", async () => {
  const s = await createShare({ scope_type: "set", scope_id: "01HXNOTE001" });
  const shares = await listSharesFor("01HXNOTE001");
  const mine = shares.find((x) => x.token === s.token);
  expect(mine.url).toBe(`${publicBase}/p/${s.token}/n/01HXNOTE001`);
});

test("set-scoped note renders publicly via /n/ (the corrected landing path)", async () => {
  const s = await createShare({ scope_type: "set", scope_id: "01HXNOTE001" });
  const r = await fetch(`${baseUrl}/p/${s.token}/n/01HXNOTE001`);
  expect(r.status).toBe(200);
  // And /t/<note-uuid> is NOT a valid landing for a set share.
  const bad = await fetch(`${baseUrl}/p/${s.token}/t/01HXNOTE001`);
  expect(bad.status).not.toBe(200);
});

test("set-scoped share serves an asset from a linked note in another thread", async () => {
  // Regression: the asset validScope only checked the ROOT note's thread, so a
  // set share's image living in a LINKED note's (different) thread 404'd even
  // though the share grants that note. The note renders; only the image breaks
  // — exactly the reported symptom.
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const up = await fetch(`${baseUrl}/v1/sync/assets/${hash}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-folio-filename": "pic.png",
      "x-folio-thread-id": "img-thread",
    },
    body: bytes,
  });
  expect(up.ok).toBe(true);

  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      notes: [
        { uuid: "01HXLINKED01", slug: "linked", thread_id: "img-thread", title: "Linked", type: "research", body_html: '<img src="/t/img-thread/asset/pic.png" alt="hero">', created_at: "2026-05-13T12:00:00Z" },
        { uuid: "01HXROOT01", slug: "root", thread_id: "root-thread", title: "Root", type: "research", body_html: '<p>see <a href="/n/01HXLINKED01">linked</a></p>', created_at: "2026-05-13T12:01:00Z" },
      ],
    }),
  });

  const s = await createShare({ scope_type: "set", scope_id: "01HXROOT01" });
  // The set grants the linked note…
  expect((await fetch(`${baseUrl}/p/${s.token}/raw/01HXLINKED01`)).status).toBe(200);
  // …so its image (thread img-thread, ≠ root thread) must be reachable too.
  const asset = await fetch(`${baseUrl}/p/${s.token}/t/img-thread/asset/pic.png`);
  expect(asset.status).toBe(200);
  expect(new Uint8Array(await asset.arrayBuffer())).toEqual(bytes);
});
