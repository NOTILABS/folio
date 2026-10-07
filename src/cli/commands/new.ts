import { readFileSync, existsSync } from "node:fs";
import { createNote } from "../../core/storage";
import { loadConfig, viewerLocalBaseUrl, viewerShareableBaseUrl } from "../../core/config";
import { shareHint } from "../../core/sync";
import { c, out, json } from "../io";
import type { CreateNoteInput, NoteType } from "../../core/types";

interface NewOpts {
  title: string;
  type?: string;
  htmlFile?: string;
  htmlInline?: string;
  thread?: string;
  theme?: string;
  themeProfile?: "hosted" | "standalone";
  tags?: string[];
  isFinal?: boolean;
  live?: boolean;
  inline?: boolean;
  /** sc-15149: agent chat session the note belongs to. */
  sessionKey?: string;
  jsonOut?: boolean;
}

function validType(t: string | undefined): NoteType {
  const ok: NoteType[] = ["research", "comparison", "technical", "journal", "snippet", "iteration"];
  if (!t) return "snippet";
  if (!ok.includes(t as NoteType)) throw new Error(`Invalid --type. One of: ${ok.join(", ")}`);
  return t as NoteType;
}

export async function newNote(opts: NewOpts): Promise<number> {
  if (!opts.title) {
    process.stderr.write(c.err("✗ --title required\n"));
    return 3;
  }
  let body_html = "";
  if (opts.htmlFile) {
    if (!existsSync(opts.htmlFile)) {
      process.stderr.write(c.err(`✗ file not found: ${opts.htmlFile}\n`));
      return 4;
    }
    body_html = readFileSync(opts.htmlFile, "utf-8");
  } else if (opts.htmlInline) {
    body_html = opts.htmlInline;
  } else if (opts.live || opts.type === "iteration") {
    // Live notes + iteration notes start with empty/minimal body — content
    // comes via append_entry or propose_round respectively. Check these
    // BEFORE the stdin fallback: in a non-TTY shell (CI, scripts,
    // `bun run … | …`) stdin.isTTY is false even though the user didn't
    // intend to pipe anything, and reading from stdin would block forever.
    body_html = "";
  } else if (!process.stdin.isTTY) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
    body_html = Buffer.concat(chunks).toString("utf-8");
  } else {
    process.stderr.write(c.err("✗ no body — pass --html @file, --html-inline 'string', --live, --type iteration, or pipe stdin\n"));
    return 3;
  }
  if (!opts.live && opts.type !== "iteration" && !body_html.trim()) {
    process.stderr.write(c.err("✗ empty body (use --live for an append-only feed, --type iteration for a design-iteration gallery)\n"));
    return 3;
  }

  // Default --type when --live is set: journal (matches spec intent — live
  // notes are chronological feeds by default; user can override with --type).
  const effectiveType = opts.type ?? (opts.live ? "journal" : undefined);

  const cfg = await loadConfig();
  const input: CreateNoteInput = {
    type: validType(effectiveType),
    title: opts.title,
    body_html,
    thread_id: opts.thread,
    theme: opts.theme ?? cfg.theme,
    theme_profile: opts.themeProfile ?? "hosted",
    tags: opts.tags,
    is_final: opts.isFinal,
    live: opts.live,
    inline: opts.inline,
    session_key: opts.sessionKey,
  };

  const note = await createNote(input);
  const localUrl = `${viewerLocalBaseUrl(cfg)}/n/${note.id}`;
  const publicBase = viewerShareableBaseUrl(cfg);
  const publicUrl = publicBase ? `${publicBase}/n/${note.id}` : null;
  if (opts.jsonOut) {
    // Same link contract as the MCP create tool (sc-6716): public_url only
    // from viewer_public_url, else null + share_hint.
    json({
      ...note,
      local_url: localUrl,
      public_url: publicUrl,
      ...(publicUrl ? {} : { share_hint: shareHint(note.id, "cli") }),
    });
  } else {
    out(c.ok("✓") + ` Created ${c.bold(note.title)}`);
    out(`  ${c.dim("id   ")} ${note.id}`);
    out(`  ${c.dim("type ")} ${note.type}  ${c.dim("theme")} ${note.theme}  ${c.dim("thread")} ${note.thread_id}`);
    out(`  ${c.dim("path ")} ~/Folio/${note.path}`);
    out(`  ${c.dim("url  ")} ${c.cyan(localUrl)}`);
    if (publicUrl) out(`  ${c.dim("pub  ")} ${c.cyan(publicUrl)}`);
    else out(`  ${c.dim("share")} ${c.dim(shareHint(note.id, "cli"))}`);
  }
  return 0;
}
