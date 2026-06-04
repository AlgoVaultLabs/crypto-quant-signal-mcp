/**
 * EQUITIES-ENGINE-W1 — Databento EQUS.MINI daily-bar provider.
 *
 * Thin REST client over hist.databento.com/v0 (no SDK dependency). HTTP Basic
 * auth with the API key as the username and a blank password (Databento's
 * documented scheme — C1-verified: `curl -u "$KEY:"`). Returns parsed daily
 * OHLCV bars. Bounded retry with exponential backoff; structured errors with a
 * `suggested_action`. Fail-open logging (never throws on the logging path).
 *
 * Phase 1 = daily bars only. Adjustment factors are NOT entitled on the
 * usage-based plan (C1 NO-GO) so prices are raw/unadjusted — split handling is
 * done downstream via gap-quarantine, not here.
 */
import {
  DATABENTO_DATASET,
  DATABENTO_SCHEMA,
  DATABENTO_HOST,
  DATABENTO_STYPE_IN,
} from './equity-constants.js';

export interface EquityBar {
  symbol: string;        // canonical raw_symbol (e.g. AAPL, BRK.B)
  session_date: string;  // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Daily bar keyed by instrument_id (map_symbols=false path, for ALL_SYMBOLS). */
export interface RawBar {
  instrument_id: string;
  close: number;
  volume: number;
}

export interface EquityProviderError extends Error {
  code:
    | 'DATABENTO_AUTH'          // 401/403 — key invalid or not entitled
    | 'DATABENTO_BAD_REQUEST'   // 4xx other than auth/429
    | 'DATABENTO_RATE_LIMIT'    // 429
    | 'DATABENTO_UPSTREAM'      // 5xx / network after retries
    | 'DATABENTO_PARSE';        // response shape unparseable
  suggested_action: string;
  httpStatus?: number;
}

function provErr(
  code: EquityProviderError['code'],
  message: string,
  suggested_action: string,
  httpStatus?: number
): EquityProviderError {
  const e = new Error(message) as EquityProviderError;
  e.code = code;
  e.suggested_action = suggested_action;
  if (httpStatus !== undefined) e.httpStatus = httpStatus;
  return e;
}

export interface ProviderOptions {
  maxAttempts?: number;   // default 4
  baseDelayMs?: number;   // default 300
  logger?: (line: string) => void;
}

export class DatabentoEquityBarsProvider {
  private readonly authHeader: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly log: (line: string) => void;

  constructor(apiKey: string, opts: ProviderOptions = {}) {
    if (!apiKey || !apiKey.trim()) {
      throw provErr(
        'DATABENTO_AUTH',
        'DATABENTO_API_KEY is empty',
        'Set DATABENTO_API_KEY in the container .env and recreate via `docker compose up -d mcp-server`.'
      );
    }
    // HTTP Basic: base64("KEY:") — key as username, blank password.
    this.authHeader = 'Basic ' + Buffer.from(`${apiKey.trim()}:`).toString('base64');
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 300;
    this.log = opts.logger ?? ((l) => { try { console.log(l); } catch { /* fail-open */ } });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** GET with bounded retry/backoff. Retries network errors, 429 and 5xx. */
  private async getText(path: string, params: Record<string, string>): Promise<string> {
    const qs = new URLSearchParams(params).toString();
    const url = `${DATABENTO_HOST}/${path}?${qs}`;
    let lastErr: EquityProviderError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Authorization: this.authHeader, Accept: 'text/csv, application/json' },
        });
        if (res.ok) return await res.text();

        const status = res.status;
        const body = (await res.text().catch(() => '')).slice(0, 300);
        if (status === 401 || status === 403) {
          throw provErr('DATABENTO_AUTH', `Databento ${status}: ${body}`,
            'Verify DATABENTO_API_KEY validity/entitlement for EQUS.MINI.', status);
        }
        if (status === 429) {
          lastErr = provErr('DATABENTO_RATE_LIMIT', `Databento 429: ${body}`,
            'Reduce concurrency or add backoff; retrying.', status);
        } else if (status >= 500) {
          lastErr = provErr('DATABENTO_UPSTREAM', `Databento ${status}: ${body}`,
            'Transient upstream error; retrying.', status);
        } else {
          // 4xx (e.g. data_end_after_available_end) — not retryable.
          throw provErr('DATABENTO_BAD_REQUEST', `Databento ${status}: ${body}`,
            'Check dataset/schema/symbols/date-range against EQUS.MINI availability.', status);
        }
      } catch (err) {
        const e = err as EquityProviderError;
        if (e.code === 'DATABENTO_AUTH' || e.code === 'DATABENTO_BAD_REQUEST') throw e;
        lastErr = e.code
          ? e
          : provErr('DATABENTO_UPSTREAM', `network: ${(err as Error).message}`,
              'Transient network error; retrying.');
      }
      if (attempt < this.maxAttempts) {
        const delay = this.baseDelayMs * 2 ** (attempt - 1);
        this.log(`[equity-bars-provider] attempt ${attempt} failed (${lastErr?.code}); backoff ${delay}ms`);
        await this.sleep(delay);
      }
    }
    throw lastErr ?? provErr('DATABENTO_UPSTREAM', 'exhausted retries', 'Investigate Databento availability.');
  }

  /**
   * Daily OHLCV bars for `symbols` over [start, end) (end exclusive, ISO dates).
   * CSV encoding with pretty prices/timestamps and mapped symbols.
   */
  async getDailyBars(symbols: string[], start: string, end: string): Promise<EquityBar[]> {
    if (symbols.length === 0) return [];
    const csv = await this.getText('timeseries.get_range', {
      dataset: DATABENTO_DATASET,
      schema: DATABENTO_SCHEMA,
      stype_in: DATABENTO_STYPE_IN,
      symbols: symbols.join(','),
      start,
      end,
      encoding: 'csv',
      pretty_px: 'true',
      pretty_ts: 'true',
      map_symbols: 'true',
    });
    return parseOhlcvCsv(csv);
  }

  /**
   * Latest available SESSION date (YYYY-MM-DD). dataset_range `end` is an
   * exclusive UTC boundary, so the last *complete* session is end - 1 day.
   */
  async getLatestAvailableSession(): Promise<string> {
    const json = await this.getText('metadata.get_dataset_range', { dataset: DATABENTO_DATASET });
    let end: string | undefined;
    try {
      const parsed = JSON.parse(json);
      end = parsed?.schema?.[DATABENTO_SCHEMA]?.end ?? parsed?.end;
    } catch {
      throw provErr('DATABENTO_PARSE', `unparseable dataset_range: ${json.slice(0, 120)}`,
        'Inspect metadata.get_dataset_range response shape.');
    }
    if (!end) throw provErr('DATABENTO_PARSE', 'dataset_range missing end',
      'Inspect metadata.get_dataset_range response shape.');
    const boundary = new Date(end.slice(0, 10) + 'T00:00:00Z');
    boundary.setUTCDate(boundary.getUTCDate() - 1);
    return boundary.toISOString().slice(0, 10);
  }

  /**
   * Daily bars for ALL_SYMBOLS (or a wide set) keyed by instrument_id.
   * Databento forbids `map_symbols=true` with ALL_SYMBOLS, so the symbol is NOT
   * resolved here — callers rank by instrument_id then call resolveSymbology()
   * for the survivors. [start, end) end-exclusive ISO dates.
   */
  async getDailyBarsRaw(symbols: string[], start: string, end: string): Promise<RawBar[]> {
    if (symbols.length === 0) return [];
    const csv = await this.getText('timeseries.get_range', {
      dataset: DATABENTO_DATASET,
      schema: DATABENTO_SCHEMA,
      stype_in: DATABENTO_STYPE_IN,
      symbols: symbols.join(','),
      start,
      end,
      encoding: 'csv',
      pretty_px: 'true',
      map_symbols: 'false',
    });
    return parseOhlcvCsvRaw(csv);
  }

  /**
   * Resolve a symbology mapping (e.g. instrument_id -> raw_symbol). Returns a
   * Map keyed by the input symbol, valued by the resolved symbol over the date
   * range (last interval wins). Chunked to keep request width bounded.
   */
  async resolveSymbology(
    symbols: string[], stypeIn: string, stypeOut: string, startDate: string, endDate: string
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const CHUNK = 500;
    for (let i = 0; i < symbols.length; i += CHUNK) {
      const slice = symbols.slice(i, i + CHUNK);
      const json = await this.getText('symbology.resolve', {
        dataset: DATABENTO_DATASET,
        symbols: slice.join(','),
        stype_in: stypeIn,
        stype_out: stypeOut,
        start_date: startDate,
        end_date: endDate,
      });
      let result: Record<string, Array<{ s: string }>>;
      try { result = JSON.parse(json).result ?? {}; }
      catch { throw provErr('DATABENTO_PARSE', `unparseable symbology.resolve: ${json.slice(0, 120)}`,
        'Inspect symbology.resolve response shape.'); }
      for (const [key, intervals] of Object.entries(result)) {
        if (Array.isArray(intervals) && intervals.length > 0) {
          out.set(key, intervals[intervals.length - 1].s);
        }
      }
    }
    return out;
  }

  /** Estimated cost in USD for a pull (does NOT spend). symbols=[] => ALL_SYMBOLS. */
  async getCostUsd(symbols: string[] | 'ALL_SYMBOLS', start: string, end: string): Promise<number> {
    const sym = symbols === 'ALL_SYMBOLS' || symbols.length === 0 ? 'ALL_SYMBOLS' : symbols.join(',');
    const txt = await this.getText('metadata.get_cost', {
      dataset: DATABENTO_DATASET,
      schema: DATABENTO_SCHEMA,
      stype_in: DATABENTO_STYPE_IN,
      symbols: sym,
      start,
      end,
      mode: 'historical-streaming',
    });
    const cost = parseFloat(txt.trim());
    if (!Number.isFinite(cost)) {
      throw provErr('DATABENTO_PARSE', `non-numeric cost: ${txt.slice(0, 80)}`,
        'Inspect metadata.get_cost response.');
    }
    return cost;
  }
}

/**
 * Parse an EQUS.MINI ohlcv-1d CSV response (header-indexed, order-robust).
 * Exported for unit testing.
 */
export function parseOhlcvCsv(csv: string): EquityBar[] {
  const lines = csv.split('\n').filter((l) => l.trim() !== '');
  if (lines.length <= 1) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const ix = (name: string) => header.indexOf(name);
  const iTs = ix('ts_event');
  const iO = ix('open'), iH = ix('high'), iL = ix('low'), iC = ix('close');
  const iV = ix('volume'), iSym = ix('symbol');
  if ([iTs, iO, iH, iL, iC, iV, iSym].some((i) => i < 0)) {
    const e = new Error(`ohlcv csv missing columns; header=${header.join(',')}`) as EquityProviderError;
    e.code = 'DATABENTO_PARSE';
    e.suggested_action = 'Ensure map_symbols=true and encoding=csv on the request.';
    throw e;
  }
  const out: EquityBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const open = parseFloat(c[iO]), high = parseFloat(c[iH]);
    const low = parseFloat(c[iL]), close = parseFloat(c[iC]);
    const volume = parseInt(c[iV], 10);
    const symbol = (c[iSym] || '').trim();
    const session_date = (c[iTs] || '').slice(0, 10);
    if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(session_date)) continue;
    if (![open, high, low, close].every(Number.isFinite) || !Number.isFinite(volume)) continue;
    out.push({ symbol, session_date, open, high, low, close, volume });
  }
  return out;
}

/**
 * Parse a map_symbols=false ohlcv-1d CSV (instrument_id-keyed; no symbol column).
 * Used for the ALL_SYMBOLS universe pull. Exported for unit testing.
 */
export function parseOhlcvCsvRaw(csv: string): RawBar[] {
  const lines = csv.split('\n').filter((l) => l.trim() !== '');
  if (lines.length <= 1) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const iId = header.indexOf('instrument_id');
  const iC = header.indexOf('close');
  const iV = header.indexOf('volume');
  if (iId < 0 || iC < 0 || iV < 0) {
    const e = new Error(`raw ohlcv csv missing columns; header=${header.join(',')}`) as EquityProviderError;
    e.code = 'DATABENTO_PARSE';
    e.suggested_action = 'Ensure schema=ohlcv-1d and encoding=csv.';
    throw e;
  }
  const out: RawBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const instrument_id = (c[iId] || '').trim();
    const close = parseFloat(c[iC]);
    const volume = parseInt(c[iV], 10);
    if (!instrument_id || !Number.isFinite(close) || !Number.isFinite(volume)) continue;
    out.push({ instrument_id, close, volume });
  }
  return out;
}
