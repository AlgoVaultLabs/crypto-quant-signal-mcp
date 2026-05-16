/**
 * REVERT-DASHBOARD-SHADOW-COPY-W1 canary suite.
 *
 * Locks the post-2026-05-16 invariant per Mr.1's
 * `feedback_dashboard_changes_require_explicit_permission` rule:
 *   - No public-facing surface ships shadow-venue marketing copy on the
 *     dashboard header subtitle, the Asset Tiers methodology table Tier 3
 *     row, or the README/landing FAQ TradFi description.
 *   - The shadow state machine itself (venues table, evaluate-venues cron,
 *     /api/performance-shadow endpoint, _algovault.venue_status envelope,
 *     mcp://algovault/venues resource, tools/list describe-text caveat)
 *     remains UNCHANGED — those are technical surfaces, not public copy.
 *
 * Forbidden phrases on PUBLIC surfaces (src/index.ts dashboard,
 * src/lib/asset-tiers.ts, landing/*.html, landing/llms*.txt, README.md,
 * NPM-readme-DRAFT.md is owned by the vault but synced to README):
 *   - "promoted exchanges"
 *   - "0 shadow (experimental"
 *   - "seeded across <list> via demand-driven"
 *   - "demand-driven SHADOW-SEED-W1 fan-out"
 *
 * EXCLUDED from the canary (internal docs):
 *   - system-map.md (vault-only; internal documentation)
 *   - audits/* (internal artifacts)
 *   - CHANGELOG.md (historical; documents the removal of the claim)
 *   - this canary file (documents the forbidden phrases as values)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

const PUBLIC_SURFACES = [
  'src/index.ts',
  'src/lib/asset-tiers.ts',
  'src/lib/welcome-page.ts',
  'src/tools/get-trade-call.ts',
  'src/tools/get-market-regime.ts',
  'README.md',
  'landing/index.html',
  'landing/docs.html',
  'landing/track-record.html',
  'landing/how-it-works.html',
  'landing/integrations.html',
  'landing/verify.html',
  'landing/skills.html',
  'landing/llms.txt',
  'landing/llms-full.txt',
];

const FORBIDDEN: { regex: RegExp; description: string }[] = [
  { regex: /promoted exchanges/i, description: '"promoted exchanges" — leaks shadow-venue framing into public copy' },
  { regex: /\b0 shadow \(experimental/i, description: '"0 shadow (experimental" — dashboard subtitle pattern reverted by Mr.1' },
  { regex: /seeded across[^.]*via demand-driven/i, description: '"seeded across … via demand-driven" — Tier 3 description pattern reverted' },
  { regex: /demand-driven SHADOW-SEED-W1 fan-out/i, description: '"demand-driven SHADOW-SEED-W1 fan-out" — internal-only language' },
];

describe('REVERT-DASHBOARD-SHADOW-COPY-W1 — forbidden-phrase canary on public surfaces', () => {
  it('no public surface ships shadow-mode marketing copy', () => {
    const violations: string[] = [];
    for (const surface of PUBLIC_SURFACES) {
      const abs = join(REPO_ROOT, surface);
      if (!existsSync(abs)) continue;
      const txt = readFileSync(abs, 'utf8');
      for (const { regex, description } of FORBIDDEN) {
        if (regex.test(txt)) {
          violations.push(`${surface}: ${description}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('dashboard header subtitle uses simple "Exchanges + assets" copy (no shadow-mode framing)', () => {
    const indexTs = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');
    // The function-rendered /track-record dashboard subtitle should match
    // the Mr.1-directed shape: v<version> · <N> Exchanges · <N> assets
    // (with optional `data-tr-field` spans wrapping the variable bits).
    expect(indexTs).toMatch(/data-tr-field="exchange_count"[^<]*<\/span>\s*Exchanges/);
    expect(indexTs).not.toMatch(/data-tr-field="exchange_count"[^<]*<\/span>\s*promoted exchanges/);
    expect(indexTs).not.toMatch(/data-tr-field="shadow_venue_count"/);
  });

  it('dashboard header asset count is live-bound via data-tr-field="asset_count" (no hardcoded "710+")', () => {
    const indexTs = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');
    // After the revert: span exists, no `+` suffix on the displayed digit,
    // and no `710+` literal anywhere in the dashboard header region.
    expect(indexTs).toMatch(/data-tr-field="asset_count">\d+<\/span>\s*assets/);
    // Old shape: `<span data-tr-field="asset_count">710</span>+ assets`
    expect(indexTs).not.toMatch(/data-tr-field="asset_count">\d+<\/span>\+\s*assets/);
  });

  it('asset-tiers.ts Tier 3 description is simply "stocks, indices, commodities, FX" (no parenthetical)', () => {
    const tiersTs = readFileSync(join(REPO_ROOT, 'src/lib/asset-tiers.ts'), 'utf8');
    expect(tiersTs).toMatch(/tier:\s*3[^}]*description:\s*'TradFi perps — stocks, indices, commodities, FX'/);
    expect(tiersTs).not.toMatch(/seeded across/);
  });

  it('shadow state machine technical surfaces UNCHANGED — venue_status envelope field still present', () => {
    // The state machine itself (venues table, evaluate-venues cron, MCP
    // resource, /api/performance-shadow endpoint) is OUT of revert scope.
    // Verify the technical surfaces still exist.
    const indexTs = readFileSync(join(REPO_ROOT, 'src/index.ts'), 'utf8');
    expect(indexTs).toContain('/api/performance-shadow'); // endpoint still registered
    expect(indexTs).toContain("'venues'"); // mcp://algovault/venues resource still registered
    const getTradeCallTs = readFileSync(join(REPO_ROOT, 'src/tools/get-trade-call.ts'), 'utf8');
    expect(getTradeCallTs).toContain('venue_status'); // envelope field still populated
  });
});
