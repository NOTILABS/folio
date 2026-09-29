# Folio MCP Server — agent setup

`folio-mcp` is a stdio MCP server exposing **11 tools** and **6 resources** to any MCP-capable agent: `create`, `get`, `list`, `search`, `finalize`, `unfinalize`, `suggest_thread`, `list_expiring`, `list_themes`, `export`, `version`.

The MCP server is registered under the name `folio`, so clients that namespace tools (mcporter, OpenClaw) invoke them as `folio.create`, `folio.search`, etc. The raw tool names themselves carry no prefix — that's a v0.2.0 change.

**Prerequisite:** install Folio so `folio-mcp` is on your `PATH` (see [`../README.md#install`](../README.md#install)). If you cloned the repo for development, use `bun /path/to/folio/bin/folio-mcp.ts` instead of `folio-mcp` below.

---

## Smoke test

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | folio-mcp
```

Returns a JSON-RPC response listing all 11 tools.

---

## OpenClaw (mcporter)

```bash
mcporter config add folio --command folio-mcp --scope home
```

Then link the Skill so the agent knows when/how to call Folio:

```bash
ln -s "$HOME/.local/folio/skills/folio" "$HOME/.openclaw/workspace/skills/folio"
```

After OpenClaw restart you should see `folio.*` tools in `mcporter list`. Invoke them as `mcporter call folio.create --args '<json>'` — `folio` is the server, `create` is the tool.

---

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "folio": {
      "command": "folio-mcp",
      "env": {
        "FOLIO_HOME": "/Users/you/Folio"
      }
    }
  }
}
```

`env.FOLIO_HOME` is optional (defaults to `~/Folio`).

---

## Claude Code

```bash
claude mcp add folio folio-mcp
```

---

## Cursor / Continue / OpenCode

Most MCP-capable editors accept the same shape: command `folio-mcp`, no args, optional `FOLIO_HOME` env var. Consult your client's MCP config docs.

---

## Response convention

After `create`, the tool returns a `response_hint` field suggesting the agent reply to the user with:

```
MEDIA:<public_url>
<3-5 line TL;DR>
```

The user clicks the link, the viewer renders the note. This is the core loop.

`public_url` exists only when `viewer_public_url` is configured (see README → Public URL). Otherwise it is `null` and the response has a `share_hint`: with cloud sync paired, call `publish({ id })` and send the returned `/p/<token>/n/<id>` URL; without a cloud there is no external link. `local_url` (`http://127.0.0.1:4810/n/<id>`) opens only on the machine running Folio — never send it to someone on another device.

---

## Recommended flow

1. **Decide:** does this output deserve rich layout (research, comparison, technical) or is a short text reply enough?
2. **Pre-create:** `suggest_thread({ title })` — if a matching thread exists, use its `thread_id`; otherwise use the proposed slug.
3. **Optional:** `list_themes` if uncertain which theme fits the content.
4. **Create:** `create` with type + title + body_html + thread_id (+ theme if non-default).
5. **Reply** with `MEDIA:<public_url>` (or the `publish` URL when `public_url` is null) + short TL;DR.
6. **Iterate:** when the user asks for another angle, call `create` again with the same `thread_id` (Folio is append-only; the previous version stays).

---

## Security model

- Stdio transport, local IPC only. No network exposure.
- Folio sanitizes agent-supplied `body_html` via a strict allowlist (`sanitize-html`). Top-level `<script>` is dropped.
- `<iframe>` is allowed, but the sandbox is forced — `allow-same-origin` is always stripped, `src` is restricted to `https:`, `on*` handlers are dropped. Agents can embed interactive content (CodeSandbox, Observable, custom srcdoc) without escaping the iframe.
- Files land in `$FOLIO_HOME` (default `~/Folio`). Check filesystem permissions there.

---

## Debug

```bash
folio-mcp 2>&1
```

stderr goes to terminal, stdout is reserved for JSON-RPC. Set `FOLIO_DEBUG=1` for stack traces.

---

## Bundled Skill

`skills/folio/SKILL.md` + `skills/folio/STYLEBOOK.md` + few-shot examples ship in the install package at `~/.local/folio/skills/folio/` (or wherever `FOLIO_PREFIX` points). Symlink it into your agent client's skill directory so the agent learns:

- When Folio is the right tool (triggers + anti-triggers)
- Which note type and theme fit which content
- How to structure HTML using the utility class contract
- That `<iframe sandbox>` is the way to ship interactive content
