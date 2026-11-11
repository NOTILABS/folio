/**
 * `folio doctor` cloud section: reachability + token validity + recency.
 *
 * Unit-tests the cloud probe path against a real Bun.serve cloud, so we
 * don't have to rely on the headless browser suite for this. JSON output
 * makes assertions trivial.
 */

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/core/db";
import { closeCloudDb } from "../src/cloud/db";

let homeDir: string;
let cloudHomeDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;
let cloudUrl: string;

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "folio-doc-home-"));
  cloudHomeDir = mkdtempSync(join(tmpdir(), "folio-doc-cloud-"));
  process.env.FOLIO_HOME = homeDir;
  process.env.FOLIO_CLOUD_HOME = cloudHomeDir;
  const { startCloudServer } = await import("../src/cloud/server");
  server = (await startCloudServer({ port: 0 })) as any;
  cloudUrl = `http://${server!.hostname}:${server!.port}`;
  const { init } = await import("../src/cli/commands/init");
  await init();
});

afterEach(() => {
  try { server?.stop(); } catch {}
  server = null;
  closeDb();
  closeCloudDb();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cloudHomeDir, { recursive: true, force: true });
  delete process.env.FOLIO_HOME;
  delete process.env.FOLIO_CLOUD_HOME;
});

test("doctor unpaired: cloud.paired=false, no reachability probe", async () => {
  // Capture console.log because doctor uses out() → console.log.
  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...a: any[]) => { captured.push(a.map(String).join(" ")); };
  try {
    const { doctorCmd } = await import("../src/cli/commands/doctor");
    await doctorCmd({ jsonOut: true });
  } finally {
    console.log = realLog;
  }
  const body = JSON.parse(captured.join("\n"));
  expect(body.cloud.paired).toBe(false);
});

test("doctor paired + reachable: reports ok on both reachable + token_valid", async () => {
  // Pair via the local viewer's flow.
  const { getOrCreateDeviceId } = await import("../src/core/config");
  const dev = getOrCreateDeviceId();
  const { legacyPairResponse } = await import("./_cloud-device");
  const pairRes = legacyPairResponse({ name: dev.name, deviceId: dev.id });
  const { token } = (await pairRes.json()) as { token: string };
  const { saveSyncState } = await import("../src/core/sync");
  saveSyncState({
    remote: cloudUrl,
    device_token: token,
    last_pulled_seq: 0,
    last_pushed_at: new Date().toISOString(),
    last_live_pushed: {},
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...a: any[]) => { captured.push(a.map(String).join(" ")); };
  try {
    const { doctorCmd } = await import("../src/cli/commands/doctor");
    await doctorCmd({ jsonOut: true });
  } finally {
    console.log = realLog;
  }
  const body = JSON.parse(captured.join("\n"));
  expect(body.cloud.paired).toBe(true);
  expect(body.cloud.remote).toBe(cloudUrl);
  expect(body.cloud.reachable).toBe("ok");
  expect(body.cloud.token_valid).toBe("ok");
  expect(body.cloud.recency).toBe("fresh");
  expect(body.cloud.details?.[0]).toMatch(/1 device paired/);
});

test("doctor paired + cloud down: reachable=fail, token check skipped", async () => {
  // Point sync state at a port that nothing is listening on. More reliable
  // than stop-then-probe because Bun.serve.stop() can leave the listener
  // briefly racy on some kernels.
  const { saveSyncState } = await import("../src/core/sync");
  saveSyncState({
    remote: "http://127.0.0.1:1",
    device_token: "irrelevant-since-cloud-is-dead",
    last_pulled_seq: 0,
    last_pushed_at: null,
    last_live_pushed: {},
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...a: any[]) => { captured.push(a.map(String).join(" ")); };
  try {
    const { doctorCmd } = await import("../src/cli/commands/doctor");
    await doctorCmd({ jsonOut: true });
  } finally {
    console.log = realLog;
  }
  const body = JSON.parse(captured.join("\n"));
  expect(body.cloud.paired).toBe(true);
  expect(body.cloud.reachable).toBe("fail");
  expect(body.cloud.token_valid).toBe("skipped");
  expect(body.cloud.recency).toBe("never");
  expect(body.warnings.some((w: any) => /unreachable/.test(w.message))).toBe(true);
});

test("doctor --offline skips network probes entirely", async () => {
  const { saveSyncState } = await import("../src/core/sync");
  saveSyncState({
    remote: cloudUrl,
    device_token: "fake-token-for-offline-test",
    last_pulled_seq: 0,
    last_pushed_at: null,
    last_live_pushed: {},
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...a: any[]) => { captured.push(a.map(String).join(" ")); };
  try {
    const { doctorCmd } = await import("../src/cli/commands/doctor");
    await doctorCmd({ jsonOut: true, offline: true });
  } finally {
    console.log = realLog;
  }
  const body = JSON.parse(captured.join("\n"));
  expect(body.cloud.paired).toBe(true);
  expect(body.cloud.reachable).toBe("skipped");
  expect(body.cloud.token_valid).toBe("skipped");
});

test("storage section reports folio_home, db, themes, templates", async () => {
  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...a: any[]) => { captured.push(a.map(String).join(" ")); };
  try {
    const { doctorCmd } = await import("../src/cli/commands/doctor");
    await doctorCmd({ jsonOut: true, offline: true });
  } finally {
    console.log = realLog;
  }
  const body = JSON.parse(captured.join("\n"));
  expect(body.storage.folio_home).toBe(homeDir);
  expect(body.storage.folio_home_exists).toBe(true);
  expect(body.storage.db_exists).toBe(true);
  expect(body.storage.bundled_themes.exists).toBe(true);
});

test("stale recency triggers warning when last_pushed_at is old", async () => {
  // Pair so we have a remote to talk to, but state's last_pushed_at is 10d old.
  const { getOrCreateDeviceId } = await import("../src/core/config");
  const dev = getOrCreateDeviceId();
  const { legacyPairResponse } = await import("./_cloud-device");
  const pairRes = legacyPairResponse({ name: dev.name, deviceId: dev.id });
  const { token } = (await pairRes.json()) as { token: string };
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  const { saveSyncState } = await import("../src/core/sync");
  saveSyncState({
    remote: cloudUrl,
    device_token: token,
    last_pulled_seq: 0,
    last_pushed_at: tenDaysAgo,
    last_live_pushed: {},
  });

  const captured: string[] = [];
  const realLog = console.log;
  console.log = (...a: any[]) => { captured.push(a.map(String).join(" ")); };
  try {
    const { doctorCmd } = await import("../src/cli/commands/doctor");
    await doctorCmd({ jsonOut: true });
  } finally {
    console.log = realLog;
  }
  const body = JSON.parse(captured.join("\n"));
  expect(body.cloud.recency).toBe("stale");
  expect(body.warnings.some((w: any) => /Last successful push/.test(w.message))).toBe(true);
});
