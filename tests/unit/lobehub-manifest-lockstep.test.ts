import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publicToolNames,
  getFeature,
  servedDescription,
  projectCapabilities,
} from '../../src/lib/feature-registry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * NPM-PUBLISH-v1.28.1-W1 R1 — the lockstep `system-map.md:205` DECLARED and nothing enforced.
 *
 * That row says *"`src/tool-descriptions.ts` SoT, mirrored by `lobehub-manifest.json` api[]"*, and
 * CLAUDE.md's pre-publish ritual says to *"audit `api[].description` vs live `tools/list`"*. Both
 * are prose. Measured 2026-08-24, the audit failed **7 of 7**, and — the part that proves it was
 * accumulated rather than one missed sync — it failed in BOTH directions: `get_trade_call` and
 * `get_trade_signal` were BEHIND the SoT while the other five were AHEAD of it.
 *
 * A declared mirror with no gate is not a mirror. This is the gate.
 *
 * ── WHY IT COMPARES AGAINST THE REPO AND NEVER THE NETWORK ──────────────────
 * A gate that fetches its decision input degrades to a PASS exactly when the network is degraded,
 * indistinguishably from clean — the `generate_jsonld --check` lesson. So this is a unit test over
 * committed bytes: `lobehub-manifest.json` versus the exported resolver. The live surfaces are
 * verified separately, post-publish, where a transport failure is visible as a transport failure.
 *
 * ── WHY IT ASSERTS TWO SURFACES ─────────────────────────────────────────────
 * There are TWO public description surfaces, and when this wave started they disagreed.
 * `src/index.ts` composed the alias as base + suffix (`tools/list` → 488 chars, carrying
 * *"Prefer get_trade_call for new integrations."*) while `projectCapabilities()` spread the BASE
 * description onto every alias (`/capabilities` → 346, hint absent). The alias hint is the entire
 * steering signal `TDQS-RELATIONAL-DEFECTS-W1` shipped, and exactly one surface carried it.
 *
 * Both now project from `servedDescription()`, and both are asserted here — because a gate that
 * watched only the manifest would have let that divergence stand.
 *
 * ── MEMBERSHIP ──────────────────────────────────────────────────────────────
 * `publicToolNames()` (ENABLED and not `publicListing: false`) plus each canonical name's aliases.
 * That is 6 + 1 = 7 and it excludes `get_equity_call` / `get_equity_regime` BY CONSTRUCTION rather
 * than by an exclusion list — equities are dark behind `EQUITY_TOOLS_ENABLED` (default OFF) and
 * under a standing public-copy HOLD, so they must never appear in a distribution manifest. If the
 * hold is ever lifted, flipping `publicListing` moves them here and into the manifest together.
 */

interface ApiEntry {
  name?: string;
  description?: string;
}

/** Every callable name the PUBLIC distribution surfaces should advertise → its served description. */
function publicServedDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const canonical of publicToolNames()) {
    const f = getFeature(canonical);
    if (!f) continue;
    for (const name of [f.name, ...f.aliases]) {
      const d = servedDescription(name);
      if (d != null) out.set(name, d);
    }
  }
  return out;
}

function manifestApi(): ApiEntry[] {
  const raw = readFileSync(resolve(ROOT, 'lobehub-manifest.json'), 'utf8');
  const parsed = JSON.parse(raw) as { api?: ApiEntry[] };
  return parsed.api ?? [];
}

describe('lobehub-manifest.json api[] is in lockstep with the tool-description SoT', () => {
  const sot = publicServedDescriptions();
  const api = manifestApi();

  it('the corpus is non-empty on BOTH sides (vacuity guard, at construction)', () => {
    // Zero on either side would make every assertion below pass having compared nothing — the
    // shape this repo has been bitten by more than once. This is a defect in the fixture, not a
    // clean result, so it refuses rather than reporting a pass.
    expect(sot.size, 'resolved ZERO tools from the registry — the resolver or publicToolNames() is broken').toBeGreaterThan(0);
    expect(api.length, 'lobehub-manifest.json has ZERO api[] entries — nothing to compare').toBeGreaterThan(0);
  });

  it('no manifest entry is an orphan (every api[] name is a served tool)', () => {
    const orphans = api.map((e) => e.name).filter((n) => !n || !sot.has(n));
    expect(orphans, 'lobehub-manifest.json advertises a tool the server does not serve').toEqual([]);
  });

  it('no served tool is unmirrored (every served tool has an api[] entry)', () => {
    const present = new Set(api.map((e) => e.name));
    const missing = [...sot.keys()].filter((n) => !present.has(n));
    expect(missing, 'a served tool is missing from lobehub-manifest.json api[]').toEqual([]);
  });

  it('every api[].description matches the served description exactly', () => {
    // Report the offending NAME and BOTH lengths: "they differ" sends the reader back to a diff,
    // while "get_trade_signal manifest=439 sot=488" names the tool and the size of the lie.
    const offenders = api
      .filter((e) => e.name && sot.has(e.name))
      .filter((e) => (e.description ?? '') !== sot.get(e.name!))
      .map((e) => `${e.name}: manifest=${(e.description ?? '').length} sot=${sot.get(e.name!)!.length}`);
    expect(offenders, 'regenerate api[].description from the SoT — never hand-type it').toEqual([]);
  });

  it('/capabilities and tools/list agree: an ALIAS carries the steering suffix on both', () => {
    // The second surface. `projectCapabilities()` is what GET /capabilities serves; measured
    // 2026-08-24 it gave `get_trade_signal` the 346-char base while `tools/list` gave 488 with
    // the hint. Both now project from `servedDescription`, so this compares the projection to the
    // resolver rather than restating the composition rule a third time.
    const mismatched = projectCapabilities()
      .tools.filter((t) => servedDescription(t.name) != null)
      .filter((t) => t.description !== servedDescription(t.name))
      .map((t) => `${t.name}: capabilities=${t.description.length} sot=${servedDescription(t.name)!.length}`);
    expect(mismatched, 'GET /capabilities disagrees with the served description — an alias is losing its steering hint').toEqual([]);
  });

  it('the alias really does carry the hint (a positive assertion, not just an equality)', () => {
    // Equality alone would stay green if the suffix were emptied everywhere at once. Assert the
    // thing the release actually claims.
    const alias = servedDescription('get_trade_signal');
    expect(alias, 'get_trade_signal resolved to nothing').toBeTruthy();
    expect(alias!).toContain('Prefer get_trade_call for new integrations.');
    expect(alias!.length).toBeGreaterThan(servedDescription('get_trade_call')!.length);
  });

  it('no dark or held tool leaks into the distribution manifest', () => {
    const held = api.map((e) => e.name ?? '').filter((n) => /equity/i.test(n));
    expect(held, 'equities are dark behind EQUITY_TOOLS_ENABLED and under a public-copy HOLD').toEqual([]);
  });
});
