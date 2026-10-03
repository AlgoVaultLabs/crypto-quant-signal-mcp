/**
 * OPS-PREVERIFY-RED-UNREAD-W1 CH1 R3 — a red publish lane BLOCKS a release bump.
 *
 * publish-lane-preverify.yml ran red 49 consecutive times and three releases were tagged straight
 * through it, because its only consumer was a human reading the Actions UI. The xrepo canary row
 * is the DELIVERY half; `npm run release:readiness` is the BLOCKING half, run by
 * Version-Bump-SOP.md § 2 before any release spec is written.
 *
 * The gate carries its own two-way `--self-test` (every state, both directions, the token→exit
 * mapping, vacuity). This file runs it so it cannot rot unnoticed, and pins what a self-test
 * cannot see about itself: the declared branch semantics, the wiring, and that the gate never
 * leaks into the publish lane it guards.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  RELEASE_BLOCKING_WORKFLOWS,
  EXIT,
  badgeUrl,
  entryDefect,
} from '../../scripts/check-release-readiness.mjs';

const ROOT = resolve(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'check-release-readiness.mjs');
const CANARY = join(ROOT, 'ops', 'cron', 'xrepo-ci-conclusion-canary.sh');

const stripJsComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the gate proves itself', () => {
  // Spawns a subprocess, so the budget sits in the OPTIONS argument.
  it('--self-test passes, asserted something, and emits its token last', { timeout: 30_000 }, () => {
    const r = spawnSync('node', [GATE, '--self-test'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status).toBe(0);
    expect(out).toMatch(/self-test: (\d+) passed, 0 failed/);
    const passed = Number(/self-test: (\d+) passed/.exec(out)?.[1] ?? 0);
    expect(passed, 'a vacuous self-test must never read as a pass').toBeGreaterThanOrEqual(30);
    expect(out.trim().split('\n').pop()).toBe('RELEASE_READINESS_VERDICT=PASS');
  });

  it('maps tokens to 0 / 1 / 3', () => {
    expect(EXIT).toEqual({ PASS: 0, FAIL: 1, INDETERMINATE: 3 });
  });
});

describe('the allow-list declares its branch semantics', () => {
  const byWf = Object.fromEntries(RELEASE_BLOCKING_WORKFLOWS.map((e: { workflow: string }) => [e.workflow, e]));

  it('is exactly the two release-blocking workflows, each well-formed', () => {
    expect(Object.keys(byWf).sort()).toEqual(['publish-lane-preverify.yml', 'publish-npm.yml']);
    for (const e of RELEASE_BLOCKING_WORKFLOWS) expect(entryDefect(e)).toBeNull();
  });

  it('reads the pre-verify rehearsal on main', () => {
    expect(badgeUrl(byWf['publish-lane-preverify.yml'])).toMatch(/\/publish-lane-preverify\.yml\/badge\.svg\?branch=main$/);
  });

  it('reads publish-npm with NO branch filter — a tag-push run carries the tag as its branch', () => {
    // Measured 2026-10-03: `?branch=main` on publish-npm.yml reports a 2026-08-26 manual dispatch
    // and `?branch=main&event=push` reads "no status". Only the any-ref badge sees a release run.
    expect(byWf['publish-npm.yml'].branch).toBeNull();
    expect(badgeUrl(byWf['publish-npm.yml'])).toMatch(/\/publish-npm\.yml\/badge\.svg$/);
  });

  it('refuses an entry that leaves its branch undeclared', () => {
    expect(entryDefect({ repo: 'o/r', workflow: 'w.yml' })).toMatch(/DECLARE its branch/);
  });

  it('every branch-declared entry is ALSO delivered by the xrepo canary — block and deliver agree', () => {
    // The canary's WATCHED list is the enumeration of workflows whose red must reach a human. An
    // entry this gate blocks on with a declared branch must be on it, or its red blocks a bump
    // without anyone being told why. publish-npm (branch null) is the declared exception: the
    // canary deliberately refuses an undeclared branch, so it cannot read an any-ref badge.
    const canary = readFileSync(CANARY, 'utf8');
    const watched = /WATCHED="\$\{XREPO_CI_WATCHED-([\s\S]*?)\}"/.exec(canary)?.[1] ?? '';
    const rows = watched.split('\n').map((l) => l.trim().split('|'));
    for (const e of RELEASE_BLOCKING_WORKFLOWS.filter((x: { branch: string | null }) => x.branch !== null)) {
      const hit = rows.find((r) => r[0] === e.repo && r[1] === e.workflow && r[3] === e.branch);
      expect(hit, `${e.workflow}@${e.branch} must be a WATCHED row`).toBeTruthy();
    }
  });
});

describe('wiring', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  it('is INVOKED from package.json, not merely mentioned', () => {
    expect(pkg.scripts['release:readiness']).toBe('node scripts/check-release-readiness.mjs');
    expect(pkg.scripts['release:readiness:selftest']).toBe('node scripts/check-release-readiness.mjs --self-test');
  });

  it('is NOT in prepublishOnly and NOT in the pre-verify workflow', () => {
    // prepublishOnly is the rehearsal's own corpus, and a live-badge read inside the publish lane
    // would red the lane on a GitHub CDN hiccup.
    expect(pkg.scripts.prepublishOnly).not.toContain('check-release-readiness');
    expect(pkg.scripts.prepublishOnly).not.toContain('release:readiness');
    const wf = readFileSync(join(ROOT, '.github/workflows/publish-lane-preverify.yml'), 'utf8');
    expect(wf).not.toMatch(/^\s*run:.*check-release-readiness/m);
  });

  it('never calls process.exit() — a queued pipe write would lose the token', () => {
    // The defect that kept the pre-verify red unread: the rehearsal printed its verdict into a
    // pipe and process.exit() discarded it. This gate is read through `npm run`, i.e. a pipe.
    const code = stripJsComments(readFileSync(GATE, 'utf8'));
    expect(code).not.toMatch(/process\.exit\s*\x28/);
    expect(code).toMatch(/process\.exitCode\s*=/);
  });
});
