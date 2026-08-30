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
 * Usage:
 *   node scripts/check-robots-ai-allowlist.mjs   # probe the live edge
 *   npm run check:robots                         # the same, wired
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

async function fetchLive(url, { redirect = 'follow' } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect,
      headers: { 'cache-control': 'no-cache', 'user-agent': 'algovault-robots-allowlist-gate/2' },
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
  return emit(combineVerdicts(results), out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
