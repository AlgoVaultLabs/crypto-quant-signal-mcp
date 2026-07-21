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
import { runScript } from '../lib/script-lifecycle.js';

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
  /** Off-chain job read (reliable HTTP API; TS-private in the SDK but present at runtime).
   *  NOTE: the /jobs/{id} response carries the status in `jobStatus` (a STRING enum), not `status`. */
  api?: { getJob(chainId: number, jobId: string): Promise<{ jobStatus?: string; status?: number | string } | null> };
  /** Obtain a JobSession handle for a jobId (idempotent via the SDK's sessionMap) — for poll-driven complete(). */
  getOrCreateSession(jobId: bigint, chainId: number): BuyerSession;
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
  /** true → skip-evaluation (seller auto-completes; jobs pay out but do NOT count toward graduation). */
  skipEval: boolean;
}
export function parseArgs(argv: string[]): BuyerArgs {
  const execute = argv.includes('--execute');
  const smoke = argv.includes('--smoke');
  const skipEval = argv.includes('--skip-eval');
  let maxJobs = 10;
  const i = argv.indexOf('--max-jobs');
  if (i >= 0 && argv[i + 1]) {
    const n = parseInt(argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) maxJobs = n;
  }
  if (smoke) maxJobs = 1;
  return { execute, smoke, maxJobs, skipEval };
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SDK on-chain JobStatus enum (baseAcpClient.js): OPEN=0 FUNDED=1 SUBMITTED=2 COMPLETED=3 REJECTED=4 EXPIRED=5 */
const JOB_STATUS = ['OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED', 'REJECTED', 'EXPIRED'] as const;

interface BuyerBundle {
  agent: BuyerAgent;
  buyerAddress: string;
  driveJob: DriveJob;
}

/**
 * Construct the buyer agent (mirrors provider.ts::createLiveAcpAgent) + a live driveJob.
 *
 * EVALUATED mode (DEFAULT): the buyer is the job's evaluator (`evaluatorAddress = buyerAddress`) and
 * `complete()`s each job after the seller submits — this is what ticks the Virtuals graduation
 * "completed jobs" counter (skip-eval jobs pay out but do NOT count). Completion is POLL-driven: it reads
 * the reliable off-chain status (`agent.api.getJob`, retried) and calls `complete()` on a
 * `getOrCreateSession` handle (a bare provider call — no `_job` hydration, no socket). It does NOT rely on
 * the `job.submitted` event, which a transient off-chain 404 dropped in the first smoke (a dropped
 * dispatch permanently stalled self-eval). Funding stays event-driven on `budget.set` (empirically
 * reliable). `--skip-eval` restores the seller-auto-complete path — cheaper, but those jobs do NOT count
 * toward graduation.
 */
async function createBuyerAgent(cfg: BuyerConfig, log: (m: string) => void, skipEval = false): Promise<BuyerBundle> {
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

  // active-job state (sequential: one in-flight). Funding is event-driven (budget.set); evaluation +
  // terminal detection are poll-driven (robust to a dropped event).
  const state: { jobId: string | null; price: number; funded: boolean } = { jobId: null, price: 0, funded: false };
  agent.on('entry', async (session, entry) => {
    if (!state.jobId || String(session.jobId) !== state.jobId || entry.kind !== 'system') return;
    if (entry.event.type === 'budget.set' && !state.funded) {
      try {
        log(`  budget.set → fund $${state.price.toFixed(2)}`);
        await session.fund(sdk.AssetToken.usdc(state.price, chainId));
        state.funded = true;
      } catch (e) {
        log(`  fund (event) error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  /** Reliable off-chain status read → numeric JobStatus (0-5) or null; retries a transient 404.
   *  The /jobs/{id} response uses `jobStatus` (STRING enum, e.g. "SUBMITTED"); fall back to `status`. */
  const pollRawStatus = async (jobId: string): Promise<number | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await agent.api?.getJob(chainId, jobId);
        const s = raw?.jobStatus ?? raw?.status;
        if (s == null) return null;
        const st = typeof s === 'number' ? s : (JOB_STATUS as readonly string[]).indexOf(String(s).toUpperCase());
        return st >= 0 ? st : null;
      } catch {
        await sleep(1200 * (attempt + 1));
      }
    }
    return null;
  };

  /** Evaluator completes a SUBMITTED job (→ COMPLETED). `complete()` is a bare provider call (no `_job`
   *  hydration, no socket), so a fresh getOrCreateSession handle works; retried against transient failures. */
  const tryComplete = async (jobId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await agent.getOrCreateSession(BigInt(jobId), chainId).complete('graduation-ok');
        return true;
      } catch (e) {
        log(`  complete attempt ${attempt + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(1500 * (attempt + 1));
      }
    }
    return false;
  };

  const driveJob: DriveJob = async (offering, requirement) => {
    const jobId = await agent.createJobByOfferingName(
      chainId,
      offering.name,
      seller,
      requirement,
      skipEval ? undefined : { evaluatorAddress: buyerAddress },
    );
    const jid = String(jobId);
    state.jobId = jid;
    state.price = offeringPrice(offering);
    state.funded = false;
    log(`  job ${jid} created (${offering.name}) [${skipEval ? 'skip-eval → seller auto-completes' : 'self-eval → buyer evaluates on submit'}]`);

    const deadline = Date.now() + JOB_TIMEOUT_MS;
    let evaluated = false; // buyer already called complete() for this job (eval mode)
    let outcome: JobOutcome = 'timeout';
    while (Date.now() < deadline) {
      await sleep(5000);
      const st = await pollRawStatus(jid);
      if (st === 3) { outcome = 'completed'; break; }            // COMPLETED
      if (st === 4 || st === 5) { outcome = 'failed'; break; }   // REJECTED / EXPIRED
      if (!skipEval && st === 2 && !evaluated) {                 // SUBMITTED → evaluate (complete)
        log(`  job ${jid} submitted → evaluating (complete)`);
        evaluated = await tryComplete(jid);
        if (!evaluated) { outcome = 'error'; break; }
      }
    }

    const stuck = outcome === 'timeout' && state.funded ? jid : null;
    state.jobId = null;
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
  log(`[ACP-BUYER] ${args.execute ? 'EXECUTE (real USDC)' : 'DRY-RUN (0 txns)'} · maxJobs=${args.maxJobs} · cap=$${cfg.maxSpendUsd} · network=${cfg.network} · mode=${args.skipEval ? 'skip-eval (does NOT count toward graduation)' : 'evaluated'}`);

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
    const bundle = await createBuyerAgent(cfg, log, args.skipEval);
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
  void runScript('acp-graduation-buyer', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
