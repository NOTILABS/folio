// Internal cross-note links must (a) break out of the sandboxed body iframe
// instead of loading the whole viewer inside the note ("Folio-in-Folio"), and
// (b) resolve against the current scope so they survive publish. The body
// iframe relays a {ns:'folio', type:'navigate', href} message; each parent
// shell navigates the TOP window. These tests assert the relay + each shell's
// handler are present (string-level — the runtime behaviour needs a browser).

import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/core/db";
import { NOTE_BOOTSTRAP } from "../src/viewer/note-bootstrap";
import { renderStandaloneNote, renderSharedNotePage, renderNotePage } from "../src/cloud/render";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "folio-links-")); process.env.FOLIO_HOME = tmp; });
afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }); delete process.env.FOLIO_HOME; });

test("note-bootstrap relays internal-link clicks as a navigate message", () => {
  expect(NOTE_BOOTSTRAP).toContain("type: 'navigate'");
  expect(NOTE_BOOTSTRAP).toContain("(n|p|t|tag|threads)");
  // Same-host full URLs are normalised to their path (so a baked-in absolute
  // URL to this viewer host still breaks out instead of opening a dead tab).
  expect(NOTE_BOOTSTRAP).toContain("new URL(href)");
});

test("local viewer parent navigates the top window on a navigate message", async () => {
  const { init } = await import("../src/cli/commands/init");
  await init();
  const { createNote, getNoteMeta } = await import("../src/core/storage");
  const { pageNote } = await import("../src/viewer/render");
  const n = await createNote({ type: "snippet", title: "x", body_html: "<p>x</p>", thread_id: "t", theme: "linen" });
  const html = pageNote(getNoteMeta(n.id)!, "linen");
  expect(html).toContain("case 'navigate'");
  expect(html).toContain("window.location.assign");
});

test("cloud /raw body injects the link interceptor", () => {
  const html = renderStandaloneNote({ theme: "linen", title: "x", bodyHtml: "<p>x</p>" } as any);
  expect(html).toContain("type: 'navigate'");
  expect(html).toContain("(n|p|t|tag|threads)");
});

test("cloud capability page prefixes the token so links stay in-scope", () => {
  const html = renderSharedNotePage("TOK123", "uuid1", "Title");
  expect(html).toContain("'navigate'");
  expect(html).toContain("SCOPE + href");
  expect(html).toContain('"TOK123"');
});

test("cloud PWA shell navigates root-relative on a navigate message", () => {
  const html = renderNotePage("uuid1", "Title");
  expect(html).toContain("'navigate'");
  expect(html).toContain("window.location.assign(href)");
});

// Behavioural: run the capability page's relay script against a stub window
// and check where a navigate message actually sends the top window.
function relayTargets(token: string, hrefs: string[]): (string | null)[] {
  const html = renderSharedNotePage(token, "uuid1", "Title");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  let handler: ((e: any) => void) | null = null;
  let assigned: string | null = null;
  const win = {
    addEventListener: (type: string, fn: (e: any) => void) => { if (type === "message") handler = fn; },
    location: { assign: (u: string) => { assigned = u; } },
  };
  new Function("window", "fetch", script)(win, () => Promise.resolve());
  return hrefs.map((href) => {
    assigned = null;
    handler!({ data: { ns: "folio", type: "navigate", href } });
    return assigned;
  });
}

test("relay prefixes the token for bare internal links", () => {
  expect(relayTargets("TOK123", ["/n/abc", "/t/thr", "/t/thr/asset/a.pdf?dl=1"])).toEqual([
    "/p/TOK123/n/abc",
    "/p/TOK123/t/thr",
    "/p/TOK123/t/thr/asset/a.pdf?dl=1",
  ]);
});

test("relay does not double-prefix links the /raw route already scoped (asset downloads)", () => {
  expect(relayTargets("TOK123", ["/p/TOK123/t/thr/asset/plan.pdf", "/p/TOK123/n/abc"])).toEqual([
    "/p/TOK123/t/thr/asset/plan.pdf",
    "/p/TOK123/n/abc",
  ]);
});

test("relay still scopes /p/ links that belong to another token", () => {
  expect(relayTargets("TOK123", ["/p/OTHER/n/abc", "/p/TOK1234/n/abc"])).toEqual([
    "/p/TOK123/p/OTHER/n/abc",
    "/p/TOK123/p/TOK1234/n/abc",
  ]);
});

test("relay ignores external and non-folio links", () => {
  expect(relayTargets("TOK123", ["https://example.com", "//evil.example/n/x", "/admin"])).toEqual([null, null, null]);
});

// Behavioural: run the /raw body's click interceptor against a stub document.
function clickRaw(href: string, attrs: Record<string, string> = {}) {
  const html = renderStandaloneNote({ theme: "linen", title: "x", bodyHtml: "<p>x</p>" } as any);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const script = scripts.find((s) => s.includes("closest('a[href]')"))!;
  let handler: ((e: any) => void) | null = null;
  const doc = { addEventListener: (type: string, fn: (e: any) => void) => { if (type === "click") handler = fn; } };
  const posted: any[] = [];
  const parent = { postMessage: (m: any) => posted.push(m) };
  new Function("document", "parent", script)(doc, parent);
  const a = {
    attrs: { href, ...attrs } as Record<string, string>,
    getAttribute(n: string) { return this.attrs[n] ?? null; },
    setAttribute(n: string, v: string) { this.attrs[n] = v; },
  };
  let prevented = false;
  handler!({
    defaultPrevented: false, button: 0,
    target: { closest: () => a },
    preventDefault: () => { prevented = true; },
  });
  return { attrs: a.attrs, prevented, posted };
}

test("/raw interceptor opens external links in a new tab instead of the sandboxed frame", () => {
  for (const href of ["https://cs50.harvard.edu/python/", "http://example.com", "//example.com/x"]) {
    const r = clickRaw(href);
    expect(r.attrs.target).toBe("_blank");
    expect(r.attrs.rel).toBe("noreferrer noopener");
    expect(r.prevented).toBe(false); // browser default action does the opening
    expect(r.posted).toEqual([]);
  }
});

test("/raw interceptor keeps an explicit target on external links", () => {
  const r = clickRaw("https://example.com", { target: "_top" });
  expect(r.attrs.target).toBe("_top");
});

test("/raw interceptor still relays internal links and leaves anchors alone", () => {
  const internal = clickRaw("/n/abc");
  expect(internal.prevented).toBe(true);
  expect(internal.posted).toEqual([{ ns: "folio", type: "navigate", href: "/n/abc" }]);
  expect(internal.attrs.target).toBeUndefined();
  for (const href of ["#sekcja", "mailto:a@b.pl", "/admin"]) {
    const r = clickRaw(href);
    expect(r.prevented).toBe(false);
    expect(r.posted).toEqual([]);
    expect(r.attrs.target).toBeUndefined();
  }
});
