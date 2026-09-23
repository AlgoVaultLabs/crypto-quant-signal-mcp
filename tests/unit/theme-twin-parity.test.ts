/**
 * DESIGN-SURFACE-TOKENS-W1 CH1 — channel-twin parity, as a vitest so CI runs it even when the
 * injector's own `--self-test` is not invoked.
 *
 * WHY THIS IS NOT COVERED BY check-token-resolution.mjs (measured, Plan Mode 2026-09-22): that
 * gate globs `src/**\/*.ts` and keeps only files containing `</body>` — 3 pages — so it never
 * reads `landing/**`, and it cannot see tokens that reach a page through an imported renderer.
 * A region consuming `var(--does-not-exist-lch)` still scored TOKEN_RESOLUTION_VERDICT=PASS.
 *
 * What a drift here would DO, measured in a browser: an undefined channel makes the whole
 * `oklch()` value invalid at computed-value time, so cards, nav and the page background compute
 * transparent — a white page, on every public surface, until someone notices.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { twinParityProblems, parseTwins, parseChannelRefs, channelConsumers, REPO_ROOT } from '../../scripts/build_theme.mjs';
import { renderThemeRegion } from '../../src/lib/site-theme.js';

const CSS = fs.readFileSync(path.join(REPO_ROOT, 'landing', '_design', 'algovault-design.css'), 'utf8');
const here = path.dirname(fileURLToPath(import.meta.url));

describe('theme twin parity', () => {
  it('every channel the region and the producers consume is a :root twin with a matching fallback', () => {
    const corpus = [
      { label: 'region', text: renderThemeRegion() },
      ...channelConsumers().map((f: string) => ({ label: path.relative(REPO_ROOT, f), text: fs.readFileSync(f, 'utf8') })),
    ];
    expect(corpus.length).toBeGreaterThan(1);
    expect(twinParityProblems(corpus, CSS)).toEqual([]);
  });

  it('MUST-CATCH a typo’d twin name', () => {
    expect(twinParityProblems([{ label: 'x', text: 'oklch(var(--surfce-lch, 0.18 0.014 265) / 1)' }], CSS)).toHaveLength(1);
    expect(twinParityProblems([{ label: 'x', text: 'oklch(var(--surface-lchh, 0.18 0.014 265) / 1)' }], CSS)).toHaveLength(1);
  });

  it('MUST-CATCH a drifted fallback value', () => {
    expect(twinParityProblems([{ label: 'x', text: 'oklch(var(--surface-lch, 0.19 0.014 265) / 1)' }], CSS)).toHaveLength(1);
  });

  it('MUST-CATCH a channel with no fallback (the 4h stale-stylesheet window)', () => {
    expect(twinParityProblems([{ label: 'x', text: 'oklch(var(--surface-lch) / 1)' }], CSS)).toHaveLength(1);
  });

  it('parses :root twins and oklch(var()) references', () => {
    const twins = parseTwins(CSS);
    expect(twins['--surface-lch']).toBe('0.18 0.014 265');
    expect(twins['--well-lch']).toBe('0.13 0.012 265');
    expect(parseChannelRefs('oklch(var(--bg-lch, 0.16 0.012 265) / 0.85)')).toEqual([
      { name: '--bg-lch', fallback: '0.16 0.012 265' },
    ]);
  });

  it('keeps this test file out of its own corpus (a gate that scans itself reports its fixtures)', () => {
    const consumers = channelConsumers().map((f: string) => path.resolve(f));
    expect(consumers).not.toContain(path.resolve(here, 'theme-twin-parity.test.ts'));
    expect(consumers).not.toContain(path.resolve(REPO_ROOT, 'scripts', 'build_theme.mjs'));
  });
});
