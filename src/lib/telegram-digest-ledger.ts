/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH2 — an undelivered labelled digest is a ROW, and only a
 * terminal disposition (delivered · dead-with-a-page) can end it.
 *
 * Before this module nothing persisted an undelivered digest: `sendDigest` returned `false`,
 * paged on the FIRST failure, and the content was gone until the next scheduled run — 24 h for
 * the monitor digest, a week for four producers, a MONTH for the referral payout notice. The
 * CLAUDE.md spine is Detect → Recover → Alert → Escalate; the transport had no Recover stage.
 *
 * Table `telegram_digest_ledger`, one row per `(label, period_key, part)`:
 *   part 0      — the RUN row: attempted_at · run_attempts · parts_total · status ∈
 *                 attempted|delivered|queued|dead|skipped|missed · reason · paged_at
 *   part 1..n   — an undelivered CHUNK: text · status ∈ queued|delivered|dead · attempts ·
 *                 first_failed_at · next_attempt_at · last_cause · delivered_at · expires_at
 * A chunk delivered on the first try gets NO row — the run row's `parts_total` minus the
 * undelivered rows is the delivered count.
 *
 * Every timestamp is epoch MILLISECONDS in a BIGINT, written by us on both dialects and read
 * back through `Number()`. That sidesteps both traps `lifecycle/ledger.ts` documents (SQLite
 * TEXT compared lexicographically; node-postgres returning TIMESTAMPTZ as a Date) and the
 * third (node-postgres returns BIGINT as a STRING — a numeric mock hides it).
 *
 * This module never imports `telegram.ts` at runtime (the drain is handed its sender), so the
 * transport can lazily import it without a cycle.
 */
import { dbExec, dbQuery } from './performance-db.js';
import { mdValue } from './markdown-safe.js';
import {
  DIGEST_LABELS,
  digestRow,
  periodKey as periodKeyOf,
  redeliveryTtlS,
  type DigestLabel,
} from './digest-registry.js';
import type { DeliveryResult, TelegramFailure } from './telegram.js';

const IS_PG = !!process.env.DATABASE_URL;
export const DIGEST_LEDGER_TABLE = 'telegram_digest_ledger';

// Every column is nullable or NOT NULL DEFAULT (build-and-runtime.md: a row written by older
// code must never fail an insert). The identity columns carry inert defaults for the same rule;
// every writer sets them, and no reader selects an unregistered label.
const COLUMNS = `
    label            TEXT    NOT NULL DEFAULT '',
    period_key       TEXT    NOT NULL DEFAULT '',
    part             INTEGER NOT NULL DEFAULT 0,
    status           TEXT    NOT NULL DEFAULT 'attempted',
    attempted_at     BIGINT  NULL,
    run_attempts     INTEGER NOT NULL DEFAULT 0,
    parts_total      INTEGER NULL,
    reason           TEXT    NULL,
    paged_at         BIGINT  NULL,
    page_lease_until BIGINT  NULL,
    text             TEXT    NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    first_failed_at  BIGINT  NULL,
    first_code       TEXT    NULL,
    last_attempt_at  BIGINT  NULL,
    next_attempt_at  BIGINT  NULL,
    last_cause       TEXT    NULL,
    delivered_at     BIGINT  NULL,
    tg_message_id    BIGINT  NULL,
    expires_at       BIGINT  NULL,
    created_at       BIGINT  NULL,
    updated_at       BIGINT  NULL,
    CONSTRAINT telegram_digest_ledger_unique UNIQUE (label, period_key, part)`;
const CREATE_PG = `CREATE TABLE IF NOT EXISTS telegram_digest_ledger (\n    id BIGSERIAL PRIMARY KEY,${COLUMNS}\n)`;
const CREATE_SQLITE = `CREATE TABLE IF NOT EXISTS telegram_digest_ledger (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,${COLUMNS}\n)`;
const CREATE_DUE_INDEX = 'CREATE INDEX IF NOT EXISTS idx_telegram_digest_ledger_due ON telegram_digest_ledger (status, next_attempt_at)';

let ensured: Promise<void> | null = null;

/**
 * AWAITED DDL — never the fire-and-forget `dbExec` on Postgres, because the first write is the
 * next statement. On SQLite `dbExec` is synchronous and throws synchronously, which is awaited
 * by construction. A concurrent first use on Postgres can lose the `pg_type` race inside
 * `CREATE TABLE IF NOT EXISTS`; one retry finds the table made by the winner.
 */
export function ensureDigestLedgerSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      if (IS_PG) {
        for (const ddl of [CREATE_PG, CREATE_DUE_INDEX]) {
          try {
            await dbQuery(ddl);
          } catch {
            await dbQuery(ddl);
          }
        }
      } else {
        dbExec(CREATE_SQLITE);
        dbExec(CREATE_DUE_INDEX);
      }
    })().catch((err) => {
      ensured = null; // retry on the next call rather than caching a failure
      throw err;
    });
  }
  return ensured;
}

/** Test seam — forget the ensured-schema cache (a suite that swaps the database). */
export function _resetDigestLedgerSchemaForTest(): void {
  ensured = null;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** CH1's disposition, as ONE redacted line — what `last_cause` persists. */
export function causeLine(f: TelegramFailure | null, attempts: number): string {
  if (!f) return `disposition=unknown attempts=${attempts}`;
  return `disposition=${f.disposition} class=${f.klass} code=${f.code} desc="${f.desc}" attempts=${attempts}`;
}

/** Minutes → the drain's next wait: min(60 min, 2^attempts min), or retry_after when longer. */
export function nextBackoffMs(attempts: number, retryAfterS: number | null): number {
  const exp = Math.min(60, 2 ** Math.max(0, attempts)) * 60_000;
  return Math.max(exp, (retryAfterS ?? 0) * 1000);
}

/** A part is queued for at least this long after an in-run failure (the next critical tick or two). */
const MIN_REQUEUE_MS = 120_000;
/** The drain's lease: a part picked by one tick is invisible to any other for 5 minutes. */
const LEASE_MS = 300_000;

// ── the DEAD page — ONE renderer for the producer path and the drain ─────────────────

export interface DeadPageArgs {
  label: string;
  periodKey: string;
  runId: number;
  disposition: string;
  code: string;
  desc: string;
  attempts: number;
  firstFailedAtMs: number | null;
  partsDelivered: number;
  partsTotal: number;
  hostLog: string;
}

/**
 * The operator page for a digest that will NOT be delivered. PURE. Keeps the phrase the
 * operator already knows ("Digest <label> FAILED to deliver"); every interpolated value is a
 * code span because legacy Markdown has no escape and a cause or a table name carries `_`.
 * `W{NEXT}` is the template form — a hardcoded next-wave id is forbidden.
 */
export function renderDeadPage(a: DeadPageArgs): string {
  const first = a.firstFailedAtMs != null ? ` · first failure ${hhmmss(a.firstFailedAtMs)}Z` : '';
  const unreachable =
    a.disposition === 'transient' && a.firstFailedAtMs != null
      ? ` · Telegram unreachable from the container since ${mdValue(new Date(a.firstFailedAtMs).toISOString())}`
      : '';
  return [
    `🛑 ${mdValue('DIGEST_UNDELIVERED')} — Digest ${mdValue(a.label)} FAILED to deliver (${mdValue(a.periodKey)})`,
    `Condition: ${a.disposition} ${mdValue(a.code)} ${mdValue(a.desc)} · ${a.attempts} attempt(s)${first}`,
    `Context: parts delivered ${a.partsDelivered}/${a.partsTotal}${unreachable}`,
    `Action: dispatch OPS-DIGEST-DELIVERY-DEAD-W{NEXT} via Cowork → Claude Code`,
    `Source: ${mdValue(DIGEST_LEDGER_TABLE)} id ${a.runId} · ${mdValue(a.hostLog)}`,
  ].join('\n');
}

// ── the write path ───────────────────────────────────────────────────────────────────

export type RunStatus = 'delivered' | 'queued' | 'dead';

export interface DigestPartOutcome {
  /** 1-based chunk index. */
  part: number;
  text: string;
  result: DeliveryResult;
}

export interface PlannedPart {
  part: number;
  status: 'delivered' | 'queued' | 'dead';
  text: string;
  failure: TelegramFailure | null;
  attempts: number;
  retryAfterS: number | null;
  messageId: number | null;
}

/**
 * PURE: what a run's outcome MEANS for the ledger. One derivation, used by the real store and
 * by every in-memory test double, so a double cannot disagree with production about which
 * outcome queues, which dies and which pages.
 *   delivered now          → no part row (or a stale queued row of this period is superseded)
 *   transient              → `queued` — silent; the drain owns it
 *   entity/content/config  → `dead` immediately — resending the same bytes cannot succeed
 * Run status: any dead → `dead` (pages now); else any queued → `queued`; else `delivered`.
 */
export function planDigestRun(parts: DigestPartOutcome[]): { runStatus: RunStatus; parts: PlannedPart[] } {
  const planned: PlannedPart[] = parts.map((p) => ({
    part: p.part,
    status: p.result.ok ? 'delivered' : p.result.failure?.disposition === 'transient' ? 'queued' : 'dead',
    text: p.text,
    failure: p.result.failure,
    attempts: p.result.attempts,
    retryAfterS: p.result.retryAfterS ?? p.result.failure?.retryAfterS ?? null,
    messageId: p.result.messageId ?? null,
  }));
  const runStatus: RunStatus = planned.some((p) => p.status === 'dead')
    ? 'dead'
    : planned.some((p) => p.status === 'queued')
      ? 'queued'
      : 'delivered';
  return { runStatus, parts: planned };
}

export interface RecordedRun {
  runId: number;
  runStatus: RunStatus;
  periodKey: string;
  /** Set when the run is DEAD: the page to deliver (and mark through `pageDeadRun`). */
  deadPage: string | null;
}

/** Low-level write, shared by `recordDigestRun` (registered labels) and the proof script. */
export async function writeDigestRun(args: {
  label: string;
  periodKey: string;
  nowMs: number;
  ttlS: number;
  hostLog: string;
  parts: DigestPartOutcome[];
}): Promise<RecordedRun> {
  await ensureDigestLedgerSchema();
  const { label, periodKey, nowMs } = args;
  const plan = planDigestRun(args.parts);
  const partsTotal = args.parts.length;

  const run = await dbQuery<{ id: unknown }>(
    `INSERT INTO telegram_digest_ledger (label, period_key, part, status, attempted_at, run_attempts, parts_total, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (label, period_key, part) DO UPDATE SET
       status = excluded.status,
       parts_total = excluded.parts_total,
       attempted_at = COALESCE(telegram_digest_ledger.attempted_at, excluded.attempted_at),
       run_attempts = CASE WHEN telegram_digest_ledger.run_attempts < 1 THEN 1 ELSE telegram_digest_ledger.run_attempts END,
       updated_at = excluded.updated_at
     RETURNING id`,
    [label, periodKey, plan.runStatus, nowMs, partsTotal, nowMs, nowMs],
  );
  const runId = num(run[0]?.id);
  if (runId == null) throw new Error('run row upsert returned no id');

  for (const p of plan.parts) {
    if (p.status === 'delivered') {
      // A stale queued row from an earlier run of THIS period is superseded by this delivery.
      await dbQuery(
        `UPDATE telegram_digest_ledger SET status = 'delivered', delivered_at = ?, tg_message_id = ?, text = NULL, updated_at = ?
         WHERE label = ? AND period_key = ? AND part = ? AND status = 'queued' RETURNING id`,
        [nowMs, p.messageId, nowMs, label, periodKey, p.part],
      );
      continue;
    }
    const cause = causeLine(p.failure, p.attempts);
    const next = p.status === 'queued' ? nowMs + Math.max(MIN_REQUEUE_MS, (p.retryAfterS ?? 0) * 1000) : null;
    await dbQuery(
      `INSERT INTO telegram_digest_ledger
         (label, period_key, part, status, text, attempts, first_failed_at, first_code, last_attempt_at, next_attempt_at, last_cause, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (label, period_key, part) DO UPDATE SET
         status = excluded.status,
         text = excluded.text,
         attempts = telegram_digest_ledger.attempts + excluded.attempts,
         first_failed_at = COALESCE(telegram_digest_ledger.first_failed_at, excluded.first_failed_at),
         first_code = COALESCE(telegram_digest_ledger.first_code, excluded.first_code),
         last_attempt_at = excluded.last_attempt_at,
         next_attempt_at = excluded.next_attempt_at,
         last_cause = excluded.last_cause,
         expires_at = COALESCE(telegram_digest_ledger.expires_at, excluded.expires_at),
         delivered_at = NULL,
         updated_at = excluded.updated_at
       RETURNING id`,
      [label, periodKey, p.part, p.status, p.text, p.attempts, nowMs, p.failure?.code ?? null, nowMs, next, cause,
        nowMs + args.ttlS * 1000, nowMs, nowMs],
    );
  }
  // A previous run of this period that had MORE chunks leaves no orphan in the drain.
  await dbQuery(
    `UPDATE telegram_digest_ledger SET status = 'dead', last_cause = ?, updated_at = ?
     WHERE label = ? AND period_key = ? AND part > ? AND status = 'queued' RETURNING id`,
    ['superseded by a later run of this period', nowMs, label, periodKey, partsTotal],
  );

  let deadPage: string | null = null;
  if (plan.runStatus === 'dead') {
    const firstDead = plan.parts.find((p) => p.status === 'dead') ?? null;
    deadPage = renderDeadPage({
      label,
      periodKey,
      runId,
      disposition: firstDead?.failure?.disposition ?? 'unknown',
      code: firstDead?.failure?.code ?? 'unknown',
      desc: firstDead?.failure?.desc ?? '',
      attempts: firstDead?.attempts ?? 0,
      firstFailedAtMs: nowMs,
      partsDelivered: plan.parts.filter((p) => p.status === 'delivered').length,
      partsTotal,
      hostLog: args.hostLog,
    });
  }
  return { runId, runStatus: plan.runStatus, periodKey, deadPage };
}

/**
 * What the transport needs from the ledger — the seam `telegram.ts` reaches through
 * (`_setDigestLedgerForTest`). This module's own exports satisfy it, so the default seam is
 * a lazy `import()` of this file; a test double implements the same two calls.
 */
export interface DigestLedgerPort {
  recordDigestRun(args: { label: DigestLabel; nowMs: number; parts: DigestPartOutcome[] }): Promise<RecordedRun>;
  pageDeadRun(args: {
    runId: number;
    page: string;
    nowMs: number;
    send: (msg: string) => Promise<boolean>;
  }): Promise<'paged' | 'undelivered' | 'not-claimed'>;
}

/** Record one run of a REGISTERED digest. Throws when the ledger is unavailable. */
export async function recordDigestRun(args: { label: DigestLabel; nowMs: number; parts: DigestPartOutcome[] }): Promise<RecordedRun> {
  return writeDigestRun({
    label: args.label,
    periodKey: periodKeyOf(args.label, args.nowMs),
    nowMs: args.nowMs,
    ttlS: redeliveryTtlS(args.label),
    hostLog: digestRow(args.label).host_log,
    parts: args.parts,
  });
}

/**
 * Page a DEAD run exactly once per (label, period). A short LEASE is claimed before sending so
 * the producer process and a concurrent drain tick cannot both page; `paged_at` is written
 * ONLY after the page was delivered, and an undelivered page releases the lease so the next
 * critical tick retries it.
 */
export async function pageDeadRun(args: {
  runId: number;
  page: string;
  nowMs: number;
  send: (msg: string) => Promise<boolean>;
}): Promise<'paged' | 'undelivered' | 'not-claimed'> {
  const claim = await dbQuery<{ id: unknown }>(
    `UPDATE telegram_digest_ledger SET page_lease_until = ?
     WHERE id = ? AND part = 0 AND paged_at IS NULL AND (page_lease_until IS NULL OR page_lease_until <= ?) RETURNING id`,
    [args.nowMs + 120_000, args.runId, args.nowMs],
  );
  if (claim.length === 0) return 'not-claimed';
  let delivered = false;
  try {
    delivered = await args.send(args.page);
  } catch {
    delivered = false;
  }
  if (delivered) {
    await dbQuery(`UPDATE telegram_digest_ledger SET paged_at = ?, page_lease_until = NULL, updated_at = ? WHERE id = ? RETURNING id`, [
      args.nowMs,
      args.nowMs,
      args.runId,
    ]);
    return 'paged';
  }
  await dbQuery(`UPDATE telegram_digest_ledger SET page_lease_until = NULL WHERE id = ? RETURNING id`, [args.runId]);
  return 'undelivered';
}

// ── the drain ────────────────────────────────────────────────────────────────────────

export interface DrainDeps {
  /** ONE attempt, no in-run backoff — the ledger IS the retry. */
  send(text: string): Promise<DeliveryResult>;
  /** The operator page (a DEAD digest). */
  page(msg: string): Promise<boolean>;
}

export interface DrainResult {
  verdict: 'IDLE' | 'DELIVERED' | 'QUEUED' | 'DEAD';
  delivered: number;
  queued: number;
  dead: number;
  paged: number;
  /** The ONE `[ledger] DRAIN_VERDICT=` line every tick prints. */
  line: string;
}

/** The footer a redelivered LAST part carries — only when it still fits (a part is never re-chunked). */
export function redeliveryFooter(nowMs: number, firstFailedAtMs: number | null, firstCode: string | null): string {
  const first = firstFailedAtMs != null ? hhmmss(firstFailedAtMs) : '?';
  return `\n\n⏱ redelivered ${hhmm(nowMs)}Z · first attempt ${first}Z failed: ${mdValue(firstCode ?? 'unknown')}`;
}

const TELEGRAM_LIMIT = 4_096;

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

interface DueRow {
  id: unknown;
  label: string;
  period_key: string;
  part: unknown;
  text: string | null;
  attempts: unknown;
  first_failed_at: unknown;
  first_code: string | null;
  expires_at: unknown;
  parts_total: unknown;
}

async function deadRunPage(runId: number, label: string, periodKey: string, partsTotal: number | null): Promise<string> {
  const parts = await dbQuery<{ status: string; last_cause: string | null; attempts: unknown; first_failed_at: unknown; first_code: string | null }>(
    `SELECT status, last_cause, attempts, first_failed_at, first_code FROM telegram_digest_ledger
     WHERE label = ? AND period_key = ? AND part > 0 ORDER BY part`,
    [label, periodKey],
  );
  const dead = parts.find((p) => p.status === 'dead') ?? parts[0];
  const cause = dead?.last_cause ?? '';
  const pick = (k: string) => new RegExp(`${k}=("([^"]*)"|\\S+)`).exec(cause);
  const total = partsTotal ?? parts.length;
  const undelivered = parts.filter((p) => p.status !== 'delivered').length;
  const hostLog = (DIGEST_LABELS as readonly string[]).includes(label) ? digestRow(label as DigestLabel).host_log : 'n/a';
  return renderDeadPage({
    label,
    periodKey,
    runId,
    disposition: pick('disposition')?.[1] ?? 'unknown',
    code: pick('code')?.[1] ?? dead?.first_code ?? 'unknown',
    desc: pick('desc')?.[2] ?? '',
    attempts: num(dead?.attempts) ?? 0,
    firstFailedAtMs: num(dead?.first_failed_at),
    partsDelivered: Math.max(0, total - undelivered),
    partsTotal: total,
    hostLog,
  });
}

async function setRunDead(label: string, periodKey: string, nowMs: number, reason: string): Promise<void> {
  await dbQuery(
    `UPDATE telegram_digest_ledger SET status = 'dead', reason = ?, updated_at = ?
     WHERE label = ? AND period_key = ? AND part = 0 AND status <> 'dead' RETURNING id`,
    [reason, nowMs, label, periodKey],
  );
}

async function completeRunIfDrained(label: string, periodKey: string, nowMs: number): Promise<void> {
  const left = await dbQuery<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM telegram_digest_ledger WHERE label = ? AND period_key = ? AND part > 0 AND status <> 'delivered'`,
    [label, periodKey],
  );
  if ((num(left[0]?.n) ?? 1) === 0) {
    await dbQuery(
      `UPDATE telegram_digest_ledger SET status = 'delivered', updated_at = ?
       WHERE label = ? AND period_key = ? AND part = 0 AND status = 'queued' RETURNING id`,
      [nowMs, label, periodKey],
    );
  }
}

/**
 * Redeliver due parts. Runs at the END of `monitor --mode critical`, after the checks have
 * saved their state, so no critical check is ever delayed by it; the caller wraps it in a
 * fail-open try/catch. Bounded: at most `maxParts` parts and `wallClockMs` per tick.
 *
 * The registered-label filter sits INSIDE the selecting query — before `ORDER BY … LIMIT` —
 * so an unregistered or `__proof__` row can neither starve real parts nor be leased by
 * production. A delivered part is stamped (`delivered_at`, `tg_message_id`, `text` NULL)
 * IMMEDIATELY after the 200, in this function, before anything else can fail.
 */
export async function drainDigestLedger(opts: {
  nowMs: number;
  deps: DrainDeps;
  maxParts?: number;
  wallClockMs?: number;
  labels?: readonly string[];
  clock?: () => number;
}): Promise<DrainResult> {
  await ensureDigestLedgerSchema();
  const nowMs = opts.nowMs;
  const labels = opts.labels ?? DIGEST_LABELS;
  const maxParts = opts.maxParts ?? 3;
  const wallClockMs = opts.wallClockMs ?? 30_000;
  const clock = opts.clock ?? (() => Date.now());
  const started = clock();
  let delivered = 0;
  let queued = 0;
  let dead = 0;
  let paged = 0;

  const due = labels.length === 0 ? [] : await dbQuery<DueRow>(
    `SELECT p.id, p.label, p.period_key, p.part, p.text, p.attempts, p.first_failed_at, p.first_code, p.expires_at,
            (SELECT r.parts_total FROM telegram_digest_ledger r WHERE r.label = p.label AND r.period_key = p.period_key AND r.part = 0) AS parts_total
     FROM telegram_digest_ledger p
     WHERE p.status = 'queued' AND p.part > 0 AND p.next_attempt_at <= ? AND p.label IN (${placeholders(labels.length)})
     ORDER BY p.next_attempt_at, p.id
     LIMIT ?`,
    [nowMs, ...labels, maxParts],
  );

  for (const row of due) {
    if (clock() - started > wallClockMs) break;
    const id = num(row.id)!;
    const lease = await dbQuery<{ id: unknown }>(
      `UPDATE telegram_digest_ledger SET next_attempt_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued' AND next_attempt_at <= ? RETURNING id`,
      [nowMs + LEASE_MS, nowMs, id, nowMs],
    );
    if (lease.length === 0) continue; // another tick holds it

    const part = num(row.part) ?? 0;
    const attempts = (num(row.attempts) ?? 0) + 1;
    const expiresAt = num(row.expires_at);
    if (expiresAt != null && nowMs >= expiresAt) {
      await dbQuery(
        `UPDATE telegram_digest_ledger SET status = 'dead', last_cause = ?, updated_at = ? WHERE id = ? RETURNING id`,
        [`expired after the redelivery budget; last ${row.first_code ?? 'unknown'}`, nowMs, id],
      );
      await setRunDead(row.label, row.period_key, nowMs, 'redelivery budget exhausted');
      dead++;
      continue;
    }

    let text = row.text ?? '';
    const partsTotal = num(row.parts_total);
    if (partsTotal != null && part === partsTotal) {
      const footer = redeliveryFooter(nowMs, num(row.first_failed_at), row.first_code);
      if (text.length + footer.length <= TELEGRAM_LIMIT) text += footer;
    }

    const r = await opts.deps.send(text);
    if (r.ok) {
      await dbQuery(
        `UPDATE telegram_digest_ledger SET status = 'delivered', delivered_at = ?, tg_message_id = ?, text = NULL,
           attempts = ?, last_attempt_at = ?, updated_at = ? WHERE id = ? RETURNING id`,
        [nowMs, r.messageId ?? null, attempts, nowMs, nowMs, id],
      );
      delivered++;
      await completeRunIfDrained(row.label, row.period_key, nowMs);
      continue;
    }
    const f = r.failure;
    if (f?.disposition === 'transient' || !f) {
      await dbQuery(
        `UPDATE telegram_digest_ledger SET attempts = ?, last_attempt_at = ?, last_cause = ?, next_attempt_at = ?, updated_at = ?
         WHERE id = ? RETURNING id`,
        [attempts, nowMs, causeLine(f, attempts), nowMs + nextBackoffMs(attempts, r.retryAfterS ?? f?.retryAfterS ?? null), nowMs, id],
      );
      queued++;
      continue;
    }
    await dbQuery(
      `UPDATE telegram_digest_ledger SET status = 'dead', attempts = ?, last_attempt_at = ?, last_cause = ?, updated_at = ?
       WHERE id = ? RETURNING id`,
      [attempts, nowMs, causeLine(f, attempts), nowMs, id],
    );
    await setRunDead(row.label, row.period_key, nowMs, `redelivery rejected: ${f.disposition}`);
    dead++;
  }

  // Every DEAD run pages exactly once — here, or already in the producer process.
  if (labels.length > 0) {
    const unpaged = await dbQuery<{ id: unknown; label: string; period_key: string; parts_total: unknown }>(
      `SELECT id, label, period_key, parts_total FROM telegram_digest_ledger
       WHERE part = 0 AND status = 'dead' AND paged_at IS NULL AND label IN (${placeholders(labels.length)})
       ORDER BY id LIMIT 3`,
      [...labels],
    );
    for (const run of unpaged) {
      const runId = num(run.id)!;
      const msg = await deadRunPage(runId, run.label, run.period_key, num(run.parts_total));
      if ((await pageDeadRun({ runId, page: msg, nowMs, send: opts.deps.page })) === 'paged') paged++;
    }
  }

  const verdict: DrainResult['verdict'] = dead > 0 ? 'DEAD' : queued > 0 ? 'QUEUED' : delivered > 0 ? 'DELIVERED' : 'IDLE';
  const n = verdict === 'DEAD' ? dead : verdict === 'QUEUED' ? queued : delivered;
  const line =
    verdict === 'IDLE' && paged === 0
      ? '[ledger] DRAIN_VERDICT=IDLE'
      : `[ledger] DRAIN_VERDICT=${verdict}${verdict === 'IDLE' ? '' : ` ${n}`} (delivered=${delivered} queued=${queued} dead=${dead} paged=${paged})`;
  return { verdict, delivered, queued, dead, paged, line };
}
