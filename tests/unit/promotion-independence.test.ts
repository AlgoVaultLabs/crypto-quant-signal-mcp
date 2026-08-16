/**
 * OPS-PROMOTION-INSTRUMENT-INDEPENDENCE-W1 R1.4 / R1.5 — the consumer for the independence contract.
 *
 * WHY THIS FILE IS THE ENFORCEMENT POINT
 * --------------------------------------
 * Three of the seven promotion blocks have a JS gate that loads them, so `assertInstrumentIndependence`
 * runs against those at config-load time. The other four — author-identity, dark-exports,
 * gate-staleness and R1_confinement — have no JavaScript consumer that could call it. Without this
 * file the contract would cover fewer than half the class it was written for, and the author-identity
 * block, the one that motivated the whole wave, would be entirely unguarded.
 *
 * This rides the EXISTING pre-push vitest gate. No new hook block, no `pre-commit` change, no fleet
 * re-install — which matters, because installing a block into the shared $GIT_COMMON_DIR hook has
 * twice halted every parallel session on this machine.
 *
 * WHY DISCOVERY IS A SCAN AND NOT A LIST
 * --------------------------------------
 * The wave's own dispatching spec asserted there were FOUR promotion criteria in this repo and built
 * its classification table, its acceptance criteria and its verification gate on that number. Measured
 * at Plan Mode: SEVEN. The three it missed (`ops/dark-exports-config.json` -> promotion,
 * `ops/gate-staleness-config.json` -> promotion, and `ops/shared-worktree-state.json` ->
 * worktree_roots.assertions.R1_confinement.promotion) all have live consumers and all predate the spec.
 *
 * The census was READ rather than SCANNED. That is the same defect the contract exists to retire —
 * trusting a stated number instead of re-deriving it — so hardcoding the corrected list of seven here
 * would repeat it one wave later with a bigger number. The discovery below is therefore a directory
 * scan, and a new promotion block cannot be added to `ops/` without inheriting the contract.
 *
 * THE DISCOVERY RULE, stated so it cannot drift:
 *   ANY plain object, at ANY depth, under ops/*.json, whose key is `promotion` or ends in
 *   `_promotion` and does not begin with `_`.
 *
 * The depth clause is load-bearing: R1_confinement.promotion sits three levels down, and excluding it
 * for being nested would be an accident of file layout rather than a principle — it would hand every
 * future criterion an escape hatch one indent deep.
 *
 * The leading-underscore clause is this repo's universal documentation marker (`_doc`, `_scope`,
 * `_why`, `_comment`, `_reader`, `_shape_note`, ...). Without it, the prose field
 * `gate-staleness-config.json -> transitional_content_fallback._removal_is_the_same_wave_as_promotion`
 * is a false positive — it ends in `_promotion` and holds a STRING. That exemption is then closed
 * from the other side by the anti-laundering test below, so a criterion cannot escape by hiding
 * behind an underscore.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertInstrumentIndependence } from '../../scripts/lib/promotion-bound.mjs';

const OPS_DIR = resolve(__dirname, '..', '..', 'ops');

type Found = { file: string; path: string; block: Record<string, unknown> };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const isPromotionKey = (k: string) =>
  (k === 'promotion' || k.endsWith('_promotion')) && !k.startsWith('_');

/**
 * The scan. Parameterised by directory ON PURPOSE: it is the only way to prove the discovery is
 * directory-driven rather than list-driven without writing a scratch file into the real `ops/`,
 * which would race every other test file that reads `ops/` under vitest's parallel workers.
 */
function discoverPromotionBlocks(dir: string): Found[] {
  const out: Found[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      throw new Error(`ops/${file} is not parseable JSON, so it cannot be checked for promotion blocks: ${(e as Error).message}`);
    }
    const walk = (node: unknown, path: string) => {
      if (!isPlainObject(node)) return;
      for (const [k, v] of Object.entries(node)) {
        const p = path ? `${path}.${k}` : k;
        if (isPromotionKey(k) && isPlainObject(v)) out.push({ file, path: p, block: v });
        walk(v, p);
      }
    };
    walk(json, '');
  }
  return out;
}

/** A `_`-prefixed key that LOOKS like a promotion criterion and holds an object is the escape hatch. */
function discoverLaunderedDocKeys(dir: string): string[] {
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const walk = (node: unknown, path: string) => {
      if (!isPlainObject(node)) return;
      for (const [k, v] of Object.entries(node)) {
        const p = path ? `${path}.${k}` : k;
        if (k.startsWith('_') && (k === '_promotion' || k.endsWith('_promotion')) && isPlainObject(v)) {
          out.push(`${file} -> ${p}`);
        }
        walk(v, p);
      }
    };
    walk(json, '');
  }
  return out;
}

const LIVE = discoverPromotionBlocks(OPS_DIR);
const label = (f: Found) => `${f.file} -> ${f.path}`;

describe('promotion-independence — discovery', () => {
  it('finds every promotion block in ops/, at any depth', () => {
    // Not an equality assertion against a list: a floor plus a named-set check. If a wave ADDS a
    // promotion block this stays green and the contract test below is what greets it — which is the
    // entire point. What this pins is that the scan never SHRINKS below the seven known today.
    expect(LIVE.length).toBeGreaterThanOrEqual(7);

    const found = LIVE.map(label);
    for (const known of [
      'author-identity-allowlist.json -> promotion',
      'claudemd-claim-config.json -> freshness_promotion',
      'claudemd-claim-config.json -> report_class_promotion',
      'dark-exports-config.json -> promotion',
      'gate-staleness-config.json -> promotion',
      'session-drift-config.json -> mode2_promotion',
      'shared-worktree-state.json -> worktree_roots.assertions.R1_confinement.promotion',
    ]) {
      expect(found).toContain(known);
    }
  });

  it('reaches a block nested three levels deep', () => {
    const nested = LIVE.find((f) => f.path === 'worktree_roots.assertions.R1_confinement.promotion');
    expect(nested, 'the nested R1_confinement criterion must be discovered, not exempted by depth').toBeTruthy();
  });

  it('does not false-positive on prose whose key merely ends in _promotion', () => {
    // gate-staleness-config.json carries `_removal_is_the_same_wave_as_promotion`, a STRING.
    expect(LIVE.map((f) => f.path)).not.toContain(
      'transitional_content_fallback._removal_is_the_same_wave_as_promotion',
    );
  });

  it('AC1.5 — discovery is a SCAN, not a hardcoded list: a brand-new config is picked up', () => {
    // Written to a TEMP dir rather than the real ops/. A test that writes a shared repo artifact
    // mid-suite races any reader test under vitest's parallel workers; the scan is parameterised by
    // directory precisely so this proof costs no shared state.
    const dir = mkdtempSync(join(tmpdir(), 'promo-scan-'));
    try {
      writeFileSync(
        join(dir, 'a-config-that-did-not-exist.json'),
        JSON.stringify({ nested: { deeper: { some_future_promotion: { instrument: { grade: 'A' } } } } }),
      );
      const found = discoverPromotionBlocks(dir);
      expect(found.map((f) => f.path)).toEqual(['nested.deeper.some_future_promotion']);
      expect(found[0].file).toBe('a-config-that-did-not-exist.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no documentation key hides a criterion object behind a leading underscore', () => {
    // Closes the only exemption the discovery rule grants. Prose fields are strings and arrays; the
    // moment a `_`-prefixed promotion-shaped key holds an OBJECT, someone has moved a criterion out
    // of the scan's reach.
    expect(discoverLaunderedDocKeys(OPS_DIR)).toEqual([]);
  });
});

describe('promotion-independence — the contract holds on every discovered block', () => {
  it.each(LIVE.map((f) => [label(f), f] as const))('%s satisfies assertInstrumentIndependence', (_name, f) => {
    expect(() => assertInstrumentIndependence(f.block, f.path)).not.toThrow();
  });

  it('AC1.3 — zero blocks are classified C', () => {
    const c = LIVE.filter((f) => (f.block.instrument as Record<string, unknown> | undefined)?.grade === 'C');
    expect(c.map(label)).toEqual([]);
  });

  it('every block declares a grade in the taxonomy, and B/D carry their required field', () => {
    for (const f of LIVE) {
      const inst = f.block.instrument as Record<string, unknown>;
      expect(['A', 'B', 'D'], `${label(f)} grade`).toContain(inst.grade);
      if (inst.grade === 'B') expect(String(inst.rederive ?? '').trim(), `${label(f)} rederive`).not.toBe('');
      if (inst.grade === 'D') expect(String(inst.reobserve ?? '').trim(), `${label(f)} reobserve`).not.toBe('');
      if (inst.grade === 'A') {
        expect(inst.rederive, `${label(f)} must not keep rederive at grade A`).toBeUndefined();
        expect(inst.reobserve, `${label(f)} must not keep reobserve at grade A`).toBeUndefined();
      }
    }
  });
});

/**
 * R1.5 — PROVE IT CAN FAIL.
 *
 * An assertion that never fails is not an assertion. Four mutations per discovered block, every one
 * of which must throw AND must name the block it threw for — a bare "invalid instrument" in a repo
 * with seven of them costs a bisect.
 */
describe('promotion-independence — the assertion can fail (R1.5 mutation matrix)', () => {
  const MUTATIONS: Array<{ name: string; apply: (b: Record<string, any>) => Record<string, any> }> = [
    { name: 'instrument dropped', apply: (b) => { delete b.instrument; return b; } },
    { name: 'grade "C"', apply: (b) => { b.instrument.grade = 'C'; return b; } },
    { name: 'grade "B" with no rederive', apply: (b) => { b.instrument.grade = 'B'; delete b.instrument.rederive; delete b.instrument.reobserve; return b; } },
    { name: 'grade "D" with no reobserve', apply: (b) => { b.instrument.grade = 'D'; delete b.instrument.reobserve; delete b.instrument.rederive; return b; } },
  ];

  const cases = LIVE.flatMap((f) => MUTATIONS.map((m) => [`${label(f)} — ${m.name}`, f, m] as const));

  it.each(cases)('%s throws, naming its block', (_name, f, m) => {
    const mutated = m.apply(JSON.parse(JSON.stringify(f.block)));
    let threw: Error | null = null;
    try {
      assertInstrumentIndependence(mutated, f.path);
    } catch (e) {
      threw = e as Error;
    }
    expect(threw, `${label(f)} / ${m.name} must throw`).toBeTruthy();
    expect(threw!.message, 'the message must name the block').toContain(f.path);
  });

  it('the matrix is not vacuous — it covers every discovered block times every mutation', () => {
    expect(cases.length).toBe(LIVE.length * MUTATIONS.length);
    expect(cases.length).toBeGreaterThanOrEqual(28);
  });

  it('rejects a stale field left behind by a half-finished re-point', () => {
    const base = { instrument: { population: 'p', written_by: 'w', reason: 'r' } };
    const withGrade = (g: string, extra: Record<string, string>) =>
      ({ instrument: { ...base.instrument, grade: g, ...extra } });

    expect(() => assertInstrumentIndependence(withGrade('A', { rederive: 'x' }), 'blk')).toThrow(/blk/);
    expect(() => assertInstrumentIndependence(withGrade('A', { reobserve: 'x' }), 'blk')).toThrow(/blk/);
    expect(() => assertInstrumentIndependence(withGrade('B', { rederive: 'x', reobserve: 'y' }), 'blk')).toThrow(/blk/);
    expect(() => assertInstrumentIndependence(withGrade('D', { reobserve: 'x', rederive: 'y' }), 'blk')).toThrow(/blk/);
    // ...and the clean forms of each grade pass, so the above is rejecting the STALE FIELD and not
    // the grade itself.
    expect(() => assertInstrumentIndependence(withGrade('A', {}), 'blk')).not.toThrow();
    expect(() => assertInstrumentIndependence(withGrade('B', { rederive: 'x' }), 'blk')).not.toThrow();
    expect(() => assertInstrumentIndependence(withGrade('D', { reobserve: 'x' }), 'blk')).not.toThrow();
  });

  it('rejects empty strings, not merely missing keys — "" is truthy in jq and in JS `&&` chains alike', () => {
    const mk = (over: Record<string, string>) =>
      ({ instrument: { population: 'p', written_by: 'w', grade: 'A', reason: 'r', ...over } });
    for (const field of ['population', 'written_by', 'reason']) {
      expect(() => assertInstrumentIndependence(mk({ [field]: '' }), 'blk'), `empty ${field}`).toThrow(/blk/);
      expect(() => assertInstrumentIndependence(mk({ [field]: '   ' }), 'blk'), `blank ${field}`).toThrow(/blk/);
    }
  });
});
