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

/** Cache-buster, not a ref form: a CDN edge in front of this file would otherwise let a
 *  stale-but-clean body answer a verification read. */
export function buildFetchUrl(now) {
  return `${ROBOTS_URL}?cb=${now}`;
}

async function fetchLive(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'cache-control': 'no-cache', 'user-agent': 'algovault-robots-allowlist-gate/1' },
    });
    if (!res.ok) return { ok: false, reason: `non-2xx: HTTP ${res.status}` };
    return { ok: true, body: await res.text(), status: res.status };
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

async function main() {
  let allowlist = [];
  try {
    allowlist = readAllowlistFromSource(readFileSync(ALLOWLIST_SOURCE, 'utf8'));
  } catch (err) {
    return emit(
      {
        verdict: 'INDETERMINATE',
        lines: [],
        disallowed: [],
        reasons: [`cannot read allowlist SoT ${ALLOWLIST_SOURCE}: ${err?.message ?? err}`],
      },
      [],
    );
  }
  const url = buildFetchUrl(Date.now());
  const fetched = await fetchLive(url);
  if (!fetched.ok) {
    return emit(
      { verdict: 'INDETERMINATE', lines: [], disallowed: [], reasons: [fetched.reason] },
      [`GET ${url}`],
    );
  }
  const result = evaluate(fetched.body, allowlist);
  return emit(result, [
    `GET ${url} -> HTTP ${fetched.status}, ${fetched.body.length} B, ` +
      `${result.groupCount} user-agent group(s)`,
    `checking ${allowlist.length} allowlisted agent(s) for path /:`,
  ]);
}

// Two-way self-test lives in tests/unit/robots-ai-allowlist.test.ts (vitest), which drives
// the pure functions above directly — no network, no seam this file has to grow.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
