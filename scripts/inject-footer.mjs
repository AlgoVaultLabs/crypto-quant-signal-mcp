#!/usr/bin/env node
/**
 * FOOTER-UNIFY-W1 — build-time canonical-brand-footer injector.
 *
 * Strip-and-reinjects the single-source brand footer (src/lib/footer-content.ts
 * renderBrandFooter, compiled to dist/lib/footer-content.js) into the STATIC brand
 * surfaces, modelled on scripts/build_landing.mjs + scripts/generate_jsonld.mjs.
 *
 * Matches BRAND footers only (by the distinctive oklch(0.13 0.012 265) background
 * signature) and replaces each with the canonical SoT footer for its dual-render
 * variant (desktop padding:44px / mobile padding:32px). The page-nav (faq/glossary),
 * SEO (16 pages), and copyright/MIT (skills/integrations) footer TYPES use different
 * signatures and are NEVER touched (Mr.1 ruling Q2=A).
 *
 *   node scripts/inject-footer.mjs           # rewrite the static brand files in place
 *   node scripts/inject-footer.mjs --check   # CI canary: exit 1 if any file is out of sync
 *
 * Requires `npm run build` first (loads the tsc-emitted CJS SoT via createRequire).
 * Run at WAVE time + commit the result; the deploy then cp's the already-unified files.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const FOOTER_DIST = path.join(REPO_ROOT, 'dist', 'lib', 'footer-content.js');
if (!existsSync(FOOTER_DIST)) {
  console.error(`[inject-footer] missing ${FOOTER_DIST} — run \`npm run build\` first.`);
  process.exit(2);
}
const { renderBrandFooter, BRAND_FOOTER_BG_SIGNATURE } = require(FOOTER_DIST);

const checkMode = process.argv.includes('--check');

// The static brand surfaces (Mr.1 ruling Q1=A). Express brand pages (/track-record,
// /account) render renderBrandFooter() directly in src/ and are NOT static files.
const TARGETS = [
  'landing/index.html',          // apex — dual-render (desktop + mobile artboards)
  'landing/how-it-works.html',   // dual-render
  'landing/integrations/binance.html',
  'landing/integrations/okx.html',
  'landing/integrations/bybit.html',
  'landing/integrations/bitget.html',
  // OPS-INTEGRATIONS-VENUE-PAGES-W1: TARGETS was stale — it listed only the
  // original 4 exchange pages, so gemini/kraken/alpaca never received the
  // single-source brand footer. Now every rendered exchange page.
  'landing/integrations/gemini.html',
  'landing/integrations/kraken.html',
  'landing/integrations/alpaca.html',
  'landing/integrations/hyperliquid.html',
  'landing/integrations/aster.html',
  'landing/integrations/bingx.html',
  'landing/integrations/kucoin.html',
];

// Match a BRAND <footer>…</footer> (opening tag carries the oklch bg signature). Non-greedy
// body; brand footers never nest a <footer>. Other footer types lack this bg → never matched.
const BRAND_FOOTER_RE = new RegExp(
  `<footer\\b[^>]*${BRAND_FOOTER_BG_SIGNATURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>[\\s\\S]*?</footer>`,
  'g',
);

function variantOf(footerHtml) {
  if (footerHtml.includes('padding:44px 80px 56px')) return 'desktop';
  if (footerHtml.includes('padding:32px 22px 36px')) return 'mobile';
  return null; // unknown brand-footer padding → skip (reported)
}

let totalReplaced = 0;
let outOfSync = 0;

for (const rel of TARGETS) {
  const abs = path.join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    console.warn(`[inject-footer] SKIP (absent): ${rel}`);
    continue;
  }
  const before = await readFile(abs, 'utf8');
  let count = 0;
  let unknown = 0;
  const after = before.replace(BRAND_FOOTER_RE, (match) => {
    const variant = variantOf(match);
    if (!variant) { unknown++; return match; }
    count++;
    return renderBrandFooter(variant);
  });
  if (unknown > 0) {
    console.error(`[inject-footer] ${rel}: ${unknown} brand footer(s) with unrecognized padding — left untouched (investigate).`);
  }
  if (count === 0) {
    console.warn(`[inject-footer] ${rel}: 0 brand footers matched (already SoT-only? different markup?)`);
  }
  if (after !== before) {
    if (checkMode) {
      console.error(`[inject-footer] DRIFT: ${rel} footer(s) differ from the SoT (run \`node scripts/inject-footer.mjs\`).`);
      outOfSync++;
    } else {
      await writeFile(abs, after);
      console.log(`[inject-footer] ${rel}: ${count} brand footer(s) re-injected from the SoT.`);
      totalReplaced += count;
    }
  } else {
    console.log(`[inject-footer] ${rel}: ${count} brand footer(s) already in sync.`);
  }
}

if (checkMode) {
  if (outOfSync > 0) {
    console.error(`[inject-footer] --check FAILED: ${outOfSync} file(s) out of sync with the brand-footer SoT.`);
    process.exit(1);
  }
  console.log('[inject-footer] --check OK — all static brand footers match the SoT.');
} else {
  console.log(`[inject-footer] done — ${totalReplaced} footer(s) re-injected across ${TARGETS.length} target(s).`);
}
