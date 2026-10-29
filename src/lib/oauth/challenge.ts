/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH3 — the sign-in challenge (R3.1, endpoint-truth proposal (a)).
 *
 * Claude starts its OAuth flow only on an HTTP 401 carrying `WWW-Authenticate: … resource_metadata`,
 * and it has to arrive BEFORE the SDK runs: the quota wall answers 200 with a tool error, which no
 * client treats as "sign in". This module decides, once per `/mcp` request, whether to send that 401
 * instead of serving the call.
 *
 * Challenge iff ALL of: mode ≠ off · `oauthHealthy()` · POST `tools/call` of a metered tool ·
 * `license.anonymous` · no `Authorization` header at all · no x402 proof header (v1 `x-payment` or
 * v2 `payment-signature`) and no x402 downgrade · and EITHER `?signin=1` OR (mode `wall` · Anthropic
 * egress IP · client family `claude` · the meter refuses). Anything undecidable serves: the failure
 * mode of this module is today's behaviour, never a 401.
 *
 * A challenge charges nothing — it runs before every emit and before `trackCall` — and a `signin`
 * challenge never reads the meter. The wall's quota peek runs inside its own `requestContext.run`
 * (C19), so the free-tier key resolves to the caller's real bucket, and a refused peek emits the
 * `quota_hit_block` the tool would have (C20). `noteStepup` dedupes per tracker per UTC day, so the
 * peek and a later tool `checkQuota` write one `stepup_*` row.
 *
 * GROWTH-AGENT-SIGNIN-OAUTH-W3 — the TOOL-LEVEL half, for clients that never see that 401. ChatGPT
 * opens its account-linking UI on a tool result, not on an HTTP status, and only when BOTH halves
 * are present (OpenAI Apps SDK, "Authentication"): the tool declares `securitySchemes` on
 * tools/list, and the refused result carries `_meta["mcp/www_authenticate"]`. Both halves are gated
 * by `isMeteredTool`, so a tool never carries one without the other, and the challenge is decided
 * from the same preamble as the 401 (`canChallenge`), so the two can never disagree about WHO may
 * be asked to sign in. The 401 itself is unchanged.
 */
import type { Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LicenseInfo } from '../../types.js';
import { checkQuota, requestContext, type X402Downgrade } from '../license.js';
import { getFeature } from '../feature-registry.js';
import { classifyClient } from '../client-registry.js';
import { clientIp } from '../client-ip.js';
import { isAnthropicEgressHash, isAnthropicEgressIp } from '../platform-egress.js';
import { effectiveKeylessMonthlyCalls, freeCallsLabel, resolveStepupMode } from '../plans.js';
import { recordFunnelEvent } from '../performance-db.js';
import { OAUTH_RESOURCE_SCOPES, resolveOAuthMode, type OAuthMode } from './mode.js';
import { oauthHealthy } from './store.js';
import { bearerChallengeHeader, sendBearerChallenge } from './metadata.js';

export type ChallengeReason = 'signin' | 'wall_month' | 'wall_day';
export type ChallengeDecision = { shape: 'serve' } | { shape: 'challenge'; reason: ChallengeReason };

/** The meter's answer, as far as the wall needs it. `null` = the peek could not be read. */
export interface QuotaPeek {
  allowed: boolean;
  limit?: 'monthly' | 'daily' | null;
}

export interface ChallengeInput {
  mode: OAuthMode;
  healthy: boolean;
  httpMethod: string;
  rpcMethod: string | undefined;
  /** The called tool's name, or undefined when the body names none. */
  tool: string | undefined;
  anonymous: boolean;
  hasAuthorization: boolean;
  hasPaymentHeader: boolean;
  x402Downgrade: boolean;
  signin: boolean;
  anthropicEgress: boolean;
  clientFamily: string;
  /** Called at most once, and only when the wall is the deciding branch. */
  peekQuota: () => QuotaPeek | null;
}

const SERVE: ChallengeDecision = { shape: 'serve' };

/** A metered tool is one the registry charges for; rate-limited tools and unknown names are not. */
export function isMeteredTool(name: string | undefined): boolean {
  if (!name) return false;
  const unit = getFeature(name)?.quota.unit;
  return unit !== undefined && unit !== 'rate-limited';
}

/** The facts R3.1's preamble reads — everything except the branch-specific inputs. */
export type ChallengeEligibility = Omit<ChallengeInput, 'signin' | 'anthropicEgress' | 'clientFamily' | 'peekQuota'>;

/**
 * R3.1's preamble: a metered `tools/call` from a caller who holds no credential and pays no x402, on
 * a healthy OAuth server. It answers WHO may be asked to sign in; `decideChallenge` adds WHEN the
 * 401 is sent, and the W3 tool-level challenge reads it as-is.
 */
export function canChallenge(input: ChallengeEligibility): boolean {
  if (input.mode === 'off' || !input.healthy) return false;
  if (input.httpMethod !== 'POST' || input.rpcMethod !== 'tools/call') return false;
  if (!isMeteredTool(input.tool)) return false;
  if (!input.anonymous || input.hasAuthorization) return false;
  return !(input.hasPaymentHeader || input.x402Downgrade);
}

export function decideChallenge(input: ChallengeInput): ChallengeDecision {
  if (!canChallenge(input)) return SERVE;
  if (input.signin) return { shape: 'challenge', reason: 'signin' };
  if (input.mode !== 'wall' || !input.anthropicEgress || input.clientFamily !== 'claude') return SERVE;
  let peek: QuotaPeek | null;
  try {
    peek = input.peekQuota();
  } catch {
    return SERVE;
  }
  if (!peek || peek.allowed !== false) return SERVE;
  return { shape: 'challenge', reason: peek.limit === 'daily' ? 'wall_day' : 'wall_month' };
}

export const CHALLENGE_DESCRIPTION = 'Sign in free to keep using AlgoVault';
export const SIGN_IN_URL = 'https://api.algovault.com/welcome?src=stepup';

/** §Copy A, verbatim. */
export function challengeMessage(reason: ChallengeReason): string {
  if (reason === 'signin') return "Sign in to continue. It's free, no card.";
  const tail = `Sign in free for ${freeCallsLabel()} calls a month, no card.`;
  if (reason === 'wall_day') return `You've used today's calls available without signing in. ${tail}`;
  return `You've used the ${effectiveKeylessMonthlyCalls(resolveStepupMode())} calls available without signing in this month. ${tail}`;
}

// `stepup_challenge` is at most one row per bucket per reason per UTC minute: a client that retries
// a refused call in a tight loop must not turn the funnel table into its retry log. Bounded like
// `noteStepup`'s set, oldest evicted first.
const CHALLENGE_SEEN_MAX = 10_000;
const challengeSeen = new Set<string>();

function noteChallenge(reason: ChallengeReason, ipHash: string, clientFamily: string, sessionId: string | undefined, tier: string, now: number): void {
  const dedupe = `free:${ipHash}|${reason}|${Math.floor(now / 60_000)}`;
  if (challengeSeen.has(dedupe)) return;
  if (challengeSeen.size >= CHALLENGE_SEEN_MAX) {
    const oldest = challengeSeen.values().next().value;
    if (oldest !== undefined) challengeSeen.delete(oldest);
  }
  challengeSeen.add(dedupe);
  recordFunnelEvent({
    eventType: 'stepup_challenge',
    sessionId: sessionId ?? null,
    licenseTier: tier,
    meta: { reason, client_family: clientFamily, pool: isAnthropicEgressHash(ipHash) ? 'anthropic' : 'other' },
  });
}

/** Test seam. */
export function _resetChallengeForTest(): void {
  challengeSeen.clear();
}

/**
 * The `/mcp` seam. Returns true when it answered the request (the route must return), false to
 * serve. Called on the line after `applyCredentialRefusal`, before any emit or charge.
 */
export async function applyChallenge(
  req: Request,
  res: Response,
  license: LicenseInfo,
  x402Downgrade: X402Downgrade | undefined,
  ctx: { ipHash: string; sessionId: string | undefined },
): Promise<boolean> {
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
  const clientFamily = classifyClient(userAgent).name;
  const decision = decideChallenge({
    ...eligibilityOf(req, license, x402Downgrade),
    signin: req.query?.signin === '1',
    anthropicEgress: isAnthropicEgressIp(clientIp(req)),
    clientFamily,
    peekQuota: () => requestContext.run(
      { license, sessionId: ctx.sessionId, ipHash: ctx.ipHash, userAgent },
      () => checkQuota(license),
    ),
  });
  if (decision.shape === 'serve') return false;
  noteChallenge(decision.reason, ctx.ipHash, clientFamily, ctx.sessionId, license.tier, Date.now());
  sendBearerChallenge(res, req.originalUrl, CHALLENGE_DESCRIPTION, {
    reason: decision.reason,
    message: challengeMessage(decision.reason),
    sign_in_url: SIGN_IN_URL,
  });
  return true;
}

/** The preamble's facts, read from the request by ONE function — shared by the 401 and the tool-level half. */
function eligibilityOf(req: Request, license: LicenseInfo, x402Downgrade: X402Downgrade | undefined): ChallengeEligibility {
  const body = (req.body && typeof req.body === 'object') ? req.body as { method?: unknown; params?: { name?: unknown } } : undefined;
  return {
    mode: resolveOAuthMode(),
    healthy: oauthHealthy(),
    httpMethod: req.method,
    rpcMethod: typeof body?.method === 'string' ? body.method : undefined,
    tool: typeof body?.params?.name === 'string' ? body.params.name : undefined,
    anonymous: license.anonymous === true,
    hasAuthorization: req.headers.authorization !== undefined,
    hasPaymentHeader: req.headers['x-payment'] !== undefined || req.headers['payment-signature'] !== undefined,
    x402Downgrade: x402Downgrade !== undefined,
  };
}

// ── W3: the tool-level half ─────────────────────────────────────────────────────────────────────

/**
 * The challenge a served call's quota refusal carries in `_meta["mcp/www_authenticate"]`, or
 * undefined when signing in would not lift it. Decided at the route (where the credential headers
 * are) and threaded to the tool layer through `requestContext`. The string is the SAME
 * `bearerChallengeHeader` the 401 sends, so a client reads one grammar whichever half it honours.
 */
export function toolWallChallenge(req: Request, license: LicenseInfo, x402Downgrade: X402Downgrade | undefined): string | undefined {
  return canChallenge(eligibilityOf(req, license, x402Downgrade))
    ? bearerChallengeHeader(req.originalUrl, CHALLENGE_DESCRIPTION)
    : undefined;
}

/** Anonymous calls stay allowed; OAuth is offered. Order is the Apps SDK's "optional auth" form. */
export const TOOL_SECURITY_SCHEMES: readonly Record<string, unknown>[] = [
  { type: 'noauth' },
  { type: 'oauth2', scopes: [...OAUTH_RESOURCE_SCOPES] },
];

/** A tool's `securitySchemes`: the metered tools — the ones a sign-in lifts a refusal on — only. */
export function toolSecuritySchemes(name: unknown): readonly Record<string, unknown>[] | undefined {
  return typeof name === 'string' && isMeteredTool(name) ? TOOL_SECURITY_SCHEMES : undefined;
}

type ListHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/**
 * Declare `securitySchemes` on tools/list: top-level (the Apps SDK's primary key) and mirrored into
 * `_meta.securitySchemes` (its back-compat key). SDK 1.29 builds each tool entry from a fixed field
 * list, so the only seam is the registered handler itself, which this wraps. Call it AFTER the tools
 * are registered. Mode-gated, not health-gated: ChatGPT snapshots the list on refresh, and a
 * breaker trip must not strip the scheme until the next one. Returns false and changes nothing when
 * the mode is off or the SDK keeps its handlers elsewhere — the list then serves exactly as before.
 */
export function advertiseToolSecuritySchemes(server: McpServer, mode: OAuthMode = resolveOAuthMode()): boolean {
  if (mode === 'off') return false;
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, ListHandler> })._requestHandlers;
  const inner = handlers?.get('tools/list');
  if (!handlers || typeof inner !== 'function') return false;
  handlers.set('tools/list', async (request, extra) => {
    const result = await inner(request, extra) as { tools?: unknown } | undefined;
    if (!result || !Array.isArray(result.tools)) return result;
    return {
      ...result,
      tools: result.tools.map((tool: { name?: unknown; _meta?: Record<string, unknown> }) => {
        const schemes = toolSecuritySchemes(tool?.name);
        return schemes ? { ...tool, securitySchemes: schemes, _meta: { ...tool._meta, securitySchemes: schemes } } : tool;
      }),
    };
  });
  return true;
}
