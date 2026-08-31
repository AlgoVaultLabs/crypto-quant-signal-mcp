/**
 * pg-ddl-barrier.test.ts — OPS-PG-LANE-BOOTSTRAP-W1.
 *
 * THE BUG THIS EXISTS TO REFUSE. `PgBackend.exec()` handed every schema statement straight to a
 * 12-connection `pg.Pool` without awaiting it, so `getBackend()`'s ~60 straight-line DDL calls
 * ran a dozen at a time on a dozen connections. A `CREATE INDEX` could therefore execute before
 * the `CREATE TABLE` it indexes. Measured on the Postgres CI lane (run 33400151672): SEVEN
 * tables silently lost their indexes in one process — signup_emails, agent_sessions,
 * contact_leads, funnel_events, webhook_subscriptions, webhook_deliveries,
 * subscriber_notifications — each as a `[pg-write] WRITE LOST … relation "x" does not exist`
 * line that nothing failed on. WHICH tables lost them varied run to run on an identical tree.
 *
 * TWO ARMS, because either alone is a lie.
 *
 *   ARM A — the ordering RULE, driven directly. `DdlBarrier` is a leaf so the property can be
 *   asserted on the thing that decides it, with explicit gates instead of timers: no clock, no
 *   flake, and every assertion states which task may have started by then.
 *
 *   ARM B — the WIRING, asserted over `performance-db.ts` source. Arm A is structurally blind to
 *   exactly what its seam replaces: a barrier nothing routes through passes every behavioural
 *   test forever. Arm B is what goes red when a future `this.pool.query(...)` is added beside
 *   the wrappers instead of inside them, which is how this regression comes back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DdlBarrier } from '../../src/lib/ddl-barrier.js';

/** A promise with its resolver exposed, so a test decides when a task finishes. */
function defer<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush every pending microtask. A macrotask hop drains the whole queue in one step. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('ARM A — DdlBarrier.enqueue serialises DDL in ISSUE order', () => {
  it('statement N+1 does not start until N has settled', async () => {
    const barrier = new DdlBarrier();
    const log: string[] = [];
    const gates = [defer(), defer(), defer()];

    const runs = gates.map((g, i) =>
      barrier.enqueue(async () => {
        log.push(`start${i}`);
        await g.promise;
        log.push(`end${i}`);
      }),
    );

    // All three were ISSUED synchronously — the pre-fix code dispatched all three at once.
    await flush();
    expect(log, 'only the first statement may be in flight').toEqual(['start0']);

    gates[0].resolve();
    await flush();
    expect(log).toEqual(['start0', 'end0', 'start1']);

    gates[1].resolve();
    await flush();
    expect(log).toEqual(['start0', 'end0', 'start1', 'end1', 'start2']);

    gates[2].resolve();
    await Promise.all(runs);
    expect(log).toEqual(['start0', 'end0', 'start1', 'end1', 'start2', 'end2']);
  });

  it('order is ISSUE order, not completion order — a slow first statement still goes first', async () => {
    // The distinction that matters: an unordered pool answers in whatever order the server
    // finishes, so a fast CREATE INDEX beats a slow CREATE TABLE. This pins the opposite.
    const barrier = new DdlBarrier();
    const log: string[] = [];
    const slow = defer();

    const a = barrier.enqueue(async () => {
      await slow.promise;
      log.push('slow-table');
    });
    const b = barrier.enqueue(async () => {
      log.push('fast-index');
    });

    await flush();
    expect(log, 'the fast statement must NOT have overtaken the slow one').toEqual([]);

    slow.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['slow-table', 'fast-index']);
  });

  it('a REJECTED statement does not wedge or reorder the ones behind it', async () => {
    // A failed CREATE must not make the schema all-or-nothing. The barrier stops overtaking;
    // it is not a transaction.
    const barrier = new DdlBarrier();
    const log: string[] = [];

    const failed = barrier.enqueue(async () => {
      log.push('boom');
      throw new Error('duplicate object');
    });
    const after = barrier.enqueue(async () => {
      log.push('next');
    });

    await expect(failed).rejects.toThrow('duplicate object');
    await after;
    expect(log).toEqual(['boom', 'next']);
    // ...and the barrier itself never rejects, so no caller inherits that failure.
    await expect(barrier.settled()).resolves.toBeUndefined();
  });
});

describe('ARM A — DdlBarrier.after waits for the backlog but stays CONCURRENT', () => {
  it('a read/write issued during bootstrap runs only after the DDL enqueued so far', async () => {
    const barrier = new DdlBarrier();
    const log: string[] = [];
    const ddl = defer();

    barrier.enqueue(async () => {
      await ddl.promise;
      log.push('create-table');
    });
    const read = barrier.after(async () => {
      log.push('select');
    });

    await flush();
    expect(log, 'the read must not see a half-built schema').toEqual([]);

    ddl.resolve();
    await read;
    expect(log).toEqual(['create-table', 'select']);
  });

  it('two after() callers overlap — this is a barrier, NOT a global write lock', async () => {
    // The load-bearing negative. Serialising every write would fix ordering and quietly cap the
    // signal-write path at one statement per round trip; `after` observes the tail instead of
    // extending it, so DML concurrency is untouched.
    const barrier = new DdlBarrier();
    const log: string[] = [];
    const g1 = defer();
    const g2 = defer();

    const w1 = barrier.after(async () => {
      log.push('w1-start');
      await g1.promise;
      log.push('w1-end');
    });
    const w2 = barrier.after(async () => {
      log.push('w2-start');
      await g2.promise;
      log.push('w2-end');
    });

    await flush();
    expect(log, 'both writes must be in flight together').toEqual(['w1-start', 'w2-start']);

    g2.resolve();
    g1.resolve();
    await Promise.all([w1, w2]);
    expect(log).toContain('w1-end');
    expect(log).toContain('w2-end');
  });

  it('after() does not extend the chain — a later enqueue is not held by an in-flight read', async () => {
    const barrier = new DdlBarrier();
    const log: string[] = [];
    const slowRead = defer();

    barrier.after(async () => {
      log.push('read-start');
      await slowRead.promise;
    });
    const ddl = barrier.enqueue(async () => {
      log.push('ddl');
    });

    await ddl;
    expect(log).toEqual(['read-start', 'ddl']);
    slowRead.resolve();
  });
});

describe('ARM B — PgBackend actually ROUTES through the barrier', () => {
  // Comments are stripped first: this file and performance-db.ts both discuss `pool.query` at
  // length, and a ban-grep that demands the deletion of its own explanation is a gate nobody
  // keeps. Same discipline as check-canaries-wired.mjs ("a mention is not an invocation").
  const file = readFileSync(resolve(__dirname, '../../src/lib/performance-db.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  // Scope to the CLASS BODY, not the file. `DbBackend` declares `exec(sql: string): void;` as an
  // interface member earlier in the same file, and a file-wide search finds that declaration —
  // which contains no call at all, so the check would fail for a reason unrelated to the wiring.
  const classStart = file.indexOf('class PgBackend implements DbBackend {');
  const src = classStart === -1 ? '' : file.slice(classStart, file.indexOf('\n}', classStart));

  it('PgBackend holds a DdlBarrier', () => {
    expect(classStart, 'class PgBackend no longer exists').toBeGreaterThan(-1);
    expect(file).toContain("import { DdlBarrier } from './ddl-barrier.js';");
    expect(src).toMatch(/private ddl = new DdlBarrier\(\);/);
  });

  it('EVERY pool.query call site is wrapped by enqueueDdl or afterDdl', () => {
    const sites = src.split('\n').filter((l) => l.includes('this.pool.query('));
    // Vacuity guard: if the call sites move or are renamed, an empty list would make the
    // assertion below pass over nothing, and the wiring would go unchecked in silence.
    expect(sites.length, 'no this.pool.query call sites found — this check went vacuous').toBe(5);
    for (const line of sites) {
      expect(
        /this\.(enqueueDdl|afterDdl)\(\(\) => this\.pool\.query\(/.test(line),
        `unwrapped pool.query — it can overtake the DDL it depends on: ${line.trim()}`,
      ).toBe(true);
    }
  });

  it('DDL enqueues; DML and reads only wait', () => {
    // The split is the whole design. exec/execAsync are the schema path and must JOIN the
    // chain; run/query/runAsync must observe it without extending it, or the signal-write path
    // becomes serial.
    const body = (name: string) => {
      const m = new RegExp(`\\n  (?:async )?${name}\\([^)]*\\)[^{]*\\{`).exec(src);
      expect(m, `${name} no longer exists on PgBackend`).not.toBeNull();
      const rest = src.slice(m!.index + 1);
      const next = rest.slice(1).search(/\n  (?:private |async )*[a-zA-Z]+[<(]/);
      return next === -1 ? rest : rest.slice(0, next + 1);
    };
    for (const fn of ['exec', 'execAsync']) expect(body(fn), fn).toContain('enqueueDdl');
    for (const fn of ['run', 'query', 'runAsync']) expect(body(fn), fn).toContain('afterDdl');
  });

  it('drain() and awaitDbWrites() exist — read-after-write has a reachable barrier', () => {
    // Without an exported drain the only way to settle a fire-and-forget write was closeDbAsync(),
    // which also ends the pool. That gap is why three assertions in
    // band-population-invariance.test.ts raced on the PG lane and were sound on SQLite.
    expect(src).toMatch(/async drain\(\): Promise<void> \{/);
    expect(file).toMatch(/export async function awaitDbWrites\(\): Promise<void> \{/);
    expect(file).toMatch(/b instanceof PgBackend\) await b\.drain\(\)/);
  });
});
