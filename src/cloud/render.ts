/**
 * Minimal cloud-side note rendering. Wraps body_html with the requested
 * theme.css and a minimal `<!doctype>` shell. Intentionally simpler than the
 * local viewer (src/viewer/render.ts) — no sidebar, no TOC, no theme switcher,
 * no prev/next-in-thread. The PWA in W3 provides chrome around an iframe that
 * points at /raw/:uuid; capability URLs in W4 render the standalone HTML
 * directly.
 *
 * Theme.css is loaded from the bundled themes dir on the cloud host. If the
 * requested theme is missing, fall back to linen — never 500 on missing theme.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bundledThemesDir } from "../core/config";

function readThemeCss(theme: string): string {
  const candidate = join(bundledThemesDir(), theme, "theme.css");
  if (existsSync(candidate)) return readFileSync(candidate, "utf-8");
  const fallback = join(bundledThemesDir(), "linen", "theme.css");
  if (existsSync(fallback)) return readFileSync(fallback, "utf-8");
  return "";
}

export interface RenderNoteInput {
  title: string;
  theme: string;
  bodyHtml: string;
  /**
   * User namespace for asset URL rewriting (v0.13+). When set, any
   * `/t/<thread>/asset/<file>` ref inside bodyHtml is rewritten to
   * `/u/<userId>/t/<thread>/asset/<file>` so the iframe always loads bytes
   * via the per-user route. Omit (or pass undefined) for capability URL
   * paths — those already rewrite to `/p/<token>/t/...` upstream.
   */
  userId?: string | null;
  /**
   * v0.34: when true, inject the variant-pick affordance — turns every
   * `[data-folio-pick]` element in the body into a "choose this" control.
   * The body iframe is null-origin + CSP connect-src 'none', so it can't POST;
   * it postMessages the pick to the parent /n page, which does the fetch.
   * Set only for capability `/raw` renders whose share has allow_pick.
   */
  pickable?: boolean;
}

/**
 * Rewrite asset refs `/t/<thread>/asset/<file>` → `/u/<userId>/t/.../asset/...`
 * Same regex as the capability-URL rewrite path; keeps the iframe seeing
 * URLs whose bytes are pinned to the correct user namespace.
 */
function rewriteAssetUrls(bodyHtml: string, userId: string): string {
  return bodyHtml.replace(
    /((?:href|src)\s*=\s*["'])([^"']*?)\/t\/([^/"']+)\/asset\/([^"'?#]+)(["'])/g,
    (_match, prefix: string, leading: string, thread: string, filename: string, quote: string) =>
      `${prefix}${leading}/u/${encodeURIComponent(userId)}/t/${thread}/asset/${filename}${quote}`
  );
}

/**
 * Build a standalone HTML page (theme.css inlined, body_html slotted in).
 * This is what cloud serves at /raw/:uuid behind the iframe-isolation CSP.
 * `iframe-isolation` here means: the PWA wraps this in an iframe with
 * sandbox="allow-scripts allow-popups allow-forms allow-modals" (no allow-same-origin),
 * matching how the local viewer works.
 *
 * When `userId` is supplied, body_html asset refs are rewritten to the
 * per-user route. Skipped for capability URL renders (which already pass
 * a pre-rewritten body pointing at /p/<token>/t/...).
 */
export function renderStandaloneNote(input: RenderNoteInput): string {
  const css = readThemeCss(input.theme);
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const body = input.userId ? rewriteAssetUrls(input.bodyHtml, input.userId) : input.bodyHtml;
  return `<!doctype html>
<html lang="en" data-theme="${esc(input.theme)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(input.title)}</title>
  <style>${css}</style>
</head>
<body class="theme theme-${esc(input.theme)}">
  <main class="wrap">
    <article data-folio-content>
${body}
    </article>
  </main>
  <script>(function(){
    document.addEventListener('click', function(e){
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var t = e.target, a = t && t.closest ? t.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      // External links: the iframe is sandboxed and most sites refuse to be
      // framed ("refused to connect"), so open them in a new tab instead —
      // same as the local viewer's attachExternalLinks. Set at click time so
      // the browser's default action picks it up; explicit targets win.
      if (/^(https?:)?\\/\\//i.test(href)) {
        if (!a.getAttribute('target')) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noreferrer noopener');
        }
        return;
      }
      if (href.charAt(0) !== '/') return;
      if (!/^\\/(n|p|t|tag|threads)(\\/|\$|[?#])/.test(href)) return;
      e.preventDefault();
      try { parent.postMessage({ ns: 'folio', type: 'navigate', href: href }, '*'); } catch(_){}
    }, true);
  })();</script>${input.pickable ? PICK_AFFORDANCE : ""}
</body>
</html>`;
}

/**
 * v0.34: client-side variant-pick affordance, injected into the /raw body iframe
 * when the share has allow_pick. Finds every `[data-folio-pick]` element, adds a
 * "Wybieram ten" button, and on click marks it selected + postMessages the pick
 * to the parent /n page (which POSTs to /p/:token/pick). No-op if the body has
 * no `[data-folio-pick]` markers, so it degrades gracefully on plain notes.
 */
const PICK_AFFORDANCE = `
  <style>
    [data-folio-pick]{position:relative;transition:box-shadow .15s ease}
    .folio-pick-btn{display:inline-flex;align-items:center;gap:.4em;margin-top:14px;padding:8px 14px;font-family:inherit;font-size:14px;font-weight:600;line-height:1;cursor:pointer;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;opacity:.78}
    .folio-pick-btn:hover{opacity:1}
    .folio-pick-selected{box-shadow:0 0 0 2px #1f9d55,0 0 0 7px rgba(31,157,85,.16);border-radius:12px}
    .folio-pick-selected .folio-pick-btn{background:#1f9d55;border-color:#1f9d55;color:#fff;opacity:1}
  </style>
  <script>(function(){
    var els = document.querySelectorAll('[data-folio-pick]');
    if (!els.length) return;
    function select(el){
      document.querySelectorAll('[data-folio-pick].folio-pick-selected').forEach(function(o){
        o.classList.remove('folio-pick-selected');
        var ob = o.querySelector('.folio-pick-btn');
        if (ob) ob.textContent = ob.getAttribute('data-idle');
      });
      el.classList.add('folio-pick-selected');
      var b = el.querySelector('.folio-pick-btn');
      if (b) b.textContent = '\\u2713 Wybrano';
    }
    Array.prototype.forEach.call(els, function(el){
      if (el.dataset.folioPickBound) return;
      el.dataset.folioPickBound = '1';
      var variant = el.getAttribute('data-folio-pick') || '';
      if (!variant) return;
      var label = el.getAttribute('data-folio-pick-label') || variant;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'folio-pick-btn';
      btn.setAttribute('data-idle', 'Wybieram ten');
      btn.textContent = 'Wybieram ten';
      btn.addEventListener('click', function(ev){
        ev.preventDefault(); ev.stopPropagation();
        select(el);
        try { parent.postMessage({ ns: 'folio', type: 'share-pick', variant: variant, label: label }, '*'); } catch(_){}
      });
      el.appendChild(btn);
    });
  })();</script>`;

/**
 * Outer page for /p/:token/n/:uuid — server-rendered. Unlike /n/:uuid
 * (which is a JS shell that reads token from IDB), capability URLs carry
 * the token in the URL path itself. No JS needed for auth — server
 * validates the token on each request and renders the iframe pointed at
 * /p/<token>/raw/<uuid>. Sandbox attributes match the authed /n/ flow.
 *
 * Headers: same CSP as /raw/, plus X-Robots-Tag: noindex,nofollow and
 * Referrer-Policy: no-referrer. These reduce capability-URL leakage via
 * search indexes and external Referer logs.
 */
export function renderSharedNotePage(token: string, uuid: string, title: string, publicUrl: string = "", description: string = ""): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Absolute URL for og:image / og:url so social previewers don't try to
  // resolve a relative path against their own host. publicUrl is the
  // cloud's externally-reachable origin (https://folio.notibox.ai); empty
  // string falls back to relative URLs (fine for testing). og:image is the
  // PNG (rasterized) — SVG og:images don't unfurl on most platforms.
  const ogImg = `${publicUrl}/p/${esc(token)}/og.png`;
  const ogUrl = `${publicUrl}/p/${esc(token)}/n/${esc(uuid)}`;
  const safeTitle = title || "Folio note";
  // Short plain-text description for the unfurl card. Note content already
  // sits behind the capability link the sender chose to share, so a summary
  // snippet in the preview is consistent with the title leak (cf. Notion).
  const safeDesc = description.replace(/\s+/g, " ").trim().slice(0, 200);
  const descTags = safeDesc
    ? `\n  <meta property="og:description" content="${esc(safeDesc)}">\n  <meta name="twitter:description" content="${esc(safeDesc)}">\n  <meta name="description" content="${esc(safeDesc)}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="theme-color" content="#1a1a1a">
  <title>${esc(safeTitle)}</title>
  <meta property="og:title" content="${esc(safeTitle)}">
  <meta property="og:type" content="article">
  <meta property="og:image" content="${esc(ogImg)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${esc(ogUrl)}">
  <meta property="og:site_name" content="Folio">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(safeTitle)}">
  <meta name="twitter:image" content="${esc(ogImg)}">${descTags}
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #1a1a1a; }
    iframe { width: 100%; height: 100vh; border: 0; display: block; background: #fff; }
  </style>
</head>
<body>
  <script>(function(){
    var TOKEN = ${JSON.stringify(token)};
    var UUID = ${JSON.stringify(uuid)};
    // Messages relayed from the capability iframe (null-origin, can't fetch).
    window.addEventListener('message', function(e){
      var d = e.data; if (!d || d.ns !== 'folio') return;
      // Internal Folio link clicked inside the iframe. Keep it inside the
      // granted scope: prefix the capability token so the link resolves to
      // /p/<token>/n/<id>, not the bare /n/<id> (which would drop the token
      // and 403). Navigates the TOP window — no Folio-in-Folio.
      if (d.type === 'navigate') {
        var href = String(d.href || '');
        if (!/^\\/(n|p|t|tag|threads)(\\/|\$|[?#])/.test(href)) return;
        // Asset links arrive already scoped: the /raw route rewrites
        // /t/X/asset/f to /p/<token>/t/X/asset/f. Prefixing again would
        // yield /p/<token>/p/<token>/… → 404 (e.g. "Download PDF" buttons).
        var SCOPE = '/p/' + TOKEN;
        if (href === SCOPE || href.indexOf(SCOPE + '/') === 0 || href.indexOf(SCOPE + '?') === 0 || href.indexOf(SCOPE + '#') === 0) {
          window.location.assign(href);
        } else {
          window.location.assign(SCOPE + href);
        }
        return;
      }
      // v0.34: recipient picked a variant in the body. POST it to the cloud
      // (the iframe couldn't — CSP connect-src 'none'). Fire-and-forget; the
      // body already shows the selected state optimistically.
      if (d.type === 'share-pick') {
        var variant = String(d.variant || '');
        if (!variant) return;
        try {
          fetch('/p/' + TOKEN + '/pick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note_uuid: UUID, variant: variant, label: d.label || null })
          }).catch(function(){});
        } catch(_){}
        return;
      }
    });
  })();</script>
  <iframe
    src="/p/${esc(token)}/raw/${esc(uuid)}"
    sandbox="allow-scripts allow-popups allow-forms allow-modals"
    referrerpolicy="no-referrer"
    title="${esc(safeTitle)}"></iframe>
</body>
</html>`;
}

/**
 * Thread list page for /p/:token/t/:thread_id — server-rendered HTML
 * listing of notes in that thread. Each link points at /p/<token>/n/<uuid>.
 * No JS needed.
 */
export interface SharedThreadNote {
  uuid: string;
  title: string;
  type: string;
  created_at: string;
  is_final: boolean;
}

export function renderSharedThreadPage(token: string, threadId: string, notes: SharedThreadNote[], publicUrl: string = ""): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const rows = notes
    .map((n) => {
      const ago = relativeTime(n.created_at);
      return `<a class="note" href="/p/${esc(token)}/n/${esc(n.uuid)}">
        <div class="title">${esc(n.title)}${n.is_final ? ' <span class="final">★</span>' : ""}</div>
        <div class="meta"><span class="type ${esc(n.type)}">${esc(n.type)}</span> <span class="ago">${esc(ago)}</span></div>
      </a>`;
    })
    .join("\n");
  const ogImg = `${publicUrl}/p/${esc(token)}/og.png`;
  const ogUrl = `${publicUrl}/p/${esc(token)}/t/${esc(threadId)}`;
  const ogTitle = `Thread: ${threadId}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="theme-color" content="#f5f3ee">
  <title>${esc(threadId)} · Folio</title>
  <meta property="og:title" content="${esc(ogTitle)}">
  <meta property="og:type" content="article">
  <meta property="og:image" content="${esc(ogImg)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${esc(ogUrl)}">
  <meta property="og:site_name" content="Folio">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(ogTitle)}">
  <meta name="twitter:image" content="${esc(ogImg)}">
  <meta name="description" content="${notes.length} note${notes.length === 1 ? "" : "s"} in this thread.">
  <meta property="og:description" content="${notes.length} note${notes.length === 1 ? "" : "s"} in this thread.">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400..700&family=Instrument+Serif:ital@0;1&display=swap');
    :root { --bg: #f5f3ee; --bg-2: #efeae0; --ink: #0a0a0a; --muted: #6b6b66; --line: rgba(10,10,10,0.10); --accent: #ff5a1f; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: 'Familjen Grotesk', system-ui, sans-serif; font-size: 17px; line-height: 1.5; }
    header { padding: 14px 20px; border-bottom: 1px solid var(--line); background: #fdfcf9; }
    header h1 { font-family: 'Instrument Serif', serif; font-style: italic; font-weight: 400; margin: 0; font-size: 22px; letter-spacing: -0.5px; color: var(--ink); }
    header .sub { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin-top: 4px; }
    main { max-width: 760px; margin: 0 auto; padding: 16px 20px 60px; }
    .note { display: block; padding: 14px 12px; border-radius: 10px; text-decoration: none; color: inherit; }
    .note:hover { background: var(--bg-2); }
    .note .title { font-size: 17px; font-weight: 500; margin-bottom: 4px; }
    .note .final { color: var(--accent); }
    .note .meta { font-size: 13px; color: var(--muted); display: flex; gap: 10px; align-items: center; }
    .note .type { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--line); border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .empty { text-align: center; color: var(--muted); padding: 60px 20px; font-style: italic; font-family: 'Instrument Serif', serif; }
  </style>
</head>
<body>
  <header>
    <h1>${esc(threadId)}</h1>
    <div class="sub">${notes.length} note${notes.length === 1 ? "" : "s"} · shared via folio.</div>
  </header>
  <main>
    ${notes.length === 0 ? '<div class="empty">No notes in this thread.</div>' : rows}
  </main>
</body>
</html>`;
}

/**
 * Email-confirmation page for recipient-bound capability URLs. Renders
 * a tiny form; on POST the server hashes the submitted email and
 * compares to `shares.recipient_email_hash`. On match, sets a path-
 * scoped HttpOnly cookie tied to this token and redirects to the
 * actual content. On mismatch, renders the same form with an error.
 */
export function renderRecipientConfirm(token: string, errorMsg: string | null): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="theme-color" content="#f5f3ee">
  <title>Confirm · Folio</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400..700&family=Instrument+Serif:ital@0;1&display=swap');
    :root { --bg: #f5f3ee; --bg-2: #efeae0; --panel: #fdfcf9; --ink: #0a0a0a; --muted: #6b6b66; --line: rgba(10,10,10,0.10); --accent: #ff5a1f; --accent-soft: rgba(255,90,31,0.10); }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: 'Familjen Grotesk', system-ui, sans-serif; font-size: 17px; line-height: 1.5; }
    .wrap { max-width: 420px; margin: 60px auto; padding: 24px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
    h1 { font-family: 'Instrument Serif', serif; font-style: italic; font-weight: 400; font-size: 30px; letter-spacing: -0.5px; margin: 0 0 8px; }
    h1 .dot { color: var(--accent); font-family: 'Familjen Grotesk'; font-style: normal; font-weight: 700; }
    .lead { color: var(--muted); margin: 0 0 22px; font-size: 14px; line-height: 1.55; }
    label { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 6px; }
    input { width: 100%; padding: 12px 14px; font-size: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); -webkit-appearance: none; font-family: inherit; }
    input:focus { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button { margin-top: 16px; width: 100%; padding: 12px 14px; font-size: 15px; font-weight: 600; background: var(--ink); color: var(--bg); border: 0; border-radius: 8px; cursor: pointer; font-family: inherit; }
    button:hover { background: var(--accent); }
    .err { margin-top: 12px; color: #a4253a; font-size: 13px; }
    .tip { margin-top: 22px; font-size: 12px; color: var(--muted); line-height: 1.55; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>folio<span class="dot">.</span></h1>
    <p class="lead">This link is bound to a specific recipient. Enter the email it was shared with to read the note.</p>
    <form method="post" action="/p/${esc(token)}/confirm-recipient" autocomplete="off">
      <label for="email">Recipient email</label>
      <input id="email" name="email" type="email" required autocomplete="off" autocapitalize="none">
      <button type="submit">Continue</button>
      ${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ""}
    </form>
    <p class="tip">Your address is checked against a SHA-256 hash stored with the share — the sender's server never sees the plaintext after confirmation.</p>
  </main>
</body>
</html>`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

