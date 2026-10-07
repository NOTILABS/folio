import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

import {
  createNote,
  getNoteMeta,
  readNoteHtml,
  listNotes,
  searchNotes,
  finalize,
  unfinalize,
  updateNoteMetadata,
  replaceNote,
  getRevisionChain,
  listThreads,
  suggestThread,
  stats,
} from "../core/storage";
import { loadConfig, folioRoot, bundledThemesDir, themesDir, viewerLocalBaseUrl, viewerShareableBaseUrl, threadAssetsDir, isSafeAssetFilename } from "../core/config";
import { scheduleAutoSync, shareHint } from "../core/sync";
import { listThemes, getTheme } from "../core/themes";
import { db, logEvent } from "../core/db";
import { renderRecipe, validateRecipe } from "../core/recipe";
import type { NoteType, RenderProfile, RecipeData } from "../core/types";

/**
 * Resolve a note body from either `body_html` (inline) or `body_path` (read
 * server-side from a file on disk). body_path bypasses the tool-call argument
 * size ceiling: a large body passed inline as `body_html` can be silently
 * truncated by the agent's runtime before it ever reaches Folio (e.g. a 50KB
 * transcript). Exactly one of the two must be provided.
 */
function resolveBodyInput(args: any): { body: string } | { error: string } {
  const hasHtml = args.body_html !== undefined && args.body_html !== null;
  const hasPath = typeof args.body_path === "string" && args.body_path.length > 0;
  if (hasHtml === hasPath) {
    return { error: "Provide exactly one of: body_html, body_path." };
  }
  if (hasPath) {
    const src = String(args.body_path);
    if (!existsSync(src)) return { error: `body_path does not exist: ${src}` };
    try {
      return { body: readFileSync(src, "utf-8") };
    } catch (e: any) {
      return { error: `Failed to read body_path: ${e?.message ?? e}` };
    }
  }
  return { body: String(args.body_html) };
}

const ALLOWED_TYPES: NoteType[] = ["research", "comparison", "technical", "journal", "snippet", "iteration", "presentation", "recipe"];

/** JSON-schema fragment describing the structured recipe payload. Inlined on
 *  the `create` / `replace` tools so the agent sees the fields it can fill
 *  directly in the tool contract (full guidance lives in reference/recipe.md). */
const RECIPE_SCHEMA = {
  type: "object",
  description:
    "Structured recipe data (type:\"recipe\"). Emit this INSTEAD of body_html — the server renders a responsive, self-contained body. Only ingredients + steps are required. One schema covers dishes and drinks (kind switches labels). See reference/recipe.md.",
  required: ["ingredients", "steps"],
  properties: {
    kind: { type: "string", enum: ["dish", "drink"], description: "Default 'dish'. 'drink' surfaces glass/method/abv." },
    summary: { type: "string", description: "1–2 sentence intro (rendered as the lead)." },
    image: { type: "string", description: "Relative asset URL from attach_asset (hero image)." },
    meta: {
      type: "object",
      properties: {
        servings: { type: ["string", "number"], description: "'4 porcje' / '1 drink'. A leading number is the scaling base." },
        prep_time: { type: "string" }, cook_time: { type: "string" }, total_time: { type: "string" },
        difficulty: { type: "string" }, glass: { type: "string" }, method: { type: "string" }, abv: { type: "string" },
      },
    },
    ingredients: {
      type: "array", description: "Groups of ingredients. For a flat list pass one group with no `group` name.",
      items: {
        type: "object", required: ["items"],
        properties: {
          group: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object", required: ["name"],
              properties: {
                qty: { type: ["number", "string"], description: "Numeric where possible (enables servings scaling)." },
                unit: { type: "string" }, name: { type: "string" }, note: { type: "string" },
              },
            },
          },
        },
      },
    },
    steps: {
      type: "array", description: "Ordered preparation steps.",
      items: { type: "object", required: ["text"], properties: { text: { type: "string" }, time: { type: "string" } } },
    },
    equipment: { type: "array", items: { type: "string" } },
    tips: { type: "array", items: { type: "string" } },
    source: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } } },
    labels: { type: "object", description: "Section-label overrides (defaults are Polish).", properties: { ingredients: { type: "string" }, steps: { type: "string" }, equipment: { type: "string" }, tips: { type: "string" }, source: { type: "string" }, servings: { type: "string" } } },
  },
};
const ALLOWED_PROFILES: RenderProfile[] = ["hosted", "standalone"];

const tools: Tool[] = [
  {
    name: "create",
    description:
      "Create a new Folio note (HTML communication artifact). Agents call this when they want to give the user a visually-rich response (research, comparison, technical doc). Note: append-only — you cannot edit; new iteration = new note in same thread. Links: public_url is null unless viewer_public_url is configured — then follow share_hint (with a paired cloud: publish) to get a link for the user; local_url (127.0.0.1) opens only on this machine, never send it to someone elsewhere.",
    inputSchema: {
      type: "object",
      required: ["type", "title"],
      properties: {
        type: { type: "string", enum: ALLOWED_TYPES, description: "Note type. Pick `research` for deep dives, `comparison` for vs tables, `technical` for ADRs/specs, `journal` for chronological, `snippet` for short, `iteration` (v0.18+) for design-iteration workflows — 3 candidates → user picks → 3 variants → repeat. `recipe` (v0.42+) for a cooking recipe or drink — pass the `recipe` object instead of body_html and the server renders a responsive layout. Iteration notes have minimal body_html (chrome only); variants come via the propose_round tool." },
        recipe: RECIPE_SCHEMA,
        title: { type: "string", description: "Human-readable title (used as h1)." },
        body_html: { type: "string", description: "HTML fragment for the article body. NO <html>/<body>/<head>/<title>/<meta>; these come from the template. <style> at body level IS allowed (v0.15+) — use it for the `plain` theme or per-note custom CSS. <script>, <button>, <input>, <select>, <textarea>, <form>, role/aria-* all pass the sanitizer (v0.17.1+). Default to theme utility classes for non-plain themes: .eyebrow, .lead, .pill, .card, .verdict. For LARGE bodies (e.g. a transcript) prefer body_path — a big body_html string can be truncated by the agent runtime before it reaches Folio." },
        body_path: { type: "string", description: "Absolute path to a file whose contents become the body — read server-side, so it bypasses the tool-call argument size limit that truncates large inline body_html. Provide exactly one of body_html / body_path. Sanitized identically to body_html." },
        thread_id: { type: "string", description: "Thread slug (kebab-case). Group related iterations. If omitted, slugified from title. PREFER calling suggest_thread first to continue an existing thread instead of creating duplicates." },
        theme: { type: "string", description: "Theme name (default from user config, usually 'linen'). Call list_themes to discover." },
        theme_profile: { type: "string", enum: ALLOWED_PROFILES, description: "'hosted' (default, links theme.css, ~50% less tokens) or 'standalone' (inline CSS, share-ready)." },
        tags: { type: "array", items: { type: "string" }, description: "Free-form tags." },
        is_final: { type: "boolean", description: "Mark as final (no auto-cleanup). User typically does this from viewer; agent only when explicitly asked." },
        live: { type: "boolean", description: "Create as a live note (append-only journal/log/feed). body_html may be empty/minimal chrome. Use append_entry to add entries over time; viewer streams them via SSE. Finalize compiles the feed back into body_html." },
        inline: { type: "boolean", description: "Live notes only (v0.17+). When true, entries render INSIDE body_html (not in a side panel). Include a <section data-folio-live-feed></section> placeholder in body_html where entries should land; Folio auto-injects one at the end if you omit it. Use for journal/feed shapes where the document IS the feed — entries appear inline on every viewer hit + arrive in real time via postMessage. Ignored when live=false." },
        session_key: { type: "string", description: "Key of the chat session you are answering in (your runtime's session key, e.g. `agent:main:kokpit:…`). Optional but pass it whenever you know it: chat clients (Kokpit's \"Files & artifacts\" tab, library) list a session's notes by this key, so the note shows up there even if you never paste its link. Never invent one — omit when unknown." },
      },
    },
  },
  {
    name: "get",
    description: "Read a note's metadata and body HTML.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        include_body: { type: "boolean", description: "Include full body_html (default true)." },
      },
    },
  },
  {
    name: "list_revisions",
    description:
      "List the full revision chain a note belongs to (v0.30.2+), oldest → newest. When a document note is revised via `replace`, each prior draft stays as its own immutable note with its own capability URL — this surfaces that version history. Returns every revision with id, version number, title, created timestamp, word_count, and is_head (the current version). A note that was never replaced returns a single-element chain (itself). Use before `replace` to see prior versions, or to reference / link an older revision.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Any note id in the chain — the head or any superseded revision." },
      },
    },
  },
  {
    name: "list",
    description: "List recent notes with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ALLOWED_TYPES },
        thread_id: { type: "string" },
        is_final: { type: "boolean" },
        session_key: { type: "string", description: "Only notes created with this session_key (sc-15149)." },
        limit: { type: "number", description: "Default 50, max 200." },
      },
    },
  },
  {
    name: "search",
    description: "Full-text search across all notes (FTS5 BM25 with field weighting: title ×5, headings ×3, tags ×4, body ×1).",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: ALLOWED_TYPES },
        limit: { type: "number", description: "Default 20." },
      },
    },
  },
  {
    name: "finalize",
    description: "Mark a note as final — skip auto-cleanup. Use when user says 'keep this' or 'this is the right version'.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "suggest_thread",
    description: "Suggest existing thread_ids that match the title (FTS-based). CALL THIS BEFORE create when you suspect the topic already has notes — to continue the thread instead of creating duplicates.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        type: { type: "string", enum: ALLOWED_TYPES },
        limit: { type: "number", description: "Default 5." },
      },
    },
  },
  {
    name: "list_expiring",
    description: "List non-final notes that will be auto-deleted soon. Use to proactively warn the user (gated heuristics in Skill).",
    inputSchema: {
      type: "object",
      properties: {
        within_days: { type: "number", description: "Default 7." },
        limit: { type: "number", description: "Default 10." },
      },
    },
  },
  {
    name: "list_themes",
    description: "List available themes with name, source (bundled/user), summary, and best-for hints from theme.md.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "export",
    description: "Export a note as a single self-contained HTML document. Use this when the user asks to share / download / send a note — agent gets back the full HTML string ready to paste, save, or pipe further. The note file on disk is NOT modified.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        profile: { type: "string", enum: ["standalone", "hosted"], description: "'standalone' (default) inlines theme.css so the file works offline; 'hosted' keeps the <link> tag and only makes sense within a running viewer." },
      },
    },
  },
  {
    name: "unfinalize",
    description: "Reverse a finalize: re-enable auto-cleanup countdown on a note. Use sparingly — only when user explicitly says 'this isn't the right version after all'. Sets expires_at = created + default_lifespan and is_final=false.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "replace",
    description: "Supersede an existing note with a new revision (v0.22+). Body is the only thing that meaningfully changes; the old note's .html file stays on disk verbatim (capability URL still works for anyone who already received it) but listings, thread views, and search hide it. This is the right tool when the user says 'fix this' / 'polish it' / 'redo this' for note types where prior drafts are noise (snippet, comparison, research). For iteration / technical notes where variant history matters, keep using the create-new-in-same-thread pattern. Inherits type / theme / tags / thread_id / title from the old note unless you override; the new note gets its own ULID. Errors: not-found (old id unknown), already-superseded (old note already pointed at a successor; replace that one instead).",
    inputSchema: {
      type: "object",
      required: ["old_id"],
      properties: {
        old_id: { type: "string", description: "Note id (ULID) being replaced." },
        body_html: { type: "string", description: "New body HTML. Sanitized per the note's theme (permissive for plain, strict everywhere else). For large bodies, prefer body_path (inline body_html can be truncated by the agent runtime)." },
        body_path: { type: "string", description: "Absolute path to a file whose contents become the new body — read server-side, bypassing the tool-call argument size limit. Provide exactly one of body_html / body_path." },
        title: { type: "string", description: "Optional new title. Default: inherit from old." },
        tags: { type: "array", items: { type: "string" }, description: "Optional new tag set (replaces, not adds). Default: inherit." },
        theme: { type: "string", description: "Optional new theme. Default: inherit." },
        recipe: RECIPE_SCHEMA,
      },
    },
  },
  {
    name: "update_metadata",
    description: "Update editable metadata on an existing note (v0.22+). Body stays immutable — that's still ADR-014. Use this for: fixing a typo in the title, retagging, switching theme on a polished note, toggling is_final. For body edits, the model is still 'new note in the same thread' (or use `replace`). At least one of {title, tags, theme, is_final} must change vs current — passing only no-op values returns ok:false reason:'no-change'. The note's .html file is regenerated atomically with the new metadata; created timestamp stays, updated bumps to now. FTS index is refreshed.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Note id (ULID) to update." },
        title: { type: "string", description: "New title. Empty or whitespace-only values are rejected (kept as no-change)." },
        tags: { type: "array", items: { type: "string" }, description: "Complete new tag set (REPLACES the old set, not adds to it). Pass [] to clear all tags." },
        theme: { type: "string", description: "Theme name to switch to. Must be a known theme (bundled or user). Unknown theme → ok:false reason:'unknown-theme'." },
        is_final: { type: "boolean", description: "Flip the finalize state. true → routes through finalize() (live notes compile entries; iteration notes freeze rounds; expires_at cleared). false → routes through unfinalize() (re-arms expiry to created + default_lifespan)." },
      },
    },
  },
  {
    name: "append_entry",
    description: "Append a new entry to a live note's feed. Note must be live (created with live:true) and not yet finalized. Entry's content_html is sanitized (same allowlist as create) and stored in <slug>.entries.jsonl alongside the note. Returns the new entry id and total entry count. Tags drive Folio's two rendering opinions: state:* (decoration) and view:pinned (top rail). To 'change' an existing entry's tags, append a new entry with refs:[<entry-id>] and the new tags (chain-of-entries — namespace last-write-wins). For empty content_html (pure tag mutation) the entry affects compiled tags but doesn't render in the feed.",
    inputSchema: {
      type: "object",
      required: ["note_id", "content_html"],
      properties: {
        note_id: { type: "string", description: "Target live note id." },
        content_html: { type: "string", description: "HTML for the entry body (article fragment). Sanitized server-side; max 32KB after sanitize. May be empty/whitespace for pure tag-mutation entries used in conjunction with refs+tags." },
        tags: { type: "array", items: { type: "string" }, description: "Free-form tags. Namespaces with ':' delimiter — state:*, view:pinned, priority:*, source:*, project:*, topic:*, kind:*. Folio renders state:* and view:pinned specially; all others are generic pills + auto-facets." },
        refs: { type: "array", items: { type: "string" }, description: "Optional entry ids to reference (used for chain-of-entries mutation). Each ref must point to an existing entry on the same note." },
        importance: { type: "number", description: "Optional importance hint 1-5 (1=highest)." },
        source_ref: { type: "string", description: "Optional external reference: URL, ticket id, log line, etc." },
        occurred_at: { type: "string", description: "Optional ISO timestamp of when the event actually happened (vs ts which is when this entry was appended)." },
      },
    },
  },
  {
    name: "list_entries",
    description: "List entries on a live note. Use for agent context loading on session resume (e.g. reading the last hour's entries before deciding what to append). Returns entries + each entry's compiled tag set. The `since` filter is an ISO timestamp; the `tag` filter matches compiled (post-merge) tag set, not raw.",
    inputSchema: {
      type: "object",
      required: ["note_id"],
      properties: {
        note_id: { type: "string" },
        since: { type: "string", description: "Optional ISO timestamp; returns entries with ts > since." },
        tag: { type: "string", description: "Optional tag to filter by (matches compiled tag set)." },
        limit: { type: "number", description: "Default 100, max 500." },
      },
    },
  },
  {
    name: "set_pinned",
    description: "Set the pinned entry set for a live note (top rail in the viewer feed). Pass the complete target list of entry ids that should be pinned; the tool diffs against current state and appends the minimal pin/unpin entries to reach the target. Max 5 entries pinned at a time — passing more returns an error.",
    inputSchema: {
      type: "object",
      required: ["note_id", "entry_ids"],
      properties: {
        note_id: { type: "string" },
        entry_ids: { type: "array", items: { type: "string" }, description: "Complete target list of entry ids to be pinned (≤ 5)." },
      },
    },
  },
  {
    name: "propose_round",
    description: "Propose a fresh round of variants on an iteration note (v0.18+). Each variant is a self-contained HTML payload (full mockup, poster, layout sketch — anything you want the user to choose between). For round 1, omit parent_variant_id. For round N+1, pass parent_variant_id = the variant the user picked in round N (look it up via iteration_state). The user picks via the gallery viewer; the agent watches the SSE stream for the pick event, then calls propose_round again with the picked variant as parent. Errors: WRONG_TYPE (note isn't an iteration note), FINALIZED, ROUND_OPEN (previous round still has no pick), PARENT_MISMATCH (parent_variant_id doesn't equal previous round's pick), EMPTY_VARIANTS.",
    inputSchema: {
      type: "object",
      required: ["note_id", "variants"],
      properties: {
        note_id: { type: "string", description: "Iteration note id (created with type:'iteration')." },
        variants: {
          type: "array",
          description: "Variants to propose in this round. Typically 3, no hard limit. Each has a self-contained content_html.",
          items: {
            type: "object",
            required: ["content_html"],
            properties: {
              content_html: { type: "string", description: "HTML for the variant. Sanitized server-side. Inline styles + <style> + <script> all allowed (v0.15+/v0.17.1+); see SKILL.md. For maximum design freedom, use minimal scaffolding inside (the gallery card is the only chrome the viewer adds)." },
              label: { type: "string", description: "Optional short name for the variant (e.g. 'sidebar-L', 'topnav-v2'). Shown in the gallery card meta + breadcrumb." },
            },
          },
        },
        parent_variant_id: { type: "string", description: "REQUIRED for round 2+. The variant id picked in the previous round (from iteration_state). Omit for round 1." },
      },
    },
  },
  {
    name: "pick_variant",
    description: "Mark a variant as the winner of the current round (v0.18+). Usually called by the viewer when the user clicks; agents can call it programmatically for headless workflows. Appends a pick event; computes rejection state for siblings on read. Errors: WRONG_TYPE, FINALIZED, NO_OPEN_ROUND (no current round), UNKNOWN_VARIANT (id not in current round).",
    inputSchema: {
      type: "object",
      required: ["note_id", "variant_id"],
      properties: {
        note_id: { type: "string" },
        variant_id: { type: "string", description: "Variant id from the current round (returned by propose_round or iteration_state)." },
      },
    },
  },
  {
    name: "iteration_state",
    description: "Read the current state of an iteration note (v0.18+) — rounds, variants, picks, lineage, whether a round is open. Use on session resume before calling propose_round, OR when the agent is woken by the SSE pick event and needs to look up which variant was picked. Returns null when note isn't an iteration note or doesn't exist.",
    inputSchema: {
      type: "object",
      required: ["note_id"],
      properties: { note_id: { type: "string" } },
    },
  },
  {
    name: "wait_for_pick",
    description: "Long-poll for a pick on an iteration note (v0.19.1+). LOAD-BEARING USAGE: call this RIGHT AFTER propose_round with for_round = the round you just proposed. The tool subscribes to Folio's SSE hub for that note and resolves the instant the user clicks a variant in the gallery — no need to ask the user to confirm in chat. Race-window safe: if the round is already picked at call-time, returns immediately with the winning variant_id (covers the case where the user clicked between propose_round returning and wait_for_pick getting called). Returns {picked:true, variant_id, round} on success, or {picked:false, timeout:true, current_round} when timeout_s elapses with no pick. Default timeout 60s; clamped to [1s, 300s]. Errors: NOT_FOUND, WRONG_TYPE.",
    inputSchema: {
      type: "object",
      required: ["note_id"],
      properties: {
        note_id: { type: "string" },
        for_round: { type: "number", description: "Round number to wait the pick of. Strongly recommended: pass the round you just got back from propose_round. Omitting it waits for ANY pick (catch-up mode after restart), which is less safe against race windows." },
        timeout_s: { type: "number", description: "Seconds to wait before returning {picked:false, timeout:true}. Default 60. Clamped to [1, 300]." },
      },
    },
  },
  {
    name: "version",
    description: "Return Folio version + system info: storage root, viewer URL, default theme. Useful when the agent wants to confirm which Folio installation it's talking to (e.g. before bulk operations, or when the user asks 'what version are we on?').",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "attach_asset",
    description: "Attach a binary asset (image, PDF, video) to a thread. Stores to threads/<thread_id>/assets/<filename> and returns a stable URL the agent can reference in body_html (e.g. <img src='<url>'>). One of content_base64 or source_path is required. Filename must be ^[a-zA-Z0-9._-]+$ (no path separators); extensions allowed: jpg/jpeg/png/webp/gif/svg/pdf/mp4. Append-only: re-attaching the same filename overwrites. URL is absolute on the configured viewer_public_url when set (for relayed contexts: Telegram, email); otherwise it is the relative /t/<thread>/asset/<file> path (never 127.0.0.1).",
    inputSchema: {
      type: "object",
      required: ["thread_id", "filename"],
      properties: {
        thread_id: { type: "string", description: "Thread slug to attach into. The directory is created on first attach." },
        filename: { type: "string", description: "Asset filename. ASCII alphanumeric + '.' '_' '-' only, max 200 chars, no leading/trailing dot, no '..'." },
        content_base64: { type: "string", description: "Base64-encoded file contents. Mutually exclusive with source_path." },
        source_path: { type: "string", description: "Absolute path to read the file from (server-side). Useful when content is already on disk; mutually exclusive with content_base64." },
      },
    },
  },
  {
    name: "publish",
    description: "Create a capability-URL share for a note or thread. The returned URL grants read-only access to the resource without requiring the recipient to pair a device — anyone with the link can view. Requires the local Folio to be paired with a cloud relay (folio sync pair). Default expiry: 7 days. Set expires_in_days: 0 for no expiry. Optional max_views caps total page loads. Revoke via folio shares revoke <token>. Safe to call right after create(): if the note hasn't reached the cloud yet, publish syncs it first and waits (bounded, ~30 s) — an error saying \"try again in a moment\" means the cloud is slow/unreachable, not that sharing is unavailable. Use this after create() when the user wants to share the rendered note with someone external (Slack, email, Telegram). For a hub/index note that links to other notes (v0.32+), pass include_linked:true to grant access to the whole linked set — otherwise those links 403 for the recipient (note-scope only covers the one note). Response includes note_count (root + linked) for set shares.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Note uuid (ULID) or thread_id depending on scope_type." },
        scope_type: {
          type: "string",
          enum: ["note", "thread"],
          description: "What `id` refers to. Default 'note'. Thread scope grants access to every note in the thread, including future ones.",
        },
        expires_in_days: {
          type: "number",
          description: "Days until the share auto-revokes. Default 7. Set 0 for forever (until manually revoked).",
        },
        max_views: {
          type: "number",
          description: "Optional cap on total page views before the share auto-locks. Useful for one-time-look situations.",
        },
        include_linked: {
          type: "boolean",
          description: "v0.32+. When true, the share also grants access to every note this one links to (/n/<id>, followed transitively + bounded), snapshotted now. Use for hub/index notes so their links work for the recipient. Ignored for thread scope. The linked notes must already be synced to the cloud.",
        },
      },
    },
  },
];

function jsonContent(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
function errContent(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

function pickFirstLine(s: string, maxLen = 140): string {
  const line = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return line.replace(/^#+\s*/, "").slice(0, maxLen).trim();
}

export async function buildServer(): Promise<Server> {
  const server = new Server(
    { name: "folio", version: pkg.version },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, any>;

    try {
      switch (name) {
        case "create": {
          if (!args.type || !args.title) {
            return errContent("Missing required: type, title");
          }
          if (!ALLOWED_TYPES.includes(args.type)) {
            return errContent(`Invalid type. One of: ${ALLOWED_TYPES.join(", ")}`);
          }
          // Structured recipe: the agent sends `recipe` data instead of HTML.
          // Render it to a self-contained body fragment, then fall through the
          // normal pipeline. body_html / body_path remain an escape hatch
          // (type:"recipe" with hand-written HTML still works).
          let body_html: string;
          if (args.type === "recipe" && args.recipe !== undefined && args.body_html === undefined && args.body_path === undefined) {
            const recErrs = validateRecipe(args.recipe);
            if (recErrs.length) return errContent(`Invalid recipe: ${recErrs.join("; ")}`);
            body_html = renderRecipe(args.recipe as RecipeData, String(args.title));
          } else {
            const createBody = resolveBodyInput(args);
            if ("error" in createBody) return errContent(createBody.error);
            body_html = createBody.body;
          }
          // body may be empty string for live notes (the feed becomes the
          // content; body is just chrome scaffolding until finalize).
          const live = typeof args.live === "boolean" ? args.live : false;
          const inline = typeof args.inline === "boolean" ? args.inline : false;
          const isIteration = args.type === "iteration";
          if (!live && !isIteration && !body_html.trim()) {
            return errContent("body cannot be empty unless live:true or type:iteration (both start with chrome only — content is appended via append_entry / propose_round).");
          }
          const note = await createNote({
            type: args.type,
            title: String(args.title),
            body_html,
            thread_id: args.thread_id ? String(args.thread_id) : undefined,
            theme: args.theme ? String(args.theme) : undefined,
            theme_profile: args.theme_profile ? (String(args.theme_profile) as RenderProfile) : undefined,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
            is_final: typeof args.is_final === "boolean" ? args.is_final : undefined,
            live,
            inline,
            session_key: typeof args.session_key === "string" ? args.session_key : undefined,
          });
          const cfg = await loadConfig();
          const localUrl = `${viewerLocalBaseUrl(cfg)}/n/${note.id}`;
          const publicBase = viewerShareableBaseUrl(cfg);
          const publicUrl = publicBase ? `${publicBase}/n/${note.id}` : null;
          const response: Record<string, unknown> = {
            id: note.id,
            slug: note.slug,
            path: note.path,
            // local_url stays for back-compat (always 127.0.0.1:<port>); public_url
            // is what relays/bots should surface — the configured viewer_public_url,
            // or null when none is set (sc-6716: never the local address; a
            // relayed 127.0.0.1 link is dead for the recipient). When null,
            // share_hint says how to get a working link (publish) or that none exists.
            local_url: localUrl,
            public_url: publicUrl,
            thread_id: note.thread_id,
            theme: note.theme,
            theme_profile: note.theme_profile,
            expires_at: note.expires_at,
            live: note.live,
            // sc-15149: echo so the agent sees whether the note is filed
            // under its chat session (null = no key passed).
            session_key: note.session_key,
            // Hint to agent: include in MEDIA: response convention. Built only
            // from public_url so relays (Telegram, email, Slack) never paste
            // localhost URLs; without one it points at publish instead.
            response_hint: publicUrl
              ? `Respond to user with: "MEDIA:${publicUrl}" + 3-5 line TL;DR.`
              : `Respond to user with a 3-5 line TL;DR plus a link from share_hint — not local_url unless the user reads on this machine.`,
          };
          if (!publicUrl) response.share_hint = shareHint(note.id);
          if (note.live) {
            response.local_stream_url = `${viewerLocalBaseUrl(cfg)}/n/${note.id}/stream`;
            response.stream_url = publicBase ? `${publicBase}/n/${note.id}/stream` : null;
          }
          scheduleAutoSync(); // v0.33: push the new note in the background
          return jsonContent(response);
        }

        case "get": {
          const id = String(args.id ?? "");
          if (!id) return errContent("Missing id");
          const note = getNoteMeta(id);
          if (!note) return errContent(`Not found: ${id}`);
          const includeBody = args.include_body !== false;
          if (!includeBody) return jsonContent(note);
          const html = readNoteHtml(note);
          // Extract just the <article> body for agent consumption (cheaper than full doc)
          const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
          const body_html = articleMatch ? articleMatch[1].trim() : html;
          return jsonContent({ ...note, body_html });
        }

        case "list_revisions": {
          const id = String(args.id ?? "");
          if (!id) return errContent("Missing id");
          const chain = getRevisionChain(id);
          if (chain.length === 0) return errContent(`Not found: ${id}`);
          const revisions = chain.map((m, i) => ({
            id: m.id,
            version: i + 1,
            title: m.title,
            created: m.created,
            word_count: m.word_count,
            is_head: m.superseded_by === null,
          }));
          return jsonContent({ note_id: id, count: revisions.length, revisions });
        }

        case "list": {
          const rows = listNotes({
            type: args.type as NoteType | undefined,
            thread_id: args.thread_id ? String(args.thread_id) : undefined,
            is_final: typeof args.is_final === "boolean" ? args.is_final : undefined,
            session_key: typeof args.session_key === "string" ? args.session_key : undefined,
            limit: Math.min(typeof args.limit === "number" ? args.limit : 50, 200),
          });
          return jsonContent(rows);
        }

        case "search": {
          if (!args.query) return errContent("Missing query");
          const hits = searchNotes({
            query: String(args.query),
            type: args.type as NoteType | undefined,
            limit: Math.min(typeof args.limit === "number" ? args.limit : 20, 100),
          });
          return jsonContent(hits);
        }

        case "finalize": {
          const id = String(args.id ?? "");
          if (!id) return errContent("Missing id");
          const ok = finalize(id);
          if (!ok) return errContent(`Not found: ${id}`);
          scheduleAutoSync();
          return jsonContent({ ok: true, id });
        }

        case "suggest_thread": {
          const title = String(args.title ?? "");
          if (!title) return errContent("Missing title");
          const limit = typeof args.limit === "number" ? args.limit : 5;
          const found = suggestThread(title, limit);
          if (found.length === 0) {
            // Also offer the auto-slug that would be created
            const { slugify } = await import("../core/slug");
            return jsonContent({
              matches: [],
              proposed_new_thread: slugify(title),
              note: "No matching thread found. If you continue, a new thread will be created with this slug.",
            });
          }
          return jsonContent({ matches: found });
        }

        case "list_expiring": {
          const within_days = typeof args.within_days === "number" ? args.within_days : 7;
          const limit = typeof args.limit === "number" ? args.limit : 10;
          const rows = db()
            .query<any, [number]>(
              `SELECT id, slug, title, type, thread_id, created, expires_at,
                      CAST(julianday(expires_at) - julianday('now') AS INTEGER) AS days_left
               FROM notes
               WHERE status='active' AND is_final = 0 AND expires_at IS NOT NULL
                 AND expires_at < datetime('now', '+' || ? || ' days')
               ORDER BY expires_at ASC
               LIMIT ?`
            )
            .all(within_days, limit);
          return jsonContent(rows);
        }

        case "list_themes": {
          const list = listThemes();
          const detailed = await Promise.all(
            list.map(async (t) => {
              const full = await getTheme(t.name);
              return {
                name: t.name,
                source: t.source,
                summary: pickFirstLine(full?.prompt ?? "", 200),
                prompt_addendum: full?.prompt ?? "",
              };
            })
          );
          return jsonContent({
            default: (await loadConfig()).theme,
            themes: detailed,
          });
        }

        case "export": {
          const id = String(args.id ?? "");
          if (!id) return errContent("Missing id");
          const note = getNoteMeta(id);
          if (!note) return errContent(`Not found: ${id}`);
          const profile = (String(args.profile ?? "standalone")) as RenderProfile;
          let html = readNoteHtml(note);
          if (profile === "standalone") {
            // Inline theme.css instead of <link>
            const themeName = note.theme;
            let css: string | null = null;
            for (const root of [themesDir(), bundledThemesDir()]) {
              const p = join(root, themeName, "theme.css");
              if (existsSync(p)) { css = readFileSync(p, "utf-8"); break; }
            }
            if (css) {
              const linkRx = /<link\s+rel="stylesheet"\s+href="\/themes\/[^"]+\/theme\.css">/;
              if (linkRx.test(html)) {
                html = html.replace(linkRx, `<style>\n${css}\n</style>`);
              } else if (!/<style>/.test(html)) {
                html = html.replace(/<\/head>/, `<style>\n${css}\n</style>\n</head>`);
              }
            }
          }
          return jsonContent({
            id: note.id,
            slug: note.slug,
            title: note.title,
            profile,
            size_kb: Math.round(html.length / 1024),
            html,
          });
        }

        case "unfinalize": {
          const id = String(args.id ?? "");
          if (!id) return errContent("Missing id");
          const note = getNoteMeta(id);
          if (!note) return errContent(`Not found: ${id}`);
          if (!note.is_final) return jsonContent({ ok: false, id, note: "Already not final, no change." });
          const ok = await unfinalize(id);
          const cfg = await loadConfig();
          return jsonContent({ ok, id, expires_at_reset_to: `created + ${cfg.default_lifespan_days} days` });
        }

        case "replace": {
          const old_id = String(args.old_id ?? "");
          if (!old_id) return errContent("Missing old_id");
          // Recipe edit: re-render from structured data (title inherited from
          // the old note unless overridden), same as create.
          let body_html: string;
          if (args.recipe !== undefined && args.body_html === undefined && args.body_path === undefined) {
            const recErrs = validateRecipe(args.recipe);
            if (recErrs.length) return errContent(`Invalid recipe: ${recErrs.join("; ")}`);
            const oldMeta = getNoteMeta(old_id);
            const recipeTitle = typeof args.title === "string" ? args.title : (oldMeta?.title ?? "");
            body_html = renderRecipe(args.recipe as RecipeData, recipeTitle);
          } else {
            const replaceBody = resolveBodyInput(args);
            if ("error" in replaceBody) return errContent(replaceBody.error);
            body_html = replaceBody.body;
            if (!body_html) return errContent("Body cannot be empty (provide a non-empty body_html or body_path).");
          }
          const patch: Parameters<typeof replaceNote>[0] = { old_id, body_html };
          if (typeof args.title === "string") patch.title = args.title;
          if (Array.isArray(args.tags)) patch.tags = (args.tags as unknown[]).map(String);
          if (typeof args.theme === "string") patch.theme = args.theme;
          const result = await replaceNote(patch);
          if (!result.ok) {
            if (result.reason === "not-found") return errContent(`Not found: ${old_id}`);
            if (result.reason === "already-superseded") return errContent(`Note ${old_id} is already superseded; replace its successor instead.`);
            return errContent(`Replace failed: ${result.reason ?? "unknown"}`);
          }
          // Build URLs via the same helpers every other handler uses — both
          // take a loaded cfg. The earlier code called viewerLocalBaseUrl()
          // with no argument, so cfg was undefined and the first .viewer_host
          // access threw (`cfg.viewer_host`) on any replace call.
          const cfg = await loadConfig();
          scheduleAutoSync();
          const newId = result.new_meta!.id;
          const publicBase = viewerShareableBaseUrl(cfg);
          return jsonContent({
            ok: true,
            old_id: result.old_id,
            new_id: newId,
            new_slug: result.new_meta!.slug,
            new_local_url: `${viewerLocalBaseUrl(cfg)}/n/${newId}`,
            // null without viewer_public_url (sc-6716) — see share_hint.
            new_public_url: publicBase ? `${publicBase}/n/${newId}` : null,
            old_local_url: `${viewerLocalBaseUrl(cfg)}/n/${result.old_id}`,
            ...(publicBase ? {} : { share_hint: shareHint(newId) }),
          });
        }

        case "update_metadata": {
          const id = String(args.id ?? "");
          if (!id) return errContent("Missing id");
          const inputPatch: { id: string; title?: string; tags?: string[]; theme?: string; is_final?: boolean } = { id };
          if (typeof args.title === "string") inputPatch.title = args.title;
          if (Array.isArray(args.tags)) inputPatch.tags = (args.tags as unknown[]).map(String);
          if (typeof args.theme === "string") inputPatch.theme = args.theme;
          if (typeof args.is_final === "boolean") inputPatch.is_final = args.is_final;
          const result = await updateNoteMetadata(inputPatch);
          if (!result.ok) {
            if (result.reason === "not-found") return errContent(`Not found: ${id}`);
            if (result.reason === "unknown-theme") return errContent(`Unknown theme: ${inputPatch.theme}`);
            if (result.reason === "no-change") return jsonContent({ ok: false, id, reason: "no-change", note: "Pass at least one field different from current state." });
            return errContent(`Update failed: ${result.reason ?? "unknown"}`);
          }
          return jsonContent({
            ok: true,
            id,
            updated_fields: result.updated_fields,
            meta: {
              id: result.meta!.id,
              title: result.meta!.title,
              theme: result.meta!.theme,
              tags: result.meta!.tags,
              is_final: result.meta!.is_final,
              updated: result.meta!.updated,
            },
          });
        }

        case "append_entry": {
          const note_id = String(args.note_id ?? "");
          if (!note_id) return errContent("Missing note_id");
          const note = getNoteMeta(note_id);
          if (!note) return errContent(`Not found: ${note_id}`);
          if (!note.live) return errContent(`Note ${note_id} is not a live note (create with live:true to enable append_entry).`);
          if (note.is_final) return errContent(`Note ${note_id} is final; cannot append.`);

          // Validate refs (if any) point at existing entries on this note.
          const refs = Array.isArray(args.refs) ? args.refs.map(String) : undefined;
          const live = await import("../core/live");
          try {
            live.assertCanAppend(note);
          } catch (e: any) {
            return errContent(e?.message ?? String(e));
          }
          const jsonl = live.entriesPath(join(folioRoot(), note.path));
          if (refs && refs.length > 0) {
            const existing = new Set(live.readEntries(jsonl).map((e) => e.id));
            const bad = refs.filter((r) => !existing.has(r));
            if (bad.length > 0) return errContent(`refs reference unknown entry id(s): ${bad.join(", ")}`);
          }

          let result;
          try {
            result = live.appendEntry(jsonl, {
              content_html: String(args.content_html ?? ""),
              tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
              refs,
              importance: args.importance as 1 | 2 | 3 | 4 | 5 | undefined,
              source_ref: args.source_ref ? String(args.source_ref) : undefined,
              occurred_at: args.occurred_at ? String(args.occurred_at) : undefined,
            });
          } catch (e: any) {
            return errContent(e?.message ?? String(e));
          }

          const storage = await import("../core/storage");
          storage.updateLastEntryAt(note_id, result.entry.ts);
          // Fast-path SSE: notify the hub directly so subscribers don't wait
          // on fs.watch (which on macOS is sometimes coalesced/dropped under
          // load). Out-of-process appends still get picked up via fs.watch.
          const sseHub = await import("../core/sse-hub");
          sseHub.publish(note_id, jsonl);
          const entries = live.readEntries(jsonl);

          logEvent(
            "live_entry_appended",
            {
              entry_id: result.entry.id,
              tags_count: result.entry.tags.length,
              refs_count: result.entry.refs?.length ?? 0,
              content_size_bytes: Buffer.byteLength(result.entry.content_html, "utf-8"),
              rendered: result.entry.content_html.trim().length > 0,
              sanitizer_drops: result.sanitizer_drops,
            },
            note_id,
            note.thread_id,
          );

          scheduleAutoSync();
          return jsonContent({
            entry_id: result.entry.id,
            ts: result.entry.ts,
            entry_count: entries.length,
          });
        }

        case "list_entries": {
          const note_id = String(args.note_id ?? "");
          if (!note_id) return errContent("Missing note_id");
          const note = getNoteMeta(note_id);
          if (!note) return errContent(`Not found: ${note_id}`);
          if (!note.live) return errContent(`Note ${note_id} is not a live note.`);

          const since = args.since ? String(args.since) : null;
          if (since !== null && Number.isNaN(Date.parse(since))) {
            return errContent(`since is not a valid ISO timestamp: ${since}`);
          }
          const tagFilter = args.tag ? String(args.tag) : null;
          const limit = Math.min(typeof args.limit === "number" ? args.limit : 100, 500);

          const live = await import("../core/live");
          const jsonl = live.entriesPath(join(folioRoot(), note.path));
          const compiled = live.compile(live.readEntries(jsonl));

          let filtered = compiled;
          if (since !== null) filtered = filtered.filter((c) => c.ts > since);
          if (tagFilter !== null) filtered = filtered.filter((c) => c.compiled_tags.includes(tagFilter));

          return jsonContent({
            note_id,
            total: compiled.length,
            returned: Math.min(filtered.length, limit),
            entries: filtered.slice(0, limit),
          });
        }

        case "set_pinned": {
          const note_id = String(args.note_id ?? "");
          if (!note_id) return errContent("Missing note_id");
          const target = Array.isArray(args.entry_ids) ? args.entry_ids.map(String) : null;
          if (target === null) return errContent("Missing entry_ids (must be an array)");
          if (target.length > 5) return errContent("Cannot pin more than 5 entries at a time.");
          const note = getNoteMeta(note_id);
          if (!note) return errContent(`Not found: ${note_id}`);
          if (!note.live) return errContent(`Note ${note_id} is not a live note.`);
          if (note.is_final) return errContent(`Note ${note_id} is final.`);

          const live = await import("../core/live");
          try {
            live.assertCanAppend(note);
          } catch (e: any) {
            return errContent(e?.message ?? String(e));
          }
          const jsonl = live.entriesPath(join(folioRoot(), note.path));
          const all = live.readEntries(jsonl);
          const existingIds = new Set(all.map((e) => e.id));
          const bad = target.filter((id) => !existingIds.has(id));
          if (bad.length > 0) return errContent(`entry_ids reference unknown entry id(s): ${bad.join(", ")}`);

          const current = new Set(live.currentPinnedIds(all));
          const want = new Set(target);
          const toPin = [...want].filter((id) => !current.has(id));
          const toUnpin = [...current].filter((id) => !want.has(id));

          // Append pin/unpin entries. Both are pure tag-mutation entries
          // with empty content_html — won't render as standalone in the
          // feed but their tags compile onto the refs target.
          const storage = await import("../core/storage");
          const sseHub = await import("../core/sse-hub");
          for (const refId of toPin) {
            const r = live.appendEntry(jsonl, { content_html: "", tags: ["view:pinned"], refs: [refId] });
            storage.updateLastEntryAt(note_id, r.entry.ts);
            sseHub.publish(note_id, jsonl);
          }
          for (const refId of toUnpin) {
            const r = live.appendEntry(jsonl, { content_html: "", tags: ["view:unpinned"], refs: [refId] });
            storage.updateLastEntryAt(note_id, r.entry.ts);
            sseHub.publish(note_id, jsonl);
          }

          logEvent(
            "live_pinned_set",
            { target_count: target.length, pinned: toPin.length, unpinned: toUnpin.length },
            note_id,
            note.thread_id,
          );

          return jsonContent({
            note_id,
            target: [...want],
            pinned: toPin,
            unpinned: toUnpin,
          });
        }

        case "propose_round": {
          const note_id = String(args.note_id ?? "");
          if (!note_id) return errContent("Missing note_id");
          const variants = Array.isArray(args.variants) ? args.variants : [];
          if (variants.length === 0) return errContent("variants[] cannot be empty");
          const parent_variant_id = args.parent_variant_id != null ? String(args.parent_variant_id) : null;
          try {
            const iter = await import("../core/iteration");
            const result = iter.proposeRound({
              note_id,
              variants: variants.map((v: any) => ({
                content_html: String(v.content_html ?? ""),
                label: v.label != null ? String(v.label) : null,
              })),
              parent_variant_id,
            });
            return jsonContent(result);
          } catch (e: any) {
            return errContent(e?.message ?? String(e));
          }
        }

        case "pick_variant": {
          const note_id = String(args.note_id ?? "");
          const variant_id = String(args.variant_id ?? "");
          if (!note_id || !variant_id) return errContent("Missing note_id or variant_id");
          try {
            const iter = await import("../core/iteration");
            const result = iter.pickVariant({ note_id, variant_id });
            return jsonContent(result);
          } catch (e: any) {
            return errContent(e?.message ?? String(e));
          }
        }

        case "iteration_state": {
          const note_id = String(args.note_id ?? "");
          if (!note_id) return errContent("Missing note_id");
          const iter = await import("../core/iteration");
          const state = iter.getIterationState(note_id);
          if (!state) return errContent(`Note ${note_id} not found, or not an iteration note.`);
          return jsonContent(state);
        }

        case "wait_for_pick": {
          const note_id = String(args.note_id ?? "");
          if (!note_id) return errContent("Missing note_id");
          const for_round = typeof args.for_round === "number" ? args.for_round : undefined;
          const timeout_s = typeof args.timeout_s === "number" ? args.timeout_s : undefined;
          try {
            const iter = await import("../core/iteration");
            const result = await iter.waitForPick({ note_id, for_round, timeout_s });
            return jsonContent(result);
          } catch (e: any) {
            return errContent(e?.message ?? String(e));
          }
        }

        case "version": {
          const cfg = await loadConfig();
          return jsonContent({
            name: pkg.name,
            version: pkg.version,
            folio_root: folioRoot(),
            viewer_url: viewerLocalBaseUrl(cfg),
            public_url: viewerShareableBaseUrl(cfg), // null when not configured
            default_theme: cfg.theme,
            default_lifespan_days: cfg.default_lifespan_days,
          });
        }

        case "attach_asset": {
          const thread_id = String(args.thread_id ?? "");
          const filename = String(args.filename ?? "");
          if (!thread_id) return errContent("Missing thread_id");
          if (!isSafeAssetFilename(filename)) {
            return errContent("Invalid filename. Must match ^[a-zA-Z0-9._-]+$, ≤200 chars, no leading/trailing dot, no '..'.");
          }
          const allowedExt = /\.(jpe?g|png|webp|gif|svg|pdf|mp4)$/i;
          if (!allowedExt.test(filename)) {
            return errContent("Unsupported extension. Allowed: jpg, jpeg, png, webp, gif, svg, pdf, mp4.");
          }
          const hasB64 = typeof args.content_base64 === "string" && args.content_base64.length > 0;
          const hasSrc = typeof args.source_path === "string" && args.source_path.length > 0;
          if (hasB64 === hasSrc) {
            return errContent("Provide exactly one of: content_base64, source_path.");
          }
          let bytes: Uint8Array;
          try {
            if (hasB64) {
              bytes = Uint8Array.from(Buffer.from(String(args.content_base64), "base64"));
            } else {
              const src = String(args.source_path);
              if (!existsSync(src)) return errContent(`source_path does not exist: ${src}`);
              bytes = new Uint8Array(readFileSync(src));
            }
          } catch (e: any) {
            return errContent(`Failed to read asset: ${e?.message ?? e}`);
          }
          const dir = threadAssetsDir(thread_id);
          mkdirSync(dir, { recursive: true });
          const dest = join(dir, filename);
          writeFileSync(dest, bytes);
          const size_bytes = statSync(dest).size;
          const cfg = await loadConfig();
          const assetPath = `/t/${encodeURIComponent(thread_id)}/asset/${encodeURIComponent(filename)}`;
          // Absolute only with a configured public base; otherwise the
          // relative path — the form body_html should use anyway, and never a
          // 127.0.0.1 address posing as shareable (sc-6716).
          const publicBase = viewerShareableBaseUrl(cfg);
          const url = publicBase ? `${publicBase}${assetPath}` : assetPath;
          const local_url = `${viewerLocalBaseUrl(cfg)}${assetPath}`;
          return jsonContent({
            thread_id,
            filename,
            path: dest,
            url,
            local_url,
            size_bytes,
          });
        }

        case "publish": {
          const id = String(args.id ?? "");
          if (!id) return errContent("Missing id");
          // include_linked → a 'set' share: this note + every note it links to
          // (/n/<id>, computed cloud-side from synced bodies, bounded). Root is
          // still a note, so the local-existence check applies.
          const scope_type = (args.include_linked === true
            ? "set"
            : args.scope_type === "thread" ? "thread" : "note") as "note" | "thread" | "set";
          if (scope_type === "note" || scope_type === "set") {
            const note = getNoteMeta(id);
            if (!note) return errContent(`Not found locally: ${id}. If recently created, run \`folio sync --once\` first.`);
          }
          const { loadSyncState } = await import("../core/sync");
          const state = loadSyncState();
          if (!state) {
            return errContent("Not paired with a cloud. Run: folio sync pair --remote <url> --code <code>");
          }
          const body: Record<string, unknown> = {
            scope_type,
            scope_id: id,
            expires_in_days:
              typeof args.expires_in_days === "number" ? args.expires_in_days : 7,
          };
          if (typeof args.max_views === "number") body.max_views = args.max_views;
          // sc-7749: publish right after create used to 400 "note not found"
          // until the next sync tick. createShareSynced forces the sync and
          // retries (bounded); a silent cloud → "try again in a moment".
          const { createShareSynced } = await import("../core/publish");
          const result = await createShareSynced(state, body);
          if (!result.ok) return errContent(result.message);
          const out = result.body as {
            token: string;
            url: string;
            scope_type: string;
            scope_id: string;
            note_count?: number;
            expires_at: string | null;
            max_views: number | null;
          };
          return jsonContent({
            url: out.url,
            scope_type: out.scope_type,
            scope_id: out.scope_id,
            ...(out.scope_type === "set" ? { note_count: out.note_count ?? 1 } : {}),
            expires_at: out.expires_at,
            max_views: out.max_views,
            revoke_hint: `folio shares revoke ${out.token.slice(0, 12)}…`,
          });
        }

        default:
          return errContent(`Unknown tool: ${name}`);
      }
    } catch (e: any) {
      return errContent(`Error in ${name}: ${e?.message ?? String(e)}`);
    }
  });

  // ──────────────  RESOURCES  ──────────────
  // Folio exposes a small set of read-only resources for context-loading
  // without invoking tools. Useful when an agent wants to "browse" before deciding.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const cfg = await loadConfig();
    const resources: Resource[] = [
      { uri: "folio://recent", name: "Recent notes", description: `${cfg.viewer_host} most-recent 20 notes (metadata only)`, mimeType: "application/json" },
      { uri: "folio://final", name: "Final notes", description: "All notes marked is_final=true", mimeType: "application/json" },
      { uri: "folio://expiring", name: "Expiring soon", description: "Non-final notes within 7d of auto-delete", mimeType: "application/json" },
      { uri: "folio://threads", name: "All threads", description: "Thread index with counts + final markers", mimeType: "application/json" },
    ];
    // Plus each thread as its own resource
    const threads = listThreads(undefined, 100);
    for (const t of threads) {
      resources.push({
        uri: `folio://thread/${t.thread_id}`,
        name: `Thread: ${t.thread_id}`,
        description: `${t.count} notes${t.final_count > 0 ? ` (${t.final_count} final)` : ""}`,
        mimeType: "application/json",
      });
    }
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const respond = (payload: unknown) => ({
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
    });

    if (uri === "folio://recent") return respond(listNotes({ limit: 20 }));
    if (uri === "folio://final") return respond(listNotes({ is_final: true, limit: 100 }));
    if (uri === "folio://threads") return respond(listThreads(undefined, 200));
    if (uri === "folio://expiring") {
      const rows = db()
        .query<any, []>(
          `SELECT id, slug, title, type, thread_id, created, expires_at,
                  CAST(julianday(expires_at) - julianday('now') AS INTEGER) AS days_left
           FROM notes
           WHERE status='active' AND is_final = 0 AND expires_at IS NOT NULL
             AND expires_at < datetime('now', '+7 days')
           ORDER BY expires_at ASC`
        )
        .all();
      return respond(rows);
    }
    const threadMatch = uri.match(/^folio:\/\/thread\/(.+)$/);
    if (threadMatch) {
      const tid = decodeURIComponent(threadMatch[1]!);
      const notes = listNotes({ thread_id: tid, limit: 200 });
      return respond({ thread_id: tid, count: notes.length, notes });
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep alive; transport handles stdio lifecycle.
}
