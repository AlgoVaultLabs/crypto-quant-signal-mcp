// FIX-CONVICTION-CALL-POSTS-W1 — the publish gate that closes the blank-CTA class.
//
// The anchor fixture is not invented: it is the REAL body of dev.to article 4280654,
// published 2026-07-31, fetched from the dev.to API. Its last two lines really are two
// naked labels. Every assertion here is calibrated against that artifact, so a
// regression is measured against what actually shipped rather than a guess at it.
import { describe, it, expect } from 'vitest';
import { checkForumPost, MIN_BODY_WORDS } from '../src/lib/forum-post-gate.js';
import { stripExternalUrlsForModeration } from '../src/lib/forum-post-content.js';

const KEEP = { keepCanonicalDomain: 'algovault.com', keepHosts: ['t.me'] };

/** Verbatim shape of the defective post: CTAs authored as BARE urls. */
const BROKEN_RAW = `High-conviction call: LINK HOLD at 35% confidence

Live from AlgoVault's signal engine:

LINK 1h analysis:

  Verdict: HOLD (35% confidence)
  Price: $12.34
  Regime: TRENDING_DOWN

Trending regime, downward bias. Funding pressure mild.

⚠️ This is signal interpretation, not financial advice.

Real-time signals: https://api.algovault.com/mcp
Full track record: https://algovault.com/track-record`;

/** A healthy post: markdown-link CTAs, one on an allowlisted non-canonical host. */
const GOOD_RAW = `This week's top crypto trade setups

📡 This week I scanned 900 assets across 9 venues.

Top fresh setups:

🟢 KAITO — BUY @ $1.19 · 58% conviction · TRENDING_UP
   📊 trend persistence HIGH · funding elevated ↓
   💡 Trending regime, upward bias

🟢 CATI — BUY @ $0.038 · 51% conviction · TRENDING_UP
   📊 trend persistence HIGH · funding normal
   💡 Trending regime, upward bias

🔴 KOMA — SELL @ $0.41 · 54% conviction · TRENDING_DOWN
   📊 trend persistence HIGH · funding elevated ↑
   💡 Downward bias with persistent trend structure

Every call above is scored by the same engine that publishes its full verified record
on-chain, and every one of them was written down before its outcome was known.

⚠️ This is call interpretation, not financial advice. AlgoVault helps AI agents
analyze — execution decisions are theirs.

🛰 Want this on your coins automatically? Set a standing scan: [t.me/algovaultofficialbot](https://t.me/algovaultofficialbot)
📊 See the full verified track record: [algovault.com/track-record](https://algovault.com/track-record?src=devto)`;

const run = (raw: string) =>
  checkForumPost({
    title: raw.split('\n')[0],
    rawContent: raw,
    strippedContent: stripExternalUrlsForModeration(raw, KEEP),
  });

describe('forum post publish gate', () => {
  it('THE BUG: the real 2026-07-31 post is REJECTED (it published green before this gate)', () => {
    const r = run(BROKEN_RAW);
    expect(r.ok).toBe(false);
    // It must be caught for the RIGHT reason — the bare-URL authoring, not merely length.
    expect(r.failures.join(' ')).toMatch(/G2 bare-url/);
  });

  it('THE SYMPTOM: stripping really does blank those CTAs (the premise, proven not assumed)', () => {
    const shipped = stripExternalUrlsForModeration(BROKEN_RAW, KEEP);
    expect(shipped).toMatch(/Real-time signals:\s*$/m);
    expect(shipped).toMatch(/Full track record:\s*$/m);
    expect(shipped).not.toContain('algovault.com/track-record');
  });

  it('a healthy digest post PASSES (the gate must not block correct copy)', () => {
    const r = run(GOOD_RAW);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('the Telegram CTA survives — the primary CTA must reach the reader as a real link', () => {
    const shipped = stripExternalUrlsForModeration(GOOD_RAW, KEEP);
    expect(shipped).toContain('](https://t.me/algovaultofficialbot)');
  });

  it('WITHOUT the keepHosts allowlist the Telegram link is flattened — and the gate catches it', () => {
    // Proves the allowlist is load-bearing: absent it, the URL is dropped and only the
    // link text survives, which is strictly worse than a bare URL for the reader.
    const shipped = stripExternalUrlsForModeration(GOOD_RAW, { keepCanonicalDomain: 'algovault.com' });
    expect(shipped).not.toContain('t.me/algovaultofficialbot](');
    const r = checkForumPost({ title: 'x', rawContent: GOOD_RAW, strippedContent: shipped });
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(/G3 cta-survival/);
  });

  it('a bare URL inside a CODE FENCE is allowed (connection string, not a link)', () => {
    // The release post legitimately prints the MCP endpoint in a fence. The gate must
    // classify fences exactly as the strip does — hence the shared segmenter.
    const raw = `${GOOD_RAW}\n\n\`\`\`\nRemote MCP   https://api.algovault.com/mcp\n\`\`\``;
    const r = run(raw);
    expect(r.failures.join(' ')).not.toMatch(/G2 bare-url/);
    expect(r.ok).toBe(true);
  });

  it('a post with NO links at all fails — G2/G3 alone would pass it vacuously', () => {
    const raw = `Title here\n\n${'word '.repeat(300)}`;
    const r = run(raw);
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(/G4 cta-present/);
  });

  it('a short post fails on length, with the measured value named', () => {
    const raw = `Title\n\nToo short. [track record](https://algovault.com/track-record)`;
    const r = run(raw);
    expect(r.ok).toBe(false);
    expect(r.failures.join(' ')).toMatch(new RegExp(`G1 length.*minimum is ${MIN_BODY_WORDS}`));
  });

  it('emits POSITIVE per-check output on success — a skipped check must not look like a passing one', () => {
    const r = run(GOOD_RAW);
    expect(r.checks.join('\n')).toMatch(/G1 length: OK/);
    expect(r.checks.join('\n')).toMatch(/G2 bare-url: OK/);
    expect(r.checks.join('\n')).toMatch(/G3 cta-survival: OK/);
    expect(r.checks.join('\n')).toMatch(/G4 cta-present: OK/);
    expect(r.checks).toHaveLength(5);
  });
});
