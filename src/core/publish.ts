/**
 * Share creation against the paired cloud (`POST /v1/share`), shared by the
 * MCP `publish` tool and `folio publish`.
 *
 * sc-7749: since v0.43.0 `create` tells the agent to call `publish` right
 * away, but the new note only reaches the cloud with the next sync tick. The
 * cloud then answered `400 note not found`, which reads as "sharing is
 * broken" — the agent gave up and sent the 127.0.0.1 link instead. So when
 * the cloud does not know the scope yet, we force a sync ourselves and retry
 * until a deadline; when the cloud does not answer at all, the error says to
 * try again in a moment instead of leaking a misleading "not found".
 */

import { acquireLock, releaseLock, loadSyncState, syncOnce, LockHeldError, type SyncState } from "./sync";

export type PublishOutcome =
  | { ok: true; body: any; syncs: number; attempts: number }
  | {
      ok: false;
      /** not_synced: cloud still doesn't have the note/thread at the deadline.
       *  unreachable: no answer / 5xx from the cloud until the deadline.
       *  rejected: any other cloud error — returned as-is, no retry. */
      kind: "not_synced" | "unreachable" | "rejected";
      status: number | null;
      message: string;
      syncs: number;
      attempts: number;
    };

export interface PublishOptions {
  /** Total time budget for sync + retry. Default 30 s (observed lag ~15 s). */
  timeoutMs?: number;
  /** Per-request timeout for a single POST /v1/share. Default 10 s. */
  requestTimeoutMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  /** Returns true when it pushed, false when another syncer holds the lock. */
  syncStep?: (state: SyncState) => Promise<boolean>;
  onWait?: (reason: "not_synced" | "unreachable", attempt: number) => void;
}

export const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;

/** Cloud's createShare errors for a scope it hasn't received yet. */
const NOT_SYNCED_RE = /\b(note not found|thread not found or empty)\b/i;

export function isNotSyncedError(status: number, detail: string): boolean {
  return (status === 400 || status === 404) && NOT_SYNCED_RE.test(detail);
}

function cloudErrorText(detail: string): string {
  try {
    const j = JSON.parse(detail);
    if (j && typeof j.error === "string") return j.error;
  } catch {}
  return detail.slice(0, 200);
}

/** Push local notes now. A held lock means another syncer (daemon, auto-sync
 *  tick) is mid-sync and will push the note itself — just wait for it. */
async function defaultSyncStep(state: SyncState): Promise<boolean> {
  try {
    acquireLock();
  } catch (e) {
    if (e instanceof LockHeldError) return false;
    throw e;
  }
  try {
    // Re-read: a daemon may have advanced the cursors since we loaded it.
    await syncOnce(loadSyncState() ?? state);
    return true;
  } finally {
    releaseLock();
  }
}

export async function createShareSynced(
  state: SyncState,
  body: Record<string, unknown>,
  opts: PublishOptions = {}
): Promise<PublishOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const syncStep = opts.syncStep ?? defaultSyncStep;
  const deadline = Date.now() + timeoutMs;
  const scope = `${String(body.scope_type ?? "note")} ${String(body.scope_id ?? "")}`;

  let attempts = 0;
  let syncs = 0;
  let backoff = 500;
  let lastKind: "not_synced" | "unreachable" = "not_synced";
  let lastStatus: number | null = null;
  let lastDetail = "";

  for (;;) {
    attempts++;
    let res: Response | null = null;
    try {
      res = await fetch(`${state.remote}/v1/share`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.device_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        // Not clamped to the deadline: the final look after the deadline
        // still deserves a real answer, or a slow-but-alive cloud would be
        // misreported as unreachable. Worst case = timeoutMs + requestTimeoutMs.
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (e: any) {
      lastKind = "unreachable";
      lastStatus = null;
      lastDetail = e?.name === "TimeoutError" ? "no response" : (e?.message ?? String(e));
    }

    if (res) {
      if (res.ok) return { ok: true, body: await res.json(), syncs, attempts };
      let detail = "";
      try { detail = await res.text(); } catch {}
      lastStatus = res.status;
      lastDetail = cloudErrorText(detail);
      if (isNotSyncedError(res.status, detail)) {
        lastKind = "not_synced";
      } else if (res.status >= 500) {
        lastKind = "unreachable";
      } else {
        return {
          ok: false,
          kind: "rejected",
          status: res.status,
          message: `publish failed: HTTP ${res.status} ${lastDetail}`,
          syncs,
          attempts,
        };
      }
    }

    if (Date.now() >= deadline) break;
    opts.onWait?.(lastKind, attempts);

    let synced = false;
    if (lastKind === "not_synced") {
      try {
        synced = await syncStep(state);
        if (synced) syncs++;
      } catch (e: any) {
        // Sync couldn't reach the cloud either — keep retrying to the deadline.
        lastKind = "unreachable";
        lastStatus = null;
        lastDetail = e?.message ?? String(e);
      }
    }
    // Right after our own push, retry almost at once; otherwise back off.
    // Past the deadline the next POST is the last one.
    await sleep(synced ? 100 : Math.min(backoff, Math.max(0, deadline - Date.now())));
    if (!synced) backoff = Math.min(backoff * 2, 4000);
  }

  const secs = Math.round(timeoutMs / 1000);
  if (lastKind === "not_synced") {
    return {
      ok: false,
      kind: "not_synced",
      status: lastStatus,
      message:
        `publish failed: ${scope} is not in the cloud yet — sync still in progress after ${secs}s. ` +
        `Try again in a moment; the note exists locally and sharing works once sync catches up.`,
      syncs,
      attempts,
    };
  }
  return {
    ok: false,
    kind: "unreachable",
    status: lastStatus,
    message:
      `publish failed: cloud ${state.remote} is not responding (${lastStatus ? `HTTP ${lastStatus}` : lastDetail}). ` +
      `Try again in a moment.`,
    syncs,
    attempts,
  };
}
