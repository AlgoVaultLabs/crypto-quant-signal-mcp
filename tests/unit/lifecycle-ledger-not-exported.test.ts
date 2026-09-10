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

/**
 * Comments stripped: a mention is not a reference, as this wave has now learned three times.
 *
 * THE BLOCK-COMMENT STRIPPER IS LANGUAGE-SCOPED, AND THAT IS LOAD-BEARING. `/* ... *\/` is a
 * comment in TS/JS and NOTHING in shell or python, where `/*` is an ordinary glob and `*\/`
 * shows up in cron expressions and paths. Applied blindly it does not merely miss a comment —
 * it DELETES a span of real code between the two, and every negative assertion below then
 * passes vacuously over whatever was inside.
 *
 * MEASURED 2026-09-10 (OPS-PREREG-VAULT-MIRROR-W1): 10 of 126 `ops/**` + `scripts/**` .sh/.py
 * files on origin/main already contained at least one such span — 14 spans in all — so the
 * ledger firewall was silently unenforced across parts of them. Writing the glob
 * `audits/*preregistration*.md` into a comment in monitoring-results-sync.sh swallowed 230
 * lines (12,308 chars) of that file in one go, taking `do_push`, `do_pull` and `merge_jsonl`
 * out of the guard's reach. The fix is here rather than in the prose of ten shell files,
 * because the defect is the stripper's, not theirs.
 */
function code(rel: string): string {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  const isCLike = /\.(ts|tsx|js|mjs|cjs)$/.test(rel);
  return (isCLike ? raw.replace(/\/\*[\s\S]*?\*\//g, ' ') : raw)
    .replace(/^\s*(?:\/\/|#).*$/gm, ' ');
}

describe('the lifecycle ledger is never exported off the host', () => {
  const files = opsFiles();

  it('the comment stripper never deletes shell or python CODE', () => {
    // The corpus this guard reads must be the whole file. A `/*` in a shell comment paired with
    // any later `*/` used to swallow everything between them, so the assertions below ran over a
    // hole. Assert the property directly: for every non-C-like ops file, stripping must remove
    // only whole comment lines and never shorten a line of code.
    const damaged: string[] = [];
    for (const f of files) {
      if (/\.(ts|tsx|js|mjs|cjs)$/.test(f)) continue;
      const raw = readFileSync(join(ROOT, f), 'utf8');
      const kept = code(f);
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        if (!kept.includes(line)) { damaged.push(`${f}: ${t.slice(0, 60)}`); break; }
      }
    }
    expect(damaged, 'these lines of real code vanished from the guard corpus').toEqual([]);
  });

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

  // RENAMED by OPS-PREREG-VAULT-MIRROR-W1. The sync gained a third leg — it now also mirrors
  // the repo's pre-registrations into the vault — so the old name ("moves ONLY
  // canary-results.jsonl") became untrue while every assertion under it still passed. A test
  // whose name has quietly stopped describing what it checks is a trap for the next reader, so
  // the name follows the contract and the guard is STRENGTHENED rather than loosened: the
  // ledger-negative assertions are unchanged, and the mirrored SET is now pinned too.
  it('the results sync moves ONLY canary-results.jsonl and repo pre-registrations, never a ledger dump', () => {
    const c = code('ops/scripts/monitoring-results-sync.sh');
    expect(c).toContain('canary-results.jsonl');
    expect(c).not.toMatch(/lifecycle_sends|lifecycle_suppressions/);
    // A `pg_dump` in the sync path would carry the whole ledger to the vault in one line.
    expect(c).not.toMatch(/pg_dump/);

    // The third leg delegates to ONE named sibling and to nothing else. Whatever that sibling
    // carries is bounded by its own test; what is bounded HERE is that the sync cannot grow a
    // second, unreviewed vault-writing path without this line changing.
    expect(c).toContain('ops/scripts/prereg-vault-mirror.sh');
  });

  it('the prereg mirror carries pre-registrations and NOTHING else out of the repo', () => {
    const c = code('ops/scripts/prereg-vault-mirror.sh');
    // Its discovery predicate is the whole boundary: `audits/*preregistration*.md`. Widening it
    // is what would turn a methodology mirror into an exfiltration path for held figures.
    expect(c).toContain("SOURCE_DIR=${PREREG_MIRROR_SOURCE_DIR:-audits}");
    expect(c).toMatch(/grep -Eiq 'preregistration\.\*\\\.md\$'/);
    // Same ledger firewall as its sibling: counts and methodology may leave, rows may not.
    expect(c).not.toMatch(/lifecycle_sends|lifecycle_suppressions|rendered_html|recipient_email/);
    expect(c).not.toMatch(/pg_dump/);
    // It reads git objects, never a database.
    expect(c).not.toMatch(/psql|docker exec/);
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
