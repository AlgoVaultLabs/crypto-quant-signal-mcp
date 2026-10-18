/**
 * admission-verdict.ts — OPS-ALARM-OWNER-DERIVATION-W1 CH2. The dead-book canary's window onto the ONE
 * admission step.
 *
 *   node dist/scripts/admission-verdict.js --keys 'dead:ASTER|EWT dead:XT|EPT …'
 *
 * Fetches each named venue's universe ONCE through the production `fetchVenueUniverse` (so the venue's
 * own status is read and decided by `admitVenueRows`, exactly as the scan does), reads that fetch's
 * recorded decisions (`getLastAdmission`), asks the adapter for each key's last 24 × 1 h bars, and
 * classifies every key with `classifyDeadBook`. Prints ONE JSON line —
 * `{generated_at, keys: [{key, class, symbol, status_state, venue_last_trade, traded_bars_24h,
 * contradiction_check, reason, admission_kind}]}` — then `ADMISSION_VERDICT_EMIT=PASS` (exit 0). A malformed
 * or missing `--keys`, or any unexpected throw, prints `ADMISSION_VERDICT_EMIT=INDETERMINATE` and NO JSON
 * (exit 3, the token-law default for a new gate); the canary then treats every key as STATUS_UNKNOWN.
 *
 * Callers: the dead-book canary (book-liveness-canary.py) and, since OPS-CANDLE-REQUEST-OWNER-DERIVATION-W1
 * CH2, arm 3e of the outcome-backfill canary, which classifies a coin whose fills went silent. That wave
 * added three things, each additive:
 *  * HL dex coins (ruling Q-A=B). HL's admission payload is its STANDARD universe, so a coin HL lists only
 *    in dex xyz read VENUE_OFF "absent" although HL lists it live — which would have hidden the 8 coins
 *    arm 3e exists to catch. Such a key is now decided from the adapter's own listing (CH1's resolver)
 *    under the SAME HL declaration (`admitRow('HL', …)`, notionalOI_usd > 0). The scan, its universe and
 *    every admission declaration are untouched.
 *  * `admission_kind` — the venue's declared admission source kind (`ADMISSION_SOURCES[venue].kind`), so
 *    a caller can tell a RETIRED venue's STATUS_UNKNOWN from an unreadable one without parsing prose.
 *  * Coins in any script (`\p{L}`), so a non-ASCII coin is classified instead of refusing the whole call.
 *
 * WHY. The canary paged every dead book with a paragraph asking a human to read the venue's contract
 * status — a status the admission step already reads on every fetch. Asking it instead of re-deriving
 * it means the next change to a venue's declaration reaches the canary in the same deploy.
 *
 * Read-only: no database, no writes. Upstream calls run under the BATCH weight class (they are
 * background work and must never take an interactive caller's budget).
 */
import { fetchVenueUniverse, getLastAdmission, type AdmissionRecord } from '../lib/exchange-universe.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import { HlMarketNotListedError, resolveHlMarket } from '../lib/adapters/hyperliquid.js';
import {
  ADMISSION_SOURCES, admitRow, classifyDeadBook, DEAD_BOOK_TRADE_WINDOW_MS, type DeadBookVerdict,
} from '../lib/universe-admission.js';
import { runAsBatch } from '../lib/upstream-weight-budget.js';
import { runScript } from '../lib/script-lifecycle.js';
import type { ExchangeId } from '../types.js';

export const VERDICT_TOKEN = 'ADMISSION_VERDICT_EMIT';
const BAR_MS = 3_600_000;

export interface DeadKey { key: string; venue: string; coin: string }

/** What the CLI reads of an admission record — `AdmissionRecord` satisfies it. */
export type AdmissionView = Pick<AdmissionRecord, 'statusState' | 'circuitOpen' | 'mode' | 'rows' | 'atMs' | 'decisions'>
  & { venue?: string; side?: string; kind?: string };

/** An HL coin as the adapter lists it in ANY of its universes (standard or dex) — what ruling Q-A=B decides
 *  an HL key from when the standard admission payload does not carry it. `symbol` is HL's own market name. */
export interface HlListedRow { symbol: string; notionalOI_usd: number; volume24h_usd: number }

/** The seams, injectable so the CLI is a pure function of argv + deps. */
export interface AdmissionVerdictDeps {
  nowMs: () => number;
  fetchVenueUniverse: (venue: string) => Promise<ReadonlyArray<{ coin: string }>>;
  lastAdmission: (venue: string) => AdmissionView | undefined;
  hourlyBars: (venue: string, coin: string) => Promise<ReadonlyArray<{ time: number; volume: number }>>;
  /** The adapter's HL listing for one coin: null when HL lists it in no universe; throws when the listing
   *  cannot be read (the key is then STATUS_UNKNOWN — never VENUE_OFF on a listing nobody read). */
  hlListedRow: (coin: string) => Promise<HlListedRow | null>;
}

// The coin admits every script (\p{L}, with combining marks and digits): a non-ASCII coin is a coin, and one
// refused token used to make the WHOLE call INDETERMINATE. Whitespace, `|` and quotes stay refused.
const TOKEN_RE = /^(?:dead:)?([A-Z][A-Z0-9]*)\|([\p{L}\p{M}\p{N}._:@-]+)$/u;

/** `dead:V|C` or `V|C`, whitespace-separated → keys in their canonical `dead:` spelling. null = malformed or empty. */
export function parseDeadKeys(raw: string): DeadKey[] | null {
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const out: DeadKey[] = [];
  for (const t of tokens) {
    const m = TOKEN_RE.exec(t);
    if (!m) return null;
    out.push({ key: `dead:${m[1]}|${m[2]}`, venue: m[1], coin: m[2] });
  }
  return out;
}

interface KeyLine {
  key: string;
  class: DeadBookVerdict['cls'];
  symbol: string | null;
  status_state: string | null;
  venue_last_trade: string | null;
  traded_bars_24h: number | null;
  contradiction_check: DeadBookVerdict['contradictionCheck'];
  reason: string;
  /** `ADMISSION_SOURCES[venue].kind`; null for a venue with no declaration at all. */
  admission_kind: string | null;
}

function isVenue(v: string): v is ExchangeId {
  return Object.prototype.hasOwnProperty.call(ADMISSION_SOURCES, v);
}

/** The CLI as a function of argv + deps: the lines to print and the exit code. */
export async function runAdmissionVerdict(argv: readonly string[], deps: AdmissionVerdictDeps): Promise<{ lines: string[]; exitCode: number }> {
  const indeterminate = (why: string) => ({ lines: [`[admission-verdict] ${why}`, `${VERDICT_TOKEN}=INDETERMINATE`], exitCode: 3 });
  const i = argv.indexOf('--keys');
  const keys = i >= 0 && argv[i + 1] !== undefined ? parseDeadKeys(argv[i + 1]) : null;
  if (keys === null) return indeterminate(`usage: --keys 'dead:<VENUE>|<COIN> …' (got ${JSON.stringify(i >= 0 ? argv[i + 1] ?? null : null)})`);
  try {
    // A record older than this run's own fetch is never trusted: it is some earlier caller's answer.
    const startMs = deps.nowMs();
    const venues = new Map<string, { fetchError: string | null; empty: boolean; rec: AdmissionView | undefined }>();
    for (const { venue } of keys) {
      if (venues.has(venue) || !isVenue(venue)) continue;
      let fetchError: string | null = null;
      let empty = false;
      try {
        empty = (await deps.fetchVenueUniverse(venue)).length === 0; // no fetcher, or an empty payload
      } catch (e) {
        fetchError = e instanceof Error ? e.message : String(e);
      }
      const rec = deps.lastAdmission(venue);
      venues.set(venue, { fetchError, empty, rec: rec !== undefined && rec.atMs >= startMs ? rec : undefined });
    }
    const out: KeyLine[] = [];
    for (const { key, venue, coin } of keys) {
      if (!isVenue(venue)) {
        out.push({ key, class: 'STATUS_UNKNOWN', symbol: null, status_state: null, venue_last_trade: null, traded_bars_24h: null,
          contradiction_check: 'not_evaluable', reason: `${venue} is not a known venue`, admission_kind: null });
        continue;
      }
      const { fetchError, empty, rec } = venues.get(venue)!;
      let d: AdmissionView['decisions'][number] | undefined = rec?.decisions.find((x) => x.coin === coin);
      let keyFetchError = fetchError;
      let notListed = '';
      // Ruling Q-A=B: an HL coin the STANDARD payload lacks is decided from the adapter's own listing (CH1),
      // under HL's one declaration. Asked only when that record is trustworthy and silent on the coin — any
      // other state is STATUS_UNKNOWN below whatever the listing says.
      if (venue === 'HL' && d === undefined && rec !== undefined && fetchError === null && !empty) {
        try {
          const row = await deps.hlListedRow(coin);
          if (row === null) {
            notListed = '; the adapter lists it in no HL universe either (standard or dex)';
          } else {
            const admissionRow = { symbol: row.symbol, coin, notionalOI_usd: row.notionalOI_usd, volume24h_usd: row.volume24h_usd };
            d = { symbol: row.symbol, coin, volume24h_usd: row.volume24h_usd, tickerTsMs: null,
              decision: admitRow('HL', admissionRow, null, deps.nowMs()) };
          }
        } catch (e) {
          keyFetchError = `the adapter's HL listing could not be read for ${coin}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      let bars: ReadonlyArray<{ time: number; volume: number }> | null = null;
      try { bars = await deps.hourlyBars(venue, coin); } catch { bars = null; } // could not ask ⇒ not evaluable
      const v = classifyDeadBook({
        venue, decision: d?.decision ?? null, statusState: rec?.statusState ?? null,
        circuitOpen: rec?.circuitOpen ?? false, mode: rec?.mode ?? 'enforce',
        universeRows: empty ? 0 : rec?.rows ?? 0, fetchError: keyFetchError, venueLastTradeMs: d?.tickerTsMs ?? null,
        volume24hUsd: d?.volume24h_usd ?? null, bars, barMs: BAR_MS, nowMs: deps.nowMs(),
      });
      out.push({
        key, class: v.cls, symbol: d?.symbol ?? null, status_state: rec?.statusState ?? null,
        venue_last_trade: d?.tickerTsMs != null ? new Date(d.tickerTsMs).toISOString() : null,
        traded_bars_24h: v.tradedBars24h, contradiction_check: v.contradictionCheck,
        reason: v.cls === 'VENUE_OFF' && d === undefined ? v.reason + notListed : v.reason,
        admission_kind: ADMISSION_SOURCES[venue].kind,
      });
    }
    return { lines: [JSON.stringify({ generated_at: new Date(deps.nowMs()).toISOString(), keys: out }), `${VERDICT_TOKEN}=PASS`], exitCode: 0 };
  } catch (e) {
    return indeterminate(`unexpected throw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Production seams: the scan's own universe fetch, its recorded admission, the venue adapter. */
const productionDeps: AdmissionVerdictDeps = {
  nowMs: () => Date.now(),
  fetchVenueUniverse: (venue) => fetchVenueUniverse(venue as ExchangeId),
  lastAdmission: (venue) => getLastAdmission(venue as ExchangeId, 'sot'),
  hourlyBars: async (venue, coin) => {
    const now = Date.now();
    const from = Math.floor(now / BAR_MS) * BAR_MS - DEAD_BOOK_TRADE_WINDOW_MS - BAR_MS; // one bar of ±1 margin
    const candles = await getAdapter(venue as ExchangeId).getCandles(coin, '1h', from, undefined, now);
    return candles.map((c) => ({ time: c.time, volume: c.volume }));
  },
  // The SAME derivation as the scan's fetchHL row (notionalOI_usd = openInterest × markPx, volume = dayNtlVlm),
  // read through the adapter that owns the market (CH1) — never a second copy of HL's universe.
  hlListedRow: async (coin) => {
    const market = await resolveHlMarket(coin);
    if (market === null) return null;
    try {
      const ctx = await getAdapter('HL').getAssetContext(coin);
      return { symbol: market.market, notionalOI_usd: ctx.openInterest * ctx.markPx, volume24h_usd: ctx.volume24h };
    } catch (e) {
      if (e instanceof HlMarketNotListedError) return null; // delisted between the listing and the read
      throw e;
    }
  },
};

if (require.main === module) {
  // runScript: drain-then-exit on every path (OPS-SCRIPT-EXIT-LIFECYCLE-W1) — the verdict token is
  // flushed before exit, so it can never be cut off the pipe the canary reads through `docker exec`.
  void runScript('admission-verdict', async () => {
    const r = await runAsBatch(() => runAdmissionVerdict(process.argv.slice(2), productionDeps), 'admission-verdict');
    for (const line of r.lines) console.log(line);
    return r.exitCode;
  });
}
