/**
 * Playwright fixtures for Folio PWA tests.
 *
 * Each test gets a fresh cloud relay running on an ephemeral port with
 * an isolated FOLIO_CLOUD_HOME directory. Tests use a typed `cloud`
 * fixture that exposes the base URL + a pairDevice helper (a bearer device
 * as paired before sc-24120 — capability pages need an owner to share from).
 *
 * We deliberately don't share state across tests — `fullyParallel: false`
 * + workers=1 in playwright.config.ts because the cloud env vars are
 * process-wide.
 */

import { test as base } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface CloudFixture {
  baseUrl: string;
  /** Pair a synthetic device and return its bearer token + device_id. */
  pairDevice: (name?: string) => Promise<{ token: string; device_id: string }>;
}

type Fixtures = {
  cloud: CloudFixture;
};

export const test = base.extend<Fixtures>({
  cloud: async ({}, use) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "folio-pw-cloud-"));
    process.env.FOLIO_CLOUD_HOME = tmpDir;
    const { startCloudServer } = await import("../../src/cloud/server");
    const server: any = await startCloudServer({ port: 0, publicUrl: "http://127.0.0.1" });

    const baseUrl = `http://${server.hostname}:${server.port}`;
    const { closeCloudDb } = await import("../../src/cloud/db");

    const fixture: CloudFixture = {
      baseUrl,
      async pairDevice(name = "test-device") {
        // sc-24120: no unbound pairing — insert a pre-change bearer device.
        const { legacyBearerDevice } = await import("../_cloud-device");
        const deviceId = "01HXTEST" + Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(18, "X");
        const d = legacyBearerDevice({ name, deviceId });
        return { token: d.token, device_id: d.deviceId };
      },
    };

    await use(fixture);

    try { server.stop(); } catch {}
    closeCloudDb();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.FOLIO_CLOUD_HOME;
  },
});

export { expect } from "@playwright/test";
