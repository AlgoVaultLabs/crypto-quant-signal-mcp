// EDGE-ADS1-SCORECARD-W1-V2 CH3 — the committed cross-repo parity fixture IS the library's output.
//
// ops/ads1-parity-fixture.json is what the autonomous-optimizer vendors (bytes + pinned sha256) to prove its
// Python port of ADS-1 L0 / L1 reproduces this library. If the library changes, this test fails until the
// fixture is regenerated (`node dist/scripts/ads1-scorecard.js --print-parity-fixture >
// ops/ads1-parity-fixture.json`) — and the AOE pin then fails until the new bytes are vendored, which is
// the point: a changed standard cannot reach one repo only.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parityRows, serializeParityFixture } from '../../src/scripts/ads1/parity-fixture.js';

const JSON_PATH = path.resolve(__dirname, '../../ops/ads1-parity-fixture.json');

describe('ADS-1 parity fixture lock', () => {
  it('the committed JSON is byte-equal to the library output', { timeout: 30_000 }, () => {
    expect(readFileSync(JSON_PATH, 'utf8')).toBe(serializeParityFixture());
  });

  it('the corpus exercises every outcome class and both sides of the cluster floor', () => {
    const f = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as { rows: Array<{ engine: string; always_buy: string }>; expected: Record<string, Record<string, unknown>> };
    const classes = new Set(f.rows.map((r) => r.engine));
    for (const c of ['WIN', 'LOSS', 'FLAT', 'UNRESOLVED', 'INCONSISTENT']) expect(classes.has(c), c).toBe(true);
    expect(f.expected.cluster_edge_complete.clusters_dropped).toBeGreaterThan(0);
    expect(f.expected.cluster_edge_complete.verdict).toBe('PER_CLUSTER');
    expect(f.rows).toHaveLength(parityRows().length);
  });
});
