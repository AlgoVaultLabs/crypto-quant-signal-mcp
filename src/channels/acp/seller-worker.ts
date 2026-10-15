/**
 * seller-worker.ts — Virtuals ACP event-driven seller loop (P1-ACP-SELLER-SEED / R3).
 *
 * Maps an incoming ACP job → an EXISTING AlgoVault tool via the shared x402 core handler
 * (`callCoreHandler`), then returns the public envelope verbatim as the job deliverable. ZERO new
 * signal logic — the reuse IS the compounding artifact, and it inherits the public-shape projection
 * (never any internal outcome/PnL field) + the `_algovault` block for free.
 *
 * Lifecycle (SDK seller model — see README seller example / endpoint-truth):
 *   buyer `requirement` message while status==="open"  → validate → session.setBudget(usdc(price))
 *   system `job.funded`                                → run tool → session.submit(JSON deliverable)
 *   system `job.completed`                             → log
 *
 * IDEMPOTENCY (Q1): agent.start() hydrates in-flight jobs and may re-emit a funded event on
 * reconnect/restart. handleAcpEntry skips re-submit when the jobId is already in `deps.submitted`
 * OR session.status is already submitted/completed (a hydrated, already-delivered job) — no
 * double-delivery. The status guard is the durable one (server-sourced, survives restart); the
 * in-process set additionally guards concurrent re-entry within a single run.
 *
 * TEST-IMPORTABLE: handleAcpEntry is pure + deps-injected (no SDK, no network). The module boots a
 * real/stub worker only under `if (require.main === module)` — so importing it in tests is inert.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import type { HttpTool } from '../../lib/x402-http-routes.js';
import { callTool, type ValidatedToolInput } from '../../lib/tool-call-pipeline.js';
import { getFeature } from '../../lib/feature-registry.js';
import { markServed, markDark } from '../../lib/rail-served-state.js';
import type { LicenseInfo } from '../../types.js';
import { offeringByName, requirementToParams, type AcpOffering } from './offerings.js';
import {
  resolveAcpConfig,
  selectAcp,
  createLiveAcpAgent,
  createStubAcpAgent,
  type SellerSession,
  type SellerEntry,
  type AcpAgentBundle,
  type AcpEnv,
} from './provider.js';

/** Paid-tier license for ACP jobs — the ACP escrow IS the payment, so bypass the free quota
 *  counter exactly like the x402/a2mcp channels. Identical to what a paid x402 call resolves. */
export const ACP_X402_LICENSE: LicenseInfo = { tier: 'x402', key: null, outcome: 'RESOLVED' };

/** Per-call price (USD) for a canonical tool from the registry SoT — same schedule as every channel
 *  (get_trade_call 0.02, scan_trade_calls 0.02, scan_funding_arb 0.01). */
export function acpPriceUsd(canonicalTool: string): number {
  return getFeature(canonicalTool)?.x402?.basePriceUsd ?? 0.02;
}

/** Injected dependencies — makes handleAcpEntry a pure unit (no SDK, no network) for testing. */
export interface AcpWorkerDeps {
  /** Denominate a USD budget in USDC on the session chain (provider.usdc → SDK AssetToken.usdc). */
  usdc: (amountUsd: number, chainId: number) => Parameters<SellerSession['setBudget']>[0];
  /** Run the mapped tool through the shared x402 core handler (byte-parity with MCP/x402). */
  callTool: (httpTool: HttpTool, params: ValidatedToolInput) => Promise<unknown>;
  /** Canonical-tool → USD price (registry SoT). */
  priceFor: (canonicalTool: string) => number;
  /** In-process idempotency store — jobIds already delivered this run. */
  submitted: Set<string>;
  log?: (msg: string) => void;
}

/** Statuses at/after delivery — a job in one of these must NOT be re-submitted. */
const ALREADY_DELIVERED = new Set(['submitted', 'completed', 'rejected', 'expired']);

// ── ajv requirement validation (compiled once per offering) ──
const _ajv = new Ajv({ allErrors: false, strict: false });
const _validators = new Map<string, ValidateFunction>();
function validateRequirement(offering: AcpOffering, requirement: unknown): boolean {
  let v = _validators.get(offering.name);
  if (!v) {
    v = _ajv.compile(offering.requirementSchema);
    _validators.set(offering.name, v);
  }
  return v(requirement) === true;
}

/** Find the buyer's most-recent `requirement` message in the session history (survives hydration). */
function latestRequirement(session: SellerSession): string | null {
  for (let i = session.entries.length - 1; i >= 0; i--) {
    const e = session.entries[i];
    if (e.kind === 'message' && e.contentType === 'requirement') return e.content;
  }
  return null;
}

/**
 * PURE seller-entry handler (no SDK, no network — deps-injected). The tested unit.
 * Returns a short status string for observability/testing.
 */
export async function handleAcpEntry(session: SellerSession, entry: SellerEntry, deps: AcpWorkerDeps): Promise<string> {
  const log = deps.log ?? (() => {});
  // We only ever act as the provider (seller).
  if (!session.roles.includes('provider')) return 'ignored';

  // 1) Buyer requirement while the job is open → validate + propose the budget.
  if (entry.kind === 'message' && entry.contentType === 'requirement' && session.status === 'open') {
    const offering = offeringByName(session.job?.description);
    if (!offering) {
      log(`[ACP] job ${session.jobId}: no offering for "${session.job?.description ?? ''}" — skip`);
      return 'skipped:no_offering';
    }
    let requirement: Record<string, unknown>;
    try {
      requirement = JSON.parse(entry.content) as Record<string, unknown>;
    } catch {
      log(`[ACP] job ${session.jobId}: requirement is not JSON — skip`);
      return 'skipped:bad_json';
    }
    if (!validateRequirement(offering, requirement)) {
      log(`[ACP] job ${session.jobId}: requirement failed the offering schema — skip`);
      return 'skipped:invalid_requirement';
    }
    const price = deps.priceFor(offering.canonicalTool);
    await session.setBudget(deps.usdc(price, session.chainId));
    log(`[ACP] job ${session.jobId} (${offering.name}): budget set $${price}`);
    return 'budget_set';
  }

  // 2) Job funded → run the tool + submit the deliverable (idempotent, pass-through).
  if (entry.kind === 'system' && entry.event.type === 'job.funded') {
    if (deps.submitted.has(session.jobId) || ALREADY_DELIVERED.has(session.status)) {
      log(`[ACP] job ${session.jobId}: already delivered (status=${session.status}) — skip re-submit`);
      return 'skipped:already_delivered';
    }
    const offering = offeringByName(session.job?.description);
    if (!offering) {
      log(`[ACP] job ${session.jobId}: funded but no offering — skip`);
      return 'skipped:no_offering';
    }
    const raw = latestRequirement(session);
    if (raw == null) {
      log(`[ACP] job ${session.jobId}: funded but no requirement in history — skip`);
      return 'skipped:no_requirement';
    }
    let requirement: Record<string, unknown>;
    try {
      requirement = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      log(`[ACP] job ${session.jobId}: requirement is not JSON — skip`);
      return 'skipped:bad_json';
    }
    if (!validateRequirement(offering, requirement)) {
      log(`[ACP] job ${session.jobId}: requirement failed the offering schema — skip`);
      return 'skipped:invalid_requirement';
    }
    // ARCH-MCP-CALL-PIPELINE-W1 CH2: this is the ACP validator's mint of the validated-input brand —
    // AFTER validateRequirement (Ajv over the offering schema) and the declared-key projection.
    const params = requirementToParams(offering, requirement) as ValidatedToolInput;
    // Mark BEFORE the await to single-flight concurrent re-entry; unmark on failure to allow retry.
    deps.submitted.add(session.jobId);
    try {
      const result = await deps.callTool(offering.httpTool, params);
      // Pass-through: the deliverable is EXACTLY the public envelope (byte-parity with x402/MCP).
      await session.submit(JSON.stringify(result));
      log(`[ACP] job ${session.jobId}: delivered ${offering.canonicalTool}`);
      return 'submitted';
    } catch (err) {
      deps.submitted.delete(session.jobId);
      log(`[ACP] job ${session.jobId}: tool/submit failed — ${err instanceof Error ? err.message : String(err)}`);
      return 'error';
    }
  }

  // 3) Terminal completion → log.
  if (entry.kind === 'system' && entry.event.type === 'job.completed') {
    log(`[ACP] job ${session.jobId}: completed`);
    return 'completed';
  }

  return 'ignored';
}

/**
 * ARCH-MCP-CALL-PIPELINE-W1 CH2 — the ACP channel's ONE tool call: the shared pipeline with the ACP
 * licence, no request context (Q-PIPE-3 deferred — the channel row records nothing). A refused or
 * thrown call THROWS here so `handleAcpEntry` returns 'error' and no deliverable is submitted — the
 * same outcome class as any refused ACP job (Q-PIPE-2 row 12). Exported so the parity harness drives
 * the exact production wiring rather than a hand-built mirror of it.
 */
export async function acpCallTool(httpTool: HttpTool, input: ValidatedToolInput): Promise<unknown> {
  const outcome = await callTool({ tool: httpTool, input, channel: 'acp', license: ACP_X402_LICENSE });
  if (outcome.ok) return outcome.result;
  if (outcome.kind === 'refused') throw new Error(`refused: ${String(outcome.payload.code ?? outcome.http.status)}`);
  throw outcome.error;
}

/**
 * Boot the ACP seller worker. Gated by the outer `ACP_ENABLED` flag (default off → no-op, prod
 * byte-identical). Boot-safe: any construction/start failure leaves ACP DARK (never crash-loops),
 * mirroring okx-a2mcp's mount. Returns {mode, started} for observability/tests.
 */
export async function startAcpSellerWorker(env: AcpEnv = process.env): Promise<{ mode: string; started: boolean }> {
  const resolved = selectAcp(resolveAcpConfig(env));
  if (!resolved.active) {
    markDark('acp', 'off (ACP_ENABLED not true)');
    return { mode: 'off', started: false };
  }

  const log = (m: string): void => console.log(m);
  let bundle: AcpAgentBundle;
  try {
    bundle = resolved.mode === 'live' ? await createLiveAcpAgent(resolved) : createStubAcpAgent(log);
  } catch (err) {
    console.error('[ACP] agent construction failed — ACP stays dark:', err instanceof Error ? err.message : err);
    markDark('acp', `agent construction failed: ${err instanceof Error ? err.message : String(err)}`);
    return { mode: resolved.mode, started: false };
  }
  if (resolved.stubFellBack) {
    console.warn(
      '[STUB ACP] ACP_ENABLED=true but signer creds (ACP_WALLET_ADDRESS / ACP_WALLET_ID / ACP_SIGNER_PRIVATE_KEY) ' +
        'are missing — running the [STUB] seller (no settlement). Provision creds to go live.',
    );
  }

  const deps: AcpWorkerDeps = {
    usdc: bundle.usdc,
    callTool: acpCallTool,
    priceFor: acpPriceUsd,
    submitted: new Set<string>(),
    log,
  };

  // Await each entry so a single job's steps stay ordered (requirement→funded→completed) and each
  // is processed fully; errors are swallowed to a log so one bad entry never tears down the agent.
  // (Sandbox is low-volume; if cross-job concurrency is ever needed, that pairs with the
  // horizontal-scale singleton follow-up — see system-map / WIS.)
  bundle.agent.on('entry', async (session, entry) => {
    try {
      await handleAcpEntry(session, entry, deps);
    } catch (e) {
      log(`[ACP] handler error: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  try {
    await bundle.agent.start(() => log(`[ACP] seller worker listening (mode=${resolved.mode}, network=${resolved.network})`));
  } catch (err) {
    console.error('[ACP] agent.start failed — ACP dark:', err instanceof Error ? err.message : err);
    markDark('acp', `agent.start failed: ${err instanceof Error ? err.message : String(err)}`);
    return { mode: resolved.mode, started: false };
  }
  markServed('acp', { mode: resolved.mode });
  return { mode: resolved.mode, started: true };
}

// Standalone entry: `node dist/channels/acp/seller-worker.js` (sandbox dry-run / future separate
// process). In the main server it's started in-process from src/index.ts (gated) instead.
if (require.main === module) {
  startAcpSellerWorker()
    .then((r) => console.log(`[ACP] worker boot: ${JSON.stringify(r)}`))
    .catch((e) => {
      console.error('[ACP] fatal:', e);
      process.exit(1);
    });
}
