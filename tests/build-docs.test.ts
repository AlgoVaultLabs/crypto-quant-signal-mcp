import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Authored as .ts (vitest) not the spec's .mjs to avoid the node:test/vitest double-run trap
// (CHANNEL-HUB-PAGES-GEO-W1 precedent). Drives the REAL scripts/build_docs.mjs entrypoint as a
// subprocess. READ-ONLY on landing/docs.html: it asserts against the COMMITTED (build:landing-
// filled) docs.html and never regenerates it mid-suite — build-channel-pages.test.ts (a parallel
// worker) READS docs.html, so writing it here would race.
//
// OPS-X402-PAYER-WALLET-MIGRATION-W1 CORRECTION: that reasoning was RIGHT about the output and
// INCOMPLETE about the input. The missing-partial case does exit before any write, but it used to
// provoke the failure by renaming the REAL docs-src/partials/faq.html aside — and a shared repo
// file being mutated mid-suite is a race whether it is read or written downstream. It now runs in
// its own sandbox; see the comment on that test for the measured failure.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (args: string[]) =>
  execFileSync('node', ['scripts/build_docs.mjs', ...args], { cwd: REPO, encoding: 'utf8' });
const runExpectFail = (args: string[], cwd: string = REPO): { code: number; out: string } => {
  try {
    execFileSync('node', ['scripts/build_docs.mjs', ...args], { cwd, encoding: 'utf8' });
    return { code: 0, out: '' };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};
const docsHtml = () => fs.readFileSync(path.join(REPO, 'landing', 'docs.html'), 'utf8');

describe('build_docs.mjs generator', () => {
  beforeAll(() => {
    // build_docs imports dist/lib/docs-outline.js. CI + the pre-push gate run `npm run build`
    // BEFORE the suite, so dist is normally already present — only compile if MISSING. (A full
    // `tsc` here exceeds vitest's 10s default hookTimeout on a cold CI runner — the pre-deploy
    // gate flaked on exactly that.) We do NOT run build:landing — docs.html is asserted committed.
    const dist = path.join(REPO, 'dist', 'lib', 'docs-outline.js');
    if (!fs.existsSync(dist)) execFileSync('npx', ['tsc'], { cwd: REPO, stdio: 'ignore' });
  }, 120_000);

  it('--verify-partials passes (every outline partial present)', () => {
    expect(run(['--verify-partials'])).toMatch(/all \d+ outline partials present/);
  });

  it('--check passes on the committed docs.html (sidebar === body === outline; no drift)', () => {
    expect(run(['--check'])).toMatch(/OK — sidebar === body === outline/);
  });

  it('the committed docs.html carries the target IA + registry back-fill', () => {
    const html = docsHtml();
    // Tools back-fill (the previously-undocumented scanner) + friendly heading + code name
    expect(html).toMatch(/id="scan-trade-calls"/);
    expect(html).toMatch(/Trade Call\s*<span[^>]*>get_trade_call<\/span>/);
    // Channels section (4) + Ecosystem connect markers (filled by build_landing, markers remain)
    for (const id of ['mcp', 'rest-api', 'webhooks', 'telegram']) expect(html).toContain(`id="${id}"`);
    for (const m of ['connect-mcp-client', 'connect-ai-agent', 'connect-exchange-kit'])
      expect(html).toContain(`<!-- BUILD:${m}:start -->`);
    // NAV region preserved for build_nav; signup-flow slot present for build_landing
    expect(html).toContain('<!-- NAV:START -->');
    expect(html).toContain('<!-- BUILD:signup-flow:start -->');
    // equities held off public docs
    expect(html).not.toContain('id="get-equity-call"');
  });

  it('MISSING PARTIAL is a hard build failure (never a silent drop)', () => {
    // IN ITS OWN SANDBOX, and the reason is a measured flake rather than caution.
    //
    // This used to rename the REAL docs-src/partials/faq.html aside and restore it in `finally`.
    // That is write-free with respect to landing/docs.html — which is what this file's header
    // reasoned about — and it raced anyway, because the shared artifact it mutated was an INPUT.
    // tests/build-docs-foreign-markers.test.ts builds its sandbox with
    // `cpSync(REPO/docs-src, …)` in a PARALLEL WORKER; a copy taken inside this rename window
    // yields a sandbox permanently missing faq.html, and all three of that file's end-to-end tests
    // then fail with "1 MISSING partial(s) — refusing to generate".
    //
    // Measured 2026-09-01: green in isolation, green in three consecutive local full runs, and it
    // blocked a push by flagging the OTHER file as a NEW failure. The pre-push gate was right and
    // the two green local runs were the luck.
    //
    // The rule this sharpens: never mutate a shared repo file mid-suite — INPUTS INCLUDED. A
    // sibling that copies a whole tree is indistinguishable from a sibling that reads one file,
    // and "I put it back in `finally`" does not help a reader scheduled in between.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'build-docs-missing-partial-'));
    try {
      for (const d of ['scripts', 'docs-src', 'landing']) {
        fs.cpSync(path.join(REPO, d), path.join(sandbox, d), { recursive: true });
      }
      // dist is a read-only input (docs-outline + footer-content) — symlink, never copy.
      fs.symlinkSync(path.join(REPO, 'dist'), path.join(sandbox, 'dist'), 'dir');

      const victim = path.join(sandbox, 'docs-src', 'partials', 'faq.html');
      expect(fs.existsSync(victim), 'the sandbox copy must contain the partial we are about to remove').toBe(true);
      fs.rmSync(victim);

      const { code, out } = runExpectFail([], sandbox);
      expect(code).not.toBe(0);
      expect(out).toMatch(/MISSING partial/i);
      expect(out).toContain('faq.html');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('every legacy anchor id is present in docs.html (no dead links)', () => {
    const html = docsHtml();
    for (const legacy of [
      'get-trade-signal', 'knowledge-tools-chat', 'knowledge-tools-search', 'knowledge-tools-when',
      'knowledge-tools-examples', 'knowledge-tools-quota', 'knowledge-tools-api', 'x402',
      'testing-with-curl', 'on-chain-verification', 'usage-examples',
    ]) {
      expect(html).toContain(`id="${legacy}"`);
    }
  });
});
