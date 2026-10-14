/**
 * EDGE-LABELER-RACE-WINDOW-V2-W1 CH4 — the `-v1` consumer registry (`ops/monitoring/directional-labels-consumers.json`)
 * is the ENUMERATION a migration reads. Detection is weaker than enumeration: a grep finds a reader only after it has
 * shipped, so the registry names every reader and this test holds the tree to it — a `-v1` literal in a tracked file
 * with no registry row fails, and so does a row whose literal is gone. `docs/Directional-Accuracy-SoT.md` §7 projects
 * the migration table from the registry, byte for byte.
 *
 * This file carries no `-v1` literal of its own: the pattern is assembled from pieces below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REGISTRY = 'ops/monitoring/directional-labels-consumers.json';
const SOT = 'docs/Directional-Accuracy-SoT.md';
// Any spec form that starts with `tau` and ends with `-floor0.30-v1`: the three spec strings, a wildcard in prose,
// and a TEMPLATED spec — the reader a fixed-string grep would miss. Quotes, backticks and whitespace end a form.
const LITERAL = new RegExp(['tau[^\\s\'"`]{0,16}', 'floor0\\.30', 'v1'].join('-'));
const STATUSES = ['pinned-v1', 'migrated-v2'];

interface Consumer {
  id: string; repo: string; path: string; symbol: string; kind: string; spec_pinned: string; owner: string;
  migration_wave: string; status: string; liveness: string; verified: string; note: string;
}
interface Site { path: string; role: string; consumer_id: string | null; note: string }
const reg = JSON.parse(readFileSync(REGISTRY, 'utf8')) as { statuses: string[]; consumers: Consumer[]; literal_sites: Site[] };

/** The tracked files: `git ls-files` where a repository exists; a walk of the tree where it does not (a gate sandbox). */
function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
        const p = dir === '.' ? name : join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk('.');
    return out;
  }
}

/** PURE. Which of (path, text) pairs carry a `-v1` literal. Binary (NUL-bearing) files are skipped. */
function literalPaths(files: Iterable<[string, string]>): Set<string> {
  const out = new Set<string>();
  for (const [p, t] of files) if (!t.includes('\0') && LITERAL.test(t)) out.add(p);
  return out;
}
/** PURE. The two ways the tree and the registry can disagree. */
function drift(found: Set<string>, sites: Site[]): { unregistered: string[]; stale: string[] } {
  const listed = new Set(sites.map((s) => s.path));
  return {
    unregistered: [...found].filter((p) => !listed.has(p)).sort(),
    stale: [...listed].filter((p) => !found.has(p)).sort(),
  };
}
/** PURE. The §7 block: the registry's consumers as the migration table, in a fixed order. */
function renderMigrationTable(consumers: Consumer[]): string {
  const rows = [...consumers].sort((a, b) => (a.repo + '\u0000' + a.id < b.repo + '\u0000' + b.id ? -1 : 1));
  return [
    '| Consumer | Pins | Owner | Migration wave | Status |',
    '|---|---|---|---|---|',
    ...rows.map((c) => `| \`${c.repo}\` · \`${c.path}\` | ${c.spec_pinned} | ${c.owner} | ${c.migration_wave} | \`${c.status}\` |`),
  ].join('\n');
}

describe('the -v1 consumer registry is the enumeration (EDGE-LABELER-RACE-WINDOW-V2-W1 CH4)', () => {
  it('every consumer row is complete: the spec it pins, an owner, a NAMED migration wave (never a date), a status', () => {
    expect(reg.statuses).toEqual(STATUSES);
    expect(reg.consumers.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const c of reg.consumers) {
      for (const k of ['id', 'repo', 'path', 'symbol', 'kind', 'spec_pinned', 'owner', 'migration_wave', 'status', 'liveness', 'verified'] as const) {
        expect({ id: c.id, k, ok: typeof c[k] === 'string' && c[k].trim().length > 0 }).toEqual({ id: c.id, k, ok: true });
      }
      expect(STATUSES).toContain(c.status);
      expect({ id: c.id, scheduled: /\b20\d\d-\d\d-\d\d\b/.test(c.migration_wave) }).toEqual({ id: c.id, scheduled: false });
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
    }
  });

  it('every tracked file carrying a -v1 literal has a literal_sites row, and no row outlives its literal', () => {
    const files = trackedFiles();
    const found = literalPaths(files.map((p) => {
      try { return [p, readFileSync(p, 'utf8')] as [string, string]; } catch { return [p, ''] as [string, string]; }
    }));
    expect(found.size).toBeGreaterThan(0); // the instrument saw the family: BARRIER_SPECS itself carries it
    expect(drift(found, reg.literal_sites)).toEqual({ unregistered: [], stale: [] });
  });

  it('the detector is proven both ways on a synthetic tree (it can fail)', () => {
    const lit = ['tau1.0', 'floor0.30', 'v1'].join('-');
    const tpl = ['tau${t.toFixed(1)}', 'floor0.30', 'v1'].join('-');
    const v2 = ['tau1.0', 'floor0.30', 'v2'].join('-');
    const found = literalPaths([['a.ts', `const s = '${lit}';`], ['b.ts', 'no literal'], ['c.bin', `\0${lit}`], ['d.md', `see ${lit}`],
      ['e.ts', `const spec = \`${tpl}\`;`], ['f.ts', `const s = '${v2}';`]]);
    expect([...found].sort()).toEqual(['a.ts', 'd.md', 'e.ts']);
    const sites: Site[] = [{ path: 'a.ts', role: 'consumer', consumer_id: null, note: '' }, { path: 'z.ts', role: 'test', consumer_id: null, note: '' }];
    expect(drift(found, sites)).toEqual({ unregistered: ['d.md', 'e.ts'], stale: ['z.ts'] });
  });

  it('a consumer site points at a real consumer row, and every row of this repo names a tracked file', () => {
    const ids = new Set(reg.consumers.map((c) => c.id));
    for (const s of reg.literal_sites) if (s.consumer_id !== null) expect({ site: s.path, ok: ids.has(s.consumer_id) }).toEqual({ site: s.path, ok: true });
    for (const s of reg.literal_sites) if (s.role === 'consumer') expect({ site: s.path, linked: s.consumer_id !== null }).toEqual({ site: s.path, linked: true });
    const tracked = new Set(trackedFiles());
    for (const c of reg.consumers.filter((x) => x.repo === 'crypto-quant-signal-mcp')) {
      expect({ id: c.id, path: c.path, tracked: tracked.has(c.path) }).toEqual({ id: c.id, path: c.path, tracked: true });
    }
  });

  it('SoT §7 projects the migration table from the registry, byte for byte', () => {
    const doc = readFileSync(SOT, 'utf8');
    const m = doc.match(/<!-- LRW-MIGRATION-TABLE:BEGIN[^>]*-->\n([\s\S]*?)\n<!-- LRW-MIGRATION-TABLE:END -->/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(renderMigrationTable(reg.consumers));
  });

  it('the deprecation promises no nightly disagreement figure (ruling Q-A: a registered read, never a nightly number)', () => {
    const doc = readFileSync(SOT, 'utf8');
    const s7 = doc.slice(doc.indexOf('## 7. '));
    expect(s7).toMatch(/-v1` is DEPRECATED\*\* \(defective race window; retained for registered consumers; retired after the last\nmigration\)/);
    expect(s7).toMatch(/never a nightly number/);
    expect(s7).not.toMatch(/disagreement (rate|share) (is )?(reported|printed|published) nightly|nightly disagreement (rate|figure)/i);
  });
});
