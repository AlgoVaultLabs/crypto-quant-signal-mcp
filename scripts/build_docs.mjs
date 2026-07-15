#!/usr/bin/env node
/**
 * build_docs.mjs — DOCS-GENERATOR-FROM-NAV-SOT-W1 (CH3)
 *
 * Regenerates landing/docs.html from ONE source of truth (src/lib/docs-outline.ts →
 * dist) × the content partials in docs-src/partials/. The sidebar, the body section
 * order, and every anchor id all PROJECT from the outline (Single-Derivation LAW).
 *
 * BUILD ORDER (A3): tsc → build_docs → build_landing → build_nav. build_docs owns the
 * page STRUCTURE and re-emits the downstream markers EMPTY:
 *   - <!-- NAV:START/END -->            kept verbatim from docs-src/template.html (build_nav owns it)
 *   - <!-- BUILD:signup-flow:* -->       inside the pricing partial (build_landing fills)
 *   - <!-- BUILD:connect-mcp-client:* --> } the 3 Ecosystem connect surfaces —
 *   - <!-- BUILD:connect-ai-agent:* -->   } build_landing fills each via
 *   - <!-- BUILD:connect-exchange-kit:* -->} renderSurfaceSection(<surface>) (auto-follow)
 *
 * Modes:
 *   node scripts/build_docs.mjs                    — regenerate + write landing/docs.html (missing partial → exit 1)
 *   node scripts/build_docs.mjs --verify-partials  — assert every outline partial exists (exit 1 if any missing)
 *   node scripts/build_docs.mjs --check            — STRUCTURAL canary (sidebar===body===outline + registry counts
 *                                                     + partial coverage + no-drift ignoring downstream-filled markers)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_OUTLINE_DIST = path.join(REPO_ROOT, 'dist', 'lib', 'docs-outline.js');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'docs-src', 'template.html');
const PARTIALS_DIR = path.join(REPO_ROOT, 'docs-src', 'partials');
const DOCS_HTML_PATH = path.join(REPO_ROOT, 'landing', 'docs.html');

const SIDEBAR_PLACEHOLDER = '<!--DOCS:SIDEBAR-->';
const BODY_PLACEHOLDER = '<!--DOCS:BODY-->';
// OPS-DOCS-JSONLD-TOOLCOUNT-W1: the <head> TechArticle JSON-LD tool clause, derived from the SoT.
const TECH_ARTICLE_PLACEHOLDER = '__TECH_ARTICLE_TOOLS__';

const checkMode = process.argv.includes('--check');
const verifyPartialsMode = process.argv.includes('--verify-partials');

// Heading tag + classes per outline level (page <h1> is the static "Documentation" title).
const TAG = { 1: 'h2', 2: 'h2', 3: 'h3', 4: 'h4' };
const HCLASS = {
  1: 'text-2xl font-bold text-white mb-5 mt-2 flex items-center gap-2',
  2: 'text-xl font-bold text-white mb-4 flex items-center gap-2',
  3: 'text-lg font-semibold text-white mb-3 mt-2 flex items-center gap-2',
  4: 'text-base font-semibold text-white mb-3 mt-2 flex items-center gap-2',
};
const sidebarIndent = (level) => `padding-left:${12 + (level - 1) * 10}px`;

function readPartial(id) {
  const p = path.join(PARTIALS_DIR, `${id}.html`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').replace(/\n$/, '');
}

function renderAliases(node) {
  return (node.aliases ?? []).map((a) => `<span id="${a}" aria-hidden="true"></span>`).join('');
}

/** Grouped sidebar: group nodes → non-link headers, leaves → sidebar-link, indented by level. */
function renderSidebar(flat) {
  const lines = [];
  for (const n of flat) {
    if (n.sidebarHidden) continue;
    if (n.body.kind === 'group') {
      lines.push(`    <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold mt-5 mb-2" style="${sidebarIndent(n.level)}">${n.label}</div>`);
    } else {
      lines.push(`    <a href="#${n.anchor}" class="sidebar-link" style="${sidebarIndent(n.level)}">${n.label}</a>`);
    }
  }
  return lines.join('\n');
}

/** Body: one block per node (outline order); dividers before top-level/H2 groups. */
function renderBody(flat) {
  const parts = [];
  let first = true;
  for (const n of flat) {
    if (n.level <= 2 && !first) parts.push('    <div class="border-t border-white/5 mb-16"></div>');
    first = false;
    const aliases = renderAliases(n);

    if (n.body.kind === 'marker') {
      // A self-contained integrations-data surface (renderSurfaceSection) fills this at
      // build_landing time with its own <h3 id="…"> + table — emit the marker EMPTY.
      parts.push(
        `    <div class="mb-16">${aliases}\n      <!-- BUILD:${n.body.name}:start -->\n      <!-- BUILD:${n.body.name}:end -->\n    </div>`,
      );
      continue;
    }

    const tag = TAG[n.level];
    const code = n.codeName ? ` <span class="text-gray-500 text-sm font-normal">${n.codeName}</span>` : '';
    let bodyHtml = '';
    if (n.body.kind === 'partial' || (n.body.kind === 'group' && n.body.intro)) {
      bodyHtml = readPartial(n.id);
      if (bodyHtml === null) bodyHtml = `      <!-- MISSING PARTIAL: ${n.id}.html -->`;
    }
    parts.push(
      `    <section id="${n.anchor}" class="mb-16">${aliases}\n` +
        `      <${tag} class="${HCLASS[n.level]}"><span class="text-mint-400">&#9670;</span> ${n.label}${code}</${tag}>\n` +
        `${bodyHtml}\n` +
        `    </section>`,
    );
  }
  return parts.join('\n\n');
}

/** Blank the inner of every downstream-filled marker so a drift compare ignores them. */
function blankMarkers(html, markerNames) {
  const pairs = [['<!-- NAV:START -->', '<!-- NAV:END -->'], ['<!-- ANALYTICS:START -->', '<!-- ANALYTICS:END -->'], ['<!-- BUILD:signup-flow:start -->', '<!-- BUILD:signup-flow:end -->']];
  for (const m of markerNames) pairs.push([`<!-- BUILD:${m}:start -->`, `<!-- BUILD:${m}:end -->`]);
  let out = html;
  for (const [s, e] of pairs) {
    const si = out.indexOf(s);
    const ei = out.indexOf(e);
    if (si !== -1 && ei !== -1 && ei >= si) out = out.slice(0, si + s.length) + out.slice(ei);
  }
  return out;
}

function generate(outlineMod) {
  const flat = outlineMod.flattenOutline();
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .replace(SIDEBAR_PLACEHOLDER, renderSidebar(flat))
    .replace(BODY_PLACEHOLDER, renderBody(flat))
    .replace(TECH_ARTICLE_PLACEHOLDER, outlineMod.techArticleToolClause());
}

async function main() {
  if (!fs.existsSync(DOCS_OUTLINE_DIST)) {
    console.error(`build_docs: ${DOCS_OUTLINE_DIST} not found. Run \`npm run build\` (tsc) first.`);
    process.exit(2);
  }
  const outlineMod = await import(DOCS_OUTLINE_DIST);
  const { partialIds, markerNames, sidebarEntries, allAnchorIds, toolNodeCount, channelNodeCount, flattenOutline } = outlineMod;

  // ── partial coverage (shared by --verify-partials and default write) ──
  const missing = partialIds().filter((id) => !fs.existsSync(path.join(PARTIALS_DIR, `${id}.html`)));

  if (verifyPartialsMode) {
    if (missing.length) {
      console.error(`build_docs --verify-partials: ${missing.length} MISSING partial(s):\n  ${missing.map((m) => `docs-src/partials/${m}.html`).join('\n  ')}`);
      process.exit(1);
    }
    console.log(`build_docs --verify-partials: OK — all ${partialIds().length} outline partials present`);
    process.exit(0);
  }

  if (missing.length) {
    console.error(`build_docs: ${missing.length} MISSING partial(s) — refusing to generate:\n  ${missing.map((m) => `docs-src/partials/${m}.html`).join('\n  ')}`);
    process.exit(1);
  }

  const generated = generate(outlineMod);

  if (checkMode) {
    const errors = [];
    // 1. counts
    if (toolNodeCount() !== 6) errors.push(`Tools count ${toolNodeCount()} !== 6 (registry publicListing)`);
    if (channelNodeCount() !== 4) errors.push(`Channels count ${channelNodeCount()} !== 4 (channel-registry)`);
    // 2. on-disk structure: sidebar (aside-scoped) + body ids cover the outline
    const onDisk = fs.readFileSync(DOCS_HTML_PATH, 'utf8');
    const aside = (onDisk.match(/<aside[\s\S]*?<\/aside>/) ?? [''])[0];
    const sidebarHrefs = new Set([...aside.matchAll(/class="sidebar-link"[^>]*href="#([a-z0-9-]+)"|href="#([a-z0-9-]+)"[^>]*class="sidebar-link"/g)].map((m) => m[1] ?? m[2]));
    for (const n of flattenOutline()) {
      if (n.sidebarHidden) continue;
      if (n.body.kind === 'group') {
        // group headers render as a non-link <div>…label…</div> in the sidebar
        if (!aside.includes(`>${n.label}</div>`)) errors.push(`sidebar group header missing: ${n.label}`);
      } else if (!sidebarHrefs.has(n.anchor)) {
        errors.push(`sidebar missing leaf link #${n.anchor} (${n.label})`);
      }
    }
    const bodyIds = new Set([...onDisk.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]));
    // Marker-node anchors (connect-*) are emitted by the DOWNSTREAM surface fill (build_landing →
    // renderSurfaceSection), not by build_docs — build_landing --check verifies those. build_docs
    // only owns partial/group section ids + alias spans, so exclude marker anchors here.
    const markerAnchors = new Set(flattenOutline().filter((n) => n.body.kind === 'marker').map((n) => n.anchor));
    for (const anchor of allAnchorIds()) {
      if (markerAnchors.has(anchor)) continue;
      if (!bodyIds.has(anchor)) errors.push(`docs.html body missing id="${anchor}" (dead-link / unrendered section)`);
    }
    // 3. no-drift (ignore downstream-filled markers)
    if (blankMarkers(generated, markerNames()) !== blankMarkers(onDisk, markerNames())) {
      errors.push('docs.html DRIFT vs generated (structure/partials changed but not rebuilt) — run `node scripts/build_docs.mjs`');
    }
    if (errors.length) {
      console.error(`build_docs --check: ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
      process.exit(1);
    }
    console.log('build_docs --check: OK — sidebar === body === outline; Tools=6, Channels=4; all anchors present; no drift');
    process.exit(0);
  }

  fs.writeFileSync(DOCS_HTML_PATH, generated, 'utf8');
  console.log(`build_docs: wrote landing/docs.html (${sidebarEntries().length} sidebar entries, ${partialIds().length} partials, ${markerNames().length} build_landing markers)`);
}

main().catch((err) => {
  console.error('build_docs: fatal:', err);
  process.exit(2);
});
