/**
 * GEO-MEASUREMENT-W2 (C3) — demand-mining for the GEO query set. Two PII-safe
 * halves; neither reads, derives, or stores the source text of any user input.
 *
 *  1. weightQueriesByPlatformDemand() — fingerprint each canonical SoT query with
 *     the SAME hash as chat-analytics (shared ./question-hash.js), match against
 *     `chat_analytics_events.question_hash` frequency, emit a demand_weight per
 *     query. High-frequency hashes that match no SoT query are surfaced (hash +
 *     hits only) for human review — the text is never stored (PII firewall).
 *
 *  2. minePublicQuestions() — pull candidate questions from public dev forums
 *     (HN Algolia + StackExchange; Reddit = MANUAL_PENDING), cluster by topic,
 *     and write a review artifact. PROPOSED, never auto-injected into the SoT
 *     yaml (human/Code curates) — preserves SoT-locked discipline.
 *
 * Monthly cron, off the :00 boundary (snapshot-sampler rule), e.g.:
 *   17 9 1 * * docker exec crypto-quant-signal-mcp-mcp-server-1 \
 *     node dist/scripts/geo-demand-mining.js >> /var/log/geo-demand-mining.log 2>&1
 */
import * as yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashQuestion } from '../lib/question-hash.js';
import { dbQuery } from '../lib/performance-db.js';

export interface SoTQuery {
  id: string;
  text: string;
  tier: string;
}

export interface DemandWeight {
  query_id: string;
  tier: string;
  question_hash: string;
  demand_weight: number;
  matched_hits: number;
}

export interface UnmatchedHash {
  question_hash: string;
  hits: number;
  note: string;
}

export interface MinedCandidate {
  source: 'hn' | 'stackoverflow';
  topic: string;
  title: string;
  url: string;
  score: number;
}

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const STACKEXCHANGE_SEARCH_URL = 'https://api.stackexchange.com/2.3/search/advanced';

/** Topic keywords seeding the public-forum mine (AlgoVault's ICP surface). */
export const TOPIC_KEYWORDS = [
  'crypto trading agent',
  'MCP crypto signals',
  'perp funding arbitrage',
  'AI agent trade signals',
  'crypto backtesting python',
  'market regime detection',
];

/** Resolve + parse the canonical SoT yaml into {id,text,tier}. tier absent => 'niche'. */
export function loadSoTQueries(yamlPath?: string): SoTQuery[] {
  const resolved =
    yamlPath ?? path.resolve(__dirname, '..', '..', 'landing', 'Prompt', 'geo-queries.yaml');
  const raw = yaml.load(fs.readFileSync(resolved, 'utf-8')) as {
    queries?: Array<{ id: string; text: string; tier?: string }>;
  };
  if (!raw || !Array.isArray(raw.queries)) {
    throw new Error(`geo-queries.yaml at ${resolved} missing 'queries' array`);
  }
  return raw.queries.map((q) => ({ id: q.id, text: q.text, tier: q.tier ?? 'niche' }));
}

/**
 * PII-safe weighting. Reads ONLY `question_hash` + frequency from
 * chat_analytics_events; matches each SoT query's hash; returns per-query
 * demand_weight + the top unmatched high-frequency hashes (for human review).
 */
export async function weightQueriesByPlatformDemand(opts?: {
  yamlPath?: string;
  minUnmatchedHits?: number;
  topUnmatched?: number;
}): Promise<{ weights: DemandWeight[]; unmatched: UnmatchedHash[] }> {
  const queries = loadSoTQueries(opts?.yamlPath);
  const minHits = opts?.minUnmatchedHits ?? 2;
  const topUnmatched = opts?.topUnmatched ?? 20;

  let rows: Array<{ question_hash: string; hits: string | number }> = [];
  try {
    rows = await dbQuery<{ question_hash: string; hits: string | number }>(
      `SELECT question_hash, count(*) AS hits
         FROM chat_analytics_events
        GROUP BY question_hash`,
      [],
    );
  } catch (err) {
    // Graceful degradation: analytics unavailable -> zero weights, no crash.
    console.error(
      `[geo-demand-mining] platform-demand read failed (continuing with 0 weights): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const hitsByHash = new Map<string, number>();
  for (const r of rows) hitsByHash.set(r.question_hash, Number(r.hits) || 0);

  const sotHashes = new Set<string>();
  const weights: DemandWeight[] = queries.map((q) => {
    const h = hashQuestion(q.text);
    sotHashes.add(h);
    const hits = hitsByHash.get(h) ?? 0;
    return { query_id: q.id, tier: q.tier, question_hash: h, demand_weight: hits, matched_hits: hits };
  });

  const unmatched: UnmatchedHash[] = [...hitsByHash.entries()]
    .filter(([h, hits]) => !sotHashes.has(h) && hits >= minHits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topUnmatched)
    .map(([question_hash, hits]) => ({
      question_hash,
      hits,
      note: 'source text not stored (PII) — review the hash frequency only',
    }));

  return { weights, unmatched };
}

/** Pure: HN Algolia search payload -> candidates. */
export function parseHnResponse(json: unknown, topic: string): MinedCandidate[] {
  const hits = (json as { hits?: Array<Record<string, unknown>> })?.hits ?? [];
  const out: MinedCandidate[] = [];
  for (const h of hits) {
    const title = typeof h.title === 'string' ? h.title : '';
    if (!title) continue;
    const url =
      typeof h.url === 'string' && h.url
        ? h.url
        : `https://news.ycombinator.com/item?id=${String(h.objectID ?? '')}`;
    out.push({ source: 'hn', topic, title, url, score: Number(h.points) || 0 });
  }
  return out;
}

/** Pure: StackExchange advanced-search payload -> candidates. */
export function parseStackExchangeResponse(json: unknown, topic: string): MinedCandidate[] {
  const items = (json as { items?: Array<Record<string, unknown>> })?.items ?? [];
  const out: MinedCandidate[] = [];
  for (const it of items) {
    const title = typeof it.title === 'string' ? it.title : '';
    if (!title) continue;
    const url = typeof it.link === 'string' ? it.link : '';
    out.push({ source: 'stackoverflow', topic, title, url, score: Number(it.score) || 0 });
  }
  return out;
}

/** Cluster by topic, dedup by url, sort by score desc within each topic. */
export function clusterCandidates(candidates: MinedCandidate[]): Record<string, MinedCandidate[]> {
  const byTopic: Record<string, MinedCandidate[]> = {};
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.topic}|${c.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (byTopic[c.topic] ??= []).push(c);
  }
  for (const topic of Object.keys(byTopic)) byTopic[topic].sort((a, b) => b.score - a.score);
  return byTopic;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Mine public dev forums for candidate questions. Best-effort: a source being
 * down logs + continues. Reddit = MANUAL_PENDING (OAuth + spam-sensitivity).
 * PROPOSED candidates only — never auto-injected into the SoT yaml.
 */
export async function minePublicQuestions(opts?: {
  keywords?: string[];
  hitsPerKeyword?: number;
}): Promise<MinedCandidate[]> {
  const keywords = opts?.keywords ?? TOPIC_KEYWORDS;
  const per = opts?.hitsPerKeyword ?? 10;
  const candidates: MinedCandidate[] = [];

  for (const kw of keywords) {
    const q = encodeURIComponent(kw);
    try {
      const hn = await fetchJson(`${HN_SEARCH_URL}?query=${q}&tags=story&hitsPerPage=${per}`);
      candidates.push(...parseHnResponse(hn, kw));
    } catch (err) {
      console.error(`[geo-demand-mining] HN mine failed for "${kw}" (continuing): ${String(err)}`);
    }
    try {
      const so = await fetchJson(
        `${STACKEXCHANGE_SEARCH_URL}?q=${q}&site=stackoverflow&pagesize=${per}&order=desc&sort=relevance`,
      );
      candidates.push(...parseStackExchangeResponse(so, kw));
    } catch (err) {
      console.error(`[geo-demand-mining] StackExchange mine failed for "${kw}" (continuing): ${String(err)}`);
    }
  }
  // Reddit DEFERRED: MANUAL_PENDING (OAuth + spam-sensitivity).
  return candidates;
}

/** Render the human review brief (markdown) from the two halves. */
export function renderReviewBrief(
  dateUtc: string,
  weights: DemandWeight[],
  unmatched: UnmatchedHash[],
  clustered: Record<string, MinedCandidate[]>,
): string {
  const lines: string[] = [];
  lines.push(`# GEO demand-mining review — ${dateUtc}`);
  lines.push('');
  lines.push('> PROPOSED candidates for the canonical query SoT. Human/Code curates; nothing auto-injected.');
  lines.push('');
  lines.push('## Platform demand (existing SoT queries, by hash-match frequency)');
  lines.push('| query_id | tier | demand_weight |');
  lines.push('|---|---|---|');
  for (const w of [...weights].sort((a, b) => b.demand_weight - a.demand_weight)) {
    lines.push(`| ${w.query_id} | ${w.tier} | ${w.demand_weight} |`);
  }
  lines.push('');
  lines.push('## Unmatched high-frequency hashes (text not stored — PII)');
  if (unmatched.length === 0) {
    lines.push('_none above threshold_');
  } else {
    lines.push('| question_hash | hits |');
    lines.push('|---|---|');
    for (const u of unmatched) lines.push(`| \`${u.question_hash}\` | ${u.hits} |`);
  }
  lines.push('');
  lines.push('## Mined public candidates (HN + StackExchange)');
  for (const topic of Object.keys(clustered)) {
    lines.push(`### ${topic}`);
    for (const c of clustered[topic].slice(0, 10)) {
      lines.push(`- [${c.source}] (${c.score}) ${c.title} — ${c.url}`);
    }
    lines.push('');
  }
  lines.push('Reddit: MANUAL_PENDING (OAuth + spam-sensitivity).');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const dateUtc = new Date().toISOString().slice(0, 10);
  const outDir =
    process.env.GEO_DEMAND_OUTPUT_DIR ?? path.resolve(__dirname, '..', '..', 'audits');

  console.log(`[geo-demand-mining] start date=${dateUtc} dryRun=${dryRun}`);
  const { weights, unmatched } = await weightQueriesByPlatformDemand();
  const candidates = await minePublicQuestions();
  const clustered = clusterCandidates(candidates);

  const jsonOut = { generated_utc: dateUtc, weights, unmatched, candidates };
  const brief = renderReviewBrief(dateUtc, weights, unmatched, clustered);

  if (dryRun) {
    console.log('[geo-demand-mining] DRY RUN — not writing artifacts');
    console.log(`weights=${weights.length} unmatched=${unmatched.length} candidates=${candidates.length}`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `geo-demand-candidates-${dateUtc}.json`);
  const mdPath = path.join(outDir, `geo-demand-candidates-${dateUtc}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2), 'utf-8');
  fs.writeFileSync(mdPath, brief, 'utf-8');
  console.log(`[geo-demand-mining] wrote ${jsonPath} + ${mdPath}`);
}

// Run only when invoked directly (cron), not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].includes('geo-demand-mining');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[geo-demand-mining] fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
