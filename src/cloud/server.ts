/**
 * Folio Cloud relay — Bun HTTP server.
 *
 * Routes:
 *   GET    /healthz                       (public)
 *   GET    /v1/version                    (public, sparse — full info auth'd)
 *   POST   /v1/auth/pair                  (public — consumes pairing code)
 *   DELETE /v1/auth/device/:id            (authed)
 *   GET    /v1/auth/devices               (authed)
 *   POST   /v1/sync/push                  (authed)
 *   POST   /v1/sync/assets/:hash          (authed)
 *   GET    /v1/sync/assets/:hash          (authed, returns bytes)
 *   GET    /v1/sync/pull?since=<seq>      (authed)
 *   GET    /n/:uuid                       (authed — outer page with iframe)
 *   GET    /raw/:uuid                     (authed — body in theme, CSP locked)
 *   GET    /t/:thread_id                  (authed — thread index, minimal)
 *   GET    /manifest.webmanifest          (public — PWA, W3 placeholder)
 *   GET    /sw.js                         (public — PWA, W3 placeholder)
 *
 * Capability URLs `/p/:token/...` are stubbed for W4 (returns 501 today).
 *
 * Trust model: outside this file, treat req.device as the only authenticated
 * subject. Public paths (see isPublicPath in auth.ts) get no device context.
 */

import { cloudDb } from "./db";
import { subscribe as subscribeLiveStream } from "./sse-hub";
import {
  authenticate,
  consumePairingCode,
  createPairingCode,
  extractBearer,
  isPublicPath,
  listDevices,
  revokeDevice,
  type Device,
} from "./auth";
import {
  handlePush,
  handlePull,
  storeAsset,
  readAsset,
  type PushPayload,
} from "./sync";
import { renderNotePage, renderStandaloneNote, renderSharedNotePage, renderSharedThreadPage, renderRecipientConfirm } from "./render";
import { renderHome, renderPair, serviceWorkerJs, manifestJson, FOLIO_ICON_SVG, SW_VERSION } from "./pwa";
import {
  createShare,
  getShare,
  revokeShare,
  listShares,
  validateShareAccess,
  incrementShareViews,
  recordSharePick,
  getSharePicks,
} from "./shares";
import { buildAdminStats, buildGlobalStats } from "./stats";
import { getMailer, isMailerConfigured, renderShareEmail } from "./mailer";
import {
  whoami,
  createUser,
  patchUser,
  deleteUser,
  mintPairCodeFor,
  AdminError,
} from "./admin";
import { createHash } from "node:crypto";
import { rawNoteHeaders } from "../core/csp";
import { DEFAULT_SHARE_EXPIRES_DAYS } from "../core/config";
import pkg from "../../package.json" with { type: "json" };

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function sharedHeaders(): Record<string, string> {
  // Same CSP as authed /raw/, plus belt-and-braces no-index + no-referrer to
  // limit capability-URL leakage via search engines and external Referers.
  return {
    ...rawNoteHeaders(),
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
  };
}

/**
 * Handle `/p/:token/(n|raw|t)/:id` capability routes.
 *
 * Path layout:
 *   /p/<token>/n/<uuid>         → outer iframe page (server-rendered HTML)
 *   /p/<token>/raw/<uuid>       → body in theme + locked CSP (the actual content)
 *   /p/<token>/t/<thread_id>    → thread list (server-rendered HTML)
 *
 * Validation order:
 *   1. Token exists?
 *   2. Not revoked, not expired, view_count < max_views?
 *   3. Scope matches the requested resource?
 * Any failure returns the appropriate 4xx, no info leak about the missing
 * piece (404 + minimal body).
 *
 * View counting bumps only after a successful match, once per HIT
 * (including iframe-loaded /raw/ — each child iframe load counts). For
 * MVP this is fine; if it becomes noisy, throttle by token+UA later.
 */
async function handleCapabilityRoute(req: Request, path: string, method: string, publicUrl: string): Promise<Response> {
  const parts = path.split("/").filter(Boolean); // ["p", token, kind, id, ...]
  if (parts.length < 3 || parts[0] !== "p") {
    return new Response("not found", { status: 404 });
  }
  const token = parts[1]!;
  const share = getShare(token);
  if (!share) return new Response("not found", { status: 404 });

  // POST /p/:token/confirm-recipient — handles the email-confirmation form
  // for recipient-bound shares. Sets a path-scoped HttpOnly cookie on
  // match; subsequent GETs to /p/:token/* see the cookie and skip the
  // confirmation gate.
  if (parts.length === 3 && parts[2] === "confirm-recipient" && method === "POST") {
    if (!share.recipient_email_hash) return new Response("not found", { status: 404 });
    let email = "";
    try {
      const ct = (req.headers.get("content-type") ?? "").toLowerCase();
      if (ct.includes("application/x-www-form-urlencoded")) {
        const body = new URLSearchParams(await req.text());
        email = body.get("email") ?? "";
      } else if (ct.includes("application/json")) {
        const body = (await req.json()) as { email?: string };
        email = body.email ?? "";
      }
    } catch {}
    email = email.trim().toLowerCase();
    if (!email) return new Response("email required", { status: 400 });
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const submitted = createHash("sha256").update(email, "utf8").digest("hex");
    if (submitted !== share.recipient_email_hash) {
      return new Response(renderRecipientConfirm(token, "Email doesn't match. Try again."), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    // Match. Set a path-scoped HttpOnly cookie tied to this token.
    // Max-Age picks the lesser of "share expires_at" and "24 hours" so the
    // confirmation doesn't outlive the link itself.
    const ttlSec = share.expires_at
      ? Math.min(86400, Math.max(60, Math.floor((new Date(share.expires_at).getTime() - Date.now()) / 1000)))
      : 86400;
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/p/${token}/${share.scope_type === "thread" ? "t" : "n"}/${share.scope_id}`,
        "Set-Cookie": `folio_share_${token}=1; Path=/p/${token}/; Max-Age=${ttlSec}; HttpOnly; SameSite=Strict`,
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  // POST /p/:token/pick — a recipient registers a SOFT variant preference for
  // a note inside this share's scope. Requires the share to be live AND
  // allow_pick. The capability token is the credential (link = authority); for
  // recipient-bound shares we additionally require the confirmation cookie.
  // Writes to share_picks — deliberately separate from the authoritative
  // iteration state machine (no kind:pick, no append-only side effects).
  // Idempotent last-pick-wins per (token, note).
  if (parts.length === 3 && parts[2] === "pick" && method === "POST") {
    const jsonErr = (msg: string, status: number): Response =>
      new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { "Content-Type": "application/json", "Referrer-Policy": "no-referrer" },
      });
    if (!share.allow_pick) return jsonErr("not found", 404);
    if (share.revoked_at) return jsonErr("not found", 404);
    if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
      return jsonErr("link expired", 410);
    }
    if (share.recipient_email_hash) {
      const cookie = req.headers.get("cookie") ?? "";
      if (!cookie.split(";").some((c) => c.trim() === `folio_share_${token}=1`)) {
        return jsonErr("recipient confirmation required", 403);
      }
    }
    let noteUuid = "";
    let variant = "";
    let label: string | null = null;
    try {
      const b = (await req.json()) as { note_uuid?: string; variant?: string; label?: string };
      noteUuid = (b.note_uuid ?? "").trim();
      variant = (b.variant ?? "").trim();
      label = b.label ? String(b.label).slice(0, 200) : null;
    } catch {}
    if (!noteUuid || !variant) return jsonErr("note_uuid and variant required", 400);
    // The picked note must belong to the share's user (no cross-user write via
    // a leaked token) AND be inside the share's scope.
    const note = cloudDb()
      .query<{ uuid: string; thread_id: string }, [string, string]>(
        "SELECT uuid, thread_id FROM notes WHERE uuid = ? AND user_id = ?"
      )
      .get(noteUuid, share.user_id);
    if (!note) return jsonErr("note not found", 404);
    const v = validateShareAccess(share, { type: "note", uuid: note.uuid, thread_id: note.thread_id });
    if (!v.ok) return jsonErr("scope mismatch", 403);
    const pick = recordSharePick({
      token,
      note_uuid: note.uuid,
      user_id: share.user_id,
      variant: variant.slice(0, 200),
      label,
    });
    return new Response(
      JSON.stringify({ ok: true, variant: pick.variant, label: pick.label, picked_at: pick.picked_at }),
      { status: 200, headers: { "Content-Type": "application/json", "Referrer-Policy": "no-referrer" } }
    );
  }

  if (method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  // /p/<token>/og.svg — Open Graph image for the share. Public (no cookie
  // gate even for recipient-bound shares — social previewers fetch this
  // before the user has confirmed email; title leakage in og:image is the
  // accepted trade-off, mirrors Notion/Google Docs behaviour). Same
  // share-validity rules as the main page (revoked/expired → 404/410).
  if (parts.length === 3 && parts[2] === "og.svg") {
    if (share.revoked_at) return new Response("not found", { status: 404 });
    if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
      return new Response("link expired", { status: 410 });
    }
    const { generateOgSvg } = await import("./og");
    let title = "Folio";
    let theme = "linen";
    let scope_type: "note" | "thread" = share.scope_type;
    let thread_id: string | null = null;
    if (share.scope_type === "note") {
      const note = cloudDb()
        .query<{ title: string; theme: string; thread_id: string }, [string, string]>(
          "SELECT title, theme, thread_id FROM notes WHERE uuid = ? AND user_id = ?"
        )
        .get(share.scope_id, share.user_id);
      if (note) {
        title = note.title;
        theme = note.theme;
        thread_id = note.thread_id;
      }
    } else {
      title = share.scope_id;
      thread_id = share.scope_id;
    }
    const svg = generateOgSvg({ title, theme, scope_type, scope_id: share.scope_id, thread_id });
    return new Response(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        // Modest cache so the preview unfurls fast on repeated paste in
        // Slack/Telegram. Title rarely changes on a published note, but
        // 5min lets us recover from a typo + republish without waiting
        // a day.
        "Cache-Control": "public, max-age=300",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  // /p/<token>/og.png — rasterized OG card. og:image points here (not og.svg)
  // because most unfurlers reject SVG og:images. Same share-validity rules and
  // title lookup as og.svg. If rasterization is unavailable (a deploy missing
  // the og/ sidecar), falls back to serving the SVG so the link still previews.
  if (parts.length === 3 && parts[2] === "og.png") {
    if (share.revoked_at) return new Response("not found", { status: 404 });
    if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
      return new Response("link expired", { status: 410 });
    }
    const og = await import("./og");
    let title = "Folio";
    let theme = "linen";
    const scope_type: "note" | "thread" = share.scope_type;
    let thread_id: string | null = null;
    if (share.scope_type === "note") {
      const note = cloudDb()
        .query<{ title: string; theme: string; thread_id: string }, [string, string]>(
          "SELECT title, theme, thread_id FROM notes WHERE uuid = ? AND user_id = ?"
        )
        .get(share.scope_id, share.user_id);
      if (note) {
        title = note.title;
        theme = note.theme;
        thread_id = note.thread_id;
      }
    } else {
      title = share.scope_id;
      thread_id = share.scope_id;
    }
    const ogInput = { title, theme, scope_type, scope_id: share.scope_id, thread_id };
    try {
      const png = await og.generateOgPng(ogInput);
      return new Response(png, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch {
      // Rasterizer unavailable (missing og/ sidecar, init failure) — serve the
      // SVG so SVG-tolerant clients still preview instead of getting a 404.
      const svg = og.generateOgSvg(ogInput);
      return new Response(svg, {
        status: 200,
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=60",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
  }

  // /p/<token>/qr.svg — QR code encoding the share URL itself. Same
  // share-validity rules as og.svg.
  if (parts.length === 3 && parts[2] === "qr.svg") {
    if (share.revoked_at) return new Response("not found", { status: 404 });
    if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
      return new Response("link expired", { status: 410 });
    }
    const { generateQrSvg } = await import("./qr");
    const shareUrl = `${publicUrl}/p/${token}/${share.scope_type === "thread" ? "t" : "n"}/${share.scope_id}`;
    const svg = await generateQrSvg(shareUrl);
    return new Response(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  }

  if (parts.length < 4) return new Response("not found", { status: 404 });
  const kind = parts[2]!;
  const id = parts.slice(3).join("/");

  // Recipient-bound shares: gate every read with a cookie check. Allow
  // asset sub-resources through (img refs in a confirmed iframe shouldn't
  // re-prompt) — the iframe already passed the confirmation when /n/ loaded.
  if (share.recipient_email_hash && kind !== "t" /* allow asset path below */) {
    // Asset path under /t/<thread>/asset/<filename> is fine — image fetch
    // from inside the iframe; if the iframe is loaded, the visitor already
    // passed confirmation. Note pages (/n/) and raw bodies need the cookie.
    if (kind === "n" || kind === "raw") {
      const cookie = req.headers.get("cookie") ?? "";
      const wanted = `folio_share_${token}=1`;
      if (!cookie.split(";").some((c) => c.trim() === wanted)) {
        return new Response(renderRecipientConfirm(token, null), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }
  }

  // /p/:token/t/:thread/asset/:filename — capability-scoped asset access.
  // The share must cover the requested thread (either thread-scoped to it,
  // or note-scoped to a note in it). Asset lookup pinned to share.user_id
  // so a cross-user (thread, filename) collision can never serve another
  // user's bytes through a single user's capability token.
  if (kind === "t" && parts.length === 6 && parts[4] === "asset") {
    const threadId = decodeURIComponent(parts[3]!);
    const filename = decodeURIComponent(parts[5]!);
    // Thread-scoped: thread_id must equal scope_id.
    // Set-scoped: a set grants a BUNDLE of notes that may span threads — the
    //   asset is in scope if ANY granted note (share_notes) lives in this
    //   thread, not just the root note. (Regression: checking only the root
    //   note's thread 404'd images that lived in a linked note's thread.)
    // Note-scoped: the asset must live in the shared note's own thread.
    const validScope = share.scope_type === "thread"
      ? share.scope_id === threadId
      : share.scope_type === "set"
        ? cloudDb()
            .query<{ n: number }, [string, string, string]>(
              `SELECT COUNT(*) AS n FROM share_notes sn
                 JOIN notes n ON n.uuid = sn.note_uuid
                WHERE sn.token = ? AND n.user_id = ? AND n.thread_id = ?`
            )
            .get(share.token, share.user_id, threadId)!.n > 0
        : (cloudDb()
            .query<{ thread_id: string }, [string, string]>("SELECT thread_id FROM notes WHERE uuid = ? AND user_id = ?")
            .get(share.scope_id, share.user_id)?.thread_id === threadId);
    if (!validScope) return new Response("not found", { status: 404 });
    if (share.revoked_at) return new Response("not found", { status: 404 });
    if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
      return new Response("link expired", { status: 410 });
    }
    const row = cloudDb()
      .query<{ hash: string }, [string, string, string]>(
        "SELECT hash FROM assets WHERE user_id = ? AND thread_id = ? AND filename = ?"
      )
      .get(share.user_id, threadId, filename);
    if (!row) return new Response("not found", { status: 404 });
    const a = readAsset(row.hash);
    if (!a) return new Response("not found", { status: 404 });
    // Don't bump view_count for sub-resource fetches — would balloon per image.
    return new Response(a.bytes, {
      status: 200,
      headers: {
        "Content-Type": a.content_type,
        "Content-Length": String(a.size_bytes),
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  if (kind === "n" || kind === "raw") {
    // Look up note for thread context (needed for thread-scoped validation
    // when caller targets a note). Same lookup is reused for rendering
    // below. Pinned to share.user_id so a leaked token from user A can
    // never address user B's notes even if the uuid happens to collide.
    type CapabilityNoteRow = {
      uuid: string;
      title: string;
      theme: string;
      body_html: string;
      thread_id: string;
      summary: string | null;
      superseded_by: string | null;
    };
    const noteQuery = () =>
      cloudDb().query<CapabilityNoteRow, [string, string]>(
        "SELECT uuid, title, theme, body_html, thread_id, summary, superseded_by FROM notes WHERE uuid = ? AND user_id = ?"
      );
    let note = noteQuery().get(id, share.user_id);
    if (!note) return new Response("not found", { status: 404 });

    // sc-24117: `replace` mints a new head and points this note's
    // superseded_by at it. The capability link format never changes
    // (`/p/<token>/n/<scope_id>`), so an old link must keep resolving — to
    // the NEW content, not a 404. We render the head IN PLACE rather than
    // issuing a redirect: the URL the recipient has stays valid indefinitely
    // (a redirect would still work too since fetch follows them, but
    // render-in-place also means /p/<token>/raw/<old-uuid> hit directly —
    // e.g. a stale cached iframe src — resolves too, with no second round-
    // trip, and it mirrors the local (non-cloud) viewer's existing pattern
    // for this exact situation — see render.ts `supersedeBanner`/
    // resolveHeadOfChain, which shows the head's content in place rather
    // than redirecting the browser). Limit 50 matches the walk in
    // validateShareAccess.
    if (note.superseded_by) {
      let cur = note;
      let hops = 0;
      while (cur.superseded_by && hops < 50) {
        const next = noteQuery().get(cur.superseded_by, share.user_id);
        if (!next) break;
        cur = next;
        hops++;
      }
      note = cur;
    }

    const v = validateShareAccess(share, { type: "note", uuid: note.uuid, thread_id: note.thread_id });
    if (!v.ok) return shareFailure(v.reason);

    if (kind === "n") {
      const body = renderSharedNotePage(token, note.uuid, note.title, publicUrl, note.summary ?? "");
      const res = new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
          "Referrer-Policy": "no-referrer",
        },
      });
      incrementShareViews(token);
      return res;
    }
    // kind === "raw"
    // Rewrite asset URLs in body_html so they route through the capability
    // scope. Relative refs like `/t/X/asset/foo.png` become
    // `/p/<token>/t/X/asset/foo.png`. Absolute refs to viewer_public_url
    // get the same treatment by matching the path suffix.
    const rewrittenBody = note.body_html.replace(
      /((?:href|src)\s*=\s*["'])([^"']*?)\/t\/([^/"']+)\/asset\/([^"'?#]+)(["'])/g,
      (_match, prefix: string, _leading: string, thread: string, filename: string, quote: string) =>
        `${prefix}/p/${token}/t/${thread}/asset/${filename}${quote}`
    );
    const body = renderStandaloneNote({
      title: note.title,
      theme: note.theme,
      bodyHtml: rewrittenBody,
      // v0.34: when the share allows picking, inject the affordance that turns
      // [data-folio-pick] elements into "choose this" controls. The body iframe
      // can't fetch (CSP connect-src 'none') so it postMessages the pick to the
      // parent /n page, which does the POST to /p/:token/pick.
      pickable: share.allow_pick,
    });
    const res = new Response(body, { status: 200, headers: sharedHeaders() });
    // Don't bump on /raw/ — it's loaded inside the iframe spawned by /n/,
    // so we'd double-count every page view. View counting happens at /n/.
    return res;
  }

  if (kind === "t") {
    const v = validateShareAccess(share, { type: "thread", thread_id: id });
    if (!v.ok) return shareFailure(v.reason);
    const notes = cloudDb()
      .query<
        { uuid: string; title: string; type: string; created_at: string; is_final: number },
        [string, string]
      >(
        `SELECT uuid, title, type, created_at, is_final FROM notes
          WHERE thread_id = ? AND user_id = ? ORDER BY created_at DESC`
      )
      .all(id, share.user_id);
    const body = renderSharedThreadPage(
      token,
      id,
      notes.map((n) => ({
        uuid: n.uuid,
        title: n.title,
        type: n.type,
        created_at: n.created_at,
        is_final: n.is_final === 1,
      })),
      publicUrl
    );
    const res = new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Referrer-Policy": "no-referrer",
      },
    });
    incrementShareViews(token);
    return res;
  }

  return new Response("not found", { status: 404 });
}

/**
 * Operator-only admin routes (v0.14+). Caller's device must have
 * `device.isOperator === true`, otherwise 403. Returns null when no route
 * matches so the dispatcher in startCloudServer can fall through to the
 * default 404 handler.
 */
async function handleAdminRoute(
  path: string,
  method: string,
  req: Request,
  device: Device,
  publicUrl: string
): Promise<Response | null> {
  // Operator gate. /v1/admin/whoami and /v1/admin/stats are handled BEFORE
  // this helper is reached, so anything that lands here is an operator path.
  if (!device.isOperator) {
    return new Response(JSON.stringify({ error: "operator role required" }, null, 2), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function adminJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  function adminErr(e: unknown): Response {
    if (e instanceof AdminError) return adminJson({ error: e.message }, e.status);
    return adminJson({ error: (e as Error)?.message ?? "internal error" }, 500);
  }

  // GET /v1/admin/users — global per-user table.
  if (path === "/v1/admin/users" && method === "GET") {
    return adminJson(buildGlobalStats(publicUrl));
  }

  // POST /v1/admin/users — create user; optional mint_pair_code=true.
  if (path === "/v1/admin/users" && method === "POST") {
    try {
      const body = (await req.json()) as {
        id?: string;
        display_name?: string;
        is_operator?: boolean;
        mint_pair_code?: boolean;
      };
      if (!body.id) return adminJson({ error: "id required" }, 400);
      const result = createUser({
        id: body.id,
        display_name: body.display_name,
        is_operator: body.is_operator,
        mint_pair_code: body.mint_pair_code,
      });
      return adminJson(result);
    } catch (e) {
      return adminErr(e);
    }
  }

  // /v1/admin/users/<id>[/pair-code]
  const userMatch = path.match(/^\/v1\/admin\/users\/([^/]+)(?:\/(pair-code))?$/);
  if (userMatch) {
    const targetId = decodeURIComponent(userMatch[1]!);
    const sub = userMatch[2];

    if (sub === "pair-code" && method === "POST") {
      try {
        return adminJson(mintPairCodeFor(targetId));
      } catch (e) {
        return adminErr(e);
      }
    }

    if (!sub && method === "PATCH") {
      try {
        const body = (await req.json()) as {
          new_id?: string;
          display_name?: string;
          is_operator?: boolean;
          reactivate?: boolean;
        };
        const result = patchUser(targetId, body);
        return adminJson(result);
      } catch (e) {
        return adminErr(e);
      }
    }

    if (!sub && method === "DELETE") {
      try {
        const url = new URL(req.url);
        const purge = url.searchParams.get("purge") === "1";
        const result = deleteUser(targetId, { purge });
        return adminJson(result);
      } catch (e) {
        return adminErr(e);
      }
    }
  }

  return null;
}

function shareFailure(reason: string): Response {
  // Deliberately terse to avoid info leak. 410 Gone for expired, 404 for the rest.
  if (reason === "expired") {
    return new Response("link expired", { status: 410, headers: { "Cache-Control": "no-store" } });
  }
  return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

function text(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...extraHeaders } });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="folio-cloud"' });
}

function notFound(msg = "not found"): Response {
  return json({ error: msg }, 404);
}

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

function serverError(msg: string): Response {
  return json({ error: msg }, 500);
}

function jsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

async function readJsonBody<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) throw new Error("empty body");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("invalid JSON body");
  }
}

export interface CloudServerOptions {
  port?: number;
  hostname?: string;
  publicUrl?: string;
}

export function startCloudServer(opts: CloudServerOptions = {}): ReturnType<typeof Bun.serve> {
  // Initialize DB eagerly so a missing /var/lib/folio-cloud surfaces immediately.
  cloudDb();
  const port = opts.port ?? Number(process.env.FOLIO_CLOUD_PORT ?? 8081);
  const hostname = opts.hostname ?? process.env.FOLIO_CLOUD_HOST ?? "127.0.0.1";
  const publicUrl = (opts.publicUrl ?? process.env.FOLIO_CLOUD_PUBLIC_URL ?? `http://${hostname}:${port}`).replace(/\/+$/, "");

  return Bun.serve({
    hostname,
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // Capability URLs — public read access to a single note or thread
      // gated by a bearer-style token in the URL path. Token is the
      // credential; server validates on every hit. Atomic view_count bump
      // happens after the response is rendered (caller chooses idempotency).
      if (path.startsWith("/p/")) {
        return handleCapabilityRoute(req, path, method, publicUrl);
      }

      // Auth: public paths skip; everything else needs a valid bearer.
      // SSE live-stream is a special case: EventSource can't send custom
      // headers (browser API), so the token rides in a query param. We
      // accept either header or query param ONLY for that route, and only
      // for that route — every other path stays bearer-header-only.
      let device: Device | null = null;
      if (!isPublicPath(path)) {
        let token = extractBearer(req);
        if (!token && path === "/v1/sync/live-stream") {
          token = url.searchParams.get("token");
        }
        if (!token) return unauthorized();
        device = authenticate(token);
        if (!device) return unauthorized();
      }

      try {
        // ----- Public paths -----
        if (path === "/healthz") return json({ ok: true });

        if (path === "/v1/version") {
          return json({ name: "folio-cloud", version: pkg.version, public_url: publicUrl });
        }

        if (path === "/manifest.webmanifest") {
          return new Response(JSON.stringify(manifestJson(publicUrl), null, 2), {
            status: 200,
            headers: {
              "Content-Type": "application/manifest+json; charset=utf-8",
              "Cache-Control": "public, max-age=300",
            },
          });
        }

        if (path === "/sw.js") {
          return new Response(serviceWorkerJs(), {
            status: 200,
            headers: {
              "Content-Type": "application/javascript; charset=utf-8",
              "Service-Worker-Allowed": "/",
              "Cache-Control": "no-cache",
            },
          });
        }

        if (path === "/icons/folio.svg") {
          return new Response(FOLIO_ICON_SVG, {
            status: 200,
            headers: {
              "Content-Type": "image/svg+xml; charset=utf-8",
              "Cache-Control": "public, max-age=86400, immutable",
            },
          });
        }

        if (path === "/" && method === "GET") {
          return new Response(renderHome(publicUrl), {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (path === "/pair" && method === "GET") {
          return new Response(renderPair(publicUrl), {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        if (path === "/v1/auth/pair" && method === "POST") {
          const body = await readJsonBody<{ code?: string; device_name?: string; device_id?: string }>(req);
          if (!body.code) return badRequest("code required");
          if (!body.device_name) return badRequest("device_name required");
          try {
            const { deviceId, token } = consumePairingCode(body.code, body.device_name, body.device_id);
            return json({ device_id: deviceId, token });
          } catch (e: any) {
            return badRequest(e?.message ?? "pairing failed");
          }
        }

        // /n/:uuid — public JS shell. Reads bearer token from IDB client-side
        // and fetches /raw/:uuid with auth. Outer page exposes nothing
        // beyond the uuid that's already in the URL.
        {
          const m = path.match(/^\/n\/([0-9A-Za-z-]+)$/);
          if (m && method === "GET") {
            return new Response(renderNotePage(m[1]!, ""), {
              status: 200,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
        }

        // /t/:thread_id/asset/:filename — PUBLIC asset bytes. Lookup is
        // (thread_id, filename) → assets table → blob_path on disk. Why
        // public: notes referenced assets via this URL pattern from local
        // viewer, and sub-resource fetches from null-origin sandboxed
        // iframes can't reliably carry bearer headers. URLs aren't trivially
        // enumerable (need to know both thread_id slug and filename),
        // matching the local viewer's posture.
        // /u/:user/t/:thread/asset/:filename — per-user public asset route
        // (v0.13+). Pinned to user_id so two users with the same
        // (thread, filename) never serve each other's bytes. Iframe srcs in
        // newly-rendered notes use this path via renderStandaloneNote's
        // rewrite. Public (no bearer) for the same reason as the legacy
        // /t/.../asset/... route: sub-resource fetches from sandboxed null-
        // origin iframes can't reliably carry Authorization headers.
        {
          const m = path.match(/^\/u\/([^/]+)\/t\/([^/]+)\/asset\/([^/]+)$/);
          if (m && method === "GET") {
            const userId = decodeURIComponent(m[1]!);
            const threadId = decodeURIComponent(m[2]!);
            const filename = decodeURIComponent(m[3]!);
            const row = cloudDb()
              .query<
                { blob_path: string; content_type: string; size_bytes: number; hash: string },
                [string, string, string]
              >("SELECT blob_path, content_type, size_bytes, hash FROM assets WHERE user_id = ? AND thread_id = ? AND filename = ?")
              .get(userId, threadId, filename);
            if (!row) return notFound("asset not found");
            const a = readAsset(row.hash);
            if (!a) return notFound("asset bytes missing");
            return new Response(a.bytes, {
              status: 200,
              headers: {
                "Content-Type": a.content_type,
                "Content-Length": String(a.size_bytes),
                "Cache-Control": "public, max-age=86400, immutable",
                "X-Content-Type-Options": "nosniff",
              },
            });
          }
        }

        // Legacy /t/<thread>/asset/<file> kept for backward-compat with
        // v0.12 PWAs that still have cached body_html. Resolves only when
        // exactly one user owns the (thread, filename) pair; multi-user
        // collisions return 404 so the iframe falls back to a broken
        // image rather than getting someone else's bytes. New body_html
        // gets the /u/... form via renderStandaloneNote rewrite.
        {
          const m = path.match(/^\/t\/([^/]+)\/asset\/([^/]+)$/);
          if (m && method === "GET") {
            const threadId = decodeURIComponent(m[1]!);
            const filename = decodeURIComponent(m[2]!);
            const rows = cloudDb()
              .query<
                { blob_path: string; content_type: string; size_bytes: number; hash: string },
                [string, string]
              >("SELECT blob_path, content_type, size_bytes, hash FROM assets WHERE thread_id = ? AND filename = ?")
              .all(threadId, filename);
            if (rows.length !== 1) return notFound("asset not found");
            const row = rows[0]!;
            const a = readAsset(row.hash);
            if (!a) return notFound("asset bytes missing");
            return new Response(a.bytes, {
              status: 200,
              headers: {
                "Content-Type": a.content_type,
                "Content-Length": String(a.size_bytes),
                "Cache-Control": "public, max-age=86400, immutable",
                "X-Content-Type-Options": "nosniff",
              },
            });
          }
        }

        // /t/:thread_id — public JS shell, same renderer as /. JS reads
        // location.pathname → /t/<id> and fetches /v1/feed?thread=<id>.
        {
          const m = path.match(/^\/t\/([^/]+)$/);
          if (m && method === "GET") {
            return new Response(renderHome(publicUrl), {
              status: 200,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
        }

        // ----- Authed paths below -----
        if (!device) return unauthorized(); // belt-and-braces; isPublicPath gate above ensures this

        if (path === "/v1/auth/devices" && method === "GET") {
          // Caller only sees their own user's devices (v0.13+).
          return json({ devices: listDevices(device!.userId) });
        }

        // Read-only observability snapshot — see src/cloud/stats.ts. Authed:
        // any paired device can read its OWN USER's metrics. Cross-user
        // numbers stay invisible; operators get the global view via the new
        // /v1/admin/users endpoint below.
        if (path === "/v1/admin/stats" && method === "GET") {
          return json(buildAdminStats(publicUrl, device!.userId));
        }

        // /v1/admin/whoami — any authed device. Lets the local viewer
        // decide whether to render the operator dashboard. Cheap lookup,
        // not gated on is_operator.
        if (path === "/v1/admin/whoami" && method === "GET") {
          return json(whoami(device!));
        }

        // Operator-only mutation surface for managing users from the local
        // viewer's dashboard. 403 if caller's device.isOperator !== true.
        if (path.startsWith("/v1/admin/")) {
          const adminResp = await handleAdminRoute(path, method, req, device!, publicUrl);
          if (adminResp) return adminResp;
        }

        // Already-paired devices can request fresh pairing codes for
        // onboarding additional devices within the SAME user account.
        // Cross-user pairing is operator-only (CLI `folio cloud pair-code
        // --user <other>`). Code carries device.userId so the new device
        // joins the caller's account, never another's.
        if (path === "/v1/auth/pair-code" && method === "POST") {
          const { code, expiresAt, userId } = createPairingCode(device!.userId);
          return json({ code, expires_at: expiresAt, user_id: userId });
        }

        {
          const m = path.match(/^\/v1\/auth\/device\/([^/]+)$/);
          if (m && method === "DELETE") {
            // Cross-user revoke is operator-only; restrict via the API to
            // own-user devices so a compromised bearer can't kick out other
            // users' devices.
            const target = m[1]!;
            const row = cloudDb()
              .query<{ user_id: string }, [string]>("SELECT user_id FROM devices WHERE id = ?")
              .get(target);
            if (!row || row.user_id !== device!.userId) {
              return notFound("device not found");
            }
            revokeDevice(target);
            return json({ revoked: target });
          }
        }

        if (path === "/v1/sync/push" && method === "POST") {
          const payload = await readJsonBody<PushPayload>(req);
          const result = handlePush(payload, device!);
          return json(result);
        }

        // SSE stream of live entries for a single note. Subscribers (PWA,
        // CLI `curl -N …`) get fanout from handlePush whenever a fresh
        // live_entry arrives for that uuid. No historical replay — the
        // caller should fetch /raw/:uuid for the current state and use
        // the stream for what's new SINCE the connection opened.
        if (path === "/v1/sync/live-stream" && method === "GET") {
          const noteUuid = url.searchParams.get("note_uuid");
          if (!noteUuid) return badRequest("note_uuid query param required");
          // Verify the note exists, belongs to caller's user, is live, not
          // finalized. Cross-user subscribe attempts get the same "not found"
          // as truly missing — avoids leaking whether a uuid exists.
          const row = cloudDb()
            .query<{ live: number; is_final: number; user_id: string }, [string]>(
              "SELECT live, is_final, user_id FROM notes WHERE uuid = ?"
            )
            .get(noteUuid);
          if (!row || row.user_id !== device!.userId) return notFound("note not found");
          if (row.live !== 1) return badRequest("note is not a live note");
          if (row.is_final === 1) return badRequest("note is finalized");

          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              // Initial "ready" so the client knows the connection is live.
              controller.enqueue(enc.encode(":ok\n\n"));
              const unsub = subscribeLiveStream(noteUuid, (frame) => {
                try {
                  // event: entry — matches what the local viewer emits, so
                  // client code can be shared.
                  const data = JSON.stringify(frame);
                  controller.enqueue(enc.encode(`event: entry\nid: ${frame.id}\ndata: ${data}\n\n`));
                } catch {
                  // controller closed; unsubscribe handled by cancel below.
                }
              });
              // Heartbeat every 25s — keeps proxies from idling out the
              // connection on quiet streams (Caddy default is ~60s).
              const heartbeat = setInterval(() => {
                try { controller.enqueue(enc.encode(":hb\n\n")); } catch {}
              }, 25_000);
              (controller as any)._folioCleanup = () => {
                clearInterval(heartbeat);
                unsub();
              };
            },
            cancel() {
              // Cancel fires when the client disconnects. Tear down the
              // subscription so the channel can be GC'd.
              const ctrl = this as any;
              if (ctrl._folioCleanup) ctrl._folioCleanup();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no", // disable buffering at nginx if present
              Connection: "keep-alive",
            },
          });
        }

        if (path === "/v1/sync/pull" && method === "GET") {
          const since = Number(url.searchParams.get("since") ?? 0);
          if (!Number.isFinite(since) || since < 0) return badRequest("invalid since cursor");
          return json(handlePull(since, device!));
        }

        // ---- Shares (capability URL admin) ----
        if (path === "/v1/share" && method === "POST") {
          const body = await readJsonBody<{
            scope_type?: "note" | "thread" | "set";
            scope_id?: string;
            expires_in_days?: number | null;
            max_views?: number | null;
            recipient_email_hash?: string | null;
            /** Plaintext email — used ONLY to send the invite; the cloud
             *  derives + persists the hash and discards the plaintext when
             *  the mailer returns. If recipient_email_hash is also provided
             *  it MUST match the hash of recipient_email (defensive client). */
            recipient_email?: string | null;
            /** v0.34: opt-in — let recipients register a variant preference. */
            allow_pick?: boolean;
          }>(req);
          if (body.scope_type !== "note" && body.scope_type !== "thread" && body.scope_type !== "set") {
            return badRequest("scope_type must be 'note', 'thread', or 'set'");
          }
          if (!body.scope_id) return badRequest("scope_id required");
          // If the caller sent a plaintext email, derive the hash here so
          // we don't trust the client to be consistent with itself. If
          // BOTH are supplied, reject mismatched pairs (defensive against
          // bug-or-tamper). Plaintext lives only in this stack frame +
          // outbound mailer call.
          let recipientEmail: string | null = null;
          let recipientEmailHash: string | null = body.recipient_email_hash ?? null;
          if (body.recipient_email && body.recipient_email.trim()) {
            recipientEmail = body.recipient_email.trim().toLowerCase();
            const derived = createHash("sha256").update(recipientEmail, "utf8").digest("hex");
            if (recipientEmailHash && recipientEmailHash !== derived) {
              return badRequest("recipient_email and recipient_email_hash disagree");
            }
            recipientEmailHash = derived;
          }
          try {
            const share = createShare({
              user_id: device!.userId,
              scope_type: body.scope_type,
              scope_id: body.scope_id,
              created_by_device: device!.id,
              expires_in_days: body.expires_in_days ?? DEFAULT_SHARE_EXPIRES_DAYS,
              max_views: body.max_views ?? null,
              recipient_email_hash: recipientEmailHash,
              allow_pick: body.allow_pick === true,
            });
            // 'set' shares enter at the root note (same /n/ path as a note
            // share); only thread shares use the /t/ landing.
            const scopePath =
              share.scope_type === "thread"
                ? `/p/${share.token}/t/${share.scope_id}`
                : `/p/${share.token}/n/${share.scope_id}`;
            const url = `${publicUrl}${scopePath}`;
            // Send the invite if (a) the caller gave us a plaintext email
            // AND (b) a mailer is configured. We return the mailer outcome
            // in the response so the CLI can surface a clear success/skip
            // line — but we don't fail the whole share creation if the
            // mailer is offline; the share itself is already persisted.
            let email_sent = false;
            let email_skipped: "no-mailer" | "no-recipient" | null = null;
            let email_error: string | null = null;
            if (!recipientEmail) {
              email_skipped = "no-recipient";
            } else {
              const mailer = getMailer();
              if (!mailer) {
                email_skipped = "no-mailer";
              } else {
                const msg = renderShareEmail({
                  url,
                  recipient: recipientEmail,
                  scope_type: share.scope_type,
                  expires_at: share.expires_at,
                });
                const result = await mailer.send({
                  to: recipientEmail,
                  subject: msg.subject,
                  html: msg.html,
                  text: msg.text,
                });
                if (result.ok) email_sent = true;
                else email_error = result.error ?? "mailer returned not-ok";
              }
            }
            // For a 'set' share, report how many notes the bundle grants
            // (root + linked) so the caller can show "shared N notes".
            const note_count = share.scope_type === "set"
              ? (cloudDb().query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM share_notes WHERE token = ?").get(share.token)?.n ?? 1)
              : 1;
            return json({
              token: share.token,
              url,
              scope_type: share.scope_type,
              scope_id: share.scope_id,
              note_count,
              created_at: share.created_at,
              expires_at: share.expires_at,
              max_views: share.max_views,
              allow_pick: share.allow_pick,
              email_sent,
              email_skipped,
              email_error,
              mailer_configured: isMailerConfigured(),
            });
          } catch (e: any) {
            return badRequest(e?.message ?? "share creation failed");
          }
        }

        {
          const m = path.match(/^\/v1\/share\/([A-Za-z0-9_\-]+)$/);
          if (m && method === "DELETE") {
            // Only the owning user may revoke. Cross-user revoke attempts
            // return the same "not found" path as truly missing tokens.
            const target = m[1]!;
            const owned = cloudDb()
              .query<{ user_id: string }, [string]>("SELECT user_id FROM shares WHERE token = ?")
              .get(target);
            if (!owned || owned.user_id !== device!.userId) {
              return json({ revoked: null });
            }
            const ok = revokeShare(target);
            return json({ revoked: ok ? target : null });
          }
        }

        if (path === "/v1/shares" && method === "GET") {
          const scope_id = url.searchParams.get("scope_id") ?? undefined;
          const shares = listShares({
            user_id: device!.userId,
            scope_id: scope_id ?? undefined,
            created_by_device: device!.id,
          });
          return json({
            shares: shares.map((s) => ({
              token: s.token,
              url: `${publicUrl}/p/${s.token}/${s.scope_type === "thread" ? "t" : "n"}/${s.scope_id}`,
              scope_type: s.scope_type,
              scope_id: s.scope_id,
              created_at: s.created_at,
              expires_at: s.expires_at,
              max_views: s.max_views,
              view_count: s.view_count,
              allow_pick: s.allow_pick,
              // v0.34: recipient variant preferences for this share (soft
              // signal). Empty unless allow_pick + someone has chosen.
              picks: s.allow_pick ? getSharePicks(s.token) : [],
            })),
          });
        }

        if (path === "/v1/feed" && method === "GET") {
          // Lightweight list for the PWA home screen — no body_html.
          // Supports two optional filters:
          //   ?q=<query>     — case-insensitive LIKE across title + plain_text
          //   ?thread=<id>   — exact thread_id match
          // Always scoped to caller's user_id. Cross-user notes invisible.
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
          const q = (url.searchParams.get("q") ?? "").trim();
          const thread = (url.searchParams.get("thread") ?? "").trim();
          const where: string[] = ["user_id = ?"];
          const params: any[] = [device!.userId];
          if (q) {
            // Tokenize on whitespace; require every token match in title OR plain_text.
            // ESCAPE \\ for LIKE so a literal % or _ from the user doesn't wildcard.
            for (const tok of q.split(/\s+/).filter(Boolean)) {
              where.push(
                "(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(plain_text) LIKE ? ESCAPE '\\')"
              );
              const needle = "%" + tok.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%";
              params.push(needle, needle);
            }
          }
          if (thread) {
            where.push("thread_id = ?");
            params.push(thread);
          }
          const whereClause = `WHERE ${where.join(" AND ")}`;
          const sql =
            `SELECT uuid, slug, title, type, theme, thread_id, created_at, updated_at, is_final, live` +
            ` FROM notes ${whereClause} ORDER BY created_at DESC LIMIT ?`;
          const notes = cloudDb()
            .query<
              {
                uuid: string;
                slug: string;
                title: string;
                type: string;
                theme: string;
                thread_id: string;
                created_at: string;
                updated_at: string;
                is_final: number;
                live: number;
              },
              any[]
            >(sql)
            .all(...params, limit);
          const threads = cloudDb()
            .query<{ thread_id: string; count: number; latest: string }, [string]>(
              `SELECT thread_id, COUNT(*) AS count, MAX(created_at) AS latest
                 FROM notes WHERE user_id = ? GROUP BY thread_id ORDER BY latest DESC LIMIT 50`
            )
            .all(device!.userId);
          return json({
            notes: notes.map((n) => ({
              uuid: n.uuid,
              slug: n.slug,
              title: n.title,
              type: n.type,
              theme: n.theme,
              thread_id: n.thread_id,
              created_at: n.created_at,
              updated_at: n.updated_at,
              is_final: n.is_final === 1,
              live: n.live === 1,
            })),
            threads,
            query: q || undefined,
            thread: thread || undefined,
            sw_version: SW_VERSION,
          });
        }

        {
          const m = path.match(/^\/v1\/sync\/assets\/([a-f0-9]{64})$/);
          if (m) {
            const hash = m[1]!;
            if (method === "POST") {
              const filename = req.headers.get("x-folio-filename");
              const threadId = req.headers.get("x-folio-thread-id");
              if (!filename) return badRequest("x-folio-filename header required");
              if (!threadId) return badRequest("x-folio-thread-id header required");
              const bytes = new Uint8Array(await req.arrayBuffer());
              try {
                const result = storeAsset(hash, filename, threadId, bytes, device!.userId);
                return json(result);
              } catch (e: any) {
                return badRequest(e?.message ?? "asset upload failed");
              }
            }
            if (method === "HEAD") {
              const a = readAsset(hash);
              if (!a) return new Response(null, { status: 404 });
              return new Response(null, {
                status: 200,
                headers: { "Content-Type": a.content_type, "Content-Length": String(a.size_bytes) },
              });
            }
            if (method === "GET") {
              const a = readAsset(hash);
              if (!a) return notFound("asset not found");
              return new Response(a.bytes, {
                status: 200,
                headers: {
                  "Content-Type": a.content_type,
                  "Content-Length": String(a.size_bytes),
                  "Cache-Control": "public, max-age=86400, immutable",
                },
              });
            }
          }
        }

        // (/n/:uuid handled above as public route — see comment near auth gate.)

        {
          const m = path.match(/^\/raw\/([0-9A-Za-z-]+)$/);
          if (m && method === "GET") {
            // Scoped to caller's user — cross-user /raw/<uuid> requests get
            // the same "not found" as a truly missing uuid.
            const row = cloudDb()
              .query<
                { uuid: string; title: string; theme: string; type: string; body_html: string; live: number; is_final: number; inline_render: number },
                [string, string]
              >(
                "SELECT uuid, title, theme, type, body_html, live, is_final, inline_render FROM notes WHERE uuid = ? AND user_id = ?"
              )
              .get(m[1]!, device!.userId);
            if (!row) return notFound("note not found");
            let bodyHtml = row.body_html;
            // v0.18 iteration notes: cloud renders the same gallery the
            // local viewer does, but read-only — pick happens on the
            // device that owns the note (no /iter/pick endpoint on cloud).
            // We share the renderer + state-compute helpers with the
            // local viewer; entries come from `live_entries` mirrored
            // up by sync. Skip when finalized — final iteration notes
            // have body_html compiled in Phase 6 and render like any
            // static note.
            if (row.type === "iteration" && row.is_final === 0) {
              const cloudEntries = cloudDb()
                .query<{ id: string; ts: string; content_html: string; tags_json: string; refs_json: string; source_ref: string | null }, [string]>(
                  "SELECT id, ts, content_html, tags_json, refs_json, source_ref FROM live_entries WHERE note_uuid = ? ORDER BY ts ASC"
                )
                .all(row.uuid)
                .map((e) => ({
                  id: e.id,
                  ts: e.ts,
                  content_html: e.content_html,
                  plain: "",
                  tags: jsonArray(e.tags_json),
                  refs: jsonArray(e.refs_json),
                  source_ref: e.source_ref ?? undefined,
                }));
              const { computeIterationState } = await import("../core/iteration");
              const { renderIterationRaw, extractChrome } = await import("../viewer/iteration-render");
              const state = computeIterationState(row.uuid, cloudEntries as any, false);
              const chrome = extractChrome(bodyHtml);
              const iterFragment = renderIterationRaw({
                noteId: row.uuid,
                title: row.title,
                chromeHtml: chrome,
                state,
                readonly: true,
              });
              bodyHtml = bodyHtml.replace(
                /(<article[^>]*data-folio-content[^>]*>)([\s\S]*?)(<\/article>)/,
                (_m, open, _content, close) => `${open}${iterFragment}${close}`
              );
            }
            // v0.17 inline-rendered live notes: splice the cloud-side
            // live_entries into <section data-folio-live-feed> on every
            // serve. New entries during the session arrive via the PWA
            // shell's SSE → postMessage forward (same bootstrap script
            // appended below).
            if (row.live === 1 && row.inline_render === 1 && row.is_final === 0) {
              const cloudEntries = cloudDb()
                .query<{ id: string; ts: string; content_html: string; tags_json: string; occurred_at: string | null; refs_json: string; importance: number | null; source_ref: string | null }, [string]>(
                  "SELECT id, ts, content_html, tags_json, occurred_at, refs_json, importance, source_ref FROM live_entries WHERE note_uuid = ? ORDER BY ts ASC"
                )
                .all(row.uuid)
                .map((e) => ({
                  id: e.id,
                  ts: e.ts,
                  content_html: e.content_html,
                  tags: jsonArray(e.tags_json),
                  occurred_at: e.occurred_at,
                  refs: jsonArray(e.refs_json),
                  importance: e.importance,
                  source_ref: e.source_ref,
                }));
              const { compileRendered } = await import("../core/live");
              const { renderFeedHtml, spliceFeedIntoBody } = await import("../core/feed-render");
              const compiled = compileRendered(cloudEntries as any);
              bodyHtml = spliceFeedIntoBody(bodyHtml, renderFeedHtml(compiled));
            }
            // Expose live/is_final/inline via response headers so the
            // /n/:uuid PWA shell can decide whether to open SSE + whether
            // to postMessage entries down to the body iframe.
            const headers: Record<string, string> = {
              ...rawNoteHeaders(),
              "X-Folio-Live": row.live === 1 ? "1" : "0",
              "X-Folio-Final": row.is_final === 1 ? "1" : "0",
              "X-Folio-Inline": row.inline_render === 1 ? "1" : "0",
            };
            let html = renderStandaloneNote({
              title: row.title,
              theme: row.theme,
              bodyHtml,
              userId: device!.userId,
            });
            // Append the bootstrap script (matches viewer/server.ts pattern).
            if (row.live === 1 && row.inline_render === 1 && row.is_final === 0) {
              const { INLINE_FEED_BOOTSTRAP_JS } = await import("../core/feed-render");
              html = html.replace("</body>", `<script>${INLINE_FEED_BOOTSTRAP_JS}</script></body>`);
            }
            return new Response(html, { status: 200, headers });
          }
        }

        {
          // Authed JSON thread listing — scoped to caller's user. The
          // earlier public /t/:thread_id route (above the auth gate) returns
          // the HTML shell for any caller; this JSON variant runs only when
          // a bearer token reached the authed block.
          const m = path.match(/^\/t\/([^/]+)$/);
          if (m && method === "GET") {
            const notes = cloudDb()
              .query<{ uuid: string; title: string; created_at: string }, [string, string]>(
                "SELECT uuid, title, created_at FROM notes WHERE thread_id = ? AND user_id = ? ORDER BY created_at DESC"
              )
              .all(m[1]!, device!.userId);
            return json({ thread_id: m[1], notes });
          }
        }

        return notFound();
      } catch (e: any) {
        if (process.env.FOLIO_DEBUG) console.error("[folio-cloud]", e);
        return serverError(e?.message ?? "internal error");
      }
    },
  });
}
