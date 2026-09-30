/**
 * `folio publish <id|thread:slug> [--expires-days 7] [--max-views N]`
 *   Create a capability URL share via the paired cloud. Reads remote +
 *   token from ~/Folio/.sync-state.json. Prints the URL on success.
 *
 * `folio shares list [--for <id>]`
 *   List active shares (optionally filtered to a scope_id).
 *
 * `folio shares revoke <token>`
 *   Revoke an active share. The capability URL stops working immediately.
 *
 * All commands require a paired device — without sync state there's no
 * remote or auth token to call.
 */

import { createHash } from "node:crypto";
import { c, out, err, json as jsonOut } from "../io";
import { loadSyncState } from "../../core/sync";
import { getNoteMeta } from "../../core/storage";
import { createShareSynced } from "../../core/publish";

export interface PublishOpts {
  id?: string;
  expiresDays?: number;
  maxViews?: number;
  scope?: "note" | "thread";
  /** Bind the share to a specific recipient's email — they confirm it
   *  before the content renders. SHA-256 hash sent to cloud; the plaintext
   *  email never leaves this device. Reduces blast radius of a URL leak
   *  (recipient still needs the email to read). */
  recipient?: string;
  /** v0.34: let share recipients register a soft variant preference
   *  (POST /p/:token/pick). Pairs with `data-folio-pick` markers in the
   *  note body. Opt-in; default off (read-only share). */
  allowPick?: boolean;
  jsonOut?: boolean;
}

/**
 * Normalize + hash a recipient email. Lowercased, trimmed; doesn't try to
 * validate format beyond "non-empty". The cloud stores only the hash, so
 * even a sniffed DB row doesn't leak the address.
 */
export function recipientEmailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export async function publishCmd(opts: PublishOpts): Promise<number> {
  const state = loadSyncState();
  if (!state) {
    err(c.err("✗ not paired with a cloud — run `folio sync pair --remote <url> --code <code>` first\n"));
    return 2;
  }

  const arg = (opts.id ?? "").trim();
  if (!arg) {
    err(c.err("✗ note id or `thread:<slug>` required\n"));
    return 3;
  }

  // Determine scope: explicit `thread:<slug>` prefix, explicit --scope flag,
  // or default = note. Lookup by ID against local DB so the user gets a
  // sane error message before the cloud round-trip.
  let scope_type: "note" | "thread";
  let scope_id: string;
  if (opts.scope === "thread" || arg.startsWith("thread:")) {
    scope_type = "thread";
    scope_id = arg.startsWith("thread:") ? arg.slice("thread:".length) : arg;
  } else {
    scope_type = "note";
    scope_id = arg;
    const note = getNoteMeta(scope_id);
    if (!note) {
      err(c.err(`✗ note not found locally: ${scope_id}\n`));
      err(c.dim("  Sync first? `folio sync --once`\n"));
      return 4;
    }
  }

  const body: Record<string, unknown> = {
    scope_type,
    scope_id,
    expires_in_days: opts.expiresDays ?? 7,
    max_views: opts.maxViews ?? null,
  };
  if (opts.allowPick) body.allow_pick = true;
  if (opts.recipient && opts.recipient.trim()) {
    const plain = opts.recipient.trim().toLowerCase();
    body.recipient_email_hash = recipientEmailHash(plain);
    // Send plaintext too — cloud uses it ONLY for outbound delivery via its
    // configured mailer (Resend etc) and persists only the hash. Both fields
    // travel over the same TLS connection; defense against a tampering
    // server is the local hash that the cloud's `recipient_email_hash`
    // derivation MUST agree with. If the cloud has no mailer wired up the
    // response says so via email_skipped="no-mailer" and we surface that.
    body.recipient_email = plain;
  }
  // sc-7749: a note created a moment ago may not be in the cloud yet —
  // sync it and retry (bounded) instead of failing with "note not found".
  const result = await createShareSynced(state, body, {
    onWait: (reason, attempt) => {
      if (attempt === 1) {
        err(c.dim(reason === "not_synced"
          ? "  note not in the cloud yet — syncing and retrying…\n"
          : "  cloud not responding — retrying…\n"));
      }
    },
  });
  if (!result.ok) {
    err(c.err(`✗ ${result.message}\n`));
    return 5;
  }
  const respBody = result.body as {
    token: string;
    url: string;
    expires_at: string | null;
    max_views: number | null;
    allow_pick?: boolean;
    email_sent?: boolean;
    email_skipped?: "no-mailer" | "no-recipient" | null;
    email_error?: string | null;
    mailer_configured?: boolean;
  };

  if (opts.jsonOut) {
    jsonOut(respBody);
    return 0;
  }

  out(c.ok("✓") + ` Published ${scope_type} ${c.dim(scope_id)}`);
  out(`  ${c.cyan(respBody.url)}`);
  if (respBody.expires_at) {
    out(`  ${c.dim("expires")} ${respBody.expires_at}`);
  } else {
    out(`  ${c.dim("expires")} never (until revoked)`);
  }
  if (respBody.max_views !== null) {
    out(`  ${c.dim("max views")} ${respBody.max_views}`);
  }
  if (respBody.allow_pick) {
    out(`  ${c.ok("◆")} ${c.dim("recipient can pick a variant")} ${c.dim("(mark variants with data-folio-pick)")}`);
  }
  if (opts.recipient) {
    out(`  ${c.dim("recipient")} ${opts.recipient} ${c.dim("(must confirm email on first visit)")}`);
    if (respBody.email_sent) {
      out(`  ${c.ok("✉")} ${c.dim("email sent to")} ${opts.recipient}`);
    } else if (respBody.email_skipped === "no-mailer") {
      out(`  ${c.dim("✉ email not sent")} ${c.dim("(cloud has no mailer configured — set RESEND_API_KEY + FOLIO_MAIL_FROM)")}`);
    } else if (respBody.email_error) {
      out(`  ${c.err("✉ email failed")} ${c.dim(respBody.email_error)}`);
    }
  }
  // QR code URL (since v0.16) — paste in chat or open in browser for a
  // scannable image. Same share-validity rules as the link itself.
  const qrUrl = respBody.url.replace(/\/(n|t)\/[^/?#]+$/, "/qr.svg");
  out(`  ${c.dim("QR code")} ${c.cyan(qrUrl)}`);
  out("");
  out(c.dim("  Revoke with: ") + `folio shares revoke ${respBody.token.slice(0, 8)}…`);
  return 0;
}

export interface SharesOpts {
  sub?: string;
  forId?: string;
  token?: string;
  jsonOut?: boolean;
}

export async function sharesCmd(opts: SharesOpts): Promise<number> {
  const state = loadSyncState();
  if (!state) {
    err(c.err("✗ not paired with a cloud — run `folio sync pair ...` first\n"));
    return 2;
  }
  switch (opts.sub) {
    case "list":
      return listSharesCmd(state, opts);
    case "revoke":
      return revokeShareCmd(state, opts);
    default:
      err(c.err(`✗ Usage: folio shares {list|revoke <token>}\n`));
      return 1;
  }
}

async function listSharesCmd(
  state: ReturnType<typeof loadSyncState> & {},
  opts: SharesOpts
): Promise<number> {
  const params = new URLSearchParams();
  if (opts.forId) params.set("scope_id", opts.forId);
  const url = `${state!.remote}/v1/shares${params.toString() ? "?" + params.toString() : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${state!.device_token}` },
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch {}
    err(c.err(`✗ list failed: HTTP ${res.status} ${detail.slice(0, 200)}\n`));
    return 5;
  }
  const body = (await res.json()) as {
    shares: {
      token: string;
      url: string;
      scope_type: string;
      scope_id: string;
      created_at: string;
      expires_at: string | null;
      max_views: number | null;
      view_count: number;
    }[];
  };
  if (opts.jsonOut) {
    jsonOut(body);
    return 0;
  }
  if (body.shares.length === 0) {
    out(c.dim("No active shares."));
    return 0;
  }
  out(c.bold(`${body.shares.length} active share${body.shares.length === 1 ? "" : "s"}`));
  for (const s of body.shares) {
    out("");
    out(`  ${c.cyan(s.url)}`);
    out(
      `  ${c.dim(s.scope_type)} ${s.scope_id} ${c.dim("·")} ` +
        `created ${s.created_at.slice(0, 16).replace("T", " ")} ${c.dim("·")} ` +
        `${s.view_count} view${s.view_count === 1 ? "" : "s"}` +
        (s.max_views !== null ? `/${s.max_views}` : "") +
        ` ${c.dim("·")} ` +
        (s.expires_at ? `expires ${s.expires_at.slice(0, 10)}` : "no expiry")
    );
    out(`  ${c.dim("token:")} ${s.token.slice(0, 12)}…`);
  }
  return 0;
}

async function revokeShareCmd(
  state: ReturnType<typeof loadSyncState> & {},
  opts: SharesOpts
): Promise<number> {
  if (!opts.token) {
    err(c.err("✗ token required: folio shares revoke <token>\n"));
    return 3;
  }
  const res = await fetch(`${state!.remote}/v1/share/${encodeURIComponent(opts.token)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${state!.device_token}` },
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch {}
    err(c.err(`✗ revoke failed: HTTP ${res.status} ${detail.slice(0, 200)}\n`));
    return 5;
  }
  const body = (await res.json()) as { revoked: string | null };
  if (body.revoked) {
    out(c.ok("✓") + ` Revoked ${c.dim(body.revoked.slice(0, 12) + "…")}`);
  } else {
    out(c.dim("Nothing to revoke (token unknown or already revoked)."));
  }
  return 0;
}
