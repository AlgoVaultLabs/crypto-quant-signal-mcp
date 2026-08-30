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
import { describe, expect, it } from 'vitest';
import { buildWorklistSql, parseCli } from '../../src/scripts/backfill-hold-decision-labels.js';

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
