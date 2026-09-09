/**
 * IDENTITY-LIFECYCLE-W3 — the ledger stays ON THE HOST (architect ruling Q7, 2026-09-09).
 *
 * `lifecycle_sends.rendered_html` now holds free-tier API keys AT REST, in the same Postgres that
 * already holds `free_keys`. The ruling accepts that — a free key grants nothing an anonymous
 * caller lacks — on ONE condition: the ledger is never exported, never synced to the vault, and
 * never included in a canary result line, which carries COUNTS ONLY.
 *
 * That condition is a property of code that does not exist yet. This file is what makes it a
 * CONTROL rather than a note: the moment a future wave adds a ledger export, an rsync of the
 * table, or a canary that publishes a rendered body, one of these fails.
 *
 * Deliberately a STRUCTURAL test over the ops surface, not a behavioural one — the thing being
 * prevented is a file that nobody has written, so there is no behaviour to drive.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '../..');

/** Every ops/monitoring surface that could plausibly move data off the host. */
function opsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(join(ROOT, dir))) return;
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(sh|mjs|py|ts)$/.test(name)) out.push(rel);
    }
  };
  walk('ops');
  walk('scripts');
  return out;
}

/** Comments stripped: a mention is not a reference, as this wave has now learned three times. */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*(?:\/\/|#).*$/gm, ' ');
}

describe('the lifecycle ledger is never exported off the host', () => {
  const files = opsFiles();

  it('the ops surface is non-empty — this test must not pass by finding nothing', () => {
    // Vacuity guard where the corpus is CONSTRUCTED: we build this list, so an empty one means
    // the walker broke, not that the estate has no ops scripts.
    expect(files.length).toBeGreaterThan(20);
  });

  it('no ops script SELECTs a rendered body or a recipient address', () => {
    const offenders = files.filter((f) => {
      const c = code(f);
      return /rendered_html|rendered_text|recipient_email/.test(c);
    });
    // Counts and verdicts may leave the host. Message BODIES and ADDRESSES may not.
    expect(offenders).toEqual([]);
  });

  it('the results sync moves ONLY canary-results.jsonl, never a ledger dump', () => {
    const c = code('ops/scripts/monitoring-results-sync.sh');
    expect(c).toContain('canary-results.jsonl');
    expect(c).not.toMatch(/lifecycle_sends|lifecycle_suppressions/);
    // A `pg_dump` in the sync path would carry the whole ledger to the vault in one line.
    expect(c).not.toMatch(/pg_dump/);
  });

  it('no canary publishes a lifecycle row — result lines carry counts only', () => {
    for (const f of files.filter((x) => /lifecycle/.test(x))) {
      const c = code(f);
      // `append_result` takes a metrics OBJECT; these are the keys this wave publishes, and all
      // of them are numbers or verdicts.
      expect(c, f).not.toMatch(/rendered_/);
      expect(c, f).not.toMatch(/SELECT\s+\*\s+FROM\s+lifecycle_sends/i);
    }
  });

  it('the health canary reads AGGREGATES, never rows', () => {
    const c = code('ops/cron/lifecycle-health.sh');
    expect(c).toMatch(/COUNT\(\*\)/);
    expect(c).not.toMatch(/rendered_html|recipient_email/);
  });
});
