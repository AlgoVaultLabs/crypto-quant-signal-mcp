import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// EDGE-LABELER-RACE-WINDOW-V2-W1 CH3 — "DONE" measured on the rows, not taken from a runner's say-so
// (registration §1.3; the CH3 gate's D6 / D7). Synthetic ids only.

import {
  sessionRows, parseManifest, relabelCompleteness, annotationCompleteness, main, NULL_V1_GAP_SQL, PROBES,
} from '../../src/scripts/lrw/completeness.js';
import { RO_TOKEN_LINE } from '../../src/scripts/lrw/extract-sql.js';
import { buildRelabelMissingSql } from '../../src/scripts/lrw/relabel-sql.js';

describe('the read-session output', () => {
  it('is accepted only behind the read-only token line', () => {
    expect(sessionRows(`${RO_TOKEN_LINE}\n1,OKX,1h\n2,OKX,1h\n`, 'x')).toEqual(['1,OKX,1h', '2,OKX,1h']);
    expect(() => sessionRows('TOKEN current_user=algovault transaction_read_only=off\n1,OKX,1h', 'x')).toThrow(/read-only token/);
    expect(() => sessionRows('', 'x')).toThrow(/read-only token/);
  });
});

describe('relabel completeness', () => {
  it('the manifest: last class per signal across logs; an unregistered class or a malformed line refuses', () => {
    const m = parseManifest(['x\nLRW_MANIFEST 1 deferred\nLRW_MANIFEST 2 refused:gap', '[ts] noise\nLRW_MANIFEST 1 unreachable:depth\n']);
    expect([...m.entries()]).toEqual([[1, 'unreachable:depth'], [2, 'refused:gap']]);
    expect(() => parseManifest(['LRW_MANIFEST 3 error'])).toThrow(/registered form/);
    expect(() => parseManifest(['LRW_MANIFEST x refused:gap'])).toThrow(/registered form/);
  });

  it('YES only when every still-missing signal carries a registered class and none is deferred', () => {
    const m = parseManifest(['LRW_MANIFEST 1 refused:gap\nLRW_MANIFEST 2 unreachable:adapter-pending\nLRW_MANIFEST 3 deferred']);
    expect(relabelCompleteness(['1,OKX,1h', '2,BITGET,8h'], m)).toEqual({
      missing: 2, unmanifested: 0, deferred: 0, byClass: { 'refused:gap': 1, 'unreachable:adapter-pending': 1 }, byVenue: {},
    });
    expect(relabelCompleteness(['1,OKX,1h', '3,HL,1h', '4,HL,4h'], m)).toMatchObject({ unmanifested: 1, deferred: 1, byVenue: { HL: 2 } });
    expect(relabelCompleteness([], m)).toMatchObject({ missing: 0, unmanifested: 0 });
    expect(() => relabelCompleteness(['1,OKX'], m)).toThrow(/id,exchange,timeframe/);
  });
});

describe('annotation completeness', () => {
  it('counts the NULL -v1 rows the pinned worklists could still annotate, keyed (signal_id, barrier_spec)', () => {
    const gaps = new Map([['5|tau1.0-floor0.30-v1', 2]]);
    expect(annotationCompleteness(['5,tau1.0-floor0.30-v1', '5,tau0.5-floor0.30-v1', '9,tau1.0-floor0.30-v1'], gaps)).toEqual({ nullRows: 3, annotatable: 1 });
    expect(annotationCompleteness(['5,tau0.5-floor0.30-v1'], gaps)).toEqual({ nullRows: 1, annotatable: 0 });
    expect(() => annotationCompleteness(['x,tau1.0-floor0.30-v1'], gaps)).toThrow(/signal_id,barrier_spec/);
  });

  it('the NULL probe reads -v1 specs and the NULL column only — no label column', () => {
    expect(NULL_V1_GAP_SQL).toMatch(/race_gap_candles IS NULL$/);
    for (const c of ['label', 'ambiguous_candle', 'barrier_pct', 't_hit_candles', 'computed_at']) expect(new RegExp(`\\b${c}\\b`).test(NULL_V1_GAP_SQL)).toBe(false);
    expect(PROBES.MISSING_V2()).toBe(buildRelabelMissingSql());
  });
});

describe('the CLI verdict tokens', () => {
  const run = (argv: string[]) => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try { return { rc: main(argv), line: logs.at(-1) ?? '' }; } finally { console.log = orig; }
  };
  it('YES / NO / INDETERMINATE with exit 0 / 1 / 3 — an unreadable or untokened input is never YES', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lrw-cmp-'));
    const w = (n: string, t: string) => { const p = join(dir, n); writeFileSync(p, t); return p; };
    const man = w('m.log', 'LRW_MANIFEST 1 refused:gap\n');
    expect(run(['--relabel', '--missing', w('a.txt', `${RO_TOKEN_LINE}\n1,OKX,1h\n`), '--manifest', man])).toMatchObject({ rc: 0, line: expect.stringMatching(/^LRW_RELABEL_COMPLETE=YES /) });
    expect(run(['--relabel', '--missing', w('b.txt', `${RO_TOKEN_LINE}\n1,OKX,1h\n2,OKX,1h\n`), '--manifest', man])).toMatchObject({ rc: 1, line: expect.stringMatching(/^LRW_RELABEL_COMPLETE=NO /) });
    expect(run(['--relabel', '--missing', w('c.txt', '1,OKX,1h\n'), '--manifest', man])).toMatchObject({ rc: 3, line: expect.stringMatching(/^LRW_RELABEL_COMPLETE=INDETERMINATE /) });
    expect(run(['--relabel', '--missing', join(dir, 'absent.txt'), '--manifest', man]).rc).toBe(3);
    expect(run(['--relabel', '--missing', '--manifest', man]).rc).toBe(3);
    // the annotation reads only the pinned worklists — a synthetic file is refused, INDETERMINATE
    expect(run(['--annotation', '--null-keys', w('n.txt', `${RO_TOKEN_LINE}\n`), '--worklists', w('w.csv.gz', 'x')])).toMatchObject({ rc: 3, line: expect.stringMatching(/not a pinned annotation source/) });
    expect(run([]).rc).toBe(3);
  });
});
