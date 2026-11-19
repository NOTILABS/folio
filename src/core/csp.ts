/**
 * Shared Content-Security-Policy for the iframe-isolated note `/raw/:id` route
 * across both the local viewer (src/viewer/server.ts) and the cloud relay
 * (src/cloud/server.ts).
 *
 * The rationale lives in AGENTS.md hard rules: notes run inside a null-origin
 * sandboxed iframe (sandbox="allow-scripts allow-popups allow-forms" WITHOUT
 * allow-same-origin), so this CSP works alongside that. `connect-src 'none'`
 * is the load-bearing line — even though scripts can execute in the note,
 * they cannot fetch/XHR/WebSocket anywhere, which prevents data exfiltration.
 *
 * Keep this header identical between viewer and cloud — if they drift, a note
 * could behave differently depending on which surface served it, and threat
 * model reasoning falls apart.
 */
export const RAW_NOTE_CSP = [
  "default-src 'self' 'unsafe-inline' data: blob: https:",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https:",
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'none'",
  "base-uri 'self'",
].join("; ");

export function rawNoteHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": RAW_NOTE_CSP,
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
  };
}

/**
 * Origins allowed to frame a capability-URL note body (`/p/:token/raw/:id`).
 *
 * Kokpit (any gateway — Tailscale/box over https, the Mac on loopback http)
 * shows a shared note in its side panel by framing `/p/:token/n/:id` with
 * allow-same-origin, and that page frames `/p/:token/raw/:id`. CSP
 * frame-ancestors checks EVERY ancestor, so `'self'` alone blocked the body as
 * soon as the outer page sat inside Kokpit ("refused to connect", sc-37038).
 *
 * Why this is safe for share routes only: the URL is already a bearer
 * capability (anyone holding it can open the note), the body is read-only, and
 * the isolation that matters — null-origin sandbox + `connect-src 'none'` —
 * is unchanged. The authed `/raw/:id` keeps `frame-ancestors 'self'`.
 */
export const SHARED_FRAME_ANCESTORS = "frame-ancestors 'self' https: http://localhost:* http://127.0.0.1:*";

export const SHARED_RAW_NOTE_CSP = RAW_NOTE_CSP.replace("frame-ancestors 'self'", SHARED_FRAME_ANCESTORS);

/**
 * Headers for capability-URL responses (`/p/:token/raw/...` in cloud relay).
 * Same CSP as the local raw-note route except frame-ancestors (see above);
 * no X-Frame-Options, because SAMEORIGIN would veto the wider frame-ancestors
 * in browsers that still consult it. Adds noindex + tightens referrer.
 */
export function sharedNoteHeaders(): Record<string, string> {
  const { "X-Frame-Options": _xfo, ...base } = rawNoteHeaders();
  return {
    ...base,
    "Content-Security-Policy": SHARED_RAW_NOTE_CSP,
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
  };
}
