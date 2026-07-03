/**
 * provider.ts — Virtuals ACP seller provider adapter + Stub (P1-ACP-SELLER-SEED / R2).
 *
 * Single file that absorbs SDK churn: env → resolveAcpConfig → pure selectAcp (the unit-test
 * seam) → construct. Mirrors src/lib/okx-a2mcp.ts (the sibling agent-commerce channel).
 *
 * TWO-FLAG FIREWALL:
 *   - outer `ACP_ENABLED` (default false) → selectAcp returns mode 'off' → the worker never
 *     starts → prod is byte-identical; flip = instant rollback.
 *   - inner per-tool `channels.acp` in the registry → decides WHICH tools are offered (the
 *     offering set derives from the registry via offerings.ts + the coverage canary).
 * STUB-FIRST: `ACP_ENABLED=true` but signer creds absent → StubAcpAgent (synthetic lifecycle,
 *   no network) — the wave's default dark behavior + the dry-run/unit-tested surface.
 *
 * ESM-INTEROP: @virtuals-protocol/acp-node-v2 is an ESM-only package ("type":"module"); this
 * repo compiles CommonJS (tsconfig module=Node16, no top-level "type"). A static `import` of the
 * SDK from a CJS file fails tsc (TS1479), so the SDK RUNTIME values are loaded via a dynamic
 * `import()` inside the async live path (Node16 preserves import() in CJS emit → loads the ESM
 * package at runtime on Node 20). SDK TYPES arrive via `import type` (erased, no require). Importing
 * THIS module is therefore side-effect-free (the SDK is touched only inside createLiveAcpAgent).
 */
import { base, baseSepolia } from 'viem/chains';

// ─────────────────── seller-facing interfaces (decouple the worker from SDK types + churn) ───────────────────
/**
 * The subset of the SDK `AssetToken` the worker/stub reference (a real AssetToken is assignable).
 * Defined locally so this CJS module never type-imports the ESM-only SDK (avoids TS1541); the SDK
 * value is only ever touched via the dynamic import in createLiveAcpAgent.
 */
export interface AssetTokenLike {
  readonly amount: number;
  readonly symbol: string;
}
/** The subset of the SDK `JobSession` the seller worker touches (a real JobSession is assignable). */
export interface SellerSession {
  readonly jobId: string;
  readonly chainId: number;
  readonly roles: readonly string[];
  readonly status: string;
  readonly job: { readonly description?: string | null } | null;
  readonly entries: readonly SellerEntry[];
  setBudget(amount: AssetTokenLike): Promise<void>;
  submit(deliverable: string): Promise<void>;
}
/** The subset of the SDK `JobRoomEntry` the worker inspects (a real JobRoomEntry is assignable). */
export type SellerEntry =
  | { kind: 'system'; event: { type: string } }
  | { kind: 'message'; contentType: string; content: string; from?: string };
export type SellerEntryHandler = (session: SellerSession, entry: SellerEntry) => void | Promise<void>;
/** The subset of the SDK `AcpAgent` the worker drives. */
export interface SellerAgent {
  on(event: 'entry', handler: SellerEntryHandler): unknown;
  start(onConnected?: () => void): Promise<void>;
  stop(): Promise<void>;
}
/** Denominate a USD budget in USDC on a chain (SDK `AssetToken.usdc`). */
export type UsdcFactory = (amountUsd: number, chainId: number) => AssetTokenLike;
/** What the worker needs to run a session, regardless of live/stub mode. */
export interface AcpAgentBundle {
  agent: SellerAgent;
  usdc: UsdcFactory;
  /** Default chainId for stub/dry-run lifecycles (real sessions carry their own). */
  chainId: number;
}

// ─────────────────── env → config → pure selection (the unit-test seam) ───────────────────
export type AcpMode = 'off' | 'stub' | 'live';
export type AcpNetwork = 'testnet' | 'mainnet';

export interface AcpEnv {
  ACP_ENABLED?: string;
  /** 'testnet' (default, Base Sepolia) | 'mainnet' (Base). Mainnet flip = a separate Mr.1-gated wave. */
  ACP_ENV?: string;
  /** app.virtuals.io Signers tab → walletAddress / walletId / signerPrivateKey. */
  ACP_WALLET_ADDRESS?: string;
  ACP_WALLET_ID?: string;
  ACP_SIGNER_PRIVATE_KEY?: string;
}
export interface AcpConfig {
  enabled: boolean;
  network: AcpNetwork;
  walletAddress?: string;
  walletId?: string;
  signerPrivateKey?: string;
}
export interface ResolvedAcp {
  active: boolean;
  mode: AcpMode;
  network: AcpNetwork;
  stubFellBack: boolean;
  walletAddress?: string;
  walletId?: string;
  signerPrivateKey?: string;
}

export function resolveAcpConfig(env: AcpEnv = process.env): AcpConfig {
  const network: AcpNetwork = env.ACP_ENV?.trim().toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
  return {
    enabled: env.ACP_ENABLED?.trim().toLowerCase() === 'true',
    network,
    walletAddress: env.ACP_WALLET_ADDRESS?.trim() || undefined,
    walletId: env.ACP_WALLET_ID?.trim() || undefined,
    signerPrivateKey: env.ACP_SIGNER_PRIVATE_KEY?.trim() || undefined,
  };
}

/**
 * PURE decision (no construction, no I/O) — the two-flag + stub-fallback rule:
 *   ACP_ENABLED!=true                                  → off  (worker never starts)
 *   enabled + walletAddress+walletId+signerPrivateKey  → live (Base Sepolia sandbox by default)
 *   enabled + any signer cred missing                  → stub (dark synthetic lifecycle)
 */
export function selectAcp(cfg: AcpConfig): ResolvedAcp {
  if (!cfg.enabled) return { active: false, mode: 'off', network: cfg.network, stubFellBack: false };
  const credsPresent = Boolean(cfg.walletAddress && cfg.walletId && cfg.signerPrivateKey);
  if (credsPresent) {
    return {
      active: true, mode: 'live', network: cfg.network, stubFellBack: false,
      walletAddress: cfg.walletAddress, walletId: cfg.walletId, signerPrivateKey: cfg.signerPrivateKey,
    };
  }
  return { active: true, mode: 'stub', network: cfg.network, stubFellBack: true };
}

// ─────────────────── live agent construction (dynamic import → ESM SDK from CJS) ───────────────────
/**
 * Construct the real ACP seller agent for the selected network. LIVE-UNVERIFIED end-to-end until
 * Mr.1 provisions signer creds + completes app.virtuals.io onboarding (R7); typed + compiles against
 * the pinned 0.1.7 types. The caller (the worker) wraps this in try/catch → boot-safe (never crash-loops).
 * DATA-INTEGRITY: the only chain interactions are the SDK's escrow ops (setBudget/submit/fund =
 * USDC settlement); the deliverable is posted off-chain via the SDK job API. No signal data on-chain.
 */
export async function createLiveAcpAgent(resolved: ResolvedAcp): Promise<AcpAgentBundle> {
  const sdk = await import('@virtuals-protocol/acp-node-v2');
  const isTestnet = resolved.network !== 'mainnet';
  const serverUrl = isTestnet ? sdk.ACP_TESTNET_SERVER_URL : sdk.ACP_SERVER_URL;
  // The Privy app-id follows the AGENT WALLET's environment, NOT the ACP job network: an agent minted
  // on the production Virtuals console lives on the prod Privy app even when its jobs run on the Base
  // Sepolia sandbox. Default to the network-based id, but ACP_PRIVY_APP_ID overrides it (no-redeploy
  // toggle) so a prod-console wallet can settle sandbox jobs.
  const privyAppId = process.env.ACP_PRIVY_APP_ID?.trim() || (isTestnet ? sdk.TESTNET_PRIVY_APP_ID : sdk.PRIVY_APP_ID);
  const chain = isTestnet ? baseSepolia : base;
  const provider = await sdk.PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: resolved.walletAddress! as `0x${string}`,
    walletId: resolved.walletId!,
    signerPrivateKey: resolved.signerPrivateKey!,
    chains: [chain],
    serverUrl,
    privyAppId,
  });
  const agent = await sdk.AcpAgent.create({
    provider,
    transport: new sdk.SseTransport({ serverUrl }),
    api: new sdk.AcpApiClient({ serverUrl }),
  });
  return {
    agent: agent as unknown as SellerAgent,
    usdc: (amountUsd, chainId) => sdk.AssetToken.usdc(amountUsd, chainId),
    chainId: chain.id,
  };
}

// ─────────────────── stub agent (no network, no creds) — default dark behavior + dry-run surface ───────────────────
class StubSellerSession implements SellerSession {
  status = 'open';
  readonly entries: SellerEntry[] = [];
  constructor(
    readonly jobId: string,
    readonly chainId: number,
    readonly roles: readonly string[],
    readonly job: { readonly description?: string | null } | null,
    private readonly log: (m: string) => void,
  ) {}
  async setBudget(amount: AssetTokenLike): Promise<void> {
    this.log(`[STUB ACP] setBudget job=${this.jobId} budget=${amount.amount} ${amount.symbol}`);
    this.status = 'budget_set';
  }
  async submit(deliverable: string): Promise<void> {
    const preview = deliverable.length > 140 ? `${deliverable.slice(0, 140)}…` : deliverable;
    this.log(`[STUB ACP] submit job=${this.jobId} deliverable=${preview}`);
    this.status = 'submitted';
  }
}

/**
 * StubAcpAgent — drives ONE scripted job (offering "AlgoVault Trade Call", BTC) through the
 * registered handler on start(): requirement(open) → job.funded → job.completed. Exercises the full
 * seller path offline so the dry-run logs the lifecycle against a Base Sepolia mock chainId. The
 * job.funded step invokes the REAL tool via the worker's callTool (byte-parity proof).
 */
export class StubAcpAgent implements SellerAgent {
  private handler: SellerEntryHandler | null = null;
  constructor(
    private readonly chainId: number = baseSepolia.id,
    private readonly log: (m: string) => void = console.log,
  ) {}
  on(_event: 'entry', handler: SellerEntryHandler): this {
    this.handler = handler;
    return this;
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async start(onConnected?: () => void): Promise<void> {
    this.log('[STUB ACP] seller agent started (no creds → dark). Running one synthetic job…');
    onConnected?.();
    const h = this.handler;
    if (!h) return;
    const session = new StubSellerSession('stub-job-1', this.chainId, ['provider'], { description: 'AlgoVault Trade Call' }, this.log);
    const dispatch = async (entry: SellerEntry): Promise<void> => {
      session.entries.push(entry);
      await h(session, entry);
    };
    await dispatch({ kind: 'message', contentType: 'requirement', content: JSON.stringify({ coin: 'BTC', timeframe: '1h' }) });
    session.status = 'funded';
    await dispatch({ kind: 'system', event: { type: 'job.funded' } });
    session.status = 'completed';
    await dispatch({ kind: 'system', event: { type: 'job.completed' } });
    this.log('[STUB ACP] synthetic job complete.');
  }
}

/** Stub bundle — fake USDC factory (no SDK runtime), synthetic agent. */
export function createStubAcpAgent(log: (m: string) => void = console.log): AcpAgentBundle {
  const usdc: UsdcFactory = (amountUsd) => ({ amount: amountUsd, symbol: 'USDC' });
  return { agent: new StubAcpAgent(baseSepolia.id, log), usdc, chainId: baseSepolia.id };
}
