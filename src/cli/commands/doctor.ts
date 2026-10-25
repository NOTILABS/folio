// `folio doctor` — diagnostic. Shows where the skill + MCP are wired in for
// every supported target, and warns about:
//   - missing or broken skill symlinks
//   - MCP `command:` paths that don't exist on disk
//   - multiple folio binaries on $PATH (potential version skew)
//
// Read-only; no mutations. Exit code 0 = healthy, 1 = at least one warning.

import { existsSync, readlinkSync, lstatSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { c, out, err, json } from "../io";
import { check as checkClaudeCode, claudeCodePaths, mcpCommand, skillSourcePath } from "../install/claude-code";
import { check as checkOpenclaw, openclawPaths, isOpenclawPresent } from "../install/openclaw";
import { bundledSkillsDir, bundledThemesDir, bundledTemplatesDir, folioRoot, dbPath, configPath } from "../../core/config";
import pkg from "../../../package.json" with { type: "json" };

type CheckResult = ReturnType<typeof checkClaudeCode>;

export interface DoctorOptions {
  jsonOut?: boolean;
  /** Skip network probes (reachability, token round-trip). Useful offline. */
  offline?: boolean;
}

interface DoctorReport {
  folio_version: string;
  binary: string;
  bundled_skills_dir: string;
  skill_source: string;
  mcp_command: { command: string; args: string[] };
  claude_code: CheckResult;
  openclaw: CheckResult | { present: false };
  storage: StorageReport;
  cloud: CloudReport;
  warnings: { level: "warn" | "error"; message: string }[];
  conflicts: { kind: string; detail: string }[];
}

export interface StorageReport {
  folio_home: string;
  folio_home_exists: boolean;
  db_path: string;
  db_exists: boolean;
  config_exists: boolean;
  bundled_themes: { path: string; exists: boolean };
  bundled_templates: { path: string; exists: boolean };
}

export interface CloudReport {
  paired: boolean;
  remote?: string;
  device_id?: string;
  device_name?: string;
  /** sc-24117: "all" (full mirror, default) or "shared" (publish-only —
   *  only this device's active shares reach the cloud). */
  sync_scope?: "all" | "shared";
  last_pushed_at?: string | null;
  last_pulled_seq?: number;
  /** Reachability check — null when not paired or `--offline` skipped them. */
  reachable?: "ok" | "fail" | "skipped";
  /** Token check — round-trip /v1/auth/devices with the stored bearer. */
  token_valid?: "ok" | "fail" | "skipped";
  /** Sync recency. "stale" if last push > staleness threshold. */
  recency?: "fresh" | "stale" | "never";
  details?: string[];
}

export async function doctorCmd(opts: DoctorOptions = {}): Promise<number> {
  const ccPaths = claudeCodePaths();
  const ocPaths = openclawPaths();
  const cc = checkClaudeCode(ccPaths);
  const ocPresent = isOpenclawPresent(ocPaths);
  const oc = ocPresent ? checkOpenclaw(ocPaths) : null;
  const warnings: DoctorReport["warnings"] = [];
  const conflicts: DoctorReport["conflicts"] = [];

  // ── Skill source on disk ──
  const skillSrc = skillSourcePath();
  if (!existsSync(skillSrc)) {
    warnings.push({ level: "error", message: `bundled skill missing at ${skillSrc} — Folio install is incomplete.` });
  }

  // ── Per-target skill + MCP analysis ──
  function analyzeTarget(label: string, cr: CheckResult, refreshHint: string): void {
    switch (cr.skill.state) {
      case "ok":
      case "missing":
        break;
      case "wrong-target":
        warnings.push({
          level: "warn",
          message: cr.skill.note
            ? `[${label}] ${cr.skill.note} — ${refreshHint}`
            : (cr.skill.installedAt
              ? `[${label}] skill symlink ${cr.skill.installedAt} points elsewhere (${cr.skill.currentTarget ?? "non-symlink"}); ${refreshHint}`
              : `[${label}] skill expected at ${cr.skill.expected}; ${refreshHint}`),
        });
        break;
      case "stale":
        warnings.push({
          level: "warn",
          message: cr.skill.note
            ? `[${label}] ${cr.skill.note}`
            : `[${label}] skill symlink target ${cr.skill.expected} does not exist on disk.`,
        });
        break;
    }
    for (const e of cr.mcp.entries) {
      if (e.state === "stale") {
        warnings.push({
          level: "warn",
          message: `[${label}] MCP entry for scope ${e.scope} points to ${e.command}; differs from this binary (${cr.mcp.expectedCommand}). ${refreshHint}`,
        });
      }
    }
  }
  analyzeTarget("claude-code", cc, "run `folio install --target claude-code` to refresh.");
  if (oc) analyzeTarget("openclaw", oc, "run `folio install --target openclaw` to refresh.");

  // ── Conflicts: multiple folio binaries on $PATH ──
  const found = findFolioBinariesOnPath();
  if (found.length > 1) {
    conflicts.push({
      kind: "multiple-binaries",
      detail: `Multiple \`folio\` on PATH: ${found.join(", ")}. Last \`folio install\` wins; consider removing the older one.`,
    });
    warnings.push({ level: "warn", message: `Multiple folio binaries detected — see conflicts.` });
  }

  // ── Storage paths ──
  const storage = collectStorage();
  if (!storage.folio_home_exists) {
    warnings.push({
      level: "warn",
      message: `FOLIO_HOME ${storage.folio_home} does not exist. Run \`folio init\` to bootstrap.`,
    });
  }
  if (!storage.bundled_themes.exists) {
    warnings.push({
      level: "error",
      message: `Bundled themes dir ${storage.bundled_themes.path} not found — compiled binary may be missing assets next to it.`,
    });
  }
  if (!storage.bundled_templates.exists) {
    warnings.push({
      level: "error",
      message: `Bundled templates dir ${storage.bundled_templates.path} not found.`,
    });
  }

  // ── Cloud sync diagnostics ──
  const cloud = await collectCloud({ offline: !!opts.offline });
  if (cloud.paired) {
    if (cloud.reachable === "fail") {
      warnings.push({ level: "warn", message: `Cloud ${cloud.remote} unreachable (check VPS / DNS / Caddy).` });
    }
    if (cloud.token_valid === "fail") {
      warnings.push({
        level: "warn",
        message: `Token rejected by ${cloud.remote} — device may have been revoked. Re-pair via /cloud in the local viewer.`,
      });
    }
    if (cloud.recency === "stale") {
      warnings.push({
        level: "warn",
        message: `Last successful push was ${cloud.last_pushed_at}. Run \`folio sync --once\` (or check the daemon) — notes on this device aren't reaching the cloud.`,
      });
    }
  }

  const report: DoctorReport = {
    folio_version: pkg.version,
    binary: process.execPath,
    bundled_skills_dir: bundledSkillsDir(),
    skill_source: skillSrc,
    mcp_command: mcpCommand(),
    claude_code: cc,
    openclaw: oc ?? { present: false },
    storage,
    cloud,
    warnings,
    conflicts,
  };

  if (opts.jsonOut) {
    json(report);
    return warnings.some((w) => w.level === "error") ? 1 : 0;
  }

  out(c.bold(`Folio doctor — v${pkg.version}`));
  out(c.dim(`  binary:         ${process.execPath}`));
  out(c.dim(`  skill source:   ${skillSrc}${existsSync(skillSrc) ? "" : c.err(" (MISSING)")}`));
  out(c.dim(`  mcp command:    ${mcpCommand().command} ${mcpCommand().args.join(" ")}`));

  printTargetSection("Claude Code", cc);
  if (oc) {
    printTargetSection("OpenClaw", oc);
  } else {
    out("");
    out(c.bold("OpenClaw"));
    out(c.dim("  not detected (no ~/.openclaw/openclaw.json)"));
  }

  printStorageSection(storage);
  printCloudSection(cloud);

  if (conflicts.length > 0) {
    out("");
    out(c.bold("Conflicts"));
    for (const k of conflicts) out(c.warn(`  ! ${k.kind}: ${k.detail}`));
  }

  if (warnings.length > 0) {
    out("");
    out(c.bold("Warnings"));
    for (const w of warnings) {
      const sym = w.level === "error" ? c.err("✗") : c.warn("!");
      out(`  ${sym} ${w.message}`);
    }
    return 1;
  }
  out("");
  out(c.ok("✓ No issues."));
  return 0;
}

function printTargetSection(title: string, cr: CheckResult): void {
  out("");
  out(c.bold(title));
  out(`  skill: ${formatSkillState(cr.skill)}`);
  if (cr.mcp.entries.length === 0) {
    out(`  mcp:   ${c.dim("(no entries)")}`);
  } else {
    out(`  mcp:`);
    for (const e of cr.mcp.entries) {
      const tag = e.state === "ok" ? c.ok("ok") : c.warn("stale");
      out(`    [${tag}] ${e.scope}`);
      out(`           ${c.dim("→ " + e.command)}`);
    }
  }
}

function formatSkillState(s: CheckResult["skill"]): string {
  switch (s.state) {
    case "ok":
      // Symlink installs show "→ target"; copied installs (no currentTarget)
      // show the version note instead.
      return s.currentTarget
        ? `${c.ok("ok")} ${c.dim(s.installedAt + " → " + s.currentTarget)}`
        : `${c.ok("ok")} ${c.dim((s.installedAt ?? "") + (s.note ? ` (${s.note})` : ""))}`;
    case "missing":
      return `${c.dim("not installed")}`;
    case "stale":
      return s.currentTarget
        ? `${c.warn("stale")} ${c.dim(s.installedAt + " → " + s.currentTarget + (s.note ? ` (${s.note})` : ""))}`
        : `${c.warn("stale")} ${c.dim((s.installedAt ?? "") + (s.note ? ` (${s.note})` : ""))}`;
    case "wrong-target":
      return `${c.warn("wrong-target")} ${c.dim((s.installedAt ?? "") + " → " + (s.currentTarget ?? "") + (s.note ? ` (${s.note})` : ""))}`;
  }
}

// Stale-sync threshold: 7 days. Below this we treat the last_pushed_at as
// "fresh enough"; above and we surface a warning. Tuned for the typical
// usage pattern (laptop active most days) and easy to revisit if it
// produces noise for users who genuinely don't sync often.
const STALE_DAYS = 7;

function collectStorage(): StorageReport {
  const root = folioRoot();
  return {
    folio_home: root,
    folio_home_exists: existsSync(root),
    db_path: dbPath(),
    db_exists: existsSync(dbPath()),
    config_exists: existsSync(configPath()),
    bundled_themes: { path: bundledThemesDir(), exists: existsSync(bundledThemesDir()) },
    bundled_templates: { path: bundledTemplatesDir(), exists: existsSync(bundledTemplatesDir()) },
  };
}

async function collectCloud(opts: { offline: boolean }): Promise<CloudReport> {
  // Lazy import — if FOLIO_HOME isn't ready, sync state load is meaningless
  // but importing it is still cheap.
  const { loadSyncState } = await import("../../core/sync");
  const state = loadSyncState();
  if (!state) return { paired: false };

  const { loadConfig } = await import("../../core/config");
  const cfg = await loadConfig();

  const details: string[] = [];
  const report: CloudReport = {
    paired: true,
    remote: state.remote,
    sync_scope: cfg.sync_scope ?? "all",
    last_pushed_at: state.last_pushed_at,
    last_pulled_seq: state.last_pulled_seq,
    details,
  };

  // Identity surfaced for the operator (no token — just id + label).
  try {
    const { getOrCreateDeviceId } = await import("../../core/config");
    const dev = getOrCreateDeviceId();
    report.device_id = dev.id;
    report.device_name = dev.name;
  } catch {
    // pre-W2 dbs may not have the column / hostname could fail; non-fatal.
  }

  if (opts.offline) {
    report.reachable = "skipped";
    report.token_valid = "skipped";
  } else {
    // /healthz is public; reachability check first to distinguish "cloud
    // down" from "cloud up but rejecting our token".
    try {
      const r = await fetch(`${state.remote}/healthz`, { signal: AbortSignal.timeout(5000) });
      report.reachable = r.ok ? "ok" : "fail";
    } catch {
      report.reachable = "fail";
    }
    if (report.reachable === "ok") {
      try {
        const r = await fetch(`${state.remote}/v1/auth/devices`, {
          headers: { Authorization: `Bearer ${state.device_token}` },
          signal: AbortSignal.timeout(5000),
        });
        report.token_valid = r.ok ? "ok" : "fail";
        if (r.ok) {
          // Bonus: include how many devices share this account, for context.
          try {
            const body = (await r.json()) as { devices?: unknown[] };
            const n = Array.isArray(body.devices) ? body.devices.length : 0;
            details.push(`${n} device${n === 1 ? "" : "s"} paired on cloud.`);
          } catch {}
        }
      } catch {
        report.token_valid = "fail";
      }
    } else {
      report.token_valid = "skipped";
    }
  }

  // Recency: last_pushed_at → fresh/stale/never.
  if (!state.last_pushed_at) {
    report.recency = "never";
  } else {
    const ageMs = Date.now() - new Date(state.last_pushed_at).getTime();
    report.recency = ageMs > STALE_DAYS * 86400_000 ? "stale" : "fresh";
  }

  return report;
}

function printStorageSection(s: StorageReport): void {
  out("");
  out(c.bold("Storage"));
  out(`  folio home:     ${s.folio_home} ${s.folio_home_exists ? c.ok("✓") : c.err("✗ missing")}`);
  out(`  index db:       ${s.db_path} ${s.db_exists ? c.ok("✓") : c.dim("(not yet)")}`);
  out(`  config:         ${s.config_exists ? c.ok("✓") : c.dim("(default)")}`);
  out(`  bundled themes: ${s.bundled_themes.path} ${s.bundled_themes.exists ? c.ok("✓") : c.err("✗")}`);
  out(`  bundled tpls:   ${s.bundled_templates.path} ${s.bundled_templates.exists ? c.ok("✓") : c.err("✗")}`);
}

function printCloudSection(r: CloudReport): void {
  out("");
  out(c.bold("Cloud sync"));
  if (!r.paired) {
    out(`  ${c.dim("not paired — pair via http://127.0.0.1:4810/cloud (after `folio serve`)")}`);
    return;
  }
  out(`  remote:         ${c.cyan(r.remote ?? "")}`);
  if (r.device_id) {
    out(`  device:         ${r.device_name ?? ""} ${c.dim(r.device_id.slice(0, 12) + "…")}`);
  }
  out(`  sync scope:     ${r.sync_scope === "shared" ? c.warn("shared") + c.dim(" (publish-only — only active shares reach the cloud)") : c.dim("all (full mirror)")}`);
  out(`  reachable:      ${formatCloudStatus(r.reachable)}`);
  out(`  token valid:    ${formatCloudStatus(r.token_valid)}`);
  out(`  last push:      ${r.last_pushed_at ? `${r.last_pushed_at} ${formatRecency(r.recency)}` : c.dim("never")}`);
  out(`  pull cursor:    ${r.last_pulled_seq ?? 0}`);
  if (r.details && r.details.length > 0) {
    for (const d of r.details) out(c.dim(`  · ${d}`));
  }
}

function formatCloudStatus(v: "ok" | "fail" | "skipped" | undefined): string {
  if (v === "ok") return c.ok("✓");
  if (v === "fail") return c.err("✗");
  if (v === "skipped") return c.dim("(skipped)");
  return c.dim("?");
}

function formatRecency(r: CloudReport["recency"]): string {
  if (r === "fresh") return c.ok("(fresh)");
  if (r === "stale") return c.warn(`(stale — > ${STALE_DAYS}d)`);
  if (r === "never") return c.dim("(never synced)");
  return "";
}

function findFolioBinariesOnPath(): string[] {
  const PATH = process.env.PATH ?? "";
  const dirs = PATH.split(":").filter(Boolean);
  const found: string[] = [];
  for (const d of dirs) {
    const candidate = `${d}/folio`;
    if (existsSync(candidate)) {
      try {
        const st = lstatSync(candidate);
        const resolved = st.isSymbolicLink() ? readlinkSync(candidate) : candidate;
        if (!found.includes(candidate)) found.push(candidate);
        // Ignore `resolved` for now — listing the PATH entry is more useful than
        // listing the symlink target (which collapses brew + manual installs).
        void resolved;
      } catch {
        // ignore
      }
    }
  }
  return found;
}

// `which -a folio` would be cleaner on Unix; we keep it portable to avoid a
// shell dep in compiled Bun binaries. spawnSync stays imported so tests can
// shim it if we ever want to mock PATH lookup; currently unused.
void spawnSync;
