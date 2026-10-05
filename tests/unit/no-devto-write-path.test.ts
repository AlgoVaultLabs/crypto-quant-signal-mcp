/**
 * OPS-DEVTO-SPAM-GUARD-W1 CH2 — signal-MCP holds NO dev.to API reference (ruling Q1 = C).
 *
 * The editorial pipeline (algovault-editorial) is the ONLY dev.to writer. This repo used to be a second,
 * independent producer with its own copy of the key (agent-forum-post: weekly report, BTC usage example,
 * market insight, release "What's New"), and those templated, link-carrying posts are what DEV's spam
 * checks flagged. The allowlist is EMPTY: no file under src/ or scripts/ may contain a dev.to API URL,
 * whatever its HTTP method. A positive control proves the scanner can still see one.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src', 'scripts'];
const DEVTO_API_RE = /dev\.to\/api\//;
const ALLOWLIST: string[] = [];

function walk(rel: string, out: string[]): string[] {
  for (const e of readdirSync(path.join(ROOT, rel))) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const r = `${rel}/${e}`;
    if (statSync(path.join(ROOT, r)).isDirectory()) walk(r, out);
    else out.push(r);
  }
  return out;
}

/** Files (repo-relative) whose text contains a dev.to API URL. */
export function devtoApiRefs(files: Array<{ rel: string; text: string }>): string[] {
  return files.filter((f) => DEVTO_API_RE.test(f.text)).map((f) => f.rel).sort();
}

describe('no dev.to write path in signal-MCP', () => {
  const corpus = SCAN_DIRS.flatMap((d) => walk(d, []));

  it('scans a real corpus (vacuity guard)', () => {
    expect(corpus.length).toBeGreaterThan(100);
    expect(corpus).toContain('scripts/fetchers/devto.mjs');
    expect(corpus).toContain('src/scripts/agent-forum-post.ts');
  });

  it('no file under src/ or scripts/ contains a dev.to API URL (allowlist: empty)', () => {
    const hits = devtoApiRefs(corpus.map((rel) => ({ rel, text: readFileSync(path.join(ROOT, rel), 'utf8') })));
    expect(hits.filter((h) => !ALLOWLIST.includes(h))).toEqual([]);
    expect(ALLOWLIST).toEqual([]);
  });

  it('positive control: the scanner flags a dev.to API URL in any form (GET or POST, template or literal)', () => {
    const fixtures = [
      { rel: 'src/a.ts', text: "await fetch('https://dev.to/api/articles', { method: 'POST' })" },
      { rel: 'src/b.ts', text: 'const url = `https://dev.to/api/articles/${id}`;' },
      { rel: 'scripts/c.mjs', text: "fetch('https://dev.to/api/articles/me/published?per_page=100')" },
      { rel: 'src/d.ts', text: "const profile = 'https://dev.to/algovaultlabs'; // a public page, not the API" },
    ];
    expect(devtoApiRefs(fixtures)).toEqual(['scripts/c.mjs', 'src/a.ts', 'src/b.ts']);
  });
});
