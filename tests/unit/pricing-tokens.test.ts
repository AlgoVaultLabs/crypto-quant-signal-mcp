/**
 * PRICING-FOLLOWUPS-GENERATOR-W1 CH3 — the ladder is a TOKEN, never a literal, in every
 * tutorial source that renders into this repo.
 *
 * WHAT THIS RETIRES. CH7 of the previous wave fixed the RENDERED integration pages while their
 * SOURCES — in the separate `algovault-skills` repo — still said "100 calls/month".
 * `render-integrations.mjs` is manual and ungated, so the next run would have silently reverted
 * published copy. Hand-syncing the literals resets that clock; tokenizing retires the class.
 *
 * WHY THE SOURCES ARE OPTIONAL HERE. They live in another repo that this suite cannot require
 * to be checked out. So: when the clone is reachable the assertions RUN; when it is not, the
 * test says so out loud and the deploy-side `--check` on `ops/pricing-tokens.json` still holds.
 * A skip that prints nothing would be indistinguishable from a pass.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The 9 sources measured as carrying a ladder literal — the 7 exchanges + maf + the TEMPLATE. */
const TOKENIZED = ['binance', 'okx', 'hyperliquid', 'aster', 'bingx', 'kucoin', 'gateio', 'maf', '_template'];

/** Ladder literals that must never reappear in a tutorial source. */
const STALE = /100 calls\/month|3,000 calls|15,000 calls|15K calls|\$79\b|\$299\/yr|interval=year/;

/**
 * Candidate clones, in preference order.
 *
 * Anchored on the DECLARED repo root (`~/code` per CLAUDE.md) rather than on a relative hop from
 * ROOT: this file runs from both the primary checkout and a worktree, which sit at different
 * depths, so `../..` resolves to two different places and silently found neither. `~/git` was
 * retired by OPS-WORKTREE-ROOT-CONFINEMENT-W2 and is deliberately not probed.
 */
const CODE = process.env.ALGOVAULT_CODE_ROOT || join(homedir(), 'code');
const CANDIDATES = [
  process.env.ALGOVAULT_SKILLS_PATH || '',
  join(CODE, '.worktrees', 'algovault-skills', 'pricing-tokens'),
  join(CODE, 'algovault-skills'),
].filter(Boolean);
const skills = CANDIDATES.find((p) => existsSync(join(p, 'docs', 'integrations', '_template.md')));

describe('pricing tokens — the emitted SoT', () => {
  const tokens = JSON.parse(readFileSync(join(ROOT, 'ops', 'pricing-tokens.json'), 'utf8')).tokens as Record<string, string>;

  it('is committed, non-empty, and every token is a non-empty string', () => {
    expect(Object.keys(tokens).length).toBeGreaterThanOrEqual(10);
    for (const [k, v] of Object.entries(tokens)) {
      expect(typeof v, k).toBe('string');
      expect(v.length, k).toBeGreaterThan(0);
    }
  });

  it('projects the live ladder — a stale emit fails HERE, not on a published page', async () => {
    const plans = await import('../../src/lib/plans.js');
    expect(tokens.free_monthly).toBe(plans.FREE_MONTHLY_CALLS.toLocaleString('en-US'));
    expect(tokens.free_daily).toBe(plans.FREE_DAILY_CALLS.toLocaleString('en-US'));
    expect(tokens.free_allowance).toBe(`${tokens.free_monthly} calls/month (${tokens.free_daily}/day)`);
    expect(tokens.starter_monthly).toBe(plans.planCallsLabel('starter'));
    expect(tokens.pro_monthly).toBe(plans.planCallsLabel('pro'));
    expect(tokens.starter_prepay).toBe(plans.planPrepayPriceLabel('starter', plans.PREPAY_6MONTH_MONTHS));
    expect(tokens.pro_prepay).toBe(plans.planPrepayPriceLabel('pro', plans.PREPAY_6MONTH_MONTHS));
  });

  it('carries no retired annual figure — those Prices are archived', () => {
    const blob = JSON.stringify(tokens);
    for (const dead of ['$79', '$299/yr', 'interval=year', '6.58', '24.92']) {
      expect(blob, `retired annual figure ${dead} in the token SoT`).not.toContain(dead);
    }
  });
});

describe('tutorial sources carry placeholders, never ladder literals', () => {
  it('the skills clone is reachable (otherwise the assertions below are inert — say so)', () => {
    if (!skills) {
      console.warn(
        '[pricing-tokens] algovault-skills not found at any known path — the source assertions did NOT run.\n' +
        `  looked in: ${CANDIDATES.join(', ')}\n` +
        '  ops/pricing-tokens.json --check still gates the emitted SoT on deploy.',
      );
    }
    expect(true).toBe(true);
  });

  it.runIf(!!skills)('all 9 sources use {{PRICING.*}} and none carries a raw ladder literal', () => {
    const missing: string[] = [];
    const stale: string[] = [];
    for (const m of TOKENIZED) {
      const p = join(skills as string, 'docs', 'integrations', `${m}.md`);
      if (!existsSync(p)) { missing.push(m); continue; }
      const src = readFileSync(p, 'utf8');
      if (!src.includes('{{PRICING.')) missing.push(`${m} (no placeholder)`);
      if (STALE.test(src)) stale.push(`${m}: ${STALE.exec(src)?.[0]}`);
    }
    expect(missing, 'sources missing their pricing placeholder').toEqual([]);
    expect(stale, 'a hand-typed ladder literal is back in a tutorial source').toEqual([]);
  });

  it.runIf(!!skills)('the TEMPLATE is tokenized — otherwise every future tutorial reintroduces the literal', () => {
    // The rider on ruling Q3. `_template.md` is the generator: leaving it hand-typed means the
    // class comes back with the next tutorial, and a copy of the template fails CLOSED on an
    // unresolved placeholder rather than shipping a stale number.
    const t = readFileSync(join(skills as string, 'docs', 'integrations', '_template.md'), 'utf8');
    expect(t).toContain('{{PRICING.free_allowance}}');
    expect(STALE.test(t)).toBe(false);
  });

  it.runIf(!!skills)('every placeholder used by a source resolves to a real token key', () => {
    const tokens = JSON.parse(readFileSync(join(ROOT, 'ops', 'pricing-tokens.json'), 'utf8')).tokens;
    const unknown: string[] = [];
    for (const m of TOKENIZED) {
      const p = join(skills as string, 'docs', 'integrations', `${m}.md`);
      if (!existsSync(p)) continue;
      for (const mt of readFileSync(p, 'utf8').matchAll(/\{\{PRICING\.([a-z0-9_]+)\}\}/g)) {
        if (!(mt[1] in tokens)) unknown.push(`${m}: ${mt[1]}`);
      }
    }
    // The renderer fails closed on these too; catching them here means a typo fails in CI rather
    // than at the manual render step nobody runs until the next tutorial.
    expect(unknown, 'placeholder naming a token key that does not exist').toEqual([]);
  });
});
