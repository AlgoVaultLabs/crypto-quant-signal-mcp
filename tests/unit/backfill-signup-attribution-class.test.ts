/**
 * FUNNEL-ATTRIBUTION-CLASSIFY-BACKFILL-W1 CH2 R6 — the bulk UPDATE cannot reach a live verdict.
 *
 * This wave writes to a LIVE table carrying 44 real classifier verdicts among 826 rows. The one
 * thing that must be impossible is overwriting one of those 44. Prose cannot establish that, and
 * neither can reading the SQL — so this suite EXECUTES the exported statements against a real
 * SQLite database and asserts what they actually touched.
 *
 * ── THE SEAM REPLACES THE CONNECTION, NEVER THE SQL ──────────────────────────────────────────
 * A hermetic self-test is structurally blind to exactly what its own seam replaces, so the seam
 * here is drawn as narrowly as it can be: `better-sqlite3` on a throwaway file, running the
 * VERBATIM exported `BACKFILL_CANDIDATE_SQL` / `botUpdateSql()` / `uaClassUpdateSql()` strings.
 * The statements under test are the ones the script ships; only the pool is different. A suite
 * that asserted on the strings instead would pass just as happily against SQL that does not
 * parse — which is the shape that let a `%`-formatted LIKE clause reach a canary's first live run.
 *
 * Each test gets its own database file. A shared one would collide under vitest's parallel
 * workers, and a fresh-DB WAL race is a known flake in this suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKFILL_CANDIDATE_SQL,
  botUpdateSql,
  uaClassUpdateSql,
  planBackfill,
  chunk,
  BATCH_SIZE,
  type CandidateRow,
} from '../../src/scripts/backfill-signup-attribution-class.js';

/** A UA `classifyTraffic` calls automated — the live wall pair's own UA. */
const BOT_UA = 'curl/7.81.0';
/** A UA the canonical classifier does NOT call automated. */
const HUMAN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const STAMP = '2026-09-10T12:00:00.000Z';

const SCRIPT_SRC = readFileSync(
  join(__dirname, '..', '..', 'src', 'scripts', 'backfill-signup-attribution-class.ts'), 'utf8');

/** Drop comment lines so a source-level ban does not also ban the prose explaining it. */
function stripComments(src: string): string {
  return src.split('\n').filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
}

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'av-backfill-'));
  db = new Database(join(dir, 'test.db'));
  // Same column set as `CREATE_SIGNUP_ATTRIBUTION_SQL` in `src/lib/subscriber-attribution.ts`.
  // The two DDLs' agreement is asserted by `signup-attribution-ddl-parity.test.ts`; here we only
  // need a table the real statements can run against.
  db.exec(`
    CREATE TABLE signup_attribution (
      client_reference_id TEXT PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT (datetime('now')),
      channel TEXT NOT NULL DEFAULT 'unknown',
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
      referrer TEXT, landing_path TEXT, tier_requested TEXT,
      ip_hash TEXT, user_agent TEXT,
      classification TEXT, ua_class TEXT, backfilled_at TIMESTAMP
    );`);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(rows: Array<Partial<Record<string, string | null>> & { id: string }>): void {
  const stmt = db.prepare(
    `INSERT INTO signup_attribution
       (client_reference_id, created_at, user_agent, classification, ua_class, backfilled_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((r, i) =>
    stmt.run(r.id, `2026-06-0${i + 1} 00:00:00`, r.user_agent ?? null, r.classification ?? null, r.ua_class ?? null, r.backfilled_at ?? null),
  );
}

const candidates = (): CandidateRow[] => db.prepare(BACKFILL_CANDIDATE_SQL).all() as CandidateRow[];

/** Whole-table fingerprint over the columns this job may touch. */
const fingerprint = (): string =>
  JSON.stringify(
    db.prepare('SELECT client_reference_id, classification, ua_class, backfilled_at FROM signup_attribution ORDER BY client_reference_id').all(),
  );

/** Run the real statements for a plan, exactly as `main()` does. */
function applyPlan(rows: readonly CandidateRow[]): number {
  const { groups } = planBackfill(rows);
  let written = 0;
  for (const g of groups) {
    for (const ids of chunk(g.ids)) {
      const sql = g.classification === 'bot' ? botUpdateSql(ids.length) : uaClassUpdateSql(ids.length);
      written += (db.prepare(sql).all(g.uaClass, STAMP, ...ids) as unknown[]).length;
    }
  }
  return written;
}

describe('R6(a) — the UPDATE cannot select a row that already carries a verdict', () => {
  it('the selector admits only the unclassified row', () => {
    seed([
      { id: 'live-browser', user_agent: HUMAN_UA, classification: 'browser', ua_class: 'browser' },
      { id: 'live-bot', user_agent: BOT_UA, classification: 'bot', ua_class: 'other' },
      { id: 'pre-ch1', user_agent: BOT_UA },
    ]);
    expect(candidates().map((r) => r.client_reference_id)).toEqual(['pre-ch1']);
  });

  it('the bot UPDATE, handed a live verdict\'s id ANYWAY, still refuses it', () => {
    // The selector is one guard; this is the other. If a future edit widens the SELECT, the
    // statement itself must still refuse — that is what `classification IS NULL` in its own WHERE
    // buys, and it is the assertion that would have caught the widening.
    seed([
      { id: 'live-browser', user_agent: HUMAN_UA, classification: 'browser', ua_class: 'browser' },
      { id: 'live-bot', user_agent: BOT_UA, classification: 'bot', ua_class: 'other' },
      { id: 'pre-ch1', user_agent: BOT_UA },
    ]);
    const ids = ['live-browser', 'live-bot', 'pre-ch1'];
    const touched = db.prepare(botUpdateSql(ids.length)).all('other', STAMP, ...ids) as Array<{ client_reference_id: string }>;
    expect(touched.map((r) => r.client_reference_id)).toEqual(['pre-ch1']);
    expect(db.prepare("SELECT classification FROM signup_attribution WHERE client_reference_id='live-browser'").get())
      .toEqual({ classification: 'browser' });
  });

  it('the ua_class UPDATE is STRUCTURALLY unable to change a verdict — it never names the column', () => {
    expect(uaClassUpdateSql(1)).not.toMatch(/SET[\s\S]*classification/i);
  });
});

describe('R6(c)(d)(e) — each row gets exactly the verdict its own UA implies', () => {
  beforeEach(() => {
    seed([
      { id: 'bot-row', user_agent: BOT_UA },
      { id: 'human-row', user_agent: HUMAN_UA },
      { id: 'no-ua-row', user_agent: null },
    ]);
    applyPlan(candidates());
  });

  const row = (id: string): Record<string, unknown> =>
    db.prepare('SELECT classification, ua_class, backfilled_at FROM signup_attribution WHERE client_reference_id = ?').get(id) as Record<string, unknown>;

  it('(d) an automated UA gets bot', () => {
    expect(row('bot-row')).toEqual({ classification: 'bot', ua_class: 'other', backfilled_at: STAMP });
  });

  it('(c) a browser-shaped UA is stamped and gets ua_class but keeps classification NULL', () => {
    expect(row('human-row')).toEqual({ classification: null, ua_class: 'browser', backfilled_at: STAMP });
  });

  it('(e) a no-UA row is stamped and nothing is invented', () => {
    // `unknown` is the canonical slug `classifyClient()` returns for an absent UA — the same value
    // the live path writes for such a row — so this is a recovery, not a fabrication.
    expect(row('no-ua-row')).toEqual({ classification: null, ua_class: 'unknown', backfilled_at: STAMP });
  });
});

describe('R6(b) — idempotence', () => {
  it('a second run scans zero rows and changes nothing', () => {
    seed([
      { id: 'bot-row', user_agent: BOT_UA },
      { id: 'human-row', user_agent: HUMAN_UA },
      { id: 'no-ua-row', user_agent: null },
    ]);
    expect(applyPlan(candidates())).toBe(3);
    const after = fingerprint();

    expect(candidates()).toHaveLength(0);
    expect(applyPlan(candidates())).toBe(0);
    expect(fingerprint()).toBe(after);
  });
});

describe('R6(f) — a dry run writes nothing', () => {
  it('planning is byte-for-byte non-mutating, including backfilled_at', () => {
    seed([
      { id: 'bot-row', user_agent: BOT_UA },
      { id: 'human-row', user_agent: HUMAN_UA },
      { id: 'no-ua-row', user_agent: null },
      { id: 'live-bot', user_agent: BOT_UA, classification: 'bot', ua_class: 'other' },
    ]);
    const before = fingerprint();
    const { tally } = planBackfill(candidates());
    expect(tally.scanned).toBe(3);
    expect(fingerprint()).toBe(before);
  });
});

describe('R6(g) — the verdict token is the only line a caller parses', () => {
  it('the script prints exactly one terminal token line, and exits 3 on INDETERMINATE', () => {
    const src = SCRIPT_SRC;
    const tokens = [...src.matchAll(/SIGNUP_ATTRIBUTION_BACKFILL_VERDICT=(\w+)/g)].map((m) => m[1]);
    expect(new Set(tokens)).toEqual(new Set(['PASS', 'INDETERMINATE']));
    // Never FAIL: "nothing to do" is a legitimate pass and this job has no notion of a wrong
    // answer, only of one it could not obtain.
    expect(tokens).not.toContain('FAIL');
    expect(src).toContain('const EXIT_INDETERMINATE = 3;');
    // The INDETERMINATE token is printed from exactly ONE place, and that place returns the code
    // rather than calling process.exit — two printers can disagree, and a process.exit inside main
    // would skip runScript's drain.
    expect([...src.matchAll(/console\.log\('SIGNUP_ATTRIBUTION_BACKFILL_VERDICT=INDETERMINATE'\)/g)]).toHaveLength(1);
    expect(src).toMatch(/VERDICT=INDETERMINATE'\);\s*\n\s*return EXIT_INDETERMINATE;/);
    // Strip comments before banning `process.exit` — the docstring EXPLAINS why the code returns
    // instead of calling it, and a naive grep would demand deleting the explanation. Same
    // discipline as `signup-intent.test.ts:101-108`.
    expect(stripComments(src)).not.toMatch(/process\.exit\(/);
  });

  it('terminates through runScript(), so a successful run cannot pin a Postgres connection', () => {
    // OPS-SCRIPT-EXIT-LIFECYCLE-W1: `allowExitOnIdle` is deliberately unset, so an explicit drain
    // is the ONLY exit path and a bare `main().catch()` tail makes a SUCCESSFUL run immortal. The
    // structural canary (tests/unit/script-exit-lifecycle-canary.test.ts) polices this across all
    // of src/scripts; asserted here too so this file's own contract is legible where it is edited.
    expect(SCRIPT_SRC).toMatch(/if \(require\.main === module\) \{\s*\n\s*void runScript\('backfill-signup-attribution-class', main\);/);
  });
});

describe('the tally counts what was written, not what was intended', () => {
  it('a row that already carries a verdict lands in already_classified_skipped, never in set_bot', () => {
    // Admitted by the selector because its ua_class is the NULL half. It must NOT be counted as a
    // recovery, and its verdict must survive.
    seed([{ id: 'verdict-no-uaclass', user_agent: BOT_UA, classification: 'browser' }]);
    const { tally } = planBackfill(candidates());
    expect(tally).toMatchObject({ scanned: 1, set_bot: 0, already_classified_skipped: 1 });

    applyPlan(candidates());
    expect(db.prepare("SELECT classification, ua_class FROM signup_attribution WHERE client_reference_id='verdict-no-uaclass'").get())
      .toEqual({ classification: 'browser', ua_class: 'other' });
  });

  it('the tally is a partition of scanned (no row counted twice, none dropped)', () => {
    seed([
      { id: 'a', user_agent: BOT_UA }, { id: 'b', user_agent: HUMAN_UA },
      { id: 'c', user_agent: null }, { id: 'd', user_agent: '   ' },
      { id: 'e', user_agent: BOT_UA, classification: 'bot' },
    ]);
    const { tally } = planBackfill(candidates());
    expect(tally.set_bot + tally.set_ua_class_only + tally.skipped_no_ua + tally.already_classified_skipped)
      .toBe(tally.scanned);
    // A whitespace-only UA is an ABSENT one, matching the live path's trimmed `ua &&` gate.
    expect(tally.skipped_no_ua).toBe(2);
  });
});

describe('batching', () => {
  it('splits an oversized group into statement-sized chunks and writes every row once', () => {
    const n = BATCH_SIZE + 7;
    seed(Array.from({ length: n }, (_, i) => ({ id: `bulk-${i}`, user_agent: BOT_UA })));
    const rows = candidates();
    expect(rows).toHaveLength(n);

    const { groups } = planBackfill(rows);
    expect(groups).toHaveLength(1);
    expect(chunk(groups[0].ids).map((c) => c.length)).toEqual([BATCH_SIZE, 7]);

    expect(applyPlan(rows)).toBe(n);
    expect(db.prepare("SELECT count(*) AS n FROM signup_attribution WHERE classification='bot' AND backfilled_at IS NOT NULL").get())
      .toEqual({ n });
  });
});
