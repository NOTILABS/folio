/**
 * Tests for outbound email on share creation. Uses a mock mailer to record
 * what would have been sent — no real network calls. The plaintext-email
 * passthrough behaviour is asserted: hashes persist, plaintext doesn't.
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { closeCloudDb } from "../src/cloud/db";
import { setMailer, type MailMessage, type Mailer, type MailResult, renderShareEmail } from "../src/cloud/mailer";

let tmpDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let baseUrl: string;
let token = "";

class RecordingMailer implements Mailer {
  sent: MailMessage[] = [];
  failNext = false;
  async send(msg: MailMessage): Promise<MailResult> {
    this.sent.push(msg);
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, error: "simulated bounce" };
    }
    return { ok: true, message_id: `mock-${this.sent.length}` };
  }
}

async function pair(): Promise<string> {
  const { legacyPairResponse } = await import("./_cloud-device");
  const res = legacyPairResponse({ name: "test", deviceId: "01HXMAILTEST00000000000000" });
  return ((await res.json()) as { token: string }).token;
}

async function seedNote(uuid = "01HXMAILNOTE001", thread = "mailbox"): Promise<void> {
  await fetch(`${baseUrl}/v1/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      notes: [
        {
          uuid,
          slug: "for-mail",
          thread_id: thread,
          title: "For mail",
          type: "research",
          body_html: "<p>hi</p>",
          created_at: "2026-05-12T09:00:00Z",
        },
      ],
    }),
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-mailer-"));
  process.env.FOLIO_CLOUD_HOME = tmpDir;
  // Clear any env-driven mailer choice; tests use setMailer() explicitly.
  delete process.env.RESEND_API_KEY;
  delete process.env.FOLIO_MAIL_FROM;
  delete process.env.FOLIO_MAIL_DEV;
  setMailer(null);
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0, publicUrl: "https://folio.example.com" })) as any;
  baseUrl = `http://${server!.hostname}:${server!.port}`;
  token = await pair();
});

afterEach(() => {
  setMailer(null);
  try { server?.stop(); } catch {}
  server = null;
  closeCloudDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FOLIO_CLOUD_HOME;
});

test("renderShareEmail: includes URL + expiry + plain-text fallback", () => {
  const out = renderShareEmail({
    url: "https://folio.example.com/p/abc/n/n001",
    recipient: "bob@example.com",
    scope_type: "note",
    expires_at: "2026-06-01T00:00:00Z",
  });
  expect(out.subject).toMatch(/Folio note was shared/i);
  expect(out.text).toContain("https://folio.example.com/p/abc/n/n001");
  expect(out.text).toContain("expires on 2026-06-01");
  expect(out.html).toContain("https://folio.example.com/p/abc/n/n001");
  expect(out.html).toContain("Open note");
});

test("POST /v1/share without recipient_email: no mailer call, email_skipped=no-recipient", async () => {
  const m = new RecordingMailer();
  setMailer(m);
  await seedNote();
  const res = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope_type: "note", scope_id: "01HXMAILNOTE001" }),
  });
  const body = (await res.json()) as any;
  expect(body.email_sent).toBe(false);
  expect(body.email_skipped).toBe("no-recipient");
  expect(m.sent).toHaveLength(0);
});

test("POST /v1/share with recipient_email + mailer: sends email, persists only hash", async () => {
  const m = new RecordingMailer();
  setMailer(m);
  await seedNote();
  const res = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      scope_type: "note",
      scope_id: "01HXMAILNOTE001",
      recipient_email: "bob@example.com",
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.email_sent).toBe(true);
  expect(body.email_skipped).toBeNull();
  expect(m.sent).toHaveLength(1);
  expect(m.sent[0].to).toBe("bob@example.com");
  expect(m.sent[0].html).toContain(body.url);
  expect(m.sent[0].text).toContain(body.url);

  // DB stored only the hash, not the plaintext.
  const { cloudDb } = await import("../src/cloud/db");
  const row = cloudDb()
    .query<{ recipient_email_hash: string | null }, [string]>(
      "SELECT recipient_email_hash FROM shares WHERE token = ?"
    )
    .get(body.token);
  const expected = createHash("sha256").update("bob@example.com", "utf8").digest("hex");
  expect(row?.recipient_email_hash).toBe(expected);

  // Confirm-recipient flow still works with the same plaintext.
  const confirm = await fetch(`${baseUrl}/p/${body.token}/confirm-recipient`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "bob@example.com" }).toString(),
    redirect: "manual",
  });
  expect(confirm.status).toBe(303);
});

test("POST /v1/share with recipient_email but no mailer: still creates share, email_skipped=no-mailer", async () => {
  setMailer(null); // no mailer configured AND no env
  await seedNote();
  const res = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      scope_type: "note",
      scope_id: "01HXMAILNOTE001",
      recipient_email: "bob@example.com",
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.email_sent).toBe(false);
  expect(body.email_skipped).toBe("no-mailer");
  expect(body.mailer_configured).toBe(false);
  // Share itself still created.
  expect(body.token).toBeTruthy();
});

test("POST /v1/share mailer error: share created, email_error reported, mailer_configured=true", async () => {
  const m = new RecordingMailer();
  m.failNext = true;
  setMailer(m);
  await seedNote();
  const res = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      scope_type: "note",
      scope_id: "01HXMAILNOTE001",
      recipient_email: "bob@example.com",
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.email_sent).toBe(false);
  expect(body.email_error).toContain("simulated bounce");
  expect(body.mailer_configured).toBe(true);
});

test("POST /v1/share: recipient_email and explicit hash that disagree are rejected", async () => {
  const m = new RecordingMailer();
  setMailer(m);
  await seedNote();
  const res = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      scope_type: "note",
      scope_id: "01HXMAILNOTE001",
      recipient_email: "bob@example.com",
      recipient_email_hash: createHash("sha256").update("alice@example.com").digest("hex"),
    }),
  });
  expect(res.status).toBe(400);
  expect(m.sent).toHaveLength(0);
});

test("POST /v1/share: both recipient_email and matching hash work (CLI sends both)", async () => {
  const m = new RecordingMailer();
  setMailer(m);
  await seedNote();
  const hash = createHash("sha256").update("bob@example.com").digest("hex");
  const res = await fetch(`${baseUrl}/v1/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      scope_type: "note",
      scope_id: "01HXMAILNOTE001",
      recipient_email: "bob@example.com",
      recipient_email_hash: hash,
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.email_sent).toBe(true);
  expect(m.sent).toHaveLength(1);
});

test("getMailer: env-based selection prefers Resend > FOLIO_MAIL_DEV > none", async () => {
  const { getMailer, setMailer: setM, isMailerConfigured } = await import("../src/cloud/mailer");
  setM(null);
  expect(getMailer()).toBeNull();
  expect(isMailerConfigured()).toBe(false);

  process.env.FOLIO_MAIL_DEV = "1";
  const consoleM = getMailer();
  expect(consoleM).not.toBeNull();
  delete process.env.FOLIO_MAIL_DEV;

  process.env.RESEND_API_KEY = "re_test";
  process.env.FOLIO_MAIL_FROM = "Folio <hi@example.com>";
  const resendM = getMailer();
  expect(resendM).not.toBeNull();
  expect(resendM).not.toBe(consoleM);
  delete process.env.RESEND_API_KEY;
  delete process.env.FOLIO_MAIL_FROM;
});
