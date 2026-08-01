/**
 * OPS-ACTIVATION-LEAK-FIX-W1 CH3 (2026-06-29): the canonical traffic classifier.
 *
 * ONE shared pure fn (`classifyTraffic`) is AUTHORITATIVE for "is this funnel
 * connect automated?" (single-derivation LAW — Q3). The result is stamped into
 * `funnel_events.meta_json` at the `mcp_connect` emit (additive — events are
 * TAGGED, never dropped; Data Integrity), and the snapshot computes a cleaned
 * `by_authenticity` denominator from it.
 *
 * Layered DENY-list (never a human allow-list as the PRIMARY mechanism — that
 * would drop real agents). Precedence (architect-ratified Q3; registry layers added
 * by OPS-CLIENT-ATTRIBUTION-W1):
 *   L0  internal-tier (bot loopback / admin bypass)            → automated
 *   --  registry `agent_client` un-tag (the ONE allow-list)    → human (beats L1)
 *   L2  registry `health_check`                                → automated
 *   --  registry `crawler` (named probers + bot/spider tokens) → automated
 *   --  registry `bare_sdk` un-tag  ← NEW                      → human (beats L1)
 *   L1  isbot (206-pattern crawler/bot list; subsumes most     → automated
 *       of crawler-user-agents) + generic HTTP clients
 *   L4  datacenter-IP ∧ generic/empty-UA ∧ no-real-call        → automated
 *       (a connect-only probe from cloud with no human signal; COMBINING only —
 *       NEVER excludes on cloud-IP alone: real agents run in the cloud)
 *   --  default                                                → human
 *
 * The `bare_sdk` un-tag is the ICP fix: isbot flags `python-httpx` / `axios` / `undici` /
 * `node` as crawlers, which is exactly what an autonomous agent looks like, so
 * "🟢 Recognized clients" read 0 across an entire 24h window with 70 distinct sessions
 * (measured 2026-07-31). isbot is NOT disabled — an unknown UA still reaches it; the
 * registry only corrects the known-SDK false positives, and `crawler` is asserted first so
 * widening the allow-list can never un-tag a prober.
 *
 * NOTE the deliberate boundary: `curl` / `wget` / `HTTPie` / `Postman` / `Insomnia` are NOT
 * in `bare_sdk` — they are interactive human probing tools, not agent runtimes, and keep
 * their prior isbot-driven verdict.
 *
 * The KNOWN-AGENT un-tag is REQUIRED: isbot v5 flags `claude-code/…` (pattern
 * `^claude-code/`) and `Cursor/…` (pattern `cursor/`) as bots, but these are
 * REAL MCP clients = real users in the funnel sense (verified empirically
 * 2026-06-29). It runs BEFORE isbot so a wanted agent is un-tagged. (isbot's own
 * `createIsbotFromList(list.filter(…))` is the alternative; an explicit pre-isbot
 * allow-list is chosen for transparency + version-stability — isbot patterns
 * drift across versions, and surgically removing `agent\b` would UNDER-tag real
 * bots.)
 *
 * `is_bot_internal` (request_log column) is a NARROWER INPUT (internal/admin tier
 * only) — it is consumed here as the L0 signal, NOT re-derived. The subset
 * invariant `is_bot_internal===true ⟹ classifyTraffic()=automated` is pinned by a
 * canary in the tests (single-derivation: two bot-derivations must never drift).
 */
import { isbot } from 'isbot';
// OPS-CLIENT-ATTRIBUTION-W1: the ONE User-Agent → client identity map. The KNOWN-AGENT and
// health-check lists that used to live here as local regexes now live THERE, because the same
// UA also has to produce `request_log.client_name` — two homes for one fact is the drift
// CLAUDE.md forbids. This module projects from it; it does not re-derive.
import { classifyClient } from './client-registry.js';

export interface TrafficSignals {
  /** Request User-Agent (raw). null/empty when the client omits it. */
  ua?: string | null;
  /** Raw client IP (NOT the hash — only available at the emit/POST layer). */
  ip?: string | null;
  /**
   * Did the classified unit make a COMPLETED real tool call (a `tools/call` that
   * returns data)? `tools/list` / handshake-only never count. Used by the L4
   * combining path. At the per-connect emit this is "is THIS POST a real call".
   */
  hadRealToolCall?: boolean;
  /** License tier === 'internal' (bot loopback / admin bypass) — the L0 signal. */
  isInternalTier?: boolean;
}

export interface TrafficVerdict {
  is_automated: boolean;
  /** Short machine-readable reason when automated (for by_authenticity / debug); null when human. */
  reason: string | null;
}

/** Injectable deps so the layering logic is unit-testable without isbot's full list / a real IP DB. */
export interface ClassifyDeps {
  isBot?: (ua: string) => boolean;
  isDatacenterIp?: (ip: string) => boolean;
}

/**
 * L3 — generic HTTP-client UAs (SOFT signal; only meaningful in the L4 combination).
 * Most are already caught by isbot L1; this set is the residual + the "empty UA"
 * partner for the combining path.
 */
const GENERIC_CLIENT_RE =
  /(python-requests|python-urllib|urllib|libwww-perl|Apache-HttpClient|okhttp|Go-http-client|node-fetch|axios|undici|Java\/|Jakarta|Wget|curl|libcurl|http\.rb|Faraday|Guzzle|HTTPie|PostmanRuntime|insomnia|reqwest|aiohttp|httpx)/i;

/**
 * Best-effort, NON-EXHAUSTIVE datacenter/cloud IPv4 second-octet prefixes used
 * ONLY as a COMBINING signal (never alone). Conservative by design: a miss leaves
 * traffic labeled human (the safe bias). For a precise verdict this is injectable
 * (`ClassifyDeps.isDatacenterIp`) and a future wave can plug in a real IP-intel
 * provider. `// TODO: revisit by 2026-09-27` (defensive-threshold hygiene).
 * Prefixes chosen as predominantly-datacenter (Hetzner / AWS / GCP / Azure / DO /
 * OVH / Linode / Vultr blocks); residential ISPs largely live elsewhere.
 */
const DATACENTER_V4_PREFIXES: ReadonlySet<string> = new Set([
  // Hetzner (our own host neighborhood + common scrapers)
  '5.75', '5.78', '78.46', '78.47', '88.99', '95.216', '116.202', '128.140',
  '135.181', '138.201', '142.132', '144.76', '148.251', '157.90', '159.69',
  '162.55', '167.235', '168.119', '176.9', '178.63', '188.34', '195.201',
  // AWS
  '3.80', '13.56', '15.220', '18.205', '34.192', '35.153', '52.0', '54.144',
  // GCP
  '34.64', '34.120', '35.184', '35.224',
  // Azure
  '13.64', '20.36', '40.74', '52.224', '104.40',
  // DigitalOcean / Linode / Vultr / OVH
  '104.131', '142.93', '159.65', '165.227', '167.99', '45.33', '45.79',
  '139.144', '45.76', '149.28', '51.79', '51.81', '147.135',
]);

function defaultIsDatacenterIp(ip: string): boolean {
  // IPv4 only; IPv6 → false (conservative). Match on the first two octets.
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(ip.trim());
  if (!m) return false;
  return DATACENTER_V4_PREFIXES.has(`${m[1]}.${m[2]}`);
}

/**
 * Classify a funnel unit (a connect / request) as automated vs human. PURE: same
 * inputs → same output, no I/O. `deps` injectable for tests. The reason string is
 * informative only (the boolean is authoritative).
 */
export function classifyTraffic(signals: TrafficSignals, deps: ClassifyDeps = {}): TrafficVerdict {
  const ua = (signals.ua ?? '').trim();
  const ip = (signals.ip ?? '').trim();
  const isBotFn = deps.isBot ?? isbot;
  const isDatacenterIpFn = deps.isDatacenterIp ?? defaultIsDatacenterIp;

  // L0 — internal-tier (bot loopback / admin bypass). Consumes the SAME signal
  // that sets request_log.is_bot_internal (does not re-derive it).
  if (signals.isInternalTier) return { is_automated: true, reason: 'internal_tier' };

  // Registry-driven layers (OPS-CLIENT-ATTRIBUTION-W1). ONE ordered map decides client
  // identity; the branches below just project its `kind`. Registry order already encodes
  // the precedence this function used to spell out: agent_client beats crawler ("never drop
  // a real agent"), and crawler beats bare_sdk, so a named prober shipping an SDK UA
  // (`CoinbaseBazaarDiscovery/1.0 (axios)`) cannot be laundered by the bare-SDK un-tag.
  const client = ua ? classifyClient(ua) : null;

  // Un-tag escape hatch — known real MCP agents are HUMAN (beats isbot L1). Unchanged
  // behavior, now sourced from the registry.
  if (client?.kind === 'agent_client') return { is_automated: false, reason: null };

  // L2 — explicit health-check / uptime probes.
  if (client?.kind === 'health_check') return { is_automated: true, reason: 'health_check' };

  // Named + generic crawlers — asserted BEFORE the bare-SDK un-tag below, so widening the
  // allow-list can never accidentally un-tag a prober.
  if (client?.kind === 'crawler') return { is_automated: true, reason: 'crawler_bot' };

  // NEW un-tag — a bare programmatic SDK (`python-httpx`, `axios`, `undici`, `node`, the MCP
  // SDK default) is THE ICP shape: an autonomous agent calling from code. isbot flags these as
  // crawlers, which made "🟢 Recognized clients" structurally ~0 — it could never count the
  // target customer. This runs BEFORE isbot so the flag is corrected rather than isbot being
  // disabled; every UA the registry does not know still falls through to isbot unchanged.
  if (client?.kind === 'bare_sdk') return { is_automated: false, reason: null };

  // L1 — isbot (crawler/bot + most generic HTTP clients).
  if (ua && isBotFn(ua)) return { is_automated: true, reason: 'crawler_bot' };

  // L4 — combining only: a connect-only probe from a datacenter IP with a
  // generic/empty UA and no real tool call. NEVER fires on cloud-IP alone.
  //
  // NARROWED by the bare_sdk un-tag above, deliberately and with eyes open: an `axios`/`httpx`
  // connect-only probe from a cloud IP now reads HUMAN, because it is genuinely
  // indistinguishable from a real agent that connected and has not called yet. That is the
  // ratified bias ("a dropped real agent corrupts the funnel; a spoofed human is noise").
  // L4 still covers the EMPTY-UA case and the interactive tools left outside `bare_sdk`.
  const genericOrEmptyUa = ua === '' || GENERIC_CLIENT_RE.test(ua);
  if (genericOrEmptyUa && signals.hadRealToolCall !== true && ip && isDatacenterIpFn(ip)) {
    return { is_automated: true, reason: 'datacenter_no_call_probe' };
  }

  // Default — human.
  return { is_automated: false, reason: null };
}

/** Test/diagnostic seam: the default datacenter heuristic (non-exhaustive). */
export function _defaultIsDatacenterIpForTest(ip: string): boolean {
  return defaultIsDatacenterIp(ip);
}
