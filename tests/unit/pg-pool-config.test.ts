/**
 * OPS-POSTGRES-MEM-RIGHTSIZE-W1 — pg Pool hardening.
 *
 * The PgBackend pool was constructed bare: `new Pool({ connectionString })`.
 * That gave it the pg defaults (no keepAlive → idle TCP drops surface as
 * "Connection terminated unexpectedly"; no statement_timeout → a runaway
 * query can pin a connection; no bound that an operator can tune). This
 * extracts the pool config into a pure, env-tunable builder so it can be
 * asserted without opening a real connection.
 */
import { describe, it, expect } from 'vitest';
import { buildPoolConfig } from '../../src/lib/performance-db.js';

describe('buildPoolConfig', () => {
  it('passes the connection string through unchanged', () => {
    const cfg = buildPoolConfig('postgres://u:p@h:5432/db', {});
    expect(cfg.connectionString).toBe('postgres://u:p@h:5432/db');
  });

  it('bounds the pool + keepAlive but does NOT set allowExitOnIdle (it aborted in-flight fire-and-forget writes when a short-lived seed/backfill cron exited)', () => {
    const cfg = buildPoolConfig('postgres://x', {});
    expect(cfg.max).toBe(12);
    expect(cfg.keepAlive).toBe(true);
    expect(cfg.allowExitOnIdle).toBeUndefined();
    expect(cfg.connectionTimeoutMillis).toBe(10_000);
    expect(cfg.idleTimeoutMillis).toBe(30_000);
    expect(cfg.statement_timeout).toBe(120_000);
  });

  it('honours numeric env overrides', () => {
    const cfg = buildPoolConfig('postgres://x', {
      PG_POOL_MAX: '8',
      PG_STATEMENT_TIMEOUT_MS: '30000',
      PG_CONNECTION_TIMEOUT_MS: '5000',
    });
    expect(cfg.max).toBe(8);
    expect(cfg.statement_timeout).toBe(30_000);
    expect(cfg.connectionTimeoutMillis).toBe(5_000);
  });

  it('default-denies invalid / non-positive env values back to the safe default', () => {
    const cfg = buildPoolConfig('postgres://x', { PG_POOL_MAX: 'abc', PG_STATEMENT_TIMEOUT_MS: '0', PG_IDLE_TIMEOUT_MS: '-5' });
    expect(cfg.max).toBe(12);
    expect(cfg.statement_timeout).toBe(120_000);
    expect(cfg.idleTimeoutMillis).toBe(30_000);
  });
});
