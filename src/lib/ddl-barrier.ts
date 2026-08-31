/**
 * ddl-barrier.ts — OPS-PG-LANE-BOOTSTRAP-W1.
 *
 * ONE ordering primitive, extracted as a dependency-free leaf so it can be exercised directly.
 *
 * WHY IT IS ITS OWN MODULE. The behaviour it encodes lives inside `PgBackend`, which is not
 * exported and whose only collaborator is a real `pg.Pool` opened in its constructor. Testing
 * the ordering rule through that class means mocking the `pg` package, which tests the mock as
 * much as the rule. A leaf module is driven directly with instrumented async functions, so the
 * ordering property is asserted on the thing that actually decides it.
 *
 * That leaves the seam this hermetic test is blind to — whether `PgBackend` still ROUTES
 * through the barrier — which `tests/unit/pg-ddl-barrier.test.ts` pins as a source assertion
 * over `performance-db.ts` rather than trusting. Both halves are load-bearing; neither alone
 * says the schema path is ordered.
 *
 * See the long rationale on `PgBackend.ddl` in `performance-db.ts` for what went wrong without
 * it (seven tables silently lost their indexes on every fresh Postgres).
 */
export class DdlBarrier {
  /**
   * The tail of the chain. NEVER rejects — every link is parked behind a two-armed `then`, so a
   * failed statement cannot poison the barrier for the statements after it, and cannot surface
   * as an unhandled rejection through the many callers that only ever read this value.
   */
  private tail: Promise<void> = Promise.resolve();

  /**
   * Serialise `fn` behind everything enqueued before it: it starts only once the previous link
   * has SETTLED, resolved or rejected alike.
   *
   * Rejected-runs-anyway is deliberate. The barrier's job is to stop a later statement
   * OVERTAKING an earlier one, not to make a schema bootstrap all-or-nothing — a failed
   * `CREATE TABLE` must not wedge the forty statements behind it.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Run `fn` after everything enqueued SO FAR, without joining the chain.
   *
   * This is what keeps the fix from being "serialise every write". Callers that are not DDL —
   * inserts, reads — wait out the schema backlog once and then run fully concurrently with each
   * other, because they observe the tail rather than extending it.
   */
  after<T>(fn: () => Promise<T>): Promise<T> {
    return this.tail.then(fn, fn);
  }

  /** Resolve once the currently-enqueued backlog has settled. Never rejects. */
  settled(): Promise<void> {
    return this.tail.then(
      () => undefined,
      () => undefined,
    );
  }
}
