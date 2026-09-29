# Attaching assets to threads (v0.7.0+)

## Contents
- When to attach
- Call shape + embed patterns
- Filename rules
- Overwrite vs versioning
- Relative URLs vs absolute (the load-bearing rule)
- Generating images from scratch (vector vs raster vs external)

---

`attach_asset` drops a binary (image, PDF, video) into `threads/<thread_id>/assets/<filename>` and returns a stable URL you can paste into `body_html`. Use it instead of inlining base64 in HTML — base64 bloats the note, breaks copy-as-markdown, and the file gets buried.

## When to attach

- ✅ Agent generated a chart / diagram and wants it visible in the note
- ✅ User dropped a photo into chat ("save this to today's journal")
- ✅ Long PDF user wants kept beside the research summary
- ✅ Telegram / email bot relaying media → assetize it, then reference the URL in the note body

## Call shape

```
attach_asset({
  thread_id: "morning-ride-2026-05-12",
  filename: "speed-chart.png",
  content_base64: "<base64>"     // OR source_path: "/abs/path/file.png"
})
↳ returns { thread_id, filename, path, url, local_url, size_bytes }
```

## Embed patterns

```html
<img src="<url>" alt="Speed over time — peaks at 38 km/h around km 14" width="800">
<video src="<url>" controls></video>
<a href="<url>" target="_blank">↗ Open PDF</a>
```

Always write a real `alt` — binary content is NOT FTS-indexed; the alt text is what makes the asset searchable. Set `width`/`height` on `<img>` to prevent layout shift.

## Filename rules (enforced server-side, errors loudly)

- ASCII alphanumeric + `.` `_` `-`, ≤ 200 chars
- No leading/trailing dot, no `..`, no path separators
- Extension allowlist: `jpg / jpeg / png / webp / gif / svg / pdf / mp4`
- Use slug-style names: `speed-chart.png`, `route-map-v2.svg`, `q3-report.pdf`

## Overwrite vs versioning

- Same `filename` = overwrites in place (idempotent upload — useful for retrying)
- Want to keep both versions? Use a new filename (`chart-v2.png`). The note that referenced `chart.png` keeps pointing to whatever bytes are at that path.
- Note files themselves stay append-only (ADR-014). Asset overwrite is a separate convention.

## Order with `create`

Attach first (you need the URL), then `create` with `body_html` that references it. Same `thread_id` in both calls.

## Relative URLs are usually right

Folio rewrites image URLs at render time. Use the **relative** form `/t/<thread>/asset/<filename>` inside `body_html`, NOT the absolute `url` from the `attach_asset` response.

- A relative URL renders correctly under whatever origin the user is viewing the note from — local viewer (`127.0.0.1:4810`), reverse-proxied public host, Tailscale Funnel, capability URL on cloud — all transparent.
- The absolute `url` returned by `attach_asset` is built from `viewer_public_url` in config. Without `viewer_public_url` it is just the relative `/t/<thread>/asset/<file>` path (Folio never hands out a `127.0.0.1` address as shareable); `local_url` stays for this machine only. If a recipient browses through a DIFFERENT host (Tailscale interface, alias domain, capability URL on a different cloud), absolute URLs break.
- Capability URL rewrites (`/p/<token>/t/.../asset/...`) hook on the `/t/<thread>/asset/<file>` substring — relative or absolute both match, but relative produces cleaner output.

```html
<!-- ✅ inside body_html: relative path -->
<img src="/t/morning-ride-2026-05-12/asset/speed-chart.png" alt="Speed over time" width="800">

<!-- ❌ inside body_html: absolute URL with viewer_public_url -->
<img src="https://my-folio.example.com/t/morning-ride-2026-05-12/asset/speed-chart.png" ...>
<!-- breaks when user opens the note through Tailscale Funnel, capability URL on cloud, or local viewer -->

<!-- ✅ in an email / Telegram message: absolute URL -->
<a href="https://my-folio.example.com/t/.../asset/...">↗ Open</a>
```

Use the absolute `url` only when relaying outside Folio (email body, Telegram, anywhere the recipient won't be viewing through a Folio origin).

---

# Generating images from scratch (v0.19.3+)

When the agent has an image to show that doesn't exist as a file yet (generated logo, icon, diagram, illustration, chart), pick the right tool — none of them is "hallucinate a URL".

## 1. Vector content → inline `<svg>` (preferred for logos/icons/diagrams)

Since v0.19.3 the sanitizer fully supports inline SVG with `viewBox` (case preserved), `<defs>`, `<marker>` (arrows), gradients, all paint + typography attrs. For logos, app icons, diagrams, simple illustrations, and any flat-color graphic the agent can describe as shapes + text, **inline SVG is the right answer.**

Benefits: vector (scales to any size), themable (CSS variables apply), no external dependency, text content inside `<text>` elements is FTS-indexed.

For iteration notes specifically (6 logo variants, 3 icon directions), each variant's `content_html` should be inline SVG. See [`iteration-notes.md`](iteration-notes.md) for the SVG variant skeleton.

## 2. Raster content the agent has the bytes of → `attach_asset`

If the agent has access to an image-generation tool (DALL·E, Imagen, Midjourney via MCP, etc.) and gets bytes back, save them via `attach_asset`:

```
attach_asset({
  thread_id,
  filename: "hero-bg-v1.png",      // slug-style, descriptive, forever
  content_base64: "<bytes>"
})
→ { url, local_url, ... }
```

Then reference the asset in `body_html` via the **relative path** `/t/<thread>/asset/<filename>` (see the "Relative URLs" rule above). NEVER inline base64 into `body_html`.

## 3. External-hosted raster → `<img src="<absolute https URL>">`

Only if the image actually lives at a stable public HTTPS URL the agent KNOWS exists (e.g. a CDN, a Wikipedia image, a public API response that returns an image URL). The sanitizer allows `https:` and `data:` schemes for `<img>`.

## What NOT to do

- ❌ **Hallucinating image URLs.** If you didn't call `attach_asset` and didn't generate inline SVG, there is no image. Writing `<img src="https://my-server.local/cool-logo-1.png">` produces a broken link.
- ❌ **Inline base64 in `body_html`.** Bloats the note, breaks copy-as-markdown, no FTS lift. Use `attach_asset`.
- ❌ **External URLs you can't verify.** Don't grab a random image URL from training data and hope it's still up.
- ❌ **For logos / icons specifically: using raster when SVG would do.** A `<svg viewBox="0 0 48 48">` with shapes is almost always better than a 512×512 PNG of the same logo.
