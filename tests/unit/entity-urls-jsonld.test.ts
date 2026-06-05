/**
 * ENTITY-FOOTPRINT-W1 R1 — entity-urls config -> canonical Organization sameAs.
 *
 * Unit-tests the generator's pure exports (network-free; main() is entrypoint-guarded
 * so importing the .mjs does NOT trigger a live fetch) + asserts the rendered contract:
 *   - null / absent / "" entity-urls entries are EXCLUDED from sameAs (the config flip lever);
 *   - the homepage serves ONE full Organization node (@id + sameAs + name);
 *   - every other page references it by @id only (no duplicate full node).
 *
 * Run under the gate via `npm test` (vitest). The node:test CI guard
 * (geo_jsonld_consistency.test.mjs) enforces the same rendered invariant on every deploy.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSameAs,
  SAMEAS_KEY_ORDER,
  ORG_ID,
  ORG_REF_NODE,
  loadEntityUrls,
} from '../../scripts/generate_jsonld.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LANDING_DIR = path.resolve(__dirname, '..', '..', 'landing');

function orgBlock(html: string): any {
  const m = html.match(
    /<script type="application\/ld\+json" data-algovault-jsonld="Organization">\s*([\s\S]*?)\s*<\/script>/,
  );
  return m ? JSON.parse(m[1]) : null;
}

describe('ENTITY-FOOTPRINT-W1 — entity-urls -> Organization sameAs', () => {
  it('buildSameAs excludes null / undefined / empty-string entries (the deferral lever)', () => {
    const out = buildSameAs({
      github: 'https://github.com/AlgoVaultLabs',
      x: 'https://x.com/AlgoVaultLabs',
      npm: 'https://www.npmjs.com/package/crypto-quant-signal-mcp',
      crunchbase: null,
      g2: null,
      capterra: undefined,
      wikidata: '',
    });
    expect(out).toEqual([
      'https://github.com/AlgoVaultLabs',
      'https://x.com/AlgoVaultLabs',
      'https://www.npmjs.com/package/crypto-quant-signal-mcp',
    ]);
    expect(out).not.toContain(null);
  });

  it('buildSameAs renders in canonical key order, not input order', () => {
    expect(buildSameAs({ npm: 'N', github: 'G', x: 'X' })).toEqual(['G', 'X', 'N']);
  });

  it('buildSameAs returns [] when every profile is deferred (all null)', () => {
    const allNull = Object.fromEntries(SAMEAS_KEY_ORDER.map((k) => [k, null]));
    expect(buildSameAs(allNull)).toEqual([]);
  });

  it('buildSameAs ignores non-allowlisted keys (e.g. _comment)', () => {
    expect(buildSameAs({ _comment: 'docs', github: 'G' })).toEqual(['G']);
  });

  it('the committed entity-urls.json yields exactly github/x/npm initially', async () => {
    const cfg = await loadEntityUrls();
    expect(buildSameAs(cfg)).toEqual([
      'https://github.com/AlgoVaultLabs',
      'https://x.com/AlgoVaultLabs',
      'https://www.npmjs.com/package/crypto-quant-signal-mcp',
    ]);
    for (const deferred of ['crunchbase', 'g2', 'capterra', 'wikidata']) {
      expect(cfg[deferred], `${deferred} must stay null until live`).toBeNull();
    }
  });

  it('ORG_REF_NODE is a bare @id reference (no @type/name/sameAs)', () => {
    expect(ORG_REF_NODE['@id']).toBe(ORG_ID);
    expect(ORG_REF_NODE['@context']).toBe('https://schema.org');
    expect(ORG_REF_NODE).not.toHaveProperty('@type');
    expect(ORG_REF_NODE).not.toHaveProperty('name');
    expect(ORG_REF_NODE).not.toHaveProperty('sameAs');
  });

  it('homepage serves ONE full Organization node (@id + sameAs + name)', async () => {
    const node = orgBlock(await readFile(path.join(LANDING_DIR, 'index.html'), 'utf-8'));
    expect(node).toBeTruthy();
    expect(node['@id']).toBe(ORG_ID);
    expect(node['@type']).toBe('Organization');
    expect(node.name).toBe('AlgoVault Labs');
    expect(Array.isArray(node.sameAs)).toBe(true);
    expect(node.sameAs.length).toBeGreaterThanOrEqual(3);
    expect(node.sameAs).toContain('https://x.com/AlgoVaultLabs');
    expect(node.sameAs.join(' ')).not.toMatch(/crunchbase|wikidata|capterra|g2\.com/i);
  });

  it('every non-homepage page references the Organization by @id only', async () => {
    for (const f of ['faq.html', 'docs.html', 'verify.html', 'privacy.html']) {
      const node = orgBlock(await readFile(path.join(LANDING_DIR, f), 'utf-8'));
      expect(node, `${f} Organization block`).toBeTruthy();
      expect(node['@id'], `${f} @id`).toBe(ORG_ID);
      expect(node, `${f} must be a reference, not a full node`).not.toHaveProperty('name');
      expect(node, `${f} must not re-declare sameAs`).not.toHaveProperty('sameAs');
    }
  });
});
