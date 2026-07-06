/**
 * acp-graduation-buyer.ts — P1-ACP-MAINNET-GRADUATION test-buyer driver.
 *
 * Drives the live AlgoVault SELLER agent to graduation: creates jobs against its 3 registered
 * offerings, funds them, self-evaluates (completes), and counts successes until 10 (incl. ≥3
 * consecutive). The seller worker (already live, `mode=live network=mainnet`) auto-fulfils each
 * job (`callCoreHandler` → deliverable), so this driver is ONLY the buyer + orchestration.
 *
 * SAFETY (real USDC, tiny — mainnet-micro-canary discipline):
 *   - `--dry-run` is the DEFAULT: simulates the full loop, ZERO on-chain txns, no creds needed.
 *   - `--execute` is REQUIRED to spend real USDC. `--smoke` = 1 job. `--max-jobs N` (default 10).
 *   - `MAX_SPEND_USD` env hard-cap (default 0.50) halts the loop before it would exceed.
 *   - Sequential (1 job in-flight) + STOP-ON-ERROR + finally-cleanup (a crash never silently
 *     strands USDC — a funded-but-incomplete job SLA-auto-refunds in ~5 min; we log its id).
 *
 * BUYER IDENTITY: the acp-node-v2 `ViemProviderAdapter` is a non-functional stub, so the buyer
 * MUST be a 2nd REGISTERED Virtuals agent (Privy). Reuses the seller's construction shape
 * (`src/channels/acp/provider.ts::createLiveAcpAgent`): ESM-only SDK loaded via dynamic `import()`
 * from this CJS build; `PrivyAlchemyEvmProviderAdapter.create` → `AcpAgent.create`. See
 * `audits/P1-ACP-GRADUATION-endpoint-truth.md` + `docs/RUNBOOK-VIRTUALS-ACP-GRADUATION.md`.
 *
 * Run:  npx tsx src/scripts/acp-graduation-buyer.ts               # dry-run (default, 0 txns)
 *       npx tsx src/scripts/acp-graduation-buyer.ts --execute --smoke      # 1 real job (~$0.02)
 *       npx tsx src/scripts/acp-graduation-buyer.ts --execute --max-jobs 10  # full graduation run
 */
import { normalizeOfferingName } from '../channels/acp/offerings.js';

// ─────────────── minimal seller-facing types (no ESM-only SDK type-import → avoids TS1541) ───────────────
/** The subset of the SDK `AcpAgentOffering` the driver reads (a real offering is assignable). */
export interface OfferingLike {
  name: string;
  priceValue: number;
}
/** A per-job terminal outcome. */
export type JobOutcome = 'completed' | 'failed' | 'error' | 'timeout';
/** Drives ONE job to a terminal outcome (injected — real SDK loop in live mode, stub in dry-run/tests). */
export type DriveJob = (offering: OfferingLike, requirement: Record<string, unknown>) => Promise<JobOutcome>;

/** Subset of the SDK `JobSession` the buyer touches. */
interface BuyerSession {
  readonly jobId: string;
  fund(amount?: unknown): Promise<void>;
  complete(reason: string): Promise<void>;
}
type BuyerEntry = { kind: 'system'; event: { type: string } } | { kind: 'message'; contentType: string; content: string };
/** Subset of the SDK `AcpAgent` the buyer drives. */
interface BuyerAgent {
  on(event: 'entry', handler: (s: BuyerSession, e: BuyerEntry) => void | Promise<void>): unknown;
  start(onConnected?: () => void): Promise<void>;
  stop(): Promise<void>;
  getAgentByWalletAddress(addr: string): Promise<{ offerings?: Array<{ name: string; priceValue: number }> } | null>;
  createJobByOfferingName(
    chainId: number,
    offeringName: string,
    providerAddress: string,
    requirementData: Record<string, unknown>,
    opts?: { evaluatorAddress?: string },
  ): Promise<bigint>;
}

const JOB_TIMEOUT_MS = 180_000; // 3 min/job (< the 5-min SLA); a stuck fund/submit resolves 'timeout'.
const GRADUATION_MIN_SUCCESS = 10;
const GRADUATION_MIN_CONSECUTIVE = 3;

/** Fallback offering set for dry-run when a live seller can't be resolved (the 3 registered names). */
const STUB_OFFERINGS: OfferingLike[] = [
  { name: 'algovault_tradecall', priceValue: 0.02 },
  { name: 'algoVault_MarketScan', priceValue: 0.02 },
  { name: 'algoVault_FundingArb', priceValue: 0.01 },
];

// ─────────────── pure pieces (unit-tested) ───────────────
export interface BuyerArgs {
  execute: boolean;
  smoke: boolean;
  maxJobs: number;
}
export function parseArgs(argv: string[]): BuyerArgs {
  const execute = argv.includes('--execute');
  const smoke = argv.includes('--smoke');
  let maxJobs = 10;
  const i = argv.indexOf('--max-jobs');
  if (i >= 0 && argv[i + 1]) {
    const n = parseInt(argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) maxJobs = n;
  }
  if (smoke) maxJobs = 1;
  return { execute, smoke, maxJobs };
}

export interface BuyerConfig {
  network: 'mainnet' | 'testnet';
  seller?: string;
  buyer: { walletAddress?: string; walletId?: string; signerPrivateKey?: string; privyAppId?: string };
  credsPresent: boolean;
  maxSpendUsd: number;
}
export function resolveBuyerConfig(env: NodeJS.ProcessEnv = process.env): BuyerConfig {
  const env_ = env.ACP_ENV?.trim().toLowerCase();
  const network: 'mainnet' | 'testnet' = env_ === 'testnet' ? 'testnet' : 'mainnet'; // live seller = mainnet
  const buyer = {
    walletAddress: env.BUYER_WALLET_ADDRESS?.trim() || undefined,
    walletId: env.BUYER_WALLET_ID?.trim() || undefined,
    signerPrivateKey: env.BUYER_SIGNER_PRIVATE_KEY?.trim() || undefined,
    privyAppId: env.BUYER_PRIVY_APP_ID?.trim() || undefined,
  };
  const spend = parseFloat(env.MAX_SPEND_USD ?? '');
  return {
    network,
    seller: env.SELLER_WALLET_ADDRESS?.trim() || undefined,
    buyer,
    credsPresent: Boolean(buyer.walletAddress && buyer.walletId && buyer.signerPrivateKey),
    maxSpendUsd: Number.isFinite(spend) && spend > 0 ? spend : 0.5,
  };
}

/** Valid sample requirement per offering (matched normalized → tolerant of the registered names). */
export function sampleRequirement(offeringName: string): Record<string, unknown> {
  const n = normalizeOfferingName(offeringName);
  if (n.includes('tradecall')) return { coin: 'BTC', exchange: 'binance', timeframe: '4h' };
  if (n.includes('funding')) return { limit: 5 };
  if (n.includes('scan')) return { limit: 5 };
  return {};
}

/** The USD price of an offering (the seller's registered price). */
export function offeringPrice(o: OfferingLike): number {
  return Number.isFinite(o.priceValue) ? o.priceValue : 0.02;
}

export interface GraduationResult {
  success: number;
  maxConsecutive: number;
  spentUsd: number;
  halted: boolean;
  jobs: Array<{ n: number; offering: string; outcome: JobOutcome; price: number }>;
}
export function isGraduationComplete(r: GraduationResult): boolean {
  return r.success >= GRADUATION_MIN_SUCCESS && r.maxConsecutive >= GRADUATION_MIN_CONSECUTIVE;
}

/**
 * The graduation loop — PURE except for the injected `driveJob`. Sequential, cap-gated, stop-on-error.
 * `spentUsd` is incremented BEFORE driveJob (conservative: a job is funded on `budget.set`).
 */
export async function runGraduation(
  offerings: readonly OfferingLike[],
  opts: { maxJobs: number; maxSpendUsd: number },
  driveJob: DriveJob,
  log: (m: string) => void = () => {},
): Promise<GraduationResult> {
  let success = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  let spentUsd = 0;
  let halted = false;
  const jobs: GraduationResult['jobs'] = [];

  for (let i = 0; i < opts.maxJobs; i++) {
    const offering = offerings[i % offerings.length];
    const price = offeringPrice(offering);
    if (spentUsd + price > opts.maxSpendUsd + 1e-9) {
      log(`MAX_SPEND_USD cap: $${spentUsd.toFixed(2)} + $${price.toFixed(2)} > $${opts.maxSpendUsd} — halting before job ${i + 1}`);
      halted = true;
      break;
    }
    log(`job ${i + 1}/${opts.maxJobs} — ${offering.name} ($${price.toFixed(2)})`);
    spentUsd += price; // conservative (funded on budget.set)
    let outcome: JobOutcome;
    try {
      outcome = await driveJob(offering, sampleRequirement(offering.name));
    } catch (e) {
      outcome = 'error';
      log(`  driveJob threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    jobs.push({ n: i + 1, offering: offering.name, outcome, price });
    if (outcome === 'completed') {
      success++;
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
      log(`  ✓ completed | success=${success} consecutive=${consecutive} spent≈$${spentUsd.toFixed(2)}`);
    } else {
      consecutive = 0;
      log(`  ✗ ${outcome} — STOP-ON-ERROR after ${success} success(es); investigate before re-running`);
      break;
    }
  }
  return { success, maxConsecutive, spentUsd, halted, jobs };
}

// ─────────────── live SDK wiring (dynamic import — ESM-only SDK from CJS) ───────────────
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<T>((r) => {
    timer = setTimeout(() => r(onTimeout), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

interface BuyerBundle {
  agent: BuyerAgent;
  buyerAddress: string;
  driveJob: DriveJob;
}

/**
 * Construct the buyer agent (mirrors provider.ts::createLiveAcpAgent) + a live driveJob that runs the
 * per-job event loop: create (self-eval) → on `budget.set` fund → on `job.submitted` complete → resolve
 * on `job.completed`. A single `on("entry")` handler routes to the active (sequential) job.
 */
async function createBuyerAgent(cfg: BuyerConfig, log: (m: string) => void): Promise<BuyerBundle> {
  const sdk = await import('@virtuals-protocol/acp-node-v2');
  const { base } = await import('viem/chains');
  const serverUrl = cfg.network === 'testnet' ? sdk.ACP_TESTNET_SERVER_URL : sdk.ACP_SERVER_URL;
  const privyAppId = cfg.buyer.privyAppId || (cfg.network === 'testnet' ? sdk.TESTNET_PRIVY_APP_ID : sdk.PRIVY_APP_ID);
  const chain = cfg.network === 'testnet' ? (await import('viem/chains')).baseSepolia : base;

  const provider = await sdk.PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: cfg.buyer.walletAddress! as `0x${string}`,
    walletId: cfg.buyer.walletId!,
    signerPrivateKey: cfg.buyer.signerPrivateKey!,
    chains: [chain],
    serverUrl,
    privyAppId,
  });
  const agent = (await sdk.AcpAgent.create({ provider })) as unknown as BuyerAgent;
  const buyerAddress = cfg.buyer.walletAddress!;
  const seller = cfg.seller!;
  const chainId = chain.id;

  // single handler → active-job state machine (sequential: exactly one in-flight)
  const state: { jobId: string | null; price: number; funded: boolean; resolve: ((o: JobOutcome) => void) | null } = {
    jobId: null,
    price: 0,
    funded: false,
    resolve: null,
  };
  agent.on('entry', async (session, entry) => {
    if (!state.jobId || String(session.jobId) !== state.jobId || entry.kind !== 'system') return;
    try {
      switch (entry.event.type) {
        case 'budget.set':
          log(`  budget.set → fund $${state.price.toFixed(2)}`);
          await session.fund(sdk.AssetToken.usdc(state.price, chainId));
          state.funded = true;
          break;
        case 'job.submitted':
          log('  job.submitted → complete');
          await session.complete('graduation-ok');
          break;
        case 'job.completed':
          state.resolve?.('completed');
          break;
        case 'job.rejected':
        case 'job.expired':
          state.resolve?.('failed');
          break;
      }
    } catch (e) {
      log(`  handler error: ${e instanceof Error ? e.message : String(e)}`);
      state.resolve?.('error');
    }
  });

  const driveJob: DriveJob = async (offering, requirement) => {
    const jobId = await agent.createJobByOfferingName(chainId, offering.name, seller, requirement, { evaluatorAddress: buyerAddress });
    state.jobId = String(jobId);
    state.price = offeringPrice(offering);
    state.funded = false;
    log(`  job ${jobId} created (${offering.name})`);
    const outcome = await withTimeout(new Promise<JobOutcome>((r) => (state.resolve = r)), JOB_TIMEOUT_MS, 'timeout');
    const stuck = outcome === 'timeout' && state.funded ? state.jobId : null;
    state.jobId = null;
    state.resolve = null;
    if (stuck) log(`  ⚠ job ${stuck} funded but not completed within ${JOB_TIMEOUT_MS / 1000}s — SLA auto-refunds (~5m); investigate`);
    return outcome;
  };

  return { agent, buyerAddress, driveJob };
}

// ─────────────── entrypoint ───────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = resolveBuyerConfig(process.env);
  const log = (m: string): void => console.log(m);
  log(`[ACP-BUYER] ${args.execute ? 'EXECUTE (real USDC)' : 'DRY-RUN (0 txns)'} · maxJobs=${args.maxJobs} · cap=$${cfg.maxSpendUsd} · network=${cfg.network}`);

  let offerings: OfferingLike[];
  let driveJob: DriveJob;
  let stop: () => Promise<void> = async () => {};

  if (!args.execute) {
    // DRY-RUN — no creds, no SDK, stub the round-trip.
    offerings = STUB_OFFERINGS;
    driveJob = async (o, req) => {
      log(`  [DRY] createJob ${o.name} req=${JSON.stringify(req)} → fund → submit → complete → completed`);
      return 'completed';
    };
  } else {
    // EXECUTE — real money. Preamble asserts before any spend.
    if (cfg.network !== 'mainnet') throw new Error('ACP_ENV must be "mainnet" (the live seller is on Base mainnet)');
    if (!cfg.seller) throw new Error('SELLER_WALLET_ADDRESS is required');
    if (!cfg.credsPresent) throw new Error('BUYER_WALLET_ADDRESS / BUYER_WALLET_ID / BUYER_SIGNER_PRIVATE_KEY required for --execute (see docs/RUNBOOK-VIRTUALS-ACP-GRADUATION.md)');
    const bundle = await createBuyerAgent(cfg, log);
    stop = () => bundle.agent.stop();
    await bundle.agent.start(() => log('[ACP-BUYER] connected — listening'));
    const detail = await bundle.agent.getAgentByWalletAddress(cfg.seller);
    if (!detail?.offerings?.length) throw new Error(`seller ${cfg.seller} has no offerings (not registered / graduated?)`);
    offerings = detail.offerings.map((o) => ({ name: o.name, priceValue: o.priceValue }));
    log(`[ACP-BUYER] seller offerings: ${offerings.map((o) => `${o.name}($${o.priceValue})`).join(', ')}`);
    driveJob = bundle.driveJob;
  }

  let result: GraduationResult;
  try {
    result = await runGraduation(offerings, { maxJobs: args.maxJobs, maxSpendUsd: cfg.maxSpendUsd }, driveJob, log);
  } finally {
    await stop().catch(() => {});
  }

  log(`[ACP-BUYER] DONE — success=${result.success} maxConsecutive=${result.maxConsecutive} spent≈$${result.spentUsd.toFixed(2)} halted=${result.halted}`);
  if (isGraduationComplete(result)) {
    log('GRADUATION_JOBS_COMPLETE');
    process.exit(0);
  }
  log(`GRADUATION_INCOMPLETE (need success≥${GRADUATION_MIN_SUCCESS} & maxConsecutive≥${GRADUATION_MIN_CONSECUTIVE})`);
  process.exit(args.execute ? 1 : 0); // dry-run/smoke never "fails"; a real incomplete run signals non-zero
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[ACP-BUYER] fatal:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
