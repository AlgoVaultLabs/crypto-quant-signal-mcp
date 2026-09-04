/**
 * hold-decision-label-filters.test.ts — EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1 R2.
 *
 * The wave adds three ADDITIVE work-list filters (`--side`, `--conf-min`, `--conf-max`) to the
 * counterfactual labeler so a dedicated backfill can target one band instead of spending the
 * breadth-first budget on ~486k rows it does not need. "Additive" is a claim, and this file is
 * its proof: with the flags absent, `buildWorklistSql` must emit SQL and params BYTE-IDENTICAL
 * to the pre-flag implementation. The expected literal below was captured from the UNMODIFIED
 * `origin/main` build (`e680b1ec`, dist output, nowSec=1788064175) BEFORE the flags were added —
 * it is the pre-change behaviour, pinned, not a snapshot of whatever the code now does.
 *
 * The barrier arithmetic is untouched by construction — it lives in `directional-labeler.ts`
 * and this wave edits only the work-list query builder + CLI parsing.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSinceWithoutPartsSql, buildWorklistSql, parseCli } from '../../src/scripts/backfill-hold-decision-labels.js';

const NOW_SEC = 1_788_064_175; // fixed instant used for the origin/main capture

/** Captured verbatim from origin/main@e680b1ec dist (pre-flag) — do not reformat. */
const PRE_FLAG_SQL =
  '\n    WITH eligible AS (\n      SELECT h.decision_id, h.decided_at, h.coin, h.timeframe, h.exchange,\n' +
  '             h.would_be_side, h.price_at_decision,\n             ROW_NUMBER() OVER (\n' +
  '               PARTITION BY h.exchange, h.coin, h.timeframe ORDER BY h.decided_at ASC\n' +
  '             ) AS rn\n        FROM hold_decisions h\n' +
  "       WHERE h.would_be_side <> 0 AND h.exchange IS NOT NULL AND h.timeframe <> '1m' AND NOT EXISTS (SELECT 1 FROM hold_decision_labels l\n" +
  '                WHERE l.hold_decision_id = h.decision_id AND l.barrier_spec = $1)\n    )\n' +
  '    SELECT decision_id, decided_at, coin, timeframe, exchange, would_be_side, price_at_decision\n' +
  '      FROM eligible\n     WHERE rn <= $2\n' +
  '     ORDER BY exchange, coin, timeframe, decided_at\n     LIMIT $3';

describe('R2 additive work-list filters', () => {
  it('flags absent ⇒ SQL + params byte-identical to the pre-flag origin/main build', () => {
    const { sql, params } = buildWorklistSql(parseCli([]), NOW_SEC);
    expect(sql).toBe(PRE_FLAG_SQL);
    expect(params).toEqual(['tau1.0-floor0.30-v1', 3, 4000]);
  });

  it('flags absent ⇒ byte-identical even with the pre-existing filters in play', () => {
    const cli = parseCli(['--venue', 'BINANCE', '--timeframe', '4h', '--per-cell', '5']);
    const { sql, params } = buildWorklistSql(cli, NOW_SEC);
    // pre-existing conditionals keep their exact shape and ordering
    expect(sql).toContain('h.exchange = $2');
    expect(sql).toContain('h.timeframe = $3');
    expect(params).toEqual(['tau1.0-floor0.30-v1', 'BINANCE', '4h', 5, 4000]);
    expect(sql).not.toMatch(/h\.confidence|h\.would_be_side = \$/);
  });

  it('--side sell narrows to would_be_side = -1; buy to +1', () => {
    const sell = buildWorklistSql(parseCli(['--side', 'sell']), NOW_SEC);
    expect(sell.sql).toContain('h.would_be_side = $2');
    expect(sell.params).toEqual(['tau1.0-floor0.30-v1', -1, 3, 4000]);
    const buy = buildWorklistSql(parseCli(['--side', 'buy']), NOW_SEC);
    expect(buy.params).toEqual(['tau1.0-floor0.30-v1', 1, 3, 4000]);
  });

  it('--conf-min/--conf-max bound the confidence band inclusively', () => {
    const cli = parseCli(['--side', 'sell', '--conf-min', '45', '--conf-max', '62']);
    const { sql, params } = buildWorklistSql(cli, NOW_SEC);
    expect(sql).toContain('h.would_be_side = $2');
    expect(sql).toContain('h.confidence >= $3');
    expect(sql).toContain('h.confidence <= $4');
    expect(params).toEqual(['tau1.0-floor0.30-v1', -1, 45, 62, 3, 4000]);
    // the structural exclusions the filters must never displace
    expect(sql).toContain("h.would_be_side <> 0 AND h.exchange IS NOT NULL AND h.timeframe <> '1m'");
  });

  it('conf-min of 0 is honoured, not dropped as falsy', () => {
    const { sql, params } = buildWorklistSql(parseCli(['--conf-min', '0']), NOW_SEC);
    expect(sql).toContain('h.confidence >= $2');
    expect(params).toEqual(['tau1.0-floor0.30-v1', 0, 3, 4000]);
  });

  it('rejects invalid values loudly', () => {
    expect(() => parseCli(['--side', 'short'])).toThrow(/--side must be 'buy' or 'sell'/);
    expect(() => parseCli(['--conf-min', '101'])).toThrow(/integer 0\.\.100/);
    expect(() => parseCli(['--conf-max', '4.5'])).toThrow(/integer 0\.\.100/);
    expect(() => parseCli(['--conf-min', '62', '--conf-max', '45'])).toThrow(/must be <=/);
  });
});

/**
 * EDGE-ATTRIBUTION-CORPUS-DRAIN-W1 R1 — `--since` + `--require-parts`.
 *
 * The same additive contract, proven against the SAME pre-flag literal above. Reusing
 * `PRE_FLAG_SQL` rather than capturing a fresh golden is the point: a golden re-captured from the
 * current build pins whatever the code now does and can never fail. A second wave adding filters
 * must be held to the first wave's baseline, not to its own.
 */
describe('R1 date + parts work-list filters', () => {
  it('both flags absent ⇒ still byte-identical to the SAME pre-flag origin/main build', () => {
    const { sql, params } = buildWorklistSql(parseCli([]), NOW_SEC);
    expect(sql).toBe(PRE_FLAG_SQL);
    expect(params).toEqual(['tau1.0-floor0.30-v1', 3, 4000]);
    expect(sql).not.toContain('raw_final');
    expect(sql).not.toContain('h.decided_at >=');
  });

  it('--since binds an ABSOLUTE epoch and never shifts with nowSec', () => {
    const cli = parseCli(['--since', '1788172475']);
    const a = buildWorklistSql(cli, NOW_SEC);
    const b = buildWorklistSql(cli, NOW_SEC + 30 * 86_400); // a month later
    expect(a.sql).toContain('h.decided_at >= $2');
    expect(a.params).toEqual(['tau1.0-floor0.30-v1', 1_788_172_475, 3, 4000]);
    expect(b.params).toEqual(a.params); // ← the whole reason --lookback-days was not enough
  });

  it('--lookback-days DOES shift with nowSec — the defect --since exists to fix', () => {
    const cli = parseCli(['--lookback-days', '4']);
    const a = buildWorklistSql(cli, NOW_SEC);
    const b = buildWorklistSql(cli, NOW_SEC + 86_400);
    expect(a.sql).toContain('h.decided_at > $2');
    expect(b.params[1]).toBe((a.params[1] as number) + 86_400);
  });

  it('--since accepts ISO8601 and epoch-seconds as the same instant', () => {
    expect(parseCli(['--since', '2026-08-31T10:34:35Z']).since)
      .toBe(parseCli(['--since', '1788172475']).since);
  });

  it('--require-parts adds an unparameterised NOT NULL test, written last', () => {
    const { sql, params } = buildWorklistSql(parseCli(['--require-parts']), NOW_SEC);
    expect(sql).toContain('h.raw_final IS NOT NULL');
    expect(params).toEqual(['tau1.0-floor0.30-v1', 3, 4000]); // consumes no bind
    expect(sql.indexOf('h.raw_final IS NOT NULL')).toBeGreaterThan(sql.indexOf('NOT EXISTS'));
  });

  it('the new predicates land AFTER the R2 filters — param numbering preserved', () => {
    const cli = parseCli([
      '--side', 'sell', '--conf-min', '45', '--since', '1788172475', '--require-parts',
    ]);
    const { sql, params } = buildWorklistSql(cli, NOW_SEC);
    expect(sql).toContain('h.would_be_side = $2');
    expect(sql).toContain('h.confidence >= $3');
    expect(sql).toContain('h.decided_at >= $4');
    expect(params).toEqual(['tau1.0-floor0.30-v1', -1, 45, 1_788_172_475, 3, 4000]);
    expect(sql).toContain('WHERE rn <= $5');
    expect(sql).toContain('LIMIT $6');
  });

  it('--require-parts WINS over a looser --since: they intersect, never union', () => {
    // A --since deliberately older than capture start still cannot admit a parts-less row.
    const { sql } = buildWorklistSql(parseCli(['--since', '1', '--require-parts']), NOW_SEC);
    expect(sql).toContain('h.decided_at >= $2');
    expect(sql).toContain('h.raw_final IS NOT NULL');
    expect(sql).not.toContain(' OR '); // ANDed — the intersection IS the parts predicate winning
  });

  it('the disagreement counter INVERTS the parts test and changes nothing else', () => {
    const cli = parseCli(['--since', '1788172475', '--require-parts', '--side', 'sell']);
    const work = buildWorklistSql(cli, NOW_SEC);
    const gap = buildSinceWithoutPartsSql(cli, NOW_SEC);
    expect(gap.sql.startsWith('SELECT count(*)')).toBe(true);
    expect(gap.sql).toContain('h.raw_final IS NULL');
    // scoped to the parts column: `h.exchange IS NOT NULL` is a structural exclusion and MUST stay
    expect(gap.sql).not.toContain('h.raw_final IS NOT NULL');
    expect(gap.sql).toContain('h.exchange IS NOT NULL');
    // ONE derivation: every eligibility term the work-list carries, the counter carries too
    for (const term of [
      'h.would_be_side <> 0', "h.timeframe <> '1m'", 'h.would_be_side = $2', 'h.decided_at >= $3',
    ]) {
      expect(work.sql).toContain(term);
      expect(gap.sql).toContain(term);
    }
    expect(gap.params).toEqual(['tau1.0-floor0.30-v1', -1, 1_788_172_475]); // no perCell/limit binds
    expect(gap.sql).not.toContain('ROW_NUMBER');
    expect(gap.sql).not.toContain('LIMIT');
  });

  it('rejects an unparseable --since loudly rather than defaulting to 1970', () => {
    expect(() => parseCli(['--since', 'yesterday'])).toThrow(/ISO8601 or epoch-seconds/);
    expect(() => parseCli(['--since', '0x1'])).toThrow(/ISO8601 or epoch-seconds/); // Number('0x1') === 1
    expect(() => parseCli(['--since', '0'])).toThrow(/positive epoch-second/);
  });
});

/**
 * EDGE-ATTRIBUTION-CORPUS-DRAIN-W1 R2 — the one-way priority, PINNED.
 *
 * The drain yields to interactive callers because this script's entry point runs under
 * `runAsBatch`, and `WeightBudget.acquire` caps a batch caller at `ceiling − interactiveReserve`
 * while an interactive one may use the whole ceiling. That is structural, and it was already true
 * before this wave — which is exactly why it needs a pin rather than a build: a refactor that
 * dropped the wrapper would take the guarantee with it and NOTHING would go red. The drain would
 * still work. It would just quietly start competing with paying callers.
 *
 * Asserted on SOURCE TEXT with comments stripped first, following `check-canaries-wired.mjs`'s
 * rule that a mention in a comment is not an invocation — this file's own header names
 * `runAsBatch` several times and must not be able to satisfy its own test.
 */
describe('R2 batch weight-class priority', () => {
  const SRC = readFileSync(
    new URL('../../src/scripts/backfill-hold-decision-labels.ts', import.meta.url),
    'utf8',
  );
  /** Strip line and block comments so prose about `runAsBatch` cannot pass for a call to it. */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('the entry point runs main() inside runAsBatch', () => {
    expect(code).toContain('runAsBatch');
    expect(code).toMatch(/runScript\([^)]*,\s*\(\)\s*=>\s*runAsBatch\(\(\)\s*=>\s*main\(\)\)\s*\)/);
  });

  it('it is imported from the budget engine, not shadowed locally', () => {
    expect(code).toMatch(/import\s*\{[^}]*\brunAsBatch\b[^}]*\}\s*from\s*'[^']*upstream-weight-budget/);
    expect(code).not.toMatch(/(const|let|function)\s+runAsBatch/);
  });

  it('never escalates itself to the interactive lane', () => {
    expect(code).not.toContain('runAsInteractive');
  });

  it('the comment-stripper actually strips — the pin cannot be satisfied by prose', () => {
    const proseOnly = '/** runAsBatch runAsInteractive */\n// runAsBatch\nconst x = 1;\n';
    const stripped = proseOnly.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(stripped).not.toContain('runAsBatch');
    // and the real file still carries the call AFTER stripping, so the strip is not over-eager
    expect(code).toContain('runAsBatch');
  });
});
