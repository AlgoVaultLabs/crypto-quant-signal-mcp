#!/usr/bin/env node
// @ts-check
/**
 * check-mcp-client-copy.mjs — the vendor-UI-path drift gate.
 *
 * LANDING-MCP-CLIENT-REGISTRY-W1 CH5.
 *
 * THE BUG CLASS: a vendor renames a menu, and our copy keeps naming the old one.
 * Claude Desktop moved custom MCP servers from `Settings → Integrations` to
 * `Settings → Connectors`. Three public surfaces had independently hardcoded the
 * old path — the landing quickstart, /faq (twice, prose AND its FAQPage JSON-LD
 * twin) and README (twice) — so the site spent months telling every visitor to
 * open a menu that is not there. Nothing failed. Nothing alerted. It was found by
 * reading the page.
 *
 * The registry retired the DUPLICATION. This retires the DRIFT: without it, the
 * next vendor rename recreates the identical defect, and detection without
 * enforcement is half a guard.
 *
 * WHY A SEPARATE SCRIPT from check-integrations-registry-lockstep.mjs, which
 * already walks the same registry: different evidence source. That canary proves
 * a SLUG is wired across its six homes; this one proves the COPY is not stale.
 * Same split as bot-deploy-parity.sh vs checkout-parity.sh. A copy-drift failure
 * surfacing under a script named "lockstep" mislabels itself for whoever reads
 * the CI log at 3am.
 *
 * DELIBERATELY NOT CHECKED: "every registry label appears on /integrations".
 * The lockstep canary owns that, and a second implementation of one assertion is
 * a second thing that can drift.
 *
 * Checks:
 *   1. FAIL — a retired vendor UI path in any rendered surface.
 *   2. FAIL — a byo-model row whose copy calls itself an MCP client.
 *   3. REPORT — a row whose `verifiedAt` is older than 180 days.
 *
 * Usage:
 *   node scripts/check-mcp-client-copy.mjs --self-test   # offline; proves both directions
 *   node scripts/check-mcp-client-copy.mjs               # scan the working tree
 *
 * Verdict: exactly one terminal `MCP_CLIENT_COPY_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Callers gate on the TOKEN, not the code (CLAUDE.md verdict-token law).
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE. 3 is the token-law default for a
 * NEW gate; do NOT "align" it to check_test_baseline.sh's 2, which is 2 only
 * because it already deployed that code.
 *
 * FAIL-CLOSED — there is no fail-open branch. An unreadable file, a missing
 * registry, or an empty corpus is INDETERMINATE and blocks.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';

// The registry is a tsc-emitted CJS module. createRequire is the documented way
// to load one from an ESM script (a bare `require` is not defined here, and
// getting that wrong is invisible: the loader throws, the catch returns null,
// and the gate reports INDETERMINATE forever while looking like a config issue).
const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const STALE_AFTER_DAYS = 180;

/**
 * Retired vendor UI paths. Each is matched in every encoding this repo actually
 * uses: the literal arrow (JSON-LD, markdown), the &rarr; named entity (page
 * prose) and the &#8594; numeric entity. Fixing one encoding and missing another
 * is exactly how /faq shipped a body and a structured-data twin that disagreed.
 */
const RETIRED_PATHS = [
  {
    label: 'Settings → Integrations (Claude Desktop; renamed to Connectors)',
    replacement: 'Settings → Connectors → Add custom connector',
    // eslint-disable-next-line no-useless-escape
    re: /Settings\s*(?:→|&rarr;|&#8594;|&#x2192;)\s*Integrations/gi,
  },
];

/** Rendered surfaces. A path that does not exist is INDETERMINATE, never a pass. */
function corpusFiles() {
  /** @type {string[]} */
  const files = [];
  const landing = join(ROOT, 'landing');
  if (!existsSync(landing)) return null;
  for (const f of readdirSync(landing)) {
    if (f.endsWith('.html') || /^llms.*\.txt$/.test(f)) files.push(join(landing, f));
  }
  const readme = join(ROOT, 'README.md');
  if (!existsSync(readme)) return null;
  files.push(readme);
  const docs = join(ROOT, 'docs');
  if (existsSync(docs)) walkMd(docs, files);
  return files;
}

/** @param {string} dir @param {string[]} out */
function walkMd(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
}

/**
 * Strip comments before grepping (CLAUDE.md gate-writing bug (a)).
 *
 * This wave's own history quotes the retired literal — in an HTML comment
 * explaining what was fixed, in a JS comment above the ban list, in a commit
 * body. A naive grep would demand deleting the most useful line in the file, and
 * a gate that punishes documentation gets disabled. A mention in a comment is
 * not a claim to the reader.
 *
 * @param {string} src @param {string} path
 */
export function stripComments(src, path) {
  let s = src;
  if (/\.html?$/.test(path)) s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  if (/\.(mjs|js|ts|tsx)$/.test(path)) {
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  }
  if (/\.md$/.test(path)) {
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    // Markdown blockquote lines are narrative in this repo's tutorials.
    s = s.replace(/^[ \t]*>.*$/gm, ' ');
  }
  return s;
}

/**
 * Comment-stripping for the TUTORIAL checks — code comments only, blockquotes KEPT.
 *
 * The distinction is load-bearing and nearly shipped a vacuous gate. stripComments()
 * above drops markdown blockquote lines because, for the retired-UI-path check, a
 * blockquote is narrative. For D3 and D4 the blockquote IS the defect:
 *
 *   > *Screenshot placeholder — Codex CLI showing the AlgoVault tool call.*
 *   > *Config verified 2026-08-05 against <URL>. Live numbers refresh in-page from <URL>.*
 *
 * Reusing stripComments() here would remove every violation before the regex ran, and
 * the checks would report a confident, permanent PASS over an empty corpus. Same rule,
 * opposite application — so it gets its own function rather than a boolean flag that a
 * future edit could pass wrong.
 *
 * @param {string} src @param {string} path
 */
export function stripCodeCommentsOnly(src, path) {
  let s = src;
  if (/\.html?$/.test(path)) s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  if (/\.md$/.test(path)) s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  if (/\.(mjs|js|ts|tsx)$/.test(path)) {
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  }
  return s;
}

/**
 * The 8 MCP-client tutorials, as (markdown source, rendered page) pairs.
 *
 * The markdown is the PRODUCER — scripts/render-integrations.mjs generates the HTML
 * from it — so both are scanned. A fix applied only to the HTML passes a
 * HTML-only gate and is then silently reverted by the next render.
 */
export const TUTORIAL_SLUGS = [
  'claude-desktop', 'cursor', 'cline', 'claude-code',
  'smithery', 'codex', 'kimi', 'glm-zcode',
];

/** @returns {string[]|null} null = a declared file is missing → INDETERMINATE, never a pass. */
export function tutorialFiles(rootDir = ROOT) {
  const files = [];
  for (const slug of TUTORIAL_SLUGS) {
    const md = join(rootDir, 'docs', 'integrations', 'mcp-clients', `${slug}.md`);
    const html = join(rootDir, 'landing', 'integrations', `${slug}.html`);
    if (!existsSync(md) || !existsSync(html)) return null;
    files.push(md, html);
  }
  return files;
}

/**
 * C-D4's corpus — WHAT REACHES A READER (architect ruling, CROSS-REPO-TUTORIAL-PRODUCER-GATE-W1).
 *
 * The live-numbers note exists in 17 `algovault-skills` markdown producers, but
 * `render-integrations.mjs::stripSnapshotBlock()` removes it from 12 of them by
 * design, so those never reach a page. Scanning producers whose output is stripped
 * would hold this check RED forever over a defect no reader can see, and editing
 * them to make it green would risk breaking the stripper's 3-block match.
 *
 * So the corpus is the rendered surfaces plus the in-repo producers: the 8
 * MCP-client tutorial pairs, the 4 agent-framework pages whose block SURVIVES
 * stripping, and the two hand-maintained landing pages.
 */
const D4_EXTRA_SURFACES = [
  'landing/integrations/langchain.html',
  'landing/integrations/crewai.html',
  'landing/integrations/maf.html',
  'landing/integrations/llamaindex.html',
  'landing/integrations.html',
  'landing/skills.html',
];

/** @returns {string[]|null} null = a declared surface is missing → INDETERMINATE. */
export function d4Files(rootDir = ROOT) {
  const base = tutorialFiles(rootDir);
  if (!base) return null;
  const extra = [];
  for (const rel of D4_EXTRA_SURFACES) {
    const p = join(rootDir, rel);
    if (!existsSync(p)) return null;
    extra.push(p);
  }
  return [...base, ...extra];
}

/**
 * C-BLOCKLIST's corpus — every reader-facing surface in this repo.
 *
 * Deliberately NOT corpusFiles(), which walks only the TOP level of landing/. The
 * per-day quota phrase lives in landing/integrations/*.html, one directory down, so
 * a top-level walk would report a confident clean scan over the exact files that
 * carry the defect.
 *
 * @returns {string[]|null} null = landing/ or README.md missing → INDETERMINATE.
 */
export function blocklistFiles(rootDir = ROOT) {
  const files = [];
  const landing = join(rootDir, 'landing');
  if (!existsSync(landing)) return null;
  walkExts(landing, files, (n) => n.endsWith('.html') || /^llms.*\.txt$/.test(n));
  const readme = join(rootDir, 'README.md');
  if (!existsSync(readme)) return null;
  files.push(readme);
  const docs = join(rootDir, 'docs');
  if (existsSync(docs)) walkExts(docs, files, (n) => n.endsWith('.md'));
  return files;
}

/** @param {string} dir @param {string[]} out @param {(name:string)=>boolean} keep */
function walkExts(dir, out, keep) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkExts(p, out, keep);
    else if (keep(e.name)) out.push(p);
  }
}

/**
 * Load the canonical forbidden-phrase blocklist. Null = cannot verify, never a pass.
 *
 * Returns compiled entries so a bad pattern fails HERE (INDETERMINATE) rather than
 * silently matching nothing at scan time, which would read as a clean corpus.
 */
export function loadBlocklist(file = join(ROOT, 'ops', 'brand-forbidden-phrases.json')) {
  if (!existsSync(file)) return null;
  let j;
  try {
    j = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(j.phrases) || j.phrases.length === 0) return null;
  const out = [];
  for (const p of j.phrases) {
    if (!p || !p.id || !p.pattern || !p.correction) return null;
    let re;
    try {
      re = new RegExp(p.pattern, 'gi');
    } catch {
      return null;
    }
    out.push({ ...p, re });
  }
  // Every exemption must carry a REASON. An exemption with no stated reason is
  // indistinguishable from an oversight, and the next wave enforcing the contract
  // deletes it. Refuse to load rather than honour a bare path.
  const exemptions = Array.isArray(j.exempt_paths) ? j.exempt_paths : [];
  for (const e of exemptions) {
    if (!e || !e.path || !e.phrase_id || !e.reason) return null;
  }
  out.exemptions = exemptions;
  return out;
}

/** Is (file, phrase) exempt? Path is matched repo-relative, exactly — no globs. */
function isExempt(exemptions, relPath, phraseId) {
  return exemptions.some((e) => e.path === relPath && e.phrase_id === phraseId);
}

/**
 * CHECK 8 (C-BLOCKLIST) — a retired brand phrase in any reader-facing surface.
 *
 * Reports file:line so the output is a worklist, not a verdict. Uses
 * stripCodeCommentsOnly() so documentation explaining a ban is not punished by it,
 * while markdown blockquotes — where several of these phrases live — stay visible.
 */
export function checkBlocklist(files, readFile, blocklist, rootDir = ROOT) {
  const hits = [];
  const exemptions = blocklist.exemptions || [];
  for (const f of files) {
    const relPath = f.startsWith(rootDir + '/') ? f.slice(rootDir.length + 1) : f;
    const src = stripCodeCommentsOnly(readFile(f), f);
    const lines = src.split('\n');
    for (const p of blocklist) {
      if (isExempt(exemptions, relPath, p.id)) continue;
      for (let i = 0; i < lines.length; i++) {
        p.re.lastIndex = 0;
        const m = p.re.exec(lines[i]);
        if (m) hits.push({ file: f, line: i + 1, id: p.id, match: m[0], correction: p.correction });
      }
    }
  }
  return hits;
}

/** Load the MCP-client registry from the compiled SoT. Null = cannot verify. */
function loadRegistry() {
  const dist = join(ROOT, 'dist', 'lib', 'integrations-data', 'mcp-clients.js');
  if (!existsSync(dist)) return null;
  try {
    const mod = require(dist);
    const surface = mod && (mod.default || mod);
    if (!surface || !Array.isArray(surface.entries) || surface.entries.length === 0) return null;
    return surface;
  } catch {
    return null;
  }
}

/** Text a reader actually sees for one registry row. */
export function renderedRowText(e) {
  return [e.setupSummary, e.whatYouGet, e.walkthroughSummary || '', e.walkthroughHtml]
    .join('\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&rarr;/g, '→')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** @param {'PASS'|'FAIL'|'INDETERMINATE'} verdict */
function verdictAndExit(verdict) {
  console.log(`MCP_CLIENT_COPY_VERDICT=${verdict}`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);
}

// ── the three checks, as pure functions so the self-test can drive them ──

/** CHECK 1 — retired vendor UI path in a rendered surface. */
export function checkRetiredPaths(files, readFile) {
  const hits = [];
  for (const f of files) {
    const src = stripComments(readFile(f), f);
    for (const p of RETIRED_PATHS) {
      const m = src.match(p.re);
      if (m) hits.push({ file: f, label: p.label, count: m.length, replacement: p.replacement });
    }
  }
  return hits;
}

/** CHECK 2 — a byo-model row must not describe itself as an MCP client. */
export function checkByoModelCopy(entries) {
  const byo = entries.filter((e) => e.kind === 'byo-model');
  return {
    rows: byo.length,
    hits: byo.filter((e) => /MCP client/i.test(renderedRowText(e))).map((e) => e.slug),
  };
}

// ── INTEGRATIONS-TUTORIAL-COPY-SWEEP-V2-W1: three tutorial-copy checks ──
//
// All three scan the markdown PRODUCER and its rendered page, and all three use
// stripCodeCommentsOnly() — never stripComments() — because the defects live in
// markdown blockquotes. See that function's docstring.

/**
 * CHECK 4 (C-D2) — the Telegram bot framed as a support channel.
 *
 * Scoped to the 8 tutorials so the LEGITIMATE Telegram surfaces are untouched: the
 * `Try Free in Telegram` CTA on index.html / how-it-works.html and the nav's
 * "Telegram Bot" entry are product links, not support promises. checkTelegramCtasPresent()
 * asserts those still exist, so an over-broad sweep cannot quietly delete them.
 */
export function checkTgAsSupport(files, readFile) {
  const hits = [];
  // The handle and the word "support" inside one sentence — not merely one file.
  const RE = /algovaultofficialbot[^.!?]*\bsupport\b|(?:\bsupport\b)[^.!?]*algovaultofficialbot/gi;
  for (const f of files) {
    const src = stripCodeCommentsOnly(readFile(f), f);
    const m = src.match(RE);
    if (m) hits.push({ file: f, count: m.length });
  }
  return hits;
}

/** Positive-presence guard for the legitimate Telegram CTAs. @returns {string[]} missing */
export function checkTelegramCtasPresent(pairs, readFile) {
  const missing = [];
  for (const { file, needle } of pairs) {
    let src;
    try { src = readFile(file); } catch { missing.push(`${file} (unreadable)`); continue; }
    if (!src.includes(needle)) missing.push(`${file} :: "${needle}"`);
  }
  return missing;
}

/** CHECK 5 (C-D3) — screenshot placeholders that never became screenshots. */
export function checkScreenshotPlaceholders(files, readFile) {
  const hits = [];
  for (const f of files) {
    const src = stripCodeCommentsOnly(readFile(f), f);
    const m = src.match(/Screenshot placeholder/gi);
    if (m) hits.push({ file: f, count: m.length });
  }
  return hits;
}

/**
 * CHECK 6 (C-D4) — internal plumbing exposed as user copy.
 *
 * Two live variants: "Live numbers refresh in-page from …" and
 * "Snapshot <date> — live numbers refreshed in-page from …".
 *
 * MUST NOT fire on `Config verified <date> against <vendor-URL>`, which is the
 * verifiedAt/source trust signal and stays. Note those two sit on the SAME LINE in
 * three tutorials, so this matches the offending PHRASE rather than excluding lines
 * that mention "Config verified" — a line-level exclusion would silently skip exactly
 * the three pages that need it.
 */
export function checkLiveNumbersNote(files, readFile) {
  const hits = [];
  const RE = /(?:live\s+numbers\s+refresh(?:ed)?\s+in-page|numbers\s+refreshed\s+in-page)/gi;
  for (const f of files) {
    const src = stripCodeCommentsOnly(readFile(f), f);
    const m = src.match(RE);
    if (m) hits.push({ file: f, count: m.length });
  }
  return hits;
}

/** CHECK 3 — REPORT rows whose vendor doc was last checked over 180 days ago. */
export function checkStaleVerification(entries, nowMs) {
  const stale = [];
  for (const e of entries) {
    if (!e.verifiedAt) continue;
    const t = Date.parse(e.verifiedAt);
    if (Number.isNaN(t)) continue;
    const days = Math.floor((nowMs - t) / 86_400_000);
    if (days > STALE_AFTER_DAYS) stale.push({ slug: e.slug, days, source: e.source || '(none)' });
  }
  return stale;
}

// ── self-test ─────────────────────────────────────────────────────────────────

/**
 * Vacuity-guarded and two-way. WE build this corpus, so an empty one means the
 * test built nothing — a defect in the test, not a fact about the world. REFUSE.
 * (At runtime the world builds the corpus, and empty there is a fact; that case
 * is handled in main.)
 *
 * Asserts the verdict tokens AND the token→exit-code mapping. Asserting tokens
 * alone once let a re-coded INDETERMINATE→0 mapping stay fully green.
 *
 * @returns {'PASS'|'FAIL'|'INDETERMINATE'}
 */
function selfTest() {
  const fails = [];
  let mustFire = 0;
  let mustNotFire = 0;

  const fixtures = {
    '/fx/clean.html': '<p>Settings &rarr; Connectors &rarr; Add custom connector</p>',
    '/fx/stale-entity.html': '<p>Claude Desktop: Settings &rarr; Integrations &rarr; paste</p>',
    '/fx/stale-arrow.md': 'Open Claude → Settings → Integrations → Add custom connector',
    '/fx/stale-numeric.html': '<p>Settings &#8594; Integrations</p>',
    '/fx/comment-only.html':
      '<!-- was: Settings &rarr; Integrations --><p>Settings &rarr; Connectors</p>',
    '/fx/blockquote-only.md': '> Historical note: Settings → Integrations was the old path.',
  };
  const readFixture = (p) => {
    if (!(p in fixtures)) throw new Error(`fixture missing: ${p}`);
    return fixtures[p];
  };

  if (Object.keys(fixtures).length === 0) {
    console.error('✗ self-test corpus is EMPTY — the test built nothing.');
    return 'INDETERMINATE';
  }

  // CHECK 1, must-fire
  for (const f of ['/fx/stale-entity.html', '/fx/stale-arrow.md', '/fx/stale-numeric.html']) {
    mustFire++;
    if (checkRetiredPaths([f], readFixture).length !== 1) fails.push(`check1 must fire on ${f}`);
  }
  // CHECK 1, must-NOT-fire (incl. the comment/blockquote carve-outs)
  for (const f of ['/fx/clean.html', '/fx/comment-only.html', '/fx/blockquote-only.md']) {
    mustNotFire++;
    if (checkRetiredPaths([f], readFixture).length !== 0) fails.push(`check1 must NOT fire on ${f}`);
  }

  // CHECK 2, both directions
  const byoBad = [{ slug: 'x', kind: 'byo-model', setupSummary: 'Use it as an MCP client', whatYouGet: '', walkthroughHtml: '' }];
  const byoGood = [{ slug: 'x', kind: 'byo-model', setupSummary: 'Point Claude Code at it', whatYouGet: '', walkthroughHtml: '' }];
  mustFire++;
  if (checkByoModelCopy(byoBad).hits.length !== 1) fails.push('check2 must fire on byo-model calling itself an MCP client');
  mustNotFire++;
  if (checkByoModelCopy(byoGood).hits.length !== 0) fails.push('check2 must NOT fire on clean byo-model copy');
  // vacuity: zero byo-model rows must be visible as zero, not silently "clean"
  if (checkByoModelCopy([{ slug: 'y', kind: 'native' }]).rows !== 0) fails.push('check2 row count wrong');

  // CHECK 3, both directions
  const now = Date.parse('2026-08-05T00:00:00Z');
  mustFire++;
  if (checkStaleVerification([{ slug: 'old', verifiedAt: '2025-01-01', source: 'https://x' }], now).length !== 1) {
    fails.push('check3 must report a >180d row');
  }
  mustNotFire++;
  if (checkStaleVerification([{ slug: 'new', verifiedAt: '2026-08-01', source: 'https://x' }], now).length !== 0) {
    fails.push('check3 must NOT report a fresh row');
  }

  // ── CHECKS 4-6 (tutorial copy). Fixtures are BLOCKQUOTES on purpose: that is the
  // shape the real defects take, and it is the shape stripComments() would erase.
  const tut = {
    '/fx/tg-support.md':
      'Message [@algovaultofficialbot](https://t.me/algovaultofficialbot) for support, or [verify](…).',
    '/fx/tg-clean.md':
      'Try it free: get a BTC trade call right now. Or [verify the track record on-chain](…).',
    // The bot may be named as a PRODUCT without promising support — must not fire.
    '/fx/tg-product-link.md':
      'Get free trade calls in Telegram via [@algovaultofficialbot](https://t.me/algovaultofficialbot).',
    '/fx/shot.md': '> *Screenshot placeholder — Codex CLI showing the tool call.*',
    '/fx/shot-clean.md': '> *Config verified 2026-08-05 against <https://vendor.example/docs>.*',
    // Shape A — the whole blockquote is the defect (the 5 older tutorials).
    '/fx/numbers-a.md':
      '> *Snapshot 2026-05-19 — live numbers refreshed in-page from <https://algovault.com/api/performance-public>.*',
    // Shape B — KEEP sentence + DEFECT sentence on ONE line (the 3 newer tutorials).
    // This is the case a line-level "skip lines mentioning Config verified" would miss.
    '/fx/numbers-b.md':
      '> *Config verified 2026-08-05 against <https://vendor.example/docs>. Live numbers refresh in-page from <https://algovault.com/api/performance-public>.*',
    // KEEP-only — must never fire.
    '/fx/numbers-clean.md':
      '> *Config verified 2026-08-05 against <https://vendor.example/docs>.*',
  };
  Object.assign(fixtures, tut);

  // CHECK 4 (C-D2)
  mustFire++;
  if (checkTgAsSupport(['/fx/tg-support.md'], readFixture).length !== 1) fails.push('check4 must fire on TG-as-support');
  for (const f of ['/fx/tg-clean.md', '/fx/tg-product-link.md']) {
    mustNotFire++;
    if (checkTgAsSupport([f], readFixture).length !== 0) fails.push(`check4 must NOT fire on ${f}`);
  }

  // CHECK 5 (C-D3)
  mustFire++;
  if (checkScreenshotPlaceholders(['/fx/shot.md'], readFixture).length !== 1) fails.push('check5 must fire on a screenshot placeholder');
  mustNotFire++;
  if (checkScreenshotPlaceholders(['/fx/shot-clean.md'], readFixture).length !== 0) fails.push('check5 must NOT fire on clean copy');

  // CHECK 6 (C-D4) — both live variants must fire, and the KEEP string must not.
  for (const f of ['/fx/numbers-a.md', '/fx/numbers-b.md']) {
    mustFire++;
    if (checkLiveNumbersNote([f], readFixture).length !== 1) fails.push(`check6 must fire on ${f}`);
  }
  mustNotFire++;
  if (checkLiveNumbersNote(['/fx/numbers-clean.md'], readFixture).length !== 0) {
    fails.push('check6 must NOT fire on "Config verified … against …" alone');
  }

  // The blockquote-stripping trap, pinned: if a future edit points these checks at
  // stripComments(), every fixture above becomes invisible and the gate passes over
  // nothing. Assert the two strippers actually differ on a blockquote.
  const bq = '> *Screenshot placeholder — x.*';
  if (/Screenshot placeholder/.test(stripComments(bq, '/fx/x.md'))) {
    fails.push('stripComments() no longer strips md blockquotes — check1 carve-out broken');
  }
  if (!/Screenshot placeholder/.test(stripCodeCommentsOnly(bq, '/fx/x.md'))) {
    fails.push('stripCodeCommentsOnly() strips md blockquotes — checks 4-6 would be VACUOUS');
  }

  // ── CHECK 8 (C-BLOCKLIST). The must-NOT-fire cases matter more than the
  // must-fire ones here: a pattern that also swallows legitimate copy would force
  // an editor to weaken real documentation to get a push through.
  //
  // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (2026-08-09) RETIRED the `per-day-quota`
  // class and these fixtures moved WITH it. R-B introduced a real per-UTC-day cap, so
  // '100 calls/day' became an accurate statement the gate was blocking — and the
  // per-day fixtures are kept, INVERTED, as the regression lock: they must now be
  // inert. Deleting them instead would leave nothing asserting the ban is gone, and a
  // silently-reinstated pattern would block every pricing page again.
  const bl = {
    // Retired class — every one of these is legitimate copy now and must NOT fire.
    '/fx/bl-quota.md': 'Free tier covers 100 calls/day per IP — plenty for development.',
    '/fx/bl-quota-upto.md': 'Free tier covers up to 100 calls/day per IP',
    '/fx/bl-quota-free.md': 'Free tier covers 100 free calls/day',
    '/fx/bl-quota-words.md': 'Free tier covers 100 calls per day',
    '/fx/bl-quota-future.md': 'Starter covers 1,000 calls/day',
    '/fx/bl-ok-month.md': 'Free tier: 200 calls/month, every coin and timeframe.',
    // Real venue rate limits that MUST survive — these are exchange API facts.
    '/fx/bl-ok-venue1.md': 'Awareness that rate limits are **per-IP, not per-key** (2,400 weight/min, 1,200 order/min)',
    '/fx/bl-ok-venue2.md': 'Awareness of the order rate limit — 10/s per UID and 3/s per IP on the place-order endpoint.',
    // LIVE class — the free-HOLD promise, in the paraphrases it actually shipped as.
    '/fx/bl-hold-are.md': 'HOLD verdicts are free and never charged.',
    '/fx/bl-hold-is.md': 'A HOLD is free, so scan as often as you like.',
    '/fx/bl-hold-adj.md': 'Batch scans give you free HOLDs at no quota cost.',
    '/fx/bl-hold-never.md': 'A HOLD is never charged against your allowance.',
    '/fx/bl-hold-count.md': "HOLDs don't count towards your monthly quota.",
    // ...and the copy this wave actually shipped, which must stay inert. The pattern is
    // DIRECTIONAL: it needs HOLD adjacent to a free/never-charged claim, so the true
    // statement of the same fact is not collateral damage.
    '/fx/bl-ok-hold-counts.md': 'Every verdict counts, HOLD included.',
    '/fx/bl-ok-hold-flat.md': 'Free tier: 200 calls/month. Every successful verdict is one metered call, HOLD included.',
    // A doc explaining the ban must not be punished by the ban.
    '/fx/bl-ok-comment.html': '<!-- retired: HOLDs are free --><p>Every verdict counts, HOLD included.</p>',
  };
  Object.assign(fixtures, bl);

  const testBl = loadBlocklist(join(ROOT, 'ops', 'brand-forbidden-phrases.json'));
  if (!testBl) {
    console.error('✗ self-test could not load ops/brand-forbidden-phrases.json — cannot verify C-BLOCKLIST.');
    return 'INDETERMINATE';
  }
  for (const f of ['/fx/bl-hold-are.md', '/fx/bl-hold-is.md', '/fx/bl-hold-adj.md',
                   '/fx/bl-hold-never.md', '/fx/bl-hold-count.md']) {
    mustFire++;
    if (checkBlocklist([f], readFixture, testBl).length !== 1) fails.push(`check8 must fire on ${f}`);
  }
  for (const f of ['/fx/bl-quota.md', '/fx/bl-quota-upto.md', '/fx/bl-quota-free.md',
                   '/fx/bl-quota-words.md', '/fx/bl-quota-future.md', '/fx/bl-ok-month.md',
                   '/fx/bl-ok-venue1.md', '/fx/bl-ok-venue2.md', '/fx/bl-ok-hold-counts.md',
                   '/fx/bl-ok-hold-flat.md', '/fx/bl-ok-comment.html']) {
    mustNotFire++;
    if (checkBlocklist([f], readFixture, testBl).length !== 0) fails.push(`check8 must NOT fire on ${f}`);
  }
  // Fail-closed: a malformed or empty blocklist must be unloadable, not "no phrases".
  if (loadBlocklist(join(ROOT, 'ops', 'does-not-exist.json')) !== null) {
    fails.push('loadBlocklist must return null for a missing file');
  }

  // Positive-presence guard must itself be able to fail.
  mustFire++;
  if (checkTelegramCtasPresent([{ file: '/fx/tg-clean.md', needle: 'Try Free in Telegram' }], readFixture).length !== 1) {
    fails.push('CTA presence guard must report a missing CTA');
  }
  mustNotFire++;
  if (checkTelegramCtasPresent([{ file: '/fx/tg-product-link.md', needle: 'Telegram' }], readFixture).length !== 0) {
    fails.push('CTA presence guard must NOT report a present CTA');
  }

  // token → exit-code mapping. Asserting the token alone is not enough: a
  // re-coded mapping would leave every token assertion green.
  const MAP = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
  for (const [tok, code] of Object.entries(MAP)) {
    const got = tok === 'PASS' ? 0 : tok === 'FAIL' ? 1 : 3;
    if (got !== code) fails.push(`token→exit mapping broken for ${tok}: ${got} != ${code}`);
  }

  if (mustFire === 0 || mustNotFire === 0) {
    console.error(`✗ self-test is VACUOUS (must-fire=${mustFire}, must-not-fire=${mustNotFire}).`);
    return 'INDETERMINATE';
  }
  if (fails.length) {
    for (const f of fails) console.error(`  ✗ ${f}`);
    return 'FAIL';
  }
  console.log(
    `✓ self-test passed — ${mustFire} must-fire, ${mustNotFire} must-not-fire, ` +
      `3 token→exit mappings, across ${Object.keys(fixtures).length} fixtures.`,
  );
  return 'PASS';
}

// ── main ──────────────────────────────────────────────────────────────────────

// Test-importable entrypoint (CLAUDE.md). Importing this module for its exported
// check functions must NOT run the scan or call process.exit — only a direct
// `node scripts/check-mcp-client-copy.mjs` does. Found the hard way: importing it
// to probe stripComments() executed the whole gate and exited 3.
const INVOKED_DIRECTLY =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!INVOKED_DIRECTLY) {
  // Imported — expose the checks and stop here.
} else {

if (argv.includes('--self-test')) {
  verdictAndExit(selfTest());
}

// A broken detector must never certify the tree.
const st = selfTest();
if (st !== 'PASS') {
  console.error('✗ detector self-test did not pass — refusing to certify the working tree.');
  verdictAndExit(st === 'FAIL' ? 'FAIL' : 'INDETERMINATE');
}

const files = corpusFiles();
if (!files) {
  console.error('✗ corpus unreadable (landing/ or README.md missing) — cannot verify.');
  verdictAndExit('INDETERMINATE');
}
if (files.length === 0) {
  console.error('✗ corpus resolved to ZERO files — cannot verify.');
  verdictAndExit('INDETERMINATE');
}

const registry = loadRegistry();
if (!registry) {
  console.error(
    '✗ MCP-client registry not loadable at dist/lib/integrations-data/mcp-clients.js — run `npm run build`.',
  );
  verdictAndExit('INDETERMINATE');
}

let failed = false;

// CHECK 1 — assert POSITIVE per-check output. A check skipped by a load error
// must not be indistinguishable from a check that passed.
let hits;
try {
  hits = checkRetiredPaths(files, (f) => readFileSync(f, 'utf8'));
} catch (e) {
  console.error(`✗ check 1 could not read a corpus file: ${e && e.message}`);
  verdictAndExit('INDETERMINATE');
}
if (hits.length) {
  failed = true;
  for (const h of hits) {
    console.error(`  ✗ ${h.file.replace(ROOT + '/', '')}: ${h.count}× "${h.label}" → use "${h.replacement}"`);
  }
} else {
  console.log(`✓ check 1: no retired vendor UI path across ${files.length} rendered surface(s).`);
}

// CHECK 2
const byo = checkByoModelCopy(registry.entries);
if (byo.rows === 0) {
  // Not vacuity — the registry legitimately might carry no byo-model row. Say so
  // out loud rather than printing a pass that examined nothing.
  console.log('✓ check 2: no byo-model rows in the registry (nothing to check).');
} else if (byo.hits.length) {
  failed = true;
  console.error(`  ✗ ${byo.hits.length} byo-model row(s) call themselves an MCP client: ${byo.hits.join(', ')}`);
} else {
  console.log(`✓ check 2: ${byo.rows} byo-model row(s), none described as an MCP client.`);
}

// CHECK 3 — REPORT only. Vendor UI paths drift; this names the row that rots next.
const stale = checkStaleVerification(registry.entries, Date.now());
if (stale.length) {
  for (const s of stale) {
    console.log(`  ⚠ REPORT: ${s.slug} last verified ${s.days}d ago (>${STALE_AFTER_DAYS}d) — re-check ${s.source}`);
  }
} else {
  console.log(
    `✓ check 3: all ${registry.entries.length} registry row(s) verified within ${STALE_AFTER_DAYS} days.`,
  );
}

// ── CHECKS 4-6 — tutorial copy (INTEGRATIONS-TUTORIAL-COPY-SWEEP-V2-W1) ──
// Scanned over the markdown PRODUCER + its rendered page, so a fix applied only to
// the generated HTML cannot pass; the next render would revert it.

const tutFiles = tutorialFiles();
if (!tutFiles) {
  console.error('✗ a declared MCP-client tutorial source or page is missing — cannot verify.');
  verdictAndExit('INDETERMINATE');
}

const readTut = (f) => readFileSync(f, 'utf8');
const rel = (f) => f.replace(ROOT + '/', '');

/** Run one tutorial check with fail-closed read handling + positive output. */
function runTutCheck(n, label, fn, remedy) {
  let hitList;
  try {
    hitList = fn(tutFiles, readTut);
  } catch (e) {
    console.error(`✗ check ${n} could not read a tutorial file: ${e && e.message}`);
    verdictAndExit('INDETERMINATE');
  }
  const total = hitList.reduce((s, h) => s + h.count, 0);
  if (hitList.length) {
    failed = true;
    console.error(`  ✗ check ${n} (${label}): checked ${tutFiles.length} files, ${total} violation(s) in ${hitList.length} file(s) — ${remedy}`);
    for (const h of hitList) console.error(`      ${rel(h.file)}: ${h.count}×`);
  } else {
    console.log(`✓ check ${n} (${label}): checked ${tutFiles.length} files, 0 violations.`);
  }
}

runTutCheck(4, 'C-D2 TG-as-support', checkTgAsSupport, 'delete the support clause; keep the verify CTA');
runTutCheck(5, 'C-D3 screenshot placeholder', checkScreenshotPlaceholders, 'delete the blockquote entirely');

// C-D4 runs over the WIDER corpus (see d4Files): the tutorial pairs plus the 4
// agent-framework pages whose snapshot block survives stripSnapshotBlock(), plus
// the two hand-maintained landing pages.
const d4Corpus = d4Files();
if (!d4Corpus) {
  console.error('✗ a declared C-D4 surface is missing — cannot verify.');
  verdictAndExit('INDETERMINATE');
}
{
  let hitList;
  try {
    hitList = checkLiveNumbersNote(d4Corpus, readTut);
  } catch (e) {
    console.error(`✗ check 6 could not read a corpus file: ${e && e.message}`);
    verdictAndExit('INDETERMINATE');
  }
  const total = hitList.reduce((s, h) => s + h.count, 0);
  if (hitList.length) {
    failed = true;
    console.error(`  ✗ check 6 (C-D4 live-numbers note): checked ${d4Corpus.length} files, ${total} violation(s) in ${hitList.length} file(s) — delete it; KEEP "Config verified … against …"`);
    for (const h of hitList) console.error(`      ${rel(h.file)}: ${h.count}×`);
  } else {
    console.log(`✓ check 6 (C-D4 live-numbers note): checked ${d4Corpus.length} files, 0 violations.`);
  }
}

// CHECK 8 — C-BLOCKLIST. Fail-closed on an unreadable or malformed blocklist: a
// gate that cannot read its own rules has verified nothing.
const blocklist = loadBlocklist();
if (!blocklist) {
  console.error('✗ ops/brand-forbidden-phrases.json missing, malformed, empty, or carries a bad pattern — cannot verify.');
  verdictAndExit('INDETERMINATE');
}
const blFiles = blocklistFiles();
if (!blFiles || blFiles.length === 0) {
  console.error('✗ blocklist corpus unreadable or empty — cannot verify.');
  verdictAndExit('INDETERMINATE');
}
{
  let hits8;
  try {
    hits8 = checkBlocklist(blFiles, readTut, blocklist);
  } catch (e) {
    console.error(`✗ check 8 could not read a corpus file: ${e && e.message}`);
    verdictAndExit('INDETERMINATE');
  }
  if (hits8.length) {
    failed = true;
    console.error(`  ✗ check 8 (C-BLOCKLIST): checked ${blFiles.length} files against ${blocklist.length} phrase class(es), ${hits8.length} violation(s):`);
    for (const h of hits8) {
      console.error(`      ${rel(h.file)}:${h.line} [${h.id}] "${h.match}" → use "${h.correction}"`);
    }
  } else {
    console.log(`✓ check 8 (C-BLOCKLIST): checked ${blFiles.length} files against ${blocklist.length} phrase class(es), 0 violations.`);
  }
}

// Positive-presence guard: the legitimate Telegram surfaces must SURVIVE the sweep.
// Deleting a support clause is a delete operation, and a delete that goes one grep
// too wide would silently remove the product CTAs. Assert they are still there.
const TG_CTAS = [
  { file: join(ROOT, 'landing', 'index.html'), needle: 'Try Free in Telegram' },
  { file: join(ROOT, 'landing', 'how-it-works.html'), needle: 'Try Free in Telegram' },
];
const missingCtas = checkTelegramCtasPresent(TG_CTAS, readTut);
if (missingCtas.length) {
  failed = true;
  console.error(`  ✗ check 7 (legitimate TG CTAs): ${missingCtas.length} MISSING — an over-broad sweep removed a product link:`);
  for (const m of missingCtas) console.error(`      ${rel(m)}`);
} else {
  console.log(`✓ check 7: ${TG_CTAS.length} legitimate Telegram CTA(s) still present.`);
}

verdictAndExit(failed ? 'FAIL' : 'PASS');

} // end INVOKED_DIRECTLY
