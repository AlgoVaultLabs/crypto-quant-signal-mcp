/**
 * OPS-INTEGRATIONS-LIVE-SOT-W1 — drift guard for landing/integrations/*.html.
 *
 * These 16 pages are COMMITTED static HTML served from the container, and the
 * deploy-time snapshot injector (scripts/snapshot-landing-data.mjs) does not
 * reach them — so a number baked here rots silently until someone notices. It
 * did: `89.4%` / `56,375` sat live from 2026-04-26 to 2026-07-19, and the
 * knowledge-bundle builder ingests these page BODIES, so the stale figures
 * reached the public chat too.
 *
 * This canary makes the class un-regressable. It asserts the retired literals
 * and the DEAD live-proxy hooks never come back — a property that stays stable
 * no matter how far the live counter moves, which is why it is the CI-safe
 * guarantee rather than an equals-live check (`totalCalls` grows continuously;
 * an equality gate would be red within a minute of every refresh).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(REPO_ROOT, 'landing', 'integrations');
const PAGES = readdirSync(DIR).filter((f) => f.endsWith('.html')).sort();

/**
 * Every field key track-record-proxy.js actually calls setField() for.
 * A `data-tr-field` outside this set NEVER hydrates: its literal is frozen at
 * bake time and will rot. Keep in sync with landing/js/track-record-proxy.js.
 */
const LIVE_HOOKS = new Set([
  'pfe_wr', 'call_count', 'hold_rate', 'last_updated', 'asset_count',
  'exchange_count', 'timeframe_count', 'funding_venue_count',
  'total_calls_executed', 'batch_count', 'merkle_batch_count',
  'latest_batch_at', 'latest_batch_n', 'latest_batch', 'erc8004_agent_id',
]);

/** Literals retired by this wave. Each was live on a public page. */
const RETIRED_LITERALS: Array<[string, RegExp]> = [
  ['56,375 (2026-04-26 call count)', /56,375/],
  ['89.4 (2026-04-26 PFE WR)', /89\.4/],
  ['96,864 (framework-page call count)', /96,864/],
  ['">5</span> exchanges (pre-promotion venue count)', />5<\/span> exchanges/],
];

/** Hooks the proxy no longer sets — retired in favour of the live key. */
const DEAD_HOOKS: Array<[string, string]> = [
  ['signal_count', 'call_count'],
  ['total_calls', 'call_count'],
  ['merkle_batches', 'merkle_batch_count'],
];

describe('landing/integrations/*.html — stale-number drift guard', () => {
  it('finds the expected page set (guards against a silent glob miss)', () => {
    expect(PAGES.length).toBe(20);
    // Execution-kit tutorials for non-signal venues are intentional — kept, not
    // deleted, per Mr.1 2026-07-20. Their presence is asserted so a future
    // cleanup wave can't quietly drop them.
    for (const keep of ['gemini.html', 'kraken.html', 'alpaca.html']) {
      expect(PAGES).toContain(keep);
    }
  });

  for (const page of PAGES) {
    const html = readFileSync(join(DIR, page), 'utf8');

    it(`${page}: carries no retired track-record literal`, () => {
      for (const [label, re] of RETIRED_LITERALS) {
        expect(re.test(html), `${page} still contains ${label}`).toBe(false);
      }
    });

    it(`${page}: every data-tr-field is a hook the proxy actually hydrates`, () => {
      const keys = [...html.matchAll(/data-tr-field="([a-z_]+)"/g)].map((m) => m[1]);
      const dead = [...new Set(keys)].filter((k) => !LIVE_HOOKS.has(k));
      expect(
        dead,
        `${page} uses non-hydrating hook(s) ${dead.join(', ')} — their literals will rot. ` +
          `Retired mappings: ${DEAD_HOOKS.map(([o, n]) => `${o}→${n}`).join(', ')}`,
      ).toEqual([]);
    });

    it(`${page}: JSON-LD still parses`, () => {
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(blocks.length).toBeGreaterThan(0);
      for (const [, body] of blocks) {
        expect(() => JSON.parse(body)).not.toThrow();
      }
    });

    it(`${page}: crawler-facing prose carries no volatile number`, () => {
      // meta description / og:description / JSON-LD description cannot
      // self-heal — no client proxy runs for a crawler — so a number there
      // rots permanently. The fix is to carry none, not to refresh them.
      const metas = [...html.matchAll(/<meta (?:name="description"|property="og:description") content="([^"]*)"/g)].map((m) => m[1]);
      expect(metas.length).toBeGreaterThan(0);
      const jsonLdDescs = [...html.matchAll(/"description": "([^"]*)"/g)].map((m) => m[1]);
      for (const text of [...metas, ...jsonLdDescs]) {
        expect(
          /\d[\d,]*\+?\s*(?:calls|batches)|\d+\.\d+\s*%|\b\d+%\s*PFE/i.test(text),
          `crawler-facing prose in ${page} carries a volatile number: "${text}"`,
        ).toBe(false);
      }
    });
  }
});
