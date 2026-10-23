/**
 * OPS-SERVED-CANDLE-TRUTH-W1 CH3 — the JIT-off read the stats pushdown and the public confidence bands take.
 *
 * Measured on prod PG 16 (EXPLAIN ANALYZE, read-only): the scoring-exclusion fragment makes those queries' expression
 * large enough that JIT spends ~6.3 s compiling it to save nothing (995 ms with JIT off vs 936 ms pre-wave). The
 * setting must be scoped to the one transaction, the transaction must be READ ONLY, and the pooled client must go
 * back to the pool on every path — a leaked client or a leaked `jit = off` would be a fault nothing else reports.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryWithoutJit } from '../../src/lib/performance-db.js';

function fakePool(failOn?: string) {
  const log: string[] = [];
  let released = 0;
  const pool = {
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) {
          log.push(params && params.length ? `${sql} ${JSON.stringify(params)}` : sql);
          if (failOn && sql === failOn) throw new Error('boom');
          return { rows: sql.startsWith('SELECT') ? [{ n: 1 }] : [] };
        },
        release() { released++; },
      };
    },
  };
  return { pool, log, released: () => released };
}

describe('queryWithoutJit', () => {
  it('runs the read inside BEGIN READ ONLY + SET LOCAL jit = off, commits, and releases the client', async () => {
    const f = fakePool();
    expect(await queryWithoutJit(f.pool, 'SELECT 1 AS n WHERE $1 = 1', [1])).toEqual([{ n: 1 }]);
    expect(f.log).toEqual(['BEGIN READ ONLY', 'SET LOCAL jit = off', 'SELECT 1 AS n WHERE $1 = 1 [1]', 'COMMIT']);
    expect(f.released()).toBe(1);
  });

  it('rolls back and releases when the read fails, and the error reaches the caller', async () => {
    const f = fakePool('SELECT broken');
    await expect(queryWithoutJit(f.pool, 'SELECT broken', [])).rejects.toThrow('boom');
    expect(f.log).toEqual(['BEGIN READ ONLY', 'SET LOCAL jit = off', 'SELECT broken', 'ROLLBACK']);
    expect(f.released()).toBe(1);
  });

  it('the two large-fragment readers take it: the stats groups query and the confidence bands', () => {
    const src = readFileSync(resolve(__dirname, '../../src/lib/performance-db.ts'), 'utf8');
    const body = (fn: string) => { const i = src.indexOf(`export async function ${fn}(`); return i === -1 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
    expect(body('aggregateSignalsSql')).toMatch(/b\.queryNoJit\(groupsSql\)/);
    expect(body('getConfidenceBands')).toMatch(/b\.queryNoJit\(sql\)/);
  });
});
