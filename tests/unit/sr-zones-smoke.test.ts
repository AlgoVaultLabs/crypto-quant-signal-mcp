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
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'sr-zones-smoke.mjs');
const run = (...args: string[]) => spawnSync(process.execPath, [SMOKE, ...args], { encoding: 'utf8', timeout: 30_000 });

describe('sr-zones-smoke --self-test', () => {
  it('passes: clean bodies pass, planted defects fail, the echoed coin symbol is masked', () => {
    const r = run('--self-test');
    expect(r.stdout).toContain('SR_ZONES_SMOKE_SELFTEST=PASS');
    expect(r.stdout).toMatch(/PASS {2}PREDICT coin echo is masked/);
    expect(r.stdout).toMatch(/PASS {2}a forbidden word in the summary is caught/);
    expect(r.status).toBe(0);
  });

  it('a usage error exits 2 and prints no verdict token', () => {
    const r = run('--bogus');
    expect(r.status).toBe(2);
    expect(r.stdout).not.toMatch(/SR_ZONES_SMOKE_(VERDICT|SELFTEST)=/);
  });
});
