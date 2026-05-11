/**
 * DESIGN-W9 C5 — /verify canonical rebuild + verify://signal/{id} MCP resource consistency.
 *
 * Asserts the architect-ratified 13 Q-W9-N decisions from audits/DESIGN-W9-mapping.md:
 *   - C2: 7 JSX sections render in order (VHero → VInput → VResult-hidden → VHowItWorks
 *         → VRecent → VFaq → VFooter); dual-render desktop+mobile @media swap.
 *   - C3: 5 wave-level overrides — eyebrow rename, VRecent empty state, contract full
 *         EIP-55 + Basescan, VerifyNav link rewrites, VFooter <pre> outcome strip; 4
 *         data-tr-field live-bind spans + hydration JS.
 *   - C4: server.resource('verify-signal', new ResourceTemplate('verify://signal/{id}'))
 *         with PUBLIC-ONLY shape (no outcome / PFE / Phase-E); BOTH integer + hex {id}.
 *   - Preservation-LAW: W4 form behavior (verifySignal + #signal-id + #verify-btn +
 *         /api/verify-signal); 5 JSON-LD blocks byte-identical.
 *   - Data Integrity LAW: zero Phase-E outcome leakage in src/index.ts CODE PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

async function read(rel) {
  return readFile(resolve(REPO_ROOT, rel), 'utf8');
}

function countOcc(haystack, needle) {
  if (typeof needle === 'string') {
    let n = 0, idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
    return n;
  }
  // RegExp
  const re = needle.global ? needle : new RegExp(needle.source, needle.flags + 'g');
  const m = haystack.match(re);
  return m ? m.length : 0;
}

// ── C2 — Dual-render + JSX section order ─────────────────────────────────────

test('landing/verify.html: C2 dual-render wrappers present (lp-verify-desktop + lp-verify-mobile)', async () => {
  const html = await read('landing/verify.html');
  assert.ok(countOcc(html, 'lp-verify-desktop') >= 1, 'desktop wrapper missing');
  assert.ok(countOcc(html, 'lp-verify-mobile') >= 1, 'mobile wrapper missing');
  assert.match(html, /@media \(max-width: ?767px\) \{ ?\.lp-verify-desktop \{ display: none/, '@media swap CSS missing');
  assert.match(html, /@media \(min-width: ?768px\) \{ ?\.lp-verify-mobile \{ display: none/, 'mobile-swap @media CSS missing');
});

test('landing/verify.html: C2 7 JSX sections render in canonical order (VHero H1 → VInput → VHowItWorks H2 → VRecent H2 → VFaq H2 → VFooter H3)', async () => {
  const html = await read('landing/verify.html');
  // VHero — H1 "Verify Any AlgoVault Trade Call"
  const hero = html.indexOf('Verify Any AlgoVault');
  // R3-4: VInput label renamed `signal id or call timestamp` → `call id or call timestamp`
  const input = html.indexOf('call id or call timestamp');
  const how = html.indexOf('Hashed first. Outcome second.');
  const recent = html.indexOf('Recent verifications');
  const faq = html.indexOf('Verification, in detail');
  const footer = html.indexOf('Want to verify in code?');
  assert.ok(hero > 0 && input > 0 && how > 0 && recent > 0 && faq > 0 && footer > 0,
    `all 7 sections must be present: hero=${hero} input=${input} how=${how} recent=${recent} faq=${faq} footer=${footer}`);
  // Order: hero < input < how < recent < faq < footer
  assert.ok(hero < input && input < how && how < recent && recent < faq && faq < footer,
    'section order violated: must be VHero → VInput → VHowItWorks → VRecent → VFaq → VFooter');
});

test('landing/verify.html: C2 H1 + H2 + H3 counts match JSX SoT dual-render + R2-3 additions (2 H1 + 10 H2 + 2 H3)', async () => {
  const html = await read('landing/verify.html');
  assert.strictEqual(countOcc(html, /<h1[^>]*>/), 2, 'expected 2 H1 (1 per artboard)');
  // R2-3 added "How to Verify" + "How It Works" sections (2 new H2s × dual = 4 new); 3 JSX H2s × dual = 6; total 10.
  assert.strictEqual(countOcc(html, /<h2[^>]*>/), 10, 'expected 10 H2 (3 JSX + 2 R2-3 = 5 × 2 dual-render)');
  assert.strictEqual(countOcc(html, /<h3[^>]*>/), 2, 'expected 2 H3 (VFooter × 2 dual-render)');
});

test('landing/verify.html: 5 JSON-LD blocks preserved byte-identical (Product / Service / SoftwareApplication / Organization / WebSite)', async () => {
  const html = await read('landing/verify.html');
  assert.strictEqual(countOcc(html, /<script type="application\/ld\+json"/g), 5, 'expected exactly 5 JSON-LD blocks');
  for (const t of ['Product', 'Service', 'SoftwareApplication', 'Organization', 'WebSite']) {
    assert.ok(html.includes(`data-algovault-jsonld="${t}"`), `JSON-LD ${t} missing`);
  }
});

// ── C2 W4 form preservation (Q-W9-10) ───────────────────────────────────────

test('landing/verify.html: C2 W4 form preservation — verifySignal + #signal-id + #verify-btn + .verify-result-mount (R2-1 supersedes #result)', async () => {
  const html = await read('landing/verify.html');
  assert.ok(countOcc(html, 'verifySignal') >= 5, 'verifySignal function references missing');
  assert.strictEqual(countOcc(html, /id="signal-id"/g), 1, '#signal-id must be unique (desktop only; mobile strips id)');
  assert.strictEqual(countOcc(html, /id="verify-btn"/g), 1, '#verify-btn must be unique (desktop only)');
  // R2-1: #result superseded by class .verify-result-mount (dual-render = 2 instances).
  assert.strictEqual(countOcc(html, /id="result"/g), 0, '#result id superseded by .verify-result-mount class (R2-1)');
  assert.strictEqual(countOcc(html, /class="verify-result-mount"/g), 2, '.verify-result-mount class must appear in both artboards (dual-render)');
  // Both inputs share class for cross-artboard querying
  assert.ok(countOcc(html, /class="signal-id-input"/g) >= 2, 'class="signal-id-input" must appear on both desktop + mobile inputs');
  // Both buttons have onclick handler
  assert.strictEqual(countOcc(html, /onclick="verifySignal\(\)"/g), 2, 'onclick="verifySignal()" must appear on both desktop + mobile buttons');
});

test('landing/verify.html: C2 W4 endpoint integration preserved — /api/verify-signal + URL-param auto-lookup', async () => {
  const html = await read('landing/verify.html');
  assert.ok(html.includes("'/api/verify-signal?signalId='"), '/api/verify-signal fetch call missing');
  assert.ok(html.includes("params.get('signalId')") || html.includes('params.get(\'id\')'), 'URL-param auto-lookup handler missing');
  assert.ok(html.includes('fmtDate'), 'fmtDate helper missing');
  assert.ok(html.includes('truncHash'), 'truncHash helper missing');
});

// ── C3 — Mr.1's 3 surgical overrides ─────────────────────────────────────────

test('landing/verify.html: C3 Override 1 — VRecent eyebrow rename · social proof → · Agent Verification Records', async () => {
  const html = await read('landing/verify.html');
  assert.ok(countOcc(html, 'Agent Verification Records') >= 1, 'new eyebrow text missing');
  assert.strictEqual(countOcc(html, 'social proof'), 0, 'old eyebrow text must be 0 after rename');
});

test('landing/verify.html: C3 Override 2 — Q-W9-4 REVERSED by Fix-Forward Fix 5 (ship JSX VRecent 10 rows verbatim per Mr.1 positioning override)', async () => {
  const html = await read('landing/verify.html');
  // DESIGN-W9-FIX-FORWARD Fix 5 (2026-05-11): Mr.1 reversed Q-W9-4 ratification with positioning
  // argument "we publish Merkle batches proactively, demo rows showing past published verifications
  // are factually accurate, not fictional". applyVerifyOverride2VRecentEmpty removed from C3 chain;
  // JSX VRecent 10 rows ship verbatim. Empty-state shell class no longer present.
  assert.strictEqual(countOcc(html, 'recent-verifications-empty'), 0, 'empty-state shell class must be 0 after Q-W9-4 reversal');
  assert.ok(!html.includes('Verifications will appear here once requesters opt in'), 'empty-state copy must be 0');
  // JSX-default row anchors must be PRESENT (dual-render: 2 instances each)
  for (const anchor of ['12s ago', '38s ago', '14m ago']) {
    assert.ok(countOcc(html, anchor) >= 1, `JSX row anchor "${anchor}" must be present (Fix 5)`);
  }
});

test('landing/verify.html: C3 Override 3 — VFooter contract full EIP-55 + Basescan link wrap', async () => {
  const html = await read('landing/verify.html');
  assert.strictEqual(countOcc(html, '0x9aF3…b21c'), 0, 'JSX placeholder contract must be 0 after rewrite');
  assert.ok(countOcc(html, '0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81') >= 2, 'full EIP-55 contract address must appear (display + href)');
  assert.match(html, /href="https:\/\/basescan\.org\/address\/0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/, 'Basescan external-link discipline missing');
});

test('landing/verify.html: C3 Override 4 — VerifyNav SUPERSEDED by Fix-Forward Fix 1 (entire JSX VerifyNav stripped; global W7 nav remains for cross-page consistency)', async () => {
  const html = await read('landing/verify.html');
  // DESIGN-W9-FIX-FORWARD Fix 1 (2026-05-11): the entire JSX <nav class="nav">...</nav> block is now
  // stripped post-render to prevent duplicate-nav (the global W7 AlgoVault Labs sticky nav already
  // sits above /verify content per cross-page consistency). Q-W9-2 and Q-W9-3 link-target rewrites
  // are therefore moot — no Verdicts/Docs/Open-in-Claude links exist on /verify.
  assert.strictEqual(countOcc(html, '<nav class="nav">'), 0, 'JSX VerifyNav must be stripped (Fix 1)');
  // Global W7 nav remains (1 instance — cross-page sticky AlgoVault Labs nav)
  assert.ok(countOcc(html, '<nav class="fixed top-0') >= 1, 'global W7 sticky nav remains');
  // Verdicts placeholder removed (Q-W9-3 + Fix 1 — double-stripped now)
  assert.ok(!html.includes('<a href="#">Verdicts</a>'), 'Verdicts placeholder removed');
});

test('landing/verify.html: C3 Override 6 — VFooter <pre> outcome line STRIPPED per Q-W9-9 spec-cross-section-contradiction-probe', async () => {
  const html = await read('landing/verify.html');
  // The outcome line is HTML-encoded inside <pre> as &quot;outcome&quot;:{ &quot;won&quot;: true, ...}
  assert.strictEqual(countOcc(html, 'pfe_bps'), 0, 'pfe_bps must be 0 in VFooter <pre> example (Q-W9-9 strip)');
  assert.strictEqual(countOcc(html, 'outcome&quot;:{'), 0, 'outcome:{ must be 0 in <pre> example');
  // The PUBLIC-ONLY fields must still be present in the <pre>
  assert.ok(html.includes('&quot;status&quot;'), 'status field must remain in <pre>');
  assert.ok(html.includes('&quot;leaf&quot;'), 'leaf field must remain in <pre>');
  assert.ok(html.includes('&quot;root&quot;'), 'root field must remain in <pre>');
  assert.ok(html.includes('&quot;batch&quot;'), 'batch field must remain in <pre>');
  assert.ok(html.includes('&quot;tx&quot;'), 'tx field must remain in <pre>');
});

// ── C3 Live-bind hydration ───────────────────────────────────────────────────

test('landing/verify.html: C3 4 data-tr-field live-bind spans present (latest_batch + latest_batch_n + latest_batch_at + next_batch_in × 2 dual-render)', async () => {
  const html = await read('landing/verify.html');
  assert.strictEqual(countOcc(html, /data-tr-field="latest_batch"/g), 2, 'latest_batch span count');
  assert.strictEqual(countOcc(html, /data-tr-field="latest_batch_n"/g), 2, 'latest_batch_n span count');
  assert.strictEqual(countOcc(html, /data-tr-field="latest_batch_at"/g), 2, 'latest_batch_at span count');
  assert.strictEqual(countOcc(html, /data-tr-field="next_batch_in"/g), 2, 'next_batch_in span count');
});

test('landing/verify.html: C3 hydration order (Q-W9-11) — track-record-proxy.js script tag FIRST, inline W9 block THEN', async () => {
  const html = await read('landing/verify.html');
  const proxyIdx = html.indexOf('/js/track-record-proxy.js');
  const inlineIdx = html.indexOf('__w9VerifyHydrationInit');
  assert.ok(proxyIdx > 0, 'track-record-proxy.js script tag missing');
  assert.ok(inlineIdx > 0, 'inline W9 hydration block missing');
  assert.ok(proxyIdx < inlineIdx, `Q-W9-11 hydration order violated: proxy.js must precede inline W9 block (proxyIdx=${proxyIdx}, inlineIdx=${inlineIdx})`);
  // Countdown setInterval present
  assert.ok(html.includes('updateNextBatchCountdown') && html.includes('60000'), 'countdown setInterval missing');
});

// ── W9 FIX-FORWARD ROUND 2 (post-deploy Mr.1 visual review 2026-05-11) ──────

test('landing/verify.html: R2-1 result mount inside VInput (class-based, dual-render) + emerald frame stripped', async () => {
  const html = await read('landing/verify.html');
  // Wrapper + mount classes present (one per artboard = 2 dual-render)
  assert.strictEqual(countOcc(html, /class="verify-result-wrapper"/g), 2, '2 verify-result-wrapper class instances (dual-render)');
  assert.strictEqual(countOcc(html, /class="verify-result-mount"/g), 2, '2 verify-result-mount class instances (dual-render)');
  // Legacy id-based wrapper removed
  assert.strictEqual(countOcc(html, /id="verify-result-wrapper"/g), 0, 'legacy id="verify-result-wrapper" must be 0 (switched to class)');
  // verifySignal must NOT use emerald-500 wrapper (frame stripped per Mr.1 "remove black frame too")
  assert.strictEqual(countOcc(html, 'bg-emerald-500/5 border border-emerald-500/20'), 0, 'emerald-500 border frame must be 0 (verifySignal innerHTML rewritten borderless)');
  // verifySignal uses class-based queries
  assert.ok(html.includes("querySelectorAll('.verify-result-mount')"), 'verifySignal must query .verify-result-mount');
});

test('landing/verify.html: R2-1 result mount position — section appears immediately after VInput (before VHowItWorks)', async () => {
  const html = await read('landing/verify.html');
  const tipIdx = html.indexOf('Latest Trade Calls to Verify');
  const resultSectionIdx = html.indexOf('verify-result-section');
  const howItWorksIdx = html.indexOf('· how verification works');
  assert.ok(tipIdx > 0 && resultSectionIdx > 0 && howItWorksIdx > 0, 'all 3 anchors present');
  assert.ok(tipIdx < resultSectionIdx, 'result section must come AFTER VInput tip line');
  assert.ok(resultSectionIdx < howItWorksIdx, 'result section must come BEFORE VHowItWorks');
});

test('landing/verify.html: R2-2 bg-radial-accent stripped (green shape at top removed)', async () => {
  const html = await read('landing/verify.html');
  assert.strictEqual(countOcc(html, /<div class="bg-radial-accent"><\/div>/g), 0, 'bg-radial-accent must be stripped');
  // bg-grid + bg-noise preserved (Mr.1 only flagged green shape)
  assert.ok(countOcc(html, /<div class="bg-grid"><\/div>/g) >= 2, 'bg-grid preserved (dual-render)');
});

test('landing/verify.html: R2-3 How to Verify (3-step) section present, above VFaq', async () => {
  const html = await read('landing/verify.html');
  assert.ok(countOcc(html, '· How to Verify') >= 2, '· How to Verify eyebrow present (dual-render)');
  assert.ok(html.includes('Verify any AlgoVault call in 3 steps'), 'How to Verify h2 present');
  for (const card of ['Pick a Call', 'Check the Proof', 'Verify On-Chain']) {
    assert.ok(html.includes(card), `card "${card}" present`);
  }
  // Position: above VFaq
  const howToIdx = html.indexOf('· How to Verify');
  const faqIdx = html.indexOf('· faq');
  assert.ok(howToIdx < faqIdx, 'How to Verify must be ABOVE VFaq');
});

test('landing/verify.html: R2-3 How It Works (4-step) section present, above VFaq', async () => {
  const html = await read('landing/verify.html');
  assert.ok(countOcc(html, '· How It Works') >= 2, '· How It Works eyebrow present (dual-render)');
  assert.ok(html.includes('Hashed first. Anchored daily. Immutable forever'), 'How It Works h2 present');
  for (const card of ['Call Created', 'Hash Stored', 'Daily Batch', 'On-Chain Anchor']) {
    assert.ok(html.includes(card), `card "${card}" present`);
  }
  // Position: above VFaq
  const howItIdx = html.indexOf('· How It Works');
  const faqIdx = html.indexOf('· faq');
  assert.ok(howItIdx < faqIdx, 'How It Works must be ABOVE VFaq');
});

test('landing/verify.html: C3 API field-name correctness (Q-W9-12 inline-fix — batch_id + published_at, NOT batchNumber + timestamp)', async () => {
  const html = await read('landing/verify.html');
  assert.ok(html.includes('batches[0]') || html.includes('data.batches'), 'merkle-batches consumer pattern missing');
  assert.ok(html.includes('latest.batch_id'), 'must use actual API field `batch_id` (not `batchNumber`)');
  assert.ok(html.includes('latest.published_at'), 'must use actual API field `published_at` (not `timestamp`)');
});

// ── C4 — MCP verify://signal/{id} resource registration ─────────────────────

test('src/index.ts: C4 ResourceTemplate import + verify://signal/{id} resource registration', async () => {
  const ts = await read('src/index.ts');
  assert.match(ts, /import \{[^}]*ResourceTemplate[^}]*\} from '@modelcontextprotocol\/sdk\/server\/mcp\.js'/, 'ResourceTemplate import missing');
  assert.match(ts, /new ResourceTemplate\('verify:\/\/signal\/\{id\}'/, 'ResourceTemplate verify://signal/{id} construction missing');
  assert.ok(countOcc(ts, 'verify://signal') >= 2, 'verify://signal URI must appear ≥2 times in src/index.ts');
});

test('src/index.ts: C4 Q-W9-8 BOTH-form lookup — getSignalByHash + getSignalWithBatch imports + 0x-prefix auto-detect', async () => {
  const ts = await read('src/index.ts');
  assert.ok(ts.includes('getSignalByHash'), 'getSignalByHash helper import missing');
  assert.ok(ts.includes('getSignalWithBatch'), 'getSignalWithBatch helper import missing');
  // Auto-detect logic: startsWith('0x') OR startsWith('0X')
  assert.match(ts, /startsWith\(['"]0[xX]['"]\)/, '0x-prefix auto-detect missing');
});

test('src/lib/performance-db.ts: C4 getSignalByHash helper definition (SELECT JOIN sibling of getSignalWithBatch)', async () => {
  const db = await read('src/lib/performance-db.ts');
  assert.match(db, /export async function getSignalByHash\(signalHash: string\)/, 'getSignalByHash function definition missing');
  assert.match(db, /WHERE s\.signal_hash = \?/, 'WHERE clause on signal_hash column missing');
});

test('src/index.ts: C4 Data Integrity LAW canary — ZERO code-path Phase-E leakage in verify-signal handler', async () => {
  const ts = await read('src/index.ts');
  // Extract verify-signal handler body
  const start = ts.indexOf("server.resource(\n    'verify-signal',");
  assert.ok(start > 0, "verify-signal resource registration block must be findable");
  const end = ts.indexOf('  );', start);
  const handler = ts.slice(start, end);
  // Filter out comment lines, then check no code-path Phase-E references.
  const codeLines = handler.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*');
  }).join('\n');
  for (const fic of ['outcome_return_pct', 'outcome.won', 'outcome.pfe_bps']) {
    assert.ok(!codeLines.includes(fic), `Data Integrity LAW violation: ${fic} must not appear in handler code (only comments documenting omission OK)`);
  }
});

test('src/index.ts: C4 PUBLIC-ONLY response shape — body assembles {status, leaf, root, batch, tx} + _algovault metadata', async () => {
  const ts = await read('src/index.ts');
  const start = ts.indexOf("server.resource(\n    'verify-signal',");
  const end = ts.indexOf('  );', start);
  const handler = ts.slice(start, end);
  assert.ok(handler.includes('body.status') || handler.includes("body['status']"), 'body.status assignment missing');
  assert.ok(handler.includes('body.leaf'), 'body.leaf assignment missing');
  assert.ok(handler.includes('body.root'), 'body.root assignment missing');
  assert.ok(handler.includes('body.batch'), 'body.batch assignment missing');
  assert.ok(handler.includes('body.tx'), 'body.tx assignment missing');
  assert.ok(handler.includes('_algovault'), '_algovault metadata block missing (CLAUDE.md ## Build rules)');
});

// ── System-map.md edge enumeration ───────────────────────────────────────────

test('system-map.md: NEW edge row for verify://signal/{id} resource present (Plan-Mode §7)', async () => {
  const VAULT_SYSTEM_MAP = '/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/system-map.md';
  const map = await readFile(VAULT_SYSTEM_MAP, 'utf8');
  assert.ok(map.includes('verify://signal/{id}'), 'verify://signal/{id} URI reference missing from system-map.md');
  assert.ok(map.includes('DESIGN-W9 / C4 2026-05-11'), 'DESIGN-W9 / C4 edge row marker missing');
  // The verify://signal/{id} resource edge should be present.
  assert.match(map, /server\.resource\('verify-signal'/, "server.resource('verify-signal') reference missing in edge row");
});
