/**
 * acp-graduation-buyer.test.ts — P1-ACP-MAINNET-GRADUATION / R2.
 *
 * Unit-tests the buyer driver's PURE surfaces (no SDK, no network — `driveJob` is injected):
 *   - parseArgs (dry-run default; --execute / --smoke / --max-jobs)
 *   - resolveBuyerConfig (creds present/absent, MAX_SPEND_USD, network default)
 *   - sampleRequirement (normalized match to the 3 registered offering names)
 *   - runGraduation: 10-all-complete → GRADUATION_JOBS_COMPLETE; stop-on-error; MAX_SPEND_USD cap
 *     halts; dry-run stub performs zero txns; 3-consecutive counting; isGraduationComplete boundary.
 * (The live Privy/AcpAgent path is exercised only under `--execute` with real creds — MANUAL_PENDING.)
 */
import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  resolveBuyerConfig,
  sampleRequirement,
  offeringPrice,
  runGraduation,
  isGraduationComplete,
  type OfferingLike,
  type DriveJob,
  type GraduationResult,
} from '../src/scripts/acp-graduation-buyer.js';

const OFF: OfferingLike[] = [
  { name: 'algovault_tradecall', priceValue: 0.02 },
  { name: 'algoVault_MarketScan', priceValue: 0.02 },
  { name: 'algoVault_FundingArb', priceValue: 0.01 },
];
const alwaysComplete: DriveJob = async () => 'completed';
const gr = (o: Partial<GraduationResult>): GraduationResult => ({ success: 0, maxConsecutive: 0, spentUsd: 0, halted: false, jobs: [], ...o });

describe('parseArgs', () => {
  it('dry-run by default (no --execute)', () => {
    expect(parseArgs([])).toEqual({ execute: false, smoke: false, maxJobs: 10 });
  });
  it('--execute enables real spend', () => {
    expect(parseArgs(['--execute']).execute).toBe(true);
  });
  it('--smoke → 1 job', () => {
    expect(parseArgs(['--execute', '--smoke']).maxJobs).toBe(1);
  });
  it('--max-jobs N', () => {
    expect(parseArgs(['--max-jobs', '5']).maxJobs).toBe(5);
  });
  it('--smoke overrides --max-jobs', () => {
    expect(parseArgs(['--max-jobs', '5', '--smoke']).maxJobs).toBe(1);
  });
});

describe('resolveBuyerConfig', () => {
  it('creds present only when all three set', () => {
    expect(resolveBuyerConfig({ BUYER_WALLET_ADDRESS: '0x1', BUYER_WALLET_ID: 'w', BUYER_SIGNER_PRIVATE_KEY: 'k' } as NodeJS.ProcessEnv).credsPresent).toBe(true);
    expect(resolveBuyerConfig({ BUYER_WALLET_ADDRESS: '0x1' } as NodeJS.ProcessEnv).credsPresent).toBe(false);
  });
  it('network defaults to mainnet (the live seller)', () => {
    expect(resolveBuyerConfig({} as NodeJS.ProcessEnv).network).toBe('mainnet');
    expect(resolveBuyerConfig({ ACP_ENV: 'testnet' } as NodeJS.ProcessEnv).network).toBe('testnet');
  });
  it('MAX_SPEND_USD parses + defaults to 0.5', () => {
    expect(resolveBuyerConfig({ MAX_SPEND_USD: '0.10' } as NodeJS.ProcessEnv).maxSpendUsd).toBe(0.1);
    expect(resolveBuyerConfig({} as NodeJS.ProcessEnv).maxSpendUsd).toBe(0.5);
    expect(resolveBuyerConfig({ MAX_SPEND_USD: 'nan' } as NodeJS.ProcessEnv).maxSpendUsd).toBe(0.5);
  });
});

describe('sampleRequirement', () => {
  it('maps the 3 registered names (normalized)', () => {
    expect(sampleRequirement('algovault_tradecall')).toEqual({ coin: 'BTC', exchange: 'binance', timeframe: '4h' });
    expect(sampleRequirement('algoVault_MarketScan')).toEqual({ limit: 5 });
    expect(sampleRequirement('algoVault_FundingArb')).toEqual({ limit: 5 });
  });
  it('also matches the clean display names', () => {
    expect(sampleRequirement('AlgoVault Trade Call')).toHaveProperty('coin', 'BTC');
    expect(offeringPrice(OFF[2])).toBe(0.01);
  });
});

describe('runGraduation', () => {
  it('10 all-complete → success=10, maxConsecutive=10, graduation complete', async () => {
    const r = await runGraduation(OFF, { maxJobs: 10, maxSpendUsd: 1 }, alwaysComplete);
    expect(r.success).toBe(10);
    expect(r.maxConsecutive).toBe(10);
    expect(r.jobs).toHaveLength(10);
    expect(isGraduationComplete(r)).toBe(true);
  });
  it('stop-on-error: a failure on job 3 halts the loop (success=2)', async () => {
    let n = 0;
    const failOn3: DriveJob = async () => (++n === 3 ? 'failed' : 'completed');
    const r = await runGraduation(OFF, { maxJobs: 10, maxSpendUsd: 1 }, failOn3);
    expect(r.success).toBe(2);
    expect(r.jobs).toHaveLength(3);
    expect(r.jobs[2].outcome).toBe('failed');
    expect(r.maxConsecutive).toBe(2);
    expect(isGraduationComplete(r)).toBe(false);
  });
  it('a thrown driveJob is caught as "error" and stops the loop', async () => {
    let n = 0;
    const throwOn2: DriveJob = async () => {
      if (++n === 2) throw new Error('boom');
      return 'completed';
    };
    const r = await runGraduation(OFF, { maxJobs: 10, maxSpendUsd: 1 }, throwOn2);
    expect(r.success).toBe(1);
    expect(r.jobs[1].outcome).toBe('error');
  });
  it('MAX_SPEND_USD cap halts before exceeding', async () => {
    // prices rotate 0.02, 0.02, 0.01, … ; cap 0.05 → 3 jobs ($0.05) then halt before job 4 ($0.07).
    const r = await runGraduation(OFF, { maxJobs: 10, maxSpendUsd: 0.05 }, alwaysComplete);
    expect(r.halted).toBe(true);
    expect(r.success).toBe(3);
    expect(r.spentUsd).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(isGraduationComplete(r)).toBe(false);
  });
  it('dry-run stub performs zero real txns — driveJob is the only side-effect surface', async () => {
    const calls: string[] = [];
    const recording: DriveJob = async (o, req) => {
      calls.push(`${o.name}:${JSON.stringify(req)}`);
      return 'completed';
    };
    await runGraduation(OFF, { maxJobs: 3, maxSpendUsd: 1 }, recording);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('algovault_tradecall');
    expect(calls[0]).toContain('BTC'); // sampleRequirement is wired into the loop
  });
});

describe('isGraduationComplete', () => {
  it('needs success≥10 AND maxConsecutive≥3', () => {
    expect(isGraduationComplete(gr({ success: 10, maxConsecutive: 3 }))).toBe(true);
    expect(isGraduationComplete(gr({ success: 9, maxConsecutive: 9 }))).toBe(false);
    expect(isGraduationComplete(gr({ success: 10, maxConsecutive: 2 }))).toBe(false);
  });
});
