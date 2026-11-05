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

/**
 * Outer page for cloud /n/:uuid — JS-driven shell. PUBLIC route (no auth
 * required) that returns this HTML, which then:
 *   1. Reads the bearer token from IndexedDB (origin-scoped, set during pair)
 *   2. Fetches /raw/:uuid with Authorization: Bearer ...
 *   3. Wraps the response body in a Blob and loads it into a sandboxed
 *      iframe via blob: URL.
 *
 * Why not let SW inject the Authorization header for direct iframe src?
 * Two reasons:
 *   - First-navigation race: on a freshly-installed PWA, the user can tap
 *     a note before the SW takes control. Direct fetch in this page avoids
 *     that race entirely — works the moment the JS runs.
 *   - Some browsers reconstruct/normalize navigation requests in ways that
 *     drop the SW-added header. Doing the fetch explicitly sidesteps that.
 *
 * Blob URL + sandbox without `allow-same-origin` = null origin for the
 * iframe content. Body scripts run with no access to folio.notibox.ai
 * cookies/IDB. CSP on the raw response still applies if we set
 * Content-Security-Policy as meta tag in the rendered content. The current
 * raw response is theme'd standalone HTML; we keep the same isolation
 * guarantees as before because the iframe sandbox attribute is the
 * load-bearing piece, not the response headers.
 */
export function renderNotePage(uuid: string, _title: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#1a1a1a">
  <title>Folio</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #1a1a1a; color: #aaa; font-family: 'Familjen Grotesk', system-ui, sans-serif; }
    body.has-live { display: flex; flex-direction: column; }
    iframe { width: 100%; height: 100vh; border: 0; display: block; background: #fff; }
    body.has-live iframe { flex: 1; height: auto; min-height: 0; }
    .state { padding: 20vh 20px; text-align: center; font-size: 14px; line-height: 1.6; }
    .state a { color: #ff5a1f; text-decoration: none; }
    .state a:hover { text-decoration: underline; }
    .state .err { color: #ff7a5f; font-size: 13px; margin-top: 8px; opacity: 0.7; }
    .back { position: fixed; top: env(safe-area-inset-top, 0); left: 0; padding: 10px 14px; color: #888; text-decoration: none; font-size: 14px; z-index: 10; }
    /* Live entries panel — slides up from the bottom on live notes. */
    .live-panel { display: none; background: #1a1a1a; color: #ddd; border-top: 1px solid #333; max-height: 38vh; overflow-y: auto; padding: 12px 16px env(safe-area-inset-bottom, 12px); }
    body.has-live .live-panel { display: block; }
    .live-panel .lp-h { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase; color: #888; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
    .live-panel .lp-h .dot { width: 7px; height: 7px; border-radius: 50%; background: #ff5a1f; animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
    .live-panel .lp-list { display: flex; flex-direction: column; gap: 8px; }
    .live-panel .lp-entry { padding: 8px 10px; background: #232323; border-radius: 6px; font-size: 13px; line-height: 1.45; }
    .live-panel .lp-entry .lp-ts { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10.5px; color: #777; margin-bottom: 4px; }
    .live-panel .lp-entry .lp-c { color: #ddd; }
    .live-panel .lp-entry .lp-c p { margin: 0; }
    .live-panel .lp-empty { color: #666; font-style: italic; font-size: 12px; }
  </style>
</head>
<body>
  <script>(function(){
    // Internal Folio link clicked inside the body iframe (relayed by the
    // /raw interceptor) → navigate the TOP PWA page. Same origin + authed,
    // so the root-relative path is correct as-is. Kills Folio-in-Folio.
    window.addEventListener('message', function(e){
      var d = e.data; if (!d || d.ns !== 'folio' || d.type !== 'navigate') return;
      var href = String(d.href || '');
      if (!/^\\/(n|p|t|tag|threads)(\\/|\$|[?#])/.test(href)) return;
      window.location.assign(href);
    });
  })();</script>
  <a href="/" class="back" id="back">‹ back</a>
  <div id="state" class="state">Loading…</div>
  <iframe id="frame" sandbox="allow-scripts allow-popups allow-forms allow-modals" referrerpolicy="no-referrer" style="display: none;"></iframe>
  <aside class="live-panel" id="live-panel" aria-label="Live entries">
    <div class="lp-h"><span class="dot"></span><span>Live</span><span id="lp-count" style="color:#666;">(0)</span></div>
    <div class="lp-list" id="lp-list">
      <div class="lp-empty">Waiting for entries…</div>
    </div>
  </aside>
  <script>
(function () {
  var UUID = ${JSON.stringify(uuid)};
  var stateEl = document.getElementById('state');
  var frame = document.getElementById('frame');

  function setError(msg, hint) {
    stateEl.innerHTML = msg + (hint ? '<div class="err">' + hint + '</div>' : '');
    stateEl.style.display = '';
    frame.style.display = 'none';
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('folio-pwa', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function kvGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('kv', 'readonly');
        var req = tx.objectStore('kv').get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(undefined); };
      });
    });
  }

  // Live entries panel state.
  var liveEntries = [];
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderLiveEntries() {
    var list = document.getElementById('lp-list');
    var count = document.getElementById('lp-count');
    if (count) count.textContent = '(' + liveEntries.length + ')';
    if (!list) return;
    if (liveEntries.length === 0) {
      list.innerHTML = '<div class="lp-empty">Waiting for entries…</div>';
      return;
    }
    // Newest first.
    list.innerHTML = liveEntries.slice().reverse().map(function(e){
      var t = new Date(e.ts);
      var ts = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      return (
        '<div class="lp-entry">' +
          '<div class="lp-ts">' + ts + '</div>' +
          '<div class="lp-c">' + (e.content_html || '') + '</div>' +
        '</div>'
      );
    }).join('');
  }
  function openLiveStream(token) {
    try {
      // EventSource can't send headers; pass token as query param.
      // The cloud accepts query-param auth ONLY for /v1/sync/live-stream.
      var url = '/v1/sync/live-stream?note_uuid=' + encodeURIComponent(UUID) +
                '&token=' + encodeURIComponent(token);
      var es = new EventSource(url);
      es.addEventListener('entry', function(ev){
        try {
          var entry = JSON.parse(ev.data);
          liveEntries.push(entry);
          renderLiveEntries();
        } catch(_){}
      });
      es.onerror = function() {
        // Browser auto-retries with backoff. No-op here; if connection
        // permanently breaks, panel keeps last-rendered entries.
      };
      // Best-effort close on navigation.
      window.addEventListener('beforeunload', function(){ es.close(); });
    } catch(_){}
  }

  kvGet('token').then(function (token) {
    if (!token) {
      setError('Not paired on this device.', '<a href="/pair">Pair now</a>');
      return null;
    }
    return fetch('/raw/' + encodeURIComponent(UUID), {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'text/html' }
    }).then(function (r) {
      if (r.status === 401) {
        setError('Session expired or device revoked.', '<a href="/pair">Pair this device again</a>');
        return null;
      }
      if (r.status === 404) {
        setError('Note not found.', '<a href="/">‹ back to list</a>');
        return null;
      }
      if (!r.ok) {
        setError('Could not load note.', 'HTTP ' + r.status);
        return null;
      }
      // Capture live/is_final via the X-Folio-* response headers so we
      // can decide whether to open the SSE stream below. Heading-based
      // signaling avoids a separate metadata roundtrip per note view.
      var live = r.headers.get('X-Folio-Live') === '1';
      var fin = r.headers.get('X-Folio-Final') === '1';
      return r.text().then(function(html){ return { html: html, live: live, fin: fin, token: token }; });
    });
  }).then(function (out) {
    if (!out) return;
    if (out.live && !out.fin) {
      document.body.classList.add('has-live');
      openLiveStream(out.token);
    }
    var blob = new Blob([out.html], { type: 'text/html' });
    var blobUrl = URL.createObjectURL(blob);
    frame.onload = function () {
      stateEl.style.display = 'none';
      frame.style.display = 'block';
    };
    frame.src = blobUrl;
  }).catch(function (e) {
    setError('Could not load note.', String(e && e.message || e));
  });
})();
  </script>
</body>
</html>`;
}
