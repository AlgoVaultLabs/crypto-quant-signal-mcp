/**
 * GEO-REGISTRY-RANK-TDQS-W1 annotation-hint canary (2026-06-17).
 *
 * Locks the MCP tool-annotation hints carried by every PUBLIC AlgoVault tool.
 * index.ts registers each tool as `{ title, ...PUBLIC_READONLY_TOOL_ANNOTATIONS }`,
 * so the three BEHAVIORAL hints come verbatim from the shared SoT constant and
 * every tool emits the 4-field shape: title + readOnlyHint + destructiveHint +
 * openWorldHint.
 *
 *   readOnlyHint    true  — all AlgoVault tools only retrieve/compute.
 *   destructiveHint false — no irreversible side effects in any code path.
 *   openWorldHint   true  — every tool surfaces LIVE external data (exchange /
 *                           venue APIs, or the knowledge bundle).
 *
 * idempotentHint is intentionally unset — it is moot under readOnlyHint:true
 * (a read has no environment effect) and not MCP-spec-meaningful here.
 *
 * The prod tool set is locked against the live tools/list so adding a tool
 * forces a deliberate update here (and a re-confirm that it carries the SoT).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_READONLY_TOOL_ANNOTATIONS } from '../../src/tool-annotations.js';
import { allToolNames } from '../../src/lib/feature-registry.js';

const INDEX_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index.ts'),
  'utf8',
);

// Authoritative prod tool set — captured from live tools/list at
// https://api.algovault.com/mcp on 2026-06-17 (GEO-REGISTRY-RANK-TDQS-W1).
const PROD_TOOLS = [
  'get_trade_call',
  'get_trade_signal',
  'get_market_regime',
  'scan_funding_arb',
  'scan_trade_calls',
  'get_equity_call',
  'get_equity_regime',
  'chat_knowledge',
  'search_knowledge',
  // DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2. It is DECLARED here like every other tool; its
  // `publicListing: false` governs nav/docs listing only and does not touch tools/list.
  'get_track_record',
] as const;

describe('GEO-REGISTRY-RANK-TDQS-W1 — MCP annotation-hint SoT', () => {
  it('shared SoT is exactly { readOnlyHint:true, openWorldHint:true, destructiveHint:false }', () => {
    // toEqual on the whole object catches BOTH a flipped hint (e.g. destructive
    // turned true) AND an accidentally added/removed key.
    expect(PUBLIC_READONLY_TOOL_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    });
  });

  it('feature-registry prod tool set equals the locked live tools/list set', () => {
    expect([...allToolNames()].sort()).toEqual([...PROD_TOOLS].sort());
  });

  // DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2: the `it.each` below RECONSTRUCTS what index.ts is
  // supposed to emit, so on its own it cannot prove any tool actually spreads the SoT — a
  // tool registered with a hand-written annotations object would sail through it. This reads
  // the SOURCE and asserts every `register(` call site spreads the shared constant, which is
  // the property the file claims to lock.
  it('every register() call site spreads the shared annotation SoT — no hand-written object', () => {
    const sites = [...INDEX_SRC.matchAll(/\n  register\(\s*\n\s*'([a-z_]+)',/g)].map((m) => m[1]);
    expect(sites.length).toBeGreaterThanOrEqual(9); // vacuity guard: the regex really matched
    expect(sites).toContain('get_track_record');
    for (const name of sites) {
      const from = INDEX_SRC.indexOf(`  register(\n    '${name}',`);
      const body = INDEX_SRC.slice(from, from + 4000);
      const annotations = body.match(/\{\s*title:[^}]*\}/);
      expect(annotations, `no annotations object found for ${name}`).not.toBeNull();
      expect(annotations![0], `${name} does not spread the annotation SoT`)
        .toContain('...PUBLIC_READONLY_TOOL_ANNOTATIONS');
    }
  });

  // "Every prod tool carries the 4-hint shape with correct readOnly/destructive."
  // Reconstructs the annotations index.ts emits (title + the shared SoT spread);
  // the three hint VALUES are the real SoT, the title presence is the 4th field.
  it.each(PROD_TOOLS)('%s emits the 4-field shape: title + readOnly:true + destructive:false + openWorld:true', (name) => {
    const emitted = { title: name, ...PUBLIC_READONLY_TOOL_ANNOTATIONS };
    expect(emitted.readOnlyHint).toBe(true);
    expect(emitted.destructiveHint).toBe(false);
    expect(emitted.openWorldHint).toBe(true);
    expect(typeof emitted.title).toBe('string');
    expect(emitted.title.length).toBeGreaterThan(0);
    expect(Object.keys(emitted).sort()).toEqual([
      'destructiveHint',
      'openWorldHint',
      'readOnlyHint',
      'title',
    ]);
  });
});
