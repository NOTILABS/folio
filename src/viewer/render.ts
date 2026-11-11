import type { NoteMeta, SearchHit } from "../core/types";
import { db } from "../core/db";
import { resolveHeadOfChain, getRevisionChain, listPopularTags, type ContinueRailItem, type ProjectDashboard } from "../core/storage";
import { listThemes } from "../core/themes";
import { panelIframeSrcdoc, LIVE_CHROME_JS } from "./live-panel";
import { renderModeOf } from "../core/note-log";
import { ENTRIES_CSS } from "./entries-css";
import { themesDir, bundledThemesDir } from "../core/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

/** Sync theme.css read. Mirrors viewer/server.ts resolveTheme without
 *  creating a circular import (render.ts is imported by server.ts). */
function loadThemeCss(name: string): string | null {
  for (const root of [themesDir(), bundledThemesDir()]) {
    const p = join(root, name, "theme.css");
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  return null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function ago(iso: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function daysUntil(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  const d = Math.floor(ms / 86400000);
  if (d < 0) return "expired";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `${d}d`;
}

function dateGroup(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dDay = new Date(d);
  dDay.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - dDay.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This week";
  if (diffDays < 30) return "This month";
  return "Older";
}

const VIEWER_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400..700&family=Instrument+Serif:ital@0;1&family=Inter:wght@300..700&family=JetBrains+Mono:wght@300..600&display=swap');

:root {
  --vbg:       #f5f3ee;
  --vbg-2:     #efeae0;
  --vbg-3:     #e8e3d5;
  --vpanel:    #fdfcf9;
  --vink:      #0a0a0a;
  --vink-2:    #1a1a1a;
  --vmuted:    #6b6b66;
  --vmuted-2:  #a8a89e;
  --vline:     rgba(10,10,10,0.10);
  --vline-2:   rgba(10,10,10,0.06);

  --vorange:   #ff5a1f;
  --vorange-soft: rgba(255,90,31,0.10);
  --vorange-glow: rgba(255,90,31,0.22);
  --vamber:    #c98e2d;
  --vgood:     #2f9050;
  --vblue:     #2c4ad9;
  --vbronze:   #8b6535;
  --vpurple:   #6b3e9a;

  --vhead:  'Familjen Grotesk', 'Inter', system-ui, sans-serif;
  --vbody:  'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --vserif: 'Instrument Serif', Georgia, serif;
  --vmono:  'JetBrains Mono', 'SF Mono', ui-monospace, monospace;

  --gutter: 32px;
  --content-max: 720px;
  --list-max:    1100px;
  --chrome-max:  1400px;
}

* { box-sizing: border-box; }
html, body {
  background: var(--vbg);
  color: var(--vink);
  font-family: var(--vbody);
  margin: 0; padding: 0;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: inherit; text-decoration: none; }
::selection { background: var(--vorange); color: var(--vpanel); }

.v-top { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--vbg) 92%, transparent); backdrop-filter: saturate(140%) blur(8px); -webkit-backdrop-filter: saturate(140%) blur(8px); border-bottom: 1px solid var(--vline); }
.v-top-inner { max-width: var(--chrome-max); margin: 0 auto; padding: 14px var(--gutter); display: flex; align-items: center; gap: 22px; }
.v-logo { display: flex; align-items: baseline; gap: 14px; font-family: var(--vhead); font-weight: 500; letter-spacing: -0.035em; line-height: 1; color: var(--vink); }
.v-logo .mark { font-size: 26px; }
.v-logo .mark .dot { color: var(--vorange); }
.v-logo .div { width: 1px; height: 18px; background: var(--vline); align-self: center; }
.v-logo .tagline { font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--vmuted-2); font-weight: 400; }
.v-search { flex: 1; max-width: 520px; background: var(--vpanel); border: 1px solid var(--vline); border-radius: 10px; padding: 8px 14px; display: flex; align-items: center; gap: 10px; font-family: var(--vmono); font-size: 13px; transition: border-color .15s, box-shadow .15s, background .15s; }
.v-search:focus-within { border-color: var(--vorange); box-shadow: 0 0 0 4px var(--vorange-soft); background: #fff; }
.v-search .ico { color: var(--vmuted-2); font-size: 12px; }
.v-search input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--vink); font-family: var(--vmono); font-size: 13px; }
.v-search input::placeholder { color: var(--vmuted-2); }
.v-search kbd { font-family: var(--vmono); font-size: 10px; padding: 2px 6px; border-radius: 4px; background: var(--vbg-2); color: var(--vmuted); border: 1px solid var(--vline); }
.v-nav { display: flex; gap: 2px; }
.v-nav a { padding: 6px 12px; border-radius: 7px; color: var(--vmuted); font-size: 13.5px; font-family: var(--vhead); font-weight: 500; letter-spacing: -0.005em; transition: color .12s, background .12s; }
.v-nav a:hover { color: var(--vink); background: var(--vbg-2); }
.v-nav a.on { color: var(--vink); background: var(--vbg-2); }
.v-nav a.on::after { content: ""; display: block; height: 2px; margin: 4px -4px -8px; background: var(--vorange); border-radius: 1px; }

.v-strip { border-bottom: 1px solid var(--vline); background: var(--vbg); }
.v-strip-inner { max-width: var(--chrome-max); margin: 0 auto; padding: 12px var(--gutter); display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

/* v0.28 — tag bar promoted to header, just below filter bar. Same vbg
   background, slightly softer separator. Single horizontal scroll row;
   namespaced tags (project:, slot:, kind:) lead. */
.v-tagbar { border-bottom: 1px solid var(--vline-2); background: var(--vbg); }
.v-tagbar-inner { max-width: var(--chrome-max); margin: 0 auto; padding: 9px var(--gutter); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.v-tagbar-lbl { font-family: var(--vmono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--vmuted-2); font-weight: 600; margin-right: 4px; }
/* v0.29.1 — header tag chips reuse the side-panel pill aesthetic
 * (.side-tags .tg). The previous override only set padding/font-size,
 * which meant chips inherited zero visual treatment outside .tag-cloud:
 * no background, no border, no separator → "kind:bug3" rendered as one
 * unreadable string. This rebuilds the chip from scratch in the tagbar
 * scope: monospace pill, muted background, line border, namespace
 * prefix dimmed, count separated by a thin divider. Hover → orange.
 * Active → inverted dark fill (matches .fp.on style for filter pills). */
.v-tagbar .tag-chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--vmono); font-size: 10.5px;
  padding: 3px 8px; border-radius: 4px;
  background: var(--vbg-2); color: var(--vink-2);
  border: 1px solid var(--vline-2);
  text-decoration: none;
  transition: color .12s, border-color .12s, background .12s;
  max-width: 100%; overflow-wrap: anywhere; word-break: break-word;
}
.v-tagbar .tag-chip:hover { color: var(--vorange); border-color: var(--vorange); background: var(--vpanel); }
.v-tagbar .tag-chip.on { background: var(--vink); border-color: var(--vink); color: var(--vbg); }
.v-tagbar .tag-chip .ns { color: var(--vmuted-2); opacity: 0.85; font-weight: 400; }
.v-tagbar .tag-chip .val { font-weight: 600; }
.v-tagbar .tag-chip .count {
  font-size: 9.5px; color: var(--vmuted-2);
  padding-left: 6px;
  border-left: 1px solid var(--vline);
  line-height: 1;
}
.v-tagbar .tag-chip.on .ns { color: var(--vamber); opacity: 0.9; }
.v-tagbar .tag-chip.on .count { color: var(--vbg); opacity: 0.7; border-left-color: color-mix(in srgb, var(--vbg) 25%, transparent); }
@media (max-width: 720px) {
  .v-tagbar-inner { flex-wrap: nowrap; overflow-x: auto; padding-right: 24px; }
  .v-tagbar-inner > * { flex: 0 0 auto; }
}
.fp { padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; background: transparent; border: 1px solid var(--vline); color: var(--vmuted); font-family: var(--vbody); display: inline-flex; align-items: center; gap: 7px; transition: color .12s, background .12s, border-color .12s, transform .12s; }
.fp:hover { color: var(--vink); border-color: var(--vink); }
.fp:active { transform: translateY(1px); }
.fp.on { background: var(--vink); border-color: var(--vink); color: var(--vbg); }
.fp.on .count { color: var(--vbg); opacity: 0.7; }
.fp.warn.on { background: var(--vamber); border-color: var(--vamber); color: #fff; }
.fp .count { font-family: var(--vmono); font-weight: 500; opacity: 0.7; font-size: 11px; }
.fp .star { color: var(--vorange); }
.v-strip .sep { width: 1px; height: 18px; background: var(--vline); margin: 0 6px; }
.v-strip .results-meta { margin-left: auto; font-family: var(--vmono); font-size: 11.5px; color: var(--vmuted-2); text-transform: lowercase; letter-spacing: 0.04em; }

.v-page { max-width: var(--list-max); margin: 0 auto; padding: 28px var(--gutter) 96px; }
.v-page.wide { max-width: var(--chrome-max); }

.group { margin-bottom: 36px; }
.group-lbl { display: flex; align-items: baseline; gap: 14px; font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--vmuted-2); font-weight: 500; padding: 0 4px 10px; border-bottom: 1px solid var(--vline); margin-bottom: 6px; }
.group-lbl .count { color: var(--vmuted); }
.group-lbl .spacer { flex: 1; }
.group-lbl .accent { color: var(--vorange); font-style: italic; font-family: var(--vserif); text-transform: none; letter-spacing: 0; font-size: 15px; font-weight: 400; }

.hero { display: grid; grid-template-columns: 1fr auto; gap: 24px; padding: 22px 4px 26px; border-bottom: 1px solid var(--vline); align-items: end; margin-bottom: 6px; cursor: pointer; transition: background .15s; }
.hero:hover { background: linear-gradient(180deg, transparent, var(--vbg-2)); }
.hero .eyebrow { display: flex; align-items: center; gap: 12px; font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--vmuted); margin-bottom: 16px; }
.hero .eyebrow .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vorange); box-shadow: 0 0 0 4px var(--vorange-soft); }
.hero h1 { font-family: var(--vhead); font-weight: 500; font-size: clamp(32px, 4.4vw, 52px); line-height: 1.02; letter-spacing: -0.035em; margin: 0 0 14px; max-width: 18ch; text-wrap: balance; }
.hero .lead { font-family: var(--vserif); font-size: 18px; font-style: italic; color: var(--vmuted); line-height: 1.5; max-width: 56ch; margin: 0 0 18px; }
.hero .meta { display: flex; gap: 16px; flex-wrap: wrap; font-family: var(--vmono); font-size: 11.5px; color: var(--vmuted); align-items: center; }
.hero .meta .pip { width: 4px; height: 4px; border-radius: 50%; background: var(--vmuted-2); }
.hero .meta .thread { color: var(--vbronze); }
.hero .meta .final { color: var(--vorange); font-weight: 600; }
.hero-arrow { align-self: end; font-family: var(--vhead); font-weight: 400; font-size: 56px; line-height: 1; color: var(--vmuted-2); transition: transform .25s, color .15s; }
.hero:hover .hero-arrow { transform: translateX(8px); color: var(--vorange); }

.rows { display: flex; flex-direction: column; }
.row { display: grid; grid-template-columns: 88px minmax(0, 1fr) 92px auto; gap: 18px; padding: 12px 8px; align-items: baseline; border-bottom: 1px solid var(--vline-2); color: var(--vink); position: relative; transition: background .12s; }
.row::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: transparent; transition: background .12s; }
.row:hover { background: var(--vbg-2); }
.row:hover::before { background: var(--vorange); }
.row .type { font-family: var(--vmono); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.14em; font-weight: 600; color: var(--vmuted); padding-top: 1px; }
.row .type.research    { color: var(--vorange); }
.row .type.comparison  { color: var(--vbronze); }
.row .type.technical   { color: var(--vblue); }
.row .type.journal     { color: var(--vgood); }
.row .type.snippet     { color: var(--vmuted); }
.row .type.recipe      { color: var(--vgood); }
.row .title { font-family: var(--vhead); font-weight: 500; font-size: 18px; line-height: 1.3; letter-spacing: -0.015em; color: var(--vink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.row .title-sub { display: block; font-family: var(--vmono); font-size: 11px; color: var(--vmuted); font-weight: 400; letter-spacing: 0; margin-top: 3px; }
.row .title-sub .thread:hover { color: var(--vorange); }
.row .age { font-family: var(--vmono); font-size: 11.5px; color: var(--vmuted-2); text-align: right; }
.row .stat { font-family: var(--vmono); font-size: 11.5px; text-align: right; min-width: 56px; }
.row .stat.final { color: var(--vorange); font-weight: 600; }
.row .stat.warn  { color: var(--vamber); }
.row .stat .star { font-style: normal; }

.row.with-snippet { padding: 14px 8px; align-items: start; }
.row.with-snippet .snippet { font-family: var(--vserif); font-size: 16px; font-style: italic; color: var(--vmuted); line-height: 1.55; margin-top: 6px; max-width: 64ch; }
.row.with-snippet .snippet mark { background: var(--vorange-soft); color: var(--vink); padding: 0 3px; border-radius: 2px; font-style: normal; font-weight: 500; font-family: var(--vbody); }

/* v0.23 — Continue-rail. Soft orange band that sits between filter strip
   and the date-grouped notes list. Shown only on the bare home view
   (no activeType / activeStatus / activeTag) and only when the score
   query returned at least one item. Score is recency × frequency from
   the events table; see listContinueRail() in storage.ts. */
.v-rail { margin: 0 calc(-1 * var(--gutter, 32px)) 22px; padding: 18px var(--gutter, 32px) 22px; background: linear-gradient(180deg, var(--vorange-soft) 0%, transparent 100%); border-bottom: 1px solid color-mix(in srgb, var(--vorange) 18%, transparent); }
.v-rail__head { font-family: var(--vmono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--vorange); font-weight: 600; margin: 0 0 14px; display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.v-rail__head .hint { color: var(--vmuted-2); font-weight: 400; font-size: 10.5px; letter-spacing: 0.08em; text-transform: none; }
.v-rail__cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.v-rail-card { display: flex; flex-direction: column; gap: 7px; background: var(--vpanel); border: 1px solid var(--vline); border-radius: 10px; padding: 14px 16px; color: var(--vink); text-decoration: none; transition: border-color .15s, transform .15s, box-shadow .15s; min-width: 0; }
.v-rail-card:hover { border-color: var(--vorange); transform: translateY(-1px); box-shadow: 0 6px 16px rgba(255,90,31,0.10); }
.v-rail-card.hot { border-color: var(--vorange); box-shadow: 0 6px 16px rgba(255,90,31,0.12); }
.v-rail-card.is-project { background: linear-gradient(135deg, var(--vpanel), color-mix(in srgb, var(--vorange) 8%, var(--vpanel))); border-color: color-mix(in srgb, var(--vorange) 30%, var(--vline)); }
.v-rail-card.is-project::before { content: "▦"; position: absolute; top: 8px; right: 10px; font-family: var(--vmono); font-size: 11px; color: var(--vorange); opacity: 0.55; }
.v-rail-card.is-project { position: relative; }
.v-rail-card.is-project .proj { letter-spacing: 0.08em; text-transform: uppercase; font-size: 9.5px; }
.v-rail-card.is-project .ttl { font-size: 17px; font-weight: 500; letter-spacing: -0.01em; color: var(--vorange); }
.v-rail-card .proj { font-family: var(--vmono); font-size: 10.5px; color: var(--vorange); letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v-rail-card .ttl { font-family: var(--vhead); font-size: 14px; font-weight: 500; line-height: 1.32; color: var(--vink); letter-spacing: -0.005em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.v-rail-card .meta { font-family: var(--vmono); font-size: 10px; color: var(--vmuted); margin-top: auto; padding-top: 4px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.v-rail-card .meta .dot { width: 3px; height: 3px; border-radius: 50%; background: var(--vmuted-2); flex-shrink: 0; }
.v-rail-card .iter-flag { background: var(--vorange-soft); border: 1px solid color-mix(in srgb, var(--vorange) 35%, transparent); color: var(--vorange); padding: 1px 6px; border-radius: 4px; font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; }
@media (max-width: 640px) {
  .v-rail__cards { grid-template-columns: 1fr; }
}

.cluster { display: grid; grid-template-columns: 1fr auto; gap: 24px; padding: 18px 18px 18px 22px; background: var(--vbg-2); border: 1px solid var(--vline); border-radius: 12px; margin-bottom: 10px; position: relative; overflow: hidden; transition: border-color .15s, transform .15s; }
.cluster:hover { border-color: var(--vorange); transform: translateY(-1px); }
.cluster::before { content: ""; position: absolute; left: 0; top: 14px; bottom: 14px; width: 3px; background: var(--vorange); border-radius: 0 2px 2px 0; }
.cluster .tid { font-family: var(--vmono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--vbronze); margin-bottom: 6px; }
.cluster h3 { font-family: var(--vhead); font-weight: 500; font-size: 22px; letter-spacing: -0.02em; margin: 0 0 4px; }
.cluster .blurb { color: var(--vmuted); font-size: 13.5px; line-height: 1.5; margin-bottom: 12px; max-width: 60ch; }
.cluster .stack { display: flex; gap: 0; flex-wrap: wrap; }
.cluster .stack .chip { font-family: var(--vmono); font-size: 11px; padding: 4px 10px; border-radius: 999px; background: var(--vpanel); border: 1px solid var(--vline); color: var(--vmuted); margin-right: 6px; margin-bottom: 4px; }
.cluster .stack .chip.final { color: var(--vorange); border-color: var(--vorange-glow); }
.cluster .cluster-meta { font-family: var(--vmono); font-size: 11px; color: var(--vmuted); text-align: right; display: flex; flex-direction: column; gap: 4px; align-items: end; }
.cluster .cluster-meta .big { font-family: var(--vhead); font-weight: 500; font-size: 32px; line-height: 1; color: var(--vink); letter-spacing: -0.02em; }

.tag-cloud { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 4px 8px; }
.tag-cloud .tag-chip { display: inline-flex; align-items: baseline; gap: 8px; font-family: var(--vmono); font-size: 12px; padding: 5px 12px; border-radius: 999px; background: var(--vpanel); border: 1px solid var(--vline); color: var(--vink-2); transition: color .12s, border-color .12s, background .12s, box-shadow .12s; max-width: 100%; overflow-wrap: anywhere; }
.tag-cloud .tag-chip:hover { color: var(--vorange); border-color: var(--vorange); }
.tag-cloud .tag-chip.on { background: var(--vink); border-color: var(--vink); color: var(--vbg); box-shadow: 0 0 0 3px var(--vorange-soft); }
.tag-cloud .tag-chip .ns { color: var(--vbronze); opacity: 0.65; font-weight: 400; }
.tag-cloud .tag-chip .val { font-weight: 600; }
.tag-cloud .tag-chip.on .ns { color: var(--vamber); opacity: 0.9; }
.tag-cloud .tag-chip .count { font-size: 10.5px; color: var(--vmuted); }
.tag-cloud .tag-chip.on .count { color: var(--vbg); opacity: 0.7; }
.tag-cloud .more { font-family: var(--vmono); font-size: 11px; color: var(--vmuted-2); padding: 5px 4px; align-self: center; }

/* Namespace coloring — color-mix gives the chip a soft tint of the accent
   without sacrificing contrast against linen-warm viewer chrome.
   ns-klient → niebieski, ns-projekt → zielony, ns-temat → bursztynowy,
   ns-type → fioletowy, ns-unknown / no namespace → muted neutral. */
/* Intensities tuned for clearly-visible tint on linen-warm chrome:
   ~24% background fill (still light, but distinguishable from #f5f3ee bg),
   ~55% border for a strong outline, ~70% text for AA-safe contrast on top. */
.tag-cloud .tag-chip.ns-klient   { background: color-mix(in srgb, var(--vblue)   22%, var(--vpanel)); border-color: color-mix(in srgb, var(--vblue)   55%, var(--vline));  color: color-mix(in srgb, var(--vblue)   70%, var(--vink)); }
.tag-cloud .tag-chip.ns-projekt  { background: color-mix(in srgb, var(--vgood)   22%, var(--vpanel)); border-color: color-mix(in srgb, var(--vgood)   55%, var(--vline));  color: color-mix(in srgb, var(--vgood)   70%, var(--vink)); }
.tag-cloud .tag-chip.ns-temat    { background: color-mix(in srgb, var(--vamber)  26%, var(--vpanel)); border-color: color-mix(in srgb, var(--vamber)  60%, var(--vline));  color: color-mix(in srgb, var(--vamber)  75%, var(--vink)); }
.tag-cloud .tag-chip.ns-type     { background: color-mix(in srgb, var(--vpurple) 22%, var(--vpanel)); border-color: color-mix(in srgb, var(--vpurple) 55%, var(--vline));  color: color-mix(in srgb, var(--vpurple) 70%, var(--vink)); }
.tag-cloud .tag-chip.ns-klient   .ns { color: color-mix(in srgb, var(--vblue)   65%, var(--vink)); }
.tag-cloud .tag-chip.ns-projekt  .ns { color: color-mix(in srgb, var(--vgood)   65%, var(--vink)); }
.tag-cloud .tag-chip.ns-temat    .ns { color: color-mix(in srgb, var(--vamber)  70%, var(--vink)); }
.tag-cloud .tag-chip.ns-type     .ns { color: color-mix(in srgb, var(--vpurple) 65%, var(--vink)); }
.tag-cloud .tag-chip:hover.ns-klient,
.tag-cloud .tag-chip:hover.ns-projekt,
.tag-cloud .tag-chip:hover.ns-temat,
.tag-cloud .tag-chip:hover.ns-type { color: currentColor; filter: brightness(0.95); border-color: currentColor; }
/* Large header chip variant for /tag/:slug page */
.tag-header { display: inline-flex; align-items: baseline; gap: 12px; font-family: var(--vmono); font-size: 18px; padding: 10px 22px; border-radius: 999px; background: var(--vpanel); border: 1.5px solid var(--vline); color: var(--vink-2); max-width: 100%; overflow-wrap: anywhere; }
.tag-header .ns { color: var(--vbronze); opacity: 0.7; font-weight: 400; }
.tag-header .val { font-weight: 600; letter-spacing: -0.01em; }
.tag-header .count { font-family: var(--vmono); font-size: 12px; color: var(--vmuted); font-weight: 400; letter-spacing: 0.04em; padding-left: 8px; border-left: 1px solid var(--vline); }
.tag-header.ns-klient  { background: color-mix(in srgb, var(--vblue)   22%, var(--vpanel)); border-color: color-mix(in srgb, var(--vblue)   60%, var(--vline)); color: color-mix(in srgb, var(--vblue)   70%, var(--vink)); }
.tag-header.ns-projekt { background: color-mix(in srgb, var(--vgood)   22%, var(--vpanel)); border-color: color-mix(in srgb, var(--vgood)   60%, var(--vline)); color: color-mix(in srgb, var(--vgood)   70%, var(--vink)); }
.tag-header.ns-temat   { background: color-mix(in srgb, var(--vamber)  26%, var(--vpanel)); border-color: color-mix(in srgb, var(--vamber)  65%, var(--vline)); color: color-mix(in srgb, var(--vamber)  75%, var(--vink)); }
.tag-header.ns-type    { background: color-mix(in srgb, var(--vpurple) 22%, var(--vpanel)); border-color: color-mix(in srgb, var(--vpurple) 60%, var(--vline)); color: color-mix(in srgb, var(--vpurple) 70%, var(--vink)); }
.tag-header.ns-klient  .ns { color: color-mix(in srgb, var(--vblue)   65%, var(--vink)); }
.tag-header.ns-projekt .ns { color: color-mix(in srgb, var(--vgood)   65%, var(--vink)); }
.tag-header.ns-temat   .ns { color: color-mix(in srgb, var(--vamber)  70%, var(--vink)); }
.tag-header.ns-type    .ns { color: color-mix(in srgb, var(--vpurple) 65%, var(--vink)); }

/* Active filter strip shown above the date groups when ?tag= and/or ?type= is set */
.active-filter { display: flex; align-items: center; gap: 10px; padding: 10px 4px 14px; margin-bottom: 4px; flex-wrap: wrap; font-family: var(--vmono); font-size: 11.5px; color: var(--vmuted); }
.active-filter .lbl { letter-spacing: 0.14em; text-transform: uppercase; color: var(--vmuted-2); font-size: 10.5px; }
.active-filter .chip { display: inline-flex; align-items: baseline; gap: 8px; padding: 4px 10px 4px 12px; border-radius: 999px; background: var(--vpanel); border: 1px solid var(--vline); color: var(--vink-2); font-size: 12px; }
.active-filter .chip .x { color: var(--vmuted-2); padding-left: 6px; border-left: 1px solid var(--vline-2); margin-left: 4px; transition: color .12s; }
.active-filter .chip:hover .x { color: var(--vorange); }
.active-filter .clear-all { color: var(--vmuted-2); padding: 3px 8px; border-radius: 4px; transition: color .12s, background .12s; }
.active-filter .clear-all:hover { color: var(--vorange); background: var(--vbg-2); }

.thread-card { display: grid; grid-template-columns: 1fr auto auto; gap: 22px; align-items: center; padding: 18px 8px 18px 30px; border-bottom: 1px solid var(--vline-2); position: relative; transition: background .12s; }
.thread-card:hover { background: var(--vbg-2); }
.thread-card::before { content: ""; position: absolute; left: 8px; top: 18px; bottom: 18px; width: 2px; background: var(--vline); border-radius: 1px; }
.thread-card:hover::before { background: var(--vorange); }
.thread-card .tid { font-family: var(--vmono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--vbronze); margin-bottom: 4px; }
.thread-card .title { font-family: var(--vhead); font-weight: 500; font-size: 20px; letter-spacing: -0.015em; margin-bottom: 8px; }
.thread-card .progress { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.thread-card .progress .tick { width: 18px; height: 4px; border-radius: 2px; background: var(--vmuted-2); opacity: 0.5; }
.thread-card .progress .tick.has { background: var(--vmuted); opacity: 1; }
.thread-card .progress .tick.final { background: var(--vorange); opacity: 1; }
.thread-card .progress .more { font-family: var(--vmono); font-size: 10px; color: var(--vmuted); margin-left: 4px; }
.thread-card .count { font-family: var(--vhead); font-weight: 500; font-size: 28px; line-height: 1; letter-spacing: -0.02em; color: var(--vink); }
.thread-card .count small { font-family: var(--vmono); font-size: 10.5px; color: var(--vmuted); display: block; letter-spacing: 0.14em; text-transform: uppercase; margin-top: 4px; font-weight: 400; }
.thread-card .latest { font-family: var(--vmono); font-size: 11.5px; color: var(--vmuted-2); text-align: right; min-width: 90px; }
.thread-card .latest .final-marker { display: inline-block; color: var(--vorange); font-weight: 600; margin-top: 4px; }

/* Note page: lock body to viewport so the topbar-height estimate (60px,
   approximate) can't push the page into a few-px overflow. Side panel +
   iframe wrap each scroll internally so nothing legitimate is hidden. */
body.note-page { overflow: hidden; }
body.list-page { overflow: hidden; }

/* List shell — used by /tag/:slug and /p/:slug (v0.20.1+). Same grid
   shape as .note-shell so the chrome feels consistent across surfaces.
   Left: sticky scrollable nav of items in the list. Right: existing
   page body (header + meta + rows or cards).
   On mobile the sidebar collapses into a top strip. */
.list-shell { display: grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 60px); }
@media (max-width: 720px) { .list-shell { grid-template-columns: 1fr; } }
.list-side { border-right: 1px solid var(--vline); padding: 22px 18px 22px; display: flex; flex-direction: column; gap: 0; background: var(--vbg); position: sticky; top: 60px; align-self: start; max-height: calc(100vh - 60px); overflow-y: auto; overflow-x: hidden; min-width: 0; }
@media (max-width: 720px) { .list-side { position: static; max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--vline); } }
.list-side .back { font-family: var(--vmono); font-size: 11px; color: var(--vmuted); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 14px; }
.list-side .back:hover { color: var(--vorange); }
.list-side h2 { font-family: var(--vhead); font-weight: 500; font-size: 18px; letter-spacing: -0.015em; margin: 0 0 4px; line-height: 1.2; }
.list-side h2 .ns { color: var(--vorange); }
.list-side .list-meta { font-family: var(--vmono); font-size: 10.5px; color: var(--vmuted); margin-bottom: 16px; }
.list-side .list-items { display: flex; flex-direction: column; gap: 0; }
.list-side .list-item { padding: 10px 12px; border-radius: 7px; border: 1px solid transparent; text-decoration: none; color: inherit; display: flex; flex-direction: column; gap: 3px; margin-bottom: 2px; cursor: pointer; transition: background .12s, border-color .12s; }
.list-side .list-item:hover { background: var(--vbg-2); }
.list-side .list-item.active { background: var(--vbg-2); border-color: var(--vline-2); }
.list-side .list-item__title { font-family: var(--vhead); font-size: 13.5px; font-weight: 500; line-height: 1.3; color: var(--vink-2); letter-spacing: -0.005em; }
.list-side .list-item__title.final::before { content: "★ "; color: var(--vorange); }
.list-side .list-item__meta { font-family: var(--vmono); font-size: 10px; color: var(--vmuted); display: flex; gap: 8px; align-items: center; }
.list-side .list-item__type { display: inline-block; background: var(--vorange-soft); color: var(--vorange); font-size: 8.5px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; padding: 1px 6px; border-radius: 7px; }
.list-side .list-item__type.technical { background: rgba(44,74,217,0.10); color: var(--vblue); }
.list-side .list-item__type.comparison { background: rgba(139,101,53,0.12); color: var(--vbronze); }
.list-side .list-item__type.journal { background: rgba(47,144,80,0.10); color: var(--vgood); }
.list-side .list-item__type.snippet { background: var(--vbg-2); color: var(--vmuted); }
.list-side .list-item__type.iteration { background: rgba(255,90,31,0.12); color: var(--vorange); }
.list-side .list-section { font-family: var(--vmono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--vmuted-2); padding: 18px 12px 6px 12px; font-weight: 600; }
.list-side .list-section:first-of-type { padding-top: 0; }
.list-main { padding: 0; min-width: 0; max-height: calc(100vh - 60px); overflow-y: auto; }

.note-shell { display: grid; grid-template-columns: var(--side-w, 360px) 1fr; min-height: calc(100vh - 60px); transition: grid-template-columns 220ms ease; }
.note-shell.has-live { grid-template-columns: var(--side-w, 360px) minmax(0, 1fr) minmax(340px, 26vw); }
@media (max-width: 1180px) { .note-shell.has-live { grid-template-columns: var(--side-w, 360px) 1fr; } .note-shell.has-live .live-panel { grid-column: 1 / -1; max-height: 60vh; } }
/* v0.40.1 — no grid-stack override at narrow widths anymore; the sidebar
   stays in the grid as a collapsible drawer (driven by --side-w). On small
   screens the auto-collapse default (≤1024px in JS) lands users on the
   40px strip — they don't see the sidebar jump full-width. */
.live-panel { background: var(--vbg-2); border-left: 1px solid var(--vline); display: flex; flex-direction: column; height: calc(100vh - 60px); min-width: 0; }
.live-panel-iframe { flex: 1; width: 100%; border: 0; min-height: 0; display: block; background: var(--vpanel); }
.note-side { border-right: 1px solid var(--vline); display: flex; flex-direction: column; gap: 0; background: var(--vbg); position: sticky; top: 60px; align-self: start; max-height: calc(100vh - 60px); overflow-y: auto; overflow-x: hidden; min-width: 0; }
.note-side .back { font-family: var(--vmono); font-size: 11px; color: var(--vmuted); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 22px; transition: color .12s; }
.note-side .back:hover { color: var(--vorange); }
.note-side .type-pill { align-self: flex-start; font-family: var(--vmono); font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 600; padding: 4px 9px; border-radius: 5px; background: var(--vorange-soft); color: var(--vorange); margin-bottom: 14px; }
.note-side .type-pill.technical { background: rgba(44,74,217,0.10); color: var(--vblue); }
.note-side .type-pill.comparison { background: rgba(139,101,53,0.12); color: var(--vbronze); }
.note-side .type-pill.journal { background: rgba(47,144,80,0.10); color: var(--vgood); }
.note-side .type-pill.snippet { background: var(--vbg-2); color: var(--vmuted); }
.note-side h1 { font-family: var(--vhead); font-weight: 500; font-size: 24px; line-height: 1.15; letter-spacing: -0.025em; margin: 0 0 22px; text-wrap: balance; }
/* v0.40 — sidebar collapse toggle. --side-w drives the grid column; collapsed
   shows only the toggle in a 40px strip. transition: grid-template-columns
   works in Chrome/Firefox/Safari for these interpolatable track lists. .no-anim
   suppresses the transition briefly so initial-state load doesn't animate. */
.note-shell.is-side-collapsed { --side-w: 40px; }
.note-shell.no-anim, .note-shell.no-anim * { transition: none !important; }
/* Sidebar content lives in .side-content so collapse SLIDES it off to the
   left (transform: translateX(-100%)) instead of shrinking its width — which
   would cause text to wrap inside the 40px column and surface a scrollbar.
   min-width: 360px keeps the wrapper at its natural width while the column
   narrows; .note-side gets overflow: hidden in the collapsed state to clip
   the off-screen content cleanly. */
.side-content { display: flex; flex-direction: column; gap: 0; min-width: 360px; padding: 24px 22px 22px; box-sizing: border-box; transition: transform 220ms ease, opacity 200ms ease; }
.note-shell.is-side-collapsed .side-content { transform: translateX(-100%); opacity: 0; pointer-events: none; }
.note-shell.is-side-collapsed .note-side { overflow: hidden; }
.side-toggle { position: absolute; top: 16px; right: 14px; width: 26px; height: 26px; padding: 0; border: 1px solid var(--vline); background: var(--vbg); color: var(--vmuted); border-radius: 6px; cursor: pointer; display: grid; place-items: center; font-size: 14px; line-height: 1; transition: background .12s, color .12s, border-color .12s, transform 220ms ease, right 220ms ease; z-index: 2; }
.side-toggle:hover { background: var(--vpanel); color: var(--vink-2); border-color: var(--vmuted); }
.note-shell.is-side-collapsed .side-toggle { transform: rotate(180deg); right: 7px; }

.action-card { display: block; background: var(--vink); color: var(--vbg); border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; position: relative; overflow: hidden; cursor: pointer; border: 0; width: 100%; text-align: left; font-family: inherit; line-height: 1.3; transition: transform .15s, background .15s; }
.action-card > * { display: block; }
.action-card:hover { background: var(--vorange); transform: translateY(-1px); }
.action-card .ac-lbl { font-family: var(--vmono); font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--vmuted-2); margin-bottom: 6px; }
.action-card .ac-title { font-family: var(--vhead); font-weight: 500; font-size: 16px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
.action-card .ac-title .ac-star { color: var(--vorange); font-style: normal; }
.action-card:hover .ac-title .ac-star { color: var(--vbg); }
.action-card .ac-hint { font-family: var(--vmono); font-size: 11px; color: var(--vmuted-2); margin-top: 6px; line-height: 1.45; }

/* v0.29 — pin toggle. Sits just below the action-card. Compact: a single
 * row with the 📌 glyph + label. State is reflected via .on (currently
 * pinned). Click hits POST /api/notes/:id/metadata with {is_pinned}. */
.pin-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 14px; margin-bottom: 18px; border: 1px solid var(--vline); border-radius: 8px; background: var(--vbg); color: var(--vink-2); cursor: pointer; font-family: var(--vmono); font-size: 11.5px; letter-spacing: 0.04em; transition: background .12s, border-color .12s, color .12s; }
.pin-toggle:hover { background: var(--vpanel); border-color: var(--vmuted); }
.pin-toggle .pin-glyph { font-size: 14px; opacity: 0.85; }
.pin-toggle .pin-lbl { flex: 1; }
.pin-toggle .pin-hint { color: var(--vmuted-2); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
.pin-toggle.on { background: var(--vorange-soft, rgba(213,124,38,0.08)); border-color: var(--vorange); color: var(--vorange); }
.pin-toggle.on .pin-glyph { opacity: 1; }
.pin-toggle.on:hover { background: rgba(213,124,38,0.14); }

/* v0.29 — 📌 indicator on hero card eyebrow + row title prefix. Small,
 * tinted, visually parallel to the ★ final pip — same scale, lower
 * weight to keep "final" as the louder signal. */
.eyebrow .pinned { color: var(--vorange); font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; }
.hero.pinned { border-color: var(--vorange); }
.row.pinned .pin-mark { color: var(--vorange); font-size: 11px; margin-right: 2px; }

.side-meta { display: grid; grid-template-columns: auto 1fr; gap: 12px 14px; padding: 4px 0 18px; border-bottom: 1px solid var(--vline); margin-bottom: 18px; }
.side-meta dt { font-family: var(--vmono); font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--vmuted-2); align-self: baseline; }
.side-meta dd { font-family: var(--vmono); font-size: 12px; color: var(--vink-2); margin: 0; align-self: baseline; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.side-meta dd.thread { color: var(--vbronze); }
.side-meta dd.warn { color: var(--vamber); }
.side-meta dd.final { color: var(--vorange); }
.side-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.side-tags .tg { font-family: var(--vmono); font-size: 10.5px; padding: 3px 8px; border-radius: 4px; background: var(--vbg-2); color: var(--vmuted); border: 1px solid var(--vline-2); transition: color .12s, border-color .12s, background .12s; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
.side-tags a.tg:hover { color: var(--vorange); border-color: var(--vorange); background: var(--vpanel); }

/* v0.22.2 — inline metadata editors (replaces the Edit popover).
   Direct-manipulation pattern: click title to rename, × on a tag chip
   to remove, type in the trailing input to add new (with autocomplete).
   Each commit auto-saves via POST /api/notes/:id/metadata. */
.editable-title { cursor: text; padding: 2px 6px; margin-left: -6px; border-radius: 4px; transition: background .12s, box-shadow .12s; }
.editable-title:hover { background: var(--vbg-2); box-shadow: inset 0 0 0 1px var(--vline); }
.editable-title:focus { background: var(--vbg-2); box-shadow: inset 0 0 0 2px var(--vorange); outline: none; }
.editable-title.is-saving { opacity: 0.6; cursor: wait; }

.tag-editor { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; position: relative; }
.tag-editor .tag-chip { display: inline-flex; align-items: center; gap: 4px; font-family: var(--vmono); font-size: 10.5px; padding: 3px 4px 3px 8px; border-radius: 4px; background: var(--vbg-2); color: var(--vmuted); border: 1px solid var(--vline-2); max-width: 100%; }
.tag-editor .tag-chip a.tg { color: inherit; padding: 0; background: transparent; border: 0; }
.tag-editor .tag-chip a.tg:hover { color: var(--vorange); }
.tag-editor .tag-chip button.tag-remove { background: transparent; border: 0; color: var(--vmuted-2); cursor: pointer; font-size: 12px; padding: 0 2px; line-height: 1; transition: color .12s; font-family: inherit; }
.tag-editor .tag-chip button.tag-remove:hover { color: #c8412a; }
.tag-editor .tag-add-wrap { position: relative; }
.tag-editor .tag-add-input { font-family: var(--vmono); font-size: 10.5px; padding: 3px 8px; border: 1px dashed var(--vline); border-radius: 4px; background: transparent; color: inherit; min-width: 88px; max-width: 140px; }
.tag-editor .tag-add-input::placeholder { color: var(--vmuted-2); }
.tag-editor .tag-add-input:focus { outline: none; border-color: var(--vorange); border-style: solid; }
.tag-editor .tag-suggest { position: absolute; top: 100%; left: 0; margin-top: 3px; background: var(--vpanel); border: 1px solid var(--vline); border-radius: 6px; box-shadow: 0 6px 18px rgba(0,0,0,0.12); min-width: 160px; max-width: 240px; max-height: 220px; overflow-y: auto; z-index: 50; padding: 4px; }
.tag-editor .tag-suggest[hidden] { display: none; }
.tag-editor .tag-suggest-item { display: block; width: 100%; text-align: left; padding: 4px 8px; font-family: var(--vmono); font-size: 11px; color: var(--vmuted); background: transparent; border: 0; border-radius: 3px; cursor: pointer; }
.tag-editor .tag-suggest-item:hover, .tag-editor .tag-suggest-item.is-active { background: var(--vbg-2); color: var(--vink-2); }
.tag-editor .tag-suggest-item.is-create { color: var(--vorange); }
.tag-editor .tag-suggest-item .count { color: var(--vmuted-2); margin-left: 6px; }

.theme-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.theme-save { font-family: var(--vmono); font-size: 10.5px; color: var(--vorange); cursor: pointer; padding: 3px 0; }
.theme-save[hidden] { display: none; }
.theme-save:hover { text-decoration: underline; }

.meta-toast { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%) translateY(8px); padding: 8px 14px; background: #0a0a0a; color: #f5f3ee; border-radius: 6px; font-family: var(--vmono); font-size: 11.5px; opacity: 0; transition: opacity .15s, transform .15s; pointer-events: none; z-index: 200; box-shadow: 0 6px 18px rgba(0,0,0,0.25); }
.meta-toast.is-shown { opacity: 1; transform: translateX(-50%) translateY(0); }
.meta-toast.is-error { background: #c8412a; }
.side-aux { margin-top: auto; padding-top: 18px; border-top: 1px solid var(--vline); display: flex; flex-direction: column; gap: 4px; }
.side-aux a, .side-aux button { font-family: var(--vmono); font-size: 11px; color: var(--vmuted); letter-spacing: 0.06em; padding: 4px 0; transition: color .12s; background: transparent; border: 0; text-align: left; cursor: pointer; }
.side-aux a:hover, .side-aux button:hover { color: var(--vorange); }
.side-aux .danger { color: #c8412a; opacity: 0.7; }

.theme-switch { font-family: var(--vmono); font-size: 12px; color: var(--vink-2); background: transparent; border: 1px solid var(--vline); padding: 3px 6px 3px 4px; border-radius: 4px; cursor: pointer; max-width: 140px; }
.theme-switch:hover { border-color: var(--vink); }
.theme-switch:focus { outline: 0; border-color: var(--vorange); box-shadow: 0 0 0 3px var(--vorange-soft); }

.reading-progress { position: fixed; top: 0; left: 0; right: 0; height: 2px; background: transparent; z-index: 30; pointer-events: none; }
.reading-progress-fill { height: 100%; background: var(--vorange); width: 0%; transition: width .05s linear; }

.toc { margin: 0 0 18px; padding: 14px 0 12px; border-top: 1px solid var(--vline); border-bottom: 1px solid var(--vline); }
.toc[hidden] { display: none; }
.toc .toc-lbl { font-family: var(--vmono); font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--vmuted-2); margin-bottom: 10px; font-weight: 500; }
.toc ol { list-style: none; padding: 0; margin: 0; counter-reset: toc; display: flex; flex-direction: column; gap: 3px; }
.toc li { position: relative; counter-increment: toc; padding-left: 22px; }
.toc li::before { content: counter(toc, decimal-leading-zero); position: absolute; left: 0; top: 2px; font-family: var(--vmono); font-size: 9.5px; color: var(--vmuted-2); letter-spacing: 0.04em; }
.toc li.h3 { padding-left: 34px; }
.toc li.h3::before { left: 14px; opacity: 0.6; }
.toc a { display: block; color: var(--vmuted); font-size: 12.5px; line-height: 1.35; padding: 2px 0; transition: color .12s; cursor: pointer; }
.toc a:hover { color: var(--vink); }
.toc li.active a { color: var(--vorange); font-weight: 500; }

.prev-next { display: flex; gap: 6px; margin-bottom: 20px; }
.pn-btn { flex: 1; padding: 8px 10px; border: 1px solid var(--vline); border-radius: 7px; font-family: var(--vmono); font-size: 11px; color: var(--vmuted); text-align: center; transition: color .12s, border-color .12s; min-width: 0; }
.pn-btn:hover { border-color: var(--vorange); color: var(--vorange); }
.pn-btn.disabled { opacity: 0.3; pointer-events: none; }
.pn-btn .pn-label { display: block; font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--vmuted-2); margin-bottom: 2px; }

.revisions { margin-bottom: 20px; }
.rev-lbl { font-family: var(--vmono); font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--vmuted-2); margin-bottom: 7px; }
.rev-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.rev-chip { padding: 4px 9px; border: 1px solid var(--vline); border-radius: 6px; font-family: var(--vmono); font-size: 11px; color: var(--vmuted); transition: color .12s, border-color .12s, background .12s; }
.rev-chip:hover { border-color: var(--vorange); color: var(--vorange); }
.rev-chip.cur { border-color: var(--vorange); color: var(--vorange); background: var(--vorange-soft); }
.rev-chip.head { font-weight: 600; }

.side-action { font-family: var(--vmono); font-size: 11px; color: var(--vmuted); letter-spacing: 0.06em; padding: 4px 0; transition: color .12s; background: transparent; border: 0; text-align: left; cursor: pointer; width: 100%; display: block; }
.side-action:hover { color: var(--vorange); }
.side-action.copied { color: var(--vgood); }
.side-action.danger { color: var(--vmuted); margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--vline-2); }
.side-action.danger:hover { color: #c0392b; }
.side-action.danger.confirming { color: #c0392b; font-weight: 500; }

.lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 9999; display: flex; align-items: center; justify-content: center; cursor: zoom-out; animation: lb-in .15s ease-out; }
.lightbox img { max-width: 95vw; max-height: 95vh; box-shadow: 0 8px 32px rgba(0,0,0,0.6); border-radius: 4px; }
.lightbox .lb-close { position: absolute; top: 18px; right: 22px; font-family: var(--vmono); font-size: 11px; color: rgba(255,255,255,0.7); letter-spacing: 0.14em; text-transform: uppercase; cursor: pointer; }
@keyframes lb-in { from { opacity: 0; } to { opacity: 1; } }

.note-main { background: var(--vpanel); min-width: 0; display: flex; flex-direction: column; height: calc(100vh - 60px); }
.note-banner { padding: 12px 24px; background: linear-gradient(90deg, rgba(201,142,45,0.08), transparent 60%); border-bottom: 1px solid var(--vline-2); display: flex; align-items: center; justify-content: space-between; font-family: var(--vmono); font-size: 11.5px; color: var(--vink-2); gap: 14px; flex-wrap: wrap; flex-shrink: 0; }
.note-banner .lbl { color: var(--vamber); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; font-size: 10.5px; }
.note-banner .finalize-btn { font-family: var(--vhead); font-weight: 500; font-size: 13px; letter-spacing: -0.005em; padding: 6px 14px; border-radius: 7px; background: var(--vink); color: var(--vbg); border: 0; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.note-banner .finalize-btn:hover { background: var(--vorange); }
.note-banner.supersede-banner { background: linear-gradient(90deg, rgba(44,74,217,0.08), transparent 60%); }
.note-banner.supersede-banner .lbl { color: #2c4ad9; }
.note-banner.supersede-banner a { color: var(--vorange); text-decoration: none; font-weight: 600; }
.note-banner.supersede-banner a:hover { text-decoration: underline; }
.note-iframe-wrap { background: var(--vpanel); flex: 1; min-height: 0; }
.note-iframe { width: 100%; height: 100%; border: 0; display: block; }

.empty { text-align: center; padding: 80px 20px; color: var(--vmuted); max-width: 480px; margin: 0 auto; }
.empty h2 { font-family: var(--vhead); font-weight: 500; font-size: 36px; letter-spacing: -0.025em; color: var(--vink); margin: 0 0 12px; }
.empty .lead { font-family: var(--vserif); font-style: italic; font-size: 19px; color: var(--vmuted); }
.empty code { font-family: var(--vmono); font-size: 12px; background: var(--vbg-2); padding: 3px 8px; border-radius: 5px; color: var(--vink-2); }

.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin: 24px 0 32px; }
.stat-cell { padding: 18px 20px; background: var(--vpanel); border: 1px solid var(--vline); border-radius: 10px; }
.stat-cell .n { font-family: var(--vhead); font-weight: 500; font-size: 36px; letter-spacing: -0.025em; line-height: 1; color: var(--vink); }
.stat-cell .n.acc { color: var(--vorange); }
.stat-cell .n.good { color: var(--vgood); }
.stat-cell .n.mid { color: var(--vamber); }
.stat-cell .lbl { font-family: var(--vmono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--vmuted); margin-top: 8px; font-weight: 500; }

@media (max-width: 860px) {
  :root { --gutter: 18px; }
  .v-logo .div, .v-logo .tagline { display: none; }
  .v-search { max-width: none; }
  .v-top-inner { flex-wrap: wrap; gap: 12px; }
  .v-nav { width: 100%; order: 3; }
  .v-strip-inner { overflow-x: auto; flex-wrap: nowrap; padding-right: 24px; }
  .v-strip-inner .fp { flex: 0 0 auto; }
  .v-strip .results-meta { display: none; }
  .hero { grid-template-columns: 1fr; }
  .hero-arrow { display: none; }
  .hero h1 { font-size: 32px; max-width: none; }
  .hero .lead { font-size: 16px; }
  .row { grid-template-columns: 64px minmax(0,1fr) auto; gap: 12px; }
  .row .age { display: none; }
  .row .title { font-size: 16px; white-space: normal; }
  .cluster { grid-template-columns: 1fr; }
  .cluster .cluster-meta { flex-direction: row; align-items: center; justify-content: flex-start; text-align: left; }
  .cluster .cluster-meta .big { font-size: 22px; }
  .thread-card { grid-template-columns: 1fr auto; gap: 12px 18px; }
  .thread-card .latest { grid-column: 2; }
  .thread-card .progress { grid-column: 1 / -1; margin-top: 4px; }
  /* v0.40.1 — note-shell stays as drawer at all widths; no grid stack here. */
  .note-side h1 { font-size: 22px; }
  .action-card { margin-bottom: 14px; }
}

/* Live search dropdown — attached to .v-search by JS */
.v-search { position: relative; }
.v-search-results {
  position: absolute; top: calc(100% + 6px); left: 0; right: 0;
  background: var(--vpanel); border: 1px solid var(--vline); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(10,10,10,0.12);
  z-index: 50; max-height: 60vh; overflow-y: auto;
  display: none;
}
.v-search-results.open { display: block; }
.v-search-results .group-lbl { font-family: var(--vmono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--vmuted-2); padding: 10px 14px 6px; border-bottom: 1px solid var(--vline-2); display: flex; align-items: center; gap: 8px; }
.v-search-results .group-lbl .accent { color: var(--vorange); }
.v-search-results a.hit { display: block; padding: 9px 14px; border-bottom: 1px solid var(--vline-2); color: var(--vink); cursor: pointer; }
.v-search-results a.hit:last-of-type { border-bottom: 0; }
.v-search-results a.hit:hover, .v-search-results a.hit.kb { background: var(--vbg-2); }
.v-search-results .hit .t { font-family: var(--vhead); font-weight: 500; font-size: 14px; line-height: 1.3; letter-spacing: -0.01em; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v-search-results .hit .sub { font-family: var(--vmono); font-size: 10.5px; color: var(--vmuted); display: flex; gap: 8px; align-items: center; }
.v-search-results .hit .sub .type.research { color: var(--vorange); }
.v-search-results .hit .sub .type.comparison { color: var(--vbronze); }
.v-search-results .hit .sub .type.technical { color: var(--vblue); }
.v-search-results .hit .sub .type.journal { color: var(--vgood); }
.v-search-results .hit .sub .final { color: var(--vorange); font-weight: 600; }
.v-search-results .hit .snip { font-family: var(--vserif); font-style: italic; font-size: 12px; color: var(--vmuted); margin-top: 3px; line-height: 1.45; max-height: 2.9em; overflow: hidden; }
.v-search-results .hit .snip mark { background: var(--vorange-soft); color: var(--vink); padding: 0 2px; font-style: normal; font-weight: 500; font-family: var(--vbody); }
.v-search-results .footer { padding: 8px 14px; font-family: var(--vmono); font-size: 11px; color: var(--vmuted-2); border-top: 1px solid var(--vline-2); display: flex; justify-content: space-between; align-items: center; }
.v-search-results .footer a { color: var(--vorange); }
.v-search-results .empty { padding: 24px 14px; font-family: var(--vserif); font-style: italic; color: var(--vmuted); font-size: 14px; text-align: center; }
`;

const KBD_SHORTCUT_JS = `<script>
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement && (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA')) {
    e.preventDefault();
    document.querySelector('.v-search input')?.focus();
  }
  if (e.key === 'Escape' && document.activeElement && document.activeElement.tagName === 'INPUT') {
    document.activeElement.blur();
  }
});

// Live search — debounced /api/search dropdown attached to .v-search.
// Hits Enter / form submit still falls through to /search?q=... so the
// no-JS / full-results path keeps working.
(function(){
  var form = document.querySelector('.v-search');
  if (!form) return;
  var input = form.querySelector('input');
  if (!input) return;
  var results = document.createElement('div');
  results.className = 'v-search-results';
  form.appendChild(results);

  var debounceTimer = 0;
  var lastQuery = '';
  var activeReq = 0;
  var kbIdx = -1;

  function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function close(){ results.classList.remove('open'); results.innerHTML = ''; kbIdx = -1; }
  function open(){ results.classList.add('open'); }

  function render(query, hits){
    if (!Array.isArray(hits) || hits.length === 0) {
      results.innerHTML = '<div class="empty">No matches for <em>' + escapeHtml(query) + '</em></div>';
      open();
      return;
    }
    var shown = hits.slice(0, 8);
    var pieces = ['<div class="group-lbl">Notes <span class="accent">· ' + hits.length + ' ' + (hits.length === 1 ? 'hit' : 'hits') + '</span></div>'];
    shown.forEach(function(h){
      var sub = '<div class="sub"><span class="type ' + escapeHtml(h.type) + '">' + escapeHtml(h.type) + '</span> · <span>' + escapeHtml(h.thread_id) + '</span>' + (h.is_final ? ' · <span class="final">★ final</span>' : '') + '</div>';
      var snip = h.snippet ? '<div class="snip">' + h.snippet + '</div>' : '';
      pieces.push('<a class="hit" href="/n/' + escapeHtml(h.id) + '"><div class="t">' + escapeHtml(h.title) + '</div>' + sub + snip + '</a>');
    });
    var moreNote = hits.length > shown.length ? '+' + (hits.length - shown.length) + ' more' : '&nbsp;';
    pieces.push('<div class="footer"><span>' + moreNote + '</span><a href="/search?q=' + encodeURIComponent(query) + '">Open full results →</a></div>');
    results.innerHTML = pieces.join('');
    kbIdx = -1;
    open();
  }

  function doSearch(q){
    var myReq = ++activeReq;
    fetch('/api/search?q=' + encodeURIComponent(q))
      .then(function(r){ return r.json(); })
      .then(function(json){
        if (myReq !== activeReq) return; // stale response
        render(q, json);
      })
      .catch(function(){
        if (myReq !== activeReq) return;
        results.innerHTML = '<div class="empty">Search failed</div>';
        open();
      });
  }

  input.addEventListener('input', function(){
    var q = input.value.trim();
    if (q === lastQuery) return;
    lastQuery = q;
    clearTimeout(debounceTimer);
    if (!q) { close(); return; }
    debounceTimer = setTimeout(function(){ doSearch(q); }, 150);
  });

  input.addEventListener('focus', function(){
    if (input.value.trim() && results.children.length > 0) open();
  });

  document.addEventListener('mousedown', function(e){
    if (!form.contains(e.target)) close();
  });

  input.addEventListener('keydown', function(e){
    var items = results.querySelectorAll('a.hit');
    if (e.key === 'ArrowDown') {
      if (items.length === 0) return;
      e.preventDefault();
      kbIdx = Math.min(items.length - 1, kbIdx + 1);
      items.forEach(function(el, i){ el.classList.toggle('kb', i === kbIdx); });
      items[kbIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      if (items.length === 0) return;
      e.preventDefault();
      kbIdx = Math.max(0, kbIdx - 1);
      items.forEach(function(el, i){ el.classList.toggle('kb', i === kbIdx); });
      items[kbIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && kbIdx >= 0 && items[kbIdx]) {
      e.preventDefault();
      window.location.href = items[kbIdx].getAttribute('href');
    } else if (e.key === 'Escape') {
      close();
    }
  });
})();
</script>`;

function topbar(query = "", active?: "notes" | "threads" | "stats" | "cloud", _shareForId?: string): string {
  const on = (k: string) => (active === k ? ' class="on"' : "");
  // shareForId param kept for backwards-compat callers but no longer wired —
  // v0.21.1 moved the Share trigger into .side-aux (sidebar) where the rest
  // of the per-note actions live. The popover content itself is unchanged.
  void _shareForId;
  return `
<header class="v-top">
  <div class="v-top-inner">
    <a href="/" class="v-logo" aria-label="Folio home">
      <span class="mark">folio<span class="dot">.</span></span>
      <span class="div"></span>
      <span class="tagline">Visual comm for agents</span>
    </a>
    <form class="v-search" role="search" action="/search" method="get">
      <span class="ico">⌕</span>
      <input type="search" name="q" placeholder="Search notes and threads…" value="${esc(query)}" autocomplete="off">
      <kbd>/</kbd>
    </form>
    <nav class="v-nav">
      <a href="/"${on("notes")}>Notes</a>
      <a href="/threads"${on("threads")}>Threads</a>
      <a href="/stats"${on("stats")}>Stats</a>
      <a href="/cloud"${on("cloud")} title="Cloud pairing + push/pull">Sync</a>
    </nav>
  </div>
</header>`;
}

interface CountSummary {
  all: number;
  final: number;
  expiring: number;
  pinned: number;
  byType: Record<string, number>;
}

function buildHref(params: Record<string, string | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") usp.set(k, v);
  }
  const qs = usp.toString();
  return qs ? `/?${qs}` : "/";
}

function filterBar(activeType?: string, activeStatus?: string, counts?: CountSummary, resultsMeta?: string, activeTag?: string): string {
  const cs = counts ?? { all: 0, final: 0, expiring: 0, pinned: 0, byType: {} };
  const on = (cond: boolean) => (cond ? " on" : "");
  // Type/status chips preserve the active tag so combined filter works
  const withTag = (extra: Record<string, string>) => buildHref({ tag: activeTag ?? null, ...extra });
  // v0.29: 📌 Pinned chip lives next to Final/Expiring. Only show when at
  // least one pinned exists — empty filter is dead UI noise on fresh installs.
  const pinnedChip = cs.pinned > 0
    ? `<a href="${withTag({ pinned: "1" })}" class="fp${on(activeStatus === "pinned")}"><span class="pin-glyph">📌</span> Pinned <span class="count">${cs.pinned}</span></a>`
    : "";
  return `
<div class="v-strip">
  <div class="v-strip-inner">
    <a href="${withTag({})}" class="fp${on(!activeType && !activeStatus)}">All <span class="count">${cs.all}</span></a>
    <a href="${withTag({ type: "research" })}" class="fp${on(activeType === "research")}">Research <span class="count">${cs.byType.research ?? 0}</span></a>
    <a href="${withTag({ type: "comparison" })}" class="fp${on(activeType === "comparison")}">Comparison <span class="count">${cs.byType.comparison ?? 0}</span></a>
    <a href="${withTag({ type: "technical" })}" class="fp${on(activeType === "technical")}">Technical <span class="count">${cs.byType.technical ?? 0}</span></a>
    ${cs.byType.journal ? `<a href="${withTag({ type: "journal" })}" class="fp${on(activeType === "journal")}">Journal <span class="count">${cs.byType.journal}</span></a>` : ""}
    ${cs.byType.recipe ? `<a href="${withTag({ type: "recipe" })}" class="fp${on(activeType === "recipe")}">Recipe <span class="count">${cs.byType.recipe}</span></a>` : ""}
    <span class="sep"></span>
    ${pinnedChip}
    <a href="${withTag({ final: "1" })}" class="fp${on(activeStatus === "final")}"><span class="star">★</span> Final <span class="count">${cs.final}</span></a>
    <a href="${withTag({ expiring: "1" })}" class="fp warn${on(activeStatus === "expiring")}">⏱ Expiring 7d <span class="count">${cs.expiring}</span></a>
    ${resultsMeta ? `<span class="results-meta">${esc(resultsMeta)}</span>` : ""}
  </div>
</div>`;
}

/**
 * v0.28 — popular tags promoted from below the notes list to a header
 * strip just under the filter bar. Sort order: namespaced tags first
 * (those carrying `:`, e.g. `project:`, `slot:`, `kind:` — they lead to
 * organized data), then non-namespaced alphabetically.
 *
 * Within the namespaced bucket, also sort alphabetically. The whole row
 * is horizontally scrollable on narrow viewports.
 */
function tagBar(popularTags: { tag: string; count: number }[], activeTag?: string): string {
  if (popularTags.length === 0) return "";
  const sorted = [...popularTags].sort((a, b) => {
    const aNs = a.tag.includes(":");
    const bNs = b.tag.includes(":");
    if (aNs !== bNs) return aNs ? -1 : 1;  // namespaced first
    return a.tag.localeCompare(b.tag);     // then alpha
  });
  const chips = sorted.map((t) => tagChip(t, t.tag === activeTag)).join("");
  return `
<div class="v-tagbar">
  <div class="v-tagbar-inner">
    <span class="v-tagbar-lbl">tags</span>
    ${chips}
  </div>
</div>`;
}

function activeFilterStrip(activeTag?: string, activeType?: string, activeStatus?: string): string {
  if (!activeTag && !activeType && !activeStatus) return "";
  const chips: string[] = [];
  const statusToParam = (s: string | undefined): { final?: string; expiring?: string; pinned?: string } => {
    if (s === "final") return { final: "1" };
    if (s === "expiring") return { expiring: "1" };
    if (s === "pinned") return { pinned: "1" };
    return {};
  };
  if (activeTag) {
    const { ns, value, nsClass } = parseTagNs(activeTag);
    const label = ns !== null
      ? `<span class="ns" style="color:var(--vmuted-2)">${esc(ns)}:</span>${esc(value)}`
      : esc(activeTag);
    // Remove tag, keep other filters
    const href = buildHref({ type: activeType, ...statusToParam(activeStatus) });
    chips.push(`<a href="${href}" class="chip${nsClass ? " " + nsClass : ""}" title="Clear tag filter">🏷 ${label}<span class="x">×</span></a>`);
  }
  if (activeType) {
    const href = buildHref({ tag: activeTag, ...statusToParam(activeStatus) });
    chips.push(`<a href="${href}" class="chip" title="Clear type filter">type: ${esc(activeType)}<span class="x">×</span></a>`);
  }
  if (activeStatus) {
    const href = buildHref({ tag: activeTag, type: activeType });
    const statusLabel = activeStatus === "final" ? "★ final"
                      : activeStatus === "expiring" ? "⏱ expiring 7d"
                      : "📌 pinned";
    chips.push(`<a href="${href}" class="chip" title="Clear status filter">${statusLabel}<span class="x">×</span></a>`);
  }
  return `
<div class="v-page" style="padding-top: 12px; padding-bottom: 0;">
  <div class="active-filter">
    <span class="lbl">active filter</span>
    ${chips.join("")}
    <a href="/" class="clear-all">clear all</a>
  </div>
</div>`;
}

function heroCard(n: NoteMeta): string {
  const eyebrowParts: string[] = [];
  eyebrowParts.push(n.type[0].toUpperCase() + n.type.slice(1));
  eyebrowParts.push(ago(n.created));
  const finalChip = n.is_final ? `<span class="pip"></span><span class="final">★ FINAL</span>` : "";
  // v0.29: 📌 sits in the eyebrow next to the type — same row as the date,
  // signals "pinned" without competing with the title.
  const pinnedChip = n.is_pinned ? `<span class="pip"></span><span class="pinned">📌 pinned</span>` : "";
  const lead = n.summary && n.summary.length > 10 ? esc(n.summary) : "";
  return `
<a class="hero${n.is_pinned ? " pinned" : ""}" href="/n/${n.id}">
  <div>
    <div class="eyebrow"><span class="dot"></span><span>${eyebrowParts.join(" · ")}</span>${pinnedChip}</div>
    <h1>${esc(n.title)}</h1>
    ${lead ? `<p class="lead">${lead}</p>` : ""}
    <div class="meta">
      <span class="thread">📂 ${esc(n.thread_id)}</span>
      <span class="pip"></span>
      <span>${n.word_count} words</span>
      <span class="pip"></span>
      <span>theme: ${esc(n.theme)}</span>
      ${finalChip}
    </div>
  </div>
  <div class="hero-arrow">→</div>
</a>`;
}

function noteRow(n: NoteMeta): string {
  const expiring = !n.is_final ? daysUntil(n.expires_at) : null;
  let stat = `<span class="stat">·</span>`;
  if (n.is_final) stat = `<span class="stat final">★ final</span>`;
  else if (expiring && /^\d+d$/.test(expiring)) {
    const d = parseInt(expiring);
    if (d <= 7) stat = `<span class="stat warn">⏱ ${expiring}</span>`;
  }
  const subParts: string[] = [];
  subParts.push(`<span class="thread">📂 ${esc(n.thread_id)}</span>`);
  if (n.theme) subParts.push(`${esc(n.theme)} theme`);
  if (n.word_count > 0) subParts.push(`${n.word_count} words`);
  // v0.29: 📌 prefix on the title row signals pinned. Subtle — same glyph
  // as the filter chip, so the visual link is obvious without shouting.
  const pinPrefix = n.is_pinned ? `<span class="pin-mark" title="Pinned to top">📌</span> ` : "";
  return `
<a class="row${n.is_pinned ? " pinned" : ""}" href="/n/${n.id}">
  <span class="type ${n.type}">${n.type}</span>
  <div>
    <span class="title">${pinPrefix}${esc(n.title)}</span>
    <span class="title-sub">${subParts.join("  ·  ")}</span>
  </div>
  <span class="age">${ago(n.created)}</span>
  ${stat}
</a>`;
}

function searchRow(h: SearchHit): string {
  const subParts: string[] = [];
  subParts.push(`<span class="thread">📂 ${esc(h.thread_id)}</span>`);
  subParts.push(ago(h.created));
  const stat = h.is_final ? `<span class="stat final">★</span>` : `<span class="stat">·</span>`;
  // snippet already contains <mark> from FTS5
  return `
<a class="row with-snippet" href="/n/${h.id}">
  <span class="type ${h.type}">${h.type}</span>
  <div>
    <span class="title">${esc(h.title)}</span>
    <p class="snippet">${h.snippet}</p>
    <span class="title-sub">${subParts.join("  ·  ")}</span>
  </div>
  <span class="age">★ ${(-h.score).toFixed(1)}</span>
  ${stat}
</a>`;
}

export interface ThreadHit {
  thread_id: string;
  count: number;
  latest: string;
  final_count: number;
}

function clusterCard(t: ThreadHit, exampleTitle?: string, blurb?: string): string {
  // Fetch up to 5 sibling notes for the chip stack
  const siblings = db()
    .query<{ slug: string; is_final: number; word_count: number; created: string }, [string]>(
      `SELECT slug, is_final, word_count, created FROM notes WHERE thread_id = ? AND status = 'active' ORDER BY created DESC LIMIT 5`
    )
    .all(t.thread_id);
  const chips = siblings
    .map((s, i) => {
      const v = `v${t.count - i}`;
      const cls = s.is_final ? "chip final" : "chip";
      const star = s.is_final ? "★ " : "";
      return `<span class="${cls}">${star}${v} · ${s.word_count}w</span>`;
    })
    .join("");
  const extraN = Math.max(0, t.count - siblings.length);
  const extraChip = extraN > 0 ? `<span class="chip">+${extraN} earlier</span>` : "";
  const big = t.count;
  const metaTail = t.final_count > 0 ? `★ final · ${ago(t.latest)}` : ago(t.latest);
  const title = exampleTitle ?? siblings[0]?.slug.replace(/-/g, " ") ?? t.thread_id;
  const blurbHtml = blurb ?? `Thread of <strong>${t.count}</strong> ${t.count === 1 ? "note" : "notes"}${t.final_count > 0 ? `, ${t.final_count} marked <em>final</em>` : ""}. Last updated ${ago(t.latest)}.`;
  return `
<a class="cluster" href="/t/${esc(t.thread_id)}">
  <div>
    <div class="tid">📂 ${esc(t.thread_id)}</div>
    <h3>${esc(title)}</h3>
    <p class="blurb">${blurbHtml}</p>
    <div class="stack">${chips}${extraChip}</div>
  </div>
  <div class="cluster-meta">
    <span class="big">${big}</span>
    <span>${t.count === 1 ? "note" : "notes"}</span>
    <span>${metaTail}</span>
  </div>
</a>`;
}

function threadCard(t: ThreadHit): string {
  // Compute progress ticks from real per-note final flags
  const notes = db()
    .query<{ is_final: number }, [string]>(
      `SELECT is_final FROM notes WHERE thread_id = ? AND status = 'active' ORDER BY created ASC`
    )
    .all(t.thread_id);
  const MAX = 8;
  let ticks: string;
  if (notes.length <= MAX) {
    ticks = notes.map((n) => `<span class="tick ${n.is_final ? "final" : "has"}"></span>`).join("");
  } else {
    const shown = notes.slice(0, MAX - 1);
    ticks =
      shown.map((n) => `<span class="tick ${n.is_final ? "final" : "has"}"></span>`).join("") +
      `<span class="more">${notes.length - shown.length} more${t.final_count > 0 ? "" : ", no final"}</span>`;
  }
  // Build title — derive from first note's title to make threads scannable
  const title = db()
    .query<{ title: string }, [string]>(
      `SELECT title FROM notes WHERE thread_id = ? AND status = 'active' ORDER BY is_final DESC, created DESC LIMIT 1`
    )
    .get(t.thread_id)?.title ?? t.thread_id.replace(/-/g, " ");
  const latestFinal = t.final_count > 0 ? `<span class="final-marker">★ ${t.final_count} final</span>` : "";
  return `
<a class="thread-card" href="/t/${esc(t.thread_id)}">
  <div>
    <div class="tid">📂 ${esc(t.thread_id)}</div>
    <div class="title">${esc(title)}</div>
    <div class="progress">${ticks}</div>
  </div>
  <div class="count">${t.count}<small>${t.count === 1 ? "nota" : "not"}</small></div>
  <div class="latest">${ago(t.latest)}${latestFinal ? "<br>" + latestFinal : ""}</div>
</a>`;
}

const KNOWN_NAMESPACES = new Set(["klient", "projekt", "temat", "type"]);

/** Parse `klient:foo` → { ns: "klient", value: "foo", nsClass: "ns-klient" }.
 *  Unknown namespaces and bare tags get `nsClass: ""` so they keep the
 *  neutral muted styling (no jarring color for arbitrary prefixes). */
function parseTagNs(tag: string): { ns: string | null; value: string; nsClass: string } {
  const i = tag.indexOf(":");
  if (i <= 0 || i === tag.length - 1) return { ns: null, value: tag, nsClass: "" };
  const ns = tag.slice(0, i);
  const value = tag.slice(i + 1);
  const nsClass = KNOWN_NAMESPACES.has(ns) ? `ns-${ns}` : "";
  return { ns, value, nsClass };
}

function tagChip(t: { tag: string; count: number }, active = false): string {
  const { ns, value, nsClass } = parseTagNs(t.tag);
  const label = ns !== null
    ? `<span class="ns">${esc(ns)}:</span><span class="val">${esc(value)}</span>`
    : `<span class="val">${esc(value)}</span>`;
  const classes = ["tag-chip"];
  if (nsClass) classes.push(nsClass);
  if (active) classes.push("on");
  return `<a class="${classes.join(" ")}" href="/tag/${encodeURIComponent(t.tag)}">${label}<span class="count">${t.count}</span></a>`;
}

function tagCloud(tags: { tag: string; count: number }[], activeTag?: string): string {
  if (tags.length === 0) return "";
  return `<div class="tag-cloud">${tags.map((t) => tagChip(t, t.tag === activeTag)).join("")}</div>`;
}

/**
 * v0.23 — Continue-rail renderer. The rail is purely presentation; scoring
 * + per-thread enrichment lives in `listContinueRail()`. Click target:
 *   - pending iteration round → /n/<iteration-id> (decision is one tap away)
 *   - else project tag present → /p/<slug> (the project workspace view)
 *   - else → /n/<latest-note-id> (jump back into the document itself)
 *
 * First card always carries `.hot` so it visually leads. We don't badge
 * "newest" or rank cards individually — score already does that ordering;
 * the user reads top-to-left as "what I'm most likely to want next".
 */
function renderContinueRail(items: ContinueRailItem[]): string {
  if (items.length === 0) return "";
  const ago = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    return `${Math.round(days / 7)}w ago`;
  };
  const cards = items.map((it, i) => {
    const isProject = it.kind === "project";
    // Click target: project tiles always go to /p/<slug>; thread tiles
    // route to pending iteration if any, else /n/<latest>.
    const href = isProject
      ? `/p/${encodeURIComponent(it.project_slug!)}`
      : it.has_pending_iteration && it.pending_iteration_id
        ? `/n/${it.pending_iteration_id}`
        : `/n/${it.latest_note_id}`;
    // Top label (small, monospaced, orange):
    //   - project tile: "project · N threads" (with member count badge)
    //   - thread w/ project tag: "project:<slug>"
    //   - thread w/o tag: thread_id
    const projLabel = isProject
      ? `project · ${it.member_thread_count} ${it.member_thread_count === 1 ? "thread" : "threads"}`
      : it.project_slug ? `project:${it.project_slug}` : it.thread_id;
    // Title:
    //   - project: just the slug (large, primary)
    //   - thread: head note title
    const title = isProject ? it.project_slug! : it.title;
    const meta = it.has_pending_iteration
      ? `<span class="iter-flag">iteration · pending pick</span>`
      : `<span>${ago(it.last_touch)}</span><span class="dot"></span><span>${it.touch_count} ${it.touch_count === 1 ? "touch" : "touches"}</span><span class="dot"></span><span>★ ${(Math.round(it.score * 10) / 10).toFixed(1)}</span>`;
    const cls = (i === 0 ? " hot" : "")
      + (it.has_pending_iteration ? " iter" : "")
      + (isProject ? " is-project" : "");
    return `<a href="${href}" class="v-rail-card${cls}">
      <div class="proj">${esc(projLabel)}</div>
      <div class="ttl">${esc(title)}</div>
      <div class="meta">${meta}</div>
    </a>`;
  }).join("");
  return `<section class="v-rail">
    <header class="v-rail__head">
      <span>↻ Continue where you left off</span>
      <span class="hint">last 7 days · scored by recency × frequency</span>
    </header>
    <div class="v-rail__cards">${cards}</div>
  </section>`;
}

export function pageList(
  notes: NoteMeta[],
  counts: CountSummary,
  activeType?: string,
  activeStatus?: string,
  popularTags: { tag: string; count: number }[] = [],
  activeTag?: string,
  continueRail: ContinueRailItem[] = [],
): string {
  // v0.29.3 — pinned notes get their own section on top, ABOVE the date
  // groups. Date-grouping only the unpinned notes fixes the bug where a
  // pinned older note (which `listNotes` floats to the front of the array)
  // seeded its date group — e.g. "Yesterday" — into the Map first, so it
  // rendered before "Today". Pinned are excluded from their date group to
  // avoid duplication.
  const pinnedNotes = notes.filter((n) => n.is_pinned);
  const restNotes = notes.filter((n) => !n.is_pinned);

  const groups = new Map<string, NoteMeta[]>();
  for (const n of restNotes) {
    const g = dateGroup(n.created);
    const arr = groups.get(g) ?? [];
    arr.push(n);
    groups.set(g, arr);
  }
  // Sort groups strictly newest-first by the freshest note in each, rather
  // than trusting Map insertion order (which any future change to the
  // listNotes sort could perturb again).
  const orderedGroups = Array.from(groups.entries())
    .sort((a, b) => b[1][0]!.created.localeCompare(a[1][0]!.created));

  const pinnedHtml = pinnedNotes.length > 0
    ? `<div class="group"><div class="group-lbl"><span class="pin-glyph">📌</span> Pinned <span class="count">· ${pinnedNotes.length}</span></div><div class="rows">${pinnedNotes.map(noteRow).join("")}</div></div>`
    : "";

  const dateGroupsHtml = orderedGroups
    .map(([label, items], idx) => {
      const accent = idx === 0 && label === "Today" ? `<span class="spacer"></span><span class="accent">fresh</span>` : "";
      const lbl = `<div class="group-lbl">${label} <span class="count">· ${items.length}</span>${accent}</div>`;
      // For "Today" group, first note gets hero treatment
      if (idx === 0 && label === "Today" && items.length > 0) {
        const [hero, ...rest] = items;
        return `<div class="group">${lbl}${heroCard(hero!)}${rest.length > 0 ? `<div class="rows">${rest.map(noteRow).join("")}</div>` : ""}</div>`;
      }
      return `<div class="group">${lbl}<div class="rows">${items.map(noteRow).join("")}</div></div>`;
    })
    .join("");

  const groupsHtml = pinnedHtml + dateGroupsHtml;

  // v0.28 — popular tags moved up into the header tag bar (see tagBar()
  // injection below). Bottom-of-list tag cloud removed to avoid duplication.
  const tagsSection = "";

  const emptyMsg = activeTag
    ? `No notes tagged <code>${esc(activeTag)}</code>${activeType ? ` of type <code>${esc(activeType)}</code>` : ""}.`
    : activeType
    ? `No notes of type <code>${esc(activeType)}</code>.`
    : `Create your first note: <code>folio new --title "..." --html @file.html</code>`;
  // v0.23 — continue-rail injected at the top of the page body, but only
  // on the bare home view. Filter-narrowed views (by type/status/tag)
  // already have an intent — surfacing "what you worked on lately" on
  // top of "show me only research notes" would be noise.
  const railHtml = !activeType && !activeStatus && !activeTag ? renderContinueRail(continueRail) : "";

  const body = notes.length === 0
    ? `<div class="empty"><h2>Empty</h2><p class="lead">${emptyMsg}</p></div>`
    : `<main class="v-page">${railHtml}${groupsHtml}${tagsSection}</main>`;

  const meta = notes.length > 0 ? `${notes.length} ${notes.length === 1 ? "note" : "notes"} · latest ${ago(notes[0]!.created)}` : "";
  return shell("Folio", `${topbar("", "notes")}${filterBar(activeType, activeStatus, counts, meta, activeTag)}${tagBar(popularTags, activeTag)}${activeFilterStrip(activeTag, activeType, activeStatus)}${body}`);
}

export function pageTag(tag: string, notes: NoteMeta[], popularTags: { tag: string; count: number }[] = []): string {
  const sorted = [...notes].sort((a, b) => b.created.localeCompare(a.created));
  const latest = sorted[0]?.created ?? "";
  const finalCount = notes.filter((n) => n.is_final).length;
  const rows = sorted.map(noteRow).join("");
  const otherTags = popularTags.filter((t) => t.tag !== tag).slice(0, 16);
  const otherCloud = otherTags.length > 0
    ? `<div class="group">
         <div class="group-lbl">Other popular tags <span class="count">· ${otherTags.length}</span></div>
         ${tagCloud(otherTags)}
       </div>`
    : "";

  const { ns, value, nsClass } = parseTagNs(tag);
  const description = ns !== null
    ? `${esc(ns)}: ${esc(value.replace(/-/g, " "))}`
    : "";
  const headerInner = ns !== null
    ? `<span class="ns">${esc(ns)}:</span><span class="val">${esc(value)}</span>`
    : `<span class="val">${esc(tag)}</span>`;
  const headerClasses = ["tag-header"];
  if (nsClass) headerClasses.push(nsClass);

  const sideItems = sorted.map((n) => listSidebarItem(n, undefined, `tag:${tag}`)).join("");
  const sidebar = `
<aside class="list-side">
  <a href="/" class="back">← Back to list</a>
  <h2>${ns ? `<span class="ns">${esc(ns)}:</span>` : ""}${esc(value)}</h2>
  <div class="list-meta">${notes.length} ${notes.length === 1 ? "note" : "notes"}${finalCount > 0 ? ` · ★ ${finalCount} final` : ""}</div>
  <div class="list-items">${sideItems}</div>
</aside>`;

  const main = `
<main class="list-main">
  <div class="v-page">
    <div class="group">
      <div class="group-lbl"><a href="/" style="color:var(--vmuted)">← Notes</a> <span class="spacer"></span><span class="accent">tag</span></div>
      <div style="padding: 12px 4px 24px;">
        <div class="${headerClasses.join(" ")}">${headerInner}<span class="count">${notes.length} ${notes.length === 1 ? "note" : "notes"}</span></div>
        <div style="font-family: var(--vserif); font-style: italic; font-size: 17px; color: var(--vmuted); margin-top: 12px; line-height: 1.4;">${description ? esc("Notes tagged: ") + description : "Notes carrying this tag."}</div>
        <div style="font-family: var(--vmono); font-size: 12px; color: var(--vmuted-2); margin-top: 6px;">
          latest ${ago(latest)}${finalCount > 0 ? ` · <span style="color:var(--vorange)">★ ${finalCount} final</span>` : ""}
          · <a href="/?tag=${encodeURIComponent(tag)}" style="color:var(--vmuted); border-bottom: 1px solid var(--vline);">open in main feed</a>
        </div>
      </div>
      <div class="rows">${rows}</div>
    </div>
    ${otherCloud}
  </div>
</main>`;

  return shell(`Tag: ${tag}`, `${topbar("", "notes")}<div class="list-shell">${sidebar}${main}</div>`, { bodyClass: "list-page" });
}

/** Sidebar item renderer for /tag/ + /p/ + /n/ pages (v0.20.1+).
 *  Pass `currentId` to highlight the active note; pass `from` so the
 *  link carries `?from=tag:X` / `?from=project:Y` and pageNote knows
 *  to override prev/next + back link with that list's ordering. */
function listSidebarItem(n: NoteMeta, currentId: string | undefined, from: string): string {
  const active = n.id === currentId ? " active" : "";
  const finalCls = n.is_final ? " final" : "";
  const href = `/n/${encodeURIComponent(n.id)}?from=${encodeURIComponent(from)}`;
  return `<a class="list-item${active}" href="${href}">
    <div class="list-item__title${finalCls}">${esc(n.title)}</div>
    <div class="list-item__meta">
      <span class="list-item__type ${esc(n.type)}">${esc(n.type)}</span>
      <span>${ago(n.created)}</span>
    </div>
  </a>`;
}

// ───────────────────────────────────────────────────────────────────────
// Project grouping (v0.20+) — /p/:slug shows threads-in-project, not the
// flat note list `/tag/project:slug` gives. Each card = one thread that
// has ≥1 note tagged `project:<slug>`. Drives the agent's "multi-thread
// project workspace" mental model that maps to Obsidian's folder shape.
// ───────────────────────────────────────────────────────────────────────

import type { ProjectThreadGroup } from "../core/storage";

/**
 * v0.24 — Project workspace as a dashboard, not a flat list.
 *
 * Sections, top → bottom:
 *   1. Slot cards (canonical living docs: roadmap / todo / changelog / …)
 *      Each card shows slot name, head note title, excerpt, and click → /n/<head-id>
 *   2. Pending iterations (any non-finalized iteration note in the project)
 *      Each opens the gallery view; "round X · N variants · pick one"
 *   3. Threads — one card per thread, the thread's notes listed inside it as
 *      rows that click straight through to /n/<id> (v0.31). Card header links
 *      to the /t/<thread> view.
 *   4. Recent activity (last 14d of events) — demoted to the bottom (v0.31).
 *      Thin timeline — kind icon + title + ago
 *
 * Empty project: keeps the v0.20 "tag a note with project:<slug>" prompt.
 */
export function pageProject(dashboard: ProjectDashboard): string {
  const { slug, slots, pendingIterations, recentActivity, threadGroups, totalNotes, slotWarnings } = dashboard;
  const latestCreated = threadGroups[0]?.latestCreated ?? "";
  const totalFinal = threadGroups.reduce((acc, g) => acc + g.finalCount, 0);

  const cardCss = `<style>
    .proj-page { max-width: 1100px; margin: 0 auto; padding: 20px 28px 60px; }
    .proj-head { padding: 12px 4px 24px; }
    .proj-eyebrow { font-family: var(--vmono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--vmuted); margin-bottom: 6px; }
    .proj-eyebrow a { color: var(--vmuted); }
    .proj-eyebrow a:hover { color: var(--vorange); }
    .proj-title { font-family: var(--vhead); font-weight: 500; font-size: clamp(28px, 3.6vw, 40px); letter-spacing: -0.025em; margin: 0 0 6px; line-height: 1.1; }
    .proj-title .proj-ns { color: var(--vorange); }
    .proj-sub { font-family: var(--vserif); font-style: italic; font-size: 17px; color: var(--vmuted); margin: 6px 0 2px; }
    .proj-meta { font-family: var(--vmono); font-size: 12px; color: var(--vmuted-2); margin-top: 8px; }
    .proj-meta .final { color: var(--vorange); }
    .proj-empty { padding: 60px 20px; text-align: center; color: var(--vmuted); }
    .proj-empty p { font-family: var(--vserif); font-style: italic; font-size: 17px; line-height: 1.5; margin: 0 0 14px; }
    .proj-empty code { font-family: var(--vmono); background: var(--vbg-2); padding: 2px 6px; border-radius: 3px; }

    /* Section header — used by Slots / Pending / Activity / Threads */
    .proj-section { margin: 32px 0 14px; display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
    .proj-section h2 { font-family: var(--vmono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--vmuted); font-weight: 600; margin: 0; }
    .proj-section .lbl-cnt { color: var(--vmuted-2); margin-left: 6px; }
    .proj-section .hint { font-family: var(--vserif); font-style: italic; font-size: 12.5px; color: var(--vmuted-2); }

    /* Slot cards */
    .proj-slots { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
    .proj-slot { background: var(--vpanel); border: 1px solid var(--vline); border-radius: 12px; padding: 16px 18px; transition: border-color .15s, transform .15s; text-decoration: none; color: inherit; display: flex; flex-direction: column; gap: 8px; position: relative; }
    .proj-slot:hover { border-color: var(--vorange); transform: translateY(-2px); }
    .proj-slot__name { font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--vorange); font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .proj-slot__name .slot-icon { font-size: 13px; line-height: 1; }
    .proj-slot__title { font-family: var(--vhead); font-size: 17px; font-weight: 500; letter-spacing: -0.01em; color: var(--vink); margin: 0; line-height: 1.3; }
    .proj-slot__excerpt { font-family: var(--vserif); font-style: italic; font-size: 13.5px; color: var(--vmuted); line-height: 1.5; margin: 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .proj-slot__meta { font-family: var(--vmono); font-size: 10px; color: var(--vmuted-2); margin-top: auto; padding-top: 6px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .proj-slot__meta .live { color: #2f9050; }
    .proj-slot__meta .type { color: var(--vink-2); }
    .proj-slot__warn { background: rgba(201,142,45,0.12); color: #b07a1f; font-family: var(--vmono); font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; padding: 1px 6px; border-radius: 4px; margin-left: auto; }

    /* Pending iterations strip */
    .proj-pending { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .proj-pending-card { background: var(--vpanel); border: 1.5px solid var(--vorange); border-radius: 10px; padding: 14px 16px; text-decoration: none; color: inherit; display: flex; flex-direction: column; gap: 6px; transition: transform .12s, box-shadow .12s; box-shadow: 0 2px 8px rgba(255,90,31,0.06); }
    .proj-pending-card:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(255,90,31,0.14); }
    .proj-pending-card__flag { font-family: var(--vmono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--vorange); font-weight: 700; }
    .proj-pending-card__title { font-family: var(--vhead); font-size: 15px; font-weight: 500; letter-spacing: -0.01em; color: var(--vink); }
    .proj-pending-card__sub { font-family: var(--vmono); font-size: 10.5px; color: var(--vmuted); }

    /* Activity timeline */
    .proj-activity { background: var(--vbg-2); border-radius: 10px; padding: 8px 14px; }
    .proj-act-row { display: grid; grid-template-columns: 26px 1fr auto; gap: 12px; align-items: baseline; padding: 7px 4px; font-size: 12.5px; border-bottom: 1px solid var(--vline-2); }
    .proj-act-row:last-child { border-bottom: 0; }
    .proj-act-row .icon { font-family: var(--vmono); font-size: 12px; color: var(--vorange); }
    .proj-act-row .desc { color: var(--vink-2); }
    .proj-act-row .desc a { color: inherit; border-bottom: 1px dashed var(--vline); }
    .proj-act-row .desc a:hover { color: var(--vorange); border-bottom-color: currentColor; }
    .proj-act-row .when { font-family: var(--vmono); font-size: 10.5px; color: var(--vmuted-2); }

    /* Threads as cards, each with its notes listed inside (one click → note) */
    .proj-tcards { display: flex; flex-direction: column; gap: 14px; margin-top: 8px; }
    .proj-tcard { background: var(--vpanel); border: 1px solid var(--vline); border-radius: 12px; padding: 2px 18px 6px; transition: border-color .12s; }
    .proj-tcard:hover { border-color: var(--vline-2); }
    .proj-tcard__head { display: flex; align-items: baseline; gap: 10px; padding: 13px 4px 9px; border-bottom: 1px solid var(--vline-2); }
    .proj-tcard__name { font-family: var(--vhead); font-size: 16px; font-weight: 500; letter-spacing: -0.01em; color: var(--vink-2); text-decoration: none; }
    .proj-tcard__name:hover { color: var(--vorange); }
    .proj-tcard__meta { font-family: var(--vmono); font-size: 10.5px; color: var(--vmuted); margin-left: auto; }
    .proj-tcard__meta .final { color: var(--vorange); }
    .proj-nrow { display: grid; grid-template-columns: 96px 1fr auto; gap: 12px; align-items: center; padding: 9px 4px; border-bottom: 1px solid var(--vline-2); text-decoration: none; color: inherit; transition: background .1s; }
    .proj-nrow:last-child { border-bottom: 0; }
    .proj-nrow:hover { background: var(--vbg-2); }
    .proj-nrow__type { font-family: var(--vmono); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vorange); background: var(--vorange-soft); padding: 3px 0; border-radius: 8px; text-align: center; }
    .proj-nrow__title { font-family: var(--vhead); font-size: 14.5px; font-weight: 500; letter-spacing: -0.01em; color: var(--vink); min-width: 0; }
    .proj-nrow__title .live { color: #2f9050; font-weight: 600; font-size: 11px; }
    .proj-nrow__title .final { color: var(--vorange); font-weight: 700; }
    .proj-nrow__when { font-family: var(--vmono); font-size: 10.5px; color: var(--vmuted-2); white-space: nowrap; }
  </style>`;

  // Slot icons — emoji-free, monospace glyphs the linen theme already uses
  const slotIcon = (name: string): string => {
    switch (name) {
      case "roadmap": return "→";
      case "todo": return "☐";
      case "changelog": return "▤";
      case "release-notes": return "★";
      case "vision": return "◇";
      case "hub": return "◎";
      case "presentation": return "▰";
      case "gantt": return "≣";
      default: return "·";
    }
  };

  const headerInner = `<span class="proj-ns">project:</span>${esc(slug)}`;
  const meta = totalNotes > 0
    ? `${threadGroups.length} ${threadGroups.length === 1 ? "thread" : "threads"} · ${totalNotes} ${totalNotes === 1 ? "note" : "notes"} · latest ${ago(latestCreated)}${totalFinal > 0 ? ` · <span class="final">★ ${totalFinal} final</span>` : ""}`
    : "";

  // ── Slots section ─────────────────────────────────────────────────────
  const slotsHtml = slots.length === 0
    ? ""
    : `<div class="proj-section"><h2>Canonical docs <span class="lbl-cnt">· ${slots.length}</span></h2><span class="hint">slot:&lt;name&gt; tag → one head doc per slot</span></div>
       <div class="proj-slots">${
         slots.map((s) => {
           const liveLbl = s.head.live ? `<span class="live">● live</span>` : "";
           const warnLbl = s.duplicates > 0 ? `<span class="proj-slot__warn">+${s.duplicates} dupe${s.duplicates === 1 ? "" : "s"}</span>` : "";
           return `<a class="proj-slot" href="/n/${esc(s.head.id)}?from=project:${encodeURIComponent(slug)}">
             <div class="proj-slot__name"><span class="slot-icon">${slotIcon(s.name)}</span>slot:${esc(s.name)}${warnLbl}</div>
             <h3 class="proj-slot__title">${esc(s.head.title)}</h3>
             ${s.excerpt ? `<p class="proj-slot__excerpt">${esc(s.excerpt)}</p>` : ""}
             <div class="proj-slot__meta">
               <span class="type">${esc(s.head.type)}</span>
               <span>${ago(s.head.updated)}</span>
               ${liveLbl}
               ${s.head.is_final ? '<span style="color:var(--vorange)">★ final</span>' : ""}
             </div>
           </a>`;
         }).join("")
       }</div>`;

  // ── Pending iterations ────────────────────────────────────────────────
  const pendingHtml = pendingIterations.length === 0
    ? ""
    : `<div class="proj-section"><h2>Pending picks <span class="lbl-cnt">· ${pendingIterations.length}</span></h2><span class="hint">iteration rounds waiting for your click</span></div>
       <div class="proj-pending">${
         pendingIterations.map((n) => `<a class="proj-pending-card" href="/n/${esc(n.id)}?from=project:${encodeURIComponent(slug)}">
           <span class="proj-pending-card__flag">↻ iteration · pending pick</span>
           <span class="proj-pending-card__title">${esc(n.title)}</span>
           <span class="proj-pending-card__sub">thread ${esc(n.thread_id)} · ${ago(n.updated)}</span>
         </a>`).join("")
       }</div>`;

  // ── Recent activity timeline ──────────────────────────────────────────
  const actIcon = (kind: string): string => {
    if (kind === "note_created") return "+";
    if (kind === "note_viewed") return "○";
    if (kind === "note_finalized") return "★";
    if (kind === "note_metadata_updated") return "✎";
    if (kind === "note_superseded") return "↻";
    if (kind === "live_entry_appended") return "▶";
    if (kind === "note_deleted") return "✕";
    if (kind === "note_unfinalized") return "↶";
    return "·";
  };
  const actDesc = (e: ProjectActivityEvent): string => {
    const noteLink = e.note_id ? `<a href="/n/${esc(e.note_id)}?from=project:${encodeURIComponent(slug)}">note</a>` : "note";
    const threadLink = e.thread_id ? `<a href="/t/${esc(e.thread_id)}">${esc(e.thread_id)}</a>` : "";
    if (e.kind === "note_created") return `created ${noteLink} in ${threadLink}`;
    if (e.kind === "note_viewed") return `viewed ${noteLink}`;
    if (e.kind === "note_finalized") return `finalized ${noteLink}`;
    if (e.kind === "live_entry_appended") return `appended to live ${noteLink}`;
    if (e.kind === "note_metadata_updated") return `edited metadata on ${noteLink}`;
    if (e.kind === "note_superseded") return `${noteLink} replaced`;
    if (e.kind === "note_deleted") return `deleted ${noteLink}`;
    if (e.kind === "note_unfinalized") return `unfinalized ${noteLink}`;
    return `${esc(e.kind)} on ${noteLink}`;
  };
  const activityHtml = recentActivity.length === 0
    ? ""
    : `<div class="proj-section"><h2>Recent activity <span class="lbl-cnt">· ${recentActivity.length}</span></h2><span class="hint">last 14 days</span></div>
       <div class="proj-activity">${
         recentActivity.map((e) => `<div class="proj-act-row">
           <span class="icon">${actIcon(e.kind)}</span>
           <span class="desc">${actDesc(e)}</span>
           <span class="when">${ago(e.ts)}</span>
         </div>`).join("")
       }</div>`;

  // ── Threads — one card per thread, its notes listed inside (v0.31) ─────
  let threadsHtml: string;
  if (threadGroups.length === 0) {
    threadsHtml = `<div class="proj-empty">
      <p>No threads tagged <code>project:${esc(slug)}</code> yet.</p>
      <p style="font-size: 14px; line-height: 1.55;">When you ask an agent to write something for this project, ask it to <strong>tag the note <code>project:${esc(slug)}</code></strong> — it'll show up here grouped by thread.</p>
    </div>`;
  } else {
    const noteRow = (n: NoteMeta): string => {
      const flags = [
        n.live ? `<span class="live">● live</span>` : "",
        n.is_final ? `<span class="final">★</span>` : "",
      ].filter(Boolean).join(" ");
      return `<a class="proj-nrow" href="/n/${esc(n.id)}?from=project:${encodeURIComponent(slug)}">
        <span class="proj-nrow__type">${esc(n.type)}</span>
        <span class="proj-nrow__title">${esc(n.title)}${flags ? ` ${flags}` : ""}</span>
        <span class="proj-nrow__when">${ago(n.created)}</span>
      </a>`;
    };
    const cards = threadGroups.map((g) => {
      const rows = g.notes.map(noteRow).join("");
      return `<div class="proj-tcard">
        <div class="proj-tcard__head">
          <a class="proj-tcard__name" href="/t/${esc(g.thread_id)}">${esc(g.thread_id)}</a>
          <span class="proj-tcard__meta">${g.noteCount} ${g.noteCount === 1 ? "note" : "notes"} · latest ${ago(g.latestCreated)}${g.finalCount > 0 ? ` · <span class="final">★ ${g.finalCount}</span>` : ""}</span>
        </div>
        ${rows}
      </div>`;
    }).join("");
    threadsHtml = `<div class="proj-section"><h2>Threads <span class="lbl-cnt">· ${threadGroups.length}</span></h2><span class="hint">notes grouped by thread — click to open</span></div>
       <div class="proj-tcards">${cards}</div>`;
  }

  // Sidebar: group notes by thread, list under thread-name section heading.
  const sideHtml = threadGroups.length === 0
    ? ""
    : threadGroups.map((g) => {
        const items = g.notes.map((n) => listSidebarItem(n, undefined, `project:${slug}`)).join("");
        return `<div class="list-section">${esc(g.thread_id)} · ${g.noteCount}</div>${items}`;
      }).join("");

  const sidebar = `
<aside class="list-side">
  <a href="/" class="back">← Back to list</a>
  <h2><span class="ns">project:</span>${esc(slug)}</h2>
  <div class="list-meta">${threadGroups.length} ${threadGroups.length === 1 ? "thread" : "threads"} · ${totalNotes} ${totalNotes === 1 ? "note" : "notes"}${totalFinal > 0 ? ` · ★ ${totalFinal} final` : ""}${slots.length > 0 ? ` · ${slots.length} slot${slots.length === 1 ? "" : "s"}` : ""}${pendingIterations.length > 0 ? ` · ${pendingIterations.length} pending` : ""}</div>
  <div class="list-items">${sideHtml}</div>
</aside>`;

  const main = `
<main class="list-main">
  <div class="proj-page">
    <div class="proj-head">
      <div class="proj-eyebrow"><a href="/">← Notes</a> · <a href="/tag/${esc(`project:${slug}`)}">flat tag view</a></div>
      <h1 class="proj-title">${headerInner}</h1>
      <p class="proj-sub">Project workspace — canonical docs, pending decisions, every note one click away.</p>
      ${meta ? `<div class="proj-meta">${meta}</div>` : ""}
    </div>
    ${slotsHtml}
    ${pendingHtml}
    ${threadsHtml}
    ${activityHtml}
  </div>
</main>`;

  return shell(`Project: ${slug}`, `${topbar("", "notes")}${cardCss}<div class="list-shell">${sidebar}${main}</div>`, { bodyClass: "list-page" });
}

export function pageSearch(
  query: string,
  hits: SearchHit[],
  threadHits: ThreadHit[],
  counts: CountSummary,
  durationMs: number
): string {
  const empty = hits.length === 0 && threadHits.length === 0;
  const body = empty
    ? `<div class="empty"><h2>No results</h2><p class="lead">Try different words. Or browse <a href="/threads" style="color:var(--vorange);border-bottom:1px solid currentColor">all threads</a>.</p></div>`
    : `<main class="v-page">
         ${threadHits.length ? `<div class="group">
            <div class="group-lbl">Threads <span class="count">· ${threadHits.length} ${threadHits.length === 1 ? "hit" : "hits"}</span><span class="spacer"></span><span class="accent">groups</span></div>
            ${threadHits.map((t) => clusterCard(t)).join("")}
          </div>` : ""}
         ${hits.length ? `<div class="group">
            <div class="group-lbl">Notes <span class="count">· ${hits.length} ${hits.length === 1 ? "hit" : "hits"}</span><span class="spacer"></span><span class="accent">single hits</span></div>
            <div class="rows">${hits.map(searchRow).join("")}</div>
          </div>` : ""}
       </main>`;
  const meta = `${hits.length + threadHits.length} ${hits.length + threadHits.length === 1 ? "hit" : "hits"} · ${durationMs} ms · fts5`;
  return shell(`Search: ${query}`, `${topbar(query, "notes")}${filterBar(undefined, undefined, counts, meta)}${body}`);
}

export function pageThreads(threads: ThreadHit[], query?: string): string {
  // Split into active (recent activity, no final) vs closed (has final) — or just active vs all
  const withFinal = threads.filter((t) => t.final_count > 0);
  const active = threads.filter((t) => t.final_count === 0);
  const sections: string[] = [];
  if (active.length > 0) {
    sections.push(`<div class="group">
      <div class="group-lbl">${query ? "Matched active" : "Active"} <span class="count">· ${active.length}</span><span class="spacer"></span><span class="accent">in progress</span></div>
      <div class="rows">${active.map(threadCard).join("")}</div>
    </div>`);
  }
  if (withFinal.length > 0) {
    sections.push(`<div class="group">
      <div class="group-lbl">With final <span class="count">· ${withFinal.length}</span></div>
      <div class="rows">${withFinal.map(threadCard).join("")}</div>
    </div>`);
  }
  const body = threads.length === 0
    ? `<div class="empty"><h2>No threads</h2><p class="lead">${query ? `No matches for <code>${esc(query)}</code>.` : "Create a note with a thread_id to start."}</p></div>`
    : `<main class="v-page">${sections.join("")}</main>`;
  const meta = `${threads.length} ${threads.length === 1 ? "thread" : "threads"} · sort: last activity`;
  return shell("Threads", `${topbar(query ?? "", "threads")}${filterBar(undefined, undefined, undefined, meta)}${body}`);
}

export function pageThread(threadId: string, notes: NoteMeta[]): string {
  const sorted = [...notes].sort((a, b) => a.created.localeCompare(b.created));
  const latest = sorted[sorted.length - 1]?.created ?? "";
  const hasFinal = notes.some((n) => n.is_final);
  const rows = sorted.map((n, i) => {
    const expiring = !n.is_final ? daysUntil(n.expires_at) : null;
    let stat = `<span class="stat">·</span>`;
    if (n.is_final) stat = `<span class="stat final">★ final</span>`;
    else if (expiring && /^\d+d$/.test(expiring)) {
      const d = parseInt(expiring);
      if (d <= 7) stat = `<span class="stat warn">⏱ ${expiring}</span>`;
    }
    return `
<a class="row" href="/n/${n.id}">
  <span class="type ${n.type}">v${i + 1} · ${n.type}</span>
  <div>
    <span class="title">${esc(n.title)}</span>
    <span class="title-sub">${esc(n.theme)} theme · ${n.word_count} words</span>
  </div>
  <span class="age">${ago(n.created)}</span>
  ${stat}
</a>`;
  }).join("");

  const body = `
<main class="v-page">
  <div class="group">
    <div class="group-lbl"><a href="/threads" style="color:var(--vmuted)">← Threads</a> <span class="spacer"></span>${hasFinal ? `<span class="accent">final in thread</span>` : `<span class="accent">in progress</span>`}</div>
    <div style="padding: 8px 4px 20px;">
      <div style="font-family: var(--vmono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--vbronze); margin-bottom: 8px;">📂 ${esc(threadId)}</div>
      <h1 style="font-family: var(--vhead); font-weight: 500; font-size: clamp(28px, 3.6vw, 40px); letter-spacing: -0.025em; margin: 0 0 6px; line-height: 1.1;">Thread</h1>
      <div style="font-family: var(--vmono); font-size: 12px; color: var(--vmuted);">
        ${notes.length} ${notes.length === 1 ? "note" : "notes"} · latest ${ago(latest)}${hasFinal ? ` · <span style="color:var(--vorange)">★ final</span>` : ""}
      </div>
    </div>
    <div class="rows">${rows}</div>
  </div>
</main>`;
  return shell(`Thread: ${threadId}`, `${topbar("", "threads")}${body}`);
}

// ───────────────────────────────────────────────────────────────────────
// Share popover (v0.19+) — topbar trigger + form + manage-bar (B3 layout).
// ───────────────────────────────────────────────────────────────────────

const SHARE_POPOVER_CSS = `<style>
/* Share trigger moved to .side-aux in v0.21.1; keep the legacy selectors
   around for any callers that still pass shareForId, plus the new sidebar
   location styling. */
.v-share-trigger { position: relative; }
.v-share-trigger .active-dot,
.side-aux #share-trigger .active-dot { display: inline-block; width: 6px; height: 6px; background: var(--vorange); border-radius: 50%; margin-left: 6px; vertical-align: middle; }
.v-share-trigger .active-dot[hidden],
.side-aux #share-trigger .active-dot[hidden] { display: none; }
.side-aux #folio-handoff-btn.copied { color: #2f9050; }

/* Popover positioned dynamically by JS via inline top/left styles on open
   (v0.21.2+) — anchored to the right of the sidebar Share trigger so the
   form sits next to where the user clicked. Falls back to top-right via
   the data-position="top-right" attribute on body if needed. */
.share-pop { position: fixed; top: 54px; left: 380px; width: 280px; background: var(--vpanel); border: 1px solid var(--vline); border-radius: 10px; box-shadow: 0 12px 36px rgba(0,0,0,0.16); z-index: 100; overflow-x: hidden; overflow-y: auto; max-height: calc(100vh - 24px); opacity: 0; visibility: hidden; transform: translateX(-4px); transition: opacity .14s, transform .14s, visibility .14s; }
.share-pop.is-open { opacity: 1; visibility: visible; transform: translateX(0); }
/* Pointer triangle on the LEFT edge (now that popover sits to the right
   of the trigger). Vertical center is set inline via --share-pop-arrow-top
   CSS custom property by the open() function to match the trigger's y. */
.share-pop::before { content: ''; position: absolute; top: var(--share-pop-arrow-top, 18px); left: -6px; width: 10px; height: 10px; background: var(--vpanel); border-left: 1px solid var(--vline); border-bottom: 1px solid var(--vline); transform: rotate(45deg); }
.share-pop__head { padding: 14px 18px 8px; }
.share-pop__title { font-family: var(--vmono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--vmuted); font-weight: 600; }
.share-pop__form { padding: 0 18px 14px; display: flex; flex-direction: column; gap: 9px; }
.share-pop__row { display: flex; flex-direction: column; gap: 3px; }
.share-pop__row label { font-family: var(--vmono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--vmuted); }
.share-pop__row input { padding: 7px 10px; border: 1px solid var(--vline); border-radius: 5px; background: var(--vbg); color: inherit; font-family: var(--vmono); font-size: 12.5px; }
.share-pop__row input:focus { outline: none; border-color: var(--vorange); }
.share-pop__go { background: var(--vorange); color: #fff; border: 0; padding: 9px; border-radius: 6px; font-family: 'Familjen Grotesk', sans-serif; font-weight: 600; font-size: 12.5px; cursor: pointer; letter-spacing: 0.05em; text-transform: uppercase; margin-top: 4px; }
.share-pop__go:hover { background: #e64a0e; }
.share-pop__go:disabled { opacity: 0.55; cursor: wait; }
.share-pop__result { padding: 14px 18px; border-top: 1px solid var(--vline); background: rgba(47,144,80,0.05); display: none; }
.share-pop__result.is-shown { display: block; }
.share-pop__result-label { font-family: var(--vmono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: #2f9050; font-weight: 600; margin-bottom: 6px; }
.share-pop__result-url { font-family: var(--vmono); font-size: 10.5px; word-break: break-all; color: var(--vorange); margin-bottom: 10px; line-height: 1.45; }
.share-pop__result-actions { display: flex; gap: 6px; }
.share-pop__result-actions button { flex: 1; padding: 6px 8px; border: 1px solid var(--vline); background: var(--vpanel); color: inherit; border-radius: 4px; font-family: var(--vmono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; }
.share-pop__result-actions button:hover { background: var(--vbg-2); }
.share-pop__result-actions button.copied { color: #2f9050; border-color: #2f9050; }
.share-pop__error { padding: 10px 18px; border-top: 1px solid var(--vline); color: #c8412a; font-size: 12px; line-height: 1.5; display: none; }
.share-pop__error.is-shown { display: block; }
.share-pop__error a { color: var(--vorange); }
.share-pop__manage { background: rgba(255,90,31,0.05); border-top: 1px solid var(--vline); padding: 10px 18px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-family: var(--vmono); font-size: 10.5px; text-decoration: none; color: inherit; }
.share-pop__manage:hover { background: rgba(255,90,31,0.09); }
.share-pop__manage .lbl { color: var(--vmuted); letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.share-pop__manage .cnt { background: var(--vorange); color: #fff; font-size: 9px; padding: 1px 7px; border-radius: 9px; font-weight: 600; }
.share-pop__manage .arrow { color: var(--vorange); font-weight: 600; }
.share-pop__manage[hidden] { display: none; }
</style>`;

function sharePopoverHtml(noteId: string): string {
  return `<aside class="share-pop" id="share-pop" role="dialog" aria-label="Publish capability URL" data-note-id="${esc(noteId)}">
  <div class="share-pop__head">
    <div class="share-pop__title">Publish capability URL</div>
  </div>
  <form class="share-pop__form" id="share-form">
    <div class="share-pop__row">
      <label for="share-expires">Expires (days · 0 = never)</label>
      <input id="share-expires" name="expires_in_days" type="number" value="7" min="0" max="365">
    </div>
    <div class="share-pop__row">
      <label for="share-maxviews">Max views (blank = ∞)</label>
      <input id="share-maxviews" name="max_views" type="number" placeholder="e.g. 5" min="1">
    </div>
    <div class="share-pop__row">
      <label for="share-recipient">Recipient email (optional)</label>
      <input id="share-recipient" name="recipient" type="email" placeholder="alice@example.com">
    </div>
    <div class="share-pop__row share-pop__row--check">
      <label><input id="share-include-linked" name="include_linked" type="checkbox"> Include linked notes <span class="share-pop__hint">grant access to every note this one links to</span></label>
    </div>
    <div class="share-pop__row share-pop__row--check">
      <label><input id="share-allow-pick" name="allow_pick" type="checkbox"> Let recipient pick a variant <span class="share-pop__hint">adds a "choose this" button to every <code>data-folio-pick</code> block</span></label>
    </div>
    <button class="share-pop__go" type="submit" id="share-submit">Publish →</button>
  </form>
  <div class="share-pop__result" id="share-result">
    <div class="share-pop__result-label">✓ Published</div>
    <div class="share-pop__result-url" id="share-result-url"></div>
    <div class="share-pop__result-actions">
      <button type="button" id="share-result-copy">Copy URL</button>
      <button type="button" id="share-result-revoke">Revoke</button>
    </div>
  </div>
  <div class="share-pop__error" id="share-error"></div>
  <a href="/n/${esc(noteId)}/shares" class="share-pop__manage" id="share-manage" hidden>
    <span class="lbl">Active <span class="cnt" id="share-active-count">0</span></span>
    <span class="arrow">manage →</span>
  </a>
</aside>`;
}

function sharePopoverJs(noteId: string): string {
  // Wires the trigger/popover/form. Outside-click + Esc dismiss. POSTs the
  // form to the viewer's /api/notes/:id/shares proxy and shows the URL
  // inline on success. Refreshes the active-count after publish/revoke so
  // the manage bar + topbar dot stay accurate.
  return `(function () {
  var noteId = ${JSON.stringify(noteId)};
  var trigger = document.getElementById('share-trigger');
  var pop = document.getElementById('share-pop');
  if (!trigger || !pop) return;
  var form = document.getElementById('share-form');
  var submitBtn = document.getElementById('share-submit');
  var result = document.getElementById('share-result');
  var resultUrl = document.getElementById('share-result-url');
  var resultCopy = document.getElementById('share-result-copy');
  var resultRevoke = document.getElementById('share-result-revoke');
  var errorBox = document.getElementById('share-error');
  var manageBar = document.getElementById('share-manage');
  var activeCount = document.getElementById('share-active-count');
  var activeDot = document.getElementById('share-active-dot');
  var lastToken = null;

  function positionNearTrigger() {
    // Anchor the popover to the right of the trigger so the form appears
    // where the user clicked (v0.21.2+). Trigger lives in the left sidebar
    // (.side-aux). Popover floats over the main iframe to the trigger's
    // right. If the trigger goes offscreen vertically (long sidebar with
    // many actions), clamp top to viewport bounds with a small margin.
    var rect = trigger.getBoundingClientRect();
    var popHeight = pop.offsetHeight || 280;
    var viewportH = window.innerHeight;
    var margin = 12;
    var top = rect.top - 4;
    if (top + popHeight > viewportH - margin) top = Math.max(margin, viewportH - popHeight - margin);
    pop.style.top = top + 'px';
    pop.style.left = (rect.right + 14) + 'px';
    // Align the arrow triangle with the trigger's vertical center.
    var arrowTop = Math.max(8, Math.min(popHeight - 14, rect.top + rect.height / 2 - top - 5));
    pop.style.setProperty('--share-pop-arrow-top', arrowTop + 'px');
  }
  function open() {
    positionNearTrigger();
    pop.classList.add('is-open');
    // Recompute after the popover is visible (offsetHeight needs paint).
    setTimeout(function () {
      positionNearTrigger();
      var first = document.getElementById('share-expires');
      if (first) first.focus();
    }, 60);
  }
  function close() {
    pop.classList.remove('is-open');
    result.classList.remove('is-shown');
    errorBox.classList.remove('is-shown');
  }
  function showError(msg, html) {
    if (html) errorBox.innerHTML = html;
    else errorBox.textContent = msg;
    errorBox.classList.add('is-shown');
    // Error block grows the popover — re-clamp so the bottom stays on-screen.
    positionNearTrigger();
  }
  function updateActive(count) {
    if (count > 0) {
      manageBar.hidden = false;
      activeCount.textContent = String(count);
      if (activeDot) activeDot.hidden = false;
    } else {
      manageBar.hidden = true;
      if (activeDot) activeDot.hidden = true;
    }
    // The manage bar toggles the popover's height; re-clamp when it's open.
    if (pop.classList.contains('is-open')) positionNearTrigger();
  }
  function refreshActive() {
    fetch('/api/notes/' + encodeURIComponent(noteId) + '/shares')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && Array.isArray(data.shares)) updateActive(data.shares.length);
      })
      .catch(function () {});
  }

  trigger.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (pop.classList.contains('is-open')) close(); else open();
  });
  document.addEventListener('click', function (e) {
    if (!pop.classList.contains('is-open')) return;
    if (pop.contains(e.target) || trigger.contains(e.target)) return;
    close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && pop.classList.contains('is-open')) close();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox.classList.remove('is-shown');
    submitBtn.disabled = true;
    var prevLabel = submitBtn.textContent;
    submitBtn.textContent = 'Publishing…';
    var body = { expires_in_days: Number(document.getElementById('share-expires').value || 7) };
    var maxv = document.getElementById('share-maxviews').value.trim();
    if (maxv) body.max_views = Number(maxv);
    var rec = document.getElementById('share-recipient').value.trim();
    if (rec) body.recipient = rec;
    var inc = document.getElementById('share-include-linked');
    if (inc && inc.checked) body.include_linked = true;
    var pick = document.getElementById('share-allow-pick');
    if (pick && pick.checked) body.allow_pick = true;
    fetch('/api/notes/' + encodeURIComponent(noteId) + '/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    }).then(function (resp) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevLabel;
      if (!resp.ok) {
        if (resp.status === 412) {
          showError('', 'Cloud not paired. <a href="/cloud">Pair a device →</a>');
        } else {
          showError(resp.data.error || ('HTTP ' + resp.status));
        }
        return;
      }
      lastToken = resp.data.token;
      resultUrl.textContent = resp.data.url;
      // Set shares grant a bundle — make the size explicit so the user knows
      // they shared more than one note.
      var rlabel = pop.querySelector('.share-pop__result-label');
      if (rlabel) rlabel.textContent = (resp.data.note_count && resp.data.note_count > 1)
        ? ('✓ Published · ' + resp.data.note_count + ' notes (this + ' + (resp.data.note_count - 1) + ' linked)')
        : '✓ Published';
      result.classList.add('is-shown');
      // The result block (URL + actions) grows the popover after publish —
      // re-clamp so it doesn't slide off the bottom of the viewport.
      positionNearTrigger();
      refreshActive();
    }).catch(function (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevLabel;
      showError(err && err.message ? err.message : String(err));
    });
  });

  resultCopy.addEventListener('click', function () {
    var url = resultUrl.textContent;
    navigator.clipboard.writeText(url).then(function () {
      resultCopy.textContent = '✓ Copied';
      resultCopy.classList.add('copied');
      setTimeout(function () { resultCopy.textContent = 'Copy URL'; resultCopy.classList.remove('copied'); }, 1400);
    });
  });

  resultRevoke.addEventListener('click', function () {
    if (!lastToken) return;
    if (!window.confirm('Revoke this share? URL will stop working immediately.')) return;
    fetch('/api/notes/' + encodeURIComponent(noteId) + '/shares/' + encodeURIComponent(lastToken), {
      method: 'DELETE'
    }).then(function (r) {
      if (r.ok) {
        result.classList.remove('is-shown');
        lastToken = null;
        refreshActive();
      }
    });
  });

  refreshActive();
})();`;
}

/**
 * v0.22.2 — inline metadata editor (replaces the popover from v0.22.1).
 * Wires three direct-manipulation surfaces in the sidebar:
 *   • `.editable-title` — click the H1 → contenteditable, Enter saves,
 *     Esc cancels, blur saves. Empty/whitespace value is rejected.
 *   • `.tag-editor` — × on each chip removes (auto-saves); the trailing
 *     input adds a new tag on Enter or on click of an autocomplete
 *     suggestion. Autocomplete shows existing popular tags filtered by
 *     prefix, plus a "+ create [text]" affordance when the typed value
 *     doesn't match any. Up/Down navigate, Enter commits, Esc dismisses.
 *   • Theme dropdown's "Save as default" link is handled inside the
 *     existing noteScript above (it shares state with the preview).
 *
 * All saves POST to /api/notes/:id/metadata. On success we reload the
 * page so the sidebar h1, the body iframe's <title>/<h1>, the tag chips,
 * and the active theme link all converge to the new state.
 *
 * `popularTags` is embedded at render time (top 100 most-used tags in
 * this Folio). Cheap enough to inline; avoids a /api/tags round-trip on
 * every keystroke.
 */
function inlineMetadataEditorJs(noteId: string): string {
  const popular = listPopularTags(100, 1).map((t) => ({ tag: t.tag, count: t.count }));
  return `(function () {
  var noteId = ${JSON.stringify(noteId)};
  var popularTags = ${JSON.stringify(popular)};

  // ── Tiny toast helper used by all surfaces ────────────────────────────
  var toastEl = null;
  function toast(msg, isErr) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'meta-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.toggle('is-error', !!isErr);
    toastEl.classList.add('is-shown');
    clearTimeout(toastEl.__t);
    toastEl.__t = setTimeout(function () { toastEl.classList.remove('is-shown'); }, 1800);
  }
  window.__folioToast = toast;

  function saveMetadata(patch, onOk, onErr) {
    return fetch('/api/notes/' + encodeURIComponent(noteId) + '/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(function (r) {
      return r.json().then(function (d) { return { httpOk: r.ok, status: r.status, data: d }; });
    }).then(function (resp) {
      if (resp.httpOk && resp.data.ok) { onOk && onOk(resp.data); }
      else { onErr && onErr(resp.data || { reason: 'HTTP ' + resp.status }); }
    }).catch(function (err) {
      onErr && onErr({ reason: (err && err.message) || 'network' });
    });
  }

  // ── Inline title editor ───────────────────────────────────────────────
  var titleEl = document.querySelector('.editable-title');
  if (titleEl) {
    var originalTitle = titleEl.textContent.trim();
    var armed = false;
    function enterEdit() {
      if (armed) return;
      armed = true;
      titleEl.setAttribute('contenteditable', 'true');
      titleEl.focus();
      // Place cursor at end.
      try {
        var range = document.createRange();
        range.selectNodeContents(titleEl);
        range.collapse(false);
        var sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      } catch (_e) {}
    }
    function commit() {
      if (!armed) return;
      var v = titleEl.textContent.trim();
      titleEl.removeAttribute('contenteditable');
      armed = false;
      if (!v) {
        titleEl.textContent = originalTitle;
        toast('Title cannot be empty', true);
        return;
      }
      if (v === originalTitle) {
        titleEl.textContent = originalTitle;
        return;
      }
      titleEl.classList.add('is-saving');
      saveMetadata({ title: v }, function (data) {
        window.location.reload();
      }, function (err) {
        titleEl.classList.remove('is-saving');
        titleEl.textContent = originalTitle;
        toast('Save failed: ' + (err.reason || 'unknown'), true);
      });
    }
    function cancel() {
      if (!armed) return;
      titleEl.textContent = originalTitle;
      titleEl.removeAttribute('contenteditable');
      armed = false;
    }
    titleEl.addEventListener('click', enterEdit);
    titleEl.addEventListener('focus', enterEdit);
    titleEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); titleEl.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); titleEl.blur(); }
    });
    titleEl.addEventListener('blur', commit);
  }

  // ── Tag editor ────────────────────────────────────────────────────────
  var tagEditor = document.querySelector('.tag-editor');
  if (tagEditor) {
    function currentTags() {
      return Array.prototype.slice.call(tagEditor.querySelectorAll('.tag-chip[data-tag]'))
        .map(function (c) { return c.getAttribute('data-tag'); });
    }
    function persistTags(tags) {
      saveMetadata({ tags: tags }, function () {
        window.location.reload();
      }, function (err) {
        toast('Save failed: ' + (err.reason || 'unknown'), true);
      });
    }
    // Remove × button on existing chips.
    tagEditor.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('.tag-remove');
      if (!btn) return;
      e.preventDefault();
      var tag = btn.getAttribute('data-tag');
      var keep = currentTags().filter(function (t) { return t !== tag; });
      persistTags(keep);
    });

    var addInput = tagEditor.querySelector('.tag-add-input');
    var suggestBox = tagEditor.querySelector('.tag-suggest');
    var activeIdx = -1;

    function getSuggestions(q) {
      var existing = new Set(currentTags());
      var lower = q.trim().toLowerCase();
      var matches = popularTags.filter(function (p) {
        if (existing.has(p.tag)) return false;
        if (!lower) return true;
        return p.tag.toLowerCase().indexOf(lower) !== -1;
      }).slice(0, 8);
      // Add a "+ create" entry if the query is non-empty and doesn't exactly
      // match an existing popular tag (or any of the already-present tags).
      var exact = matches.some(function (m) { return m.tag.toLowerCase() === lower; });
      if (lower && !exact && !existing.has(lower)) {
        matches.unshift({ tag: lower, count: -1, create: true });
      }
      return matches;
    }
    function renderSuggestions(items) {
      if (items.length === 0) { suggestBox.hidden = true; suggestBox.innerHTML = ''; activeIdx = -1; return; }
      suggestBox.innerHTML = items.map(function (it, i) {
        if (it.create) {
          return '<button type="button" class="tag-suggest-item is-create" data-tag="' + escapeAttr(it.tag) + '">+ create &ldquo;' + escapeText(it.tag) + '&rdquo;</button>';
        }
        return '<button type="button" class="tag-suggest-item" data-tag="' + escapeAttr(it.tag) + '">' + escapeText(it.tag) + '<span class="count">' + it.count + '</span></button>';
      }).join('');
      suggestBox.hidden = false;
      activeIdx = 0;
      highlightActive();
    }
    function highlightActive() {
      var btns = suggestBox.querySelectorAll('.tag-suggest-item');
      btns.forEach(function (b, i) {
        b.classList.toggle('is-active', i === activeIdx);
      });
    }
    function addTag(tag) {
      var keep = currentTags();
      if (keep.indexOf(tag) !== -1) return;
      keep.push(tag);
      persistTags(keep);
    }
    function escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function escapeText(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    if (addInput && suggestBox) {
      addInput.addEventListener('focus', function () {
        renderSuggestions(getSuggestions(addInput.value));
      });
      addInput.addEventListener('input', function () {
        renderSuggestions(getSuggestions(addInput.value));
      });
      addInput.addEventListener('keydown', function (e) {
        var items = suggestBox.querySelectorAll('.tag-suggest-item');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (items.length === 0) return;
          activeIdx = (activeIdx + 1) % items.length;
          highlightActive();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (items.length === 0) return;
          activeIdx = (activeIdx - 1 + items.length) % items.length;
          highlightActive();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          var chosen = items[activeIdx] || items[0];
          if (chosen) addTag(chosen.getAttribute('data-tag'));
          else if (addInput.value.trim()) addTag(addInput.value.trim().toLowerCase());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          suggestBox.hidden = true;
          addInput.blur();
        }
      });
      suggestBox.addEventListener('mousedown', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('.tag-suggest-item');
        if (!btn) return;
        e.preventDefault();
        addTag(btn.getAttribute('data-tag'));
      });
      document.addEventListener('click', function (e) {
        if (suggestBox.hidden) return;
        if (tagEditor.contains(e.target)) return;
        suggestBox.hidden = true;
      });
    }
  }
})();`;
}

/** Context passed when navigating to a note from a list page (/tag/:slug
 *  or /p/:slug). When present, pageNote overrides:
 *   - the "← Back to list" link → points to the source list, not the homepage
 *   - prev/next buttons → walk the list (not thread siblings)
 *   - version label → "<i> of <n> in <list>"
 *  Without context, behavior is unchanged from pre-v0.20.1. */
export interface NoteListContext {
  kind: "tag" | "project";
  slug: string;
  items: { id: string; title: string }[];  // ordered same as the list
  currentIndex: number;
}

export function pageNote(note: NoteMeta, _themeName: string, context?: NoteListContext): string {
  const expiring = note.is_final ? null : daysUntil(note.expires_at);
  // Banner shows only when expiry is genuinely close (≤7 days) — matches
  // the `Expiring 7d` filter chip + `list_expiring` MCP tool's window.
  // Showing it for fresh 30-day-old notes was just noise that everyone
  // learned to ignore + pushed the viewport into a few-px overflow on
  // some screen sizes.
  const expiringDaysMatch = expiring && /^(\d+)d$/.exec(expiring);
  const closeToExpiry = expiringDaysMatch && Number(expiringDaysMatch[1]) <= 7;
  const banner = !note.is_final && closeToExpiry
    ? `<div class="note-banner">
        <div><span class="lbl">⏱ Auto-delete in ${expiring}</span>&nbsp; unless you mark final or publish</div>
        <form method="post" action="/api/notes/${note.id}/finalize" style="margin:0"><button class="finalize-btn" type="submit">★ Finalize</button></form>
       </div>`
    : "";

  // v0.22 supersede banner. When viewing /n/<old-id> after `replace`,
  // show a banner pointing to the current head. We walk the chain via
  // resolveHeadOfChain — a head may itself have been replaced again, and
  // we want the user one click away from the latest version, not the
  // immediate successor.
  let supersedeBanner = "";
  if (note.superseded_by) {
    const head = resolveHeadOfChain(note.id);
    if (head && head.id !== note.id) {
      supersedeBanner = `<div class="note-banner supersede-banner">
        <div><span class="lbl">↻ Replaced</span>&nbsp; this version has been superseded — <a href="/n/${head.id}">${esc(head.title)}</a> is the current head</div>
      </div>`;
    }
  }

  // v0.30.2 — revision-chain strip. When this note has been replaced at least
  // once (chain length > 1), surface the document's version history as linked
  // chips, current one highlighted, head marked ★. Each revision keeps its own
  // immutable /n/<id>. Single-revision notes (the common case) render nothing.
  const revisionChain = getRevisionChain(note.id);
  const revisionsHtml = revisionChain.length > 1
    ? `<nav class="revisions" aria-label="Revision history">
        <div class="rev-lbl">Revisions · ${revisionChain.length}</div>
        <div class="rev-chips">${revisionChain
          .map((m, i) => {
            const isHead = m.superseded_by === null;
            const cls = `rev-chip${m.id === note.id ? " cur" : ""}${isHead ? " head" : ""}`;
            return `<a class="${cls}" href="/n/${m.id}" title="${esc(m.title)}${isHead ? " · current" : ""}">v${i + 1}${isHead ? " ★" : ""}</a>`;
          })
          .join("")}</div>
       </nav>`
    : "";

  // Sibling notes in thread, ascending — for version label + prev/next nav
  const allSiblings = db()
    .query<{ id: string; created: string }, [string]>(
      `SELECT id, created FROM notes WHERE thread_id = ? AND status='active' ORDER BY created ASC`
    )
    .all(note.thread_id);
  const myIdx = allSiblings.findIndex((s) => s.id === note.id);
  const version = myIdx >= 0 ? myIdx + 1 : 1;
  const totalInThread = allSiblings.length || 1;
  const prevSibling = myIdx > 0 ? allSiblings[myIdx - 1] : null;
  const nextSibling = myIdx >= 0 && myIdx < allSiblings.length - 1 ? allSiblings[myIdx + 1] : null;

  // Reading time @ ~220 wpm
  const readingMin = Math.max(1, Math.ceil(note.word_count / 220));

  // Context-aware nav (v0.20.1+): when we arrived from /tag/:slug or /p/:slug
  // (via ?from=…), the back link points there and prev/next walk that list.
  // Without context we keep the original thread-based nav.
  const fromHref = context
    ? (context.kind === "project" ? `/p/${encodeURIComponent(context.slug)}` : `/tag/${encodeURIComponent(context.slug)}`)
    : "/";
  const fromLabel = context
    ? (context.kind === "project" ? `← Back to project: ${context.slug}` : `← Back to tag: ${context.slug}`)
    : "← Back to list";

  const ctxPrev = context && context.currentIndex > 0 ? context.items[context.currentIndex - 1] : null;
  const ctxNext = context && context.currentIndex < context.items.length - 1 ? context.items[context.currentIndex + 1] : null;
  const ctxFromQ = context ? `?from=${encodeURIComponent(context.kind === "project" ? `project:${context.slug}` : `tag:${context.slug}`)}` : "";

  const prevNextHtml = context
    ? `<div class="prev-next">
         ${ctxPrev
           ? `<a class="pn-btn" href="/n/${ctxPrev.id}${ctxFromQ}"><span class="pn-label">← prev</span>${context.currentIndex} of ${context.items.length}</a>`
           : `<span class="pn-btn disabled"><span class="pn-label">prev</span>—</span>`}
         ${ctxNext
           ? `<a class="pn-btn" href="/n/${ctxNext.id}${ctxFromQ}"><span class="pn-label">next →</span>${context.currentIndex + 2} of ${context.items.length}</a>`
           : `<span class="pn-btn disabled"><span class="pn-label">next</span>—</span>`}
       </div>`
    : totalInThread > 1
    ? `<div class="prev-next">
         ${prevSibling
           ? `<a class="pn-btn" href="/n/${prevSibling.id}"><span class="pn-label">← prev</span>v${myIdx}</a>`
           : `<span class="pn-btn disabled"><span class="pn-label">prev</span>—</span>`}
         ${nextSibling
           ? `<a class="pn-btn" href="/n/${nextSibling.id}"><span class="pn-label">next →</span>v${myIdx + 2}</a>`
           : `<span class="pn-btn disabled"><span class="pn-label">next</span>—</span>`}
       </div>`
    : "";

  const actionCard = note.is_final
    ? `<div class="action-card" style="background:var(--vorange-soft);color:var(--vorange);cursor:default">
         <div class="ac-lbl" style="color:var(--vorange)">Status</div>
         <div class="ac-title"><span class="ac-star">★</span> Final · preserved</div>
         <div class="ac-hint" style="color:var(--vmuted)">Excluded from auto-cleanup. Safely archived in this thread.</div>
       </div>`
    : `<form method="post" action="/api/notes/${note.id}/finalize" style="margin:0">
         <button class="action-card" type="submit">
           <span class="ac-lbl">Primary action</span>
           <span class="ac-title"><span class="ac-star">★</span> Mark as final</span>
           <span class="ac-hint">Stop auto-delete · archive as canonical version of the thread</span>
         </button>
       </form>`;

  // v0.29 — pin toggle. Lives right under the action-card. Pins float to
  // the top of the home list; pinned_at orders multiple pinned (freshly
  // pinned floats above long-pinned). Click → POST /metadata {is_pinned}.
  const pinToggle = `<button type="button" class="pin-toggle${note.is_pinned ? " on" : ""}" data-note-id="${esc(note.id)}" data-pinned="${note.is_pinned ? "1" : "0"}" aria-pressed="${note.is_pinned ? "true" : "false"}">
         <span class="pin-glyph">📌</span>
         <span class="pin-lbl">${note.is_pinned ? "Pinned to top" : "Pin to top"}</span>
         <span class="pin-hint">${note.is_pinned ? "click to unpin" : "click to pin"}</span>
       </button>`;

  // Tag editor — always present (zero-tags case shows just the +add input).
  // Each chip carries a tag-remove button; autocomplete suggestions come
  // from listPopularTags embedded in the inline editor script below.
  const tagChips = note.tags.map((t) =>
    `<span class="tag-chip" data-tag="${esc(t)}"><a class="tg" href="/tag/${encodeURIComponent(t)}">${esc(t)}</a><button type="button" class="tag-remove" data-tag="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`
  ).join("");
  const tagsHtml = `<dt>Tags</dt>
      <dd>
        <div class="tag-editor" data-note-id="${esc(note.id)}">
          ${tagChips}<div class="tag-add-wrap"><input class="tag-add-input" type="text" placeholder="+ add tag" autocomplete="off" spellcheck="false" maxlength="200"><div class="tag-suggest" hidden></div></div>
        </div>
      </dd>`;

  const tocHtml = `<nav class="toc" id="folio-toc" hidden><div class="toc-lbl">In this document</div><ol class="toc-list"></ol></nav>`;

  const themes = listThemes();
  const themeOptions = themes
    .map((t) => `<option value="${esc(t.name)}"${t.name === note.theme ? " selected" : ""}>${esc(t.name)}</option>`)
    .join("");
  const themeDd = `<dd class="theme-row"><select class="theme-switch" data-noteid="${esc(note.id)}" data-original="${esc(note.theme)}">${themeOptions}</select><a href="#" class="theme-save" data-note-id="${esc(note.id)}" hidden>✓ Save as default</a></dd>`;

  // Parent-side viewer chrome. The note lives in a null-origin iframe (since
  // v0.3+) so we cannot reach .contentDocument; instead the note's bootstrap
  // script publishes TOC / scroll / heading-spy events via postMessage and we
  // request content (plain/markdown) the same way for copy buttons.
  const noteScript = `<script>(function(){
    var iframe = document.querySelector('.note-iframe');
    var sel = document.querySelector('.theme-switch');
    var progressFill = document.querySelector('.reading-progress-fill');
    var toc = document.getElementById('folio-toc');
    var tocList = toc ? toc.querySelector('.toc-list') : null;
    var tocItems = []; // [{ id, li }]

    // Theme preview switcher + "Save as default" link (v0.22.2). The
    // dropdown still does preview-only on change (?theme=X URL param);
    // the link next to it appears whenever the dropdown value diverges
    // from the saved theme and persists via POST when clicked.
    var saveThemeLink = document.querySelector('.theme-save');
    if (sel && iframe) {
      sel.addEventListener('change', function(){
        var t = sel.value;
        var orig = sel.dataset.original;
        iframe.src = '/raw/' + sel.dataset.noteid + (t !== orig ? '?theme=' + encodeURIComponent(t) : '');
        if (saveThemeLink) saveThemeLink.hidden = (t === orig);
      });
      if (saveThemeLink) {
        saveThemeLink.addEventListener('click', function(e){
          e.preventDefault();
          var noteId = saveThemeLink.dataset.noteId;
          var t = sel.value;
          fetch('/api/notes/' + encodeURIComponent(noteId) + '/metadata', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ theme: t })
          }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok && d.ok, status: r.status, data: d }; }); })
            .then(function(resp){
              if (resp.ok) window.location.reload();
              else if (window.__folioToast) window.__folioToast('Save failed: ' + (resp.data.reason || resp.status), true);
            })
            .catch(function(err){
              if (window.__folioToast) window.__folioToast('Network error', true);
            });
        });
      }
    }

    // v0.29 — pin toggle. POST /metadata {is_pinned}, then flip the
    // button's visual state in place (no reload — the note page itself
    // doesn't show different content based on is_pinned, only the list
    // does). Optimistic UI: the click instantly flips, network failure
    // rolls back + toasts.
    var pinBtn = document.querySelector('.pin-toggle');
    if (pinBtn) {
      pinBtn.addEventListener('click', function(){
        var noteId = pinBtn.dataset.noteId;
        var currentlyPinned = pinBtn.dataset.pinned === '1';
        var nextPinned = !currentlyPinned;
        // Optimistic flip
        pinBtn.dataset.pinned = nextPinned ? '1' : '0';
        pinBtn.setAttribute('aria-pressed', nextPinned ? 'true' : 'false');
        pinBtn.classList.toggle('on', nextPinned);
        var lbl = pinBtn.querySelector('.pin-lbl');
        var hint = pinBtn.querySelector('.pin-hint');
        if (lbl) lbl.textContent = nextPinned ? 'Pinned to top' : 'Pin to top';
        if (hint) hint.textContent = nextPinned ? 'click to unpin' : 'click to pin';
        fetch('/api/notes/' + encodeURIComponent(noteId) + '/metadata', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ is_pinned: nextPinned })
        }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok && d.ok, status: r.status, data: d }; }); })
          .then(function(resp){
            if (!resp.ok) {
              // Rollback
              pinBtn.dataset.pinned = currentlyPinned ? '1' : '0';
              pinBtn.setAttribute('aria-pressed', currentlyPinned ? 'true' : 'false');
              pinBtn.classList.toggle('on', currentlyPinned);
              if (lbl) lbl.textContent = currentlyPinned ? 'Pinned to top' : 'Pin to top';
              if (hint) hint.textContent = currentlyPinned ? 'click to unpin' : 'click to pin';
              if (window.__folioToast) window.__folioToast('Pin failed: ' + (resp.data.reason || resp.status), true);
            } else if (window.__folioToast) {
              window.__folioToast(nextPinned ? '📌 Pinned to top' : 'Unpinned');
            }
          })
          .catch(function(){
            pinBtn.dataset.pinned = currentlyPinned ? '1' : '0';
            pinBtn.setAttribute('aria-pressed', currentlyPinned ? 'true' : 'false');
            pinBtn.classList.toggle('on', currentlyPinned);
            if (lbl) lbl.textContent = currentlyPinned ? 'Pinned to top' : 'Pin to top';
            if (hint) hint.textContent = currentlyPinned ? 'click to unpin' : 'click to pin';
            if (window.__folioToast) window.__folioToast('Network error', true);
          });
      });
    }

    function buildToc(items){
      if (!toc || !tocList) return;
      var visible = items.filter(function(i){ return i.level === 'h2' || i.level === 'h3'; });
      if (visible.length < 3) { toc.hidden = true; return; }
      tocList.innerHTML = '';
      tocItems = [];
      visible.forEach(function(it){
        var li = document.createElement('li');
        li.className = it.level;
        li.dataset.targetId = it.id;
        var a = document.createElement('a');
        a.textContent = it.text;
        a.addEventListener('click', function(e){
          e.preventDefault();
          postToIframe({ type: 'scroll-to', id: it.id });
        });
        li.appendChild(a);
        tocList.appendChild(li);
        tocItems.push({ id: it.id, li: li });
      });
      toc.hidden = false;
    }

    function setActiveHeading(id){
      tocItems.forEach(function(it){
        if (it.id === id) it.li.classList.add('active');
        else it.li.classList.remove('active');
      });
    }

    function postToIframe(msg){
      try { iframe && iframe.contentWindow && iframe.contentWindow.postMessage(Object.assign({ ns: 'folio' }, msg), '*'); } catch(_){}
    }

    // Pending copy requests: requestId -> { resolve, reject, timer }
    var pending = new Map();
    var nextReqId = 1;
    function requestContent(){
      var id = String(nextReqId++);
      return new Promise(function(resolve, reject){
        var timer = setTimeout(function(){
          pending.delete(id);
          reject(new Error('content-timeout'));
        }, 2000);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        postToIframe({ type: 'request-content', requestId: id });
      });
    }
    // Receive messages from the note's bootstrap (runs inside the iframe)
    window.addEventListener('message', function(e){
      var d = e.data; if (!d || d.ns !== 'folio') return;
      // Optional source check: only accept from our iframe's window
      if (iframe && e.source && e.source !== iframe.contentWindow) return;
      switch (d.type) {
        case 'ready':
          // Tell the note our parent URL so anchor-copy builds a clipboard URL
          // that opens the viewer page (with the hash) rather than /raw/.
          postToIframe({ type: 'set-parent-url', url: window.location.href });
          break;
        case 'toc':
          buildToc(Array.isArray(d.items) ? d.items : []);
          break;
        case 'heading':
          if (d.id) setActiveHeading(String(d.id));
          break;
        case 'scroll':
          if (progressFill) progressFill.style.width = Math.max(0, Math.min(100, Number(d.pct) || 0)) + '%';
          break;
        case 'navigate': {
          // Internal Folio link clicked inside the body iframe (relayed by
          // note-bootstrap, since the sandbox has no allow-top-navigation).
          // Navigate the TOP viewer page — kills the "Folio-in-Folio" nesting.
          // Guard: only same-origin internal paths, never //host or javascript:.
          var nhref = String(d.href || '');
          if (/^\\/(n|p|t|tag|threads)(\\/|\$|[?#])/.test(nhref)) window.location.assign(nhref);
          break;
        }
        case 'content': {
          var p = pending.get(String(d.requestId));
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(String(d.requestId));
          p.resolve({ plain: String(d.plain || ''), markdown: String(d.markdown || '') });
          break;
        }
        case 'iteration-pick': {
          // v0.18+: iteration variant clicked inside the body iframe.
          // Iframe runs in null-origin sandbox with connect-src 'none', so it
          // cannot fetch the API itself — we relay the pick from the parent.
          var vid = d.variant_id; var nid = d.note_id;
          if (!vid || !nid) return;
          fetch('/api/notes/' + encodeURIComponent(nid) + '/iter/pick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ variant_id: vid })
          }).then(function(r){
            if (!r.ok) return r.json().then(function(j){ throw new Error(j.error || 'pick failed'); });
            // Force a full iframe reload so the gallery re-renders with
            // sibling variants greyed out and the picked one styled.
            // Cache-buster prevents any stale response.
            if (iframe) iframe.src = '/raw/' + encodeURIComponent(nid) + '?t=' + Date.now();
          }).catch(function(err){
            console.error('[folio] iteration pick failed:', err && err.message ? err.message : err);
          });
          break;
        }
      }
    });

    // Copy buttons — ask the iframe over postMessage instead of reading its DOM
    document.querySelectorAll('[data-copy]').forEach(function(btn){
      btn.addEventListener('click', function(e){
        e.preventDefault();
        var mode = btn.dataset.copy;
        var orig = btn.dataset.label;
        requestContent().then(function(content){
          var text = mode === 'markdown' ? content.markdown : content.plain;
          return navigator.clipboard.writeText(text);
        }).then(function(){
          btn.textContent = '✓ copied';
          btn.classList.add('copied');
          setTimeout(function(){ btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
        }).catch(function(){
          btn.textContent = '✗ error';
          setTimeout(function(){ btn.textContent = orig; }, 1500);
        });
      });
    });

    // Print button — ask the iframe to print itself. We can't call
    // iframe.contentWindow.print() from here because the iframe is null-
    // origin (no allow-same-origin); cross-origin restriction blocks it.
    // Going through the iframe's own window.print() means the print job
    // contains JUST the note body in its theme — no viewer chrome,
    // sidebar, or topbar leaking into the printed page.
    (function(){
      var pbtn = document.getElementById('folio-print-btn');
      if (!pbtn || !iframe) return;
      pbtn.addEventListener('click', function(){
        try {
          iframe.contentWindow.postMessage({ ns: 'folio', type: 'print' }, '*');
        } catch(_){}
      });
    })();

    // Delete button — two-step inline confirmation (no modal dialog). First
    // click flips label + colour; second click within 5s POSTs the delete
    // and navigates to the thread index. Resets if the user mouses away or
    // 5s elapse, so a stray double-tap can't fire it.
    (function(){
      var btn = document.getElementById('folio-delete-btn');
      if (!btn) return;
      var armedTimer = 0;
      var armed = false;
      function disarm(){
        armed = false;
        btn.classList.remove('confirming');
        btn.textContent = btn.dataset.defaultLabel || '✕ Delete note';
        if (armedTimer) { clearTimeout(armedTimer); armedTimer = 0; }
      }
      btn.addEventListener('click', function(){
        if (!armed) {
          armed = true;
          btn.classList.add('confirming');
          btn.textContent = btn.dataset.confirmLabel || '✕ Click again to confirm';
          armedTimer = setTimeout(disarm, 5000);
          return;
        }
        var id = btn.dataset.noteId;
        var thread = btn.dataset.threadId;
        btn.disabled = true;
        btn.textContent = '… deleting';
        fetch('/api/notes/' + encodeURIComponent(id) + '/delete', {
          method: 'POST',
          headers: { 'X-Folio-Thread': '/t/' + thread },
        }).then(function(r){
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function(body){
          window.location.href = body.thread_redirect || ('/t/' + thread);
        }).catch(function(e){
          btn.disabled = false;
          btn.classList.remove('confirming');
          btn.textContent = '✗ error: ' + e.message;
          setTimeout(disarm, 2500);
        });
      });
      btn.addEventListener('mouseleave', function(){
        if (armed) disarm();
      });
    })();

    // ─── Hand off to agent (v0.21.1+) ─────────────────────────────────
    // Click → copy a minimal note reference to clipboard. User pastes
    // into their agent chat. Payload is intentionally short — agents with
    // Folio MCP can call folio.get to pull the full body; the URL is
    // the universal fallback for anyone else. No deep links, no per-host
    // URL schemes; just structured text that works in any chat surface.
    (function(){
      var ho = document.getElementById('folio-handoff-btn');
      if (!ho) return;
      ho.addEventListener('click', function(){
        var id = ho.dataset.noteId;
        var title = ho.dataset.noteTitle;
        var thread = ho.dataset.threadId;
        var type = ho.dataset.noteType;
        var origin = window.location.origin;
        var payload = [
          'Folio note: ' + origin + '/n/' + id,
          'Title: ' + title,
          'Thread: ' + thread,
          'Type: ' + type,
          '',
          'Please continue work on this Folio note.',
          'If you have folio MCP installed, call \`folio.get\` to load the full body.',
          'What should we do next?',
        ].join('\\n');
        var prev = ho.dataset.defaultLabel || '↗ Hand off to agent';
        navigator.clipboard.writeText(payload).then(function(){
          ho.textContent = '✓ Copied — paste into your agent chat';
          ho.classList.add('copied');
          setTimeout(function(){
            ho.textContent = prev;
            ho.classList.remove('copied');
          }, 1800);
        }).catch(function(){
          ho.textContent = '✗ copy failed (clipboard denied)';
          setTimeout(function(){
            ho.textContent = prev;
          }, 1800);
        });
      });
    })();
  })();</script>`;

  // Live notes: inject a side panel iframe with the compiled feed plus
  // a chrome-side EventSource subscriber. Panel iframe is sandboxed and
  // null-origin (no allow-same-origin); chrome and panel talk via
  // postMessage. Body iframe is unchanged — its CSP stays connect-src:'none'.
  // Render mode is the single source of truth for the live/iteration/static
  // branch (core/note-log.ts renderModeOf). v0.17 inline_render: live-inline
  // splices entries into body_html at /raw/ time + forwards SSE entries to
  // the body iframe; live-panel keeps the side-panel feed; finalized
  // feed/iteration notes collapse to a plain document (static body).
  const mode = renderModeOf(note);
  let livePanelHtml = "";
  let liveScript = "";
  if (mode === "live-panel") {
    const themeCss = loadThemeCss(note.theme) ?? "";
    const srcdoc = panelIframeSrcdoc({ theme_css: themeCss, entries_css: ENTRIES_CSS, noteId: note.id });
    livePanelHtml = `
  <aside class="live-panel" aria-label="Live entries feed">
    <iframe class="live-panel-iframe" title="Live feed" sandbox="allow-scripts" srcdoc="${esc(srcdoc)}"></iframe>
  </aside>`;
    liveScript = `<script>window.__folioLiveNoteId = ${JSON.stringify(note.id)};</script>${LIVE_CHROME_JS}`;
  } else if (mode === "live-inline") {
    // Parent chrome opens the same SSE stream the panel would, but instead
    // of postMessage'ing into a side-panel iframe, it postMessage's into
    // the body iframe. The body iframe's bootstrap (appended in /raw/)
    // listens and appends entries to <section data-folio-live-feed>.
    liveScript = `<script>(function(){
      var noteId = ${JSON.stringify(note.id)};
      var bodyFrame = document.querySelector(".note-iframe");
      if (!bodyFrame) return;
      function sendToBody(payload){
        try { bodyFrame.contentWindow && bodyFrame.contentWindow.postMessage(payload, "*"); } catch (_e) {}
      }
      // Open SSE. EventSource auto-retries on transient hiccups.
      var ev = new EventSource("/n/" + encodeURIComponent(noteId) + "/stream");
      var queued = [];
      var ready = false;
      ev.addEventListener("entry", function(e){
        try {
          var entry = JSON.parse(e.data);
          var payload = { ns: "folio", type: "entry", entry: entry };
          if (ready) sendToBody(payload);
          else queued.push(payload);
        } catch (_err) {}
      });
      window.addEventListener("message", function(ev){
        var d = ev.data;
        if (!d) return;
        if (d.ns === "folio" && d.type === "inline-feed-ready") {
          ready = true;
          for (var i = 0; i < queued.length; i++) sendToBody(queued[i]);
          queued.length = 0;
          return;
        }
        // v0.27 — kanban view inside the body iframe posts move intents up
        // ('folio-feed' namespace shared with panel mode). Forward to the
        // entries endpoint; SSE re-delivers the new entry so both feed
        // and kanban views re-render via the existing append path.
        if (d.ns === "folio-feed" && d.type === "move" && d.entry_id && d.state) {
          fetch("/api/notes/" + encodeURIComponent(noteId) + "/entries", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content_html: "",
              tags: ["state:" + d.state],
              refs: [d.entry_id],
            }),
          }).catch(function () { /* SSE reconnect recovers */ });
        }
      });
    })();</script>`;
  } else if (mode === "iteration-gallery") {
    // Iteration notes auto-refresh the gallery when the agent appends a new
    // round (v0.20.2+). SSE delivers every entry on the JSONL substrate; we
    // reload the body iframe only on `kind:variant` entries — those mean a
    // new round just landed. `kind:pick` entries already trigger reload via
    // the existing postMessage path (variant card click → POST iter/pick →
    // iframe reload), so skipping pick here avoids a redundant second reload.
    //
    // Backlog entries (initial backfill on the SSE connect) are skipped
    // too: we tag the first batch, ignore until the connection has been
    // open for one tick. Otherwise opening the page would always reload
    // it once on first paint.
    liveScript = `<script>(function(){
      var noteId = ${JSON.stringify(note.id)};
      var bodyFrame = document.querySelector(".note-iframe");
      if (!bodyFrame) return;
      var skipBacklog = true;
      // Mark the backlog window as closed once the event loop has a chance
      // to drain the initial flood from the SSE connection open.
      setTimeout(function(){ skipBacklog = false; }, 250);
      var ev = new EventSource("/n/" + encodeURIComponent(noteId) + "/stream");
      ev.addEventListener("entry", function(e){
        if (skipBacklog) return;
        try {
          var entry = JSON.parse(e.data);
          var tags = entry && entry.tags;
          if (!tags || !tags.includes("kind:variant")) return;
          // New round landed — refresh the gallery via cache-buster.
          bodyFrame.src = "/raw/" + encodeURIComponent(noteId) + "?t=" + Date.now();
        } catch (_err) {}
      });
    })();</script>`;
  }
  const shellClass = mode === "live-panel" ? "note-shell has-live" : "note-shell";
  const sharePop = sharePopoverHtml(note.id);

  return shell(note.title, `${topbar()}
${SHARE_POPOVER_CSS}
<div class="reading-progress"><div class="reading-progress-fill"></div></div>
<div class="${shellClass}">
  <aside class="note-side">
    <button class="side-toggle" type="button" data-folio-side-toggle aria-label="Collapse sidebar" aria-expanded="true" title="Toggle sidebar">‹</button>
    <div class="side-content">
    <a href="${fromHref}" class="back">${fromLabel}</a>
    <span class="type-pill ${note.type}">${note.type}</span>
    <h1 class="editable-title" data-note-id="${esc(note.id)}" tabindex="0" title="Click to edit">${esc(note.title)}</h1>
    ${actionCard}
    ${pinToggle}
    ${prevNextHtml}
    ${revisionsHtml}
    ${tocHtml}
    <dl class="side-meta">
      <dt>Thread</dt><dd class="thread"><a href="/t/${esc(note.thread_id)}">${esc(note.thread_id)}</a></dd>
      <dt>Status</dt><dd class="${note.is_final ? "final" : "warn"}">${note.is_final ? "★ final" : (expiring ? `⏱ expires in ${expiring}` : "active")}</dd>
      <dt>Created</dt><dd>${ago(note.created)}</dd>
      <dt>${context ? `In ${context.kind}` : "Version"}</dt><dd>${context ? `${context.currentIndex + 1} of ${context.items.length}` : `v${version} of ${totalInThread}`}</dd>
      <dt>Words</dt><dd>${note.word_count} · ~${readingMin} min</dd>
      <dt>Theme</dt>${themeDd}
      <dt>Profile</dt><dd>${esc(note.theme_profile)}</dd>
      ${tagsHtml}
    </dl>
    <nav class="side-aux">
      <button class="side-action" data-copy="plain" data-label="⎘ Copy plain text">⎘ Copy plain text</button>
      <button class="side-action" data-copy="markdown" data-label="⎘ Copy as markdown">⎘ Copy as markdown</button>
      <a href="/raw/${note.id}" target="_blank">↗ View raw HTML</a>
      <button class="side-action" id="folio-print-btn" type="button">↗ Print / PDF</button>
      <a href="#" id="share-trigger" class="side-action" data-note-id="${esc(note.id)}" title="Share publicly via capability URL">↗ Share publicly<span class="active-dot" id="share-active-dot" hidden></span></a>
      <button class="side-action" id="folio-handoff-btn" type="button"
              data-note-id="${esc(note.id)}"
              data-note-title="${esc(note.title)}"
              data-thread-id="${esc(note.thread_id)}"
              data-note-type="${esc(note.type)}"
              data-default-label="↗ Hand off to agent"
              title="Copy a reference to this note for pasting into an agent chat">↗ Hand off to agent</button>
      <button class="side-action danger" id="folio-delete-btn"
              data-note-id="${esc(note.id)}"
              data-thread-id="${esc(note.thread_id)}"
              data-default-label="✕ Delete note"
              data-confirm-label="✕ Click again to confirm">✕ Delete note</button>
    </nav>
    </div>
  </aside>
  <main class="note-main">
    ${supersedeBanner}${banner}
    <div class="note-iframe-wrap">
      <iframe class="note-iframe" src="/raw/${note.id}" title="${esc(note.title)}" sandbox="allow-scripts allow-popups allow-forms allow-modals" allow="fullscreen"></iframe>
    </div>
  </main>${livePanelHtml}
</div>
${sharePop}
${noteScript}${liveScript}
<script>${sharePopoverJs(note.id)}</script>
<script>${inlineMetadataEditorJs(note.id)}</script>
<script>
(function () {
  var STORAGE_KEY = "folio-side-collapsed";
  var COLLAPSE_AT = 1280;
  var shell = document.querySelector(".note-shell");
  if (!shell) return;
  var btn = shell.querySelector("[data-folio-side-toggle]");
  function readSaved() { try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; } }
  function updateBtn() {
    if (!btn) return;
    var isCollapsed = shell.classList.contains("is-side-collapsed");
    btn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    btn.setAttribute("aria-label", isCollapsed ? "Expand sidebar" : "Collapse sidebar");
  }
  // Initial state: we only persist an explicit COLLAPSED preference ("1"),
  // never an explicit-expanded one — that way clicking "expand" simply clears
  // the pref, so a smaller screen auto-collapses again on the next load
  // instead of being pinned open from an earlier session. No pref → media
  // query default. A legacy "0" left over from older versions is treated as
  // no-pref and actively cleared so the resize listener can fire again.
  var saved = readSaved();
  if (saved === "0") { try { localStorage.removeItem(STORAGE_KEY); } catch (_) {} saved = null; }
  var collapsed = saved === "1" ? true
                : window.matchMedia("(max-width: " + COLLAPSE_AT + "px)").matches;
  if (collapsed) {
    // Suppress transition for the initial paint so it doesn't animate from the
    // default expanded state on every page load.
    shell.classList.add("no-anim", "is-side-collapsed");
    void shell.offsetWidth;
    shell.classList.remove("no-anim");
  }
  updateBtn();
  // Toggle click — record the explicit user preference.
  shell.addEventListener("click", function (e) {
    var b = e.target && e.target.closest && e.target.closest("[data-folio-side-toggle]");
    if (!b) return;
    var nowCollapsed = !shell.classList.contains("is-side-collapsed");
    shell.classList.toggle("is-side-collapsed", nowCollapsed);
    try {
      // Collapse = explicit pref. Expand = clear pref (so auto-collapse
      // can fire again on a smaller screen).
      if (nowCollapsed) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    updateBtn();
  });
  // Resize — re-evaluate the auto-collapse default when the user hasn't pinned
  // a preference, so dragging across the breakpoint doesn't strand them with a
  // sidebar that suddenly dominates the viewport. Debounced.
  var rt = null;
  window.addEventListener("resize", function () {
    if (rt) clearTimeout(rt);
    rt = setTimeout(function () {
      if (readSaved() != null) return;
      var should = window.matchMedia("(max-width: " + COLLAPSE_AT + "px)").matches;
      var is = shell.classList.contains("is-side-collapsed");
      if (should !== is) {
        shell.classList.toggle("is-side-collapsed", should);
        updateBtn();
      }
    }, 120);
  });
})();
</script>`, { bodyClass: "note-page" });
}

// ───────────────────────────────────────────────────────────────────────
// Manage shares page (/n/:id/shares, v0.19+) — full list of capability URL
// shares for a single note. Reached from the popover's "manage →" link.
// ───────────────────────────────────────────────────────────────────────

export interface SharePickRow {
  note_uuid: string;
  variant: string;
  label: string | null;
  picked_at: string;
  pick_count: number;
}

export interface ShareRow {
  token: string;
  url: string;
  created_at: string;
  expires_at: string | null;
  max_views: number | null;
  view_count: number;
  recipient_email_hash?: string | null;
  allow_pick?: boolean;
  picks?: SharePickRow[];
}

export function pageShares(note: NoteMeta, shares: ShareRow[], paired: boolean): string {
  const css = `<style>
.shares-page { max-width: 920px; margin: 30px auto; padding: 0 28px; }
.shares-page__head { margin-bottom: 24px; }
.shares-page__eyebrow { font-family: var(--vmono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--vmuted); margin-bottom: 8px; }
.shares-page__eyebrow a { color: var(--vorange); border-bottom: 1px solid currentColor; }
.shares-page__title { font-family: var(--vhead); font-weight: 500; font-size: clamp(26px, 3vw, 34px); letter-spacing: -0.02em; margin: 0 0 8px; line-height: 1.1; }
.shares-page__sub { font-family: var(--vserif); font-style: italic; font-size: 16px; color: var(--vmuted); margin: 0; }
.shares-list { display: flex; flex-direction: column; gap: 14px; margin-top: 28px; }
.share-card { background: var(--vpanel); border: 1px solid var(--vline); border-radius: 10px; padding: 18px 20px; }
.share-card__url { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.share-card__url-text { flex: 1; font-family: var(--vmono); font-size: 12.5px; color: var(--vorange); word-break: break-all; line-height: 1.5; }
.share-card__copy { padding: 5px 11px; border: 1px solid var(--vline); background: var(--vbg); color: inherit; border-radius: 5px; font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; flex-shrink: 0; }
.share-card__copy:hover { background: var(--vbg-2); }
.share-card__copy.copied { color: #2f9050; border-color: #2f9050; }
.share-card__meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px 22px; padding: 12px 0; border-top: 1px solid var(--vline-2); border-bottom: 1px solid var(--vline-2); margin-bottom: 14px; }
.share-card__meta dt { font-family: var(--vmono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--vmuted); margin-bottom: 3px; }
.share-card__meta dd { margin: 0; font-family: var(--vmono); font-size: 12px; color: var(--vink-2); }
.share-card__meta dd.expired { color: #c8412a; }
.share-card__actions { display: flex; justify-content: flex-end; }
.share-card__revoke { padding: 6px 14px; border: 1px solid var(--vline); background: transparent; color: #c8412a; border-radius: 6px; font-family: var(--vmono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; }
.share-card__revoke:hover { background: rgba(200,65,42,0.06); border-color: #c8412a; }
.share-card__revoke:disabled { opacity: 0.5; cursor: wait; }
.shares-empty { text-align: center; padding: 60px 20px; color: var(--vmuted); }
.shares-empty p { font-family: var(--vserif); font-style: italic; font-size: 17px; line-height: 1.5; margin: 0 0 16px; }
.shares-empty a { color: var(--vorange); font-family: var(--vhead); font-weight: 500; font-size: 14px; border-bottom: 1px solid currentColor; }
.shares-not-paired { padding: 20px 24px; background: rgba(255,90,31,0.06); border: 1px solid rgba(255,90,31,0.18); border-radius: 10px; }
.shares-not-paired h3 { font-family: var(--vhead); margin: 0 0 6px; font-size: 16px; font-weight: 500; }
.shares-not-paired p { font-family: var(--vserif); font-style: italic; color: var(--vmuted); margin: 0 0 12px; }
.shares-not-paired a { color: var(--vorange); font-family: var(--vmono); font-size: 12px; border-bottom: 1px solid currentColor; }
.share-card__picks { margin: 0 0 14px; display: flex; flex-direction: column; gap: 8px; }
.share-card__pick { display: flex; align-items: baseline; gap: 8px; padding: 10px 12px; background: rgba(47,144,80,0.07); border: 1px solid rgba(47,144,80,0.28); border-radius: 8px; font-family: var(--vmono); font-size: 12.5px; color: var(--vink-2); }
.share-card__pick-dot { color: #2f9050; }
.share-card__pick strong { font-family: var(--vhead); font-weight: 600; color: var(--vink); }
.share-card__pick-meta { margin-left: auto; color: var(--vmuted); font-size: 11px; }
.share-card__picks--empty { padding: 10px 12px; background: var(--vbg-2); border: 1px dashed var(--vline); border-radius: 8px; font-family: var(--vserif); font-style: italic; font-size: 13px; color: var(--vmuted); }
</style>`;

  const escAttr = (s: string) => esc(s);
  const fmtDate = (iso: string | null): string => {
    if (!iso) return "never";
    return new Date(iso).toISOString().slice(0, 10);
  };
  const isExpired = (iso: string | null): boolean => {
    if (!iso) return false;
    return new Date(iso).getTime() < Date.now();
  };

  const cards = shares.map((s) => {
    const exp = fmtDate(s.expires_at);
    const expCls = isExpired(s.expires_at) ? " expired" : "";
    const views = s.max_views !== null ? `${s.view_count} / ${s.max_views}` : `${s.view_count} / ∞`;
    const recipient = s.recipient_email_hash ? `<dt>Recipient</dt><dd title="${escAttr(s.recipient_email_hash)}">${escAttr(s.recipient_email_hash.slice(0, 12))}…</dd>` : "";
    const pickMeta = s.allow_pick ? `<div><dt>Picking</dt><dd>enabled</dd></div>` : "";
    const picks = s.picks ?? [];
    const pickBanner = picks.length
      ? `<div class="share-card__picks">${picks
          .map(
            (p) =>
              `<div class="share-card__pick"><span class="share-card__pick-dot">◆</span> Client picked <strong>${escAttr(p.label || p.variant)}</strong><span class="share-card__pick-meta">${escAttr(fmtDate(p.picked_at))}${p.pick_count > 1 ? ` · changed ${p.pick_count}×` : ""}</span></div>`
          )
          .join("")}</div>`
      : s.allow_pick
        ? `<div class="share-card__picks share-card__picks--empty">Waiting for the recipient to pick…</div>`
        : "";
    return `<article class="share-card" data-token="${escAttr(s.token)}">
  <div class="share-card__url">
    <span class="share-card__url-text">${escAttr(s.url)}</span>
    <button type="button" class="share-card__copy" data-url="${escAttr(s.url)}">Copy</button>
  </div>
  <dl class="share-card__meta">
    <div><dt>Created</dt><dd>${escAttr(fmtDate(s.created_at))}</dd></div>
    <div><dt>Expires</dt><dd class="${expCls.trim()}">${escAttr(exp)}</dd></div>
    <div><dt>Views</dt><dd>${escAttr(views)}</dd></div>
    ${pickMeta}
    ${recipient ? `<div>${recipient}</div>` : ""}
  </dl>
  ${pickBanner}
  <div class="share-card__actions">
    <button type="button" class="share-card__revoke" data-token="${escAttr(s.token)}">Revoke</button>
  </div>
</article>`;
  }).join("\n");

  let listSection: string;
  if (!paired) {
    listSection = `<div class="shares-not-paired">
  <h3>Cloud not paired</h3>
  <p>Capability URLs are minted by the cloud relay. Pair this device to a Folio cloud first.</p>
  <a href="/cloud">↗ Pair a cloud</a>
</div>`;
  } else if (shares.length === 0) {
    listSection = `<div class="shares-empty">
  <p>No active shares yet — go back to the note and click<br><strong>↗ Share</strong> in the topbar to create one.</p>
  <a href="/n/${escAttr(note.id)}">← Back to note</a>
</div>`;
  } else {
    listSection = `<div class="shares-list">${cards}</div>`;
  }

  const script = `<script>(function () {
  var noteId = ${JSON.stringify(note.id)};
  document.querySelectorAll('.share-card__copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(btn.dataset.url).then(function () {
        var prev = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = prev; btn.classList.remove('copied'); }, 1400);
      });
    });
  });
  document.querySelectorAll('.share-card__revoke').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!window.confirm('Revoke this share? URL will stop working immediately.')) return;
      var token = btn.dataset.token;
      btn.disabled = true;
      btn.textContent = 'Revoking…';
      fetch('/api/notes/' + encodeURIComponent(noteId) + '/shares/' + encodeURIComponent(token), { method: 'DELETE' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          // Remove the card from DOM. If list becomes empty, reload to show empty state.
          var card = btn.closest('.share-card');
          if (card) card.remove();
          if (document.querySelectorAll('.share-card').length === 0) window.location.reload();
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Revoke';
          alert('Revoke failed: ' + (err && err.message ? err.message : err));
        });
    });
  });
})();</script>`;

  const body = `${css}
<main class="shares-page">
  <div class="shares-page__head">
    <div class="shares-page__eyebrow"><a href="/n/${escAttr(note.id)}">← Back to note</a></div>
    <h1 class="shares-page__title">Shares · ${esc(note.title)}</h1>
    <p class="shares-page__sub">Active capability URLs for this note.</p>
  </div>
  ${listSection}
</main>
${script}`;

  return shell(`Shares · ${note.title}`, `${topbar()}${body}`);
}

export function pageStats(s: any): string {
  return shell("Stats", `${topbar("", "stats")}
<main class="v-page">
  <div class="group">
    <div class="group-lbl">System state <span class="count">· live</span></div>
    <div style="padding: 8px 4px 20px;">
      <h1 style="font-family: var(--vhead); font-weight: 500; font-size: clamp(28px, 3.6vw, 40px); letter-spacing: -0.025em; margin: 0 0 6px; line-height: 1.1;">Stats</h1>
      <div style="font-family: var(--vserif); font-style: italic; font-size: 18px; color: var(--vmuted); margin-bottom: 12px;">What Folio knows about itself.</div>
      <div style="font-family: var(--vmono); font-size: 11px; letter-spacing: 0.06em; color: var(--vmuted-2); display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--vbg-2); border: 1px solid var(--vline-2); border-radius: 6px;">
        <span style="color: var(--vorange); font-weight: 600;">●</span> folio
        <span style="color: var(--vink); font-weight: 600;">v${esc(pkg.version)}</span>
        · ${esc(pkg.name)}
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-cell"><div class="n acc">${s.total}</div><div class="lbl">Total</div></div>
      <div class="stat-cell"><div class="n good">${s.final}</div><div class="lbl">★ Final</div></div>
      <div class="stat-cell"><div class="n mid">${s.expiring_7d}</div><div class="lbl">Expiring 7d</div></div>
      <div class="stat-cell"><div class="n">${s.threads}</div><div class="lbl">Threads</div></div>
    </div>
  </div>

  <div class="group">
    <div class="group-lbl">By type</div>
    <div class="rows">
      ${s.by_type.map((t: any) => `<div class="row" style="cursor:default"><span class="type ${t.type}">${t.type}</span><div><span class="title" style="font-size:15px">${t.type}</span></div><span class="age">${t.n}</span><span class="stat">·</span></div>`).join("")}
    </div>
  </div>

  <div class="group">
    <div class="group-lbl">Analytics <span class="count">· ADR-017</span></div>
    <div style="padding: 8px 4px; font-family: var(--vmono); font-size: 13px; color: var(--vink-2); line-height: 1.8;">
      <div>Class match rate: <strong>${s.analytics.avg_class_match == null ? "—" : (s.analytics.avg_class_match * 100).toFixed(1) + "%"}</strong></div>
      <div>Logged events: <strong>${s.analytics.total_events}</strong></div>
    </div>
  </div>
</main>`);
}

function shell(title: string, body: string, opts: { bodyClass?: string } = {}): string {
  const bodyAttr = opts.bodyClass ? ` class="${opts.bodyClass}"` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Folio</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/favicon.svg"><style>${VIEWER_CSS}</style></head><body${bodyAttr}>${body}${KBD_SHORTCUT_JS}</body></html>`;
}

export interface CloudPageState {
  paired: boolean;
  remote?: string | null;
  device_id?: string;
  device_name?: string;
  last_pushed_at?: string | null;
  last_pulled_seq?: number;
  live_notes_tracked?: number;
}

/**
 * Sync + cloud pairing surface for the local viewer. Renders one of two
 * modes:
 *   • Not paired: form to enter the cloud URL + a 6-digit pairing code
 *     (bound to the box key: `notibox-folio-cloud enable`, sc-24120).
 *   • Paired:    status (remote, device id, last sync, etc.) plus action
 *     buttons (sync now, unpair).
 *
 * All state mutations go through local-only `/api/sync/*` endpoints — the
 * page never holds the cloud bearer token in JS or DOM, it lives in
 * ~/Folio/.sync-state.json and is touched only by the local server.
 */
export function pageCloud(state: CloudPageState): string {
  const body = state.paired ? cloudPairedBody(state) : cloudUnpairedBody();
  return shell("Cloud · Folio", `${topbar("", "cloud")}
<main class="v-page">
  <div class="group">
    <div class="group-lbl">Cloud sync${state.paired ? '<span class="count">· paired</span>' : '<span class="count">· not paired</span>'}</div>
    <div style="padding: 8px 4px 20px;">
      <h1 style="font-family: var(--vhead); font-weight: 500; font-size: clamp(28px, 3.6vw, 40px); letter-spacing: -0.025em; margin: 0 0 6px; line-height: 1.1;">Cloud sync</h1>
      <div style="font-family: var(--vserif); font-style: italic; font-size: 18px; color: var(--vmuted); margin-bottom: 24px;">Mirror your notes to a relay so phone/PWA and capability URL recipients can read them.</div>
    </div>
    ${body}
  </div>
</main>${cloudScript()}`);
}

function cloudUnpairedBody(): string {
  return `<div class="cloud-card">
    <h3>Pair this device</h3>
    <p class="lead">
      Only a NotiBox box pairs, with a code bound to its key. The box gets one
      through <code class="cloud-code">notibox-folio-cloud enable</code>; phone and browser pairing was removed.
    </p>
    <form id="pair-form" autocomplete="off">
      <label>Cloud URL
        <input id="cloud-remote" type="url" name="remote" placeholder="https://folio.example.com" required autocomplete="off">
      </label>
      <label>Pairing code
        <input id="cloud-code" type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="######" required autocomplete="off">
      </label>
      <label>Device name <span class="hint">(optional — defaults to hostname)</span>
        <input id="cloud-name" type="text" name="device_name" autocomplete="off">
      </label>
      <button type="submit" class="primary">Pair device</button>
      <div id="pair-err" class="err"></div>
    </form>
  </div>`;
}

function cloudPairedBody(state: CloudPageState): string {
  const remoteHost = state.remote ? new URL(state.remote).host : "?";
  return `<div class="cloud-card">
    <h3>Paired with <a href="${esc(state.remote ?? "#")}" target="_blank">${esc(remoteHost)}</a></h3>
    <dl class="cloud-meta">
      <dt>Device</dt><dd>${esc(state.device_name ?? "")} <span class="dim">${esc((state.device_id ?? "").slice(0, 12))}…</span></dd>
      <dt>Last push</dt><dd>${state.last_pushed_at ? esc(state.last_pushed_at) : '<span class="dim">never</span>'}</dd>
      <dt>Pull cursor</dt><dd>${state.last_pulled_seq ?? 0}</dd>
      <dt>Live notes tracked</dt><dd>${state.live_notes_tracked ?? 0}</dd>
    </dl>
    <div class="cloud-actions">
      <button id="sync-now-btn" class="primary">↻ Sync now</button>
      <button id="unpair-btn" class="danger">Unpair this device</button>
    </div>
    <div id="sync-result"></div>
    <div id="cloud-err" class="err"></div>
  </div>
  <div class="cloud-card cloud-stats-card">
    <h3>Cloud stats <button id="stats-refresh" class="copy" type="button" title="Refresh">↻</button></h3>
    <div id="cloud-stats-body" class="stats-body">
      <div class="stats-loading">Loading…</div>
    </div>
  </div>
  <div id="operator-card" class="cloud-card operator-card" hidden>
    <h3>
      <span class="op-badge">Operator</span>
      Cloud accounts
      <button id="add-user-btn" class="primary" type="button" style="margin-left:auto; font-size:12px; padding:6px 12px;">+ Add user</button>
    </h3>
    <div id="add-user-form" class="add-user-form" hidden></div>
    <div id="op-users-table"></div>
    <div id="op-detail" hidden></div>
    <div id="op-err" class="err"></div>
  </div>`;
}

function cloudScript(): string {
  return `<style>
  .cloud-card { background: var(--vpanel); border: 1px solid var(--vline); border-radius: 12px; padding: 22px 24px; max-width: 640px; margin: 0 auto 24px; }
  .cloud-card h3 { margin: 0 0 12px; font-family: var(--vhead); font-weight: 500; font-size: 20px; letter-spacing: -0.01em; }
  .cloud-card h3 a { color: var(--vorange); text-decoration: none; border-bottom: 1px solid currentColor; }
  .cloud-card .lead { color: var(--vmuted); font-size: 14px; line-height: 1.55; margin: 0 0 22px; }
  .cloud-card .cloud-code { display: block; background: var(--vbg-2); padding: 8px 12px; border-radius: 6px; font-family: var(--vmono); font-size: 12px; margin: 8px 0; user-select: all; }
  .cloud-card form label { display: block; margin-bottom: 14px; font-family: var(--vmono); font-size: 11px; color: var(--vmuted); letter-spacing: 0.06em; text-transform: uppercase; }
  .cloud-card form label .hint { text-transform: none; letter-spacing: 0; }
  .cloud-card form input { display: block; width: 100%; margin-top: 5px; padding: 10px 12px; font-size: 14px; border: 1px solid var(--vline); border-radius: 7px; background: var(--vbg); font-family: inherit; color: var(--vink); -webkit-appearance: none; }
  .cloud-card form input:focus { outline: 0; border-color: var(--vorange); box-shadow: 0 0 0 3px var(--vorange-soft); }
  .cloud-card form input#cloud-code { font-family: var(--vmono); font-size: 18px; letter-spacing: 4px; text-align: center; }
  .cloud-card button { padding: 10px 14px; font-size: 13px; font-family: var(--vhead); font-weight: 500; border: 1px solid var(--vline); border-radius: 7px; background: var(--vbg); color: var(--vink); cursor: pointer; transition: background .12s; }
  .cloud-card button:hover { background: var(--vbg-2); }
  .cloud-card button.primary { background: var(--vink); color: var(--vbg); border-color: var(--vink); }
  .cloud-card button.primary:hover { background: var(--vorange); border-color: var(--vorange); }
  .cloud-card button.danger { color: var(--vmuted); }
  .cloud-card button.danger:hover { color: #c0392b; border-color: #c0392b; background: var(--vbg); }
  .cloud-card button:disabled { opacity: 0.5; cursor: wait; }
  .cloud-card .cloud-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .cloud-meta { display: grid; grid-template-columns: 110px 1fr; gap: 8px 14px; font-size: 13px; margin: 0 0 18px; padding: 14px 0; border-top: 1px solid var(--vline-2); border-bottom: 1px solid var(--vline-2); }
  .cloud-meta dt { color: var(--vmuted); font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; }
  .cloud-meta dd { margin: 0; color: var(--vink); }
  .cloud-meta .dim { color: var(--vmuted-2); font-family: var(--vmono); font-size: 11px; }
  .generated { margin-top: 18px; padding: 16px; background: var(--vbg-2); border-radius: 8px; border: 1px solid var(--vline); }
  .generated .code-row { display: flex; align-items: center; gap: 14px; }
  .generated .code-label { font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--vmuted); flex-shrink: 0; }
  .generated .code-value { font-family: var(--vmono); font-size: 28px; letter-spacing: 6px; color: var(--vink); flex: 1; user-select: all; }
  .generated .copy { font-size: 12px; padding: 6px 10px; }
  .generated .hint { margin: 10px 0 0; font-size: 12px; color: var(--vmuted); }
  .cloud-card .err { margin-top: 12px; padding: 10px 14px; background: rgba(192,57,43,0.08); border: 1px solid rgba(192,57,43,0.25); border-radius: 6px; color: #a4253a; font-size: 13px; display: none; }
  .cloud-card .err.shown { display: block; }
  #sync-result { margin-top: 12px; font-family: var(--vmono); font-size: 12px; color: var(--vmuted); }
  #sync-result.ok { color: var(--vgood, #0a6); }
  .cloud-stats-card h3 { display: flex; align-items: center; gap: 8px; }
  .cloud-stats-card h3 button { margin-left: auto; padding: 4px 8px; font-size: 11px; }
  .stats-body { margin-top: 4px; }
  .stats-loading { color: var(--vmuted); font-style: italic; padding: 8px 0; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px 18px; margin-bottom: 18px; }
  .stats-grid .cell { padding: 10px 0; }
  .stats-grid .cell .lbl { font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vmuted); }
  .stats-grid .cell .val { font-family: var(--vhead); font-weight: 500; font-size: 22px; color: var(--vink); margin-top: 4px; line-height: 1.2; letter-spacing: -0.01em; }
  .stats-grid .cell .val .sub { font-family: var(--vmono); font-size: 11px; color: var(--vmuted); margin-left: 6px; letter-spacing: 0; }
  .stats-section { margin-top: 16px; }
  .stats-section h4 { font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vmuted); font-weight: 500; margin: 0 0 8px; }
  .stats-table { width: 100%; font-size: 13px; border-collapse: collapse; }
  .stats-table th, .stats-table td { padding: 7px 8px; text-align: left; border-bottom: 1px solid var(--vline-2); }
  .stats-table th { font-family: var(--vmono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vmuted); font-weight: 500; }
  .stats-table td.num { text-align: right; font-family: var(--vmono); font-size: 12px; color: var(--vmuted); }
  .stats-table td.dim { color: var(--vmuted-2); font-style: italic; }
  .stats-table .pill-rev { display: inline-block; padding: 1px 6px; font-size: 10.5px; background: rgba(192,57,43,0.08); color: #a4253a; border-radius: 4px; margin-left: 6px; }
  /* Operator dashboard (v0.14+) — only rendered when /v1/admin/whoami says is_operator. */
  .operator-card h3 { display: flex; align-items: center; gap: 10px; }
  .op-badge { background: var(--vorange); color: var(--vbg); font-size: 10px; padding: 2px 7px; border-radius: 4px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; }
  .op-users { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
  .op-user-row { display: grid; grid-template-columns: 1.4fr 2fr 1fr 24px; gap: 12px; padding: 11px 12px; border-radius: 6px; cursor: pointer; align-items: center; font-size: 13px; transition: background .1s; }
  .op-user-row:hover { background: var(--vbg-2); }
  .op-user-row.selected { background: var(--vorange-soft, rgba(255,90,31,0.10)); border-left: 3px solid var(--vorange); padding-left: 9px; }
  .op-user-id { font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .op-user-stats { color: var(--vmuted); font-size: 12px; }
  .op-user-last { color: var(--vmuted-2); font-size: 11px; text-align: right; }
  .op-arrow { text-align: right; color: var(--vmuted-2); font-size: 11px; }
  .op-status { font-size: 9.5px; padding: 1px 5px; border-radius: 3px; letter-spacing: 0.06em; text-transform: uppercase; }
  .op-status.operator { background: rgba(255,90,31,0.18); color: var(--vorange); }
  .op-status.active { background: rgba(74,222,128,0.12); color: #15803d; }
  .op-status.deleted { background: rgba(192,57,43,0.18); color: #c0392b; }
  .add-user-form { padding: 14px 16px; background: var(--vbg-2); border-radius: 8px; margin-bottom: 12px; border: 1px solid var(--vline); }
  .add-user-form .field { display: block; margin-bottom: 10px; }
  .add-user-form .field label { display: block; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--vmuted); margin-bottom: 4px; }
  .add-user-form .field input { width: 100%; padding: 9px 11px; background: var(--vbg); border: 1px solid var(--vline); border-radius: 6px; color: var(--vink); font-family: inherit; font-size: 13px; box-sizing: border-box; }
  .add-user-form .field input:focus { outline: none; border-color: var(--vorange); box-shadow: 0 0 0 2px var(--vorange-soft, rgba(255,90,31,0.2)); }
  .add-user-form .row { display: flex; gap: 8px; }
  .add-user-form .row > .field { flex: 1; }
  .add-user-form label.cb { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--vink); text-transform: none; letter-spacing: 0; margin-bottom: 12px; cursor: pointer; }
  .op-detail { padding: 16px; background: var(--vbg-2); border-radius: 8px; margin-top: 12px; border: 1px solid var(--vline); }
  .op-detail h4 { margin: 0 0 12px; font-family: var(--vhead); font-weight: 500; font-size: 15px; }
  .op-detail h4 .id-mono { color: var(--vmuted); font-family: var(--vmono); font-size: 12px; margin-left: 6px; }
  .op-stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .op-stat-grid .lbl { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--vmuted); }
  .op-stat-grid .val { font-family: var(--vhead); font-size: 20px; font-weight: 500; margin-top: 3px; }
  .op-stat-grid .sub { font-size: 10.5px; color: var(--vmuted-2); margin-top: 1px; }
  .op-code-box { background: var(--vorange-soft, rgba(255,90,31,0.08)); border: 1px solid rgba(255,90,31,0.3); border-radius: 8px; padding: 14px; text-align: center; margin: 10px 0; }
  .op-code-box .lbl { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--vmuted); margin-bottom: 6px; }
  .op-code-box .code { font-family: var(--vmono); font-size: 26px; letter-spacing: 6px; color: var(--vorange); font-weight: 600; user-select: all; }
  .op-code-box .hint { font-size: 11px; color: var(--vmuted); margin-top: 6px; font-family: var(--vserif); font-style: italic; }
  .op-toast { padding: 8px 12px; border-radius: 6px; background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.3); color: #15803d; font-size: 12px; margin-top: 10px; }
  .op-toast.muted { background: var(--vbg); border-color: var(--vline-2); color: var(--vmuted); }
  .op-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
</style>
<script>(function(){
  function showErr(elId, msg) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.textContent = msg;
    el.classList.add('shown');
  }
  function clearErr(elId) {
    var el = document.getElementById(elId);
    if (el) el.classList.remove('shown');
  }

  var pairForm = document.getElementById('pair-form');
  if (pairForm) {
    pairForm.addEventListener('submit', function(ev){
      ev.preventDefault();
      clearErr('pair-err');
      var btn = pairForm.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Pairing…';
      fetch('/api/sync/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          remote: document.getElementById('cloud-remote').value.trim(),
          code: document.getElementById('cloud-code').value.trim(),
          device_name: document.getElementById('cloud-name').value.trim() || undefined,
        })
      }).then(function(r){
        return r.json().then(function(body){ return { ok: r.ok, body: body }; });
      }).then(function(res){
        if (!res.ok) throw new Error(res.body.error || 'pair failed');
        window.location.reload();
      }).catch(function(e){
        showErr('pair-err', e.message || String(e));
        btn.disabled = false; btn.textContent = 'Pair device';
      });
    });
  }

  var syncBtn = document.getElementById('sync-now-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', function(){
      clearErr('cloud-err');
      var orig = syncBtn.textContent;
      syncBtn.disabled = true; syncBtn.textContent = '↻ Syncing…';
      var result = document.getElementById('sync-result');
      result.textContent = '';
      result.className = '';
      fetch('/api/sync/run', { method: 'POST' })
        .then(function(r){ return r.json().then(function(body){ return { ok: r.ok, body: body }; }); })
        .then(function(res){
          if (!res.ok) throw new Error(res.body.error || 'sync failed');
          var r = res.body;
          result.textContent = 'pulled=' + r.pulled + ' pushed=' + r.pushed +
            ' live_pushed=' + r.live_pushed +
            ' assets↑=' + r.assets_pushed + ' assets↓=' + r.assets_pulled +
            ' renamed=' + r.renamed + ' deleted=' + r.deleted;
          result.className = 'ok';
        }).catch(function(e){
          showErr('cloud-err', e.message);
        }).finally(function(){
          syncBtn.disabled = false; syncBtn.textContent = orig;
        });
    });
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function bytesHuman(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }
  function ago(iso) {
    if (!iso) return 'never';
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 0 || !Number.isFinite(ms)) return '—';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' hr ago';
    var d = Math.floor(h / 24);
    return d === 1 ? 'yesterday' : d + 'd ago';
  }

  function renderStats(data) {
    var body = document.getElementById('cloud-stats-body');
    if (!body) return;
    var c = data.counts || {};
    var s = data.storage || {};
    var devices = data.devices || [];
    var threads = data.threads || [];

    var html = '';
    html += '<div class="stats-grid">';
    html += '<div class="cell"><div class="lbl">Notes</div><div class="val">' + (c.notes || 0) +
      '<span class="sub">' + (c.notes_live || 0) + ' live · ' + (c.notes_final || 0) + ' final</span></div></div>';
    html += '<div class="cell"><div class="lbl">Live entries</div><div class="val">' + (c.live_entries || 0) + '</div></div>';
    html += '<div class="cell"><div class="lbl">Assets</div><div class="val">' + (c.assets || 0) +
      '<span class="sub">' + bytesHuman(s.assets_bytes || 0) + '</span></div></div>';
    html += '<div class="cell"><div class="lbl">DB size</div><div class="val">' + bytesHuman(s.db_bytes || 0) +
      '<span class="sub">' + (c.tombstones || 0) + ' tombstones</span></div></div>';
    html += '<div class="cell"><div class="lbl">Devices</div><div class="val">' + (c.devices_active || 0) +
      '<span class="sub">' + (c.devices_revoked || 0) + ' revoked</span></div></div>';
    html += '<div class="cell"><div class="lbl">Shares</div><div class="val">' + (c.shares_active || 0) +
      '<span class="sub">' + (c.shares_total || 0) + ' total</span></div></div>';
    html += '</div>';

    if (devices.length) {
      html += '<div class="stats-section"><h4>Devices</h4>';
      html += '<table class="stats-table"><thead><tr><th>Name</th><th>Paired</th><th>Last seen</th><th>Last push</th><th class="num">Notes</th></tr></thead><tbody>';
      for (var i = 0; i < devices.length; i++) {
        var d = devices[i];
        html += '<tr>';
        html += '<td>' + esc(d.name) + (d.revoked ? ' <span class="pill-rev">revoked</span>' : '') + '</td>';
        html += '<td class="dim">' + esc((d.paired_at || '').slice(0, 10)) + '</td>';
        html += '<td class="dim">' + esc(ago(d.last_seen_at)) + '</td>';
        html += '<td class="dim">' + esc(ago(d.last_pushed_at)) + '</td>';
        html += '<td class="num">' + (d.note_count || 0) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    }

    if (threads.length) {
      html += '<div class="stats-section"><h4>Top threads</h4>';
      html += '<table class="stats-table"><thead><tr><th>Thread</th><th class="num">Notes</th><th>Latest</th></tr></thead><tbody>';
      for (var j = 0; j < threads.length; j++) {
        var t = threads[j];
        html += '<tr>';
        html += '<td>' + esc(t.thread_id) + '</td>';
        html += '<td class="num">' + (t.count || 0) + '</td>';
        html += '<td class="dim">' + esc((t.latest || '').slice(0, 10)) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    }
    body.innerHTML = html;
  }

  function loadStats() {
    var body = document.getElementById('cloud-stats-body');
    if (!body) return;
    body.innerHTML = '<div class="stats-loading">Loading…</div>';
    fetch('/api/cloud/stats')
      .then(function(r){ return r.json().then(function(b){ return { ok: r.ok, body: b }; }); })
      .then(function(res){
        if (!res.ok) throw new Error(res.body.error || 'stats failed');
        renderStats(res.body);
      })
      .catch(function(e){
        body.innerHTML = '<div class="stats-loading">Could not load: ' + esc(e.message || String(e)) + '</div>';
      });
  }
  if (document.getElementById('cloud-stats-body')) loadStats();
  var statsRefresh = document.getElementById('stats-refresh');
  if (statsRefresh) statsRefresh.addEventListener('click', loadStats);

  // ---- Operator dashboard (v0.14+) ----
  // Renders the user-management panel iff /v1/admin/whoami returns
  // is_operator=true. Non-operator paired devices never see this section.
  var opState = { selected: null, adding: false, toast: null, renaming: false, users: [] };
  function opShowErr(msg) {
    var e = document.getElementById('op-err');
    if (!e) return;
    e.textContent = msg || '';
    if (msg) e.classList.add('shown'); else e.classList.remove('shown');
  }
  // bytesHuman() + ago() are defined earlier in this script (used by the
  // stats panel above) — reuse rather than redeclare.
  async function opCall(method, path, body) {
    var init = { method: method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    var res = await fetch('/api/cloud/admin' + path, init);
    var text = await res.text();
    var data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }
  async function opRefresh() {
    try {
      var data = await opCall('GET', '/users');
      opState.users = data.users || [];
      renderOp();
    } catch (e) { opShowErr(e.message || String(e)); }
  }
  function renderOp() {
    var tableEl = document.getElementById('op-users-table');
    var detailEl = document.getElementById('op-detail');
    var addEl = document.getElementById('add-user-form');
    if (!tableEl || !detailEl || !addEl) return;

    // Users list
    tableEl.innerHTML = '';
    var listWrap = document.createElement('div');
    listWrap.className = 'op-users';
    for (var i = 0; i < opState.users.length; i++) {
      (function(u){
        var row = document.createElement('div');
        row.className = 'op-user-row' + (opState.selected === u.id ? ' selected' : '');
        var idCell = document.createElement('span');
        idCell.className = 'op-user-id';
        idCell.appendChild(document.createTextNode(u.id));
        var statusCls = u.deleted_at ? 'deleted' : (u.is_operator ? 'operator' : 'active');
        var statusText = u.deleted_at ? 'deleted' : (u.is_operator ? 'operator' : 'active');
        var pill = document.createElement('span');
        pill.className = 'op-status ' + statusCls;
        pill.textContent = statusText;
        idCell.appendChild(pill);
        row.appendChild(idCell);
        var stats = document.createElement('span');
        stats.className = 'op-user-stats';
        stats.textContent = u.devices + ' dev · ' + u.notes + ' notes · ' + bytesHuman(u.assets_bytes);
        row.appendChild(stats);
        var last = document.createElement('span');
        last.className = 'op-user-last';
        last.textContent = ago(u.last_seen_at);
        row.appendChild(last);
        var arrow = document.createElement('span');
        arrow.className = 'op-arrow';
        arrow.textContent = opState.selected === u.id ? '▼' : '›';
        row.appendChild(arrow);
        row.addEventListener('click', function(){
          opState.selected = opState.selected === u.id ? null : u.id;
          opState.adding = false;
          opState.toast = null;
          opState.renaming = false;
          renderOp();
        });
        listWrap.appendChild(row);
      })(opState.users[i]);
    }
    tableEl.appendChild(listWrap);

    // Add-user form
    addEl.innerHTML = '';
    if (opState.adding) {
      addEl.hidden = false;
      var idField = document.createElement('div'); idField.className = 'field';
      var idLab = document.createElement('label'); idLab.textContent = 'id (kebab-case)';
      var idIn = document.createElement('input'); idIn.placeholder = 'alice'; idIn.id = 'new-uid';
      idField.appendChild(idLab); idField.appendChild(idIn);
      var dispField = document.createElement('div'); dispField.className = 'field';
      var dispLab = document.createElement('label'); dispLab.textContent = 'display name (optional)';
      var dispIn = document.createElement('input'); dispIn.placeholder = 'Alice'; dispIn.id = 'new-disp';
      dispField.appendChild(dispLab); dispField.appendChild(dispIn);
      var opLabel = document.createElement('label'); opLabel.className = 'cb';
      var opCb = document.createElement('input'); opCb.type = 'checkbox'; opCb.id = 'new-op';
      opLabel.appendChild(opCb);
      opLabel.appendChild(document.createTextNode(' make this user an operator'));
      var actions = document.createElement('div'); actions.className = 'op-actions';
      var createBtn = document.createElement('button'); createBtn.className = 'primary'; createBtn.type = 'button'; createBtn.textContent = 'Create user';
      var cancelBtn = document.createElement('button'); cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
      createBtn.addEventListener('click', async function(){
        opShowErr('');
        var id = idIn.value.trim();
        var disp = dispIn.value.trim();
        try {
          var data = await opCall('POST', '/users', {
            id: id,
            display_name: disp || undefined,
            is_operator: opCb.checked,
          });
          opState.adding = false;
          opState.selected = data.user.id;
          opState.toast = "user '" + data.user.id + "' created";
          await opRefresh();
        } catch (e) { opShowErr(e.message || String(e)); }
      });
      cancelBtn.addEventListener('click', function(){ opState.adding = false; renderOp(); });
      actions.appendChild(createBtn); actions.appendChild(cancelBtn);
      addEl.appendChild(idField);
      addEl.appendChild(dispField);
      addEl.appendChild(opLabel);
      addEl.appendChild(actions);
    } else {
      addEl.hidden = true;
    }

    // Detail pane
    if (opState.selected) {
      var u = null;
      for (var k = 0; k < opState.users.length; k++) { if (opState.users[k].id === opState.selected) { u = opState.users[k]; break; } }
      if (u) {
        detailEl.hidden = false;
        detailEl.className = 'op-detail';
        detailEl.innerHTML = '';
        var h = document.createElement('h4');
        h.appendChild(document.createTextNode(u.display_name));
        var idMono = document.createElement('span'); idMono.className = 'id-mono'; idMono.textContent = u.id;
        h.appendChild(idMono);
        detailEl.appendChild(h);

        if (opState.renaming) {
          var rf = document.createElement('div'); rf.className = 'field';
          var rl = document.createElement('label'); rl.textContent = 'new id';
          var ri = document.createElement('input'); ri.value = u.id;
          rf.appendChild(rl); rf.appendChild(ri);
          detailEl.appendChild(rf);
          var ra = document.createElement('div'); ra.className = 'op-actions';
          var saveBtn = document.createElement('button'); saveBtn.className = 'primary'; saveBtn.type = 'button'; saveBtn.textContent = 'Save';
          var cancelR = document.createElement('button'); cancelR.type = 'button'; cancelR.textContent = 'Cancel';
          saveBtn.addEventListener('click', async function(){
            opShowErr('');
            try {
              var data = await opCall('PATCH', '/users/' + encodeURIComponent(u.id), { new_id: ri.value.trim() });
              opState.selected = data.id;
              opState.toast = "renamed → '" + data.id + "' (bearer tokens unchanged)";
              opState.renaming = false;
              await opRefresh();
            } catch (e) { opShowErr(e.message || String(e)); }
          });
          cancelR.addEventListener('click', function(){ opState.renaming = false; renderOp(); });
          ra.appendChild(saveBtn); ra.appendChild(cancelR);
          detailEl.appendChild(ra);
        } else {
          var grid = document.createElement('div'); grid.className = 'op-stat-grid';
          var cells = [
            { lbl: 'Devices', val: u.devices, sub: u.devices_revoked > 0 ? u.devices_revoked + ' revoked' : null },
            { lbl: 'Notes',   val: u.notes },
            { lbl: 'Assets',  val: u.assets, sub: bytesHuman(u.assets_bytes) },
            { lbl: 'Shares',  val: u.shares_active },
          ];
          for (var c = 0; c < cells.length; c++) {
            var cell = document.createElement('div');
            var lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = cells[c].lbl;
            var val = document.createElement('div'); val.className = 'val'; val.textContent = String(cells[c].val);
            cell.appendChild(lbl); cell.appendChild(val);
            if (cells[c].sub) { var sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = cells[c].sub; cell.appendChild(sub); }
            grid.appendChild(cell);
          }
          detailEl.appendChild(grid);

          if (opState.toast) {
            var t = document.createElement('div'); t.className = 'op-toast'; t.textContent = '✓ ' + opState.toast;
            detailEl.appendChild(t);
          }
          if (u.deleted_at) {
            var dt = document.createElement('div'); dt.className = 'op-toast muted';
            dt.textContent = 'Deleted on ' + u.deleted_at.slice(0, 10) + '. Reactivate via CLI.';
            detailEl.appendChild(dt);
          } else {
            var acts = document.createElement('div'); acts.className = 'op-actions';
            function mkBtn(label, cls, fn){ var b = document.createElement('button'); b.type='button'; if(cls) b.className=cls; b.textContent=label; b.addEventListener('click', fn); return b; }
            acts.appendChild(mkBtn('✎ Rename', '', function(){ opState.renaming = true; renderOp(); }));
            acts.appendChild(mkBtn(u.is_operator ? '↓ Demote' : '↑ Promote', '', async function(){
              opShowErr('');
              try {
                await opCall('PATCH', '/users/' + encodeURIComponent(u.id), { is_operator: !u.is_operator });
                opState.toast = u.is_operator ? 'demoted from operator' : 'promoted to operator';
                await opRefresh();
              } catch (e) { opShowErr(e.message || String(e)); }
            }));
            acts.appendChild(mkBtn('☒ Revoke devices', 'danger', async function(){
              if (u.devices === 0) { opState.toast = 'no active devices'; renderOp(); return; }
              if (!window.confirm("Revoke all of " + u.display_name + "'s devices? Data preserved.")) return;
              opShowErr('');
              try {
                await opCall('DELETE', '/users/' + encodeURIComponent(u.id));
                opState.toast = 'all devices revoked — data preserved';
                await opRefresh();
              } catch (e) { opShowErr(e.message || String(e)); }
            }));
            acts.appendChild(mkBtn('⌧ Purge (cascade)', 'danger', async function(){
              if (!window.confirm("PURGE " + u.display_name + " — deletes " + u.notes + " notes, " + u.assets + " assets, " + u.shares_active + " shares. Cannot undo. Type yes to confirm.")) return;
              var typed = window.prompt("Type the user id to confirm purge:");
              if (typed !== u.id) { opState.toast = 'cancelled — id mismatch'; renderOp(); return; }
              opShowErr('');
              try {
                var data = await opCall('DELETE', '/users/' + encodeURIComponent(u.id) + '?purge=1');
                opState.toast = "purged " + (data.purged ? data.purged.notes + ' notes, ' + data.purged.assets + ' assets' : '');
                opState.selected = null;
                await opRefresh();
              } catch (e) { opShowErr(e.message || String(e)); }
            }));
            detailEl.appendChild(acts);
          }
        }
      } else {
        detailEl.hidden = true;
      }
    } else {
      detailEl.hidden = true;
    }
  }
  // Bootstrap: check whoami and conditionally show operator card.
  (async function(){
    var card = document.getElementById('operator-card');
    if (!card) return;
    try {
      var r = await fetch('/api/cloud/admin/whoami');
      if (!r.ok) return; // not paired or other error → leave card hidden
      var me = await r.json();
      if (!me.is_operator) return;
      card.hidden = false;
      var addBtn = document.getElementById('add-user-btn');
      if (addBtn) addBtn.addEventListener('click', function(){
        opState.adding = !opState.adding;
        opState.selected = null;
        opState.toast = null;
        renderOp();
      });
      await opRefresh();
    } catch (_e) {}
  })();

  var unpairBtn = document.getElementById('unpair-btn');
  if (unpairBtn) {
    var armed = false;
    unpairBtn.addEventListener('click', function(){
      if (!armed) {
        armed = true;
        unpairBtn.textContent = 'Click again to confirm';
        unpairBtn.style.color = '#c0392b';
        setTimeout(function(){
          armed = false;
          unpairBtn.textContent = 'Unpair this device';
          unpairBtn.style.color = '';
        }, 5000);
        return;
      }
      fetch('/api/sync/unpair', { method: 'POST' })
        .then(function(){ window.location.reload(); });
    });
  }
})();</script>`;
}

export function pageError(code: number, msg: string): string {
  return shell(`${code}`, `${topbar()}<div class="empty"><h2>${code}</h2><p class="lead">${esc(msg)}</p><p style="margin-top:24px;"><a href="/" style="color:var(--vorange);border-bottom:1px solid currentColor;font-family:var(--vmono);font-size:13px">← Back to list</a></p></div>`);
}
