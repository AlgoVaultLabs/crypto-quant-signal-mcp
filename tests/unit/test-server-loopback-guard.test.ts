/**
 * DECISION-CALL-V1-W3 CH1 R0 — a test server binds the loopback address it dials.
 *
 * `app.listen(0)` binds the IPv6 wildcard `::`, and every suite here then dials `http://127.0.0.1:<port>`.
 * When another process already holds `127.0.0.1:<port>`, Node's listen on `::` still succeeds and the
 * request reaches the OTHER process. Measured at DECISION-CALL-V1-W2 land #1: a Python `http.server`
 * answered 501 to an `x402-paid-path` POST and the landing gate went GATE_BLOCKED on a flake that was not one.
 * Binding the address the suite dials (`listen(0, '127.0.0.1', …)`) makes that collision impossible.
 *
 * The guard: every `.listen(0` under `tests/` names its host as a string literal. A bare `.listen(0)` or
 * `.listen(0, <callback>)` FAILS here, so the next test server cannot reintroduce the wildcard bind.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.listen(0` whose next argument is not a string-literal host: `.listen(0)` or `.listen(0, <callback>)`.
 * The whitespace sits INSIDE the lookahead: written as `,\s*(?!['"`])`, the `\s*` backtracks to zero width,
 * the lookahead then sees the space instead of the quote, and every host-named call matches.
 */
const HOSTLESS = /\.listen\(\s*0\s*(?:\)|,(?!\s*['"`]))/g;
/** `.listen(0, '<host>'` — counted only so the corpus scan can prove it saw listen calls at all. */
const HOSTED = /\.listen\(\s*0\s*,\s*['"`]/g;

const SELF = 'tests/unit/test-server-loopback-guard.test.ts';
const SOURCE_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/** 1-based line numbers of every host-less `.listen(0` in `src`. */
function hostlessListenLines(src: string): number[] {
  const lines: number[] = [];
  for (const m of src.matchAll(HOSTLESS)) lines.push(src.slice(0, m.index).split('\n').length);
  return lines;
}

/** Tracked test sources: `git ls-files` where a repository exists; a walk of `tests/` where it does not. */
function testSources(): string[] {
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files', '-z', '--', 'tests'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean);
  } catch {
    files = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk('tests');
  }
  return files.filter((f) => SOURCE_FILE.test(f) && f !== SELF);
}

describe('test servers bind the loopback they dial', () => {
  it('flags a bare listen(0) and listen(0, callback); passes a host-named listen', () => {
    expect(hostlessListenLines('const s = app.listen(0, () => resolve(s));')).toEqual([1]);
    expect(hostlessListenLines('server.listen(0);')).toEqual([1]);
    expect(hostlessListenLines('s.listen(\n  0,\n  () => r(),\n);')).toEqual([1]);
    expect(hostlessListenLines("const s = app.listen(0, '127.0.0.1', () => resolve(s));")).toEqual([]);
    expect(hostlessListenLines('srv.listen(0, "::1", cb);')).toEqual([]);
    expect(hostlessListenLines('app.listen(3000, () => {});')).toEqual([]);
  });

  it(`no test source under tests/ binds a host-less listen(0) (excludes only ${SELF})`, () => {
    const files = testSources();
    const hits: string[] = [];
    let hosted = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      hosted += [...src.matchAll(HOSTED)].length;
      for (const line of hostlessListenLines(src)) hits.push(`${f}:${line}`);
    }
    // Vacuity: a scan that read nothing, or saw no listen call at all, would also report zero hits.
    expect(files.length, `scanned ${files.length} test sources`).toBeGreaterThan(500);
    expect(hosted, `saw ${hosted} host-named listen(0) calls across ${files.length} files`).toBeGreaterThanOrEqual(7);
    expect(hits, `host-less listen(0) in ${files.length} scanned files`).toEqual([]);
  });
});
