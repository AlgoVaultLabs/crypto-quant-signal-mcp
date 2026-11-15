/**
 * SR-ZONES-W1 — the AC2.4 prod smoke's own checks, proven both ways without a network.
 *
 * `scripts/sr-zones-smoke.mjs --self-test` runs the smoke's shape check and facts lint over built-in
 * bodies: clean bodies must pass and every planted defect must be caught. It reads no key file and
 * opens no socket, so it is safe in the parallel suite.
 *
 * The case that motivated it: R4's young-listing candidate PREDICTUSDT. Its ticker matches the
 * lint's `predict\w*`, so a lint over the raw response failed on the caller's own coin symbol (the
 * `coin` field and the summary both echo it). The smoke masks the requested symbol before linting;
 * the self-test pins that the mask is what makes it pass, and that our own wording is still linted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'sr-zones-smoke.mjs');
const run = (...args: string[]) => spawnSync(process.execPath, [SMOKE, ...args], { encoding: 'utf8', timeout: 30_000 });
/** The call-site patterns, outside every test block: `\x28` matches "(" without an unmatched paren in this source. */
const ANY_FETCH_CALL = /\bfetch\x28/g;
const PINNED_FETCH_CALL = /await fetch\x28PROD_URL, \{/g;

describe('sr-zones-smoke --self-test', () => {
  it('passes: clean bodies pass, planted defects fail, the echoed coin symbol is masked', { timeout: 30_000 }, () => {
    const r = run('--self-test');
    expect(r.stdout).toContain('SR_ZONES_SMOKE_SELFTEST=PASS');
    expect(r.stdout).toMatch(/PASS {2}PREDICT coin echo is masked/);
    expect(r.stdout).toMatch(/PASS {2}a forbidden word in the summary is caught/);
    expect(r.status).toBe(0);
  });

  it('a usage error exits 2 and prints no verdict token', { timeout: 30_000 }, () => {
    const r = run('--bogus');
    expect(r.status).toBe(2);
    expect(r.stdout).not.toMatch(/SR_ZONES_SMOKE_(VERDICT|SELFTEST)=/);
  });

  it('R7 #1: every POST goes to the production MCP URL with redirects refused (self-test, stubbed fetch)', { timeout: 30_000 }, () => {
    const r = run('--self-test');
    expect(r.stdout).toMatch(/PASS {2}every POST goes to https:\/\/api\.algovault\.com\/mcp with redirects refused/);
    expect(r.status).toBe(0);
  });

  it('R9 #3: a load-timeout unserved row is a retry after about 15 s, and still loading is INDETERMINATE, not FAIL', { timeout: 30_000 }, () => {
    const r = run('--self-test');
    for (const line of [
      'a load-timeout unserved row is a retry: called again after 15 s, then served',
      'still loading after the retry is INDETERMINATE, not FAIL',
      'every timeframe still loading (the call refused) is INDETERMINATE',
      'another unserved reason is not retried, and FAILs',
      'a defect in what was served FAILs while another timeframe is loading',
      'a clean first answer is not retried',
      'the verdict: FAIL over INDETERMINATE over PASS',
      'end to end: BTC 4h still loading after the retry is the run\'s INDETERMINATE',
      'end to end: loading, then served on the retry, is the run\'s PASS',
      'end to end: a forbidden word beside a loading timeframe is the run\'s FAIL',
    ]) expect(r.stdout, line).toContain(`PASS  ${line}`);
    expect(r.stdout).toContain('SR_ZONES_SMOKE_SELFTEST=PASS');
    expect(r.status).toBe(0);
  });

  it('R10 #2: a FAIL then an unreachable call is the run\'s FAIL; an unreachable first call is INDETERMINATE', { timeout: 30_000 }, () => {
    const r = run('--self-test');
    for (const line of [
      'end to end: a FAIL then an unreachable call is the run\'s FAIL',
      'end to end: an unreachable first call is the run\'s INDETERMINATE, with nothing to lint',
    ]) expect(r.stdout, line).toContain(`PASS  ${line}`);
    expect(r.stdout).toContain('SR_ZONES_SMOKE_SELFTEST=PASS');
    expect(r.status).toBe(0);
  });

  it('R7 #1: rpc() is the only fetch call site, so the self-test above covers every POST', () => {
    const src = readFileSync(SMOKE, 'utf8');
    expect(src.match(ANY_FETCH_CALL)).toHaveLength(1);
    expect(src.match(PINNED_FETCH_CALL)).toHaveLength(1);
  });
});

/**
 * R7 #1 (Mr.1, 2026-11-15): the smoke targets only https://api.algovault.com/mcp. An instrumented run proves `--url`
 * is refused before the key file is touched: a preload reports every access to `internal.env`, and HOME points at an
 * empty directory, so even a regression that read the key could reach no network (it exits INDETERMINATE first).
 */
describe('sr-zones-smoke — the key file is never read for a refused target', () => {
  let dir = '';
  let preload = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'srz-smoke-'));
    preload = join(dir, 'watch-key-file.mjs');
    writeFileSync(preload, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "const flag = (p) => { if (String(p).includes('internal.env')) process.stderr.write('KEY_FILE_TOUCHED\\n'); };",
      "for (const name of ['readFileSync', 'readFile', 'openSync', 'open', 'existsSync', 'statSync', 'accessSync', 'createReadStream']) {",
      '  const real = fs[name];',
      '  fs[name] = function (p, ...rest) { flag(p); return real.call(this, p, ...rest); };',
      '}',
      'const realP = fs.promises.readFile;',
      'fs.promises.readFile = function (p, ...rest) { flag(p); return realP.call(this, p, ...rest); };',
      'syncBuiltinESMExports();',
    ].join('\n'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const watched = (...args: string[]) => spawnSync(process.execPath, ['--import', preload, SMOKE, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: dir },
  });

  it('the instrument sees a key read: --prod with no key file reads it and stops INDETERMINATE, before any POST', { timeout: 30_000 }, () => {
    const r = watched('--prod');
    expect(r.stderr).toContain('KEY_FILE_TOUCHED');
    expect(r.stdout).toContain('SR_ZONES_SMOKE_VERDICT=INDETERMINATE');
    expect(r.status).toBe(3);
  });

  it('--url https://example.invalid/mcp exits 2, with no verdict token and no key read', { timeout: 30_000 }, () => {
    const r = watched('--url', 'https://example.invalid/mcp');
    expect(r.status).toBe(2);
    expect(r.stdout).not.toMatch(/SR_ZONES_SMOKE_(VERDICT|SELFTEST)=/);
    expect(r.stderr).not.toContain('KEY_FILE_TOUCHED');
  });

  it('--url next to --prod is refused the same way', { timeout: 30_000 }, () => {
    const r = watched('--prod', '--url', 'https://example.invalid/mcp');
    expect(r.status).toBe(2);
    expect(r.stdout).not.toMatch(/SR_ZONES_SMOKE_(VERDICT|SELFTEST)=/);
    expect(r.stderr).not.toContain('KEY_FILE_TOUCHED');
  });
});
