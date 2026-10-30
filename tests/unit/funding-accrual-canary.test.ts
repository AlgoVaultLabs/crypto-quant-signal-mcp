/**
 * OPS-BDIR-V3-PANEL-READINESS-W1 CH1 — funding-accrual canary, pinned CROSS-LANGUAGE.
 *
 * `ops/monitoring/funding-accrual-freshness.py` runs from cron on signal-1 and nothing in the
 * TypeScript tree can import it, so the honest way to pin its contract is to RUN the shipped
 * `main()` and read what it emits. Its own `--self-test` asserts the predicate and the SQL SHAPE,
 * but a hermetic self-test is blind to exactly what its seam replaces: that `main()` really returns
 * the mapped exit codes, prints exactly one token on every path, pages on FAIL and clears on PASS.
 *
 * It also pins the predicate's declared venue set to the venues the research backfill ACCRUES
 * (`src/scripts/backfill-funding-episodes.ts`'s own venue map) — the table the predicate watches —
 * and requires every `FUNDING_VENUE_META` venue to be either accrued there or declared arb-only, so a
 * funding venue promoted to the arb cannot go unwatched by accident (and a retired one cannot keep
 * paging). DECISION-CALL-V1-W1 R7: the comparator was `FUNDING_VENUE_META` itself until Bitget joined
 * the arb (R3) without joining the research accrual.
 *
 * SPAWN BUDGET DECLARED in each block's OPTIONS arg (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FUNDING_VENUE_META } from '../../src/lib/funding-venues.js';

const REPO = path.resolve(__dirname, '../..');
const PY = path.join(REPO, 'ops/monitoring/funding-accrual-freshness.py');
const PRED = path.join(REPO, 'ops/monitoring/funding_accrual_predicate.py');
const BACKFILL = path.join(REPO, 'src/scripts/backfill-funding-episodes.ts');
const SRC = readFileSync(PY, 'utf8');
const TOKEN = 'FUNDING_ACCRUAL_VERDICT';

const tokenLines = (stdout: string): string[] => stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));

const HEALTHY = [
  'ASTER|8|0.25|60|31|15', // exempt from coverage/share by declaration
  'BINANCE|8|0.10|60|60|60',
  'BYBIT|8|2.10|60|60|60',
  'GATE|8|1.00|60|60|60',
  'HL|1|0.12|60|58|58',
  'KUCOIN|8|2.10|60|60|59',
  'OKX|8|0.40|60|60|60',
].join('\n');
// OKX exactly as measured on 2026-09-26 at 10:07Z, before the fix
const OKX_STALE = HEALTHY.replace('OKX|8|0.40|60|60|60', 'OKX|8|98.40|60|1|0');

function run(opts: { rows?: string; psqlFails?: boolean }): { stdout: string; status: number; tg: string; log: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'funding-accrual-'));
  try {
    const rowsFile = path.join(dir, 'rows.txt');
    writeFileSync(rowsFile, opts.rows ?? '');
    const psql = path.join(dir, 'psql-stub.sh');
    writeFileSync(psql, opts.psqlFails
      ? '#!/bin/sh\necho "connection refused" >&2\nexit 2\n'
      : `#!/bin/sh\ncat ${JSON.stringify(rowsFile)}\n`, { mode: 0o755 });
    const tgLog = path.join(dir, 'tg.log');
    const tg = path.join(dir, 'tg-stub.sh');
    writeFileSync(tg, `#!/bin/sh\n{ echo "ARGV: $*"; if [ "$3" = "-" ]; then cat; fi; } >> ${JSON.stringify(tgLog)}\n`, { mode: 0o755 });
    const results = path.join(dir, 'canary-results.jsonl');
    const r = spawnSync('python3', [PY], {
      encoding: 'utf8',
      env: { ...process.env, FA_PSQL_CMD: psql, FA_TG_WRAPPER: tg, CANARY_RESULT_LOG_PATH: results },
    });
    return {
      stdout: r.stdout ?? '',
      status: r.status ?? -1,
      tg: existsSync(tgLog) ? readFileSync(tgLog, 'utf8') : '',
      log: existsSync(results) ? readFileSync(results, 'utf8') : '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('funding-accrual canary — the shipped main()', () => {
  it('its own --self-test passes and prints exactly one token', { timeout: 30_000 }, () => {
    const r = spawnSync('python3', [PY, '--self-test'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.stdout).toMatch(/SELF-TEST: PASS \(\d+ assertions, non-vacuous\)/);
  });

  it('healthy venues ⇒ PASS, exit 0, the alert is CLEARED, the run is recorded', { timeout: 30_000 }, () => {
    const r = run({ rows: HEALTHY });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.status).toBe(0);
    expect(r.tg).toContain('ARGV: --clear funding_accrual_stale');
    expect(r.tg).not.toContain('CRITICAL_PERSISTENT');
    // positive per-venue output for every declared venue
    for (const v of ['ASTER', 'BINANCE', 'BYBIT', 'GATE', 'HL', 'KUCOIN', 'OKX']) expect(r.stdout).toMatch(new RegExp(`^  ${v}\\s+PASS`, 'm'));
    expect(JSON.parse(r.log.trim().split('\n').pop()!)).toMatchObject({ canary: 'funding-accrual-freshness', verdict: 'PASS', exit_code: 0 });
  });

  it('OKX as measured before the fix ⇒ FAIL, exit 1, one page naming the venue', { timeout: 30_000 }, () => {
    const r = run({ rows: OKX_STALE });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.status).toBe(1);
    expect(r.tg).toContain('ARGV: funding_accrual_stale CRITICAL_PERSISTENT -');
    expect(r.tg).toContain('venue OKX:');
    expect(r.tg).not.toContain('venue BINANCE:');
    expect(r.tg).not.toContain('--clear');
  });

  it('an unreadable database ⇒ INDETERMINATE, exit 3, and NO page', { timeout: 30_000 }, () => {
    const r = run({ psqlFails: true });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.status).toBe(3);
    expect(r.tg).toBe('');
  });

  it('a malformed row ⇒ INDETERMINATE, exit 3 (handed input we could not parse is never a pass)', { timeout: 30_000 }, () => {
    const r = run({ rows: 'OKX|8|0.40|60|60' });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.status).toBe(3);
    expect(r.tg).toBe('');
  });

  it('a declared venue missing from the result ⇒ INDETERMINATE, not PASS', { timeout: 30_000 }, () => {
    const r = run({ rows: HEALTHY.split('\n').filter((l) => !l.startsWith('OKX|')).join('\n') });
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.status).toBe(3);
  });

  it('the token vocabulary is exactly PASS | FAIL | INDETERMINATE', () => {
    const declared = new Set([...SRC.matchAll(/FUNDING_ACCRUAL_VERDICT=\{?(\w+)/g)].map((m) => m[1]).filter((w) => w !== 'verdict'));
    expect([...declared].sort()).toEqual(['FAIL', 'INDETERMINATE', 'PASS']);
  });
});

/** Arb venues the research backfill deliberately does not accrue — each with its reason. */
const ARB_ONLY: Record<string, string> = {
  // DECISION-CALL-V1-W1 R3: Bitget joined scan_funding_arb from its own current-fund-rate feed; the
  // research funding-episode backfill (and so this predicate's table) does not collect it.
  BITGET: 'arb-only since DECISION-CALL-V1-W1 R3 — not a research-accrual venue',
};

describe('funding-accrual predicate — venue set parity with the research backfill', () => {
  it('declares exactly the backfill\'s venues, each at its funding interval', () => {
    const body = /FUNDING_VENUES: dict\[str, int\] = \{([\s\S]*?)\n\}/.exec(readFileSync(PRED, 'utf8'))?.[1] ?? '';
    const py = Object.fromEntries([...body.matchAll(/"(\w+)":\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    const metaBlock = /const META: Record<string, VenueMeta> = \{([\s\S]*?)\n\};/.exec(readFileSync(BACKFILL, 'utf8'))?.[1] ?? '';
    const backfill = Object.fromEntries([...metaBlock.matchAll(/^\s*(\w+): \{ intervalHours: (\d+)/gm)].map((m) => [m[1], Number(m[2])]));
    expect(Object.keys(py).length).toBeGreaterThan(0);       // each regex must have matched something
    expect(Object.keys(backfill).length).toBeGreaterThan(0);
    expect(py).toEqual(backfill);
  });

  it('every FUNDING_VENUE_META venue is accrued by the backfill or declared arb-only (never both)', () => {
    const metaBlock = /const META: Record<string, VenueMeta> = \{([\s\S]*?)\n\};/.exec(readFileSync(BACKFILL, 'utf8'))?.[1] ?? '';
    const accrued = new Set([...metaBlock.matchAll(/^\s*(\w+): \{ intervalHours:/gm)].map((m) => m[1]));
    const arb = new Set(Object.values(FUNDING_VENUE_META).map((m) => m.exchangeId));
    expect([...arb].filter((v) => !accrued.has(v) && !(v in ARB_ONLY))).toEqual([]);
    expect(Object.keys(ARB_ONLY).filter((v) => accrued.has(v) || !arb.has(v))).toEqual([]);
    for (const [v, m] of Object.values(FUNDING_VENUE_META).map((x) => [x.exchangeId, x] as const)) {
      if (accrued.has(v)) expect(m.intervalHours, v).toBe(Number(/intervalHours: (\d+)/.exec(metaBlock.split(`${v}: {`)[1])![1]));
    }
  });
});
