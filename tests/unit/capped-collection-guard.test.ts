/**
 * OPS-CAPPED-COLLECTION-GUARD-W1 structural canary (2026-07-21).
 *
 * Makes "a public total computed by reducing over a LIMIT-capped page" un-shippable.
 *
 * ## What happened
 *
 * `getMerkleBatches(limit = 100)` was documented as "Get ALL Merkle batches" and
 * defaulted its limit, so no call site ever typed a number and the result LOOKED
 * complete. Two public figures on /track-record were computed from it and were wrong
 * for two days:
 *
 *   batches published : md.batches.length            -> 100      (true 102)
 *   calls verified    : md.batches.reduce(signal_count) -> 386,038 (true 387,834)
 *
 * The second could not be fixed client-side at all: the oldest batches are absent
 * from the payload at ANY limit, so the number was unobtainable downstream — it
 * needed a server-derived SUM (`total_signals`).
 *
 * The prior canary named the two regression SHAPES in the two known files. That
 * catches a revert, not a NEW consumer. These rules are repo-wide.
 *
 * ## The two rules
 *
 *   R1  Never aggregate over a capped collection. `.batches.reduce(...)` is banned
 *       outright; `.batches.length` is allowed ONLY as an emptiness guard, never as
 *       a value. Totals come from getMerkleBatchSummary() (SQL MAX/COUNT/SUM over
 *       the whole table).
 *
 *   R2  A truncating accessor must NAME its truncation. Every other one in this repo
 *       already does — getTopAssetsByOI, getSampleSignalsFromLatestBatch,
 *       listRecentLedger, topReferrers, listPendingNotifications,
 *       drainEmailNotifications. `getMerkleBatches` was the lone misnomer and it is
 *       the one that shipped wrong numbers. So: an exported array accessor with a
 *       DEFAULT limit must carry a truncation-signalling prefix (or drop the default
 *       and take the limit explicitly).
 *
 * Both detectors self-test in BOTH directions so they cannot silently stop matching.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_ = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename_), '..', '..');

const SCAN_ROOTS = [
  { dir: join(REPO_ROOT, 'src'), exts: ['.ts'] },
  { dir: join(REPO_ROOT, 'landing', 'js'), exts: ['.js'] },
  { dir: join(REPO_ROOT, 'scripts'), exts: ['.mjs', '.js'] },
];
const SKIP_DIR = /(^|[\\/])(node_modules|dist|\.claude|audits|archived)([\\/]|$)/;

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (SKIP_DIR.test(full)) continue;
    if (e.isDirectory()) walk(full, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x)) && statSync(full).isFile()) acc.push(full);
  }
  return acc;
}

function scanFiles(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  for (const { dir, exts } of SCAN_ROOTS) {
    for (const f of walk(dir, exts)) {
      out.push({ rel: relative(REPO_ROOT, f), src: readFileSync(f, 'utf-8') });
    }
  }
  return out;
}

// ── R1 detectors ──────────────────────────────────────────────────────────────

/** Any reduce over a `batches` collection — always an aggregate, always wrong here. */
const BATCHES_REDUCE_RE = /\.batches\s*\.\s*reduce\s*\(/g;

/**
 * `.batches.length` used as a VALUE. Emptiness/boolean guards are legitimate, so
 * allow BOTH a leading `!` (`if (!d.batches.length) return;`) and a following
 * comparison / boolean operator (`batches.length > 0`). Everything else — assignment,
 * concatenation, argument — is a value use and is flagged.
 *
 * The leading-`!` branch exists because this canary's own self-test caught its
 * absence on first run (render-jsx-static.mjs guards that way).
 */
const BATCHES_LENGTH_RE =
  /(!)?\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.batches\s*\.\s*length(?!\s*(?:[><]=?|===?|!==?|&&|\|\|))/g;

/**
 * Value-uses of `.batches.length`, i.e. offenders. A leading `!` marks an emptiness
 * guard (`if (!data.batches.length) return;`) and is NOT an offender — the negation
 * sits before the OBJECT, not before `.batches`, which is why a naive lookbehind on
 * the dot false-positives (it did, on render-jsx-static.mjs, until this self-tested).
 * Shared by the self-test and the scan so the two cannot drift apart.
 */
function findLengthValueUses(code: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  for (const m of code.matchAll(new RegExp(BATCHES_LENGTH_RE.source, 'g'))) {
    if (m[1] === '!') continue; // emptiness guard
    out.push({ text: m[0], index: m.index ?? 0 });
  }
  return out;
}

/**
 * Strip comments WITHOUT changing offsets, so reported line numbers point at the real
 * source. (Naively deleting comments shifts every subsequent line — the first version
 * of this canary reported lines ~1600 off.)
 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:])(\/\/[^\n]*)/g, (_m, p1, p2) => p1 + blank(p2));
}

// ── R2 detector ───────────────────────────────────────────────────────────────

/** `export [async] function NAME(... limit ... = ...): Promise<...[]>` */
const DEFAULTED_LIMIT_ARRAY_ACCESSOR_RE =
  /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*\blimit\b[^)]*=[^)]*)\)\s*:\s*Promise<[^>]*\[\]\s*>/g;

/** Names that declare their own truncation. */
const TRUNCATION_PREFIX_RE = /^(getTop|getRecent|getSample|getPage|listRecent|listPending|listTop|top|drain|peek|page)/;

describe('capped-collection guard', () => {
  it('self-test: R1 detectors match values but not emptiness guards', () => {
    const reduces = (s: string) => new RegExp(BATCHES_REDUCE_RE.source).test(s);
    const flags = (s: string) => findLengthValueUses(s).length > 0;
    // Banned: aggregates.
    expect(reduces('var t = md.batches.reduce(function(a,b){return a+b;},0);')).toBe(true);
    // Banned: length as a value (the exact /track-record regression).
    expect(flags("'Proof: ' + md.batches.length + ' batches'")).toBe(true);
    expect(flags('const n = merkle.batches.length;')).toBe(true);
    expect(flags('out.batchCount = String(data.batches.length);')).toBe(true);
    // Allowed: emptiness / boolean guards.
    expect(flags('if (md.batches && md.batches.length > 0) {')).toBe(false);
    expect(flags('if (!data.batches.length) return;')).toBe(false);
    expect(flags('if (d.batches.length === 0) return;')).toBe(false);
    expect(flags('x = a.batches.length && b;')).toBe(false);
  });

  it('self-test: stripComments preserves offsets so reported lines are real', () => {
    const src = 'line1\n/* a\n   multi-line\n   comment */\nconst x = 1; // trailing\nlineN\n';
    const stripped = stripComments(src);
    expect(stripped.split('\n').length).toBe(src.split('\n').length);
    expect(stripped.length).toBe(src.length);
    expect(stripped).not.toMatch(/multi-line/);
    expect(stripped).toMatch(/const x = 1;/);
  });

  it('self-test: R2 skips a genuine limit+offset pagination contract', () => {
    const paged =
      'export async function listSubscriberProfiles(opts: { limit?: number; offset?: number } = {}): Promise<Row[]> {';
    const m = new RegExp(DEFAULTED_LIMIT_ARRAY_ACCESSOR_RE.source).exec(paged);
    expect(m).not.toBeNull();
    expect(/\boffset\b/.test(m![2])).toBe(true); // → skipped as pagination
    // getMerkleBatches had NO offset: a top-N presented as the whole collection.
    const capped = new RegExp(DEFAULTED_LIMIT_ARRAY_ACCESSOR_RE.source).exec(
      'export async function getMerkleBatches(limit = 100): Promise<any[]> {',
    );
    expect(/\boffset\b/.test(capped![2])).toBe(false);
  });

  it('self-test: R2 detector matches a defaulted-limit array accessor', () => {
    const probe = 'export async function getMerkleBatches(limit = 100): Promise<any[]> {';
    const m = new RegExp(DEFAULTED_LIMIT_ARRAY_ACCESSOR_RE.source).exec(probe);
    expect(m?.[1]).toBe('getMerkleBatches');
    expect(TRUNCATION_PREFIX_RE.test('getMerkleBatches')).toBe(false); // the misnomer
    expect(TRUNCATION_PREFIX_RE.test('getRecentMerkleBatches')).toBe(true); // the fix
    expect(TRUNCATION_PREFIX_RE.test('getTopAssetsByOI')).toBe(true);
    // A REQUIRED limit is fine regardless of name — truncation is explicit at the call site.
    expect(
      new RegExp(DEFAULTED_LIMIT_ARRAY_ACCESSOR_RE.source).test(
        'export async function getRecentMerkleBatches(limit: number): Promise<any[]> {',
      ),
    ).toBe(false);
  });

  it('R1 — no code aggregates over a capped batches collection', () => {
    const offenders: string[] = [];
    for (const { rel, src } of scanFiles()) {
      const code = stripComments(src);
      const lineOf = (i: number) => code.slice(0, i).split('\n').length;
      for (const m of code.matchAll(new RegExp(BATCHES_REDUCE_RE.source, 'g'))) {
        offenders.push(`${rel}:${lineOf(m.index ?? 0)} → ${m[0].trim()}`);
      }
      for (const u of findLengthValueUses(code)) {
        offenders.push(`${rel}:${lineOf(u.index)} → ${u.text.trim()}`);
      }
    }
    expect(
      offenders,
      `A total/count derived from the LIMIT-capped \`batches\` page. It is wrong the moment more ` +
        `batches exist than the limit, and for SUMs it is unobtainable downstream at any limit. ` +
        `Use getMerkleBatchSummary() → { latest_batch_id, batch_count, total_signals } (SQL MAX/COUNT/SUM ` +
        `over the whole table), or the served fields of the same name.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('R2 — a truncating accessor names its truncation (or requires the limit)', () => {
    const offenders: string[] = [];
    for (const { rel, src } of scanFiles()) {
      if (!rel.startsWith('src')) continue;
      for (const m of stripComments(src).matchAll(new RegExp(DEFAULTED_LIMIT_ARRAY_ACCESSOR_RE.source, 'g'))) {
        const [, name, params] = m;
        // An `offset` alongside `limit` is an unambiguous PAGINATION contract — the
        // caller can page through the whole set and knows they hold a page. The
        // dangerous shape is a limit with NO offset, which is a top-N presented as
        // the complete collection (exactly what getMerkleBatches was).
        if (/\boffset\b/.test(params)) continue;
        if (!TRUNCATION_PREFIX_RE.test(name)) offenders.push(`${rel} → ${name}()`);
      }
    }
    expect(
      offenders,
      `An exported array accessor takes a DEFAULTED \`limit\`, so callers get a silently truncated ` +
        `page without ever typing a number — exactly how getMerkleBatches() shipped "Get ALL Merkle ` +
        `batches" while returning 100 of 102. Either name the truncation (getTop… / getRecent… / ` +
        `listRecent… / getSample… / drain…) or drop the default so the limit is explicit at each ` +
        `call site.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the summary accessor remains the only source of merkle totals', () => {
    const db = readFileSync(join(REPO_ROOT, 'src', 'lib', 'performance-db.ts'), 'utf-8');
    expect(db).toMatch(/MAX\(batch_id\)/);
    expect(db).toMatch(/COUNT\(\*\)/);
    expect(db).toMatch(/SUM\(signal_count\)/);
    // The misnomer must not come back.
    expect(db).not.toMatch(/export async function getMerkleBatches\s*\(/);
  });
});
