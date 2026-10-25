/**
 * Capability-URL shares for the cloud relay.
 *
 * Model: a "share" is a randomly-generated bearer token (32 bytes b64url)
 * that grants read access to a single resource — either one note or one
 * thread. The URL is the credential. Anyone who has the URL can read,
 * for as long as the share is non-expired, non-revoked, and within
 * max_views.
 *
 * Threat model trade-offs:
 *   - Capability URLs leak. Referer headers, server logs, browser history,
 *     threat-intel scanners. Mitigation: short default expiry (7 days),
 *     optional max_views, server emits Referrer-Policy: no-referrer +
 *     X-Robots-Tag: noindex so the URL stays out of search indexes and
 *     external Referer logs.
 *   - 32 random bytes = 256 bits → brute-force infeasible. Plus rate
 *     limiting at the proxy layer if abuse appears.
 *   - Scope check enforced server-side. A note-scoped token cannot access
 *     other notes or threads. A thread-scoped token can access any note
 *     within that thread but no other thread.
 *
 * Storage: src/cloud/db.ts shares table (schema-ready since W1).
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { cloudDb } from "./db";

export interface Share {
  token: string;
  user_id: string;
  scope_type: "note" | "thread" | "set";
  scope_id: string;
  created_by_device: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  recipient_email_hash: string | null;
  max_views: number | null;
  view_count: number;
  /** v0.34: when true, recipients may register a soft variant preference
   *  (POST /p/:token/pick). Opt-in per share; default false (read-only). */
  allow_pick: boolean;
}

export function generateShareToken(): string {
  // 32 bytes = 256 bits. base64url with no padding fits a URL cleanly.
  return randomBytes(32).toString("base64url");
}

/** Pull /n/<id> note links out of a body_html blob — the root-relative links
 *  the agent is told to write (and that the viewer breaks out of the iframe).
 *  We collect candidates loosely; the membership query rejects non-notes. */
const NOTE_LINK_RE = /\/n\/([0-9A-Za-z][0-9A-Za-z-]{7,})/g;

/**
 * Compute the note uuids reachable from a root note by following /n/<id>
 * links in note bodies — transitively, bounded by maxDepth + cap. Only notes
 * owned by `userId` are followed/included (no cross-user leak). Returns uuids
 * EXCLUDING the root (the caller adds it). Snapshot over the current cloud
 * bodies; re-share to refresh. The cap stops a hub from accidentally sharing
 * half the graph.
 */
export function computeLinkedNoteSet(
  rootUuid: string,
  userId: string,
  db: Database = cloudDb(),
  opts: { maxDepth?: number; cap?: number } = {}
): string[] {
  const maxDepth = opts.maxDepth ?? 3;
  const cap = opts.cap ?? 50;
  const seen = new Set<string>([rootUuid]);
  const out: string[] = [];
  let frontier: string[] = [rootUuid];
  for (let depth = 0; depth < maxDepth && frontier.length > 0 && out.length < cap; depth++) {
    const next: string[] = [];
    for (const uuid of frontier) {
      const row = db
        .query<{ body_html: string }, [string, string]>(
          "SELECT body_html FROM notes WHERE uuid = ? AND user_id = ?"
        )
        .get(uuid, userId);
      if (!row) continue;
      NOTE_LINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = NOTE_LINK_RE.exec(row.body_html)) !== null) {
        const id = m[1]!;
        if (seen.has(id)) continue;
        seen.add(id);
        const exists = db
          .query<{ uuid: string }, [string, string]>("SELECT uuid FROM notes WHERE uuid = ? AND user_id = ?")
          .get(id, userId);
        if (!exists) continue; // dangling/foreign link — skip, don't leak
        out.push(id);
        next.push(id);
        if (out.length >= cap) break;
      }
      if (out.length >= cap) break;
    }
    frontier = next;
  }
  return out;
}

export interface CreateShareInput {
  user_id: string;
  scope_type: "note" | "thread" | "set";
  scope_id: string;
  created_by_device: string;
  expires_in_days?: number | null;
  max_views?: number | null;
  recipient_email_hash?: string | null;
  /** v0.34: opt-in — allow share recipients to register a variant preference. */
  allow_pick?: boolean;
}

export function createShare(input: CreateShareInput, db: Database = cloudDb()): Share {
  // Verify the scope target exists AND belongs to the share creator's user.
  // Don't issue a share for a phantom note or for another user's note
  // (the latter would be an authorization bypass).
  let setMembers: string[] = [];
  if (input.scope_type === "note") {
    const exists = db
      .query<{ uuid: string; user_id: string }, [string]>("SELECT uuid, user_id FROM notes WHERE uuid = ?")
      .get(input.scope_id);
    if (!exists) throw new Error(`note not found: ${input.scope_id}`);
    if (exists.user_id !== input.user_id) throw new Error(`note not found: ${input.scope_id}`);
  } else if (input.scope_type === "thread") {
    const count = db
      .query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND thread_id = ?")
      .get(input.user_id, input.scope_id);
    if (!count || count.n === 0) throw new Error(`thread not found or empty: ${input.scope_id}`);
  } else if (input.scope_type === "set") {
    // Root note must exist + belong to the user. The set = root + the notes
    // it links to (transitive, bounded), snapshotted at create time below.
    const root = db
      .query<{ uuid: string; user_id: string }, [string]>("SELECT uuid, user_id FROM notes WHERE uuid = ?")
      .get(input.scope_id);
    if (!root || root.user_id !== input.user_id) throw new Error(`note not found: ${input.scope_id}`);
    setMembers = computeLinkedNoteSet(input.scope_id, input.user_id, db);
  } else {
    throw new Error(`invalid scope_type: ${input.scope_type}`);
  }

  const token = generateShareToken();
  const now = new Date().toISOString();
  const expiresAt =
    typeof input.expires_in_days === "number" && input.expires_in_days > 0
      ? new Date(Date.now() + input.expires_in_days * 86400_000).toISOString()
      : null;
  db.run(
    `INSERT INTO shares (
       token, user_id, scope_type, scope_id, created_by_device, created_at,
       expires_at, revoked_at, recipient_email_hash, max_views, view_count, allow_pick
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?)`,
    [
      token,
      input.user_id,
      input.scope_type,
      input.scope_id,
      input.created_by_device,
      now,
      expiresAt,
      input.recipient_email_hash ?? null,
      input.max_views ?? null,
      input.allow_pick ? 1 : 0,
    ]
  );
  if (input.scope_type === "set") {
    // Snapshot membership: root + every linked note. PK dedupes.
    const ins = db.query("INSERT OR IGNORE INTO share_notes (token, note_uuid) VALUES (?, ?)");
    ins.run(token, input.scope_id);
    for (const uuid of setMembers) ins.run(token, uuid);
  }
  return {
    token,
    user_id: input.user_id,
    scope_type: input.scope_type,
    scope_id: input.scope_id,
    created_by_device: input.created_by_device,
    created_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    recipient_email_hash: input.recipient_email_hash ?? null,
    max_views: input.max_views ?? null,
    view_count: 0,
    allow_pick: input.allow_pick ?? false,
  };
}

export function getShare(token: string, db: Database = cloudDb()): Share | null {
  if (!token || token.length < 16) return null;
  const row = db
    .query<
      {
        token: string;
        user_id: string;
        scope_type: string;
        scope_id: string;
        created_by_device: string;
        created_at: string;
        expires_at: string | null;
        revoked_at: string | null;
        recipient_email_hash: string | null;
        max_views: number | null;
        view_count: number;
        allow_pick: number;
      },
      [string]
    >(
      `SELECT token, user_id, scope_type, scope_id, created_by_device, created_at,
              expires_at, revoked_at, recipient_email_hash, max_views, view_count, allow_pick
         FROM shares WHERE token = ?`
    )
    .get(token);
  if (!row) return null;
  return {
    token: row.token,
    user_id: row.user_id,
    scope_type: row.scope_type as "note" | "thread" | "set",
    scope_id: row.scope_id,
    created_by_device: row.created_by_device,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    recipient_email_hash: row.recipient_email_hash,
    max_views: row.max_views,
    view_count: row.view_count,
    allow_pick: row.allow_pick === 1,
  };
}

export function revokeShare(token: string, db: Database = cloudDb()): boolean {
  const res = db.run(
    "UPDATE shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL",
    [new Date().toISOString(), token]
  );
  return (res.changes ?? 0) > 0;
}

export interface ListSharesOptions {
  user_id?: string;
  scope_id?: string;
  created_by_device?: string;
  include_revoked?: boolean;
}

export function listShares(opts: ListSharesOptions = {}, db: Database = cloudDb()): Share[] {
  const where: string[] = [];
  const params: any[] = [];
  if (!opts.include_revoked) where.push("revoked_at IS NULL");
  if (opts.user_id) {
    where.push("user_id = ?");
    params.push(opts.user_id);
  }
  if (opts.scope_id) {
    where.push("scope_id = ?");
    params.push(opts.scope_id);
  }
  if (opts.created_by_device) {
    where.push("created_by_device = ?");
    params.push(opts.created_by_device);
  }
  const sql =
    `SELECT token, user_id, scope_type, scope_id, created_by_device, created_at,
            expires_at, revoked_at, recipient_email_hash, max_views, view_count, allow_pick
       FROM shares ` +
    (where.length > 0 ? `WHERE ${where.join(" AND ")} ` : "") +
    `ORDER BY created_at DESC`;
  return db
    .query<any, any[]>(sql)
    .all(...params)
    .map((r) => ({
      token: r.token,
      user_id: r.user_id,
      scope_type: r.scope_type,
      scope_id: r.scope_id,
      created_by_device: r.created_by_device,
      created_at: r.created_at,
      expires_at: r.expires_at,
      revoked_at: r.revoked_at,
      recipient_email_hash: r.recipient_email_hash,
      max_views: r.max_views,
      view_count: r.view_count,
      allow_pick: r.allow_pick === 1,
    }));
}

export interface ValidationOk {
  ok: true;
  share: Share;
}
export interface ValidationFail {
  ok: false;
  reason: "not-found" | "revoked" | "expired" | "max-views-exceeded" | "scope-mismatch";
}

/**
 * Walk a note's replace chain forward (this note → whoever superseded it →
 * ...), including the starting uuid, up to `limit` hops, scoped to one user
 * so a chain can never cross into another user's notes. sc-24117: lets a
 * capability token minted for an old revision keep covering the note after
 * `replace` mints a new head — the link format never changes, so access has
 * to follow the chain instead of the token's scope_id staying put.
 */
function forwardChainUuids(startUuid: string, userId: string, db: Database, limit = 50): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = startUuid;
  let hops = 0;
  while (cur && !seen.has(cur) && hops < limit) {
    seen.add(cur);
    chain.push(cur);
    const row = db
      .query<{ superseded_by: string | null }, [string, string]>(
        "SELECT superseded_by FROM notes WHERE uuid = ? AND user_id = ?"
      )
      .get(cur, userId);
    if (!row) break;
    cur = row.superseded_by;
    hops++;
  }
  return chain;
}

/**
 * Validate that `share` can be used to access the requested resource.
 * Does NOT mutate view_count — caller decides when to bump (after a
 * successful render, atomically). This split keeps validation pure.
 */
export function validateShareAccess(
  share: Share | null,
  requested:
    | { type: "note"; uuid: string; thread_id?: string }
    | { type: "thread"; thread_id: string },
  db: Database = cloudDb()
): ValidationOk | ValidationFail {
  if (!share) return { ok: false, reason: "not-found" };
  if (share.revoked_at) return { ok: false, reason: "revoked" };
  if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (share.max_views !== null && share.view_count >= share.max_views) {
    return { ok: false, reason: "max-views-exceeded" };
  }
  // Scope match.
  if (share.scope_type === "note") {
    if (requested.type !== "note") return { ok: false, reason: "scope-mismatch" };
    // sc-24117: beyond the literal scope_id, also allow any uuid reachable
    // by walking scope_id's replace chain forward (the current head, or an
    // intermediate revision) — a `replace` must not 404 an existing share.
    if (
      requested.uuid !== share.scope_id &&
      !forwardChainUuids(share.scope_id, share.user_id, db).includes(requested.uuid)
    ) {
      return { ok: false, reason: "scope-mismatch" };
    }
  } else if (share.scope_type === "set") {
    // Set-scoped: the requested note must be a member of share_notes, OR
    // reachable by walking a member's replace chain forward (sc-24117, same
    // reasoning as the note-scope case above). Threads aren't grantable
    // through a set (it's a note bundle, not a thread).
    if (requested.type !== "note") return { ok: false, reason: "scope-mismatch" };
    const member = db
      .query<{ note_uuid: string }, [string, string]>(
        "SELECT note_uuid FROM share_notes WHERE token = ? AND note_uuid = ?"
      )
      .get(share.token, requested.uuid);
    if (!member) {
      const members = db
        .query<{ note_uuid: string }, [string]>("SELECT note_uuid FROM share_notes WHERE token = ?")
        .all(share.token);
      const reachable = members.some((m) =>
        forwardChainUuids(m.note_uuid, share.user_id, db).includes(requested.uuid)
      );
      if (!reachable) return { ok: false, reason: "scope-mismatch" };
    }
  } else {
    // share is thread-scoped.
    if (requested.type === "thread") {
      if (requested.thread_id !== share.scope_id) return { ok: false, reason: "scope-mismatch" };
    } else {
      // requested.type === "note" — must belong to the scoped thread.
      // Either caller provided thread_id, or we look it up.
      let threadId = requested.thread_id;
      if (!threadId) {
        const row = db
          .query<{ thread_id: string }, [string]>(
            "SELECT thread_id FROM notes WHERE uuid = ?"
          )
          .get(requested.uuid);
        if (!row) return { ok: false, reason: "scope-mismatch" };
        threadId = row.thread_id;
      }
      if (threadId !== share.scope_id) return { ok: false, reason: "scope-mismatch" };
    }
  }
  return { ok: true, share };
}

/** Atomically bump view_count. Call after a successful render of /p/:token/*. */
export function incrementShareViews(token: string, db: Database = cloudDb()): void {
  db.run("UPDATE shares SET view_count = view_count + 1 WHERE token = ?", [token]);
}

export interface SharePick {
  token: string;
  note_uuid: string;
  variant: string;
  label: string | null;
  picked_at: string;
  pick_count: number;
}

/**
 * Record a recipient's variant preference for a shared note. SOFT signal —
 * NOT an authoritative iteration pick (deliberately separate from live_entries
 * / kind:pick). One row per (token, note); last write wins, pick_count tracks
 * how many times the recipient changed their mind. Caller must have already
 * validated that the share is live, allow_pick, and covers `note_uuid`.
 */
export function recordSharePick(
  input: { token: string; note_uuid: string; user_id: string; variant: string; label?: string | null },
  db: Database = cloudDb()
): SharePick {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO share_picks (token, note_uuid, user_id, variant, label, picked_at, pick_count)
       VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(token, note_uuid) DO UPDATE SET
       variant    = excluded.variant,
       label      = excluded.label,
       picked_at  = excluded.picked_at,
       pick_count = pick_count + 1`,
    [input.token, input.note_uuid, input.user_id, input.variant, input.label ?? null, now]
  );
  const row = db
    .query<{ variant: string; label: string | null; picked_at: string; pick_count: number }, [string, string]>(
      "SELECT variant, label, picked_at, pick_count FROM share_picks WHERE token = ? AND note_uuid = ?"
    )
    .get(input.token, input.note_uuid)!;
  return {
    token: input.token,
    note_uuid: input.note_uuid,
    variant: row.variant,
    label: row.label,
    picked_at: row.picked_at,
    pick_count: row.pick_count,
  };
}

/** All recipient picks recorded against a share token (for owner display). */
export function getSharePicks(token: string, db: Database = cloudDb()): SharePick[] {
  return db
    .query<{ note_uuid: string; variant: string; label: string | null; picked_at: string; pick_count: number }, [string]>(
      "SELECT note_uuid, variant, label, picked_at, pick_count FROM share_picks WHERE token = ? ORDER BY picked_at DESC"
    )
    .all(token)
    .map((r) => ({
      token,
      note_uuid: r.note_uuid,
      variant: r.variant,
      label: r.label,
      picked_at: r.picked_at,
      pick_count: r.pick_count,
    }));
}
