import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/core/db";

let tmpDir: string;
let server: { stop: () => void; port: number; hostname: string } | null = null;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "folio-assets-test-"));
  process.env.FOLIO_HOME = tmpDir;
  const { init } = await import("../src/cli/commands/init");
  await init();
  const cfgPath = join(tmpDir, "folio.config.json");
  const parsed = JSON.parse(readFileSync(cfgPath, "utf-8"));
  parsed.viewer_port = 0;
  writeFileSync(cfgPath, JSON.stringify(parsed));
  const { startServer } = await import("../src/viewer/server");
  server = (await startServer()) as any;
});

afterEach(() => {
  try { server?.stop(); } catch {}
  server = null;
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { buildServer } = await import("../src/mcp/server");
  const mcp = await buildServer();
  const any = mcp as any;
  const handler = any._requestHandlers.get("tools/call");
  return await handler({ method: "tools/call", params: { name, arguments: args } });
}

const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63620000000005ffffff03000005fe02fe69ce0afa0000000049454e44ae426082",
  "hex",
);

test("attach_asset writes file, returns url + path + size_bytes (content_base64)", async () => {
  const res = await callTool("attach_asset", {
    thread_id: "test-thread",
    filename: "shot.png",
    content_base64: PNG_1x1.toString("base64"),
  });
  expect(res.isError).toBeFalsy();
  const data = JSON.parse(res.content[0].text);
  expect(data.thread_id).toBe("test-thread");
  expect(data.filename).toBe("shot.png");
  expect(data.path).toContain("threads/test-thread/assets/shot.png");
  expect(existsSync(data.path)).toBe(true);
  expect(data.size_bytes).toBe(PNG_1x1.length);
  // No viewer_public_url → relative path, never a 127.0.0.1 "shareable" URL (sc-6716).
  expect(data.url).toBe("/t/test-thread/asset/shot.png");
  expect(data.local_url).toContain("127.0.0.1");
});

test("attach_asset with source_path reads from disk", async () => {
  const src = join(tmpDir, "src.png");
  writeFileSync(src, PNG_1x1);
  const res = await callTool("attach_asset", {
    thread_id: "from-disk",
    filename: "img.png",
    source_path: src,
  });
  expect(res.isError).toBeFalsy();
  const data = JSON.parse(res.content[0].text);
  expect(data.size_bytes).toBe(PNG_1x1.length);
  expect(readFileSync(data.path)).toEqual(PNG_1x1);
});

test("attach_asset uses viewer_public_url when configured", async () => {
  const { saveConfig, loadConfig } = await import("../src/core/config");
  const cfg = await loadConfig();
  await saveConfig({ ...cfg, viewer_public_url: "https://notes.example.com" });
  const res = await callTool("attach_asset", {
    thread_id: "pub",
    filename: "a.png",
    content_base64: PNG_1x1.toString("base64"),
  });
  const data = JSON.parse(res.content[0].text);
  expect(data.url).toBe("https://notes.example.com/t/pub/asset/a.png");
  expect(data.local_url).toContain("127.0.0.1");
});

test("attach_asset rejects path traversal filename", async () => {
  const res = await callTool("attach_asset", {
    thread_id: "t",
    filename: "../escape.png",
    content_base64: PNG_1x1.toString("base64"),
  });
  expect(res.isError).toBe(true);
});

test("attach_asset rejects filename with slash", async () => {
  const res = await callTool("attach_asset", {
    thread_id: "t",
    filename: "sub/file.png",
    content_base64: PNG_1x1.toString("base64"),
  });
  expect(res.isError).toBe(true);
});

test("attach_asset rejects empty filename", async () => {
  const res = await callTool("attach_asset", {
    thread_id: "t",
    filename: "",
    content_base64: PNG_1x1.toString("base64"),
  });
  expect(res.isError).toBe(true);
});

test("attach_asset rejects filename starting with dot", async () => {
  const res = await callTool("attach_asset", {
    thread_id: "t",
    filename: ".hidden.png",
    content_base64: PNG_1x1.toString("base64"),
  });
  expect(res.isError).toBe(true);
});

test("attach_asset rejects filename with consecutive dots", async () => {
  const res = await callTool("attach_asset", {
    thread_id: "t",
    filename: "foo..png",
    content_base64: PNG_1x1.toString("base64"),
  });
  expect(res.isError).toBe(true);
});

test("attach_asset rejects unsupported extension", async () => {
  const res = await callTool("attach_asset", {
    thread_id: "t",
    filename: "thing.exe",
    content_base64: Buffer.from("MZ").toString("base64"),
  });
  expect(res.isError).toBe(true);
});

test("attach_asset rejects when both content_base64 and source_path provided", async () => {
  const src = join(tmpDir, "x.png");
  writeFileSync(src, PNG_1x1);
  const res = await callTool("attach_asset", {
    thread_id: "t",
    filename: "x.png",
    content_base64: PNG_1x1.toString("base64"),
    source_path: src,
  });
  expect(res.isError).toBe(true);
});

test("attach_asset rejects when neither content_base64 nor source_path provided", async () => {
  const res = await callTool("attach_asset", {
    thread_id: "t",
    filename: "x.png",
  });
  expect(res.isError).toBe(true);
});

test("attach_asset overwrites on same filename (append-only files, idempotent uploads)", async () => {
  const first = await callTool("attach_asset", {
    thread_id: "t",
    filename: "x.png",
    content_base64: PNG_1x1.toString("base64"),
  });
  expect(first.isError).toBeFalsy();
  const bigger = Buffer.concat([PNG_1x1, Buffer.from("padding")]);
  const second = await callTool("attach_asset", {
    thread_id: "t",
    filename: "x.png",
    content_base64: bigger.toString("base64"),
  });
  expect(second.isError).toBeFalsy();
  const data = JSON.parse(second.content[0].text);
  expect(data.size_bytes).toBe(bigger.length);
});

test("GET /t/:id/asset/:file serves the file with correct MIME and Cache-Control", async () => {
  await callTool("attach_asset", {
    thread_id: "served",
    filename: "a.png",
    content_base64: PNG_1x1.toString("base64"),
  });
  const res = await fetch(`http://${server!.hostname}:${server!.port}/t/served/asset/a.png`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("cache-control")).toContain("max-age=86400");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const buf = new Uint8Array(await res.arrayBuffer());
  expect(buf.length).toBe(PNG_1x1.length);
});

test("GET /t/:id/asset/:file with disallowed extension returns 415", async () => {
  const res = await fetch(`http://${server!.hostname}:${server!.port}/t/x/asset/file.exe`);
  expect(res.status).toBe(415);
});

test("GET /t/:id/asset/:file with traversal filename returns 400", async () => {
  // URL-encoded ../ — viewer must validate after decode.
  const res = await fetch(`http://${server!.hostname}:${server!.port}/t/x/asset/${encodeURIComponent("../etc.png")}`);
  expect(res.status).toBe(400);
});

test("GET /t/:id/asset/:file with missing file returns 404", async () => {
  const res = await fetch(`http://${server!.hostname}:${server!.port}/t/nothere/asset/missing.png`);
  expect(res.status).toBe(404);
});

test("GET /t/:id/asset/:file MIME maps for each whitelisted extension", async () => {
  const mimes: Record<string, string> = {
    "a.jpg": "image/jpeg",
    "a.jpeg": "image/jpeg",
    "a.png": "image/png",
    "a.webp": "image/webp",
    "a.gif": "image/gif",
    "a.svg": "image/svg+xml",
    "a.pdf": "application/pdf",
    "a.mp4": "video/mp4",
  };
  for (const [fname, expectedMime] of Object.entries(mimes)) {
    await callTool("attach_asset", {
      thread_id: "mimes",
      filename: fname,
      content_base64: PNG_1x1.toString("base64"),
    });
    const res = await fetch(`http://${server!.hostname}:${server!.port}/t/mimes/asset/${fname}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(expectedMime);
  }
});
