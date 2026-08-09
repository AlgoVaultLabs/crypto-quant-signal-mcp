/**
 * DESIGN-W3 C5 — Tier A consistency unit tests.
 *
 * Asserts that:
 *   - landing/index.html contains hero-flow-container + 5 hero-flow-edge paths
 *     (5 venues → MCP) + the canonical loader (D2-C foundation preserved).
 *   - landing/index.html contains recent-calls-feed + recent-calls-rows + a
 *     fetchRecentCalls poller calling /api/recent-calls?limit=5 every 2500ms.
 *   - All 5 D1-C exchange names verbatim (Hyperliquid, Binance, Bybit, OKX,
 *     Bitget) — preserved + emit by the new hero flow diagram.
 *   - landing/_design/algovault-design.css contains the canonical D2-C
 *     foundation classes (artboard, bg-grid, bg-radial-violet, bg-radial-
 *     accent, bg-noise, live-pulse) + the W3 extensions (hero-flow-*,
 *     recent-calls-*, tier-stat-*) + the 2 W3 keyframes (hero-flow-pulse,
 *     recent-calls-row-fade-in).
 *   - src/index.ts getPerformanceDashboardHtml emits the canonical loader
 *     <link> + 4 tier-stat-card containers (tier1..tier4) + byTier
 *     hydration block.
 *   - 4-tier preservation (Free/Starter/Pro/Enterprise) — D1-C foundation
 *     unchanged.
 *   - 0 residual gold-classes, 0 residual gold-hex, mint baseline preserved.
 *
 * Run via:   node --test tests/unit/design_w3_consistency.test.mjs
 *
 * Pure file reads — no network, no compile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function read(rel) {
  return readFile(path.join(REPO_ROOT, rel), 'utf-8');
}

test('landing/index.html: D2-C foundation preserved (W7 carry: V1Hero uses same D2-C classes)', async () => {
  const html = await read('landing/index.html');
  // D2-C foundation classes — V1Hero (W7) uses bg-grid + bg-noise + artboard + live-pulse same as W3
  assert.ok(html.includes('class="bg-grid"'), 'bg-grid present (V1Hero artboard layer)');
  assert.match(html, /class="[^"]*artboard/, '.artboard class on hero (V1Hero outer wrap)');
  assert.match(html, /class="[^"]*live-pulse/, '.live-pulse class (V1Hero LIVE pulse)');
  assert.ok(html.includes('algovault-design.css'), 'canonical CSS link present');
  // W7 NOTE: id="live-call-ticker" was W3 hero deliverable — REPLACED by V1Hero ticker card with
  // data-tr-field="total_calls_executed" + data-w7-recent-call mount-point. Data-source
  // equivalence preserved via different DOM.
});

test('landing/index.html: D1-C foundation preserved', async () => {
  const html = await read('landing/index.html');
  assert.match(html, /mint: \{ 50: 'oklch\(0\.97 0\.03 165\)'/, 'OKLCH mint config present');
  assert.match(html, /\bbg-mint-/, 'mint Tailwind classes preserved');
  assert.doesNotMatch(html, /\b(bg|text|border)-gold-[0-9]+/, '0 residual gold-class');
  assert.doesNotMatch(html, /#d4af37|#ffd700/, '0 residual gold-hex');
  assert.match(html, /The Brain Layer for AI Trading Agents/, 'H1 verbatim');
  // W7 fix-forward ROUND 10 (2026-05-11): hero rewritten to 3-line arrangement per Mr.1 directive.
  assert.match(html, /One MCP call returns a composite verdict — direction, confidence, regime/, 'hero opening verbatim (ROUND 10)');
});

test('landing/index.html: hero flow diagram (W7 V0Diagram supersedes W3 hero-flow-container)', async () => {
  const html = await read('landing/index.html');
  // W7 architectural shift 2026-05-10: W3 hero-flow-container REPLACED with V0Diagram (canonical
  // canvas via diagram='flow'). Same data-source binding (5 venues → MCP → AI agent) but
  // different DOM (V0Diagram is a flat SVG with bezier flow lines + featured chips, not the
  // class-based hero-flow-* W3 structure). Test asserts data-source equivalence:
  // - 5 exchange names visible in hero region
  // - venues counter live-binds (V0Diagram footer text "5 venues integrated · 5 featured" via Q-W7-4)
  // - 5 SVG <image> logos (W6 Q-W7 carry-forward integrated into V0Diagram chips)
  for (const ex of ['Hyperliquid', 'Binance', 'Bybit', 'OKX', 'Bitget']) {
    assert.ok(html.includes(ex), `exchange "${ex}" verbatim`);
  }
  assert.match(html, /data-tr-field="exchange_count"/, 'exchange_count live-bind preserved');
  // 5 hero <image> logos × 2 dual-render = 10 in hero region (V0Diagram chips)
  const heroLogos = (html.match(/<image href="\/_design\/logos\//g) || []).length;
  assert.ok(heroLogos >= 5, `≥5 hero SVG <image> logos (got ${heroLogos}; W6 Q-W7 carry-forward integrated into W7 V0Diagram chips)`);
});

test('landing/index.html: hero recent-call (W7 data-w7-recent-call supersedes W3 recent-calls-feed)', async () => {
  const html = await read('landing/index.html');
  // W7 architectural shift 2026-05-10: W3 recent-calls-feed (5-row 2.5s polling)
  // REPLACED with V1Hero ticker card showing MOST RECENT CALL (per Mr.1 H-PR2).
  // W7 fix-forward ROUND 6 (c08edd4 2026-05-11): cadence changed from
  // setInterval(refresh, 1500) to recursive setTimeout(refresh, 1000 +
  // Math.random() * 2000) for organic jitter (1-3s range). The original
  // H-PR2 "1.5s" decision is preserved in spirit (range includes 1.5s) but
  // no longer matches the literal setInterval pattern.
  // Data-source equivalence: still polls /api/recent-calls. Different DOM
  // + different cadence + different scheduling primitive.
  // The W3 5-row recent-calls-feed pattern STILL EXISTS on /track-record (W4 deliverable, out of W7 scope).
  assert.match(html, /data-w7-recent-call/, 'data-w7-recent-call mount-point present (W7 H-PR2)');
  assert.match(html, /aria-live="polite"/, 'aria-live for screen-reader updates');
  assert.match(html, /\/api\/recent-calls\?limit=1/, 'W7 hero polls /api/recent-calls?limit=1');
  assert.match(html, /function scheduleNextRecentCall/, 'W7 hero recursive scheduler (ROUND 6 randomized 1-3s)');
  assert.match(html, /1000 \+ Math\.random\(\) \* 2000/, 'W7 hero cadence range 1000-3000ms (ROUND 6)');
});

test('landing/index.html: inline-style baseline (W6 Q-W1 documented relaxation)', async () => {
  const html = await read('landing/index.html');
  // D2-C baseline was 6. W6 Q-W1 architect-ratified pragmatic raise 2026-05-10:
  // ReactDOMServer renders JSX style={{...}} as inline style= (~190 C2 belowfold + ~250 C3 landing-rest).
  // Full refactor logged as DESIGN-W6-INLINE-STYLE-CLEANUP follow-up.
  const inline = (html.match(/style="/g) || []).length;
  assert.ok(inline <= 2000, `inline style= count = ${inline} (W6 Q-W1 pragmatic baseline raise; cap 2000)`);
});

test('algovault-design.css: D2-C + W3 components both present', async () => {
  const css = await read('landing/_design/algovault-design.css');
  // D2-C foundation
  for (const cls of ['.artboard', '.bg-grid', '.bg-radial-violet', '.bg-radial-accent', '.bg-noise', '.live-pulse']) {
    assert.match(css, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'), `D2-C class ${cls} preserved`);
  }
  // W3 hero-flow extensions
  assert.match(css, /\.hero-flow-container\s*\{/, 'hero-flow-container');
  assert.match(css, /\.hero-flow-edge\s*\{/, 'hero-flow-edge');
  assert.match(css, /\.hero-flow-node-mcp\s*\{/, 'hero-flow-node-mcp');
  // W3 recent-calls extensions
  assert.match(css, /\.recent-calls-feed\s*\{/, 'recent-calls-feed');
  assert.match(css, /\.recent-calls-call-buy\s*\{/, 'recent-calls-call-buy modifier');
  assert.match(css, /\.recent-calls-call-sell\s*\{/, 'recent-calls-call-sell modifier');
  // W3 tier-stat extensions
  assert.match(css, /\.tier-stat-grid\s*\{/, 'tier-stat-grid');
  assert.match(css, /\.tier-stat-card\s*\{/, 'tier-stat-card');
  assert.match(css, /\.tier-stat-pfe-fill\s*\{/, 'tier-stat-pfe-fill');
  // 2 W3 keyframes
  assert.match(css, /@keyframes\s+hero-flow-pulse/, 'hero-flow-pulse keyframe');
  assert.match(css, /@keyframes\s+recent-calls-row-fade-in/, 'recent-calls-row-fade-in keyframe');
  // D2-C pulse keyframe still present
  assert.match(css, /@keyframes\s+pulse\s*\{/, 'D2-C @keyframes pulse preserved');
});

test('src/index.ts: track-record tier breakdown served by the unified leaderboard (P1; was W3 tier-stat-grid)', async () => {
  const ts = await read('src/index.ts');
  // 4 tier-stat-card divs (tier1..tier4)
  // SUPERSEDED BY P1-TRACK-RECORD-LEADERBOARD-W1: the W3 tier-stat-grid (4 per-tier
  // cards in getPerformanceDashboardHtml) is replaced by the unified leaderboard,
  // which reads byTier from the same payload. The .tier-stat-card CSS class itself
  // remains (used by /account + /integrations — see design_w10).
  const func = ts.slice(ts.indexOf('function getPerformanceDashboardHtml'), ts.indexOf('// ── Smithery sandbox export'));
  assert.ok(func.includes('id="leaderboard-section"'), 'unified leaderboard present');
  assert.ok(/d\.byTier/.test(func), 'tier breakdown read from byTier in the leaderboard');
  assert.ok(!func.includes('id="tier-stat-card-tier1"'), 'old per-tier stat cards removed from track-record');
  // Cross-origin algovault-design.css link (D2-C signup + dashboard) preserved
  const links = (ts.match(/https:\/\/algovault\.com\/_design\/algovault-design\.css/g) || []).length;
  assert.ok(links >= 2, `>=2 cross-origin design CSS links (got ${links})`);
});

test('plan-card tiers preserved (REFERRAL-WEB-FIX-W1: extracted index.ts → signup-flow.ts renderPlanCards)', async () => {
  // The 3 paid tier cards moved into the shared renderPlanCards() helper (single-source
  // for getSignupPageHtml + the /join page); getSignupPageHtml output stays byte-identical.
  //
  // OPS-QUOTA-EXHAUSTION-NOTICE-W1: this asserted the SOURCE TEXT of signup-flow.ts, so it
  // failed the moment the card literals started interpolating from the plans SoT — even
  // though the RENDERED bytes were unchanged. A test that greps the source can only certify
  // how the output is spelled in the file, never that the output is right. It now renders the
  // component and asserts the OUTPUT, which is both the original intent and strictly stronger:
  // it would still catch a tier being dropped, and it now also catches the SoT emitting the
  // wrong label, price or allowance.
  const { renderPlanCards } = await import('../../dist/lib/signup-flow.js');
  const html = renderPlanCards();
  assert.match(html, /<h2>Starter<\/h2>/, 'Starter tier preserved');
  assert.match(html, /<h2>Pro<\/h2>/, 'Pro tier preserved');
  // PRICING-MONTHLY-PATH-AND-CARD-CLEANUP-W1: Enterprise renders NO card on either pricing
  // surface — it is contact-us, carried by the line beneath the tier row. Display removal only:
  // plans.ts and the /signup?plan=enterprise route still resolve.
  assert.doesNotMatch(html, /<h2>Enterprise<\/h2>/, 'Enterprise card removed (contact-us)');
  // The rendered prices + allowances are what a visitor actually sees — pin them here so a
  // bad SoT edit fails loudly instead of silently repricing three public pages.
  //
  // PRICING-ANNUAL-AND-HOLD-PROMISE-W1 → PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-C): Starter
  // and Pro lead with the PREPAY price, now a six-month term rather than a year; the monthly
  // figure is still rendered, as the secondary "or $X/mo billed monthly" line. Enterprise has no
  // self-serve price at all — it is contact-us — so its former $299/mo assertion is inverted.
  //
  // Derived from the same dist/ build this canary already imports, for the reason the allowance
  // assertions below give: re-pinning fresh literals just re-arms this failure on the next move.
  const { PREPAY_6MONTH_MONTHS, planPrepayPriceLabel, planPrepayMonthlyEquivalent, planPrepaySavingsPct, planPriceLabel } =
    await import('../../dist/lib/plans.js');
  const M = PREPAY_6MONTH_MONTHS;
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const id of ['starter', 'pro']) {
    assert.match(html, new RegExp(`${esc(planPrepayPriceLabel(id, M))}<span>/${M}mo</span>`), `${id} prepay price rendered`);
    assert.match(html, new RegExp(`${esc(planPrepayMonthlyEquivalent(id, M))}/mo effective`), `${id} effective monthly rate shown beside the prepay total`);
    assert.match(html, new RegExp(`Save ${planPrepaySavingsPct(id, M)}%`), `${id} computed saving rendered`);
    assert.match(html, new RegExp(`or ${esc(planPriceLabel(id))}/mo billed monthly`), `${id} monthly alternative still offered`);
  }
  // R-C: annual left the buyer-facing vocabulary entirely. CH8 archives both annual Stripe
  // Prices, so a surviving /yr card would advertise a term that cannot be bought.
  assert.doesNotMatch(html, /<span>\/yr<\/span>/, 'no annual price block survives on the cards');
  assert.doesNotMatch(html, /interval=year/, 'no annual checkout href survives on the cards');
  assert.doesNotMatch(html, /\$299<span>\/mo<\/span>/, 'Enterprise self-serve price removed (contact-us)');
  // CONTACT-PAGE-APEX-AND-INQUIRY-TYPE-W1: the contact line targets the /contact FORM, not a
  // mailbox. Cloudflare rewrites every mailto: into /cdn-cgi/l/email-protection#, so the
  // preserved-LAW was preserving a link that did not work in a browser. The LAW is unchanged —
  // the cards must still carry a reachable contact path — only the mechanism moved.
  assert.match(html, /<a href="\/contact">Contact us<\/a>/, 'Enterprise contact line rendered (form)');
  assert.doesNotMatch(html, /mailto:/, 'no unclickable mailto CTA on the cards');
  // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-B): the allowances are read from the plan SoT
  // (the same dist/ build this canary already imports `renderPlanCards` from) instead of being
  // hardcoded. The ladder moved 3,000→10,000 and 15,000→100,000; re-pinning fresh literals here
  // would just re-arm this same failure on the next move.
  const { PLANS, planCallsLabel } = await import('../../dist/lib/plans.js');
  assert.match(html, new RegExp(`<li>${planCallsLabel('starter')} calls/month</li>`), 'Starter allowance rendered');
  assert.match(html, new RegExp(`<li>${planCallsLabel('pro')} calls/month</li>`), 'Pro allowance rendered');
  // "Enterprise card removed" can no longer be expressed as "100,000 calls/month is absent" —
  // that is now PRO's allowance. Assert the Enterprise IDENTITY instead: it appears exactly once,
  // in the contact line, and never as a card.
  assert.equal((html.match(new RegExp(PLANS.enterprise.label, 'g')) ?? []).length, 1,
    'Enterprise appears only in the contact line, never as a card');
  // index.ts must call the helper (byte-identical render):
  const idx = await read('src/index.ts');
  assert.match(idx, /\$\{renderPlanCards\(\)\}/, 'getSignupPageHtml renders via renderPlanCards()');
});
