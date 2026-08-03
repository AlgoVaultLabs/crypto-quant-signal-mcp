/**
 * OPS-AUDIT-REMEDIATION-LOW-W2 · Ch1 — SEC-42.
 *
 * The shape-snapshot `drift_check_command`s are the guards on the **Data Integrity** boundary:
 * they are what is supposed to catch `outcome_return_pct` / `outcome_price` reaching a public
 * shape. Two of them COULD NEVER FIRE.
 *
 * The mechanism, measured: the equity checks grepped the BARE FIELD NAMES, and
 * `dist/lib/equities/equity-tool-formatters.js:12` carries a comment reading
 * "outcome_return_pct / outcome_price can never appear because they are never …". The grep
 * matched that comment, `!` inverted it to false, and the `&&` chain short-circuited, so
 * `SHAPE_OK` never printed. The file's own comment documenting that the fields never appear is
 * what broke the check that verifies they never appear.
 *
 * A guard that always fails is as dead as one that always passes — it gets muted. So this test
 * asserts the regex **both directions**: blind to prose, and firing on a real value binding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const AUDITS = join(ROOT, 'audits');
const snap = (n: string) => JSON.parse(readFileSync(join(AUDITS, n), 'utf8'));

/** The value-binding regex CLAUDE.md prescribes, in JS form. */
const VALUE_BINDING = /"(outcome_return_pct|outcome_price)"\s*:\s*[-\d.]/;
/** What the checks used to use — matches the field name anywhere, including prose. */
const BARE_NAME = /outcome_return_pct|outcome_price/;

describe('SEC-42 — the value-binding regex, proven both directions', () => {
  // The exact comment that killed the two equity checks.
  const THE_COMMENT = ' * — outcome_return_pct / outcome_price can never appear because they are never';
  const FORBIDDEN_KEYS_ARRAY = '"forbidden_keys": ["outcome_return_pct", "outcome_price"]';
  const A_REAL_LEAK = '{"coin":"BTC","outcome_return_pct": -1.42,"verdict":"BUY"}';
  const A_REAL_LEAK_SPACED = '{"outcome_price" :  38150.5 }';

  it('is BLIND to the comment that broke the original check', () => {
    expect(BARE_NAME.test(THE_COMMENT), 'sanity: the bare-name regex DID match the comment').toBe(true);
    expect(VALUE_BINDING.test(THE_COMMENT)).toBe(false);
  });

  it('is BLIND to a forbidden-keys array, which legitimately NAMES the fields', () => {
    expect(BARE_NAME.test(FORBIDDEN_KEYS_ARRAY)).toBe(true);
    expect(VALUE_BINDING.test(FORBIDDEN_KEYS_ARRAY)).toBe(false);
  });

  it('FIRES on a real value binding — negative, spaced, and plain', () => {
    expect(VALUE_BINDING.test(A_REAL_LEAK)).toBe(true);
    expect(VALUE_BINDING.test(A_REAL_LEAK_SPACED)).toBe(true);
    expect(VALUE_BINDING.test('{"outcome_return_pct":0}')).toBe(true);
  });

  it('the shell form in the snapshots is the same regex (grep -E dialect)', () => {
    for (const n of ['get_equity_call-shape-snapshot-2026-06-04.json', 'get_equity_regime-shape-snapshot-2026-06-04.json']) {
      const cmd = snap(n).drift_check_command as string;
      expect(cmd).toContain('"(outcome_return_pct|outcome_price)"[[:space:]]*:[[:space:]]*[-0-9.]');
      expect(cmd, 'the bare-name form must be gone').not.toMatch(/grep -RnE "outcome_return_pct\|outcome_price"/);
    }
  });
});

describe('SEC-42 — the four corrected commands are structurally sound', () => {
  it('trade-call-routing no longer asserts an equality on a conditionally-exposed surface', () => {
    const cmd = snap('trade-call-routing-shape-snapshot-2026-06-09.json').drift_check_command as string;
    expect(cmd, 'the stale `must == 9` equality').not.toMatch(/==\s*9/);
    expect(cmd).toMatch(/-ge 7/);
  });

  it('verify-hash asserts the publicly-reachable contract, with no discarded fetch or undefined variable', () => {
    const cmd = snap('verify-hash-shape-snapshot-2026-05-29.json').drift_check_command as string;
    expect(cmd, 'the literal placeholder assignment').not.toContain('echo 0x...');
    expect(cmd, 'an undefined shell variable').not.toContain('$KNOWN_HASH');
    // 400 on malformed, 404 on unknown, and a real (not prose) assert on the error body
    expect(cmd).toMatch(/= 400/);
    expect(cmd).toMatch(/= 404/);
    expect(cmd).toMatch(/jq -e/);
    expect(cmd).toMatch(/outcome_\|pfe_\|mae_/);
  });

  it('verify-hash DOCUMENTS why the 200 path is unasserted rather than faking it', () => {
    // `signal_hash` reaches consumers only in webhook payloads; no public read endpoint exposes
    // one (probed 2026-08-02). A check that pretended to exercise the 200 path would be the same
    // class of dead guard this chapter exists to retire.
    const note = snap('verify-hash-shape-snapshot-2026-05-29.json').drift_check_note as string;
    expect(note).toMatch(/verified_200 path CANNOT be exercised/);
    expect(snap('verify-hash-shape-snapshot-2026-05-29.json').responses?.verified_200).toBeDefined();
  });

  it('every one of the four carries a note explaining what was wrong', () => {
    for (const n of [
      'get_equity_call-shape-snapshot-2026-06-04.json',
      'get_equity_regime-shape-snapshot-2026-06-04.json',
      'trade-call-routing-shape-snapshot-2026-06-09.json',
      'verify-hash-shape-snapshot-2026-05-29.json',
    ]) {
      expect(snap(n).drift_check_note, `${n} has no drift_check_note`).toMatch(/SEC-42/);
    }
  });
});

describe('SEC-42 — the knowledge-bundle projection contract (codified law)', () => {
  /**
   * `scripts/build-knowledge-json.mjs` projects EVERY audits/*-shape-snapshot-*.json into the
   * PUBLIC bundle's response_shapes, reading endpoint · snapshot_date · allowed_keys · object
   * cache_contract · consumers · drift_check_command — and it is TOTAL with per-field fallback,
   * so a wrong key name degrades SILENTLY (snapshot_date "unknown", allowed_keys []) with a
   * green build. Verify the FIELD NAMES the builder reads, not that the build exited 0.
   */
  const REQUIRED = ['endpoint', 'snapshot_date', 'allowed_keys', 'consumers', 'drift_check_command'];

  it('the four edited snapshots still carry every field the builder projects', () => {
    for (const n of [
      'get_equity_call-shape-snapshot-2026-06-04.json',
      'get_equity_regime-shape-snapshot-2026-06-04.json',
      'trade-call-routing-shape-snapshot-2026-06-09.json',
      'verify-hash-shape-snapshot-2026-05-29.json',
    ]) {
      const d = snap(n);
      for (const f of REQUIRED) {
        expect(d[f], `${n} lost the field \`${f}\` — the builder would silently emit a fallback`).toBeDefined();
      }
      if (d.cache_contract !== undefined) expect(typeof d.cache_contract, `${n}.cache_contract must be an OBJECT`).toBe('object');
    }
  });

  it('no endpoint has two snapshots (winkBM25 rejects a duplicate doc id)', () => {
    const byEndpoint = new Map<string, string[]>();
    for (const f of readdirSync(AUDITS).filter((x) => /-shape-snapshot-.*\.json$/.test(x))) {
      const e = snap(f).endpoint;
      if (!e) continue;
      byEndpoint.set(e, [...(byEndpoint.get(e) ?? []), f]);
    }
    const dupes = [...byEndpoint.entries()].filter(([, fs]) => fs.length > 1).map(([e, fs]) => `${e}: ${fs.join(' + ')}`);
    expect(dupes, `duplicate response_shape doc ids would fail KnowledgeIndex.build:\n${dupes.join('\n')}`).toEqual([]);
  });
});
