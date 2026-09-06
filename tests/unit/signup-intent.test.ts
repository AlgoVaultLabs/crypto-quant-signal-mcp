/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH3 — the ONE definition of human checkout intent,
 * and the two dashboard retirements it made possible.
 *
 * The property under test is not "the SQL string looks right". It is that FOUR derivations which
 * previously answered one question three different ways now project from a single definition —
 * because a dashboard whose headline counts humans while the channel split beside it counts
 * requests contradicts itself in a way a reader cannot see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SIGNUP_PAID_TIERS,
  HUMAN_INTENT_CLASS,
  UNKNOWN_INTENT_CLASS,
  PAID_TIER_PREDICATE,
  intentClassPredicate,
  intentCountSql,
  INTENT_LABELS,
} from '../../src/lib/signup-intent.js';
import { renderFunnelDashboardHtml } from '../../src/lib/funnel-dashboard-html.js';

const REPO = join(__dirname, '..', '..');

describe('the definition', () => {
  it('counts DISTINCT client_reference_id, never rows', () => {
    // Rows would count a re-click as a second intent; `client_reference_id` is the key everything
    // downstream joins on.
    for (const s of ['human', 'unknown', 'raw'] as const) {
      expect(intentCountSql(s)).toContain('COUNT(DISTINCT client_reference_id)');
      expect(intentCountSql(s)).not.toContain('COUNT(*)');
    }
  });

  it('always excludes the `free` rows deferred-signup writes into the same table', () => {
    // Load-bearing, not cosmetic: those rows are not checkout starts at all.
    for (const s of ['human', 'unknown', 'raw'] as const) {
      expect(intentCountSql(s)).toContain(PAID_TIER_PREDICATE);
    }
    for (const t of SIGNUP_PAID_TIERS) expect(PAID_TIER_PREDICATE).toContain(t);
    expect(PAID_TIER_PREDICATE).not.toContain("'free'");
  });

  it('the human series filters to `browser`, and only that', () => {
    expect(intentCountSql('human')).toContain(intentClassPredicate(HUMAN_INTENT_CLASS));
    expect(intentCountSql('human')).not.toContain(intentClassPredicate(UNKNOWN_INTENT_CLASS));
  });

  it('the unknown series is its OWN series — never merged into human', () => {
    expect(intentCountSql('unknown')).toContain(intentClassPredicate(UNKNOWN_INTENT_CLASS));
    expect(intentCountSql('unknown')).not.toContain(intentClassPredicate(HUMAN_INTENT_CLASS));
  });

  it('the raw series carries NO class filter, so it still sees pre-CH1 NULL rows', () => {
    // NULL is never equal to anything in SQL, so a class-filtered query silently drops every row
    // written before the column existed. `raw` is what keeps the historical series readable, which
    // is the add-before-you-remove half of this change.
    expect(intentCountSql('raw')).not.toContain('classification =');
  });

  it('the upper bound is opt-in, so the two callers can differ without a second query', () => {
    // The scoreboard windows from an ISO start; the snapshot bounds both ends.
    expect((intentCountSql('human').match(/\?/g) ?? []).length).toBe(1);
    expect((intentCountSql('human', { toBound: true }).match(/\?/g) ?? []).length).toBe(2);
  });

  it('labels are stable and distinct (two series named the same way is the drift)', () => {
    const vals = Object.values(INTENT_LABELS);
    expect(new Set(vals).size).toBe(vals.length);
    expect(INTENT_LABELS.human).toBe('Checkout intent (human)');
  });
});

describe('all four derivations project from it (single-derivation)', () => {
  const scoreboard = readFileSync(join(REPO, 'src', 'lib', 'funnel-scoreboard.ts'), 'utf8');
  const snapshot = readFileSync(join(REPO, 'src', 'lib', 'funnel-snapshot.ts'), 'utf8');

  it('funnel-scoreboard imports the definition rather than re-writing the predicate', () => {
    expect(scoreboard).toContain("from './signup-intent.js'");
    expect(scoreboard).toContain("intentCountSql('human')");
    expect(scoreboard).toContain("intentCountSql('unknown')");
    expect(scoreboard).toContain("intentCountSql('raw')");
  });

  it('funnel-snapshot reads the SAME definition', () => {
    expect(snapshot).toContain("from './signup-intent.js'");
    expect(snapshot).toContain('intentCountSql(series');
  });

  it('by_channel and ai_referral share the human predicate (they read the same rows)', () => {
    // These two were computed over EVERY row. Re-keying the stage and leaving them is how a
    // dashboard ends up asserting two different populations on one panel.
    const chanQuery = scoreboard.slice(
      scoreboard.indexOf('channel, referrer, utm_source FROM signup_attribution'),
    ).slice(0, 400);
    expect(chanQuery).toContain('PAID_TIER_PREDICATE');
    expect(chanQuery).toContain('intentClassPredicate(HUMAN_INTENT_CLASS)');
  });

  it('neither funnel module hand-writes a signup_attribution class filter', () => {
    // Strip comments first — the prose EXPLAINING the ban is the most valuable text in these files
    // and a naive grep would demand its deletion.
    for (const src of [scoreboard, snapshot]) {
      const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n');
      expect(code).not.toMatch(/classification\s*=\s*'browser'/);
    }
  });
});

describe('the dashboard shell tells the truth without executing JavaScript', () => {
  const html = renderFunnelDashboardHtml();

  it('SERVES the intent definition, so a curl (and the chapter gate) can read it', () => {
    // Every number on this page arrives from an XHR and is rendered client-side. That is fine for
    // numbers and wrong for the DEFINITION: the whole point of the wave is that the top stage
    // silently meant something other than its label, so the label must survive a plain fetch.
    expect(html).toContain(INTENT_LABELS.human);
    expect(html).toContain(INTENT_LABELS.unknown);
    expect(html).toContain(INTENT_LABELS.raw);
  });

  it('the three-per-call-price HOLD revenue projection is GONE', () => {
    // Flat billing since 2026-08-08, HOLD included — the panel modelled a price that no longer
    // exists, on an operator dashboard read for decisions.
    expect(html).not.toContain('Revenue sensitivity');
    expect(html).not.toContain('/ HOLD</div>');
  });

  it('the metered split it sat on is KEPT (add before you remove)', () => {
    // The projection goes; the measurement stays. Nothing that anything else derives from is lost.
    expect(html).toContain('HOLD calls (metered)');
    expect(html).toContain('Trade calls (metered)');
    expect(html).toContain('Non-verdict calls');
  });

  it('the withdrawn conclusion is gone from the RENDERED output', () => {
    expect(html).not.toContain('binding constraint is traffic/demand');
  });

  it('the withdrawal is stated, not merely silent', () => {
    // A conclusion that was published and acted on is retracted explicitly. Deleting the sentence
    // and saying nothing would leave every reader who saw it still believing it.
    expect(html).toContain('WITHDRAWN');
    expect(html).toContain('FUNNEL-FIX-HUMAN-SIGNUP-W1');
  });

  it('"TTFC not instrumented" is kept — it is still true', () => {
    expect(html).toContain('time-to-first-call');
  });
});
