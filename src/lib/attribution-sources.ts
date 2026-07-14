/**
 * ATTRIBUTION-CONNECTION-SRC-W1 — canonical SoT for per-channel acquisition
 * source, captured at the MCP **connection layer** (`?src=` query + a UA
 * heuristic fallback) and NEVER in the tools-list. That is the whole point:
 * `?src=` is set once per listing and is version-invariant, so attribution
 * never forces the cached-tools/list refresh that plagued earlier attempts.
 *
 * New channel = ONE row in {@link ATTRIBUTION_SOURCES} (+ optionally one
 * {@link UA_HEURISTICS} pattern). Default-deny: any unrecognized `?src` or UA
 * resolves to `'unknown'` (never trust a raw value through).
 *
 * Rationale correction (Cowork-ratified 2026-06-19, supersedes the spec's
 * framing): the prior track-token attempt was a HEADER
 * (`X-AlgoVault-Track-Token`, still live for TG-BROADCAST-STACK CH6) plus an
 * install-snippet header — it was **never in the tools-list**, and the
 * "tools/list cache refresh" story was a misremembering. The real blind spot
 * is **local-stdio** (`npx … TRANSPORT=stdio`): a stdio install makes no
 * outbound call to api.algovault.com, so the `npm` slug is **connect-
 * uncapturable** here. It is retained as a forward-compat placeholder (for a
 * future stdio→remote analytics proxy); npm channel VOLUME is measured via npm
 * registry download stats, not per-session. Remote-HTTP — the default
 * transport — IS fully `?src=`-capturable, so stdio is the only blind spot.
 *
 * `direct` was intentionally dropped (Cowork A4): an untagged connect is
 * genuinely `unknown`, not `direct`.
 */

/**
 * Canonical acquisition-source slugs. Order is informational only. `unknown`
 * is the default-deny terminal. `npm` is connect-uncapturable (see file
 * header) — kept as a forward-compat placeholder, NOT wired on any URL.
 */
import { matchLlmClientUa, logUnmatchedUa } from './llm-clients.js';

export const ATTRIBUTION_SOURCES = [
  'chatgpt',
  'claude',
  'smithery',
  'glama',
  'pulsemcp',
  'mcp_so',
  'bazaar',
  'agentkit',
  'elizaos',
  'llamahub',
  'npm', // connect-uncapturable placeholder (stdio doesn't phone home)
  'github',
  'docs',
  'x',
  // FUNNEL-FIX-ATTRIBUTION-W1 — LLM-client channels (UA-matched via llm-clients.ts once observed):
  'cursor', 'windsurf', 'cline', 'continue', 'zed', 'copilot',
  // FUNNEL-FIX-ATTRIBUTION-W1 — inbound referrer channels (referer-domain-matched):
  'devto', 'medium', 'lobehub', 'producthunt', 'reddit', 'organic',
  // OPS-ATTRIBUTION-AI-REFERRAL-W1 — AI-assistant HUMAN-referral channels (Referer + utm_source
  // matched). DISTINCT from the UA-matched agent slugs `chatgpt`/`claude` above: a HUMAN clicking an
  // AI citation link is NOT the same event as an agent connecting via that AI's MCP client.
  'ai_chatgpt', 'ai_perplexity', 'ai_claude', 'ai_gemini', 'ai_copilot', 'ai_grok',
  'unknown', // default-deny terminal — an untagged/unclassified hit is unknown, not "direct"
] as const;

export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];

/** O(1) membership set for validation. */
export const ATTRIBUTION_SOURCE_SET: ReadonlySet<string> = new Set(ATTRIBUTION_SOURCES);

/**
 * OPS-ATTRIBUTION-AI-REFERRAL-W1 — the `ai_*` human-referral family, DERIVED from the enum by the
 * `ai_` prefix (single SoT: add a slug to ATTRIBUTION_SOURCES → it joins the family automatically).
 * Consumers group by this set OR, equivalently, by `mediumForSource(s) === 'ai'`; never hardcode the
 * slug list at a call site. A drift canary asserts the two derivations agree.
 */
export const AI_REFERRAL_SOURCES: readonly AttributionSource[] =
  ATTRIBUTION_SOURCES.filter((s) => s.startsWith('ai_'));
export const AI_REFERRAL_SOURCE_SET: ReadonlySet<string> = new Set(AI_REFERRAL_SOURCES);
export function isAiReferralSource(source: unknown): boolean {
  return typeof source === 'string' && AI_REFERRAL_SOURCE_SET.has(source);
}

export type SourceConfidence = 'deterministic' | 'heuristic' | 'unknown';

export interface ResolvedSource {
  source: AttributionSource;
  source_confidence: SourceConfidence;
}

// FUNNEL-FIX-ATTRIBUTION-W1: the UA→client heuristic map moved to the extensible
// `llm-clients.ts` SoT (add-a-row once a real UA is observed). Referer classification below.

/**
 * Inbound-referrer host → source (deterministic — a known referrer domain IS a channel).
 * Owned-surface + organic domains, seeded from the ratified Q3 map. Extend = one row.
 */
const REFERER_DOMAIN_MAP: ReadonlyArray<{ pattern: RegExp; source: AttributionSource }> = [
  // OPS-ATTRIBUTION-AI-REFERRAL-W1 — AI-assistant web-UI referrers → ai_* (listed FIRST so
  // gemini.google.com wins BEFORE the generic google→organic rule below, and each AI host wins
  // before any parent rule). A HUMAN browser referral (desktop-web) — a FLOOR: native apps strip
  // the Referer, and Google AI-Overviews arrive as host `google.*` → `organic` (unrecoverable).
  // Grok-on-X is `x.com/i/grok` (a PATH → Referer host = `x.com`) → unrecoverable, stays `x`; the
  // canonical standalone `grok.com` IS capturable. `grok.ai` is intentionally omitted — ownership
  // unverified (Factuality LAW: don't attribute a possible look-alike).
  { pattern: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i, source: 'ai_chatgpt' },
  { pattern: /(^|\.)perplexity\.ai$/i, source: 'ai_perplexity' },
  { pattern: /(^|\.)claude\.ai$/i, source: 'ai_claude' },
  { pattern: /(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$/i, source: 'ai_gemini' },
  { pattern: /(^|\.)copilot\.microsoft\.com$/i, source: 'ai_copilot' },
  { pattern: /(^|\.)grok\.com$/i, source: 'ai_grok' },
  { pattern: /(^|\.)x\.com$|(^|\.)twitter\.com$/i, source: 'x' },
  { pattern: /(^|\.)github\.com$/i, source: 'github' },
  { pattern: /(^|\.)npmjs\.com$/i, source: 'npm' },
  { pattern: /(^|\.)dev\.to$/i, source: 'devto' },
  { pattern: /(^|\.)medium\.com$/i, source: 'medium' },
  { pattern: /(^|\.)lobehub\.com$/i, source: 'lobehub' },
  { pattern: /(^|\.)producthunt\.com$/i, source: 'producthunt' },
  { pattern: /(^|\.)reddit\.com$/i, source: 'reddit' },
  { pattern: /(^|\.)smithery\.ai$/i, source: 'smithery' },
  { pattern: /(^|\.)glama\.ai$/i, source: 'glama' },
  { pattern: /(^|\.)pulsemcp\.com$/i, source: 'pulsemcp' },
  { pattern: /(^|\.)mcp\.so$/i, source: 'mcp_so' },
  { pattern: /(^|\.)(google|bing|duckduckgo|ecosia)\./i, source: 'organic' },
];

/** Classify a Referer URL by its host against the domain map. null if none/unparseable. Pure. */
export function classifyReferer(referer: unknown): AttributionSource | null {
  if (typeof referer !== 'string' || !referer) return null;
  let host: string;
  try { host = new URL(referer).hostname.toLowerCase(); } catch { return null; }
  for (const r of REFERER_DOMAIN_MAP) if (r.pattern.test(host)) return r.source;
  return null;
}

/** Type guard: is `v` a known attribution slug? */
export function isAttributionSource(v: unknown): v is AttributionSource {
  return typeof v === 'string' && ATTRIBUTION_SOURCE_SET.has(v);
}

/**
 * Validate a raw `?src=` value against the SoT enum. Returns the slug if known,
 * else `null` (default-deny — the caller treats `null` as "not deterministically
 * tagged" and falls through to the UA heuristic). Trimmed + lowercased; rejects
 * anything not in the enum (no raw passthrough). NOTE: there is NO length floor
 * here — unlike the track-token `TOKEN_RE` (`/^[A-Za-z0-9_-]{8,64}$/`), short
 * slugs like `x` / `npm` / `docs` are valid because they are validated against
 * the closed enum, not a free-form token regex.
 */
export function normalizeSrcParam(raw: unknown): AttributionSource | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return ATTRIBUTION_SOURCE_SET.has(v) ? (v as AttributionSource) : null;
}

/**
 * OPS-ATTRIBUTION-AI-REFERRAL-W1 — allow-listed normalization of an inbound `utm_source` value to an
 * `ai_*` slug (Layer 2). ChatGPT auto-appends `utm_source=chatgpt.com` to the links it cites; that
 * tag SURVIVES the Referer-strip on mobile / native apps, so it is the single highest-value AI-
 * referral capture. Applied ONLY to `utm_source` (the external auto-tag), NEVER to our canonical
 * `?src=`. Allow-list only (default-deny), then falls back to the enum for legacy short utm slugs
 * (OPS-UTM-SHORTEN-W1 back-compat). Extend = one row (Perplexity/Gemini/Claude do NOT consistently
 * utm-tag as of 2026-07 — add when observed).
 */
const AI_UTM_SOURCE_MAP: ReadonlyMap<string, AttributionSource> = new Map([
  ['chatgpt.com', 'ai_chatgpt'],
]);
export function normalizeUtmSource(raw: unknown): AttributionSource | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return AI_UTM_SOURCE_MAP.get(v) ?? normalizeSrcParam(v);
}

/**
 * Resolve `{source, source_confidence}` from connection-layer signals.
 *
 * Precedence:
 *   1. `?src=<known slug>`          → `deterministic`  (the canonical short tag)
 *   2. `?utm_source=` — allow-listed AI domain (`chatgpt.com`→`ai_chatgpt`, Layer 2) OR legacy short slug → `deterministic`
 *   3. Referer domain              → `deterministic`
 *   4. UA heuristic match          → `heuristic`
 *   5. nothing matched             → `unknown` / `unknown`  (default-deny)
 *
 * An unrecognized `?src`/`?utm_source` is NOT trusted — it falls through to the Referer,
 * then the UA heuristic, then `unknown`. NOTE: `?ref=` is deliberately NOT read here — it is
 * REFERRAL-LIGHT-W1's referral-CODE param (a different concern); classifying it as a channel
 * would misclassify a referral code that happens to match a slug. `origin` / `referer` are
 * accepted (so call sites pass them); `referer` feeds `classifyReferer`, `origin` is reserved.
 */
export function resolveSource(input: {
  srcParam?: unknown;
  utmSource?: unknown;
  userAgent?: unknown;
  origin?: unknown;
  referer?: unknown;
}): ResolvedSource {
  // (1) explicit ?src= (deterministic), then (2) ?utm_source= — an allow-listed AI domain
  //     (chatgpt.com→ai_chatgpt, OPS-ATTRIBUTION-AI-REFERRAL-W1 Layer 2) OR a legacy short slug.
  //     Both default-deny: a junk value returns null and falls through to the Referer/UA.
  const tagged = normalizeSrcParam(input.srcParam) ?? normalizeUtmSource(input.utmSource);
  if (tagged) return { source: tagged, source_confidence: 'deterministic' };

  // (2) FUNNEL-FIX-ATTRIBUTION-W1: Referer domain (deterministic — a known referrer host).
  const referred = classifyReferer(input.referer);
  if (referred) return { source: referred, source_confidence: 'deterministic' };

  // (3) LLM-client UA (heuristic; extensible map). Unmatched non-empty UAs are log-sampled
  //     (forensic) so a real cursor/windsurf UA can be turned into a row later.
  const ua = typeof input.userAgent === 'string' ? input.userAgent : '';
  if (ua) {
    const client = matchLlmClientUa(ua);
    if (client) return { source: client, source_confidence: 'heuristic' };
    logUnmatchedUa(ua);
  }

  // (4) default-deny.
  return { source: 'unknown', source_confidence: 'unknown' };
}

/** Coarse medium for a resolved source (for the classified-channel panel). Pure. */
export type SourceMedium = 'listing' | 'social' | 'agent' | 'organic' | 'referral' | 'ai' | 'direct';
export function mediumForSource(source: AttributionSource): SourceMedium {
  switch (source) {
    case 'x': return 'social';
    case 'chatgpt': case 'claude': case 'cursor': case 'windsurf': case 'cline':
    case 'continue': case 'zed': case 'copilot': return 'agent';
    case 'smithery': case 'glama': case 'pulsemcp': case 'mcp_so': case 'bazaar':
    case 'agentkit': case 'elizaos': case 'llamahub': case 'npm': case 'lobehub':
    case 'producthunt': return 'listing';
    case 'organic': return 'organic';
    case 'github': case 'docs': case 'devto': case 'medium': case 'reddit': return 'referral';
    // OPS-ATTRIBUTION-AI-REFERRAL-W1 — the ai_* human-referral family, grouped as its OWN medium so
    // the scoreboard sums by `medium === 'ai'` (single-derivation), never a hardcoded slug list.
    case 'ai_chatgpt': case 'ai_perplexity': case 'ai_claude': case 'ai_gemini':
    case 'ai_copilot': case 'ai_grok': return 'ai';
    default: return 'direct'; // 'unknown' → the honest direct/unknown residual
  }
}

export interface ClassifiedSource {
  source: AttributionSource;
  medium: SourceMedium;
  confidence: SourceConfidence;
}

/**
 * FUNNEL-FIX-ATTRIBUTION-W1 — the richer entry point: resolve `{source, medium, confidence}`
 * from all connection-layer signals (?src/utm → Referer → LLM-client UA → default-deny).
 * Never fabricates a channel. Feeds the classified-channel panel + the first-touch stamp.
 */
export function classifySource(input: {
  srcParam?: unknown; utmSource?: unknown; userAgent?: unknown; origin?: unknown; referer?: unknown;
}): ClassifiedSource {
  const { source, source_confidence } = resolveSource(input);
  return { source, medium: mediumForSource(source), confidence: source_confidence };
}

// ── connect-emit dedup (mirrors track-token.ts shouldEmitForRequest) ──────────
// One `mcp_connect` per resolved session_id per process. In-memory LRU; resets
// on restart/replica (re-emits one connect/session/process — the funnel-snapshot
// reads COUNT(DISTINCT session_id), so cross-process dupes collapse). Bounded to
// avoid unbounded growth in the long-lived server.
const _connectEmitted = new Set<string>();
const MAX_CONNECT_KEYS = 8192;

/**
 * Returns true the FIRST time we see `sessionId` (caller should emit the
 * `mcp_connect` row), false thereafter. Call sites MUST pass a non-empty
 * sessionId (gate on truthiness first) — the `no-session` fallback exists only
 * for defense and collapses all empty ids to one key.
 */
export function shouldEmitConnect(sessionId: string | null | undefined): boolean {
  const key = sessionId && sessionId.length > 0 ? sessionId : 'no-session';
  if (_connectEmitted.has(key)) return false;
  if (_connectEmitted.size >= MAX_CONNECT_KEYS) {
    const oldest = _connectEmitted.values().next().value;
    if (oldest !== undefined) _connectEmitted.delete(oldest);
  }
  _connectEmitted.add(key);
  return true;
}

/** Reset the connect-dedup LRU — tests only. */
export function _resetConnectDedupForTest(): void {
  _connectEmitted.clear();
}
