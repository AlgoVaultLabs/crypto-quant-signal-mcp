// FIX-CONVICTION-CALL-POSTS-W1 — the TS half of the two-sided showcase parity test.
//
// THE PROBLEM THIS SOLVES. The weekly "📡 This week I scanned N assets across M venues"
// digest now renders on TWO surfaces: the Telegram bot (Python, canonical, shipped for
// months) and the dev.to market-insight post (TypeScript, new). Python cannot import
// TypeScript, so the framing is necessarily a MIRROR — and a mirror with no canary is
// just a fork that has not drifted YET.
//
// The two repos cannot import each other's test suites either, so the contract is a
// GOLDEN FIXTURE committed to both: `tests/fixtures/scan-showcase-golden.json`, whose
// `expected` field was produced by EXECUTING the real Python
// (`algovault_bot.adoption.render_scan_showcase`) — not transcribed by hand from reading
// it. The bot repo commits the identical fixture and asserts its renderer reproduces the
// same bytes. Either side drifting fails its own repo's CI.
//
// The fixture deliberately exercises all three price buckets, an arrowed driver, a
// window-suffixed driver, and a setup with NEITHER drivers nor reasoning — the branches
// most likely to be "tidied" independently on one side.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { renderScanShowcase, SCAN_SHOWCASE_TG_CTA, type RenderableScanCall } from '../src/lib/scan-digest.js';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'scan-showcase-golden.json');
const RAW = readFileSync(FIXTURE_PATH);
const GOLDEN = JSON.parse(RAW.toString('utf8')) as {
  setups: RenderableScanCall[];
  assetCount: number;
  venueCount: number;
  expected: string;
};

describe('renderScanShowcase — parity with the canonical Python renderer', () => {
  it('reproduces the Python output BYTE-FOR-BYTE', () => {
    const out = renderScanShowcase(GOLDEN.setups, GOLDEN.assetCount, GOLDEN.venueCount);
    expect(out).toBe(GOLDEN.expected);
  });

  it('the fixture itself has not been edited in place (hash pinned alongside it)', () => {
    // Guards the failure mode where a drift is "fixed" by rewriting the expectation
    // rather than the code. Regenerate deliberately, from the Python, and update both.
    const recorded = readFileSync(`${FIXTURE_PATH}.sha256`, 'utf8').trim();
    expect(createHash('sha256').update(RAW).digest('hex')).toBe(recorded);
  });

  it('an EMPTY setup list returns null — the caller decides what a quiet week means', () => {
    // Python returns None here and the bot suppresses the broadcast; dev.to instead
    // publishes an honest market-state note. Both need the null, not an empty string.
    expect(renderScanShowcase([], 900, 9)).toBeNull();
  });

  it('counts interpolate RAW — thousands separators would silently break parity', () => {
    // The Python f-string prints an int bare. A well-meaning `toLocaleString()` on the
    // TS side would render "1,200 assets" against Python's "1200 assets" — invisible in
    // review, and only reachable at the four-digit counts production actually runs at.
    const out = renderScanShowcase(GOLDEN.setups, 1200, 12)!;
    expect(out).toContain('scanned 1200 assets across 12 venues');
    expect(out).not.toContain('1,200');
  });

  it('the default CTA is the Telegram wording, verbatim', () => {
    const out = renderScanShowcase(GOLDEN.setups, 900, 9)!;
    expect(out.endsWith(SCAN_SHOWCASE_TG_CTA)).toBe(true);
    expect(SCAN_SHOWCASE_TG_CTA).toBe('Want this on your coins automatically? Set a standing scan: /scanwatch.');
  });

  it('a surface may substitute its CTA without touching the digest body', () => {
    // dev.to needs markdown links; "/scanwatch" is meaningless off Telegram. Only the
    // final line may differ — everything above it must stay identical across surfaces.
    const cta = '[track record](https://algovault.com/track-record?src=devto)';
    const out = renderScanShowcase(GOLDEN.setups, GOLDEN.assetCount, GOLDEN.venueCount, { cta })!;
    expect(out.endsWith(cta)).toBe(true);
    const bodyOf = (s: string) => s.split('\n').slice(0, -1).join('\n');
    expect(bodyOf(out)).toBe(bodyOf(GOLDEN.expected));
  });

  it('the golden fixture actually exercises the drift-prone branches (not a vacuous pin)', () => {
    // A parity test over a trivial fixture passes forever while the real format rots.
    expect(GOLDEN.expected).toMatch(/\$64,171/);   // >=1000 -> comma-grouped, 0 decimals
    expect(GOLDEN.expected).toMatch(/\$1\.19/);    // >=1    -> 2 decimals
    expect(GOLDEN.expected).toMatch(/\$0\.0412/);  // <1     -> toFixed(4), zeros stripped
    expect(GOLDEN.expected).toMatch(/funding elevated ↓/); // lowercased value + bearish arrow
    expect(GOLDEN.expected).toMatch(/OI \+27\.6% \(24h\) ↑/); // window suffix + bullish arrow
    expect(GOLDEN.expected).toMatch(/🔴 KOMA — SELL/);        // non-BUY marker
    // KOMA carries neither drivers nor reasoning, so its block is a SINGLE line.
    const koma = GOLDEN.expected.split('\n\n').find((b) => b.includes('KOMA'))!;
    expect(koma.split('\n')).toHaveLength(1);
  });
});
