import { init } from "./commands/init";
import { newNote } from "./commands/new";
import { list } from "./commands/list";
import { search } from "./commands/search";
import { statsCmd } from "./commands/stats";
import { serve } from "./commands/serve";
import { finalizeCmd } from "./commands/finalize";
import { editCmd } from "./commands/edit";
import { replaceCmd } from "./commands/replace";
import { openCmd } from "./commands/open";
import { cleanupCmd } from "./commands/cleanup";
import { reindexCmd } from "./commands/reindex";
import { exportCmd } from "./commands/export";
import { updateCmd } from "./commands/update";
import { versionCmd } from "./commands/version";
import { installCmd } from "./commands/install";
import { uninstallCmd } from "./commands/uninstall";
import { doctorCmd } from "./commands/doctor";
import { appendCmd } from "./commands/append";
import { tailCmd } from "./commands/tail";
import { cloudCmd } from "./commands/cloud";
import { syncCmd } from "./commands/sync";
import { publishCmd, sharesCmd } from "./commands/publish";
import { deleteCmd } from "./commands/delete";
import { c, out } from "./io";

interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const cmd = args[0] ?? "help";
  const rest = args.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

function help(): number {
  out(c.bold("Folio — Visual communication for AI ↔ humans"));
  out("");
  out("Usage: " + c.cyan("folio <command> [args]"));
  out("");
  out(c.bold("Commands:"));
  out(`  ${c.cyan("init")}              Initialize ~/Folio (create dirs, config, db)`);
  out(`  ${c.cyan("new")}               Create a new note (--title, --html, --type, --thread, --theme, --live, --inline, --session-key)`);
  out(`  ${c.cyan("list")}              List recent notes (--type, --thread, --final, --limit, --json)`);
  out(`  ${c.cyan("search <query>")}    Full-text search (--type, --limit, --json)`);
  out(`  ${c.cyan("append <id>")}       Append entry to a live note (--content @file, --tags, --refs, --importance, --source-ref, --occurred-at)`);
  out(`  ${c.cyan("tail <id>")}         Stream live entries from /n/:id/stream — needs folio serve (--json)`);
  out(`  ${c.cyan("finalize <id>")}     Mark note as final (skip auto-cleanup); for live notes compiles entries into body`);
  out(`  ${c.cyan("edit <id>")}         Update note metadata (--title, --theme, --tags "a,b,c", --final, --unfinal). Body stays immutable.`);
  out(`  ${c.cyan("replace <id>")}      Supersede a note with a new body (--html @path, --title, --theme, --tags). Old URL preserved + hidden from listings.`);
  out(`  ${c.cyan("delete <id>")}       Soft-delete a note (moves to ~/Folio/.trash/, recoverable 7d, propagates to cloud) — flag: --yes`);
  out(`  ${c.cyan("open <id|slug>")}    Open note in default browser (via viewer)`);
  out(`  ${c.cyan("stats")}             Show counts + analytics`);
  out(`  ${c.cyan("cleanup")}           Auto-trash non-final notes past expiry (--dry-run, --grace-days N)`);
  out(`  ${c.cyan("reindex")}           Rebuild FTS index from HTML files on disk (after tokenizer changes)`);
  out(`  ${c.cyan("export <id>")}       Export note as HTML (--standalone inlines theme CSS, --out path to file or stdout)`);
  out(`  ${c.cyan("serve")}             Start local viewer on http://127.0.0.1:4810`);
  out(`  ${c.cyan("update")}            Check + install latest release from GitHub (--check, --force, --pre, --json)`);
  out(`  ${c.cyan("install")}           Wire Folio into an agent client (--target claude-code | openclaw | all, --skill-only, --mcp-only, --global, --scope, --dry-run, --yes)`);
  out(`  ${c.cyan("uninstall")}         Remove Folio wiring (--target claude-code | openclaw | all, --skill-only, --mcp-only, --global, --scope, --all-scopes, --dry-run, --yes)`);
  out(`  ${c.cyan("doctor")}            Show install + storage + cloud sync state (--json, --offline)`);
  out(`  ${c.cyan("cloud <sub>")}       Cloud relay: init | serve | pair-code (see deploy/ for systemd unit)`);
  out(`  ${c.cyan("sync <sub>")}        Sync with cloud: pair | status | unpair | run (default) — flags: --remote, --code, --once, --interval`);
  out(`  ${c.cyan("publish <id>")}      Create a capability URL share — flags: --expires-days, --max-views, --scope=note|thread, --allow-pick`);
  out(`  ${c.cyan("shares <sub>")}      Manage capability URL shares: list | revoke <token> — flags: --for &lt;id&gt;`);
  out(`  ${c.cyan("version")}           Print Folio version + system info (--json) — also: --version, -v`);
  out(`  ${c.cyan("help")}              This help`);
  out("");
  out(c.dim("Run `folio init` first if you haven't yet."));
  return 0;
}

function flagBool(v: string | boolean | undefined, dflt = false): boolean {
  if (v === undefined) return dflt;
  if (typeof v === "boolean") return v;
  return v === "1" || v.toLowerCase() === "true" || v === "";
}

function flagStr(v: string | boolean | undefined): string | undefined {
  if (typeof v === "string") return v;
  return undefined;
}

function flagInt(v: string | boolean | undefined): number | undefined {
  const s = flagStr(v);
  if (s === undefined) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function main(argv = process.argv): Promise<number> {
  const { cmd, positional, flags } = parseArgs(argv);
  try {
    switch (cmd) {
      case "init":
        return await init();
      case "new": {
        const htmlFile = (() => {
          const v = flagStr(flags.html);
          if (v && v.startsWith("@")) return v.slice(1);
          return undefined;
        })();
        return await newNote({
          title: flagStr(flags.title) ?? positional[0] ?? "",
          type: flagStr(flags.type),
          htmlFile,
          htmlInline: !htmlFile ? flagStr(flags["html-inline"]) : undefined,
          thread: flagStr(flags.thread),
          theme: flagStr(flags.theme),
          themeProfile: flagStr(flags["theme-profile"]) as any,
          tags: flagStr(flags.tags)?.split(",").map((s) => s.trim()).filter(Boolean),
          isFinal: flagBool(flags.final),
          live: flagBool(flags.live),
          inline: flagBool(flags.inline),
          sessionKey: flagStr(flags["session-key"]),
          jsonOut: flagBool(flags.json),
        });
      }
      case "append": {
        const contentFile = (() => {
          const v = flagStr(flags.content);
          if (v && v.startsWith("@")) return v.slice(1);
          return undefined;
        })();
        return await appendCmd({
          id: positional[0] ?? flagStr(flags.id) ?? "",
          contentFile,
          contentInline: !contentFile ? flagStr(flags.content) : undefined,
          tags: flagStr(flags.tags)?.split(",").map((s) => s.trim()).filter(Boolean),
          refs: flagStr(flags.refs)?.split(",").map((s) => s.trim()).filter(Boolean),
          importance: flagInt(flags.importance),
          sourceRef: flagStr(flags["source-ref"]),
          occurredAt: flagStr(flags["occurred-at"]),
          jsonOut: flagBool(flags.json),
        });
      }
      case "tail":
        return await tailCmd({
          id: positional[0] ?? flagStr(flags.id) ?? "",
          jsonOut: flagBool(flags.json),
        });
      case "list":
        return await list({
          type: flagStr(flags.type),
          thread: flagStr(flags.thread),
          isFinal: flags.final !== undefined ? flagBool(flags.final) : undefined,
          limit: flagInt(flags.limit),
          jsonOut: flagBool(flags.json),
        });
      case "search":
        return await search({
          query: positional[0] ?? flagStr(flags.q) ?? "",
          type: flagStr(flags.type),
          limit: flagInt(flags.limit),
          jsonOut: flagBool(flags.json),
        });
      case "finalize":
        return await finalizeCmd(positional[0] ?? "");
      case "edit":
        return await editCmd(positional[0] ?? "", {
          title: flagStr(flags.title),
          theme: flagStr(flags.theme),
          tags: flagStr(flags.tags),
          final: flagBool(flags.final),
          unfinal: flagBool(flags.unfinal),
        });
      case "replace":
        return await replaceCmd(positional[0] ?? "", {
          html: flagStr(flags.html),
          title: flagStr(flags.title),
          theme: flagStr(flags.theme),
          tags: flagStr(flags.tags),
        });
      case "delete":
      case "rm":
        return await deleteCmd({
          id: positional[0] ?? flagStr(flags.id),
          yes: flagBool(flags.yes) || flagBool(flags.y),
          jsonOut: flagBool(flags.json),
        });
      case "open":
        return await openCmd(positional[0] ?? "");
      case "stats":
        return await statsCmd({ jsonOut: flagBool(flags.json) });
      case "cleanup":
        return await cleanupCmd({
          dryRun: flagBool(flags["dry-run"]),
          graceDays: flagInt(flags["grace-days"]),
          jsonOut: flagBool(flags.json),
        });
      case "reindex":
        return await reindexCmd();
      case "export":
        return await exportCmd({
          idOrSlug: positional[0] ?? "",
          standalone: flagBool(flags.standalone),
          out: flagStr(flags.out),
        });
      case "serve":
        return await serve();
      case "version":
      case "--version":
      case "-v":
        return await versionCmd({ jsonOut: flagBool(flags.json) });
      case "update":
        return await updateCmd({
          check: flagBool(flags.check),
          force: flagBool(flags.force),
          prerelease: flagBool(flags.pre) || flagBool(flags.prerelease),
          jsonOut: flagBool(flags.json),
        });
      case "install":
        return await installCmd({
          target: flagStr(flags.target),
          skillOnly: flagBool(flags["skill-only"]),
          mcpOnly: flagBool(flags["mcp-only"]),
          scope: flagStr(flags.scope),
          global: flagBool(flags.global),
          dryRun: flagBool(flags["dry-run"]),
          yes: flagBool(flags.yes) || flagBool(flags.y),
          jsonOut: flagBool(flags.json),
        });
      case "uninstall":
        return await uninstallCmd({
          target: flagStr(flags.target),
          skillOnly: flagBool(flags["skill-only"]),
          mcpOnly: flagBool(flags["mcp-only"]),
          scope: flagStr(flags.scope),
          global: flagBool(flags.global),
          allScopes: flagBool(flags["all-scopes"]),
          dryRun: flagBool(flags["dry-run"]),
          yes: flagBool(flags.yes) || flagBool(flags.y),
          jsonOut: flagBool(flags.json),
        });
      case "doctor":
        return await doctorCmd({
          jsonOut: flagBool(flags.json),
          offline: flagBool(flags.offline),
        });
      case "cloud": {
        // cloud subcommands have their own flag parser (see src/cli/commands/
        // cloud.ts parseArgs) because top-level parseArgs already stripped
        // --flag value pairs into `flags`. Reconstruct an args array that
        // looks like the original argv tail so cloudCmd's parser can pick
        // up things like `--user alice` or `--purge --yes`.
        const cloudArgs: string[] = [...positional.slice(1)];
        for (const [k, v] of Object.entries(flags)) {
          if (v === true) cloudArgs.push(`--${k}`);
          else if (typeof v === "string") { cloudArgs.push(`--${k}`); cloudArgs.push(v); }
        }
        return await cloudCmd(positional[0], cloudArgs);
      }
      case "sync":
        return await syncCmd({
          sub: positional[0],
          remote: flagStr(flags.remote),
          code: flagStr(flags.code),
          name: flagStr(flags.name),
          once: flagBool(flags.once),
          interval: flagInt(flags.interval),
          jsonOut: flagBool(flags.json),
        });
      case "publish":
        return await publishCmd({
          id: positional[0] ?? flagStr(flags.id),
          expiresDays: flagInt(flags["expires-days"]),
          maxViews: flagInt(flags["max-views"]),
          scope: flagStr(flags.scope) as any,
          recipient: flagStr(flags.recipient),
          allowPick: flagBool(flags["allow-pick"]),
          jsonOut: flagBool(flags.json),
        });
      case "shares":
        return await sharesCmd({
          sub: positional[0],
          token: positional[1],
          forId: flagStr(flags.for),
          jsonOut: flagBool(flags.json),
        });
      case "help":
      case undefined:
      case "":
        return help();
      default:
        process.stderr.write(c.err(`Unknown command: ${cmd}\n`));
        help();
        return 1;
    }
  } catch (e: any) {
    process.stderr.write(c.err(`✗ ${e?.message ?? e}\n`));
    if (process.env.FOLIO_DEBUG) console.error(e);
    return 1;
  }
}
