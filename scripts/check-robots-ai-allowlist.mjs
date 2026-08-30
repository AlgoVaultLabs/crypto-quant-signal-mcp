#!/usr/bin/env node
/**
 * check-robots-ai-allowlist.mjs — LIVE-EDGE gate over the one machine-readable file that
 * governs whether every AI crawler on earth may ingest AlgoVault content.
 *
 * WHY THIS PROBES THE EDGE AND NOT THE REPO
 * Cloudflare's managed-robots.txt feature PREPENDS its own block — `Content-signal:
 * ai-train=no` plus `Disallow: /` for Amazonbot, Applebot-Extended, Bytespider, CCBot,
 * ClaudeBot, Google-Extended, GPTBot and meta-externalagent — ahead of the origin file.
 * That injection exists in NO committed file, so every repo-file test is structurally
 * blind to it. A dashboard flip, a plan change, or Cloudflare's 2026-09-15 AI-bot-policy
 * default migration would silently end the acquisition channel with no error and no
 * user-visible symptom. This gate is the only thing that would notice.
 *
 * VERDICT TOKEN (the contract — callers gate on the TOKEN, never the bare exit code):
 *   ROBOTS_ALLOWLIST_VERDICT=GREEN | RED | INDETERMINATE
 * EXIT CODES: 0 = GREEN, 1 = RED, 3 = INDETERMINATE.
 * 3 is the token-law default for a NEW gate (this script deploys no prior code for
 * "could not verify"), and it is deliberately NOT aligned to any other script's spread.
 *
 * INDETERMINATE, never GREEN, for: non-2xx, network failure/timeout, empty body, a body
 * that parses to zero user-agent groups, or an allowlist that reads back empty. Input we
 * were handed and could not parse is INDETERMINATE; a fetch failure must never read as
 * "allowlist intact."
 *
 * GEO-AGENT-DISCOVERY-W2 EXTENSION — every W1 assertion is unchanged; these are additions.
 * The gate now covers a SURFACE LIST rather than one host, and a new host joins by adding one
 * array entry to SURFACES below. Four surfaces today, three distinct check kinds:
 *
 *   algovault.com          allowlist resolution (W1) + content-signal VALUE + no blanket
 *                          /.well-known/ disallow + the Content-Signal RESPONSE HEADER
 *                          + llms.txt carries zero /docs/integrations/ redirect hops
 *   api.algovault.com      robots.txt must return 200 (it 404'd before W2)
 *   plausible.algovault.com robots.txt must return 200 — already correct at W2 time, and kept
 *                          under the gate precisely because "already correct" can regress
 *   www.algovault.com      a DISTINCT check kind: 301 -> https://algovault.com/<path>. Deliberately
 *                          NOT a robots.txt resolution, so redirect logic cannot contaminate the
 *                          allowlist logic. www is the 2nd-largest non-2xx path on the zone and its
 *                          largest consumer is Claude-SearchBot; if that 301 ever breaks the traffic
 *                          dies silently, and enumeration beats detection.
 *
 * GEO-WELLKNOWN-DISCOVERY-W1 EXTENSION — every W1 and W2 assertion is unchanged; these are
 * additions. Beyond the surface list the gate now covers the /.well-known/ DOCUMENTS W2's
 * robots.txt narrowing unblocked, each with one reusable shape — exists -> correct media type
 * -> required fields -> freshness:
 *
 *   /.well-known/security.txt      200 + text/plain + Contact + Expires, and Expires must be
 *                                  more than 30 days out. RFC 9116. Freshness is asserted HERE,
 *                                  against the SERVED copy, and deliberately not at build time
 *                                  against the committed one — see generate-wellknown.mjs.
 *   /.well-known/api-catalog       200 + application/linkset+json + parses + item[] non-empty
 *                                  (GET), and a Link header carrying rel="api-catalog" (HEAD,
 *                                  RFC 9727 §2 — a separate obligation from serving the body).
 *   every catalog href             must resolve. This is what makes the document trustworthy
 *                                  rather than decorative. Probe method per href comes from
 *                                  API_CATALOG_ENDPOINTS, because /mcp answers 405 to GET.
 *   apex / headers                 Link AND Content-Signal on the SAME response.
 *   api. catalog URI               301 to the one canonical document (RFC 9727 §5.1).
 *
 * Usage:
 *   node scripts/check-robots-ai-allowlist.mjs   # probe the live edge
 *   npm run check:robots                         # the same, wired
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The catalog's endpoint set + per-item probe method come from the SAME reader that
// EMITS the document. Importing it beats re-implementing the parser here.
import { readEndpointsFromSource } from './generate-wellknown.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const ROBOTS_URL = 'https://algovault.com/robots.txt';
export const ALLOWLIST_SOURCE = join(REPO_ROOT, 'src', 'lib', 'ai-crawler-allowlist.ts');
export const FETCH_TIMEOUT_MS = 15000;

/** The literal Cloudflare stamps at the head of a managed robots.txt. Its presence is RED
 *  on its own: it means the edge now owns this file, whatever the rules under it say. */
export const CF_MANAGED_MARKER = 'BEGIN Cloudflare Managed content';

export const VERDICT_EXIT = Object.freeze({ GREEN: 0, RED: 1, INDETERMINATE: 3 });

/** A blanket disallow of the agent-discovery directory. Its PRESENCE is RED; the narrow
 *  `/.well-known/acme-challenge/` form is fine and must not match. */
export const WELL_KNOWN_BLANKET = '/.well-known/';

export const LLMS_URL = 'https://algovault.com/llms.txt';
/** Redirect hops inside the agent-ingested SoT. Any occurrence is RED. */
export const LLMS_FORBIDDEN_PATH = '/docs/integrations/';

export const APEX_ORIGIN = 'https://algovault.com';

/**
 * The surface list. ONE array entry per host; `kind` selects the check.
 * `robots-200` hosts are asserted reachable, not resolved — they carry no allowlist.
 */
export const SURFACES = Object.freeze([
  { host: 'algovault.com', kind: 'apex' },
  { host: 'api.algovault.com', kind: 'robots-200' },
  { host: 'plausible.algovault.com', kind: 'robots-200' },
  { host: 'www.algovault.com', kind: 'redirect-to-apex', probePath: '/track-record' },
]);

/**
 * Read CONTENT_SIGNAL_VALUE out of the same TypeScript SoT the allowlist comes from, by the
 * same means and for the same reason (host node 20, no build step, no dist). Returns null when
 * the literal cannot be located — the caller turns that into INDETERMINATE, never GREEN.
 */
export function readContentSignalFromSource(tsSource) {
  const m = /export\s+const\s+CONTENT_SIGNAL_VALUE\s*(?::[^=]*)?=\s*['"]([^'"]+)['"]\s*;/.exec(
    String(tsSource ?? ''),
  );
  return m ? m[1] : null;
}

/**
 * Read the allowlist out of its TypeScript SoT. The gate runs on a host with node 20 and
 * no build step, so it can neither import a .ts nor rely on dist/ — but duplicating the
 * list would violate single-derivation, and the duplicate is what silently rots. So: read
 * the ONE array literal, and let tests/unit/robots-ai-allowlist.test.ts assert this
 * reader's output equals the actual imported constant.
 *
 * Returns [] when the literal cannot be located — the caller turns that into
 * INDETERMINATE, never GREEN.
 */
export function readAllowlistFromSource(tsSource) {
  const m = /export\s+const\s+AI_CRAWLER_ALLOWLIST\s*(?::[^=]*)?=\s*\[([\s\S]*?)\]\s*;/.exec(
    String(tsSource ?? ''),
  );
  if (!m) return [];
  const body = m[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...body.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

/**
 * RFC 9309 §2.1 group parser.
 *
 * A group is one or more consecutive `User-agent:` lines followed by its rules. A rule
 * line closes the header, so the next `User-agent:` opens a NEW group. Fields we do not
 * model (`Sitemap`, `Content-signal`, `Crawl-delay`, anything unknown) are IGNORED and
 * neither open nor close a group — which is exactly why our own
 * `User-agent: * / Content-signal: … / Allow: /` sequence still parses as one group, and
 * why Cloudflare's `Content-signal:` line inside its prepended `User-Agent: *` block does
 * not split that block either.
 */
export function parseRobots(body) {
  const groups = [];
  let current = null;
  for (const rawLine of String(body ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) continue; // a rule before any User-agent belongs to no group
      current.rules.push({ type: field, path: value });
    }
    // every other field is ignored by design — see the docblock above
  }
  return groups.filter((g) => g.agents.length > 0);
}

/**
 * RFC 9309 §2.2.2 within ONE group: the longest matching path prefix wins; on a tie
 * Allow wins; an empty `Disallow:` value means "disallow nothing" and never matches.
 */
export function resolveGroup(group, path) {
  let best = null;
  for (const rule of group.rules) {
    if (rule.type === 'disallow' && rule.path === '') continue;
    if (rule.path === '' || !path.startsWith(rule.path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.type === 'allow')
    ) {
      best = rule;
    }
  }
  return best ? (best.type === 'allow' ? 'allowed' : 'disallowed') : 'allowed';
}

/**
 * Effective verdict for one product token.
 *
 * Group selection is exact, case-insensitive, per RFC 9309 §2.2.1, falling back to the
 * `*` group when the agent has none of its own.
 *
 * DELIBERATE, DOCUMENTED DEVIATION: when more than one group matches, RFC 9309 says to
 * MERGE them, which under §2.2.2 tie-breaking would let our later `Allow: /` outrank an
 * injected `Disallow: /` and report "allowed". That is the wrong answer for a GATE. A
 * policy file that both grants and denies the same agent has already lost the channel for
 * every crawler that honours the first or the most restrictive group — which is precisely
 * the state a prepend creates, and precisely what we need to be told about. So: ANY
 * matching group resolving to disallowed makes the agent DISALLOWED. This can never
 * false-fire on our own file, which carries exactly one group per allowlisted agent.
 */
export function resolveForAgent(groups, agent, path = '/') {
  const token = String(agent).toLowerCase();
  let matched = groups.filter((g) => g.agents.includes(token));
  let via = 'exact';
  if (matched.length === 0) {
    matched = groups.filter((g) => g.agents.includes('*'));
    via = matched.length ? 'wildcard' : 'none';
  }
  if (matched.length === 0) return { verdict: 'allowed', via: 'none', matchedGroups: 0 };
  const verdict = matched.some((g) => resolveGroup(g, path) === 'disallowed')
    ? 'disallowed'
    : 'allowed';
  return { verdict, via, matchedGroups: matched.length };
}

/**
 * Pure evaluation over an already-fetched body. Returns the verdict, the per-agent lines
 * (so the gate is never dark), and the machine-readable detail.
 *
 * `allowlist` empty ⇒ INDETERMINATE: the corpus here is one WE construct, so an empty one
 * means the reader failed, not that there is nothing to check.
 */
export function evaluate(body, allowlist) {
  const reasons = [];
  const text = String(body ?? '');
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return {
      verdict: 'INDETERMINATE',
      lines: [],
      disallowed: [],
      reasons: ['allowlist read back EMPTY — cannot verify anything'],
      groupCount: 0,
    };
  }
  if (text.trim() === '') {
    return {
      verdict: 'INDETERMINATE',
      lines: [],
      disallowed: [],
      reasons: ['empty body'],
      groupCount: 0,
    };
  }
  const groups = parseRobots(text);
  if (groups.length === 0) {
    return {
      verdict: 'INDETERMINATE',
      lines: [],
      disallowed: [],
      reasons: ['body parsed to ZERO user-agent groups — unparseable, not clean'],
      groupCount: 0,
    };
  }
  const lines = [];
  const disallowed = [];
  for (const agent of allowlist) {
    const r = resolveForAgent(groups, agent, '/');
    if (r.verdict === 'disallowed') disallowed.push(agent);
    lines.push(
      `${agent}: ${r.verdict === 'disallowed' ? 'DISALLOWED' : 'allowed'}` +
        ` (via ${r.via}, ${r.matchedGroups} group${r.matchedGroups === 1 ? '' : 's'})`,
    );
  }
  if (text.includes(CF_MANAGED_MARKER)) {
    reasons.push(`live file carries the literal "${CF_MANAGED_MARKER}" — the EDGE owns this file`);
  }
  if (disallowed.length > 0) {
    reasons.push(`disallowed on /: ${disallowed.join(', ')}`);
  }
  return {
    verdict: reasons.length > 0 ? 'RED' : 'GREEN',
    lines,
    disallowed,
    reasons,
    groupCount: groups.length,
  };
}

/**
 * W2 apex signal checks over an already-fetched robots.txt body. PURE.
 *
 * Each branch returns a DISTINCT reason string. That is not cosmetic: W1's break-proof showed a
 * verdict-only assertion cannot tell two branches apart when both return the same verdict, so the
 * reason is what makes each of these individually falsifiable — one fixture, one branch.
 *
 * Returns { verdict, lines, reasons }.
 */
export function evaluateApexSignals(body, expectedSignal) {
  const lines = [];
  const reasons = [];
  const text = String(body ?? '');

  if (!expectedSignal) {
    return {
      verdict: 'INDETERMINATE',
      lines: [],
      reasons: ['content-signal SoT read back EMPTY — cannot verify the declared value'],
    };
  }

  // --- content-signal presence AND value ---
  const m = /^[ \t]*content-signal[ \t]*:[ \t]*(.*)$/im.exec(text);
  if (!m) {
    reasons.push('content-signal: LINE ABSENT from the apex robots.txt');
    lines.push('content-signal: MISSING');
  } else {
    const got = m[1].trim();
    if (got !== expectedSignal) {
      reasons.push(`content-signal: VALUE MISMATCH — got "${got}", expected "${expectedSignal}"`);
      lines.push(`content-signal: MISMATCHED ("${got}")`);
    } else {
      lines.push(`content-signal: ok ("${got}")`);
    }
  }

  // --- blanket /.well-known/ disallow ---
  // Matches the blanket form only. `/.well-known/acme-challenge/` has trailing path and must not
  // match, which is the whole point of R2 and is asserted in both directions by the self-test.
  const blanket = new RegExp(
    `^[ \\t]*disallow[ \\t]*:[ \\t]*${WELL_KNOWN_BLANKET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`,
    'im',
  );
  if (blanket.test(text)) {
    reasons.push('well-known: BLANKET `Disallow: /.well-known/` present — agent discovery blocked');
    lines.push('well-known: BLOCKED (blanket disallow)');
  } else {
    lines.push('well-known: open (no blanket disallow)');
  }

  return { verdict: reasons.length ? 'RED' : 'GREEN', lines, reasons };
}

/** W2 response-header check. PURE. `headerValue` is null when the header was absent. */
export function evaluateHeader(headerValue, expectedSignal) {
  if (!expectedSignal) {
    return {
      verdict: 'INDETERMINATE',
      lines: [],
      reasons: ['content-signal SoT read back EMPTY — cannot verify the response header'],
    };
  }
  if (headerValue === null || headerValue === undefined) {
    return {
      verdict: 'RED',
      lines: ['header Content-Signal: MISSING'],
      reasons: ['header: `Content-Signal` ABSENT on the apex response'],
    };
  }
  const got = String(headerValue).trim();
  if (got !== expectedSignal) {
    return {
      verdict: 'RED',
      lines: [`header Content-Signal: MISMATCHED ("${got}")`],
      reasons: [`header: VALUE MISMATCH — got "${got}", expected "${expectedSignal}"`],
    };
  }
  return { verdict: 'GREEN', lines: [`header Content-Signal: ok ("${got}")`], reasons: [] };
}

/** W2 llms.txt hygiene. PURE. An empty body is INDETERMINATE, not a silent pass. */
export function evaluateLlms(body) {
  const text = String(body ?? '');
  if (text.trim() === '') {
    return {
      verdict: 'INDETERMINATE',
      lines: [],
      reasons: ['llms.txt: EMPTY body — could not verify'],
    };
  }
  const n = text.split(LLMS_FORBIDDEN_PATH).length - 1;
  if (n > 0) {
    return {
      verdict: 'RED',
      lines: [`llms.txt: ${n} REDIRECT HOP(S)`],
      reasons: [`llms.txt: ${n} occurrence(s) of ${LLMS_FORBIDDEN_PATH} — the agent-ingested SoT points at 301s`],
    };
  }
  return { verdict: 'GREEN', lines: ['llms.txt: ok (0 redirect hops)'], reasons: [] };
}

/** W2 non-apex robots.txt reachability. PURE. 200 required; anything else RED. */
export function evaluateRobotsReachable(host, status) {
  if (status === 200) {
    return { verdict: 'GREEN', lines: [`${host}/robots.txt: ok (HTTP 200)`], reasons: [] };
  }
  return {
    verdict: 'RED',
    lines: [`${host}/robots.txt: HTTP ${status}`],
    reasons: [`${host}: robots.txt returned HTTP ${status}, expected 200 — no crawl policy served`],
  };
}

/**
 * W2 www redirect check. PURE and DELIBERATELY SEPARATE from the allowlist resolution, so
 * redirect logic can never contaminate it. Accepts any 3xx whose Location lands on the apex
 * origin at the same path — the status family is the contract, not one exact code.
 */
export function evaluateRedirect(host, status, location, probePath) {
  const want = `${APEX_ORIGIN}${probePath}`;
  if (status < 300 || status >= 400) {
    return {
      verdict: 'RED',
      lines: [`${host}${probePath}: HTTP ${status} (not a redirect)`],
      reasons: [`${host}: expected a 3xx to ${want}, got HTTP ${status}`],
    };
  }
  const raw = String(location ?? '').trim();
  // Compare ORIGIN + PATHNAME only. The contract is "lands on the apex at the same path"; a
  // preserved query string is correct redirect behaviour and not part of it. Measured: the gate's
  // own `?cb=` cache-buster survives the 301, so a whole-URL comparison false-REDs on every run —
  // found by this gate's first live invocation, which is why the first run of a new gate is a test.
  let got;
  try {
    const u = new URL(raw, `https://${host}`);
    got = `${u.origin}${u.pathname}`;
  } catch {
    got = raw;
  }
  if (got !== want) {
    return {
      verdict: 'RED',
      lines: [`${host}${probePath}: ${status} -> ${raw || '(no Location)'}`],
      reasons: [`${host}: redirect target is "${got || '(none)'}", expected "${want}"`],
    };
  }
  return { verdict: 'GREEN', lines: [`${host}${probePath}: ok (${status} -> ${want})`], reasons: [] };
}

/* ===========================================================================
 * GEO-WELLKNOWN-DISCOVERY-W1 — the /.well-known/ discovery documents.
 *
 * W2 opened this directory on the argument that agent-discovery documents live in it. These
 * assertions are what keep that argument paid off: a document that 404s, loses its media type,
 * or silently expires is the "decorative pointer" class this arc exists to retire.
 *
 * PER-DOCUMENT SHAPE, reusable: exists -> correct media type -> required fields -> freshness.
 * A future /.well-known/ document joins by one entry with that same shape.
 * =========================================================================== */

export const SECURITY_TXT_URL = `${APEX_ORIGIN}/.well-known/security.txt`;
export const CATALOG_URL = `${APEX_ORIGIN}/.well-known/api-catalog`;
export const API_HOST_CATALOG_URL = 'https://api.algovault.com/.well-known/api-catalog';

/** RFC 9727 §4.2 / RFC 9264 §4.2. Prefix match: the profile parameter follows it. */
export const CATALOG_MEDIA_TYPE_PREFIX = 'application/linkset+json';
/** RFC 9727 §7.2 — the ONLY relation this gate accepts. No invented rel is tolerated. */
export const LINK_REL_API_CATALOG = 'api-catalog';

/**
 * The alarm must fire while there is still time to act, not once the file has lapsed.
 * 30 days against a 180-day issuance leaves two full renewal windows.
 */
export const EXPIRES_MIN_DAYS = 30;

/**
 * RFC 9116 security.txt. PURE.
 *
 * Freshness ladder, and the asymmetry is deliberate:
 *   Expires ABSENT        -> RED. A required field we were told to publish is simply missing.
 *   Expires UNPARSEABLE   -> INDETERMINATE. We were HANDED a value and could not read it; that
 *                            is the canonical could-not-verify case, never a regression claim.
 *   Expires in the PAST   -> RED. Worse than no file: it advertises a contact channel while
 *                            signalling the file is unmaintained.
 *   Expires < 30d out     -> RED, for the reason above — an alarm that fires after the lapse
 *                            has no action left to recommend.
 */
export function evaluateSecurityTxt(status, contentType, body, now) {
  const label = '/.well-known/security.txt';
  if (status !== 200) {
    return {
      verdict: 'RED',
      lines: [`${label}: HTTP ${status}`],
      reasons: [`${label}: returned HTTP ${status}, expected 200 — the document is not published`],
    };
  }
  if (!String(contentType ?? '').toLowerCase().startsWith('text/plain')) {
    return {
      verdict: 'RED',
      lines: [`${label}: content-type "${contentType ?? '(none)'}"`],
      reasons: [`${label}: content-type must start "text/plain", got "${contentType ?? '(none)'}"`],
    };
  }
  const text = String(body ?? '');
  if (!/^Contact:\s*\S+/m.test(text)) {
    return {
      verdict: 'RED',
      lines: [`${label}: no Contact field`],
      reasons: [`${label}: RFC 9116 requires a Contact field; none present`],
    };
  }
  const m = text.match(/^Expires:\s*(\S+)\s*$/m);
  if (!m) {
    return {
      verdict: 'RED',
      lines: [`${label}: no Expires field`],
      reasons: [`${label}: RFC 9116 requires an Expires field; none present`],
    };
  }
  const parsed = Date.parse(m[1]);
  if (Number.isNaN(parsed)) {
    return {
      verdict: 'INDETERMINATE',
      lines: [`${label}: Expires unparseable ("${m[1]}")`],
      reasons: [`${label}: Expires value "${m[1]}" could not be parsed as a date`],
    };
  }
  const daysLeft = Math.floor((parsed - now) / 86400000);
  if (daysLeft < 0) {
    return {
      verdict: 'RED',
      lines: [`${label}: EXPIRED ${Math.abs(daysLeft)}d ago (${m[1]})`],
      reasons: [`${label}: Expires ${m[1]} has already passed — the contact channel reads as unmaintained`],
    };
  }
  if (daysLeft < EXPIRES_MIN_DAYS) {
    return {
      verdict: 'RED',
      lines: [`${label}: expires in ${daysLeft}d (${m[1]})`],
      reasons: [`${label}: Expires ${m[1]} is ${daysLeft}d out, under the ${EXPIRES_MIN_DAYS}d renewal margin`],
    };
  }
  return {
    verdict: 'GREEN',
    lines: [`${label}: ok (HTTP 200, text/plain, Contact + Expires, ${daysLeft}d left)`],
    reasons: [],
  };
}

/**
 * RFC 9727 api-catalog document. PURE.
 *
 * Media type is checked BEFORE the body, because Caddy 2.6.2's file_server emits NO
 * Content-Type at all for an extensionless file (measured 2026-08-30 on this host, GET and
 * HEAD alike). The type therefore comes solely from a Caddyfile header directive — a
 * load-bearing line a future Caddyfile edit could silently drop, which is exactly what this
 * assertion is here to catch.
 */
export function evaluateCatalogDocument(status, contentType, body) {
  const label = '/.well-known/api-catalog';
  if (status !== 200) {
    return {
      verdict: 'RED',
      lines: [`${label}: HTTP ${status}`],
      reasons: [`${label}: returned HTTP ${status}, expected 200 — the catalog is not published`],
    };
  }
  const ct = String(contentType ?? '').toLowerCase();
  if (!ct.startsWith(CATALOG_MEDIA_TYPE_PREFIX)) {
    return {
      verdict: 'RED',
      lines: [`${label}: content-type "${contentType ?? '(none)'}"`],
      reasons: [
        `${label}: content-type must start "${CATALOG_MEDIA_TYPE_PREFIX}" per RFC 9727 §4.2, got "${contentType ?? '(none)'}"`,
      ],
    };
  }
  let doc;
  try {
    doc = JSON.parse(String(body ?? ''));
  } catch (err) {
    return {
      verdict: 'RED',
      lines: [`${label}: body is not valid JSON`],
      reasons: [`${label}: body did not parse as JSON (${err?.message ?? err})`],
    };
  }
  const ctx = Array.isArray(doc?.linkset) ? doc.linkset[0] : undefined;
  if (!ctx) {
    return {
      verdict: 'RED',
      lines: [`${label}: linkset[0] absent`],
      reasons: [`${label}: body parsed but carries no linkset[0] context object`],
    };
  }
  const items = Array.isArray(ctx.item) ? ctx.item : [];
  if (items.length === 0) {
    return {
      verdict: 'RED',
      lines: [`${label}: linkset[0].item is empty`],
      reasons: [`${label}: linkset[0].item is absent or empty — a catalog naming no API is decorative`],
    };
  }
  const hrefs = [];
  for (const rel of ['item', 'service-doc']) {
    for (const link of Array.isArray(ctx[rel]) ? ctx[rel] : []) {
      if (link?.href) hrefs.push({ href: link.href, rel });
    }
  }
  return {
    verdict: 'GREEN',
    lines: [`${label}: ok (HTTP 200, ${CATALOG_MEDIA_TYPE_PREFIX}, ${items.length} item(s))`],
    reasons: [],
    hrefs,
  };
}

/**
 * RFC 9727 §2 — a HEAD on the well-known URI SHALL return a Link header carrying the
 * `api-catalog` relation. A separate, easily-missed obligation from serving the body, so it
 * gets its own assertion rather than riding on the GET. PURE.
 */
export function evaluateCatalogHeadLink(linkHeader) {
  const label = 'HEAD /.well-known/api-catalog';
  const raw = String(linkHeader ?? '');
  if (!raw) {
    return {
      verdict: 'RED',
      lines: [`${label}: no Link header`],
      reasons: [`${label}: RFC 9727 §2 requires a Link header with the api-catalog relation; none present`],
    };
  }
  if (!hasRelApiCatalog(raw)) {
    return {
      verdict: 'RED',
      lines: [`${label}: Link "${raw}" lacks rel="${LINK_REL_API_CATALOG}"`],
      reasons: [`${label}: Link header present but carries no ${LINK_REL_API_CATALOG} relation`],
    };
  }
  return { verdict: 'GREEN', lines: [`${label}: ok (Link carries rel="${LINK_REL_API_CATALOG}")`], reasons: [] };
}

/** RFC 8288 rel matching: quoted or bare, case-insensitive, whitespace-tolerant. PURE. */
export function hasRelApiCatalog(linkHeader) {
  return new RegExp(`rel\\s*=\\s*"?[^"]*\\b${LINK_REL_API_CATALOG}\\b`, 'i').test(String(linkHeader ?? ''));
}

/**
 * R4.5 — the apex root must carry BOTH headers on the SAME response. Asserted together and
 * never either-alone: a Caddyfile edit that adds one while displacing the other is precisely
 * the regression a two-separate-checks design would report as half-green.
 * PURE.
 */
export function evaluateApexLinkAndSignal(linkHeader, signalHeader, expectedSignal) {
  const label = 'algovault.com/ headers';
  const link = String(linkHeader ?? '');
  const signal = String(signalHeader ?? '');
  if (!link) {
    return {
      verdict: 'RED',
      lines: [`${label}: no Link header`],
      reasons: [`${label}: apex root carries no Link header; the api-catalog relation is unadvertised`],
    };
  }
  if (!hasRelApiCatalog(link)) {
    return {
      verdict: 'RED',
      lines: [`${label}: Link "${link}" lacks rel="${LINK_REL_API_CATALOG}"`],
      reasons: [`${label}: apex Link header carries no ${LINK_REL_API_CATALOG} relation`],
    };
  }
  if (!signal) {
    return {
      verdict: 'RED',
      lines: [`${label}: Link ok but Content-Signal absent`],
      reasons: [`${label}: Link header displaced the W2 Content-Signal header — both must be present`],
    };
  }
  if (expectedSignal && signal.trim() !== String(expectedSignal).trim()) {
    return {
      verdict: 'RED',
      lines: [`${label}: Content-Signal "${signal}"`],
      reasons: [`${label}: Content-Signal is "${signal}", expected "${expectedSignal}"`],
    };
  }
  return { verdict: 'GREEN', lines: [`${label}: ok (Link + Content-Signal both present)`], reasons: [] };
}

/**
 * R4.6 / RFC 9727 §5.1 — the API domain publishes the well-known URI and redirects to the ONE
 * canonical document. 301 specifically: §5.1 wants a permanent choice of canonical, and a 302
 * would say the choice is temporary. PURE.
 */
export function evaluateCatalogRedirect(status, location) {
  const label = 'api.algovault.com/.well-known/api-catalog';
  if (status !== 301) {
    return {
      verdict: 'RED',
      lines: [`${label}: HTTP ${status}`],
      reasons: [`${label}: expected a 301 to ${CATALOG_URL}, got HTTP ${status}`],
    };
  }
  const raw = String(location ?? '').trim();
  let got = raw;
  try {
    const u = new URL(raw, 'https://api.algovault.com');
    got = `${u.origin}${u.pathname}`;
  } catch { /* keep raw; the comparison below reports it */ }
  if (got !== CATALOG_URL) {
    return {
      verdict: 'RED',
      lines: [`${label}: 301 -> ${raw || '(no Location)'}`],
      reasons: [`${label}: redirect target is "${got || '(none)'}", expected "${CATALOG_URL}"`],
    };
  }
  return { verdict: 'GREEN', lines: [`${label}: ok (301 -> ${CATALOG_URL})`], reasons: [] };
}

/**
 * R4.3, GET kind — a catalog href must actually resolve. A catalog pointing at a dead endpoint
 * is the defect this arc exists to prevent, so this is RED and not a warning. PURE.
 */
export function evaluateCatalogHref(href, status) {
  if (status === 200) {
    return { verdict: 'GREEN', lines: [`  href ${href}: ok (HTTP 200)`], reasons: [] };
  }
  return {
    verdict: 'RED',
    lines: [`  href ${href}: HTTP ${status}`],
    reasons: [`catalog href ${href} returned HTTP ${status}, expected 200 — the catalog names a dead endpoint`],
  };
}

/**
 * Pull the JSON payload out of an SSE frame. Returns null when there is no `data:` line.
 *
 * MEASURED 2026-08-30: a healthy `POST /mcp` answers 200 with `content-type: text/event-stream`
 * and a body of `event: message\ndata: {...}`. A gate doing JSON.parse(body) therefore fails on
 * a HEALTHY server — the seam that makes this parser worth extracting and testing.
 * PURE.
 */
export function parseSseData(body) {
  for (const line of String(body ?? '').split('\n')) {
    if (line.startsWith('data:')) return line.slice(5).trim();
  }
  return null;
}

/**
 * R4.3, mcp-initialize kind. PURE.
 *
 * `https://api.algovault.com/mcp` answers 405 to GET and HEAD, so its liveness is proven the way
 * the endpoint is actually used. A 200 carrying a JSON-RPC `error` is NOT alive for our purposes:
 * that is precisely the decorative-pointer case, wearing a success status code.
 *
 * GUARDRAIL: the caller sends `initialize` and nothing else. This gate runs daily against
 * production and must never call a billable tool — doing so would consume quota and write a
 * signal, making the canary a producer of the data it watches.
 */
export function evaluateMcpProbe(href, status, body) {
  if (status !== 200) {
    return {
      verdict: 'RED',
      lines: [`  href ${href}: initialize -> HTTP ${status}`],
      reasons: [`catalog href ${href} answered HTTP ${status} to a JSON-RPC initialize, expected 200`],
    };
  }
  const payload = parseSseData(body) ?? String(body ?? '').trim();
  if (!payload) {
    return {
      verdict: 'INDETERMINATE',
      lines: [`  href ${href}: initialize -> 200, empty body`],
      reasons: [`catalog href ${href} returned 200 with no readable payload — could not verify liveness`],
    };
  }
  let rpc;
  try {
    rpc = JSON.parse(payload);
  } catch (err) {
    return {
      verdict: 'INDETERMINATE',
      lines: [`  href ${href}: initialize -> 200, unparseable payload`],
      reasons: [`catalog href ${href} returned a payload that did not parse as JSON (${err?.message ?? err})`],
    };
  }
  if (rpc?.error) {
    return {
      verdict: 'RED',
      lines: [`  href ${href}: initialize -> JSON-RPC error ${rpc.error.code ?? '?'}`],
      reasons: [
        `catalog href ${href} answered 200 but the JSON-RPC envelope carries error "${rpc.error.message ?? rpc.error.code}"`,
      ],
    };
  }
  if (!rpc?.result) {
    return {
      verdict: 'RED',
      lines: [`  href ${href}: initialize -> no result member`],
      reasons: [`catalog href ${href} answered 200 but the JSON-RPC envelope carries neither result nor error`],
    };
  }
  const v = rpc.result?.serverInfo?.version;
  return {
    verdict: 'GREEN',
    lines: [`  href ${href}: ok (initialize -> result${v ? `, server v${v}` : ''})`],
    reasons: [],
  };
}

/**
 * Fold every surface's result into ONE verdict.
 *
 * RED dominates INDETERMINATE on purpose: if one check definitively found a regression while
 * another could not be verified, the actionable truth is that a regression exists. INDETERMINATE
 * dominates GREEN for the reason the token law gives — could-not-verify is never a pass.
 */
export function combineVerdicts(results) {
  const all = results.filter(Boolean);
  if (all.length === 0) {
    return { verdict: 'INDETERMINATE', lines: [], reasons: ['no surface produced a result'] };
  }
  const lines = all.flatMap((r) => r.lines ?? []);
  const reasons = all.flatMap((r) => r.reasons ?? []);
  const verdict = all.some((r) => r.verdict === 'RED')
    ? 'RED'
    : all.some((r) => r.verdict === 'INDETERMINATE')
      ? 'INDETERMINATE'
      : 'GREEN';
  return { verdict, lines, reasons };
}

/** Cache-buster, not a ref form: a CDN edge in front of this file would otherwise let a
 *  stale-but-clean body answer a verification read. */
export function buildFetchUrl(now) {
  return `${ROBOTS_URL}?cb=${now}`;
}

async function fetchLive(url, { redirect = 'follow', method = 'GET', headers = {}, body } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect,
      method,
      body,
      headers: {
        'cache-control': 'no-cache',
        'user-agent': 'algovault-robots-allowlist-gate/3',
        ...headers,
      },
    });
    // W2: a non-2xx is NOT automatically a transport failure any more — evaluateRobotsReachable
    // and evaluateRedirect need the STATUS to decide. So this returns ok:true with the status and
    // lets the caller judge; only a real transport failure is ok:false (⇒ INDETERMINATE).
    return {
      ok: true,
      status: res.status,
      body: await res.text().catch(() => ''),
      headers: res.headers,
    };
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${err?.name ?? 'Error'}: ${err?.message ?? err}` };
  } finally {
    clearTimeout(t);
  }
}

function emit(result, extraLines = []) {
  for (const l of extraLines) console.log(l);
  for (const l of result.lines) console.log(`  ${l}`);
  for (const r of result.reasons) console.log(`REASON: ${r}`);
  console.log(`ROBOTS_ALLOWLIST_VERDICT=${result.verdict}`);
  return VERDICT_EXIT[result.verdict];
}

/** INDETERMINATE result for a transport failure on any surface. */
function transportIndeterminate(label, reason) {
  return { verdict: 'INDETERMINATE', lines: [`${label}: UNREACHABLE`], reasons: [`${label}: ${reason}`] };
}

async function checkApex(allowlist, expectedSignal, out) {
  const results = [];
  const url = buildFetchUrl(Date.now());
  const r = await fetchLive(url);
  if (!r.ok) {
    out.push(`GET ${url}`);
    return [transportIndeterminate('algovault.com/robots.txt', r.reason)];
  }
  if (r.status < 200 || r.status >= 300) {
    out.push(`GET ${url} -> HTTP ${r.status}`);
    return [transportIndeterminate('algovault.com/robots.txt', `non-2xx: HTTP ${r.status}`)];
  }
  // W1's allowlist resolution, unchanged.
  const w1 = evaluate(r.body, allowlist);
  out.push(
    `GET ${url} -> HTTP ${r.status}, ${r.body.length} B, ${w1.groupCount ?? 0} user-agent group(s)`,
  );
  out.push(`checking ${allowlist.length} allowlisted agent(s) for path /:`);
  results.push(w1);
  // W2 signal checks over the same body.
  results.push(evaluateApexSignals(r.body, expectedSignal));

  // W2 response header on the apex ROOT (not robots.txt) — the resource-level policy surface.
  const hUrl = `${APEX_ORIGIN}/?cb=${Date.now()}`;
  const h = await fetchLive(hUrl);
  if (!h.ok) {
    results.push(transportIndeterminate('algovault.com header', h.reason));
  } else if (h.status < 200 || h.status >= 300) {
    results.push(transportIndeterminate('algovault.com header', `non-2xx: HTTP ${h.status}`));
  } else {
    results.push(evaluateHeader(h.headers.get('content-signal'), expectedSignal));
    // W1 R4.5 — BOTH headers on the SAME response, never either alone. A Caddyfile edit that
    // adds Link while displacing Content-Signal is exactly the regression two independent
    // checks would report as half-green.
    results.push(
      evaluateApexLinkAndSignal(h.headers.get('link'), h.headers.get('content-signal'), expectedSignal),
    );
  }

  // W2 llms.txt hygiene.
  const lUrl = `${LLMS_URL}?cb=${Date.now()}`;
  const l = await fetchLive(lUrl);
  if (!l.ok) {
    results.push(transportIndeterminate('llms.txt', l.reason));
  } else if (l.status < 200 || l.status >= 300) {
    results.push(transportIndeterminate('llms.txt', `non-2xx: HTTP ${l.status}`));
  } else {
    results.push(evaluateLlms(l.body));
  }
  return results;
}

/**
 * GEO-WELLKNOWN-DISCOVERY-W1 — probe the /.well-known/ documents.
 *
 * The href set comes from `readEndpointsFromSource` in generate-wellknown.mjs, which is the SAME
 * reader that EMITS the catalog. One parser, so the published document and the probed set cannot
 * describe different things — a second implementation of that question would drift, and the bug
 * would land in whichever copy nobody is watching.
 */
async function checkWellKnownDocuments(out) {
  const results = [];
  out.push('checking /.well-known/ discovery documents:');

  // --- security.txt: exists -> media type -> required fields -> freshness -------------------
  const sUrl = `${SECURITY_TXT_URL}?cb=${Date.now()}`;
  const s = await fetchLive(sUrl);
  if (!s.ok) {
    results.push(transportIndeterminate('/.well-known/security.txt', s.reason));
  } else {
    results.push(evaluateSecurityTxt(s.status, s.headers.get('content-type'), s.body, Date.now()));
  }

  // --- api-catalog GET: exists -> media type -> parses -> item non-empty --------------------
  const cUrl = `${CATALOG_URL}?cb=${Date.now()}`;
  const c = await fetchLive(cUrl);
  let hrefs = [];
  if (!c.ok) {
    results.push(transportIndeterminate('/.well-known/api-catalog', c.reason));
  } else {
    const doc = evaluateCatalogDocument(c.status, c.headers.get('content-type'), c.body);
    results.push(doc);
    hrefs = doc.hrefs ?? [];
  }

  // --- api-catalog HEAD: RFC 9727 §2 Link obligation, asserted separately from the GET ------
  const hUrl = `${CATALOG_URL}?cb=${Date.now()}`;
  const h = await fetchLive(hUrl, { method: 'HEAD' });
  if (!h.ok) {
    results.push(transportIndeterminate('HEAD /.well-known/api-catalog', h.reason));
  } else if (h.status !== 200) {
    results.push(transportIndeterminate('HEAD /.well-known/api-catalog', `non-200: HTTP ${h.status}`));
  } else {
    results.push(evaluateCatalogHeadLink(h.headers.get('link')));
  }

  // --- every href resolves. THIS is what makes the catalog trustworthy rather than decorative.
  // Probe method comes from the SoT, never from the served document: a conformance document
  // must not carry our gate's config (RFC 9264 object members are link relation types).
  if (hrefs.length === 0) {
    // Only reachable when the catalog itself already failed above, which has produced its own
    // RED. Reported positively so a zero-href run can never read as a silent pass.
    out.push('  href liveness: skipped — the catalog produced no hrefs to probe');
  } else {
    let methods = new Map();
    try {
      const src = readFileSync(ALLOWLIST_SOURCE, 'utf8');
      methods = new Map(readEndpointsFromSource(src).map((e) => [e.href, e.probe]));
    } catch {
      // Fall through with an empty map: every href then takes the GET path, which is the
      // conservative default — it can only make a POST-only endpoint read RED, never green.
    }
    out.push(`  href liveness: ${hrefs.length} href(s) from the live catalog`);
    for (const { href } of hrefs) {
      if (methods.get(href) === 'mcp-initialize') {
        const r = await fetchLive(href, {
          method: 'POST',
          // The 200 is SSE-framed; without BOTH accept types the server answers 406 by contract.
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          // `initialize` ONLY — never a billable tool. See evaluateMcpProbe's guardrail note.
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'algovault-wellknown-gate', version: '1' },
            },
          }),
        });
        results.push(
          r.ok
            ? evaluateMcpProbe(href, r.status, r.body)
            : transportIndeterminate(`catalog href ${href}`, r.reason),
        );
      } else {
        const r = await fetchLive(`${href}${href.includes('?') ? '&' : '?'}cb=${Date.now()}`);
        results.push(
          r.ok ? evaluateCatalogHref(href, r.status) : transportIndeterminate(`catalog href ${href}`, r.reason),
        );
      }
    }
  }

  // --- the API domain 301s to the ONE canonical document (RFC 9727 §5.1) -------------------
  const rUrl = `${API_HOST_CATALOG_URL}?cb=${Date.now()}`;
  const r = await fetchLive(rUrl, { redirect: 'manual' });
  if (!r.ok) {
    results.push(transportIndeterminate('api.algovault.com/.well-known/api-catalog', r.reason));
  } else {
    results.push(evaluateCatalogRedirect(r.status, r.headers.get('location')));
  }

  return results;
}

async function checkSurface(surface, allowlist, expectedSignal, out) {
  if (surface.kind === 'apex') return checkApex(allowlist, expectedSignal, out);

  if (surface.kind === 'robots-200') {
    const url = `https://${surface.host}/robots.txt?cb=${Date.now()}`;
    const r = await fetchLive(url);
    // A TIMEOUT / transport failure is INDETERMINATE; a reachable non-200 is RED. Distinct
    // branches on purpose — "could not ask" and "asked and got the wrong answer" are not the
    // same fact, and only the second is a regression.
    if (!r.ok) return [transportIndeterminate(`${surface.host}/robots.txt`, r.reason)];
    return [evaluateRobotsReachable(surface.host, r.status)];
  }

  if (surface.kind === 'redirect-to-apex') {
    const path = surface.probePath ?? '/';
    const url = `https://${surface.host}${path}?cb=${Date.now()}`;
    const r = await fetchLive(url, { redirect: 'manual' });
    if (!r.ok) return [transportIndeterminate(`${surface.host}${path}`, r.reason)];
    return [evaluateRedirect(surface.host, r.status, r.headers.get('location'), path)];
  }

  return [transportIndeterminate(surface.host, `unknown surface kind "${surface.kind}"`)];
}

async function main() {
  let allowlist = [];
  let expectedSignal = null;
  try {
    const src = readFileSync(ALLOWLIST_SOURCE, 'utf8');
    allowlist = readAllowlistFromSource(src);
    expectedSignal = readContentSignalFromSource(src);
  } catch (err) {
    return emit({
      verdict: 'INDETERMINATE',
      lines: [],
      reasons: [`cannot read allowlist SoT ${ALLOWLIST_SOURCE}: ${err?.message ?? err}`],
    });
  }

  const out = [`checking ${SURFACES.length} surface(s): ${SURFACES.map((s) => s.host).join(', ')}`];
  const results = [];
  for (const surface of SURFACES) {
    results.push(...(await checkSurface(surface, allowlist, expectedSignal, out)));
  }
  results.push(...(await checkWellKnownDocuments(out)));
  return emit(combineVerdicts(results), out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
