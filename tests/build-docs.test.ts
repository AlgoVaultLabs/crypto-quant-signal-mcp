import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Authored as .ts (vitest) not the spec's .mjs to avoid the node:test/vitest double-run trap
// (CHANNEL-HUB-PAGES-GEO-W1 precedent). Drives the REAL scripts/build_docs.mjs entrypoint as a
// subprocess. READ-ONLY on landing/docs.html: it asserts against the COMMITTED (build:landing-
// filled) docs.html and never regenerates it mid-suite — build-channel-pages.test.ts (a parallel
// worker) READS docs.html, so writing it here would race. The missing-partial gate exits BEFORE
// build_docs writes, so that case is write-free too.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (args: string[]) =>
  execFileSync('node', ['scripts/build_docs.mjs', ...args], { cwd: REPO, encoding: 'utf8' });
const runExpectFail = (args: string[]): { code: number; out: string } => {
  try {
    run(args);
    return { code: 0, out: '' };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};
const docsHtml = () => fs.readFileSync(path.join(REPO, 'landing', 'docs.html'), 'utf8');

describe('build_docs.mjs generator', () => {
  beforeAll(() => {
    // dist must exist for the outline import (the gate runs `tsc` first; do it here so the suite
    // is self-contained). We do NOT run build:landing — docs.html is asserted in its committed state.
    execFileSync('npx', ['tsc'], { cwd: REPO, stdio: 'ignore' });
  });

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

  it('MISSING PARTIAL is a hard build failure (never a silent drop; exits before writing docs.html)', () => {
    const victim = path.join(REPO, 'docs-src', 'partials', 'faq.html');
    const bak = `${victim}.bak`;
    fs.renameSync(victim, bak);
    try {
      // build_docs checks partial coverage and exits 1 BEFORE generate()/write — docs.html untouched.
      const { code, out } = runExpectFail([]);
      expect(code).not.toBe(0);
      expect(out).toMatch(/MISSING partial/i);
      expect(out).toContain('faq.html');
    } finally {
      fs.renameSync(bak, victim);
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
