#!/usr/bin/env npx tsx
/**
 * Activation funnel snapshot CLI — thin wrapper around the library function
 * `generateFunnelSnapshot()` in `src/lib/funnel-snapshot.ts`.
 *
 * Library extraction happened in ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28) so
 * the `/api/admin/funnel-snapshot` HTTP endpoint could import the function
 * directly (scripts/ is outside tsc rootDir).
 *
 * CLI:
 *   npx tsx scripts/funnel-snapshot.ts                       # last 14d, JSON to stdout
 *   npx tsx scripts/funnel-snapshot.ts --days 30             # custom window
 *   npx tsx scripts/funnel-snapshot.ts --since 2026-04-01    # custom start date (ISO)
 *   npx tsx scripts/funnel-snapshot.ts --until 2026-04-15    # custom end date (ISO)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFunnelSnapshot } from '../src/lib/funnel-snapshot.js';
import { closeDb } from '../src/lib/performance-db.js';

// Re-export for backward compat with `scripts/write-funnel-snapshot.ts` which
// historically imported FunnelSnapshot from this file's relative path. New
// code should import from `../src/lib/funnel-snapshot.js` directly.
export { generateFunnelSnapshot } from '../src/lib/funnel-snapshot.js';
export type { FunnelSnapshot, SnapshotOptions } from '../src/lib/funnel-snapshot.js';

interface CliArgs {
  days?: number;
  since?: string;
  until?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--days' && next !== undefined) {
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --days: ${next}`);
      }
      out.days = n;
      i++;
    } else if (arg === '--since' && next !== undefined) {
      out.since = next;
      i++;
    } else if (arg === '--until' && next !== undefined) {
      out.until = next;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `usage: funnel-snapshot.ts [--days N] [--since YYYY-MM-DD] [--until YYYY-MM-DD]`,
      );
      process.exit(0);
    }
  }
  return out;
}

// Invoked directly? (tsx / node)
function isMainModule(): boolean {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return path.resolve(thisFile) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = parseCliArgs(process.argv.slice(2));
  generateFunnelSnapshot(args)
    .then((snapshot) => {
      console.log(JSON.stringify(snapshot, null, 2));
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error('funnel-snapshot failed:', err instanceof Error ? err.message : err);
      closeDb();
      process.exit(1);
    });
}
