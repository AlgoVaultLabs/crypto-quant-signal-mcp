/**
 * tests/unit/rate-limit-digest.test.ts — OPS-RATELIMIT-TELEMETRY-DIGEST-W1 R4,
 * re-homed by OPS-TELEMETRY-DIGEST-REFRAME-W1 (was shadow-digest-rate-limit.test.ts).
 *
 * buildDigest() renders the rate-limit telemetry section from the per-venue query,
 * emits the W{NEXT} trigger lines only when thresholds trip, and stays silent
 * (zeros) otherwise. dbQuery is mocked per-statement.
 *
 * Venue fixtures matter here: the shadow-throw trigger fires only for venues NOT in
 * PROMOTED_VENUE_NAMES, which is now derived from capabilities.ts (12 promoted) rather
 * than a hardcoded 5. Bitmart/edgeX are genuinely shadow; Aster is PROMOTED and is used
 * below as the regression guard for exactly that fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbQuery = vi.fn();
vi.mock('../../src/lib/performance-db.js', () => ({
  dbQuery: (...args: unknown[]) => dbQuery(...args),
  closeDb: vi.fn(),
}));

import { buildDigest } from '../../src/lib/rate-limit-digest.js';

beforeEach(() => dbQuery.mockReset());

function routeQueries(rateLimitCounts: unknown[], hlWaits: unknown[]) {
  dbQuery.mockImplementation(async (sql: string) => {
    if (/GROUP BY venue, kind, class/i.test(sql)) return rateLimitCounts;
    if (/wait_ms IS NOT NULL/i.test(sql)) return hlWaits;
    return [];
  });
}

describe('buildDigest — rate-limit telemetry section', () => {
  it('renders the per-venue section + BOTH trigger lines when thresholds trip', async () => {
    routeQueries(
      [
        { venue: 'Bitmart', kind: 'throw', class: 'batch', n: '4' },             // shadow ≥3 → SHADOW-BUDGET
        { venue: 'Hyperliquid', kind: 'throw', class: 'interactive', n: '30' },  // HL ≥25 interactive throws → DENIAL trigger
        { venue: 'Hyperliquid', kind: 'wait', class: 'batch', n: '3' },          // by-design batch waits (diagnostics only, NOT a trigger)
      ],
      [{ wait_ms: 25000 }, { wait_ms: 30000 }],                                   // p95 30s — shown in the SECTION, never the alert
    );
    const { text } = await buildDigest();
    expect(text).toContain('⚡ *Rate-limit telemetry (7d)*');
    expect(text).toContain('*Bitmart*: 4 throws (i:0/b:4)');
    expect(text).toContain('HL batch-wait p95: 30.0s');                          // p95 stays in the diagnostic section
    expect(text).toContain('OPS-SHADOW-BUDGET-W{NEXT}');
    // OPS-RATELIMIT-DIGEST-THRESHOLD-RECAL-W1: HL trigger is denial-only (fires on the 30
    // interactive throws), driver-agnostic action (OPS-HL-WEBSOCKET cancelled). The ALERT carries
    // NO batch-wait p95 — that's diagnostics, in the section above, not an alarm.
    expect(text).toContain('investigate the HL interactive driver');
    expect(text).not.toContain('OPS-HL-WEBSOCKET');
    expect(text).not.toMatch(/-W\d/); // never a literal wave number
  });

  it('REGRESSION (OPS-TELEMETRY-DIGEST-REFRAME-W1): a PROMOTED venue never trips the shadow trigger', async () => {
    // Aster is promoted (OPS-VENUE-GO-LIVE-2026-06-30) but the digest hardcoded the ORIGINAL 5
    // promoted names, so ~2.4k Aster throws/7d fired a SHADOW-BUDGET alert recommending the wrong
    // wave class. PROMOTED_VENUE_NAMES now derives from capabilities.ts, so this must stay silent.
    routeQueries([{ venue: 'Aster', kind: 'throw', class: 'batch', n: '2466' }], []);
    const { text } = await buildDigest();
    expect(text).toContain('*Aster*: 2466 throws');   // still REPORTED in the per-venue section
    expect(text).not.toContain('Action: dispatch');   // but NOT flagged as a shadow venue
    expect(text).not.toContain('OPS-SHADOW-BUDGET');
  });

  it('classifies the other newly-promoted venues correctly too (Gate is the venueName-vs-label trap)', async () => {
    // GATE's capabilities.ts label is "Gate.io" but rate_limit_events.venue carries the
    // VENUE_FETCH_CONFIGS venueName "Gate". Deriving names from .label would misclassify it as
    // shadow — this asserts we derive from venueName.
    routeQueries(
      [
        { venue: 'Gate', kind: 'throw', class: 'batch', n: '50' },
        { venue: 'KuCoin', kind: 'throw', class: 'batch', n: '50' },
        { venue: 'Phemex', kind: 'throw', class: 'batch', n: '50' },
      ],
      [],
    );
    const { text } = await buildDigest();
    expect(text).not.toContain('Action: dispatch');
  });

  it('a genuinely-shadow venue still trips the trigger', async () => {
    routeQueries([{ venue: 'edgeX', kind: 'throw', class: 'batch', n: '373' }], []);
    const { text } = await buildDigest();
    expect(text).toContain('OPS-SHADOW-BUDGET-W{NEXT}');
  });

  it('renders zeros + NO trigger lines when there are no events', async () => {
    routeQueries([], []);
    const { text } = await buildDigest();
    expect(text).toContain('⚡ *Rate-limit telemetry (7d)*');
    expect(text).toContain('(no rate-limit events — all venues healthy)');
    expect(text).not.toContain('Action: dispatch');
  });

  it('renders the section but NO trigger line when below thresholds (2 shadow throws, 19s p95)', async () => {
    routeQueries(
      [{ venue: 'Bitmart', kind: 'throw', class: 'batch', n: '2' }, { venue: 'Hyperliquid', kind: 'wait', class: 'batch', n: '1' }],
      [{ wait_ms: 19000 }],
    );
    const { text } = await buildDigest();
    expect(text).toContain('*Bitmart*: 2 throws');
    expect(text).not.toContain('Action: dispatch');
  });

  it('fail-open: a telemetry query error degrades to a notice, never crashes the digest', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (/rate_limit_events/i.test(sql)) throw new Error('relation "rate_limit_events" does not exist');
      return [];
    });
    const { text } = await buildDigest();
    expect(text).toContain('rate-limit telemetry unavailable');
    expect(text).toContain('OPS TELEMETRY WEEKLY DIGEST'); // rest of the digest still renders
  });

  it('carries NO trace of the retired 1m/3m shadow-seed verdict section', async () => {
    routeQueries([], []);
    const { text } = await buildDigest();
    expect(text).not.toContain('SHADOW-SEED');
    expect(text).not.toContain('Decision threshold');
    expect(text).not.toContain('INSUFFICIENT_DATA');
  });
});
