/**
 * OPS-ZERO-VS-UNKNOWN-W3 · Ch1 + Ch2 — the claim path's three outcomes.
 *
 * `tryClaimPayment` was `Promise<boolean>`, so `false` meant BOTH "already claimed" (a settled
 * fact) and "the database errored" (no knowledge at all). The route answered 402/replay either
 * way, so the paid rail served nothing for ~25 hours while every gate stayed green — and a
 * well-built client, correctly reading "already used" as terminal, would never have retried.
 *
 * The DB-error case is the one that had NO coverage of any kind, which is why it shipped.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
/**
 * Strip comments LINE-WISE, not with a block regex.
 *
 * A `/*…*\/` regex over a real source file swallows everything between a `/*` that appears inside
 * a string/regex literal and the next `*\/` — which is exactly how this helper deleted the branch
 * it was written to assert, and exactly the trap check-canaries-wired.mjs documents for YAML globs.
 * Dropping whole comment LINES cannot over-reach.
 */
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => {
      const x = l.trim();
      return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*');
    })
    .map((l) => l.replace(/\s\/\/.*$/, ''))
    .join('\n');


/** The body of `if (<cond>) { … }` ONLY — a fixed-size slice bleeds into the NEXT branch, which
 *  is how this file first asserted the replay code was absent while reading the replay branch. */
function branchBody(src: string, cond: string): string {
  const i = src.indexOf(cond);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return '';
}

describe('tryClaimPayment returns three outcomes, not a boolean', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.PERFORMANCE_DB_PATH = ':memory:';
    delete process.env.DATABASE_URL;
  });
  afterEach(() => vi.doUnmock('../../src/lib/performance-db.js'));

  it('CLAIMED on first use', async () => {
    const s = await import('../../src/lib/x402-idempotency-store.js');
    s.ensureProcessedX402PaymentsSchema();
    expect(await s.tryClaimPayment('0x' + 'a'.repeat(64), 'get_trade_call', '0.01', '0xPAYER1')).toBe('CLAIMED');
  });

  it('ALREADY_CLAIMED on a genuine replay by the same payer', async () => {
    const s = await import('../../src/lib/x402-idempotency-store.js');
    s.ensureProcessedX402PaymentsSchema();
    const n = '0x' + 'b'.repeat(64);
    expect(await s.tryClaimPayment(n, 'get_trade_call', '0.01', '0xPAYER1')).toBe('CLAIMED');
    expect(await s.tryClaimPayment(n, 'get_trade_call', '0.01', '0xPAYER1')).toBe('ALREADY_CLAIMED');
  });

  it('CLAIMED for a DIFFERENT payer sharing a nonce (SEC-49 stays fixed)', async () => {
    const s = await import('../../src/lib/x402-idempotency-store.js');
    s.ensureProcessedX402PaymentsSchema();
    const n = '0x' + 'c'.repeat(64);
    expect(await s.tryClaimPayment(n, 'get_trade_call', '0.01', '0xPAYER1')).toBe('CLAIMED');
    expect(await s.tryClaimPayment(n, 'get_trade_call', '0.01', '0xPAYER2')).toBe('CLAIMED');
  });

  it('THE UNCOVERED CASE: a DB error is INDETERMINATE, never ALREADY_CLAIMED', async () => {
    // Force the exact fault shape of the outage: the query throws.
    vi.doMock('../../src/lib/performance-db.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/lib/performance-db.js')>('../../src/lib/performance-db.js');
      return {
        ...actual,
        dbQuery: vi.fn(async () => {
          throw new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification');
        }),
      };
    });
    const s = await import('../../src/lib/x402-idempotency-store.js');
    const outcome = await s.tryClaimPayment('0x' + 'd'.repeat(64), 'get_trade_call', '0.01', '0xPAYER1');
    expect(
      outcome,
      'a database fault reported as ALREADY_CLAIMED is the 25-hour outage — the client is told the proof is spent when it is not',
    ).toBe('INDETERMINATE');
  });

  it('the indeterminate branch is COUNTED, not merely logged', async () => {
    vi.doMock('../../src/lib/performance-db.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/lib/performance-db.js')>('../../src/lib/performance-db.js');
      return { ...actual, dbQuery: vi.fn(async () => { throw new Error('boom'); }) };
    });
    const s = await import('../../src/lib/x402-idempotency-store.js');
    const c = await import('../../src/lib/indeterminate-counter.js');
    c._resetIndeterminateCounters();
    await s.tryClaimPayment('0x' + 'e'.repeat(64), 'get_trade_call', '0.01', '0xPAYER1');
    expect(c.getIndeterminateSnapshot().counts.x402_claim).toBe(1);
  });
});

describe('every call site matches by NAME — truthiness would re-collapse three states into two', () => {
  it('the HTTP route branches on INDETERMINATE and ALREADY_CLAIMED explicitly', () => {
    const src = code(read('../../src/lib/x402-http-routes.ts'));
    expect(src).toMatch(/outcome === 'INDETERMINATE'/);
    expect(src).toMatch(/outcome === 'ALREADY_CLAIMED'/);
    expect(src, 'a `!claimed` test reintroduces the conflation').not.toMatch(/if \(!claimed\)/);
  });

  it('the MCP path branches by name too', () => {
    const src = code(read('../../src/lib/license.ts'));
    expect(src).toMatch(/outcome === 'INDETERMINATE'/);
    expect(src).toMatch(/reason: 'unavailable'/);
  });

  it('the refusal carries a DISTINCT retryable code, not the replay code', () => {
    const src = code(read('../../src/lib/x402-http-routes.ts'));
    const branch = branchBody(src, "outcome === 'INDETERMINATE'");
    expect(branch).toMatch(/X402_CLAIM_UNAVAILABLE/);
    expect(branch).toMatch(/retryable: true/);
    expect(branch, 'mislabelling a transient fault as a replay makes a good client stop retrying')
      .not.toMatch(/X402_PAYMENT_REPLAY/);
  });

  it('the wire message is STATIC — no SQL, no stack, no internal error text (SEC-50)', () => {
    const src = code(read('../../src/lib/x402-http-routes.ts'));
    const branch = branchBody(src, "outcome === 'INDETERMINATE'");
    const body = branch.slice(branch.indexOf('res.status(402).json('));
    expect(body).not.toMatch(/err\.message|String\(err\)|\$\{err/);
  });
});

describe('the shape snapshot governs the new code (same commit)', () => {
  const snap = JSON.parse(read('../../audits/x402-paid-route-shape-snapshot-2026-07-29.json'));

  it('declares the new code on the 402 branch', () => {
    expect(snap.error_contract['402'].codes).toContain('X402_CLAIM_UNAVAILABLE');
  });

  it('declares the new wire key `retryable`', () => {
    expect(snap.allowed_keys).toContain('retryable');
  });

  it('has a dedicated branch stating when it fires and what it guarantees', () => {
    const b = snap.error_contract['402 claim_unavailable'];
    expect(b).toBeDefined();
    expect(b.code).toBe('X402_CLAIM_UNAVAILABLE');
    expect(b.guarantees, 'the caller must be told the proof was NOT consumed').toMatch(/NOT consumed/);
    expect(b.why_402_not_5xx, 'the status decision must be recorded either way').toBeTruthy();
  });

  it('every code the implementation can emit is declared in the snapshot', () => {
    const src = code(read('../../src/lib/x402-http-routes.ts'));
    const emitted = [...src.matchAll(/code: '(X402_[A-Z_]+)'/g)].map((m) => m[1]);
    const declared = new Set([
      ...(snap.error_contract['402'].codes ?? []),
      ...Object.values(snap.error_contract).map((b: any) => b?.code).filter(Boolean),
    ]);
    const undeclared = [...new Set(emitted)].filter((c) => !declared.has(c));
    expect(undeclared, `codes emitted on the wire but absent from the snapshot: ${undeclared.join(', ')}`).toEqual([]);
  });
});
