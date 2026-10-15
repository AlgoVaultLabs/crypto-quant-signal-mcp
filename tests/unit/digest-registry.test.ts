/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH2 — the digest registry is PINNED to the enumeration that
 * already exists: live crontab ⇄ `ops/scripts/cron-interlock-registry.json`
 * (`check-cron-interlock-coverage.mjs`) ⇄ `src/lib/digest-registry.ts` (this suite).
 *
 * The cron parsing below lives ONLY in this test — no runtime code parses cron.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DIGEST_REGISTRY,
  DIGEST_LABELS,
  maxIntervalS,
  periodKey,
  redeliveryTtlS,
  type DigestLabel,
} from '../../src/lib/digest-registry.js';
// @ts-expect-error — untyped .mjs gate module
import { parseDigestRegistry } from '../../scripts/check-delivery-assertion.mjs';

const REPO = path.resolve(__dirname, '..', '..');
const interlock = JSON.parse(readFileSync(path.join(REPO, 'ops/scripts/cron-interlock-registry.json'), 'utf8')) as {
  rows: Array<{ id: string; script: string; cron: string; max_runtime_s?: number }>;
};

/** `m h dom mon dow` → cadence + due, for the DIGEST half of a row's cron. */
function cronToSchedule(row: { id: string; cron: string }) {
  let expr = row.cron;
  if (row.id === 'monitor') {
    // "*/2 * * * * (--mode critical) · 0 8 * * * (--mode digest)" — only the digest segment.
    const seg = row.cron.split('·').map((s) => s.trim()).find((s) => s.includes('(--mode digest)'));
    expect(seg, 'monitor row carries a (--mode digest) segment').toBeTruthy();
    expr = seg!.replace('(--mode digest)', '').trim();
  }
  const [m, h, dom, mon, dow] = expr.split(/\s+/);
  expect(mon).toBe('*');
  const hhmm = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (dom === '*' && dow === '*') return { cadence: 'daily', due: { hhmm } };
  if (dom === '*') return { cadence: 'weekly', due: { hhmm, dow: Number(dow) } };
  return { cadence: 'monthly', due: { hhmm, dom: Number(dom) } };
}

describe('DIGEST_REGISTRY', () => {
  it('holds exactly the 7 scheduled digest producers', () => {
    expect([...DIGEST_LABELS].sort()).toEqual([
      'chat-analytics-digest',
      'geo-weekly-cron',
      'monitor-daily-digest',
      'rate-limit-digest-weekly',
      'referral-payout-batch-detect',
      'refresh-knowledge-pages',
      'venue-readiness-report',
    ]);
  });

  it.each(DIGEST_LABELS)('%s is pinned to its interlock row: id, script, cron → cadence + due', (label) => {
    const reg = DIGEST_REGISTRY[label];
    const row = interlock.rows.find((r) => r.id === reg.interlock_id);
    expect(row, `interlock row ${reg.interlock_id}`).toBeTruthy();
    expect(row!.script).toBe(reg.producer);
    const s = cronToSchedule(row!);
    expect(reg.cadence).toBe(s.cadence);
    expect(reg.due).toEqual(s.due);
  });

  it.each(DIGEST_LABELS)('%s: stuck_after_s ≥ max(1,800 s, 2 × the interlock max_runtime_s)', (label) => {
    const reg = DIGEST_REGISTRY[label];
    const row = interlock.rows.find((r) => r.id === reg.interlock_id)!;
    expect(reg.stuck_after_s).toBeGreaterThanOrEqual(Math.max(1_800, 2 * (row.max_runtime_s ?? 0)));
  });

  it('the conditional producers are exactly the three that measurably suppress', () => {
    expect(DIGEST_LABELS.filter((l) => DIGEST_REGISTRY[l].sends === 'conditional').sort()).toEqual([
      'chat-analytics-digest',
      'referral-payout-batch-detect',
      'venue-readiness-report',
    ]);
  });

  it('only the monitor digest opts into self catch-up', () => {
    expect(DIGEST_LABELS.filter((l) => DIGEST_REGISTRY[l].catchup === 'self')).toEqual(['monitor-daily-digest']);
  });

  it('the gate (R4) parses this file to the same label → producer map', () => {
    const parsed = parseDigestRegistry(readFileSync(path.join(REPO, 'src/lib/digest-registry.ts'), 'utf8')) as Map<string, string>;
    expect(Object.fromEntries(parsed)).toEqual(
      Object.fromEntries(DIGEST_LABELS.map((l) => [l, DIGEST_REGISTRY[l].producer])),
    );
  });
});

describe('derived quantities — computed ONCE', () => {
  it('maxIntervalS: daily 1 d · weekly 7 d · monthly ≥ 31 d', () => {
    expect(maxIntervalS('monitor-daily-digest')).toBe(86_400);
    expect(maxIntervalS('geo-weekly-cron')).toBe(604_800);
    expect(maxIntervalS('referral-payout-batch-detect')).toBeGreaterThanOrEqual(31 * 86_400);
  });

  it.each(DIGEST_LABELS)('%s: redelivery TTL ≥ 5 %% of its interval (build-and-runtime.md) and ≥ 6 h', (label: DigestLabel) => {
    expect(redeliveryTtlS(label)).toBeGreaterThanOrEqual(Math.ceil(0.05 * maxIntervalS(label)));
    expect(redeliveryTtlS(label)).toBeGreaterThanOrEqual(6 * 3_600);
  });

  it('TTL values: daily 6 h · weekly 8.4 h · monthly 37.2 h', () => {
    expect(redeliveryTtlS('monitor-daily-digest')).toBe(21_600);
    expect(redeliveryTtlS('geo-weekly-cron')).toBe(30_240);
    expect(redeliveryTtlS('referral-payout-batch-detect')).toBe(133_920);
  });

  it('periodKey: UTC midnight rolls the daily key', () => {
    expect(periodKey('monitor-daily-digest', Date.UTC(2026, 9, 15, 23, 59, 59, 999))).toBe('2026-10-15');
    expect(periodKey('monitor-daily-digest', Date.UTC(2026, 9, 16, 0, 0, 0, 0))).toBe('2026-10-16');
  });

  it('periodKey: the ISO week rolls Sunday → Monday (a Sunday run belongs to the week that began Monday)', () => {
    expect(periodKey('rate-limit-digest-weekly', Date.UTC(2026, 9, 18, 23, 0))).toBe('2026-W42'); // Sun 18 Oct
    expect(periodKey('geo-weekly-cron', Date.UTC(2026, 9, 19, 1, 0))).toBe('2026-W43'); // Mon 19 Oct
    expect(periodKey('geo-weekly-cron', Date.UTC(2027, 0, 1, 1, 0))).toBe('2026-W53'); // Fri 1 Jan 2027 is ISO 2026-W53
    expect(periodKey('geo-weekly-cron', Date.UTC(2027, 0, 4, 1, 0))).toBe('2027-W01');
  });

  it('periodKey: month end rolls the monthly key', () => {
    expect(periodKey('referral-payout-batch-detect', Date.UTC(2026, 9, 31, 23, 59))).toBe('2026-10');
    expect(periodKey('referral-payout-batch-detect', Date.UTC(2026, 10, 1, 8, 7))).toBe('2026-11');
  });
});

describe('an unregistered label FAILS tsc in every TypeScript producer', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('tsc rejects `label: "not-a-digest"` and compiles a registered one', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'digest-label-tsc-'));
    dirs.push(dir);
    const telegram = path.join(REPO, 'src/lib/telegram.js');
    const tsc = path.join(REPO, 'node_modules/.bin/tsc');
    const compile = (label: string) => {
      const f = path.join(dir, 'producer.ts');
      writeFileSync(f, `import type { DigestOptions } from ${JSON.stringify(telegram)};\nexport const o: DigestOptions = { label: ${JSON.stringify(label)} };\n`);
      return spawnSync(tsc, ['--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'Node16', '--moduleResolution', 'Node16', f], { encoding: 'utf8' });
    };
    expect(compile('monitor-daily-digest').status).toBe(0);
    const bad = compile('not-a-digest');
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toMatch(/not-a-digest/);
  });
});
