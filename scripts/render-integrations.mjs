#!/usr/bin/env node
/**
 * Render integration tutorials from algovault-skills/docs/integrations/*.md
 * to landing/integrations/*.html (pre-rendered, committed, static-served).
 *
 * Run from signal-MCP repo root:
 *   node scripts/render-integrations.mjs            # default --source ~/git/algovault-skills
 *   node scripts/render-integrations.mjs --source /path/to/algovault-skills
 *
 * Output: landing/integrations/{binance,okx,bybit,bitget}.html
 *
 * Each rendered HTML page wraps the tutorial body in the same Tailwind navy/
 * mint theme used by landing/docs.html so the mirror reads as part of
 * algovault.com, not as a foreign drop-in.
 *
 * Re-run this script whenever algovault-skills/docs/integrations/<x>.md
 * changes upstream. The output is committed to signal-MCP so the deploy
 * pipeline ships static HTML — no per-request markdown rendering.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import MarkdownIt from 'markdown-it';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// FOOTER-UNIFY-W1: the brand footer comes from the single SoT (compiled
// dist/lib/footer-content.js; run `npm run build` before this generator).
// createRequire loads the tsc-emitted CJS module from this ESM script.
const require = createRequire(import.meta.url);
const { renderBrandFooter } = require(join(ROOT, 'dist', 'lib', 'footer-content.js'));
// OPS-INTEGRATIONS-LIVE-SOT-W1: the supported-exchange COUNT comes from the one
// venue SoT (src/lib/capabilities.ts → dist/lib/capabilities.js), never a hand-
// typed literal, so the page count can't diverge from /api/performance-public.
// NOTE: imported as SOT_EXCHANGE_COUNT — this file already has its own local
// `EXCHANGES` const, which is the list of 7 tutorial SLUGS (binance, gemini,
// kraken, …), a DIFFERENT set from the 12 signal venues. Do not conflate them.
const { EXCHANGE_COUNT: SOT_EXCHANGE_COUNT } = require(join(ROOT, 'dist', 'lib', 'capabilities.js'));
// BROKER-PAIRING-CRYPTO-W1 (2026-06-05): +3 crypto agentic-trading kits
// (Gemini self-hosted MCP / Kraken CLI / Alpaca crypto MCP) extend the
// exchange-kit tutorial pattern; sources in algovault-skills/docs/integrations/.
// OPS-INTEGRATIONS-VENUE-PAGES-W1 (2026-07-21): +4 signal-venue tutorials.
// HTX / MEXC / Phemex / Gate.io were verified and HALTed — see
// audits/OPS-INTEGRATIONS-VENUE-PAGES-W1-endpoint-truth.md for why.
const EXCHANGES = ['binance', 'okx', 'bybit', 'bitget', 'gemini', 'kraken', 'alpaca',
  'hyperliquid', 'aster', 'bingx', 'kucoin',
  // OPS-INTEGRATIONS-VENUE-PAGES-W2 (2026-07-21): Gate.io. MEXC/HTX/Phemex are
  // CLOSED, not pending — see audits/OPS-INTEGRATIONS-VENUE-PAGES-W2-endpoint-truth.md.
  'gateio',
  // BINANCE-AGENT-OS-TRUTH-AND-PAGE-W1 (2026-08-25): the first exchange-kit tutorial sourced
  // IN-REPO (docs/integrations/exchange-kits/), which getSrcPath() now resolves per slug.
  'binance-agent-os'];
// AI-AGENT-FRAMEWORK-TUTORIALS-W1 (2026-05-18): 4 framework integration mirrors
// extend the same render pipeline. Same template — eyebrow shows `<slug> integration`,
// canonical URL = /integrations/<slug>, page title = AlgoVault × <Display>.
const FRAMEWORKS = ['langchain', 'llamaindex', 'maf', 'crewai'];
// INTEGRATIONS-FULL-STACK-W1 C4 (2026-05-19): 5 MCP-client pages sourced
// from THIS repo at `docs/integrations/mcp-clients/<slug>.md` (NOT the
// algovault-skills repo). Same htmlShell template; getSrcPath() routes
// per-slug.
const MCP_CLIENTS = ['claude-desktop', 'claude-code', 'cursor', 'cline', 'smithery',
  // +3, each verified 2026-08-05 against that vendor's own MCP documentation.
  'codex', 'kimi', 'glm-zcode',
  // +1, verified 2026-08-28 against the harness source and registry.npmjs.org. NOTE the pairing:
  // `deepseek-harness` is DeepSeek's own runtime (a native client, this page); `deepseek` is the
  // bring-your-own-model row and stays hasDedicatedPage:false. Two products, two rows.
  'deepseek-harness'];
const ALL_TARGETS = [...EXCHANGES, ...FRAMEWORKS, ...MCP_CLIENTS];

const args = process.argv.slice(2);
const sourceArg = args[args.indexOf('--source') + 1];
// BINANCE-AGENT-OS-TRUTH-AND-PAGE-W1 CH2 R0 — the default used to be
// `join(homedir(), 'git', 'algovault-skills')`. That path does NOT exist:
// OPS-WORKTREE-ROOT-CONFINEMENT-W2 CH6 relocated `~/git/algovault-skills` to
// `~/code/algovault-skills.dup-20260809` (see its exempt_paths row in
// ops/shared-worktree-state.json), and `~/git` has been gone since. So every
// argument-less run ENOENT'd on a phantom path, which reads as a missing tutorial
// rather than a missing checkout. A default pointing at a directory that cannot
// exist is a fictional primitive in our OWN tree — exactly the class CH1's gate
// retires — so it now REFUSES with a named error instead.
const DEFAULT_SOURCE_REPO = join(homedir(), 'git', 'algovault-skills');
const SOURCE_REPO = sourceArg && sourceArg !== '--source' ? sourceArg : DEFAULT_SOURCE_REPO;

const SOURCE_DIR = join(SOURCE_REPO, 'docs', 'integrations');
const LOCAL_DOCS_ROOT = join(ROOT, 'docs', 'integrations');
const LOCAL_MCP_CLIENTS_DIR = join(LOCAL_DOCS_ROOT, 'mcp-clients');
const TARGET_DIR = join(ROOT, 'landing', 'integrations');

/**
 * Refuse a run that cannot possibly resolve its out-of-repo sources, naming the cause.
 * Called only when a slug actually needs SOURCE_DIR, so a future all-in-repo tree stops
 * depending on the sibling checkout without anyone editing this guard.
 */
function requireSourceRepo(slug) {
  if (existsSync(SOURCE_DIR)) return;
  const usedDefault = SOURCE_REPO === DEFAULT_SOURCE_REPO;
  throw new Error(
    `[render] cannot resolve the algovault-skills source for '${slug}'.\n` +
    `         looked in: ${SOURCE_DIR}\n` +
    (usedDefault
      ? `         No --source was passed, so this fell back to the built-in default\n` +
        `         ${DEFAULT_SOURCE_REPO}, which does not exist on this machine\n` +
        `         (~/git/algovault-skills was relocated by OPS-WORKTREE-ROOT-CONFINEMENT-W2 CH6).\n`
      : `         That path was passed via --source and does not exist.\n`) +
    `         Fix: create a worktree of algovault-skills off its origin/main and pass it:\n` +
    `           node scripts/render-integrations.mjs --source <path-to-algovault-skills-worktree>\n` +
    `         Do NOT point this at ~/code/algovault-skills — it is a divergent, dirty checkout\n` +
    `         (see docs/RUNBOOK-INTEGRATION-TUTORIAL-AUTHORING.md).`,
  );
}

/**
 * Resolve a slug's markdown source. IN-REPO FIRST, across any subdirectory of
 * docs/integrations/, then the sibling algovault-skills checkout.
 *
 * BINANCE-AGENT-OS-TRUTH-AND-PAGE-W1 CH2 R1: this used to route on CATEGORY —
 * `MCP_CLIENTS` resolved locally and everything else resolved out-of-repo. That coupling
 * made a page's KIND decide which repo you had to edit, so every exchange-kit tutorial
 * was a cross-repo change. Routing per SLUG instead means a new tutorial is an in-repo
 * file, and an existing one keeps resolving exactly where it does today: the in-repo
 * lookup only fires for a file that is actually present, so the 12 exchange and 4
 * framework slugs are untouched (proven by a byte-identical re-render).
 */
function getSrcPath(slug) {
  for (const dir of readdirSync(LOCAL_DOCS_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const candidate = join(LOCAL_DOCS_ROOT, dir.name, `${slug}.md`);
    if (existsSync(candidate)) return candidate;
  }
  requireSourceRepo(slug);
  return join(SOURCE_DIR, `${slug}.md`);
}

// ─── dateModified derives from the CONTENT SOURCE ────────────────────────────────────────────
//
// OPS-DATEMODIFIED-DERIVE-AND-PR-DISPOSITION-W1 R1. This was a frozen 25-entry per-slug map
// (the sibling of the published-date map above) whose 25 values were all `2026-08-25` — one false value repeated across 25 crawler-facing
// pages, which is the exact defect BINANCE-AGENT-OS-GEO-AND-SUBMISSIONS-W2 CH1 removed from
// `datePublished` and then reintroduced in the sibling field. Measured 2026-08-26: the pages'
// real last-modified date was 2026-08-26 (W2's own two commits) while every page served
// 2026-08-25.
//
// The root cause is a chicken-and-egg, and it is why a map cannot be the fix: you cannot know
// the date of the commit you are about to make, so ANY artifact-derived value is stale the
// moment it is written. Deriving from something already SETTLED — the source markdown's last
// commit — has no such circularity.
//
// WHY THE SOURCE AND NOT THE RENDERED ARTIFACT. `dateModified` answers "when did this tutorial
// last change?". Keying it on the rendered HTML means a nav-only or footer-only re-render bumps
// all 25 modification dates at once — crawler-facing freshness spam, and a worse lie than being
// a day stale. Keyed on the source, an unchanged tutorial correctly reports an unchanged date.
//
// Measured 2026-08-26 across the 25 slugs: 5 distinct dates (2026-07-21 / 07-25 / 08-09 / 08-25
// / 08-26), 15 owned by the algovault-skills worktree and 10 in-repo.
const dateModifiedCache = new Map();

/**
 * Last commit date (YYYY-MM-DD, UTC) of the slug's SOURCE markdown, from whichever repo owns it.
 *
 * `getSrcPath()` resolves in-repo first and falls back to SOURCE_REPO, so the owning repo is
 * whichever of the two the resolved path sits under — running `git -C` against the wrong one
 * returns empty and would look identical to "no history".
 *
 * REFUSES on empty output. No fallback to SNAPSHOT.date, to datePublished, or to file mtime:
 * a guessed modification date is precisely the defect this function exists to retire, and a
 * plausible-looking wrong date is harder to notice than a refusal.
 */
function sourceModifiedDate(slug) {
  if (dateModifiedCache.has(slug)) return dateModifiedCache.get(slug);
  const srcPath = getSrcPath(slug);
  const owner = srcPath.startsWith(ROOT) ? ROOT : SOURCE_REPO;
  let out = '';
  try {
    out = execFileSync('git', ['-C', owner, 'log', '-1', '--format=%aI', '--', srcPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    throw new Error(
      `[render] cannot read the source commit date for '${slug}'.\n` +
      `         source: ${srcPath}\n         repo:   ${owner}\n` +
      `         git failed: ${String(err.message).split('\n')[0]}\n` +
      `         dateModified is DERIVED, never guessed — fix the repo or the --source path.`,
    );
  }
  if (!out) {
    throw new Error(
      `[render] no commit history for '${slug}' — refusing to guess its dateModified.\n` +
      `         source: ${srcPath}\n         repo:   ${owner}\n` +
      `         A shallow clone, an uncommitted source file, or the wrong --source will all\n` +
      `         produce this. Commit the source or point --source at the repo that owns it.`,
    );
  }
  const date = out.slice(0, 10);
  dateModifiedCache.set(slug, date);
  return date;
}

// html: true required so source MDs can include <span data-tr-field="..."> for
// the live track-record proxy (see WEBSITE-REFRESH-W1 C1).
const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// BINANCE-AGENT-OS-GEO-AND-SUBMISSIONS-W2 CH1 R1/R2 — every date is DERIVED FROM GIT.
//
// 24 of these pages told crawlers they were published 2026-04-25 because that was a single
// hardcoded default; the generator's own comments dated them across May-August. A schema date
// is crawler-facing public copy, so a shared false one is a published falsehood on 24 indexed
// pages.
//
// Derived with `git log --diff-filter=A --format=%aI -- <path> | tail -1` and
// `git log -1 --format=%aI -- <path>`. **NOT `--follow`.** Measured 2026-08-26: --follow
// returns 2026-04-25 for 24 of 25 slugs -- including binance-agent-os, created 2026-08-25 --
// because rename-detection collapses these near-identical generated pages onto one ancestor
// (e4ec754 'website mirrors for 4 integration tutorials'). It manufactures a false common
// ancestor and would have re-stamped the site's only honest date with the lie. This does NOT
// contradict the provenance rule that a `git log -S` pickaxe carries --follow: that traces a
// renamed SOURCE file, where --follow prevents a false 'never designed'. Opposite operation,
// opposite failure mode, both true.
//
// Cross-checked against the generator's wave comments (05-18 frameworks / 05-19 mcp-clients /
// 06-05 gemini-kraken-alpaca / 07-21 venue pages / 08-05 codex-kimi-zcode): ZERO disagreements.
//
// DEFAULT_DATE_PUBLISHED is retained as a structural fallback but is now UNREACHABLE -- every
// rendered slug has an explicit entry, and the chapter gate asserts the entry count. A new slug
// that forgets its entry gets the fallback, which is why the gate counts rather than trusts.
const DEFAULT_DATE_PUBLISHED = '2026-04-25';

const DATE_PUBLISHED = {
  'alpaca':           '2026-06-05',
  'aster':            '2026-07-21',
  'binance':          '2026-04-25',
  'binance-agent-os': '2026-08-25',
  'bingx':            '2026-07-21',
  'bitget':           '2026-04-25',
  'bybit':            '2026-04-25',
  'claude-code':      '2026-05-19',
  'claude-desktop':   '2026-05-19',
  'cline':            '2026-05-19',
  'codex':            '2026-08-05',
  'crewai':           '2026-05-18',
  'cursor':           '2026-05-19',
  'gateio':           '2026-07-21',
  'gemini':           '2026-06-05',
  'glm-zcode':        '2026-08-05',
  'hyperliquid':      '2026-07-21',
  'kimi':             '2026-08-05',
  'kraken':           '2026-06-05',
  'kucoin':           '2026-07-21',
  'langchain':        '2026-05-18',
  'llamaindex':       '2026-05-18',
  'maf':              '2026-05-18',
  'okx':              '2026-04-25',
  'smithery':         '2026-05-19',
};



// The shared description ends "Demo runs testnet/demo only — zero real-money risk in any code
// path." That is true of the demo-bearing kits and FALSE here: this page connects a real
// Binance account under OAuth and can place live orders in an Agentic sub-account. Shipping the
// default would put an inaccurate safety claim in crawler-facing JSON-LD.
const DESCRIPTIONS = {
  'binance-agent-os':
    "Connect Binance Agent OS and AlgoVault MCP to one client: AlgoVault returns the composite "
    + "verdict, Binance executes it under OAuth. No API keys, no HMAC signing, and no withdrawal "
    + "scope exists. Trading is confined to an isolated Agentic sub-account you fund yourself.",
};

// Acronym-aware target display names (avoid auto-cap "OKX" → "Okx").
const DISPLAY_NAMES = {
  binance: 'Binance',
  okx: 'OKX',
  bybit: 'Bybit',
  bitget: 'Bitget',
  // BROKER-PAIRING-CRYPTO-W1 crypto agentic-trading kits
  gemini: 'Gemini',
  kraken: 'Kraken',
  alpaca: 'Alpaca',
  // AI-AGENT-FRAMEWORK-TUTORIALS-W1 frameworks
  langchain: 'LangChain',
  llamaindex: 'LlamaIndex',
  maf: 'Microsoft Agent Framework',
  crewai: 'CrewAI',
  // INTEGRATIONS-FULL-STACK-W1 C4 MCP clients
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  // OPS-INTEGRATIONS-VENUE-PAGES-W1 — labels VERBATIM from capabilities.ts EXCHANGES.
  gateio: 'Gate.io',   // NOT the title-cased fallback "Gateio"
  hyperliquid: 'Hyperliquid',
  aster: 'Aster',
  bingx: 'BingX',
  kucoin: 'KuCoin',
  // BINANCE-AGENT-OS-TRUTH-AND-PAGE-W1 — without this the title-cased fallback renders
  // "Binance-agent-os".
  'binance-agent-os': 'Binance Agent OS',
  cursor: 'Cursor',
  cline: 'Cline (VSCode)',
  smithery: 'Smithery',
  // Labels VERBATIM from src/lib/integrations-data/mcp-clients.ts displayName.
  // Needed here because the title-cased fallback renders "Kimi" and "Glm-zcode".
  codex: 'Codex',
  kimi: 'Kimi Code',
  'glm-zcode': 'ZCode (GLM)',
  // LANDING-DSH-CLIENT-SURFACE-W1 — same reason as binance-agent-os above: the title-cased
  // fallback renders "Deepseek-harness", which gets the vendor's own capitalisation wrong on
  // the <title>, the OG tags and the H1.
  'deepseek-harness': 'DeepSeek Harness',
};

// NAV-PLATFORM-GENERATOR-W1 (A1): canonicalNavHtml() RETIRED. The per-page integration nav is
// now the ONE unified nav — injected by scripts/build_nav.mjs from src/lib/site-nav.ts
// renderSiteNav() (single-derivation across all 26 surfaces). Integration pages emit empty
// <!-- NAV:START/END --> markers (below); build_nav fills them. Consequences of unification:
//   • hrefs are ABSOLUTE (A6), not relative — one region works apex + api-served.
//   • the /track-record link no longer carries a per-page utm_campaign (a byte-identical region
//     cannot; body-embedded tutorial links KEEP their utm for Plausible attribution).
//   • the "Integrations" active-link is applied CLIENT-SIDE by the controller (URL match).
const NAV_REGION_MARKERS = '<!-- NAV:START -->\n<!-- NAV:END -->';

// DESIGN-W10 / C3: canonical Footer VERBATIM (desktop variant, /tmp/live-landing.html
// line 493 per chrome-extract §2). Per Q-W10-7: canonical Footer ships verbatim WITHOUT
// utm-injection (no /track-record link in default Footer; utm preservation applies to
// Nav-Footer-Body links, not Footer-only links).
// FOOTER-UNIFY-W1: single-source brand footer (was an inline literal copy → drift). Desktop variant.
const CANONICAL_FOOTER_HTML = renderBrandFooter('desktop');

// DESIGN-W10-FF-2 (2026-05-12): strip the "TL;DR (3-line hook — MOAT-led)" h2 + bullet
// list from rendered tutorial HTML per Mr.1 directive ("I means remove this section,
// not the section cards"). Section is redundant with the quotable-fact callout above
// the article (both make the MOAT pitch — composite verdict, cross-venue, Merkle-
// anchored). Upstream markdown source PRESERVED at algovault-skills/docs/integrations/
// <x>.md for GitHub readers + Skills Hub PR consumers; strip is signal-MCP-side only.
function stripTLDRSection(bodyHtml) {
  return bodyHtml.replace(
    /<h2>TL;DR[^<]*<\/h2>\s*<ul>[\s\S]*?<\/ul>\s*/,
    ''
  );
}

// DESIGN-W10-FF-3 (2026-05-12): strip the snapshot blockquote pair (3 consecutive
// elements after the markdown H1) from rendered tutorial HTML per Mr.1 directive
// ("Remove the whole part that I circle in red"). Block structure:
//   1. <blockquote><!-- snapshot: ... --></blockquote>   ← marker block
//   2. <p><strong>X% PFE Win Rate · Y+ calls · Z+ Merkle-verified on-chain batches.</strong></p>
//   3. <blockquote>Don't trust — verify the track record → Snapshot taken DATE
//      — live numbers refreshed in-page from API_URL</blockquote>
// All 3 are redundant with the quotable-fact callout above the article (which
// already shows live PFE WR / signal count / Merkle batch count via data-tr-field
// hydration). Upstream markdown source PRESERVED at algovault-skills/docs/
// integrations/<x>.md for GitHub readers + Skills Hub PR consumers.
// CROSS-REPO-TUTORIAL-PRODUCER-GATE-W1 (2026-08-06) — ANCHOR REPAIR. The pattern
// below used to require the strong element to END exactly `…on-chain batches.</strong>`.
// 12 exchange producers do; the 4 agent-framework producers append a clause after
// "batches" (`… batches · <span data-tr-field="asset_count">738</span> assets covered.`),
// so the anchor silently stopped matching and the ENTIRE block survived into
// langchain/crewai/llamaindex/maf — which is why those 4 pages rendered the number
// block TWICE (once from the markdown, once from the injected callout) and were the
// only tutorials still showing the internal "live numbers refreshed in-page" note.
//
// Fixed by anchoring on the phrase and tolerating any tail before `</strong></p>`
// (lazy, so it stops at the first one). Normalising the 4 producers to one exact
// shape was considered and REJECTED: that re-asserts the brittleness this repair
// removes — a generator must not depend on every upstream author ending a sentence
// identically.
//
// Trade-off, ratified: those 4 pages lose their `asset_count` span, which the
// injected callout does not carry. Recorded as a declared reduction; reinstating
// asset_count for ALL 24 tutorials is OPS-TUTORIAL-ASSET-COUNT-REINSTATE-W{NEXT}.
function stripSnapshotBlock(bodyHtml) {
  return bodyHtml.replace(
    /<blockquote>\s*<!-- snapshot:[\s\S]*?-->\s*<\/blockquote>\s*<p><strong>[\s\S]*?Merkle-verified on-chain batches[\s\S]*?<\/strong><\/p>\s*<blockquote>\s*<p>Don['’]t trust[\s\S]*?performance-public<\/a>[\s\S]*?<\/blockquote>\s*/,
    ''
  );
}

// OPS-INTEGRATION-COPY-HYGIENE (2026-06-05, Mr.1): internal strategy language
// ("MOAT") is never public-facing. Strip any heading parenthetical that
// contains "MOAT" (e.g. "Why AlgoVault? (closing — MOAT recap)") from the
// rendered HTML as a generator-level guarantee — the source .md headings are
// kept clean too, so this only fires if a future source reintroduces one.
// Reader-facing hints like "(90s read)" / "(3-line hook)" are preserved
// (no MOAT token, so they never match).
function stripInternalHeadingAnnotations(bodyHtml) {
  return bodyHtml.replace(
    /(<h[1-6][^>]*>[^<]*?)\s*\([^)]*\bMOAT\b[^)]*\)/gi,
    '$1',
  );
}

// DESIGN-W10 / C3 / Q-W10-4 + Q-W10-6: wrap each top-level h2 section of markdown-
// rendered HTML in a tier-stat-card VCard. Splits bodyHtml on `<h2>` boundaries.
// First chunk (pre-first-h2) — the markdown H1 + intro paragraph + quotable-fact +
// callout block — gets its own tier-stat-card wrapper (the "intro section").
// Each subsequent chunk (`<h2>...next-h2-or-end`) gets its own wrapper.
function wrapH2InTierStatCard(bodyHtml) {
  // Find all <h2 offsets (allow optional attrs on <h2 e.g. <h2 id="..."> from markdown-it linkify).
  const re = /<h2(?=[ >])/g;
  const offsets = [];
  let m;
  while ((m = re.exec(bodyHtml)) !== null) {
    offsets.push(m.index);
  }
  if (offsets.length === 0) {
    // No h2 — wrap the entire body in a single card.
    return `<div class="tier-stat-card" style="padding:24px;gap:0;margin-bottom:18px">${bodyHtml}</div>`;
  }
  // First chunk: before-first-h2 (intro section)
  const chunks = [];
  const intro = bodyHtml.slice(0, offsets[0]).trim();
  if (intro) {
    chunks.push(`<div class="tier-stat-card" style="padding:24px;gap:0;margin-bottom:18px">${intro}</div>`);
  }
  // Per-h2 chunks
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : bodyHtml.length;
    const section = bodyHtml.slice(start, end).trim();
    chunks.push(`<div class="tier-stat-card" style="padding:24px;gap:0;margin-bottom:18px">${section}</div>`);
  }
  return chunks.join('\n');
}

function pageTitle(exchange) {
  const display = DISPLAY_NAMES[exchange] ?? (exchange.charAt(0).toUpperCase() + exchange.slice(1));
  return `AlgoVault × ${display} — Build Verifiable AI Trading Agents`;
}

// WEBSITE-REFRESH-W1 C1 — number snapshot for the initial render.
// Live source of truth: /api/performance-public + /api/merkle-batches (proxied
// at runtime by /js/track-record-proxy.js to update [data-tr-field] elements).
//
// OPS-INTEGRATIONS-LIVE-SOT-W1: these were hand-maintained consts that last
// moved on 2026-04-26 and rotted (89.4% / 56,375 vs a live 91.5% / 383,785).
// They are now READ LIVE at regen; the literals below are only a fail-open
// FLOOR. Monotonic-safe: every rendered count carries a trailing `+`, so a
// floor understates rather than overstates.
//
// TODO: revisit fallback floor by 2026-08-03
const SNAPSHOT_FALLBACK = Object.freeze({
  pfeWr: '91.5%',
  callCount: '383,785',
  batchCount: '100',
  assetCount: '1330',
});

/** Mutated once by `main()` before any page renders. */
let SNAPSHOT = {
  ...SNAPSHOT_FALLBACK,
  date: new Date().toISOString().slice(0, 10),
  live: false,
};

/**
 * Read the live numbers exactly as `scripts/snapshot-landing-data.mjs` does —
 * native fetch, short timeout, fail-open. A regen must never be blocked by an
 * unreachable SoT; it just renders the floor.
 *
 * Values are validated before use: `pfeWinRate` is a FRACTION (`number | null`)
 * and a bad/absent count would otherwise render "0.0%" / "0" as public fact.
 */
async function fetchSnapshot() {
  const base = process.env.API_BASE_URL || 'https://api.algovault.com';
  const out = { ...SNAPSHOT_FALLBACK, date: new Date().toISOString().slice(0, 10), live: false };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  try {
    const perf = await fetch(`${base}/api/performance-public`, { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null));
    const calls = num(perf?.totalCalls);
    const wr = num(perf?.overall?.pfeWinRate);
    if (calls && wr && wr <= 1) {
      out.callCount = calls.toLocaleString('en-US');
      out.pfeWr = `${(wr * 100).toFixed(1)}%`;
      out.live = true;
    }
    // Floor-rounded to the nearest 10 — mirrors formatAssetCount() in
    // track-record-proxy.js exactly, so the baked floor equals what the proxy paints.
    const assets = num(perf?.asset_count);
    if (assets) out.assetCount = String(Math.floor(assets / 10) * 10);
  } catch { /* fail-open — floor stands */ }
  try {
    const merkle = await fetch(`${base}/api/merkle-batches`, { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null));
    // OPS-CAPPED-COLLECTION-GUARD-W1: server-derived COUNT(*) ONLY. `batches` is a
    // LIMIT-capped page, so its length pins at the cap once more batches exist — the
    // array fallback was the wrong-number shape kept alive. Absent field → floor
    // stands (this function's existing fail-open idiom), never a short count.
    const n = typeof merkle?.batch_count === 'number' ? merkle.batch_count : 0;
    if (n > 0) out.batchCount = String(n);
  } catch { /* fail-open — floor stands */ }
  return out;
}

/**
 * Live-proxy hooks that `landing/js/track-record-proxy.js` actually calls
 * setField() for. A `data-tr-field` outside this set NEVER hydrates — its
 * literal is frozen at bake time. Keep in sync with that file.
 *
 * The retired keys map to their live successors: `signal_count` was dropped in
 * v1.10.0 (OUTPUT-SANITIZE-W1 C5) in favour of `call_count`.
 */
const RETIRED_TR_HOOKS = Object.freeze({
  signal_count: 'call_count',
  total_calls: 'call_count',
  merkle_batches: 'merkle_batch_count',
});

/**
 * Normalise track-record hooks + numbers in upstream-authored body HTML.
 *
 * Mirrors `scripts/refresh-integrations-numbers.mjs` (the committed-page
 * refresher) so both paths agree byte-for-byte — a page is identical whether it
 * was re-rendered from source or refreshed in place. Single-derivation: both
 * read the same SNAPSHOT + venue SoT.
 */
function normaliseTrackRecordBody(bodyHtml) {
  let out = bodyHtml;
  for (const [dead, live] of Object.entries(RETIRED_TR_HOOKS)) {
    out = out.replaceAll(`data-tr-field="${dead}"`, `data-tr-field="${live}"`);
  }
  const setField = (key, value) =>
    (out = out.replace(
      new RegExp(`(<span data-tr-field="${key}">)[^<]*(</span>)`, 'g'),
      `$1${value}$2`,
    ));
  setField('pfe_wr', SNAPSHOT.pfeWr);
  setField('call_count', SNAPSHOT.callCount);
  setField('batch_count', SNAPSHOT.batchCount);
  setField('merkle_batch_count', SNAPSHOT.batchCount);
  setField('exchange_count', String(SOT_EXCHANGE_COUNT));
  if (SNAPSHOT.assetCount) setField('asset_count', SNAPSHOT.assetCount);
  return out;
}

function techArticleSchema(exchange, display) {
  // WEBSITE-REFRESH-W1 follow-up: replaced HowTo (deprecated by Google for
  // SERP rich results in Aug 2023) with TechArticle, which IS rich-result
  // eligible. The HowTo was valid markup but produced "No items detected"
  // in Google's Rich Results Test — TechArticle resolves that.
  // W2 CH1 R2 — resolve both dates, then ASSERT the ordering invariant. A violation is a HALT,
  // never a clamp: silently clamping would re-publish a plausible-looking date that no commit
  // supports, which is the class this chapter exists to retire.
  const published = DATE_PUBLISHED[exchange] ?? DEFAULT_DATE_PUBLISHED;
  // max(), not a clamp on a detected violation: a page cannot have been modified before it
  // was published, and a source committed to algovault-skills BEFORE its mirror was added
  // here would otherwise trip the invariant below through no fault of the data. Measured
  // 2026-08-26 it never fires — source >= published on all 25 — so it is a guard, not a lever.
  const sourceModified = sourceModifiedDate(exchange);
  const modified = sourceModified > published ? sourceModified : published;
  if (!(published <= modified && modified <= SNAPSHOT.date)) {
    throw new Error(
      `[render] date invariant violated for '${exchange}': ` +
      `datePublished=${published} <= dateModified=${modified} <= today=${SNAPSHOT.date} is false. ` +
      `Re-derive with: git log --diff-filter=A --format=%aI -- landing/integrations/${exchange}.html | tail -1`,
    );
  }
  const canonical = `https://algovault.com/integrations/${exchange}`;
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "headline": `AlgoVault × ${display} - Build Verifiable AI Trading Agents`,
    "url": canonical,
    "datePublished": `${published}T00:00:00+00:00`,
    "dateModified": `${modified}T15:00:00+00:00`,
    "author": { "@type": "Organization", "name": "AlgoVault Labs", "url": "https://algovault.com" },
    "publisher": { "@type": "Organization", "name": "AlgoVault Labs", "url": "https://algovault.com", "logo": { "@type": "ImageObject", "url": "https://algovault.com/logo.png", "width": 512, "height": 512 } },
    "image": { "@type": "ImageObject", "url": "https://algovault.com/logo.png", "width": 512, "height": 512 },
    // OPS-INTEGRATIONS-LIVE-SOT-W1: crawler-facing prose carries NO volatile
    // number. Meta + JSON-LD cannot self-heal (no client proxy runs for a
    // crawler), so a baked figure here rots permanently — the class is killed
    // by removing the number, not by refreshing it. Body spans keep the numbers.
    "description": DESCRIPTIONS[exchange] ?? `Pair AlgoVault MCP's composite verdict (verifiable, Merkle-anchored on Base L2 across our supported exchanges) with ${display}'s execution kit to ship a complete trading agent. Demo runs testnet/demo only — zero real-money risk in any code path.`,
    "proficiencyLevel": "Intermediate|Advanced",
    "about": { "@type": "Thing", "name": `${display} integration with AlgoVault MCP composite verdict` }
  };
}

// ─── Notes that used to ship as HTML comments INSIDE this template ────────────────────────
// BINANCE-AGENT-OS-GEO-AND-SUBMISSIONS-W2 CH1 R3. A `//` comment never renders; an `<!-- -->`
// comment inside a template literal IS PUBLIC COPY. Eight flavoured comments per page reached
// View Source on all 25 rendered pages, one of them quoting an internal directive by name.
// Nothing is lost here — the notes moved from the shipped artifact to the source file, which is
// where they always belonged. Enforced going forward by scripts/check-rendered-comment-hygiene.mjs.
//
//   · WEBSITE-REFRESH-W1 C1  — the <meta name="last-updated"> snapshot date for the static
//                              numbers below; live source /api/performance-public + /api/merkle-batches.
//   · WEBSITE-REFRESH-W1 C7  — the Schema.org TechArticle block, for Google rich-results.
//   · WEBSITE-REFRESH-W1 C7  — the quotable-factoid block (Schema.org Claim) for LLM citation.
//                              PRESERVED byte-identical per the W10 preservation LAW.
//   · NAV-PLATFORM-GENERATOR-W1 (A1) — the unified nav region; scripts/build_nav.mjs injects
//                              between NAV:START/NAV:END. This generator emits the markers only.
//   · DESIGN-W10 / C3        — canonical hero scaffolding (artboard + 3 bg layers + VEyebrow)
//                              and the canonical Footer, verbatim from live algovault.com.
//   · DESIGN-W10-FF-2 (2026-05-12) — tier-stat-card per-section wrapping RESTORED; the W10-FF-1
//                              removal was based on a misread directive. The clarification was
//                              that "remove this section" meant the TL;DR section content, not
//                              the visual section cards. wrapH2InTierStatCard() wraps each H2
//                              section; stripTLDRSection() removes the redundant TL;DR first so
//                              it does not become an empty card.
//
// The design-loader BEGIN:/END: pair STAYS in the HTML — it is a functional marker other tooling
// keys on. Only its `(DESIGN-W2 / D2-C)` parenthetical was stripped; the marker text is untouched.
function htmlShell(exchange, bodyHtml) {
  const title = pageTitle(exchange);
  const display = DISPLAY_NAMES[exchange] ?? (exchange.charAt(0).toUpperCase() + exchange.slice(1));
  const description = `Pair AlgoVault MCP's verifiable, Merkle-anchored composite verdict across our supported exchanges with ${display}'s agent execution kit. Free testnet demo — zero real-money risk in any code path.`;
  const canonical = `https://algovault.com/integrations/${exchange}`;
  const techArticle = JSON.stringify(techArticleSchema(exchange, display), null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" href="/logo.png">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<meta name="last-updated" content="${SNAPSHOT.date}">
<script src="https://cdn.tailwindcss.com"></script>
<!-- BEGIN: AlgoVault canonical design loader -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/_design/algovault-design.css">
<!-- END: AlgoVault canonical design loader -->
<script defer src="/js/track-record-proxy.js"></script>
<script type="application/ld+json">
${techArticle}
</script>
<!-- ANALYTICS:START -->
<!-- ANALYTICS:END -->
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        navy: { 900: '#060a14', 800: '#0a0e1a', 700: '#0f1526', 600: '#161d30' },
        mint: { 50: 'oklch(0.97 0.03 165)', 100: 'oklch(0.94 0.06 165)', 200: 'oklch(0.91 0.09 165)', 300: 'oklch(0.89 0.13 165)', 400: 'oklch(0.86 0.16 165)', 500: 'oklch(0.78 0.18 165)', 600: 'oklch(0.66 0.18 165)', 700: 'oklch(0.54 0.16 165)', 800: 'oklch(0.42 0.12 165)', 900: 'oklch(0.32 0.08 165)' },
        steel: { 400: '#8b9bb5', 500: '#7b8ca0', 600: '#5e6d82' }
      }
    }
  }
}
</script>
<style>
  html { scroll-behavior: smooth; }
  /* DESIGN-W10 / C3 / Q-W10-10 cascade: use canonical CSS variables for body background.
     algovault-design.css defines --bg / --fg / --fg-2 / --fg-3 / --line / --mint tokens. */
  body { background: var(--bg); color: var(--fg-2, #d1d5db); font-family: var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); margin: 0; padding: 0; }
  /* Inline code + pre code — neutral colors preserved (no gold per DESIGN-W10 swap).
     Build Rule 8 exemption applies to syntax-highlighting inline color spans inside
     code blocks (preserved if present in markdown source). */
  code { font-family: var(--font-mono, 'SF Mono', 'Fira Code', 'Cascadia Code', monospace); background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { overflow-x: auto; background: oklch(0.13 0.012 265); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 16px 0; }
  pre code { background: none; padding: 0; font-size: 0.85em; line-height: 1.6; color: var(--fg); }
  /* DESIGN-W10 / C3: article headings — gold (#d4b255 / #c4a34a) → var(--fg) neutral. */
  article h1 { font-size: 2.25rem; font-weight: 700; margin: 0 0 0.5em; color: var(--fg); }
  article h2 { font-size: 1.6rem; font-weight: 600; margin: 0 0 0.5em; color: var(--fg); padding-top: 0; border-top: none; }
  article h3 { font-size: 1.2rem; font-weight: 600; margin: 1.25em 0 0.4em; color: var(--fg-2); }
  article p { margin: 0.75em 0; line-height: 1.7; }
  article ul, article ol { margin: 0.75em 0; padding-left: 1.5em; line-height: 1.7; }
  article li { margin: 0.25em 0; }
  /* DESIGN-W10 / C3: article links — gold → var(--mint). */
  article a { color: var(--mint); text-decoration: underline; }
  article a:hover { filter: brightness(1.1); }
  article strong { color: var(--fg); font-weight: 600; }
  /* DESIGN-W10 / C3: blockquote — gold accent → mint. */
  article blockquote { border-left: 3px solid var(--mint); padding-left: 16px; margin: 1em 0; color: var(--fg-3); font-style: italic; background: oklch(0.86 0.16 165 / 0.05); padding: 12px 16px; border-radius: 0 4px 4px 0; }
  article table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  article th, article td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  article th { color: var(--fg); font-weight: 600; }
  article hr { border: none; border-top: 1px solid var(--line); margin: 2em 0; }
</style>
</head>
<body>
${NAV_REGION_MARKERS}

<main class="lp-integrations-desktop">
  <div class="artboard" style="padding:100px 24px 64px;max-width:1024px;margin:0 auto;width:100%">
    <div class="bg-grid"></div>
    <div class="bg-radial-accent"></div>
    <div class="bg-noise"></div>
    <div style="position:relative;z-index:1">
      <div class="placeholder-cap" style="margin-bottom:14px">· ${exchange} integration</div>
      <p class="quotable-fact" style="background: rgba(16,185,129,0.05); border-left: 3px solid #10b981; padding: 12px 16px; margin: 0 0 24px; border-radius: 0 4px 4px 0; color: #6ee7b7; font-size: 0.95em;" itemscope itemtype="https://schema.org/Claim">
        <span itemprop="claimReviewed">AlgoVault has <strong style="color:#a7f3d0"><span data-tr-field="pfe_wr">${SNAPSHOT.pfeWr}</span></strong>+ PFE Win Rate across <strong style="color:#a7f3d0"><span data-tr-field="call_count">${SNAPSHOT.callCount}</span></strong>+ signal calls, each Merkle-anchored on Base L2 (verifiable at <a href="/track-record" itemprop="url" style="color:#d4b255">algovault.com/track-record</a>).</span>
      </p>
      <article>
${wrapH2InTierStatCard(stripInternalHeadingAnnotations(stripTLDRSection(stripSnapshotBlock(bodyHtml))))}
      </article>
    </div>
  </div>
</main>

${CANONICAL_FOOTER_HTML}
</body>
</html>
`;
}

/**
 * PRICING TOKENS (PRICING-FOLLOWUPS-GENERATOR-W1 CH3, ruling G-B).
 *
 * Tutorial sources carry `{{PRICING.<key>}}` instead of hand-typed ladder literals, so a price
 * or quota change is a token re-emit rather than a sweep across every tutorial. CH7 of the prior
 * wave fixed the RENDERED pages while their sources still said "100 calls/month" — the next
 * render would have silently reverted it, which is the class this retires.
 *
 * FAIL-CLOSED. An unresolved placeholder aborts the whole render: passing `{{PRICING.foo}}`
 * through to a published page is worse than a stale literal, because it is visibly broken AND
 * still wrong, and a silent passthrough is how a typo'd key would ship unnoticed.
 */
const PRICING_TOKENS = JSON.parse(
  await readFile(join(ROOT, 'ops', 'pricing-tokens.json'), 'utf8'),
).tokens;

function substitutePricingTokens(md, srcPath) {
  const out = md.replace(/\{\{PRICING\.([a-z0-9_]+)\}\}/g, (whole, key) => {
    const v = PRICING_TOKENS[key];
    if (typeof v !== 'string') {
      throw new Error(
        `[render] unknown pricing token ${whole} in ${srcPath}\n` +
        `         known keys: ${Object.keys(PRICING_TOKENS).join(', ')}\n` +
        `         (regenerate with: node scripts/emit-pricing-tokens.mjs)`,
      );
    }
    return v;
  });
  const leftover = out.match(/\{\{PRICING\.[^}]*\}\}/);
  if (leftover) throw new Error(`[render] unresolved pricing placeholder ${leftover[0]} in ${srcPath}`);
  return out;
}

async function renderOne(exchange) {
  const srcPath = getSrcPath(exchange);
  const dstPath = join(TARGET_DIR, `${exchange}.html`);
  let mdSource = substitutePricingTokens(await readFile(srcPath, 'utf8'), srcPath);

  // SEO-STRIP-TRACKING-PARAMS-W1: strip the utm_* tracking triple from the
  // INTERNAL algovault.com/track-record link in the rendered (web) mirror.
  // An internal utm_source makes Google treat /track-record?utm_… as a
  // duplicate of the canonical /track-record (crawl-budget waste + mixed
  // canonical signals; Google "Consolidate duplicate URLs") and makes GA-style
  // analytics start a NEW acquisition mid-session. The GitHub-facing markdown
  // KEEPS its ?utm_source=tutorial&utm_medium=repo variant (out of scope — that
  // renders on github.com, not algovault.com). Idempotent: a link with no query
  // no longer matches. (Superseded the prior repo→web channel rewrite, which
  // only relabeled the medium instead of removing the internal tracking param.)
  mdSource = mdSource.replace(
    /(https:\/\/algovault\.com\/track-record)\?utm_source=tutorial&utm_medium=(?:repo|web)&utm_campaign=integration-[a-z0-9-]+/g,
    '$1',
  );

  let bodyHtml = md.render(mdSource);
  // SEO-STRIP-TRACKING-PARAMS-W1: with the utm_campaign removed above, preserve the
  // per-exchange click attribution on the (now clean) body track-record link(s) via a
  // Plausible custom event — same pattern as the /integrations index cards
  // (renderIndexCard). Body links only: md.render emits `<a href="…/track-record">`
  // with an IMMEDIATE `>`, whereas the nav/drawer /track-record links (injected later
  // by build_nav) carry class attributes, so they never match this pattern.
  bodyHtml = bodyHtml.replace(
    /<a href="https:\/\/algovault\.com\/track-record">/g,
    `<a href="https://algovault.com/track-record" onclick="if(window.plausible)plausible('CTA Click',{props:{source:'integration_tutorial',slug:'${exchange}',campaign:'track-record'}})">`,
  );
  // AUTO-TRACE-W1 (2026-04-30): wrap the literal capability counter "N
  // exchanges" with the live-proxy span so every re-render preserves the
  // auto-update behavior. The upstream MD source is owned by the
  // algovault-skills repo; doing the wrap here keeps the post-process
  // localized and means the upstream MD doesn't have to know about the
  // proxy contract. Idempotent: re-running on already-wrapped HTML is a
  // no-op because the digits are then followed by "</span>", not " exchanges".
  //
  // OPS-INTEGRATIONS-LIVE-SOT-W1: matches ANY digit count, not just the
  // upstream's hardcoded "5", and NORMALISES it to the venue SoT. Upstream MD
  // still says "5 exchanges"; rather than requiring an external-repo edit to
  // correct it, the generator now rewrites whatever number it finds to
  // SOT_EXCHANGE_COUNT — so an out-of-date upstream can no longer leak a wrong
  // count onto a public page.
  bodyHtml = bodyHtml.replace(
    /(?<!data-tr-field="exchange_count">)\b\d+ exchanges\b/g,
    `<span data-tr-field="exchange_count">${SOT_EXCHANGE_COUNT}</span> exchanges`,
  );

  // OPS-SKILLS-MAF-COPY-W1 (2026-07-25): sibling to the "N exchanges" wrap above,
  // for the hardcoded VENUE count the tutorials also carried ("5 crypto perp
  // venues" / "the 5 venues"). Unlike the exchange count there is NO live-bind
  // hook for venues, so the fix is to describe coverage qualitatively rather than
  // enumerate it — exactly what the forward-stability rule requires. The upstream
  // .md sources were corrected in the same wave (algovault-skills 01b11cb); this
  // generator rule makes the class structurally unable to return if a future
  // tutorial edit reintroduces a venue count (e.g. binance.md still says "the 5
  // venues"). The `(?<!">)` guard + the required whitespace after the digits mean
  // a live-bind span (`…">15</span> venues`) can never match. Idempotent:
  // count-free output leaves no digit to re-match.
  bodyHtml = bodyHtml
    .replace(
      /(?<!">)\b\d+\s+crypto\s+perp(?:etual)?(?:[-\s]futures)?\s+venues\b/gi,
      'major crypto perpetual-futures venues',
    )
    .replace(/(?<!">)\b\d+\s+venues\b/gi, 'venues');

  // OPS-INTEGRATIONS-VENUE-PAGES-W1 — body-content normalisation (the
  // structural half of the fix).
  //
  // Everything above normalises only what THIS generator authors. The tutorial
  // BODY comes from the algovault-skills repo, and it used to pass through raw
  // — so an upstream `.md` carrying a retired literal or a dead live-proxy hook
  // leaked it straight onto a public page. That is exactly how `89.4%` /
  // `56,375` / `data-tr-field="signal_count"` survived from 2026-04-26 to
  // 2026-07-19, and re-running this generator would have re-introduced them
  // even after the rendered pages were corrected.
  //
  // Now the generator is the single normalisation point: whatever the upstream
  // says, the rendered page carries live-hydrating hooks and live numbers. The
  // upstream sources were corrected in the same wave, but this makes the class
  // structurally unable to return the next time someone edits a tutorial there.
  bodyHtml = normaliseTrackRecordBody(bodyHtml);

  const html = htmlShell(exchange, bodyHtml);
  await writeFile(dstPath, html);
  console.log(`[render] ${exchange}.md -> landing/integrations/${exchange}.html (${html.length} bytes)`);
}

async function main() {
  await mkdir(TARGET_DIR, { recursive: true });
  // OPS-INTEGRATIONS-LIVE-SOT-W1: read the numbers ONCE, before any page
  // renders, so all 16 mirrors carry an identical, live snapshot.
  SNAPSHOT = await fetchSnapshot();
  console.log(
    `[render] snapshot ${SNAPSHOT.live ? 'LIVE' : 'FALLBACK (SoT unreachable — rendering floor)'}` +
    ` pfeWr=${SNAPSHOT.pfeWr} callCount=${SNAPSHOT.callCount} batchCount=${SNAPSHOT.batchCount}` +
    ` assetCount=${SNAPSHOT.assetCount} exchanges=${SOT_EXCHANGE_COUNT} date=${SNAPSHOT.date}`,
  );
  console.log(`[render] source(exchanges + frameworks)=${SOURCE_DIR}`);
  console.log(`[render] source(mcp-clients)=${LOCAL_MCP_CLIENTS_DIR}`);
  console.log(`[render] target=${TARGET_DIR}`);

  // PRE-FLIGHT every date BEFORE writing a single page, so a refusal is ATOMIC.
  //
  // Measured 2026-08-26 while proving AC5: resolving dates inside the render loop meant a slug
  // that refused mid-run had already written every page before it — the `--source /nonexistent`
  // probe refused at `okx` and left `binance.html` on disk as a BARE page, missing the nav and
  // analytics regions the later generators inject. Seven tests failed on that one file, and none
  // of them named the cause. "Emits no page" has to mean no page, or a failed render leaves the
  // tree in a state worse than not having run at all.
  //
  // sourceModifiedDate() memoises, so this costs one `git log` per slug and the loop below reuses
  // every answer.
  for (const slug of ALL_TARGETS) sourceModifiedDate(slug);

  for (const slug of ALL_TARGETS) {
    await renderOne(slug);
  }
  console.log(`[render] OK — ${ALL_TARGETS.length} HTML mirrors written (${EXCHANGES.length} exchanges + ${FRAMEWORKS.length} frameworks + ${MCP_CLIENTS.length} mcp-clients)`);
}

main().catch((err) => {
  console.error('[render] FATAL:', err);
  process.exit(1);
});
