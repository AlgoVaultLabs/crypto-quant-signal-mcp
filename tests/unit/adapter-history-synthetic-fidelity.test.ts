/**
 * adapter-history-synthetic-fidelity.test.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2.
 * The parametric Bitget / OKX venue (tests/harness/adapter-history-synthetic.ts) answers the contract, the
 * differential and the budget suites for the two venues CH2 re-anchors. It is trusted ONLY because it
 * reproduces every captured page: each Bitget/OKX request in the fixtures (recent, deep, pre-listing, deeper,
 * served-step controls, off-grid boundary probes) must come back with the SAME bar open times, in the same
 * order, and the same venue code (OKX 8H → 51000). A model drift, or a venue that changes its semantics and is
 * recaptured, reddens this file first.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SyntheticVenue, listingFromProbes } from '../harness/adapter-history-synthetic.js';
import type { VenueFixture } from '../harness/adapter-history-model.js';

const FIX = path.resolve(__dirname, '../fixtures/adapter-history');
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')) as T;
const probes = read<{ bitgetListingMs: number; okxListingMs: number; probes: { pair: string; url: string; calledAt: number; json: unknown }[] }>('MODEL-PROBES.json');
const controls = read<{ controls: { pair: string; scenario: string; url: string; calledAt: number; json: unknown }[] }>('CONTROLS.json').controls;
const listingOf = listingFromProbes(probes);

type Case = { label: string; venue: 'BITGET' | 'OKX'; url: string; now: number; json: unknown };
const cases: Case[] = [];
for (const v of ['BITGET', 'OKX'] as const) {
  const f = read<VenueFixture>(`${v}.json`);
  for (const s of [...f.pairs.flatMap((p) => [p.R, p.D]), ...(f.extras ?? [])]) {
    s.requests.forEach((r, i) => cases.push({ label: `${v}/${s.tf}/${s.tag}#${i}`, venue: v, url: r.url, now: s.calledAt, json: r.json }));
  }
}
for (const c of controls) cases.push({ label: `CONTROL ${c.pair}/${c.scenario}`, venue: 'BITGET', url: c.url, now: c.calledAt, json: c.json });
for (const p of probes.probes) cases.push({ label: `PROBE ${p.pair}`, venue: p.pair.startsWith('OKX') ? 'OKX' : 'BITGET', url: p.url, now: p.calledAt, json: p.json });

const openTimes = (j: unknown): number[] => (((j as { data?: unknown[][] } | null)?.data ?? []) as unknown[][]).map((r) => Number(r[0]));

describe('the synthetic Bitget/OKX venue reproduces every captured page', () => {
  it('covers a non-trivial corpus (vacuity guard)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(cases.filter((c) => c.venue === 'OKX').length).toBeGreaterThan(20);
    expect(cases.some((c) => c.label.startsWith('CONTROL'))).toBe(true);
    expect(cases.some((c) => c.label.startsWith('PROBE'))).toBe(true);
  });

  it.each(cases.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    const got = new SyntheticVenue(c.venue, () => c.now, listingOf).answer(c.url) as { code?: string };
    expect(openTimes(got)).toEqual(openTimes(c.json));
    const want = (c.json as { code?: string } | null)?.code;
    if (want != null) expect(got.code).toBe(want);
  });

  it('refuses a Bitget history page above the venue cap (the real endpoint answers HTTP 400 / 40053)', () => {
    const v = new SyntheticVenue('BITGET', () => Date.UTC(2026, 8, 30), listingOf);
    expect(() => v.answer('https://api.bitget.com/api/v2/mix/market/history-candles?productType=USDT-FUTURES&symbol=BTCUSDT&granularity=1H&endTime=1790000000000&limit=201')).toThrow();
  });
});
