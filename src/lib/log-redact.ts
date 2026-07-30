/**
 * Structural log redaction — OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch1 (SEC-14).
 *
 * WHY THIS EXISTS. `PgBackend.trackedWrite` logs the full SQL plus every bound
 * parameter when a fire-and-forget write is finally lost. Those params include
 * freshly-minted API keys and subscriber emails (`free-keys-store.ts`,
 * `referral-store.ts`), so a sustained Postgres outage wrote working credentials
 * into stdout — retained by `docker logs`, any log shipper, and anyone with host
 * access — while the account row itself was never persisted, so nothing rotates it.
 *
 * REDACT BY STRUCTURE, NEVER BY VENDOR PREFIX (CLAUDE.md law). Key formats drift
 * (`AIza…`→`AQ.…`, `sk-…`→`sk-proj-…`, and our own `av_free_`/`av_live_`), so a
 * deny-list of known prefixes silently stops matching the day a format changes.
 * Instead:
 *
 *   • `redactParams` is TOTAL over strings — every string parameter becomes
 *     `len + sha16` regardless of what it contains. No new credential format can
 *     defeat it, because nothing is pattern-matched. Numbers/booleans/null pass
 *     through: they are not credential-bearing and carry most of the diagnostic
 *     value (row ids, cents, flags).
 *   • `redactErrorText` masks the value-bearing SPANS of a free-text error. The
 *     exception message is a SECOND leak path the params fix alone does not close:
 *     Postgres embeds the offending VALUE in a unique-violation detail
 *     (`Key (api_key)=(av_free_…) already exists`).
 *
 * The SQL SHAPE stays loggable — that is the entire diagnostic value of the line,
 * and a parameterized statement carries no values. `redactSqlShape` additionally
 * masks single-quoted literals so that even a future call site that interpolates a
 * value into the SQL string cannot leak it here (defense in depth; the call sites
 * themselves are asserted by `scripts/check-secret-log-redaction.mjs`).
 *
 * POSTGRES QUOTING IS THE STRUCTURAL SIGNAL: single quotes delimit *literals*
 * (values — redact), double quotes delimit *identifiers* (table/column names — keep,
 * they are not secret and they are what makes an error diagnosable).
 */
import { createHash } from 'node:crypto';

/** Non-reversible descriptor of a value: how long it was, and which value it was. */
export function fingerprint(value: string): string {
  const sha16 = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
  return `len=${value.length} sha16=${sha16}`;
}

/** Postgres constraint-violation detail: `Key (col, col)=(val, val)`. */
const PG_KEY_DETAIL_RE = /(Key\s*\([^)]*\)\s*=\s*)\(([^)]*)\)/g;
/** Email-shaped run — PII, and short enough to slip past the labelled-value rule. */
const EMAIL_RE = /[^\s<>()[\]{},;:"']+@[^\s<>()[\]{},;:"']+\.[A-Za-z]{2,}/g;
/** Single-quoted Postgres LITERAL (a value). Double-quoted identifiers are kept. */
const SQ_LITERAL_RE = /'([^']*)'/g;
/** `LABEL=VALUE` / `LABEL: VALUE` with a value long enough to be worth hiding. */
const LABELLED_RE = /\b([A-Za-z_][A-Za-z0-9_.-]{0,40})\s*[=:]\s*([^\s,;)]{8,})/g;

/**
 * Mask every value-bearing span of a free-text message, keeping the surrounding
 * diagnostic prose (constraint name, error class, identifiers) intact.
 *
 * Redactions are parked behind NUL-delimited placeholders while the passes run, so
 * a later pass cannot re-redact an earlier pass's `len=…`/`sha16=…` output. That
 * also makes the function idempotent-safe under composition.
 */
export function redactErrorText(text: string): string {
  if (!text) return text;
  const held: string[] = [];
  const hold = (raw: string): string => {
    held.push(`⟪redacted ${fingerprint(raw)}⟫`);
    return `\u0000${held.length - 1}\u0000`;
  };
  const masked = text
    .replace(PG_KEY_DETAIL_RE, (_m, lead: string, val: string) => `${lead}(${hold(val)})`)
    .replace(EMAIL_RE, (m: string) => hold(m))
    .replace(SQ_LITERAL_RE, (_m, val: string) => `'${hold(val)}'`)
    .replace(LABELLED_RE, (_m, label: string, val: string) => `${label}=${hold(val)}`);
  return masked.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]);
}

/** Keep the statement shape; mask any interpolated single-quoted literal. */
export function redactSqlShape(sql: string, maxLen = 500): string {
  if (!sql) return sql;
  const masked = sql.replace(SQ_LITERAL_RE, (_m, val: string) =>
    val.length === 0 ? "''" : `'⟪redacted ${fingerprint(val)}⟫'`);
  return masked.length > maxLen ? `${masked.slice(0, maxLen)}…` : masked;
}

/**
 * Render bound parameters with every STRING replaced by its fingerprint. Total by
 * construction: there is no branch in which a string parameter's content survives.
 */
export function redactParams(params: readonly unknown[], maxLen = 500): string {
  const parts = params.map((p) => {
    if (p === null || p === undefined) return 'null';
    switch (typeof p) {
      case 'number':
      case 'boolean':
        return String(p);
      case 'bigint':
        return `${p}n`;
      case 'string':
        return `<str ${fingerprint(p)}>`;
      default:
        break;
    }
    if (p instanceof Date) return `<date ${p.toISOString()}>`;
    if (ArrayBuffer.isView(p) || p instanceof ArrayBuffer) {
      const len = p instanceof ArrayBuffer ? p.byteLength : p.byteLength;
      return `<bin bytes=${len}>`;
    }
    let json: string;
    try {
      json = JSON.stringify(p) ?? String(p);
    } catch {
      json = String(p);
    }
    return `<json ${fingerprint(json)}>`;
  });
  const out = `[${parts.join(',')}]`;
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out;
}

/**
 * The single formatter for the write-loss line. Exported (rather than inlined into
 * the private `trackedWrite`) so the redaction contract is directly testable without
 * standing up a pg pool — the seam that made this defect untestable before.
 */
export function formatWriteLossLog(
  label: string,
  attempts: number,
  error: unknown,
  sql: string,
  params: readonly unknown[],
): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    `[pg-write] WRITE LOST after ${attempts} attempt(s) [${label}]: ` +
    `${redactErrorText(raw)} :: SQL=${redactSqlShape(sql)} PARAMS=${redactParams(params)}`
  );
}
