---
name: folio
description: Creates visually-rich HTML knowledge artifacts in Folio (folio-mcp). Use when the user asks for research, comparison, deep dive, technical doc, ADR, spec, "save this", "compare X and Y", "TL;DR this URL", or anything that would benefit from tables, scorecards, diagrams, or color-coded findings. Also proactively when the answer would be a structured artifact (multi-section, tables, perspectives, recommendation block). Body changes flow through the `replace` MCP tool (agent-only); metadata (title/tags/theme/is_final) is editable inline in the viewer OR via `update_metadata`.
---

# Folio Skill

Folio generates visually rich HTML communication artifacts. Markdown in chat is flat; Folio gives you scorecards, color coding, in-page nav, tables, and themed presentation.

## Quick reference

- **Install root:** `~/.local/folio` (override via `$FOLIO_PREFIX`)
- **Storage:** `$FOLIO_HOME` (default `~/Folio/`)
- **Viewer:** `folio serve` → http://127.0.0.1:4810
- **MCP server name:** `folio`
- **Tools:** `create`, `get`, `list`, `list_revisions`, `search`, `replace`, `update_metadata`, `finalize`, `unfinalize`, `suggest_thread`, `list_themes`, `list_expiring`, `export`, `attach_asset`, `append_entry`, `list_entries`, `set_pinned`, `publish`, `propose_round`, `pick_variant`, `iteration_state`, `wait_for_pick`, `version`
- **Stylebook:** [`STYLEBOOK.md`](STYLEBOOK.md) — class contract with theme.css
- **Examples:** [`examples/<type>/`](examples/) — worked agent prompts + expected `body_html` per type
- **Detail references** (load only when relevant):
  - [`reference/live-notes.md`](reference/live-notes.md) — live notes, append_entry, tag conventions, chain-of-entries
  - [`reference/iteration-notes.md`](reference/iteration-notes.md) — iteration notes, propose_round, wait_for_pick, variant content_html
  - [`reference/themes.md`](reference/themes.md) — theme picker (linen / folio / dossier / atlas / plain / 16 others)
  - [`reference/assets.md`](reference/assets.md) — attach_asset, relative-URL rule, generating images (SVG vs raster)

---

## When to use Folio

**Language note.** Triggers below are intent patterns shown in English. Match equivalents in any language the user writes — Polish "przeanalizuj X z różnych perspektyw" is the same intent as "analyze X from multiple perspectives". Don't keyword-match the literal English string.

### YES (triggers)

- Research / expand / deep-dive / summarize a topic or URL → `research`
- Compare two or more things, list differences, scorecard → `comparison`
- **Analyze / evaluate / review / audit / critique X; "is X justified?"; rationale check** → `technical` or `research`
- **"From multiple perspectives", "tradeoffs of X", "pros and cons", "look at this from different angles"** — start in Folio BEFORE drafting prose
- ADR, technical decision, spec, design doc, architecture writeup → `technical`
- Explicit save intents: "make me a note about…", "save this to folio"
- **Show N versions / variants / design candidates / mockups / "I'll pick one and you iterate"** → `type: "iteration"` (see [`reference/iteration-notes.md`](reference/iteration-notes.md))
- After a long debrief conversation (interview, meeting) → offer `journal`

### Predict-first heuristic

If you can already tell the answer will need ≥2 of {multi-section headers, tables, scorecards, perspectives, recommendation/verdict block, comparison matrix} → start in Folio, not in chat. Don't write prose in chat then ghost-offer to save — most of the value (tables, color-coded findings, in-page nav) is already lost to flat markdown.

### NO (anti-triggers)

- Short conversational answer ("what time is it?", "what's RAG?" when two sentences suffice)
- One-off code snippet answering a precise question (unless the user explicitly says "save this")
- Editing files outside Folio (Folio doesn't edit other files)

---

## Mandatory loop (every Folio use)

```
1. suggest_thread({ title })
   ↳ matches.length > 0 → use the existing thread_id.
   ↳ Empty → use proposed_new_thread (new thread).

2. (optional) list_themes()
   ↳ Only when unsure about the theme. Cache in-session; don't re-call.

3. (optional) attach_asset({ thread_id, filename, content_base64 | source_path })
   ↳ For every image / PDF / video you want embedded.
   ↳ Reference returned `url` in body_html via the RELATIVE path /t/<thread>/asset/<file>.
   ↳ See reference/assets.md.

4. Decide the SHAPE of the deliverable before writing body_html:
   • SINGLE deliverable                  → static type (research/comparison/technical/journal/snippet)
   • APPEND-ONLY FEED (journal/todo/log) → live: true (see reference/live-notes.md)
   • N CANDIDATES FOR USER TO PICK FROM  → type: "iteration" (see reference/iteration-notes.md)
                                            NEVER inline N options in one body_html or one chat message.

5. Generate body_html per STYLEBOOK.md for the chosen theme.

6. create({ type, title, body_html, thread_id, theme?, tags?, live? })

7. Respond to the user:

      MEDIA:<link>        ← public_url, or the publish url (see below)
      <3-5 line TL;DR — essence, not the whole note>
      <Tags: tag1, tag2>   ← optional, when non-obvious
```

> **Link for a human: never `127.0.0.1` / `localhost`.** `local_url` opens only on the machine running Folio — a user on a phone, another LAN or Telegram gets a dead link. `public_url` is set only when `viewer_public_url` is configured; otherwise it is `null` and the response carries `share_hint`:
> - **paired with a cloud** → call `publish({ id })` first (for a living doc: `scope_type: "thread"`, `expires_in_days: 0`) and send the `url` from its response (`…/p/<token>/n/<id>`). Don't send the cloud's plain `/n/<uuid>` either — it needs a paired browser.
>   Calling `publish` right after `create` is fine: a note not yet synced gets pushed first (bounded wait, ~30 s). If `publish` errors with "try again in a moment", the cloud is slow or unreachable — retry later; it does **not** mean sharing is unavailable, so don't fall back to `local_url`.
> - **not paired** → there is no external link; say the note is saved in Folio (title/id) and give the TL;DR. Use `local_url` only if the user is reading on that same machine.
>
> Same rule for `replace` (`new_public_url`), live notes (`stream_url`) and `attach_asset` (`url` is the relative `/t/<thread>/asset/<file>` path when no public base is set).

> **Large body (transcript, long doc, pasted log)?** Don't cram it into the `body_html` string — a big inline argument can be silently truncated by the agent runtime before it reaches Folio. Instead write the HTML to a file and pass **`body_path`** (absolute path) to `create` / `replace`; Folio reads it server-side and sanitizes it identically. Provide exactly one of `body_html` / `body_path`.

When the user later asks to change the note, use the Mutation surfaces table below.

---

## Mutation surfaces (v0.22+)

Three places a note can change after creation:

| Surface | Who drives | Tool / UI | Effect |
|---|---|---|---|
| Body HTML | **Agent only** | `replace({old_id, body_html, …})` | New ULID + URL in same thread; old `.html` stays on disk; listings hide old. |
| Metadata (title / tags / theme / is_final) | Agent OR user | Agent: `update_metadata({id, …})`. User: inline editors in the viewer sidebar (click h1 to rename, × on chips, +add tag input, theme "Save as default" link). | Same `.html` regenerated atomically; body bytes untouched. |
| Live note entries | Agent only | `append_entry({…})` | Append-only feed; "edits" are follow-up entries with `refs:[X] tags:[state:done]`. |

### Decision tree

```
User says…                                      → Agent does…
─────────────────────────────────────────────────────────────────
"fix this typo in the body"                     → replace(old_id, …)
"polish this" / "different version"             → replace(old_id, …) for snippet/comparison/research
                                                  create(thread_id: same) for iteration/technical (variants are the point)
"show me the previous versions" / "history"     → list_revisions({id})  (read-only: v1…head of the replace chain)
"rename this to X"                              → update_metadata({id, title:"X"})
                                                  or "click the title in the viewer to rename inline"
"add tag X" / "retag this"                      → update_metadata({id, tags:[…]})
                                                  or "click × on a chip / type in the +add input"
"switch theme to folio"                         → update_metadata({id, theme:"folio"})
"mark this as final"                            → finalize({id})
"this isn't final after all"                    → unfinalize({id})
```

### Not a mutation surface

- **No body textarea in the viewer.** Users don't hand-edit body HTML in a browser — they ask the agent. Visual layer (themes, navigation, sharing) is for humans; content layer is for agents.
- ADR-014 still binds *for the bytes of a published `.html` file* — capability URL trust is intact. `replace` is not a rewrite; it's a new note with a pointer.
- The `replace` chain is **inspectable, not lost**: `list_revisions(id)` returns every revision v1…head, and the viewer shows a revision strip on any note in a chain. Superseded revisions stay reachable at their own `/n/<id>` (hidden from listings, never deleted) — the document behaves like a versioned log.

Never tell the user "Folio is append-only, I can't edit" — `replace` (body) and `update_metadata` (metadata) are the supported paths.

---

## Choosing `type`

Decision order:
1. **N candidates the user will pick between?** → `iteration` (do NOT dump in chat; see [`reference/iteration-notes.md`](reference/iteration-notes.md))
2. **Feed that grows over time?** → `live: true` (see [`reference/live-notes.md`](reference/live-notes.md))
3. Otherwise pick from the static-shape table:

| Prompt signal | Type |
|---|---|
| "show me N versions of X", "logo proposals", "mockups to choose from", "I'll pick one" | `iteration` |
| "compare", "vs", "differences between" — options user already has (Postgres vs MySQL) | `comparison` |
| "research", "deep dive", "everything about", "summarize URL" | `research` |
| "debrief", "diary", "summary of the day / meeting" | `journal` |
| "ADR", "technical decision", "spec", "proposal" | `technical` |
| "save this" + short content (<400 words), single point | `snippet` |
| **"slide deck", "presentation", "talk", "pokaz mi to w prezentacji"** | **`presentation`** (v0.26+) |
| **"recipe", "przepis", "danie", "drink", "cocktail", "jak zrobić X" (kuchnia/bar)** | **`recipe`** (v0.42+) |

**`comparison` vs `iteration` — the load-bearing distinction:** `comparison` = options the user already has (real things with known properties, agent renders side-by-side). `iteration` = options the agent generates (logo directions, hero layouts, email tone variants) where the user picks one and the agent refines.

> **Letting a *share recipient* pick on a `comparison` note (v0.34+):** if you want the **client you share the note with** to choose a variant (not you, and the agent doesn't need to react), wrap each option in `data-folio-pick="<id>"` and publish with `--allow-pick`. Their choice surfaces in your Share manager as a soft signal. This is NOT `iteration` — see STYLEBOOK "Client-pickable variants on a shared note". Reach for `iteration` only when the *agent* must react to the pick.

**`presentation` shape (v0.26+):** body_html is a sequence of `<section class="slide">` blocks. The viewer hides all but the current and adds keyboard nav (← / → / Space / Home / End / digit 1-9), F → fullscreen, S → speaker mode (reveals `<aside class="notes">` inside the current slide). Theme: usually `plain` because each slide wants its own typography + layout. Skeleton:

```html
<style>
  .slide { background: #f5f3ee; }
  .slide h1 { font-size: 64px; font-family: 'Familjen Grotesk', sans-serif; }
  .slide.cover { background: #0a0a0a; color: #f5f3ee; }
</style>
<section class="slide cover">
  <h1>Project Atlas</h1>
  <p>Q3 review · 2026-09-15</p>
  <aside class="notes">Open with the cost slide first if the room is execs.</aside>
</section>
<section class="slide">
  <h1>The plan in three numbers</h1>
  <ul><li>3 teams</li><li>14 services</li><li>1 launch</li></ul>
</section>
<!-- as many <section class="slide"> blocks as you need -->
```

If unclear → ask one question. If a prompt mentions "wariantów / versions / propositions / mockups" + "I'll pick / wybiorę / choose one", treat as iteration.

**`recipe` shape (v0.42+) — STRUCTURED, not HTML.** Do NOT write `body_html`. Pass a `recipe` object and the server renders a responsive, self-contained layout (mobile single-column / desktop sticky-ingredients-rail, tap-to-check ingredients, a servings scaler, print styles). One schema covers a dish and a drink (`kind`). Only `ingredients` + `steps` are required. Full field reference + dish/drink examples in [`reference/recipe.md`](reference/recipe.md). Minimal call:

```
create({ type: "recipe", title: "Negroni", recipe: {
  kind: "drink",
  meta: { servings: "1 drink", glass: "tumbler", method: "built" },
  ingredients: [{ items: [
    { qty: 30, unit: "ml", name: "gin" },
    { qty: 30, unit: "ml", name: "Campari" },
    { qty: 30, unit: "ml", name: "czerwony wermut" } ] }],
  steps: [ { text: "Wlej składniki do szklanki z lodem i zamieszaj." },
           { text: "Udekoruj plasterkiem pomarańczy." } ] } })
```

Numeric `qty` enables the servings scaler — prefer numbers over strings ("do smaku" is fine where there's genuinely no amount). Hero image: `attach_asset` first, then pass the relative URL as `recipe.image`. Edit later via `replace({ old_id, recipe: {…} })` — re-send the (compact) data, not HTML. Escape hatch: `type:"recipe"` with hand-written `body_html` still works if you need full control.

---

## Choosing `theme`

Default: **linen** unless the user said otherwise. Suggest override only when context strongly fits ("make me an ADR" → `folio`; "build me a poster" → `plain`). Full picker in [`reference/themes.md`](reference/themes.md).

After picking, call `list_themes()` and read the relevant `prompt_addendum` — themes dictate markup style (newsroom prose-forward, brutalist short sentences, atlas drop-cap opening). Cache in-session.

---

## Stylebook (contract with theme.css)

Full spec in [`STYLEBOOK.md`](STYLEBOOK.md). Quick rules:

**Allowed utility classes:** `.eyebrow`, `.lead`, `.card`, `.cards`, `.verdict`, `.pill` (variants: `.good`, `.bad`, `.mid`, `.acc`, `.info`).

**DO NOT:**
- ❌ `style="..."` inline (except bar widths, custom accents, or theme `plain`)
- ❌ `<html>` / `<head>` / `<body>` / `<title>` / `<meta>` — the template wraps your fragment
- ⚠️ `<style>` at body level — allowed since v0.15 but **default to theme classes**. Reach for it only when using `plain` or utilities genuinely don't fit. Never redefine `.eyebrow` / `.card` / `.pill`.
- ❌ Deprecated HTML4 tags (`<font>`, `<center>`)
- ❌ Raw hex colors in attributes — use classes
- ❌ Full-domain links to other Folio notes (`http://127.0.0.1:4810/n/…`) — use root-relative `/n/<id>` / `/p/<slug>` / `/t/<thread>`. The viewer breaks them out of the note iframe + resolves them per scope so they survive publish. See [`STYLEBOOK.md`](STYLEBOOK.md) "Linking to other Folio notes".

**Allowed (v0.17.1+):**
- `<script>` at body level — runs in null-origin sandboxed iframe with CSP `connect-src 'none'` + `form-action 'none'`. Can build DOM; cannot reach parent, cookies, or network.
- Form controls (`<button>`, `<input>`, `<select>`, `<textarea>`, `<label>`, `<form>`) + `role` / `tabindex` / `aria-*` + `data-*`
- Inline `<svg>` (full attribute support since v0.19.3)
- `<details><summary>` for native expand/collapse — no JS needed
- Third-party `<iframe>` embeds (YouTube, CodeSandbox, Loom) — `src` must be `https://`, sanitizer enforces sandbox

---

## Tagging

`tags` in `create`:
- Specific: `["postgres", "saas", "comparison"]`, not generic `["analysis"]`
- Lowercase, kebab-case
- 2-5 tags per note, no more
- A tag = what the user will use when searching

### Project tag — `project:<slug>` is the load-bearing pattern (v0.20+)

A `thread_id` is **one document and its iterations**. One project usually spans **many threads** — research, decisions, design, ops log. Folio has no folder/project entity above threads; the convention is a `project:<slug>` tag on every note in the project. The viewer surfaces it two ways:

- **`/p/<slug>`** — project workspace: slot cards + pending picks on top, then one card per thread with **its notes listed inside** (each row clicks straight to the note), recent activity at the bottom. Best mental model for users coming from Obsidian folders.
- **`/tag/project:<slug>`** — flat list of every project-tagged note across threads.

> **`project:` is a literal keyword — never translate it.** The `/p/<slug>` workspace matches the exact ASCII prefix `project:`. A localized prefix (Polish `projekt:`, German `projekt:`, French `projet:`, …) **silently breaks** the grouping: the note still appears under `/tag/<your-prefix>:<slug>`, but `/p/<slug>` stays empty. This is the one spot where the **Language note** at the top inverts — translate trigger *intents*, but keep tag *keywords* verbatim in ASCII. Same rule for **every namespace Folio's code interprets** — `project:`, `slot:`, `state:`, `view:pinned` — plus the canonical `state:` values (`open` / `in_progress` / `done` / `cancelled`, which the kanban lanes match literally). A localized `stan:gotowe` breaks state decoration and kanban placement exactly the way `projekt:` breaks `/p/`. Translate only the prose *inside* an entry, never these.

Always tag project work, and tell the user where it lands:

```
create({ type: "research", title: …, thread_id: "onboarding",
        tags: ["project:repcoach-fit", "research", "onboarding"], … })
```

Response: `MEDIA:<url>` (link rules from step 7) + *"see all project threads at `/p/<slug>`"*.

### Slot tag — `slot:<name>` marks canonical docs (v0.24+)

A project usually has a handful of **canonical living documents** — one roadmap, one todo list, one changelog. Without a convention, the agent has to search by title every time the user says "update the roadmap"; the viewer can't surface them as first-class cards in `/p/<slug>`.

Pair `project:<slug>` with `slot:<name>` on the note that IS the project's roadmap / todo / changelog / etc. The viewer's project workspace reads slot tags and renders them as pinned cards above the thread list. Agents see them in the dashboard payload too — "what's the latest roadmap?" → search `slot:roadmap project:<slug>`, take head.

**Standard slot names:**

| Slot | Type usually | Mutation pattern | What it is |
|---|---|---|---|
| `slot:roadmap` | `technical` | `replace` on each revision | Where the project is going (next N weeks) |
| `slot:todo` | live, `inline: true` | `append_entry` + `state:*` tags | Open work items, drift through states |
| `slot:changelog` | live, `inline: true` | `append_entry` only | What shipped / what changed (append-only feed) |
| `slot:release-notes` | `technical` | `replace` per release | Customer-facing release writeup |
| `slot:vision` | `research` or `technical` | `replace` rarely | Why this project exists (north star) |
| `slot:hub` | `technical`, `theme: "plain"` | `replace` as needed | User-curated project dashboard (assembled by hand) |
| `slot:presentation` | `theme: "plain"` slide deck | `replace` per audience | Whatever you'd show in a meeting |
| `slot:gantt` | `technical`, `theme: "plain"` | `replace` per re-plan | Date-anchored timeline (until v0.27 timeline primitive ships) |

Exactly **one head note per slot per project**. If two exist, the viewer picks the most recently updated one and surfaces a warning — fix by superseding the older via `replace`, or just deleting it.

**Workflow examples:**

```
# First-time roadmap setup
create({ type: "technical", title: "Web redesign roadmap", thread_id: "web-redesign-roadmap",
         tags: ["project:web-redesign", "slot:roadmap"], … })

# User: "update the roadmap with what we agreed today"
search({ q: "slot:roadmap project:web-redesign", limit: 1 })  → find current head
replace({ old_id: <head>, body_html: <new full roadmap>, … })   → new head, old superseded

# User: "add 'password-reset flow' to todo"
search({ q: "slot:todo project:web-redesign", limit: 1 })     → find the live todo note
append_entry({ note_id: <id>, content_html: "<p>Add the password-reset flow</p>",
              tags: ["project:web-redesign", "state:open"] })

# User: "what's left on the redesign?"
search({ q: "slot:todo project:web-redesign" }) → list_entries({ note_id, tag: "state:open" })
```

**Anti-pattern:** ❌ creating a new note titled "Roadmap v2" with `slot:roadmap` instead of `replace`-ing the existing one. Two slot:roadmap heads in one project is a fight; `replace` is the canonical update path for canonical docs.

---

## Anti-patterns

- ❌ **Spamming `create`** for things that should live in agent memory or chat (short answers like "what's RAG?")
- ❌ **Skipping `suggest_thread`** → creates duplicate threads. ALWAYS check first.
- ❌ **Listing 3+ design candidates inline in chat** ("Wariant 1: …, Wariant 2: …, Wariant 3: …") instead of an iteration note. If you're about to type "here are N options for you to choose from" — STOP and call `create({ type: "iteration" })` + `propose_round` instead.
- ❌ **Putting iteration variants inside `body_html` of a regular note** — no gallery, no click-to-pick, no lineage.
- ❌ **Generating body without consulting the stylebook** → notes look inconsistent.
- ❌ **Missing metadata** (tags) — hurts retrieval.
- ❌ **Inline-styled HTML like it's 2005** — use the theme classes.
- ❌ **Refusing to edit "because Folio is append-only".** v0.22+ ships `replace` (body) and `update_metadata` (metadata) — there is no "I can't edit" answer.
- ❌ **Marking `is_final: true` on your own** — user's call, unless they explicitly asked.
- ❌ **Inlining base64 binaries in `body_html`** — use `attach_asset` then reference the relative path.
- ❌ **ASCII-art diagrams** (`<pre>` boxes of `| - >`) for architecture / flows / sequences. Notes render in a real browser — use a real graphic. Cheapest: **Mermaid** (declarative, CDN) for static diagrams; **D3 / Cytoscape** (data as a JS object) for interactive ones; hand-authored inline `<svg>` when offline rendering must be guaranteed. See the **Diagrams** section of [`STYLEBOOK.md`](STYLEBOOK.md).
- ❌ **Hallucinating image URLs.** No `attach_asset` and no inline `<svg>` = no image. Don't write `<img src="https://example.local/cool-logo.png">` and hope. See [`reference/assets.md`](reference/assets.md).
- ❌ **Using the absolute `url` from `attach_asset`** inside `body_html` — use the RELATIVE `/t/<thread>/asset/<file>` path so the image works under whatever origin (local viewer / Tailscale Funnel / capability URL / cloud).

---

## Surfacing expiring notes (proactive)

Per ADR-019 — hard gating:

**YES surface:**
- ✅ User is already in a Folio-related conversation (words: "folio", "note", "research", used `folio.*` in this session)
- ✅ Natural moment after `create` or `export` — "BTW thread X has 2 more notes expiring"

**NO surface:**
- ❌ Unrelated conversation (Python helper, debugging something else)
- ❌ Same `id` twice within 24h (idempotency)
- ❌ More than 5 notes at once

Mechanism:
```
list_expiring({ within_days: 7, limit: 5 })
↳ If non-empty AND in a Folio convo:
   "BTW you have <N> notes expiring: <title 1, title 2, …>.
    Finalize any? `folio finalize <id>`."
```
