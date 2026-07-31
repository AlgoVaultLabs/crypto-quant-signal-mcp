/**
 * OPS-CLIENT-ATTRIBUTION-W1 (2026-07-31): the ONE User-Agent → client identity map.
 *
 * Why this exists (two problems, one root cause — the UA had no single home):
 *
 *  1. **"🟢 Recognized clients: 0" was structurally unfixable.** `isbot` flags a bare SDK UA
 *     (`python-httpx`, `axios`, `undici`, `node`, the MCP SDK default) as a crawler — which is
 *     precisely what an ICP agent looks like — so the genuine-free bucket could never count the
 *     target customer. Measured 2026-07-31: 0 recognized clients across a whole 24h window in
 *     which 70 distinct sessions connected.
 *  2. **`request_log` discarded the UA** after using it to set `is_automated`, so a heavy caller
 *     could be classified but never named (OPS-TOP-IP-FORENSICS-W1 could not identify its top
 *     talker; 30 candidate hashes all missed).
 *
 * This registry is the single source for BOTH the `is_automated` decision (via
 * `traffic-classifier.ts`, which projects from it) and the persisted `request_log.client_name`.
 * A hand-kept allow-list *beside* the classifier's own regexes would be a second UA literal, and
 * per CLAUDE.md a duplicated fact goes stale — so the classifier's KNOWN-AGENT and HEALTH-CHECK
 * lists moved IN here rather than being mirrored.
 *
 * ORDER IS SEMANTIC — first match wins:
 *   agent_client → health_check → crawler → bare_sdk → browser
 * `agent_client` outranks `crawler` to preserve the ratified "never drop a real agent" bias
 * (a spoofed human is measurement noise; a dropped real agent corrupts the funnel).
 * `crawler` outranks `bare_sdk` so a named prober that ships an SDK UA — e.g.
 * `CoinbaseBazaarDiscovery/1.0 (axios)` — stays automated instead of being laundered by the
 * bare-SDK allow.
 *
 * NOT a replacement for `isbot`: an unmatched UA still falls through to it in the classifier.
 * This only ADDS an un-tag for programmatic SDKs, exactly as the wave scoped.
 *
 * PII: a User-Agent is not an address. Nothing here reads or stores an IP, a header other than
 * the UA, or anything from `Authorization`.
 *
 * Dependency-free leaf (no imports) so the classifier, analytics and call-class can all import it
 * without a cycle — same shape as payment-rail.ts / call-class.ts.
 */

/**
 * `agent_client` — a named MCP/AI client. A real human is behind it.
 * `bare_sdk`     — a programmatic HTTP SDK. **This is the ICP shape**: an autonomous agent
 *                  calling the API from code. Counted as a recognized client, not a crawler.
 * `crawler`      — search/SEO crawlers and the named x402 discovery probers. Automated.
 * `health_check` — uptime/liveness probes. Automated.
 * `browser`      — a real browser UA (landing pages, the dashboard).
 * `unknown`      — no UA, or no pattern matched. Never guessed at.
 */
export type ClientKind =
  | 'agent_client'
  | 'bare_sdk'
  | 'crawler'
  | 'health_check'
  | 'browser'
  | 'unknown';

export interface ClientSpec {
  /** Stable normalized slug persisted to `request_log.client_name`. Never rename in place. */
  readonly name: string;
  readonly kind: ClientKind;
  readonly re: RegExp;
}

/** Persisted `user_agent` is truncated to this many chars — forensics, not a blob store. */
export const MAX_UA_LEN = 256;

/** The value stored when the caller sends no UA at all. */
export const UNKNOWN_CLIENT = 'unknown';

export const CLIENT_REGISTRY: readonly ClientSpec[] = Object.freeze([
  // ── agent_client — named real MCP / AI clients (beats every later kind) ──
  { name: 'claude-code', kind: 'agent_client', re: /\bclaude[-_]?code\b/i },
  { name: 'claude', kind: 'agent_client', re: /\b(claude|anthropic)\b/i },
  { name: 'cursor', kind: 'agent_client', re: /\bcursor\b/i },
  { name: 'cline', kind: 'agent_client', re: /\bcline\b/i },
  { name: 'windsurf', kind: 'agent_client', re: /\bwindsurf\b/i },
  { name: 'codeium', kind: 'agent_client', re: /\bcodeium\b/i },
  { name: 'continue', kind: 'agent_client', re: /\bcontinue\.dev\b/i },
  { name: 'librechat', kind: 'agent_client', re: /\blibrechat\b/i },
  { name: 'goose', kind: 'agent_client', re: /\bgoose\b/i },
  { name: 'zed', kind: 'agent_client', re: /\bzed\.dev\b/i },
  { name: 'openai', kind: 'agent_client', re: /\b(chatgpt|openai)\b/i },
  { name: 'langchain', kind: 'agent_client', re: /\blangchain\b/i },
  { name: 'llamaindex', kind: 'agent_client', re: /\bllama[-_]?index\b/i },
  { name: 'smithery', kind: 'agent_client', re: /\bsmithery\b/i },
  { name: 'elizaos', kind: 'agent_client', re: /\beliza(os)?\b/i },
  { name: 'agentkit', kind: 'agent_client', re: /\bagentkit\b/i },
  { name: 'mcp-sdk', kind: 'agent_client', re: /(@modelcontextprotocol\/|\bmodelcontextprotocol\b|\bmcp[-_]?(client|sdk)\b)/i },

  // ── health_check — uptime / liveness probes ──
  {
    name: 'health-check',
    kind: 'health_check',
    re: /(ELB-HealthChecker|GoogleHC|kube-probe|UptimeRobot|Pingdom|Datadog\/Synthetics|Amazon-Route53-Health-Check|Consul Health Check|StatusCake|Site24x7|Better Uptime|HetrixTools)/i,
  },

  // ── crawler — named x402/discovery probers FIRST (they ship SDK UAs), then generic tokens.
  // The named set is recorded by OPS-X402-TRADE-CALL-CONTENT-TYPE-W1; keeping them explicit
  // means a rename shows up as `other` rather than being silently swept into `bare_sdk`.
  { name: 'mako-pulse-prober', kind: 'crawler', re: /\bmako[-_]?pulse[-_]?prober\b/i },
  { name: 'preflight402-probe', kind: 'crawler', re: /\bpreflight402[-_]?probe\b/i },
  { name: '402explorer', kind: 'crawler', re: /\b402explorer\b/i },
  { name: 'coinbase-bazaar-discovery', kind: 'crawler', re: /\bcoinbase.?bazaar.?discovery\b/i },
  { name: 'x402-observer', kind: 'crawler', re: /\bx402[-_]?observer\b/i },
  { name: 'forum-labs-trust-prober', kind: 'crawler', re: /\bforum[-_]?labs[-_]?trust[-_]?prober\b/i },
  { name: 'carbonmonitor', kind: 'crawler', re: /\bcarbonmonitor\b/i },
  { name: 'googlebot', kind: 'crawler', re: /\bgooglebot\b/i },
  { name: 'bingbot', kind: 'crawler', re: /\bbingbot\b/i },
  { name: 'ahrefsbot', kind: 'crawler', re: /\bahrefsbot\b/i },
  { name: 'bytespider', kind: 'crawler', re: /\bbytespider\b/i },
  { name: 'censys', kind: 'crawler', re: /\bcensys\b/i },
  // Generic crawler tokens — the catch-all that keeps the bare-SDK allow honest.
  { name: 'crawler-generic', kind: 'crawler', re: /(\bbot\b|bot\/|[-_]bot\b|spider|crawler|scraper|slurp|\bprober\b|\bprobe\b)/i },

  // ── bare_sdk — programmatic HTTP clients. THE ICP SHAPE. ──
  // Deliberately excludes curl / wget / HTTPie / Postman / Insomnia: those are interactive
  // human probing tools, not agent runtimes, and they stay on the isbot path unchanged.
  { name: 'python-httpx', kind: 'bare_sdk', re: /\b(python-)?httpx\b/i },
  { name: 'python-requests', kind: 'bare_sdk', re: /\bpython-requests\b/i },
  { name: 'aiohttp', kind: 'bare_sdk', re: /\baiohttp\b/i },
  { name: 'urllib', kind: 'bare_sdk', re: /\b(python-)?urllib3?\b/i },
  { name: 'node-fetch', kind: 'bare_sdk', re: /\bnode-fetch\b/i },
  { name: 'undici', kind: 'bare_sdk', re: /\bundici\b/i },
  { name: 'axios', kind: 'bare_sdk', re: /\baxios\b/i },
  { name: 'got', kind: 'bare_sdk', re: /\bgot\s*\(https:\/\/github\.com\/sindresorhus\/got\)/i },
  { name: 'okhttp', kind: 'bare_sdk', re: /\bokhttp\b/i },
  { name: 'go-http-client', kind: 'bare_sdk', re: /\bgo-http-client\b/i },
  { name: 'reqwest', kind: 'bare_sdk', re: /\breqwest\b/i },
  { name: 'apache-httpclient', kind: 'bare_sdk', re: /\bapache-httpclient\b/i },
  { name: 'java', kind: 'bare_sdk', re: /\bjava\/[\d.]/i },
  { name: 'guzzle', kind: 'bare_sdk', re: /\bguzzlehttp\b/i },
  { name: 'faraday', kind: 'bare_sdk', re: /\bfaraday\b/i },
  { name: 'node', kind: 'bare_sdk', re: /^node(\/|$|\s)/i },

  // ── browser — matched LAST: almost every UA above may also carry "Mozilla/5.0". ──
  { name: 'browser', kind: 'browser', re: /\bMozilla\/5\.0\b/i },
]);

export interface ClientIdentity {
  /** Stable slug for `request_log.client_name`. `unknown` (no UA) or `other` (unmatched). */
  name: string;
  kind: ClientKind;
}

/**
 * THE single derivation. Every consumer — the traffic classifier, the analytics writer, the
 * digest SQL — projects from this function or from the name lists generated below.
 *
 * An unmatched UA is `other`/`unknown`, never guessed. That keeps the remainder VISIBLE
 * (same discipline as `call-class.ts`'s `unclassified`) so a new client type surfaces instead
 * of being folded into an existing bucket.
 */
export function classifyClient(ua: string | null | undefined): ClientIdentity {
  const s = (ua ?? '').trim();
  if (!s) return { name: UNKNOWN_CLIENT, kind: 'unknown' };
  for (const spec of CLIENT_REGISTRY) {
    if (spec.re.test(s)) return { name: spec.name, kind: spec.kind };
  }
  return { name: 'other', kind: 'unknown' };
}

/** Truncate a raw UA for storage. Returns null for an absent/empty UA (never the string ''). */
export function normalizeUaForStorage(ua: string | null | undefined): string | null {
  const s = (ua ?? '').trim();
  if (!s) return null;
  return s.length > MAX_UA_LEN ? s.slice(0, MAX_UA_LEN) : s;
}

/** Client names on a given kind — DERIVED, never a parallel hand-kept literal. */
export function clientNamesOfKind(...kinds: readonly ClientKind[]): string[] {
  const want = new Set<ClientKind>(kinds);
  return [...new Set(CLIENT_REGISTRY.filter((s) => want.has(s.kind)).map((s) => s.name))];
}

/**
 * Kinds that represent a REAL client (a human or an autonomous agent acting for one) rather
 * than a crawler/probe. This is the allow-list the traffic classifier un-tags on, and the same
 * set the digest counts as recognized.
 */
export const RECOGNIZED_KINDS: readonly ClientKind[] = ['agent_client', 'bare_sdk', 'browser'];

/** Kinds that are automated by construction. */
export const AUTOMATED_KINDS: readonly ClientKind[] = ['crawler', 'health_check'];
