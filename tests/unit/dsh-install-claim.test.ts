/**
 * OPS-DSH-TUTORIAL-INSTALL-CLAIM-W1 (2026-08-29) — paired drift lock for the
 * DeepSeek Harness connect copy.
 *
 * The tutorial and the registry row both opened on an install step:
 *
 *     dsh plugin --profile <name> add @deepseek-ai/dsh-mcp-client@0.1.1-rc.2
 *
 * justified by a TRUE premise — the `base`, `headless` and `web-app` bundles
 * really do declare zero MCP dependencies — and a FALSE conclusion drawn from
 * it. Measured 2026-08-29 against the vendor:
 *
 *   1. `npm view @deepseek-ai/dsh@0.1.1-rc.2 dependencies` contains
 *      `"@deepseek-ai/dsh-mcp-client": "^0.1.1-rc.2"` — the CLI ships the
 *      bridge in its own closure.
 *   2. apps/cli/reference/README.md:96 — "The CLI also ships
 *      `@deepseek-ai/dsh-mcp-client` as a dependency for patch layers".
 *   3. apps/cli/reference/README.md:11 — a bare plugin `name` resolves through
 *      the profile directory's Node parent walk to
 *      `$DSH_HOME/profiles/node_modules`, fed by that closure and NOT by any
 *      bundle's package.json. Bundle membership is simply the wrong question.
 *   4. docs/user/guide/mcp-memory.md has ZERO `plugin add` occurrences; its
 *      "Bring another MCP server" section goes straight to an `- insert:` row.
 *   5. packages/mcp/mcp-client/package.json declares no `dsh` key, so per
 *      reference README:46 it "stays plain with a one-time warning" and never
 *      joins the layer stack — `plugin add` on it is inert, not merely
 *      redundant.
 *   6. packages/mcp/mcp-client/README.md — "Add one entry per server; nothing
 *      else is required."
 *
 * Two halves, per the project's forbidden-phrase-plus-positive-presence rule:
 * FORBIDDEN catches drift BACK to the invented step, PRESENT catches drift
 * AWAY from the correction (a surface silently regenerated from a stale
 * source, or a page dropped from the generator chain).
 *
 * Scoped to a FIXED file list — the two producers and the four artifacts they
 * generate — because an unscoped grep would trip on this file's own prose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The two hand-authored producers, then every artifact generated from them. */
const SURFACES = [
  'docs/integrations/mcp-clients/deepseek-harness.md',
  'src/lib/integrations-data/mcp-clients.ts',
  'landing/integrations/deepseek-harness.html',
  'landing/docs.html',
  'landing/mcp.html',
  'tests/fixtures/mcp-usage-html-pre-refactor.txt',
];

/**
 * Strip comments before grepping. A spec literal quoted in a maintenance
 * comment is documentation, not a live claim, and tripping on one is how this
 * class of canary gets disabled.
 *
 * The strip is chosen BY FILE TYPE, not applied as a union. Running the JS
 * block-comment pattern over `landing/docs.html` deleted the deepseek-harness
 * walkthrough outright: the page carries inline `<style>`/`<script>` blocks, so
 * a `/*` far above the section paired with a `*` + `/` far below it and the
 * lazy match swallowed everything between. The positive-presence half then
 * failed on a page that was correct — a false red on a real surface, which is
 * the fastest route to a disabled canary.
 */
function readStripped(rel: string): string {
  const abs = join(REPO_ROOT, rel);
  const raw = readFileSync(abs, 'utf8');
  if (rel.endsWith('.ts')) return raw.replace(/\/\*[\s\S]*?\*\//g, '');
  if (rel.endsWith('.html') || rel.endsWith('.txt')) return raw.replace(/<!--[\s\S]*?-->/g, '');
  return raw; // markdown: no comment syntax in play on this page
}

const FORBIDDEN: { phrase: RegExp; why: string }[] = [
  {
    phrase: /dsh\s+plugin\s+--profile/i,
    why: 'the invented install step — the CLI already ships the bridge',
  },
  {
    phrase: /pnpm/i,
    why: 'pnpm was a prerequisite only of the install step that no longer exists',
  },
  {
    phrase: /Two steps/i,
    why: 'the connect path is one step: the cordis.patch.yml entry',
  },
  {
    phrase: /BSD-3-Clause/i,
    why: 'the licence hazard was reachable only through the invented step; ^0.1.1-rc.2 resolves to MIT',
  },
  {
    phrase: /0\.0\.1-rc\.1/,
    why: "the mcp-client `latest` tag is irrelevant once the reader takes the CLI's own resolved copy",
  },
];

describe('OPS-DSH-TUTORIAL-INSTALL-CLAIM-W1 — no DSH install step in public copy', () => {
  it('every scoped surface exists (vacuity guard)', () => {
    for (const rel of SURFACES) {
      expect(existsSync(join(REPO_ROOT, rel)), `${rel} is missing`).toBe(true);
    }
    expect(SURFACES.length, 'surface list is non-empty').toBeGreaterThan(0);
    expect(FORBIDDEN.length, 'forbidden list is non-empty').toBeGreaterThan(0);
  });

  for (const rel of SURFACES) {
    it(`${rel} carries no install-step phrasing`, () => {
      const body = readStripped(rel);
      for (const { phrase, why } of FORBIDDEN) {
        expect(phrase.test(body), `${rel} matches ${phrase} — ${why}`).toBe(false);
      }
    });

    it(`${rel} states the bridge ships with the CLI`, () => {
      const body = readStripped(rel);
      expect(
        /dependency closure/i.test(body),
        `${rel} lost the "dependency closure" fact — regenerate it from its producer`,
      ).toBe(true);
    });
  }

  it('the markdown tutorial keeps the verified `- insert:` wrapper guidance', () => {
    const md = readStripped('docs/integrations/mcp-clients/deepseek-harness.md');
    expect(md).toContain('- insert:');
    expect(/wrapper is required/i.test(md)).toBe(true);
    // The vendor's own mcp-memory.md "Bring another MCP server" section uses
    // this wrapper; the bridge README's unwrapped form documents the plugin
    // config shape, not a cordis.patch.yml edit. Keeping both facts is the
    // genuinely load-bearing part of this page.
    expect(/cordis\.patch\.yml/.test(md)).toBe(true);
  });
});
