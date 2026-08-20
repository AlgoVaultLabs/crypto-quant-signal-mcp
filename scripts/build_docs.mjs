#!/usr/bin/env node
/**
 * build_docs.mjs — DOCS-GENERATOR-FROM-NAV-SOT-W1 (CH3)
 *
 * Regenerates landing/docs.html from ONE source of truth (src/lib/docs-outline.ts →
 * dist) × the content partials in docs-src/partials/. The sidebar, the body section
 * order, and every anchor id all PROJECT from the outline (Single-Derivation LAW).
 *
 * BUILD ORDER: tsc → build_docs → build_landing → build_asset_versions → build_nav →
 * build_analytics. build_docs owns the page STRUCTURE; the regions below belong to OTHER
 * builders and are CARRIED OVER from the existing landing/docs.html rather than re-emitted
 * from the template (`foreignMarkerRegions` / `preserveForeignMarkers`):
 *   - <!-- NAV:START/END -->             build_nav owns it
 *   - <!-- ANALYTICS:START/END -->       build_analytics owns it
 *   - <!-- BUILD:signup-flow:* -->       inside the pricing partial (build_landing fills)
 *   - <!-- BUILD:connect-mcp-client:* --> } the 3 Ecosystem connect surfaces —
 *   - <!-- BUILD:connect-ai-agent:* -->   } build_landing fills each via
 *   - <!-- BUILD:connect-exchange-kit:* -->} renderSurfaceSection(<surface>) (auto-follow)
 *
 * WHY CARRY OVER (OPS-DOCS-FOREIGN-MARKER-PRESERVE-W1, 2026-08-10). This generator writes
 * docs.html WHOLE-FILE from docs-src/template.html, so running it ALONE used to clobber every
 * region it does not own — and the two live regions failed in two different ways, which is why
 * "re-emit them empty and let the chain refill them" was never the safe default it reads as:
 *
 *   - ANALYTICS: the template's region is ZERO bytes, so a lone build_docs DELETED the Plausible
 *     snippet outright and shipped a docs page with no instrumentation.
 *   - NAV: the template carries a 15,922-byte HARDCODED nav whose links are
 *     `algovault.com/docs.html`, so a lone build_docs REVERTED the canonical `/docs` links that
 *     build_nav had injected. Not emptied — silently replaced with a stale copy, which is the
 *     same drift class the footer note below says FOOTER-UNIFY-W1 retired.
 *
 * `--check` could not catch either, BY CONSTRUCTION: its drift compare runs both sides through
 * `blankMarkers`, so a region this builder had just wrecked is the one thing it cannot see. It
 * failed downstream instead, at `build_nav --check` / `build_analytics --check` in CI, where it
 * reads as a mysterious unrelated failure. Measured 2026-08-10 during
 * PRICING-BADGES-LIMITED-TIME-W1: a one-paragraph docs edit produced `4 insertions, 8 deletions`,
 * 6 of them the analytics block and 2 the canonical `/docs` links.
 *
 * The preserve set and the blank set are derived from ONE declaration, so a region added to one
 * cannot be forgotten in the other — pinned by test in tests/build-docs-foreign-markers.test.ts.
 *
 * Modes:
 *   node scripts/build_docs.mjs                    — regenerate + write landing/docs.html (missing partial → exit 1)
 *   node scripts/build_docs.mjs --verify-partials  — assert every outline partial exists (exit 1 if any missing)
 *   node scripts/build_docs.mjs --check            — STRUCTURAL canary (sidebar===body===outline + registry counts
 *                                                     + partial coverage + no-drift ignoring downstream-filled markers)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_OUTLINE_DIST = path.join(REPO_ROOT, 'dist', 'lib', 'docs-outline.js');
const TOOL_PARAM_SCHEMA_DIST = path.join(REPO_ROOT, 'dist', 'lib', 'tool-param-schema.js');
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

/**
 * DOCS-PARAM-SCHEMA-PROJECTION-W1 — the tool-parameter rows THIS builder owns.
 *
 * `/docs` told integrators `get_trade_call` accepted five venues while `tools/list` published
 * seventeen, and named `1h` as scan's timeframe default while the server defaulted to `15m`. Both
 * rows were hand-typed, so `--check` — which compares BYTES — was green the whole time: a partial
 * may assert anything at all so long as the rendered page matches its source. These rows now
 * project from `dist/lib/tool-param-schema.js`, the same declaration the Zod schemas are built
 * from, so the served enum and the published table cannot disagree.
 *
 * 🛑 THESE ARE **NOT** `foreignMarkerRegions`, and registering them there would silently undo the
 * whole thing. That list means "a DOWNSTREAM builder owns this region", and it has two consumers:
 * `blankMarkers` (so `--check` ignores the region — the projection would stop being checked) and
 * `preserveForeignMarkers`, which UNCONDITIONALLY copies the region's existing on-disk content
 * over the freshly generated one. A projected region on that list is overwritten by its own stale
 * copy on every run: it renders once, then freezes forever, with a green `--check` reporting no
 * drift because it is no longer looking. build_docs fills these itself, so it keeps them.
 *
 * The `SCHEMA:` prefix is deliberate for the same reason: `BUILD:` is spelled out in three files
 * as "build_landing fills it", and reusing it for a region this builder owns would invite exactly
 * the mis-registration above.
 */
const schemaMarker = (tool) => ({
  start: `<!-- SCHEMA:tool-params:${tool}:start -->`,
  end: `<!-- SCHEMA:tool-params:${tool}:end -->`,
});

const CODE_CLS = 'text-xs bg-navy-800 px-1 rounded';

/**
 * One `<tr>` per enum parameter, generic over the schema — this function branches on no parameter
 * name, so a new enum parameter reaches `/docs` by appearing in the declaration and nowhere else.
 *
 * Every accepted value carries `data-enum-value`, which is what makes the rendered page
 * machine-comparable against live `tools/list` (`check-docs-samples-live.mjs` P7). The `Default:`
 * chip deliberately does NOT carry it: the default is also one of the accepted values, and tagging
 * it would double-count that venue and turn a set comparison into a multiset one.
 */
export function renderToolParamRows(tool, params, blurbs = {}) {
  const rows = [];
  for (const [name, spec] of Object.entries(params)) {
    const chips = spec.values
      .map((v) => `<code class="${CODE_CLS}" data-enum-value="${v}">${v}</code>`)
      .join(' ');
    const blurb = blurbs[name] ? `${blurbs[name]} ` : '';
    const dflt = spec.default ? ` Default: <code class="${CODE_CLS}">${spec.default}</code>` : '';
    // The default is machine-readable on the ROW, not on its chip: the gate compares it against the
    // served `default`, which is how `1h` on the page survived beside `15m` on the wire for months.
    const dfltAttr = spec.default ? ` data-schema-default="${spec.default}"` : '';
    rows.push(
      `          <tr class="param-row" data-schema-tool="${tool}" data-schema-param="${name}"${dfltAttr}>` +
        `<td>${name}</td><td class="text-gray-400">string</td>` +
        `<td class="text-gray-400">${blurb}${chips}.${dflt}</td></tr>`,
    );
  }
  return rows.join('\n');
}

/**
 * Fill every `SCHEMA:tool-params:<tool>` region from the compiled declaration.
 *
 * A declared tool whose marker is absent from the page is a hard error, not a silent skip: a
 * projection that lands nowhere is the same failure as a stale hand-typed row, minus the evidence.
 */
export function fillToolParamRegions(html, schemaMod) {
  let out = html;
  const filled = [];
  const missing = [];
  for (const [tool, params] of Object.entries(schemaMod.PUBLIC_TOOL_ENUM_PARAMS)) {
    const { start, end } = schemaMarker(tool);
    const si = out.indexOf(start);
    const ei = out.indexOf(end);
    if (si === -1 || ei === -1 || ei < si) { missing.push(tool); continue; }
    const rows = renderToolParamRows(tool, params, schemaMod.PARAM_DOC_BLURB);
    out = `${out.slice(0, si + start.length)}\n${rows}\n          ${out.slice(ei)}`;
    filled.push(tool);
  }
  return { html: out, filled, missing };
}

const closedSetMarker = (tool) => ({
  start: `<!-- SCHEMA:tool-closed-set:${tool}:start -->`,
  end: `<!-- SCHEMA:tool-closed-set:${tool}:end -->`,
});

/**
 * The CLOSED-SET table for one tool: one row per value, its alias, and what it selects.
 * DOCS-COMPLETENESS-AND-NAVIGATION-W1 CH1.
 *
 * A SEPARATE table from the parameter table above it, and that separation is load-bearing twice:
 *
 *   1. `check-docs-samples-live.mjs` `paramsTableFor` reads the FIRST `<table` in a section and
 *      `responseFieldsFor` reads the first one after the "Response Fields" heading. A lens table
 *      placed between them is invisible to both, so P7 keeps comparing parameters to parameters.
 *   2. The rows carry `data-enum-value` (which the CH1 gate asserts by identity) WITHOUT the row
 *      carrying `data-schema-param`. That matters: `rankBy` is `z.string().max(32)` and publishes
 *      NO `enum`, so a row advertising itself as schema-projected would make P7 red — correctly —
 *      on "renders a fixed value list but the live schema declares no enum". The docs enumerate a
 *      closed set; the API still accepts any string and `resolveRankBy` still owns validity.
 *
 * `class="param-row"` is reused for styling only (the template's `.param-row` rules), never as a
 * parse hook — both readers are table-scoped, so the class cannot be mistaken for a parameter here.
 */
export function renderToolClosedSetRows(tool, param, spec, aliasByCanonical) {
  const alias = aliasByCanonical(spec);
  const rows = spec.valueSource.map((v, i) => {
    const isLast = i === spec.valueSource.length - 1;
    const a = alias[v]
      ? `<code class="${CODE_CLS}">${alias[v]}</code>`
      : '<span class="text-gray-600">&mdash;</span>';
    const dflt = spec.default === v ? ' <span class="text-gray-500">(default)</span>' : '';
    return (
      `          <tr class="param-row"${isLast ? ' style="border-bottom:none"' : ''} data-closed-set-tool="${tool}" data-closed-set-param="${param}">` +
      `<td><code class="${CODE_CLS}" data-enum-value="${v}">${v}</code>${dflt}</td>` +
      `<td class="text-gray-400">${a}</td>` +
      `<td class="text-gray-400">${spec.selects[v]}</td></tr>`
    );
  });
  return rows.join('\n');
}

/**
 * Fill every `SCHEMA:tool-closed-set:<tool>` region from the compiled declaration.
 *
 * Same refusal contract as `fillToolParamRegions`: a declared tool whose marker is absent is a hard
 * error. A projection that lands nowhere is indistinguishable from a stale hand-typed row, minus
 * the evidence — which is the defect this whole wave exists to make impossible.
 */
export function fillToolClosedSetRegions(html, schemaMod) {
  let out = html;
  const filled = [];
  const missing = [];
  const decl = schemaMod.PUBLIC_TOOL_CLOSED_SET_PARAMS ?? {};
  for (const [tool, params] of Object.entries(decl)) {
    const { start, end } = closedSetMarker(tool);
    const si = out.indexOf(start);
    const ei = out.indexOf(end);
    if (si === -1 || ei === -1 || ei < si) { missing.push(tool); continue; }
    const body = Object.entries(params)
      .map(([param, spec]) => renderToolClosedSetRows(tool, param, spec, schemaMod.aliasByCanonical))
      .join('\n');
    out = `${out.slice(0, si + start.length)}\n${body}\n          ${out.slice(ei)}`;
    filled.push(tool);
  }
  return { html: out, filled, missing };
}

/**
 * THE ONE declaration of the regions build_docs does NOT own.
 *
 * Both consumers read it: `blankMarkers` (so the drift compare ignores them) and
 * `preserveForeignMarkers` (so a write does not clobber them). Two lists would drift, and the
 * failure mode is silent in exactly the direction that hurts — a region blanked for the compare
 * but not preserved on write is invisible to `--check` and destroyed on disk.
 */
export function foreignMarkerRegions(markerNames) {
  const regions = [
    { name: 'NAV', owner: 'build_nav', start: '<!-- NAV:START -->', end: '<!-- NAV:END -->' },
    { name: 'ANALYTICS', owner: 'build_analytics', start: '<!-- ANALYTICS:START -->', end: '<!-- ANALYTICS:END -->' },
    { name: 'BUILD:signup-flow', owner: 'build_landing', start: '<!-- BUILD:signup-flow:start -->', end: '<!-- BUILD:signup-flow:end -->' },
  ];
  for (const m of markerNames) {
    regions.push({ name: `BUILD:${m}`, owner: 'build_landing', start: `<!-- BUILD:${m}:start -->`, end: `<!-- BUILD:${m}:end -->` });
  }
  return regions;
}

/** Blank the inner of every downstream-filled marker so a drift compare ignores them. */
export function blankMarkers(html, markerNames) {
  let out = html;
  for (const { start, end } of foreignMarkerRegions(markerNames)) {
    const si = out.indexOf(start);
    const ei = out.indexOf(end);
    if (si !== -1 && ei !== -1 && ei >= si) out = out.slice(0, si + start.length) + out.slice(ei);
  }
  return out;
}

/**
 * Carry each foreign region's CURRENT on-disk content into the freshly generated page.
 *
 * 🛑 UNCONDITIONAL when the existing region is present — deliberately NOT "only when the
 * generated region is empty". That guard reads as the careful choice and would fix only half the
 * bug: the template's NAV region is not empty, it holds a stale hardcoded nav, so skipping
 * non-empty generated regions would leave `build_nav`'s canonical links being reverted on every
 * run. build_docs does not own these regions; whether the template happens to have something in
 * them is not evidence that it should win.
 *
 * Absent existing file (fresh checkout) → nothing to carry, template content stands and the
 * owning builder fills it on its next run. That is the pre-existing behaviour, unchanged.
 */
export function preserveForeignMarkers(generated, existing, markerNames) {
  let out = generated;
  const preserved = [];
  const skipped = [];
  for (const { name, start, end } of foreignMarkerRegions(markerNames)) {
    const xs = existing.indexOf(start);
    const xe = existing.indexOf(end);
    if (xs === -1 || xe === -1 || xe < xs) { skipped.push(name); continue; }   // not in the live page
    const inner = existing.slice(xs + start.length, xe);
    const gs = out.indexOf(start);
    const ge = out.indexOf(end);
    if (gs === -1 || ge === -1 || ge < gs) { skipped.push(name); continue; }   // not in the template
    if (out.slice(gs + start.length, ge) === inner) continue;                  // already identical
    out = out.slice(0, gs + start.length) + inner + out.slice(ge);
    preserved.push(name);
  }
  return { html: out, preserved, skipped };
}

/**
 * FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1 — emit the brand footer from the SoT.
 *
 * This generator writes landing/docs.html WHOLE-FILE from docs-src/template.html, so a footer
 * placed by scripts/inject-footer.mjs is dropped on the very next build. Measured: it was the one
 * page of 55 that regressed when the generators ran. Fix at the generator, not the lane.
 *
 * The footer is rendered from dist/lib/footer-content.js rather than pasted into the template —
 * a hardcoded copy in the template is exactly the drift class FOOTER-UNIFY-W1 retired.
 */
function renderFooterFromSot() {
  const dist = path.join(REPO_ROOT, 'dist', 'lib', 'footer-content.js');
  if (!fs.existsSync(dist)) {
    throw new Error(`build_docs: ${dist} not found. Run \`npm run build\` (tsc) first.`);
  }
  return createRequire(import.meta.url)(dist).renderBrandFooter('desktop');
}

function generate(outlineMod, schemaMod) {
  const flat = outlineMod.flattenOutline();
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  let html = template
    .replace(SIDEBAR_PLACEHOLDER, renderSidebar(flat))
    .replace(BODY_PLACEHOLDER, renderBody(flat))
    .replace(TECH_ARTICLE_PLACEHOLDER, outlineMod.techArticleToolClause());

  // Projected parameter rows, filled from the SAME declaration the Zod schemas are built from.
  const { html: projected, missing } = fillToolParamRegions(html, schemaMod);
  if (missing.length) {
    throw new Error(
      `build_docs: ${missing.length} declared tool(s) have no SCHEMA:tool-params marker in docs-src/: ` +
        `${missing.join(', ')} — the projection would land nowhere and the table would silently stay hand-typed`,
    );
  }
  html = projected;

  // Projected CLOSED-SET rows — values fixed at build time although Zod types them permissively.
  // Coverage first: a lens with no authored `selects` clause would render an empty description on
  // a public page, which is the same defect as the deferral this wave deletes.
  const gaps = schemaMod.assertClosedSetCoverage ? schemaMod.assertClosedSetCoverage() : [];
  if (gaps.length) {
    throw new Error(
      `build_docs: ${gaps.length} closed-set value(s) have no authored description: ${gaps.join(', ')} — ` +
        'add a `selects` clause in tool-param-schema.ts rather than shipping a blank cell',
    );
  }
  const closed = fillToolClosedSetRegions(html, schemaMod);
  if (closed.missing.length) {
    throw new Error(
      `build_docs: ${closed.missing.length} declared tool(s) have no SCHEMA:tool-closed-set marker in docs-src/: ` +
        `${closed.missing.join(', ')} — the projection would land nowhere`,
    );
  }
  html = closed.html;

  const idx = html.lastIndexOf('</body>');
  if (idx === -1) throw new Error('build_docs: template has no </body> to anchor the brand footer');
  return `${html.slice(0, idx)}${renderFooterFromSot()}\n${html.slice(idx)}`;
}

async function main() {
  if (!fs.existsSync(DOCS_OUTLINE_DIST)) {
    console.error(`build_docs: ${DOCS_OUTLINE_DIST} not found. Run \`npm run build\` (tsc) first.`);
    process.exit(2);
  }
  if (!fs.existsSync(TOOL_PARAM_SCHEMA_DIST)) {
    console.error(`build_docs: ${TOOL_PARAM_SCHEMA_DIST} not found. Run \`npm run build\` (tsc) first.`);
    process.exit(2);
  }
  const outlineMod = await import(DOCS_OUTLINE_DIST);
  const schemaMod = await import(TOOL_PARAM_SCHEMA_DIST);
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

  const generated = generate(outlineMod, schemaMod);

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

  // Carry over every region owned by a downstream builder, so running THIS builder alone is not
  // destructive. See the header note: the analytics region would otherwise be emptied and the nav
  // region reverted to the template's stale hardcoded copy.
  let toWrite = generated;
  let preserved = [];
  if (fs.existsSync(DOCS_HTML_PATH)) {
    const existing = fs.readFileSync(DOCS_HTML_PATH, 'utf8');
    ({ html: toWrite, preserved } = preserveForeignMarkers(generated, existing, markerNames()));
  }

  fs.writeFileSync(DOCS_HTML_PATH, toWrite, 'utf8');
  console.log(`build_docs: wrote landing/docs.html (${sidebarEntries().length} sidebar entries, ${partialIds().length} partials, ${markerNames().length} build_landing markers)`);
  console.log(
    preserved.length
      ? `build_docs: carried over ${preserved.length} foreign marker region(s) from the existing page: ${preserved.join(', ')}`
      : 'build_docs: no foreign marker region needed carrying over (already in sync)',
  );
}

// Entrypoint guard (CLAUDE.md: make entrypoints test-importable). `main()` calls process.exit and
// writes landing/docs.html, so a test importing the pure helpers above must not trigger it.
// Resolved through pathToFileURL on BOTH sides — a bare string compare of argv[1] against
// import.meta.url never matches (path vs file:// URL) and would silently disable the CLI.
const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((err) => {
    console.error('build_docs: fatal:', err);
    process.exit(2);
  });
}
