/**
 * refusal-counter.ts — REGIME-TF-ADMISSION-W1 CH2. Every refused tool input becomes a persistent daily count.
 *
 * WHY. "Should we add 15m?" had no answer on day 0. `strictToolInput` logged an unknown key to stdout, which every
 * deploy loses, and an enum refusal (a 15m timeframe, a venue we do not accept) left no record at all: zod refuses it
 * inside the SDK, so no handler runs and request_log never sees it. Demand we refuse is demand data, so it is kept.
 *
 * ONE ENTRY, FOUR CALLERS. `recordRefusal` is called from:
 *   - `strictToolInput` (src/index.ts): `invalid_enum_value` from an observer on each enum leaf of the shape, and
 *     `unrecognized_keys` from the object's errorMap (its stdout line stays);
 *   - the pipeline's timeframe admission (src/lib/tool-call-pipeline.ts): `timeframe_admission`;
 *   - `recordNonPublicVenue` (src/lib/non-public-venue-counter.ts): `non_public_venue` (its stdout line stays).
 * A non-public venue on MCP therefore lands twice, under two reasons: once as `non_public_venue` from the POST layer
 * and once as `invalid_enum_value` from the SDK's zod refusal of the same argument. Each reason counts each call once.
 *
 * THE RECORD PATH IS SYNCHRONOUS, NEVER THROWS AND NEVER AWAITS: it runs inside zod's parse and on the pipeline's
 * refusal arm, live serving paths, so it only touches an in-process map (a guard on a serving path refuses; an
 * instrument on it must not break it). Persistence is a batched upsert on an unref'd interval and at shutdown; the
 * table ensure runs on that flush path only. A failed flush logs ONE line and drops that batch.
 *
 * TABLE. `refusal_counts` (migrations/058, statement for statement the ensure below — pinned by
 * tests/unit/refusal-counter.test.ts): one row per (UTC day, reason, tool, parameter, value, keyed, caller_key) with a
 * count. Postgres only; a local (SQLite) install keeps nothing. Readable by `aoe_readonly`, the owed-read runner's
 * read-only role (the GRANT is guarded, so a database without that role never fails the ensure).
 *
 * BOUNDS, because every key below except `reason` is caller-influenced:
 *   - `tool`, `parameter`, `value` and `caller_key` are stored only as ≤ 32 chars of [A-Za-z0-9_.:-], else `<other>`;
 *     an absent caller key is `<none>`.
 *   - at most 10,000 distinct keys per UTC day; every later new key folds into ONE `<overflow>` row for that day. The
 *     cap counts this process's keys plus the rows the table already held for the day when this process first
 *     flushed it, so a restart does not grant a fresh 10,000.
 *
 * CALLER KEY. request_log's own pseudonymous caller identity, `ip_hash` (`hashIp`, analytics.ts; read through
 * `getRequestIpHash()`), so the two tables join and no new hash domain exists. `keyed` = the request carried an API key.
 */
import { z } from 'zod';
import { dbQuery, isPgBackend } from './performance-db.js';

export type RefusalReason = 'invalid_enum_value' | 'unrecognized_keys' | 'timeframe_admission' | 'non_public_venue';

export interface RefusalRecord {
  reason: RefusalReason;
  /** The served tool name. */
  tool: string;
  /** The refused parameter — for `unrecognized_keys`, the unknown key itself. */
  parameter: string;
  /** The refused value as the caller sent it; bounded before it is kept. */
  value: unknown;
  /** The request carried an API key. */
  keyed: boolean;
  /** request_log's `ip_hash` for the request, or absent (stdio, a channel without one). */
  callerKey: string | null | undefined;
}

const MAX_KEYS_PER_DAY = 10_000;
const FLUSH_INTERVAL_MS = 60_000;
const UPSERT_CHUNK_ROWS = 500;
const BOUNDED = /^[A-Za-z0-9_.:-]{1,32}$/;
const OTHER = '<other>';
const NONE = '<none>';
const OVERFLOW = '<overflow>';

interface Row {
  day: string;
  reason: string;
  tool: string;
  parameter: string;
  value: string;
  keyed: boolean;
  callerKey: string;
  count: number;
}

const pending = new Map<string, Row>();
/** The keys this process has admitted for the current UTC day, and the table's row count for that day at seed. */
let today: { day: string; keys: Set<string>; seeded: number; seededDone: boolean } = { day: '', keys: new Set(), seeded: 0, seededDone: false };
let timer: ReturnType<typeof setInterval> | null = null;
let ensured: Promise<void> | null = null;

function bounded(v: unknown): string {
  const s = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'boolean' ? String(v) : null;
  return s !== null && BOUNDED.test(s) ? s : OTHER;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const keyOf = (r: Omit<Row, 'count'>): string =>
  JSON.stringify([r.day, r.reason, r.tool, r.parameter, r.value, r.keyed, r.callerKey]);

/**
 * Count one refused input. Synchronous, never throws, never awaits — safe inside zod's parse and on any serving path.
 */
export function recordRefusal(r: RefusalRecord, nowMs: number = Date.now()): void {
  try {
    const day = utcDay(nowMs);
    if (today.day !== day) today = { day, keys: new Set(), seeded: 0, seededDone: false };
    let row: Omit<Row, 'count'> = {
      day,
      reason: bounded(r.reason),
      tool: bounded(r.tool),
      parameter: bounded(r.parameter),
      value: bounded(r.value),
      keyed: r.keyed === true,
      callerKey: r.callerKey == null || r.callerKey === '' ? NONE : bounded(r.callerKey),
    };
    let key = keyOf(row);
    if (!today.keys.has(key)) {
      if (today.keys.size + today.seeded >= MAX_KEYS_PER_DAY) {
        row = { day, reason: OVERFLOW, tool: OVERFLOW, parameter: OVERFLOW, value: OVERFLOW, keyed: false, callerKey: OVERFLOW };
        key = keyOf(row);
      } else {
        today.keys.add(key);
      }
    }
    const p = pending.get(key);
    if (p) p.count += 1;
    else pending.set(key, { ...row, count: 1 });
    if (!timer) {
      timer = setInterval(() => { void flushRefusals(); }, FLUSH_INTERVAL_MS);
      timer.unref?.();
    }
  } catch {
    // An instrument must never break the path it instruments.
  }
}

/**
 * The same shape with every enum leaf observing its own refusals.
 *
 * WHY A LEAF OBSERVER. zod hands an object's errorMap only the object's OWN issues (`unrecognized_keys`); a field's
 * `invalid_enum_value` is raised by the field's ZodEnum and consults only that enum's errorMap (measured on zod
 * 3.25.76). So each ZodEnum — bare, or under `.default()`, `.optional()`, `.nullable()`, `.describe()` or `z.array()` —
 * is cloned with an errorMap that reports the refusal and then returns exactly the message zod would have produced
 * (the enum's own map if it had one, else `ctx.defaultError`), so the refusal text is unchanged. Wrappers are rebuilt
 * from their own `_def` (description included) only when something beneath them changed; every other field is
 * returned as the same object. Nothing here is part of the JSON Schema the SDK renders, so tools/list bytes do not
 * move (pinned by tool-call-parity's strict-vs-raw byte-identity test).
 *
 * `onRefused` runs inside zod's parse: a throw from it is swallowed here, so the refusal is never turned into a crash.
 */
export function observeEnumLeaves<S extends z.ZodRawShape>(shape: S, onRefused: (parameter: string, value: unknown) => void): S {
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [param, schema] of Object.entries(shape)) out[param] = withEnumObserver(schema as z.ZodTypeAny, param, onRefused);
  return out as S;
}

function withEnumObserver(s: z.ZodTypeAny, param: string, onRefused: (parameter: string, value: unknown) => void): z.ZodTypeAny {
  if (s instanceof z.ZodEnum) {
    const own = s._def.errorMap;
    const errorMap: z.ZodErrorMap = (issue, ctx) => {
      if (issue.code === z.ZodIssueCode.invalid_enum_value) {
        try { onRefused(param, ctx.data); } catch { /* an observer never breaks the refusal it observes */ }
      }
      return own ? own(issue, ctx) : { message: ctx.defaultError };
    };
    return new z.ZodEnum({ ...s._def, errorMap });
  }
  if (s instanceof z.ZodDefault || s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
    const inner = withEnumObserver(s._def.innerType, param, onRefused);
    if (inner === s._def.innerType) return s;
    if (s instanceof z.ZodDefault) return new z.ZodDefault({ ...s._def, innerType: inner });
    if (s instanceof z.ZodOptional) return new z.ZodOptional({ ...s._def, innerType: inner });
    return new z.ZodNullable({ ...s._def, innerType: inner });
  }
  if (s instanceof z.ZodArray) {
    const inner = withEnumObserver(s._def.type, param, onRefused);
    return inner === s._def.type ? s : new z.ZodArray({ ...s._def, type: inner });
  }
  return s;
}

/**
 * The table's statements, in order. migrations/058_refusal_counts.sql is these statements verbatim (pinned by test).
 * The GRANT is wrapped so a database without the `aoe_readonly` role (a test, a dev box) never fails the ensure.
 */
const REFUSAL_COUNTS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS refusal_counts (
  day        DATE    NOT NULL,
  reason     TEXT    NOT NULL,
  tool       TEXT    NOT NULL,
  parameter  TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  keyed      BOOLEAN NOT NULL,
  caller_key TEXT    NOT NULL,
  count      BIGINT  NOT NULL,
  PRIMARY KEY (day, reason, tool, parameter, value, keyed, caller_key)
)`,
  `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoe_readonly') THEN
    GRANT SELECT ON refusal_counts TO aoe_readonly;
  END IF;
END
$$`,
];

/** Create the table once per process, on the flush path only; a failed ensure is dropped so the next flush retries. */
function ensureRefusalCounts(): Promise<void> {
  if (!ensured) {
    const attempt = (async () => {
      for (const sql of REFUSAL_COUNTS_DDL) await dbQuery(sql);
    })();
    ensured = attempt;
    attempt.catch(() => {
      if (ensured === attempt) ensured = null;
    });
  }
  return ensured;
}

/**
 * Upsert everything counted since the last flush. Called on the interval and at shutdown. Never rejects: a failure
 * logs one line and drops that batch (the counts are telemetry; a retry queue would grow without bound on an outage).
 */
export async function flushRefusals(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending.values()];
  pending.clear();
  if (!isPgBackend()) return;
  try {
    await ensureRefusalCounts();
    if (!today.seededDone && batch.some((r) => r.day === today.day)) {
      const day = today.day;
      const rows = await dbQuery<{ n: number | string }>('SELECT count(*)::int AS n FROM refusal_counts WHERE day = ?', [day]);
      if (today.day === day && !today.seededDone) {
        today.seeded = Number(rows[0]?.n ?? 0);
        today.seededDone = true;
      }
    }
    for (let i = 0; i < batch.length; i += UPSERT_CHUNK_ROWS) {
      const chunk = batch.slice(i, i + UPSERT_CHUNK_ROWS);
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params = chunk.flatMap((r) => [r.day, r.reason, r.tool, r.parameter, r.value, r.keyed, r.callerKey, r.count]);
      await dbQuery(
        `INSERT INTO refusal_counts (day, reason, tool, parameter, value, keyed, caller_key, count) VALUES ${values}
         ON CONFLICT (day, reason, tool, parameter, value, keyed, caller_key)
         DO UPDATE SET count = refusal_counts.count + EXCLUDED.count`,
        params,
      );
    }
  } catch (e) {
    try {
      console.error(`[refusal-counter] flush failed — dropped ${batch.length} key(s): ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    } catch { /* never throws */ }
  }
}

/** Tests only: what is waiting for the next flush, in insertion order. */
export function _pendingRefusalsForTest(): Row[] {
  return [...pending.values()].map((r) => ({ ...r }));
}

/** Tests only — module-level state needs an explicit reset seam (CLAUDE.md cache-seam rule). */
export function _resetRefusalCounterForTest(): void {
  pending.clear();
  today = { day: '', keys: new Set(), seeded: 0, seededDone: false };
  if (timer) clearInterval(timer);
  timer = null;
  ensured = null;
}
