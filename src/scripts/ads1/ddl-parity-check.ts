// ads1/ddl-parity-check.ts — EDGE-ADS1-SCORECARD-W1-V2 CH2 gate leg.
//
//   node dist/scripts/ads1/ddl-parity-check.js [--migrations <dir>]
//
// Prints exactly one line `DDL_PARITY: PASS|FAIL|INDETERMINATE …` and exits 0 / 1 / 3. INDETERMINATE
// when the migrations directory cannot be read (the check verified nothing — never a pass). Run from a
// checkout: the directory defaults to `<repo>/migrations`, resolved from this file's own location.

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DIRECTIONAL_LABELS_DDL_PG } from '../directional-labeler.js';
import { ddlParity } from './ddl-parity.js';

export function runDdlParityCheck(migrationsDir: string, log: (line: string) => void = console.log): number {
  let sqls: string[];
  try {
    sqls = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort()
      .map((f) => readFileSync(path.join(migrationsDir, f), 'utf8'));
  } catch (err) {
    log(`DDL_PARITY: INDETERMINATE (cannot read ${migrationsDir}: ${(err as Error).message})`);
    return 3;
  }
  if (sqls.length === 0) {
    log(`DDL_PARITY: INDETERMINATE (no forward migrations under ${migrationsDir})`);
    return 3;
  }
  const r = ddlParity(DIRECTIONAL_LABELS_DDL_PG, sqls);
  if (r.verdict === 'PASS') {
    log(`DDL_PARITY: PASS (${r.columns} columns, labeler DDL == migrations)`);
    return 0;
  }
  log(`DDL_PARITY: FAIL (only in labeler DDL: [${r.onlyInApplied.join(',')}]; only in migrations: [${r.onlyInMigrations.join(',')}])`);
  return 1;
}

if (require.main === module) {
  const i = process.argv.indexOf('--migrations');
  const dir = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : path.resolve(__dirname, '..', '..', '..', 'migrations');
  process.exit(runDdlParityCheck(dir));
}
