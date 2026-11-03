/**
 * OPS-AUDIT-REMEDIATION-HIGH-W2-R2 CH2 — SECR-03: one key-reveal primitive; `/welcome` is its first consumer.
 *
 * THE DEFECT, at e0f0daa3. `GET /welcome?session_id=` rendered the customer's CURRENT key for any Checkout
 * Session that had a customer: no status, payment, age or single-use check, no limiter, no `no-store`. A
 * completed session id never expires, so one leaked id was a permanent bearer of the key, and rotating the
 * key would only have re-exposed the new one.
 *
 * THE RULE PINNED HERE. `revealKeyOnce` (src/lib/key-reveal.ts) reveals a key only for an id shaped like a
 * Checkout Session id (judged BEFORE any Stripe call), of a session that is complete, paid and at most 24 h
 * old, and only on the first view: an atomic claim on sha256('key-reveal-v1:' + id) through the shared
 * `tryClaimOnce`. A key not minted yet is `pending` and consumes nothing. Every refusal renders ONE arm.
 *
 * BACKENDS. The behaviour suites claim against whatever backend this process has: a private SQLite file
 * here, real Postgres on the Postgres lane (DATABASE_URL set). The last suite pins the Postgres SQL itself
 * with a mocked dbQuery, because a suite that only ever took the SQLite branch once shipped an ON CONFLICT
 * target Postgres could not infer (the LOW-W2 lesson) — so AC 2.4 is asserted on emitted SQL, not inferred.
 *
 * `key-reveal.js` is imported inside each suite, not at the top, so a missing module fails those suites'
 * tests while the route-wiring suite still reports its own assertions.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDbAsync } from '../../src/lib/performance-db.js';
import { getWelcomePageHtml, getWelcomeRevealHtml } from '../../src/lib/welcome-page.js';
import { stripComments } from '../../scripts/lib/strip-comments.mjs';

type KeyRevealModule = typeof import('../../src/lib/key-reveal.js');
type Outcome = Awaited<ReturnType<KeyRevealModule['revealKeyOnce']>>;

/** What `getCustomerApiKey` hands the primitive: the key it would render, and the session facts it is judged on. */
interface SessionView {
  apiKey: string | null;
  tier: string | null;
  email: string | null;
  status: string | null;
  paymentStatus: string | null;
  created: number | null;
}

// ONE Stripe seam: the module the primitive calls. Its call count IS the "Stripe calls" of AC 2.3.
const stripe = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  getCustomerApiKey: vi.fn(),
}));
vi.mock('../../src/lib/stripe.js', () => ({
  getCustomerApiKey: (id: string) => stripe.getCustomerApiKey(id),
}));

const DAY_S = 24 * 60 * 60;
const FROZEN_COPY = 'This key was already shown. Get it again by email from your account page.';
const PAGE_OPTS = { newSignupEnabled: true, oauthProviders: { google: true, github: true } };

const nowS = (): number => Math.floor(Date.now() / 1000);
const newId = (mode: 'live' | 'test' = 'test'): string => `cs_${mode}_${randomBytes(12).toString('hex')}`;
const newKey = (): string => `av_live_${randomBytes(12).toString('hex')}`;

function paidSession(over: Partial<SessionView> = {}): SessionView {
  return {
    apiKey: newKey(),
    tier: 'starter',
    email: 'buyer@example.com',
    status: 'complete',
    paymentStatus: 'paid',
    created: nowS() - 60,
    ...over,
  };
}

/** Make `id` resolve to `view` at the Stripe seam; an unstaged id throws as Stripe's `resource_missing` does. */
function stage(id: string, view: SessionView): SessionView {
  stripe.sessions.set(id, view);
  return view;
}

function resetStripe(): void {
  stripe.getCustomerApiKey.mockReset();
  stripe.getCustomerApiKey.mockImplementation(async (id: string) => {
    const v = stripe.sessions.get(id);
    if (!v) throw new Error(`No such checkout.session: '${id}'`);
    return { ...(v as SessionView) };
  });
}

/** Visible text: scripts, styles and tags dropped, whitespace collapsed. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ');
}

// A private SQLite file for the claim table — outside the work tree (the tree-byproducts gate), set before
// the backend first opens. On the Postgres lane DATABASE_URL wins and the same suites claim on Postgres.
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-key-reveal-'));
let originalDbPath: string | undefined;

beforeAll(async () => {
  originalDbPath = process.env.PERFORMANCE_DB_PATH;
  process.env.PERFORMANCE_DB_PATH = path.join(DB_DIR, 'performance.db');
  await closeDbAsync();
});

afterAll(async () => {
  await closeDbAsync();
  if (originalDbPath === undefined) delete process.env.PERFORMANCE_DB_PATH;
  else process.env.PERFORMANCE_DB_PATH = originalDbPath;
  fs.rmSync(DB_DIR, { recursive: true, force: true });
});

describe('revealKeyOnce — which sessions may reveal a key (AC 2.1, AC 2.3)', () => {
  let kr: KeyRevealModule;
  beforeAll(async () => {
    kr = await import('../../src/lib/key-reveal.js');
  });
  beforeEach(resetStripe);

  it('AC 2.1 — a completed, paid session created 150 days ago reveals nothing, and claims nothing', async () => {
    const id = newId('live');
    const v = stage(id, paidSession({ created: nowS() - 150 * DAY_S }));
    const r = await kr.revealKeyOnce(id);
    expect(r).toEqual({ kind: 'refused', reason: 'stale' });
    expect(JSON.stringify(r)).not.toContain(v.apiKey);
    // Refused BEFORE the claim: the same id, were it fresh, would still reveal.
    stage(id, { ...v, created: nowS() - 60 });
    expect(await kr.revealKeyOnce(id)).toEqual({ kind: 'reveal', apiKey: v.apiKey, tier: v.tier, email: v.email });
  });

  it('the bound is 24 h, Stripe’s session lifetime: just inside reveals, just outside refuses', async () => {
    const inside = newId();
    const inView = stage(inside, paidSession({ created: nowS() - DAY_S + 30 }));
    expect(await kr.revealKeyOnce(inside)).toMatchObject({ kind: 'reveal', apiKey: inView.apiKey });
    const outside = newId();
    stage(outside, paidSession({ created: nowS() - DAY_S - 30 }));
    expect(await kr.revealKeyOnce(outside)).toEqual({ kind: 'refused', reason: 'stale' });
  });

  it.each([
    ['open, unpaid', { status: 'open', paymentStatus: 'unpaid' }, 'not_complete'],
    ['expired, unpaid', { status: 'expired', paymentStatus: 'unpaid' }, 'not_complete'],
    ['complete, unpaid (an async payment still pending)', { status: 'complete', paymentStatus: 'unpaid' }, 'not_paid'],
    ['complete, payment status unknown', { status: 'complete', paymentStatus: null }, 'not_paid'],
    ['status unknown', { status: null }, 'not_complete'],
    ['creation time unknown', { created: null }, 'stale'],
  ] as const)('AC 2.3 — %s reveals nothing, and claims nothing', async (_label, facts, reason) => {
    const id = newId();
    const v = stage(id, paidSession(facts));
    const r = await kr.revealKeyOnce(id);
    expect(r).toEqual({ kind: 'refused', reason });
    expect(JSON.stringify(r)).not.toContain(v.apiKey);
    stage(id, { ...v, status: 'complete', paymentStatus: 'paid', created: nowS() - 60 });
    expect(await kr.revealKeyOnce(id)).toMatchObject({ kind: 'reveal', apiKey: v.apiKey });
  });

  it('a session whose payment was not required (a 100 % coupon) reveals', async () => {
    const id = newId();
    const v = stage(id, paidSession({ paymentStatus: 'no_payment_required' }));
    expect(await kr.revealKeyOnce(id)).toEqual({ kind: 'reveal', apiKey: v.apiKey, tier: v.tier, email: v.email });
  });

  it('Stripe not configured (every fact null) reveals nothing', async () => {
    const id = newId();
    stage(id, { apiKey: null, tier: null, email: null, status: null, paymentStatus: null, created: null });
    expect((await kr.revealKeyOnce(id)).kind).toBe('refused');
  });

  it('AC 2.3 — a malformed id is refused with zero Stripe calls', async () => {
    const malformed: unknown[] = [
      undefined, null, '', 42, ['cs_live_a1B2'], { id: 'cs_live_a1B2' },
      'cs_live_', 'cs_test_', 'cs_prod_a1B2', 'CS_LIVE_a1B2', 'cs_live_a1B2!', 'cs_live_a1 B2', ' cs_live_a1B2',
      'cs_live_a1B2\n', 'cs_live_a1B2%00', 'cs_live_a1/../../v1/customers', 'cs_live_a1B2?expand[]=customer',
      'pi_3NabcDEF', 'sub_1NabcDEF',
    ];
    for (const id of malformed) {
      expect(await kr.revealKeyOnce(id), JSON.stringify(id)).toEqual({ kind: 'refused', reason: 'malformed_id' });
    }
    expect(stripe.getCustomerApiKey).not.toHaveBeenCalled();
    // The seam is live: a well-formed id IS looked up, exactly once.
    const id = newId();
    stage(id, paidSession());
    await kr.revealKeyOnce(id);
    expect(stripe.getCustomerApiKey).toHaveBeenCalledTimes(1);
    expect(stripe.getCustomerApiKey).toHaveBeenCalledWith(id);
  });

  it('a key not minted yet is pending and consumes nothing: the reload the pending arm asks for reveals it', async () => {
    const id = newId();
    const v = stage(id, paidSession({ apiKey: null }));
    expect(await kr.revealKeyOnce(id)).toEqual({ kind: 'pending', tier: v.tier, email: v.email });
    const key = newKey();
    stage(id, { ...v, apiKey: key });
    expect(await kr.revealKeyOnce(id)).toEqual({ kind: 'reveal', apiKey: key, tier: v.tier, email: v.email });
  });

  it('a stale session is refused even before its key is minted — never pending', async () => {
    const id = newId();
    stage(id, paidSession({ apiKey: null, created: nowS() - 150 * DAY_S }));
    expect(await kr.revealKeyOnce(id)).toEqual({ kind: 'refused', reason: 'stale' });
  });

  it('a Stripe error is not a reveal: it reaches the route’s error arm and claims nothing', async () => {
    const id = newId();
    await expect(kr.revealKeyOnce(id)).rejects.toThrow(/No such checkout\.session/);
    const v = stage(id, paidSession());
    expect(await kr.revealKeyOnce(id)).toMatchObject({ kind: 'reveal', apiKey: v.apiKey });
  });
});

describe('revealKeyOnce — once (AC 2.2)', () => {
  let kr: KeyRevealModule;
  beforeAll(async () => {
    kr = await import('../../src/lib/key-reveal.js');
  });
  beforeEach(resetStripe);

  it('a fresh paid session reveals its key once; the second view is the already-shown arm', async () => {
    const id = newId('live');
    const v = stage(id, paidSession());
    expect(await kr.revealKeyOnce(id)).toEqual({ kind: 'reveal', apiKey: v.apiKey, tier: v.tier, email: v.email });
    const second = await kr.revealKeyOnce(id);
    expect(second).toEqual({ kind: 'refused', reason: 'already_shown' });
    const html = getWelcomeRevealHtml(second, PAGE_OPTS);
    expect(html).not.toContain(v.apiKey);
    expect(html).not.toContain(v.email);
    expect(textOf(html)).toContain(FROZEN_COPY);
  });

  it.each([2, 8])('%i concurrent views of one fresh session reveal once', async (n) => {
    const id = newId();
    const v = stage(id, paidSession());
    const outcomes: Outcome[] = await Promise.all(Array.from({ length: n }, () => kr.revealKeyOnce(id)));
    expect(outcomes.filter((o) => o.kind === 'reveal')).toEqual([
      { kind: 'reveal', apiKey: v.apiKey, tier: v.tier, email: v.email },
    ]);
    expect(outcomes.filter((o) => o.kind !== 'reveal')).toEqual(
      Array.from({ length: n - 1 }, () => ({ kind: 'refused', reason: 'already_shown' })),
    );
  });

  it('the claim is per session: a second checkout by the same customer reveals the key once more', async () => {
    const key = newKey();
    const a = newId();
    const b = newId();
    stage(a, paidSession({ apiKey: key }));
    stage(b, paidSession({ apiKey: key }));
    expect(await kr.revealKeyOnce(a)).toMatchObject({ kind: 'reveal', apiKey: key });
    expect(await kr.revealKeyOnce(b)).toMatchObject({ kind: 'reveal', apiKey: key });
    expect(await kr.revealKeyOnce(a)).toEqual({ kind: 'refused', reason: 'already_shown' });
  });
});

describe('the /welcome arm each outcome renders', () => {
  const REFUSALS = ['malformed_id', 'not_complete', 'not_paid', 'stale', 'already_shown', 'indeterminate'] as const;

  it('every refusal renders ONE already-shown arm: the frozen copy, linking /account, and nothing of the session', () => {
    const arms = REFUSALS.map((reason) => getWelcomeRevealHtml({ kind: 'refused', reason }, PAGE_OPTS));
    // One arm for every reason, so the page is no oracle for which check failed.
    expect(new Set(arms).size).toBe(1);
    const html = arms[0];
    expect(textOf(html)).toContain(FROZEN_COPY);
    expect(html).toMatch(/<a href="\/account"[^>]*>account page<\/a>/);
    expect(html).not.toContain('id="api-key"');
    expect(html).not.toContain('t.me/algovaultofficialbot?start=auth_');
    expect(html).not.toContain('class="paywall-cta"');
    expect(html).not.toContain('id="signup-email-form"');
    expect(html).not.toContain('being provisioned');
    expect(html).not.toContain('Setting up your account');
  });

  it('the already-shown arm carries no sign-in card when the unified sign-in is on either', () => {
    const html = getWelcomeRevealHtml({ kind: 'refused', reason: 'already_shown' }, { ...PAGE_OPTS, unifiedSignin: true });
    expect(html).toBe(getWelcomeRevealHtml({ kind: 'refused', reason: 'already_shown' }, PAGE_OPTS));
  });

  it('a reveal renders the existing key arm, and pending the existing pending arm, byte for byte', () => {
    const key = newKey();
    expect(getWelcomeRevealHtml({ kind: 'reveal', apiKey: key, tier: 'starter', email: 'buyer@example.com' }, PAGE_OPTS))
      .toBe(getWelcomePageHtml(key, 'starter', 'buyer@example.com', PAGE_OPTS));
    expect(getWelcomeRevealHtml({ kind: 'pending', tier: 'starter', email: 'buyer@example.com' }, PAGE_OPTS))
      .toBe(getWelcomePageHtml(null, 'starter', 'buyer@example.com', PAGE_OPTS));
  });
});

describe('the /welcome route reveals only through the primitive (source)', () => {
  const REPO = fileURLToPath(new URL('../../', import.meta.url));
  const code = (rel: string): string => stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'), rel);
  const srcTsFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return srcTsFiles(p);
      return e.name.endsWith('.ts') ? [path.relative(REPO, p)] : [];
    });

  it('only key-reveal.ts calls getCustomerApiKey — no surface renders a Checkout key around the rule', () => {
    const files = srcTsFiles(path.join(REPO, 'src'));
    expect(files.length).toBeGreaterThan(100);
    const callers = files.filter((rel) =>
      /\bgetCustomerApiKey\s*\(/.test(code(rel).replace(/\bfunction\s+getCustomerApiKey\s*\(/g, '')),
    );
    expect(callers).toEqual(['src/lib/key-reveal.ts']);
  });

  it('the session_id arm is rate-limited, never cached, sends no Referer, and renders the reveal', () => {
    const index = code('src/index.ts');
    const start = index.search(/app\.get\(\s*'\/welcome'\s*,/);
    expect(start, 'the /welcome registration was not found — a miss is vacuity, never a pass').toBeGreaterThan(-1);
    const end = index.indexOf('\n  });\n', start);
    expect(end).toBeGreaterThan(start);
    const route = index.slice(start, end);
    expect(route).toMatch(/^app\.get\(\s*'\/welcome'\s*,\s*welcomeKeyLimiter\s*,/);
    expect(route).toMatch(/res\.setHeader\(\s*'Cache-Control'\s*,\s*'no-store'\s*\)/);
    expect(route).toMatch(/res\.setHeader\(\s*'Referrer-Policy'\s*,\s*'no-referrer'\s*\)/);
    expect(route).toMatch(/getWelcomeRevealHtml\(\s*await\s+revealKeyOnce\(/);
    // recoverKeyLimiter's shape, on the session_id arm only: the organic arm stays unlimited.
    const limiter = /const welcomeKeyLimiter = rateLimit\(\{([\s\S]*?)\}\);/.exec(index);
    expect(limiter, 'welcomeKeyLimiter is not declared as a rateLimit').not.toBeNull();
    expect(limiter![1]).toMatch(/windowMs:\s*60 \* 60 \* 1000,/);
    expect(limiter![1]).toMatch(/max:\s*5,/);
    expect(limiter![1]).toMatch(/skip:[^\n]*session_id/);
  });
});

// LAST in the file: it swaps performance-db for a recorder, and swaps it back in afterAll.
describe('AC 2.4 — the claim on the Postgres SQL path', () => {
  const pg = {
    calls: [] as { sql: string; params: unknown[] }[],
    events: [] as string[],
    insert: 'won' as 'won' | 'lost' | 'throw',
    createFailures: 0,
  };
  let savedDatabaseUrl: string | undefined;
  let kr: KeyRevealModule;

  const stripSql = (sql: string): string => sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const cols = (list: string): string[] => list.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  function primaryKeyOf(ddl: string): string[] {
    const sql = stripSql(ddl);
    const tableLevel = /PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(sql);
    if (tableLevel) return cols(tableLevel[1]);
    return [...sql.matchAll(/\b([a-z_][a-z0-9_]*)\s+[a-z]+(?:\s*\(\s*\d+\s*\))?\s+(?:NOT\s+NULL\s+)?PRIMARY\s+KEY\b/gi)]
      .map((m) => m[1].toLowerCase());
  }
  const onConflictOf = (sql: string): string[] => {
    const m = /ON\s+CONFLICT\s*\(([^)]+)\)/i.exec(stripSql(sql));
    return m ? cols(m[1]) : [];
  };
  const creates = () => pg.calls.filter((c) => /^\s*CREATE\s+TABLE/i.test(c.sql));
  const inserts = () => pg.calls.filter((c) => /^\s*INSERT/i.test(c.sql));

  beforeAll(() => {
    savedDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://x';
    vi.doMock('../../src/lib/performance-db.js', () => ({
      isPgBackend: () => !!process.env.DATABASE_URL,
      dbExec: (sql: string) => {
        pg.events.push('exec');
        pg.calls.push({ sql, params: [] });
      },
      dbRun: () => {
        pg.events.push('run');
      },
      dbQuery: async (sql: string, params: unknown[] = []) => {
        pg.calls.push({ sql, params });
        if (/^\s*CREATE\s+TABLE/i.test(sql)) {
          pg.events.push('create:start');
          await new Promise((r) => setTimeout(r, 5));
          if (pg.createFailures > 0) {
            pg.createFailures--;
            pg.events.push('create:fail');
            throw new Error('canceling statement due to lock timeout');
          }
          pg.events.push('create:done');
          return [];
        }
        if (/^\s*INSERT/i.test(sql)) {
          pg.events.push('insert');
          if (pg.insert === 'throw') throw new Error('connection terminated unexpectedly');
          return pg.insert === 'won' ? [{ claim_hash: params[0] }] : [];
        }
        return [];
      },
    }));
  });

  beforeEach(async () => {
    resetStripe();
    pg.calls.length = 0;
    pg.events.length = 0;
    pg.insert = 'won';
    pg.createFailures = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules(); // a cold process per test: the once-per-process ensure starts unrun
    kr = await import('../../src/lib/key-reveal.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.doUnmock('../../src/lib/performance-db.js');
    vi.resetModules();
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
  });

  it('the ensure is AWAITED through dbQuery before the first INSERT — never the fire-and-forget dbExec', async () => {
    const id = newId();
    const v = stage(id, paidSession());
    expect(await kr.revealKeyOnce(id)).toEqual({ kind: 'reveal', apiKey: v.apiKey, tier: v.tier, email: v.email });
    expect(pg.events).toEqual(['create:start', 'create:done', 'insert']);
  });

  it('the ON CONFLICT target is the DDL primary key, on the table the DDL creates, and it never updates', async () => {
    const id = newId();
    stage(id, paidSession());
    await kr.revealKeyOnce(id);
    expect(creates()).toHaveLength(1);
    expect(inserts()).toHaveLength(1);
    const ddl = creates()[0].sql;
    const insert = inserts()[0].sql;
    const pk = primaryKeyOf(ddl);
    const target = onConflictOf(insert);
    // Both parsed non-empty FIRST: two failed parses would compare equal and pass vacuously.
    expect(pk.length).toBeGreaterThan(0);
    expect(target.length).toBeGreaterThan(0);
    expect(new Set(target)).toEqual(new Set(pk));
    expect(pk).toEqual(['claim_hash']);
    expect(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/i.exec(ddl)?.[1]).toBe('key_reveal_claims');
    expect(/INSERT\s+INTO\s+([a-z_]+)/i.exec(insert)?.[1]).toBe('key_reveal_claims');
    expect(stripSql(insert)).toMatch(/DO\s+NOTHING/i);
    expect(stripSql(insert)).not.toMatch(/DO\s+UPDATE/i);
    expect(stripSql(insert)).toMatch(/RETURNING\s+claim_hash/i);
    expect(stripSql(insert)).not.toMatch(/INSERT\s+OR\s+IGNORE/i);
  });

  it('the claim key is sha256("key-reveal-v1:" + id) — a sibling hash domain, never the raw id', async () => {
    const id = newId('live');
    stage(id, paidSession());
    await kr.revealKeyOnce(id);
    const insert = inserts()[0];
    const columns = cols(/INSERT\s+INTO\s+[a-z_]+\s*\(([^)]+)\)/i.exec(insert.sql)![1]);
    const hash = insert.params[columns.indexOf('claim_hash')];
    expect(hash).toBe(createHash('sha256').update(`key-reveal-v1:${id}`).digest('hex'));
    const recorded = JSON.stringify(pg.calls);
    expect(recorded).not.toContain(id);
    expect(recorded).not.toContain(id.slice('cs_live_'.length));
  });

  it('a lost race (no row returned) is the already-shown arm', async () => {
    pg.insert = 'lost';
    const id = newId();
    const v = stage(id, paidSession());
    const r = await kr.revealKeyOnce(id);
    expect(r).toEqual({ kind: 'refused', reason: 'already_shown' });
    expect(JSON.stringify(r)).not.toContain(v.apiKey);
  });

  it('a database fault is INDETERMINATE: nothing is revealed', async () => {
    pg.insert = 'throw';
    const id = newId();
    const v = stage(id, paidSession());
    const r = await kr.revealKeyOnce(id);
    expect(r).toEqual({ kind: 'refused', reason: 'indeterminate' });
    expect(JSON.stringify(r)).not.toContain(v.apiKey);
  });

  it('a failed ensure reveals nothing, issues no INSERT, and the next view retries it', async () => {
    pg.createFailures = 1;
    const id = newId();
    const v = stage(id, paidSession());
    expect(await kr.revealKeyOnce(id)).toEqual({ kind: 'refused', reason: 'indeterminate' });
    expect(pg.events).toEqual(['create:start', 'create:fail']);
    expect(await kr.revealKeyOnce(id)).toEqual({ kind: 'reveal', apiKey: v.apiKey, tier: v.tier, email: v.email });
    expect(pg.events).toEqual(['create:start', 'create:fail', 'create:start', 'create:done', 'insert']);
  });

  it('concurrent first views on a cold process share ONE CREATE', async () => {
    const a = newId();
    const b = newId();
    stage(a, paidSession());
    stage(b, paidSession());
    const outcomes = await Promise.all([kr.revealKeyOnce(a), kr.revealKeyOnce(b)]);
    expect(outcomes.map((o) => o.kind)).toEqual(['reveal', 'reveal']);
    expect(creates()).toHaveLength(1);
    expect(inserts()).toHaveLength(2);
  });
});
