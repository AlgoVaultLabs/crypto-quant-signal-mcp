/**
 * OPS-BDIR-V3-PANEL-READINESS-W1 CH2 R3 — the coverage arm's cross-language constants, pinned.
 *
 * `ops/monitoring/directional-label-freshness.py` (host, Python) restates two facts the TypeScript
 * producer owns, because it cannot import TypeScript: the evaluation window per timeframe (which rows
 * have CLOSED their label window) and the FULL-eligible fallback set (used only if the tier mirror is
 * unreadable). A restated fact goes stale silently — so both are pinned here, read out of the Python
 * source, against the one SoT each. The canary's behaviour is pinned by its hermetic suite
 * (ops/monitoring/test-directional-label-freshness.py), which this test also runs.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVAL_CANDLES } from '../../src/scripts/directional-labeler.js';
import { FULL_PANEL_VENUES } from '../../src/lib/venue-slo-tiers.js';

const REPO = path.resolve(__dirname, '../..');
const PY = path.join(REPO, 'ops/monitoring/directional-label-freshness.py');
const SRC = readFileSync(PY, 'utf8');

function pyDict(name: string): Record<string, number> {
  const body = new RegExp(`^${name} = \\{([^}]*)\\}`, 'm').exec(SRC)?.[1] ?? '';
  return Object.fromEntries([...body.matchAll(/"(\w+)":\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
}

describe('directional-label-freshness coverage arm — constants restated from the TS SoT', () => {
  it('EVAL_W equals directional-labeler.ts EVAL_CANDLES exactly', () => {
    const w = pyDict('EVAL_W');
    expect(Object.keys(w).length).toBeGreaterThan(0); // the regex matched something
    expect(w).toEqual(EVAL_CANDLES);
  });

  it('TF_S covers every evaluated timeframe with its length in seconds', () => {
    const tf = pyDict('TF_S');
    for (const k of Object.keys(EVAL_CANDLES)) expect(tf[k], k).toBeGreaterThan(0);
    expect(tf['5m']).toBe(300);
    expect(tf['1d']).toBe(86_400);
  });

  it('the fail-safe FULL panel equals FULL_PANEL_VENUES', () => {
    const body = /^FULL_PANEL_DEFAULT = frozenset\(\{([^}]*)\}\)/m.exec(SRC)?.[1] ?? '';
    const py = [...body.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    expect(py.length).toBeGreaterThan(0);
    expect(py).toEqual([...FULL_PANEL_VENUES].sort());
  });

  it("HL carries a declared REPORT reason naming rule (d) — an exemption that lives only in prose gets 'fixed'", () => {
    expect(SRC).toMatch(/"HL": \(\s*"not FULL-eligible: rule \(d\) fails by candle horizon/);
  });

  it('the hermetic suite passes (coverage arm, capacity forward, frontier arm)', { timeout: 120_000 }, () => {
    const r = spawnSync('python3', [path.join(REPO, 'ops/monitoring/test-directional-label-freshness.py')], { encoding: 'utf8' });
    expect(r.status, r.stdout.slice(-1500)).toBe(0);
    expect(r.stdout).toMatch(/ALL \d+ ASSERTIONS PASSED/);
  });
});
