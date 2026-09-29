import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { ulid } from "ulid";

export interface FolioConfig {
  theme: string;
  default_lifespan_days: number;
  viewer_port: number;
  viewer_host: string;
  // Public-facing base URL of the viewer when Folio is reverse-proxied
  // (e.g. https://notes.example.com). When set, MCP responses and CLI
  // banners surface this instead of http://127.0.0.1:<port> — important when
  // an agent (bot, Telegram, email) relays the URL to a user who can't reach
  // localhost. Notes themselves keep relative /n/<id> links so they render
  // unchanged behind either base. No trailing slash.
  viewer_public_url?: string;
  /** Stable ULID identifying this device. Generated lazily on first read.
   *  Used by sync daemon (folio sync) to stamp origin_device_id on notes
   *  this device creates, and to recognize foreign notes on pull (skip the
   *  own-echo). Never change once set — the cloud relay associates the
   *  bearer token with this id at pair time. */
  device_id?: string;
  /** Human-readable label for this device. Default = `os.hostname()`. */
  device_name?: string;
  /** Cloud relay remote URL (e.g. https://folio.notibox.ai). Set once when
   *  pairing; sync daemon reads from here unless --remote overrides. */
  sync_remote?: string;
  /** v0.33: when paired, sync in the background automatically — the `folio
   *  serve` viewer runs a periodic push/pull loop, and MCP writes schedule a
   *  debounced sync — so you don't run `folio sync` by hand. Lock-guarded, so
   *  it coexists with a standalone `folio sync` daemon (a tick is skipped if
   *  one is already running). Default on; set false to require explicit sync. */
  auto_sync?: boolean;
}

export const DEFAULT_CONFIG: FolioConfig = {
  theme: "linen",
  default_lifespan_days: 30,
  viewer_port: 4810,
  viewer_host: "127.0.0.1",
  auto_sync: true,
};

export function viewerLocalBaseUrl(cfg: FolioConfig): string {
  return `http://${cfg.viewer_host}:${cfg.viewer_port}`;
}

/**
 * Externally reachable viewer base — the configured `viewer_public_url`
 * (trailing slash stripped), or null when none is set. Never falls back to
 * the local address: anything an agent may relay to a human (MCP
 * `public_url`, `new_public_url`, `stream_url`, the MEDIA hint) must come
 * from here, because http://127.0.0.1:<port> only opens on this machine.
 */
export function viewerShareableBaseUrl(cfg: FolioConfig): string | null {
  const pub = cfg.viewer_public_url?.trim();
  return pub ? pub.replace(/\/+$/, "") : null;
}

/** Base URL for display on this machine (viewer banner): the public base
 *  when configured, else the local one. Not for links sent to people — use
 *  viewerShareableBaseUrl() for those. */
export function viewerPublicBaseUrl(cfg: FolioConfig): string {
  return viewerShareableBaseUrl(cfg) ?? viewerLocalBaseUrl(cfg);
}

export function folioRoot(): string {
  return process.env.FOLIO_HOME ?? join(homedir(), "Folio");
}

export function notesDir(): string {
  return join(folioRoot(), "notes");
}

export function threadsDir(): string {
  return join(folioRoot(), "threads");
}

export function threadAssetsDir(threadId: string): string {
  // Assets live in threads/<thread_id>/assets/ — sibling to the note *.html
  // files so they share the thread folder and get the same backup coverage,
  // but in a subdir so a filename can never collide with a note slug.
  return join(threadsDir(), threadId, "assets");
}

/**
 * Safe-asset-filename predicate. Must be ASCII alphanumeric + `.` `_` `-`,
 * non-empty, ≤ 200 chars, no leading/trailing dot, no consecutive dots
 * (prevents `..` and `.foo` hidden files). Path separators are excluded by
 * the character class. Reject everything else; this is the only guard
 * between an untrusted MCP caller and the filesystem.
 */
export function isSafeAssetFilename(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 200) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.includes("..")) return false;
  return true;
}

export function themesDir(): string {
  return join(folioRoot(), "themes");
}

export function templatesDir(): string {
  return join(folioRoot(), "templates");
}

export function trashDir(): string {
  return join(folioRoot(), ".trash");
}

export function dbPath(): string {
  return join(folioRoot(), "index.sqlite");
}

export function configPath(): string {
  return join(folioRoot(), "folio.config.json");
}

export function bundledThemesDir(): string {
  // Env override for compiled binaries (bun --compile) — `import.meta.dir`
  // resolves to an embedded path that does not exist on disk. Production
  // deploys (Jetson) ship themes separately + FOLIO_BUNDLED_THEMES_DIR=/opt/folio/themes.
  const envDir = process.env.FOLIO_BUNDLED_THEMES_DIR?.trim();
  if (envDir && existsSync(envDir)) return envDir;
  // Fallback: relative to execPath (binary location)
  if (process.execPath && existsSync(process.execPath)) {
    const next = join(process.execPath, "..", "themes");
    if (existsSync(next)) return next;
  }
  return join(import.meta.dir, "..", "..", "themes");
}

export function bundledTemplatesDir(): string {
  const envDir = process.env.FOLIO_BUNDLED_TEMPLATES_DIR?.trim();
  if (envDir && existsSync(envDir)) return envDir;
  if (process.execPath && existsSync(process.execPath)) {
    const next = join(process.execPath, "..", "templates");
    if (existsSync(next)) return next;
  }
  return join(import.meta.dir, "..", "..", "templates");
}

export function bundledSkillsDir(): string {
  // Same resolution pattern as themes/templates: env override → execPath
  // sibling → dev fallback. Each subdir is one skill (currently just "folio").
  // `folio install --target claude-code` symlinks ~/.claude/skills/<name> →
  // <bundledSkillsDir>/<name>; after `folio update`, the path stays stable so
  // symlinks survive.
  const envDir = process.env.FOLIO_BUNDLED_SKILLS_DIR?.trim();
  if (envDir && existsSync(envDir)) return envDir;
  if (process.execPath && existsSync(process.execPath)) {
    const next = join(process.execPath, "..", "skills");
    if (existsSync(next)) return next;
  }
  return join(import.meta.dir, "..", "..", "skills");
}

export function bundledHooksDir(): string {
  // v0.21.0+: agent-host hook bundles (e.g. OpenClaw hooks at
  // hooks/openclaw/folio-event-watcher/). Same resolution pattern as
  // skills/themes. `folio install --target openclaw` symlinks
  // ~/.openclaw/hooks/<name> → <bundledHooksDir>/openclaw/<name>.
  const envDir = process.env.FOLIO_BUNDLED_HOOKS_DIR?.trim();
  if (envDir && existsSync(envDir)) return envDir;
  if (process.execPath && existsSync(process.execPath)) {
    const next = join(process.execPath, "..", "hooks");
    if (existsSync(next)) return next;
  }
  return join(import.meta.dir, "..", "..", "hooks");
}

export function bundledOgDir(): string {
  // OG-image sidecar assets for the cloud relay: resvg.wasm (the SVG→PNG
  // rasterizer) + a bundled font (resvg-wasm ships no system fonts, so card
  // text renders blank without one). Shipped beside the binary, not embedded
  // in it — keeps the `folio` binary lean for the CLI majority who never run
  // the cloud. Same resolution pattern as themes/templates/skills/hooks.
  const envDir = process.env.FOLIO_BUNDLED_OG_DIR?.trim();
  if (envDir && existsSync(envDir)) return envDir;
  if (process.execPath && existsSync(process.execPath)) {
    const next = join(process.execPath, "..", "og");
    if (existsSync(next)) return next;
  }
  return join(import.meta.dir, "..", "..", "og");
}

export async function loadConfig(): Promise<FolioConfig> {
  if (!existsSync(configPath())) return { ...DEFAULT_CONFIG };
  try {
    const raw = await Bun.file(configPath()).text();
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(cfg: FolioConfig): Promise<void> {
  await Bun.write(configPath(), JSON.stringify(cfg, null, 2));
}

/**
 * Synchronously load (or lazily initialize) this device's stable identity.
 *
 * Called from migration paths (which are sync) and from `createNote()` which
 * stamps `origin_device_id` on every new note. Idempotent: subsequent calls
 * return the same id without rewriting config.
 *
 * If folio.config.json is absent or missing the field, we create/patch it
 * in place with a generated ULID + os.hostname() as device_name. We never
 * rotate an existing id — the cloud relay binds bearer tokens to it at pair
 * time, and rotation would invalidate the pairing.
 */
export function getOrCreateDeviceId(): { id: string; name: string } {
  const path = configPath();
  if (existsSync(path)) {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf-8"));
      if (typeof cfg.device_id === "string" && cfg.device_id.length > 0) {
        return {
          id: cfg.device_id,
          name: typeof cfg.device_name === "string" ? cfg.device_name : hostname(),
        };
      }
      // Backfill onto existing config without disturbing other fields.
      const id = ulid();
      const name = hostname();
      const updated = { ...cfg, device_id: id, device_name: cfg.device_name ?? name };
      writeFileSync(path, JSON.stringify(updated, null, 2));
      return { id, name: updated.device_name };
    } catch {
      // Fall through to fresh-write.
    }
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const id = ulid();
  const name = hostname();
  const fresh = { ...DEFAULT_CONFIG, device_id: id, device_name: name };
  writeFileSync(path, JSON.stringify(fresh, null, 2));
  return { id, name };
}
