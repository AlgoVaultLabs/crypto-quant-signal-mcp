#!/usr/bin/env node
/**
 * ATTRIBUTION-SRC-COVERAGE-W1 — guard against the acquisition "untagged connect URL" class.
 *
 * The acquisition funnel attributes each MCP connection to a channel via a `?src=<slug>`
 * query on the remote connect URL (`https://api.algovault.com/mcp?src=<slug>`), captured at
 * the connection layer and bucketed in `/api/admin/funnel-snapshot.by_source` (see
 * ATTRIBUTION-CONNECTION-SRC-W1, src/lib/attribution-sources.ts). A connection snippet that
 * ships WITHOUT a `?src=` slug silently lands in the `unknown` bucket — the acquisition
 * source for that whole channel is lost, with no error. This audit fails CI when any in-repo
 * connection URL is missing its `?src=` slug (or carries a slug not in the SoT enum), making
 * "forgot to tag the new listing" structurally impossible — the same way OPS-CADDY-ROUTE-
 * PARITY-W1 retired the apex-Caddy allowlist-gap 404 class.
 *
 *   node scripts/check-attribution-src-coverage.mjs --check   # exit 1 on any untagged/bad-slug connect URL
 *
 * tests/unit/attribution-src-coverage.test.mjs imports `auditAttributionSrcCoverage()` so the
 * pre-push test-gate (node --test) + deploy.yml block a push that introduces an untagged URL.
 * NOT a runtime dependency.
 *
 * ── Scan scope ────────────────────────────────────────────────────────────────────────────
 *   • src/lib/integrations-data/mcp-clients.ts   (the /docs + /integrations index snippets)
 *   • every *.md under docs/integrations/ (recursive — any subdirectory)
 * Both are the SOURCES that render to landing/**; tagging the source closes the gap once.
 *
 * ── What counts as a connection URL ───────────────────────────────────────────────────────
 * Any `https://api.algovault.com/mcp…` token in a connect/config position: the JSON `"url":`
 * field, the `mcp-remote …/mcp…` arg/CLI form, the `claude mcp add … …/mcp…` CLI form, the
 * UI "URL: `…/mcp…`" paste line, and the URL string/template literals in mcp-clients.ts.
 * Each MUST carry a non-empty `?src=<slug>` whose slug is a member of ATTRIBUTION_SOURCES
 * (extracted live from src/lib/attribution-sources.ts at probe time — never hard-coded —
 * so a typo'd slug fails the gate here instead of silently resolving `unknown` at runtime).
 *
 * ── Documented false-positive exclusions (NOT flagged) ────────────────────────────────────
 *   • The raw-`curl` diagnostic (`curl … https://api.algovault.com/mcp …`, e.g. mcp-clients.ts
 *     and landing/docs.html "test your key" block) — a troubleshooting example, not an
 *     acquisition listing. Skipped when the URL's same-line prefix contains `curl`.
 *   • Bare-hostname prose (`api.algovault.com/account`, `algovault.com` mentions) — not a
 *     connect URL; never matches the `…/mcp` token.
 *   • smithery.md documents ONLY the `@smithery/cli` install (no raw remote URL on the page);
 *     it is connect-uncapturable via this page (attribution rides the Smithery registry-
 *     listing's own `?src=smithery`). It carries no `…/mcp` token, so it passes by
 *     construction — there is nothing to tag here.
 *
 * ── Out of scope this wave (do NOT scan — would self-inflict a red gate) ───────────────────
 *   README.md, server.json, lobehub-manifest.json, DXT manifest.json — their `?src=github`
 *   etc. ride the NEXT `RELEASE-vX.Y.Z` per the daily-release cadence LAW and are not tagged
 *   yet. The rendered landing/** HTML is derived from the scanned sources (tagging the source
 *   covers it). Add README/manifests to SCAN_FILES in the release wave that tags them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files scanned in addition to the per-platform markdown tutorials. */
const SCAN_FILES = ['src/lib/integrations-data/mcp-clients.ts'];
/**
 * Tutorial-markdown ROOT, walked RECURSIVELY.
 *
 * BINANCE-AGENT-OS-TRUTH-AND-PAGE-W1 CH2 R2 widened this from the literal
 * `docs/integrations/mcp-clients` to the whole tree. A literal directory means a new
 * tutorial directory escapes the `?src=` gate simply by existing — and CH2 adds exactly
 * such a directory (`docs/integrations/exchange-kits/`). Scope widening only: what counts
 * as a connect URL, and the slug set it is checked against, are unchanged.
 */
const DOCS_MD_ROOT = 'docs/integrations';

/** The live remote MCP connect URL + any trailing query/path up to a delimiter. */
const CONNECT_URL_RE = /https?:\/\/api\.algovault\.com\/mcp[^\s"'`\\<>)]*/g;
/** The `?src=<slug>` query value (first wins). */
const SRC_RE = /[?&]src=([^&\s"'`\\<>)]+)/;

/**
 * Extract the canonical acquisition-source slug set EXHAUSTIVELY from the SoT file at probe
 * time (never a hard-coded sample — see exhaustive-canonical-set-regex-for-coverage-probe).
 * A tagged slug outside this set fails the gate (defense-in-depth atop runtime default-deny).
 */
export function loadEnumSlugs() {
  const txt = readFileSync(join(ROOT, 'src/lib/attribution-sources.ts'), 'utf8');
  const block = txt.match(/ATTRIBUTION_SOURCES\s*=\s*\[([\s\S]*?)\]\s*as const;/);
  if (!block) throw new Error('ATTRIBUTION_SOURCES enum not found in src/lib/attribution-sources.ts');
  const slugs = new Set([...block[1].matchAll(/['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]));
  if (slugs.size === 0) throw new Error('ATTRIBUTION_SOURCES enum parsed empty — regex drift?');
  return slugs;
}

/** Scan targets: SCAN_FILES + every *.md anywhere under DOCS_MD_ROOT (repo-relative paths). */
export function scanTargets() {
  const targets = [...SCAN_FILES];
  const walk = (rel) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (e.name.endsWith('.md')) targets.push(`${rel}/${e.name}`);
    }
  };
  walk(DOCS_MD_ROOT);
  return targets.sort();
}

/**
 * Audit every in-repo connection URL for a valid `?src=` slug.
 * Returns { untagged: [{file, snippet}], invalidSlug: [{file, slug, snippet}], scanned }
 * — empty untagged + empty invalidSlug = coverage OK. `scanned` = connect URLs checked.
 */
export function auditAttributionSrcCoverage() {
  const enumSlugs = loadEnumSlugs();
  const untagged = [];
  const invalidSlug = [];
  let scanned = 0;
  for (const rel of scanTargets()) {
    const txt = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of txt.matchAll(CONNECT_URL_RE)) {
      const lineStart = txt.lastIndexOf('\n', m.index) + 1;
      const prefix = txt.slice(lineStart, m.index);
      if (/\bcurl\b/.test(prefix)) continue; // FP: raw-curl troubleshooting example, not a connect listing
      scanned++;
      const lineEnd = txt.indexOf('\n', m.index);
      const line = txt.slice(lineStart, lineEnd === -1 ? txt.length : lineEnd).trim();
      const snippet = line.length > 160 ? line.slice(0, 157) + '…' : line;
      const src = m[0].match(SRC_RE);
      if (!src || !src[1]) {
        untagged.push({ file: rel, snippet });
      } else if (!enumSlugs.has(src[1].toLowerCase())) {
        invalidSlug.push({ file: rel, slug: src[1], snippet });
      }
    }
  }
  return { untagged, invalidSlug, scanned };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { untagged, invalidSlug, scanned } = auditAttributionSrcCoverage();
  if (scanned === 0) {
    console.error('[attribution-src-coverage] FAIL — 0 connection URLs found in scope. Did the scan scope move? Check SCAN_FILES + docs/integrations/**/*.md.');
    process.exit(1);
  }
  if (untagged.length === 0 && invalidSlug.length === 0) {
    console.log(`[attribution-src-coverage] OK — ${scanned} connection URL(s) scanned; all carry a valid ?src= slug.`);
    process.exit(0);
  }
  if (untagged.length) {
    console.error(`[attribution-src-coverage] FAIL — ${untagged.length} connection URL(s) missing a ?src= slug (would bucket as \`unknown\` in /api/admin/funnel-snapshot.by_source):`);
    for (const u of untagged) console.error(`  ${u.file}: ${u.snippet}`);
  }
  if (invalidSlug.length) {
    console.error(`[attribution-src-coverage] FAIL — ${invalidSlug.length} connection URL(s) carry a ?src= slug not in ATTRIBUTION_SOURCES (would resolve \`unknown\` at runtime):`);
    for (const b of invalidSlug) console.error(`  ${b.file}: ?src=${b.slug}   ${b.snippet}`);
  }
  console.error('\nFix: append `?src=<slug>` (slug ∈ src/lib/attribution-sources.ts ATTRIBUTION_SOURCES) to the connection URL, then re-render —');
  console.error('  `node scripts/render-integrations.mjs --source <skills-worktree>` for docs/integrations/**/*.md, or `npm run build:landing` for mcp-clients.ts.');
  process.exit(1);
}
