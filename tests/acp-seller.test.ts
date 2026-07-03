/**
 * acp-seller.test.ts — P1-ACP-SELLER-SEED / R8.
 *
 * Unit-tests the Virtuals ACP seller channel's PURE surfaces (no SDK, no network):
 *   - selectAcp two-flag decision (off / stub / live) + resolveAcpConfig network parsing
 *   - requirement → tool-params mapping (drops unknowns) + registry-derived price
 *   - handleAcpEntry lifecycle: requirement→setBudget, funded→callTool→submit, schema-reject
 *   - byte-parity: the deliverable is EXACTLY the tool output (pass-through, no reshape)
 *   - public-shape allow-list: the worker adds no fields (no outcome_return_pct)
 *   - idempotency: no re-submit on a re-emitted funded event OR a hydrated delivered job
 *   - offering coverage: every channels.acp registry tool has an offering (single-derivation lock)
 *   - DATA-INTEGRITY canary: ACP source has no direct on-chain write / anchor primitive; SDK exact-pinned
 * (The LIVE Privy/AcpAgent path needs signer creds + app.virtuals.io registration — exercised at
 * onboarding, not here; see docs/RUNBOOK-VIRTUALS-ACP-ONBOARDING.md.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAcpConfig, selectAcp, createStubAcpAgent, type SellerSession, type SellerEntry } from '../src/channels/acp/provider.js';
import { handleAcpEntry, acpPriceUsd, type AcpWorkerDeps } from '../src/channels/acp/seller-worker.js';
import { ACP_OFFERINGS, offeringByName, requirementToParams, acpOfferedTools } from '../src/channels/acp/offerings.js';
import { acpChannelTools } from '../src/lib/feature-registry.js';

// ── fakes (a real JobSession / JobRoomEntry is structurally assignable to these) ──
function makeSession(opts: {
  jobId?: string;
  status?: string;
  roles?: string[];
  description?: string | null;
  entries?: SellerEntry[];
}): { session: SellerSession; budgets: Array<{ amount: number; symbol: string }>; submits: string[] } {
  const budgets: Array<{ amount: number; symbol: string }> = [];
  const submits: string[] = [];
  const session: SellerSession = {
    jobId: opts.jobId ?? 'job-1',
    chainId: 84532,
    roles: opts.roles ?? ['provider'],
    status: opts.status ?? 'open',
    job: opts.description === undefined ? { description: 'AlgoVault Trade Call' } : { description: opts.description },
    entries: opts.entries ?? [],
    async setBudget(a) {
      budgets.push({ amount: a.amount, symbol: a.symbol });
    },
    async submit(d) {
      submits.push(d);
    },
  };
  return { session, budgets, submits };
}
function makeDeps(over: Partial<AcpWorkerDeps> = {}): AcpWorkerDeps {
  return {
    usdc: (amount) => ({ amount, symbol: 'USDC' }),
    callTool: async () => ({ ok: true }),
    priceFor: () => 0.02,
    submitted: new Set<string>(),
    log: () => {},
    ...over,
  };
}
const reqEntry = (obj: unknown): SellerEntry => ({ kind: 'message', contentType: 'requirement', content: JSON.stringify(obj) });
const funded: SellerEntry = { kind: 'system', event: { type: 'job.funded' } };

describe('selectAcp — two-flag decision (unit-test seam)', () => {
  it('off when disabled', () => {
    expect(selectAcp(resolveAcpConfig({})).mode).toBe('off');
    expect(selectAcp(resolveAcpConfig({ ACP_ENABLED: 'false' })).active).toBe(false);
  });
  it('stub when enabled without signer creds', () => {
    const r = selectAcp(resolveAcpConfig({ ACP_ENABLED: 'true' }));
    expect(r.mode).toBe('stub');
    expect(r.stubFellBack).toBe(true);
  });
  it('live when enabled with all three signer creds', () => {
    const r = selectAcp(resolveAcpConfig({ ACP_ENABLED: 'true', ACP_WALLET_ADDRESS: '0x1', ACP_WALLET_ID: 'w', ACP_SIGNER_PRIVATE_KEY: 'k' }));
    expect(r.mode).toBe('live');
    expect(r.network).toBe('testnet');
  });
  it('resolveAcpConfig: mainnet only when explicitly set (default testnet)', () => {
    expect(resolveAcpConfig({}).network).toBe('testnet');
    expect(resolveAcpConfig({ ACP_ENV: 'testnet' }).network).toBe('testnet');
    expect(resolveAcpConfig({ ACP_ENV: 'mainnet' }).network).toBe('mainnet');
  });
  it('stub bundle usdc → {amount, symbol}', () => {
    const b = createStubAcpAgent(() => {});
    expect(b.usdc(0.02, 84532)).toEqual({ amount: 0.02, symbol: 'USDC' });
    expect(b.chainId).toBe(84532);
  });
});

describe('offerings — requirement mapping + price', () => {
  it('maps a requirement to declared params, dropping unknowns', () => {
    const o = offeringByName('AlgoVault Trade Call')!;
    expect(requirementToParams(o, { coin: 'BTC', timeframe: '4h', junk: 1 })).toEqual({ coin: 'BTC', timeframe: '4h' });
  });
  it('offeringByName tolerates the live registration naming (normalized match)', () => {
    // The jobs are registered on Virtuals as algovault_tradecall / algoVault_MarketScan / algoVault_FundingArb.
    expect(offeringByName('algovault_tradecall')?.canonicalTool).toBe('get_trade_call');
    expect(offeringByName('algoVault_MarketScan')?.canonicalTool).toBe('scan_trade_calls');
    expect(offeringByName('algoVault_FundingArb')?.canonicalTool).toBe('scan_funding_arb');
    expect(offeringByName('AlgoVault Trade Call')?.canonicalTool).toBe('get_trade_call'); // exact still works
    expect(offeringByName('totally unknown')).toBeUndefined();
  });
  it('price derives from the registry SoT', () => {
    expect(acpPriceUsd('get_trade_call')).toBe(0.02);
    expect(acpPriceUsd('scan_trade_calls')).toBe(0.02);
    expect(acpPriceUsd('scan_funding_arb')).toBe(0.01);
  });
  it('every offering maps to a valid HTTP_TOOLS handler key', () => {
    const httpTools = ['get_trade_signal', 'scan_trade_calls', 'scan_funding_arb'];
    for (const o of ACP_OFFERINGS) expect(httpTools).toContain(o.httpTool);
  });
});

describe('handleAcpEntry — lifecycle', () => {
  it('provider requirement (open) → setBudget with the registry price', async () => {
    const { session, budgets } = makeSession({ status: 'open', description: 'AlgoVault Trade Call' });
    const r = await handleAcpEntry(session, reqEntry({ coin: 'BTC' }), makeDeps({ priceFor: () => 0.02 }));
    expect(r).toBe('budget_set');
    expect(budgets).toEqual([{ amount: 0.02, symbol: 'USDC' }]);
  });
  it('ignores entries when we are not the provider', async () => {
    const { session } = makeSession({ roles: ['client'], status: 'open' });
    expect(await handleAcpEntry(session, funded, makeDeps())).toBe('ignored');
  });
  it('rejects a requirement that fails the offering schema (no budget)', async () => {
    const { session, budgets } = makeSession({ status: 'open' });
    const r = await handleAcpEntry(session, reqEntry({ notcoin: 1 }), makeDeps());
    expect(r).toBe('skipped:invalid_requirement');
    expect(budgets).toEqual([]);
  });
  it('skips a job whose offering name is unknown', async () => {
    const { session } = makeSession({ status: 'open', description: 'Nope' });
    expect(await handleAcpEntry(session, reqEntry({ coin: 'BTC' }), makeDeps())).toBe('skipped:no_offering');
  });

  it('funded → deliverable is EXACTLY the tool output (byte-parity; get_trade_call→get_trade_signal)', async () => {
    const SENTINEL = { call: 'BUY', confidence: 71, regime: 'TRENDING_UP', _algovault: { tool: 'get_trade_call' } };
    const { session, submits } = makeSession({ status: 'funded', entries: [reqEntry({ coin: 'BTC', timeframe: '1h' })] });
    let seen: { ht: string; params: Record<string, unknown> } | null = null;
    const deps = makeDeps({
      callTool: async (ht, params) => {
        seen = { ht, params };
        return SENTINEL;
      },
    });
    const r = await handleAcpEntry(session, funded, deps);
    expect(r).toBe('submitted');
    expect(seen).toEqual({ ht: 'get_trade_signal', params: { coin: 'BTC', timeframe: '1h' } });
    expect(submits).toHaveLength(1);
    expect(JSON.parse(submits[0])).toEqual(SENTINEL); // pass-through, no reshape
  });

  it('public-shape allow-list: the worker adds NO fields (no outcome_return_pct)', async () => {
    const PUBLIC = { call: 'HOLD', confidence: 33, price: 100 };
    const { session, submits } = makeSession({ status: 'funded', entries: [reqEntry({ coin: 'BTC' })] });
    await handleAcpEntry(session, funded, makeDeps({ callTool: async () => PUBLIC }));
    const delivered = JSON.parse(submits[0]);
    expect(Object.keys(delivered).sort()).toEqual(Object.keys(PUBLIC).sort());
    expect(delivered).not.toHaveProperty('outcome_return_pct');
    expect(delivered).not.toHaveProperty('outcome_price');
  });

  it('completed → logs, no submit', async () => {
    const { session, submits } = makeSession({ status: 'completed' });
    expect(await handleAcpEntry(session, { kind: 'system', event: { type: 'job.completed' } }, makeDeps())).toBe('completed');
    expect(submits).toHaveLength(0);
  });
});

describe('handleAcpEntry — idempotency (Q1: reconnect/restart re-emit)', () => {
  it('does not re-submit a job already in the submitted set', async () => {
    const { session, submits } = makeSession({ jobId: 'j9', status: 'funded', entries: [reqEntry({ coin: 'BTC' })] });
    const deps = makeDeps({ submitted: new Set<string>(), callTool: async () => ({ ok: 1 }) });
    expect(await handleAcpEntry(session, funded, deps)).toBe('submitted');
    expect(await handleAcpEntry(session, funded, deps)).toBe('skipped:already_delivered');
    expect(submits).toHaveLength(1);
  });
  it('skips a hydrated job already in a delivered status (durable guard, survives restart)', async () => {
    const { session, submits } = makeSession({ jobId: 'j10', status: 'completed', entries: [reqEntry({ coin: 'BTC' })] });
    expect(await handleAcpEntry(session, funded, makeDeps())).toBe('skipped:already_delivered');
    expect(submits).toHaveLength(0);
  });
  it('unmarks on tool failure so a genuine retry can re-run', async () => {
    const { session, submits } = makeSession({ jobId: 'j11', status: 'funded', entries: [reqEntry({ coin: 'BTC' })] });
    const submitted = new Set<string>();
    const r = await handleAcpEntry(session, funded, makeDeps({ submitted, callTool: async () => { throw new Error('boom'); } }));
    expect(r).toBe('error');
    expect(submitted.has('j11')).toBe(false);
    expect(submits).toHaveLength(0);
  });
});

describe('offering coverage — single-derivation lock (channel-derives-from-registry)', () => {
  it('every channels.acp registry tool has exactly one offering', () => {
    expect(acpOfferedTools().sort()).toEqual(acpChannelTools().sort());
  });
  it('the launch set is the 3 named tools', () => {
    expect(acpChannelTools().sort()).toEqual(['get_trade_call', 'scan_funding_arb', 'scan_trade_calls']);
  });
});

describe('DATA-INTEGRITY canary (Q6, persistent — re-fires every build/SDK bump)', () => {
  const acpSrc = (f: string): string => readFileSync(join(process.cwd(), 'src/channels/acp', f), 'utf8');
  it('the chain-capable ACP source has no direct on-chain write / anchor primitive', () => {
    // The ONLY chain interactions in the ACP path are the SDK escrow ops we invoke as session
    // methods (setBudget/submit = USDC settlement). Our code must never directly write to chain or
    // hash/anchor/notarize signal data. (offerings.ts is pure copy — scanned separately below.)
    const src = ['provider.ts', 'seller-worker.ts'].map(acpSrc).join('\n');
    const FORBIDDEN = [
      /\bwriteContract\b/, /\bsendTransaction\b/, /\bsendRawTransaction\b/, /\beth_sendRawTransaction\b/,
      /\bkeccak_?256\b/i, /\bsha3\b/i, /\bipfs[.-]?http/i, /\bipfs\.add\b/,
      /from\s+['"]web3['"]/, /require\(['"]web3['"]/, /['"]eth-account['"]/, /['"]eth-abi['"]/, /['"]hexbytes['"]/,
    ];
    for (const rx of FORBIDDEN) expect(src, `forbidden on-chain primitive ${rx}`).not.toMatch(rx);
  });
  it('the ACP source never references internal outcome fields', () => {
    const src = ['provider.ts', 'seller-worker.ts', 'offerings.ts'].map(acpSrc).join('\n');
    expect(src).not.toMatch(/outcome_return_pct/);
    expect(src).not.toMatch(/outcome_price/);
  });
  it('the SDK is exact-pinned (a bump forces re-review of the escrow/deliverable path)', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@virtuals-protocol/acp-node-v2']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
