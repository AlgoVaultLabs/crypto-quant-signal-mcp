/**
 * TRACK-RECORD-EXCHANGE-BRAND-COLORS-W1 — drift/exhaustiveness guard for the
 * venue → brand-colour SoT that colours the `/track-record` ANALYZING chip row.
 *
 * Guards (Requirement 4):
 *   (a) every EXCHANGES id has a brand colour,
 *   (b) colour-entry count === EXCHANGES.length (no orphan / missing key),
 *   (c) every value is a 6-digit hex.
 * Plus: the exact approved palette is pinned (no silent re-tint), OKX/WhiteBIT
 * stay near-but-distinct, and both rendered surfaces in src/index.ts project
 * from this ONE map (single-derivation lock).
 *
 * NOTE: VENUE_BRAND_COLORS is typed `Record<PromotedVenueId, string>`, so
 * DELETING a key (or promoting a 16th venue into EXCHANGES without adding a
 * colour) FAILS `tsc` — the exhaustiveness gate is enforced at compile time;
 * these runtime assertions are the belt to that braces.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCHANGES, PROMOTED_VENUE_IDS } from '../../src/lib/capabilities.js';
import { VENUE_BRAND_COLORS, venueBrandColor } from '../../src/lib/venue-brand-colors.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

/** Mr.1-approved palette — the authoritative venue→hex pairing (case as written). */
const APPROVED: Record<string, string> = {
  HL: '#97FCE4',
  BINANCE: '#F0B90B',
  BYBIT: '#F7A600',
  OKX: '#FFFFFF',
  BITGET: '#26C6DA',
  ASTER: '#EFBE84',
  BINGX: '#3D7BFF',
  GATE: '#3B6EF5',
  HTX: '#0091D4',
  KUCOIN: '#23AF91',
  MEXC: '#1972E2',
  PHEMEX: '#7DE95B',
  WHITEBIT: '#F6F0FF',
  BITMART: '#00F8F8',
  XT: '#FFBE40',
};

describe('venue brand-colour SoT — exhaustiveness + drift', () => {
  it('(a) every EXCHANGES id has a brand colour', () => {
    for (const e of EXCHANGES) {
      expect(VENUE_BRAND_COLORS[e.id], `missing brand colour for ${e.id} (${e.label})`).toBeTruthy();
    }
  });

  it('(b) colour-entry count === EXCHANGES.length (no orphan / missing key)', () => {
    const keys = Object.keys(VENUE_BRAND_COLORS);
    expect(keys.length).toBe(EXCHANGES.length);
    // keys are exactly the rendered venue ids, in render order — no stray key.
    expect(keys).toEqual([...PROMOTED_VENUE_IDS]);
  });

  it('(c) every value is a 6-digit hex', () => {
    for (const [id, hex] of Object.entries(VENUE_BRAND_COLORS)) {
      expect(hex, `${id} = ${hex}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('pins the exact Mr.1-approved palette (no silent re-tint)', () => {
    expect(VENUE_BRAND_COLORS).toEqual(APPROVED);
  });

  it('OKX and WhiteBIT are intentionally near-but-distinct (not deduped)', () => {
    expect(VENUE_BRAND_COLORS.OKX).toBe('#FFFFFF');
    expect(VENUE_BRAND_COLORS.WHITEBIT).toBe('#F6F0FF');
    expect(VENUE_BRAND_COLORS.OKX).not.toBe(VENUE_BRAND_COLORS.WHITEBIT);
  });

  it('is keyed by the rendered set (PromotedVenueId), not the wider ExchangeId — no EDGEX/WEEX', () => {
    // EDGEX/WEEX are ExchangeId literals that are NOT promoted into EXCHANGES and
    // carry no approved brand colour; they must be absent from the SoT.
    expect(VENUE_BRAND_COLORS).not.toHaveProperty('EDGEX');
    expect(VENUE_BRAND_COLORS).not.toHaveProperty('WEEX');
  });

  it('venueBrandColor(id) projects the map value for every rendered venue', () => {
    for (const id of PROMOTED_VENUE_IDS) {
      expect(venueBrandColor(id)).toBe(VENUE_BRAND_COLORS[id]);
    }
  });
});

describe('track-record ANALYZING chips derive from the single SoT (single-derivation lock)', () => {
  const src = readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf8');

  it('server-rendered chip row projects via venueBrandColor(e.id)', () => {
    const line = src.split('\n').find((l) => l.includes('id="analyzing-chips"'));
    expect(line, 'analyzing-chips SSR row not found').toBeTruthy();
    expect(line).toContain('venueBrandColor(e.id)');
    // the old uniform-grey chip colour must be gone from this row.
    expect(line).not.toContain('color:#8b949e');
  });

  it('client re-render of the chip row projects via VENUE_BRAND_COLORS[ex]', () => {
    // the re-render sets analyzing-chips.innerHTML from the injected brand map,
    // NOT LB_EX_COLOR (which stays the leaderboard-bar palette).
    const idx = src.indexOf("chipsEl.innerHTML = LB_EX_ORDER.map");
    expect(idx, 'analyzing-chips client re-render not found').toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 320);
    expect(block).toContain('VENUE_BRAND_COLORS[ex]');
    expect(block).not.toContain('LB_EX_COLOR[ex]');
  });

  it('server injects the VENUE_BRAND_COLORS SoT into the client script once', () => {
    expect(src).toContain('var VENUE_BRAND_COLORS = ${JSON.stringify(VENUE_BRAND_COLORS)};');
  });
});
