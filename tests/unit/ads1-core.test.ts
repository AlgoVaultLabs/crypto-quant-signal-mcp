// EDGE-ADS1-SCORECARD-W1-V2 CH2 — the ADS-1 library's known answers, one it() per check, plus the
// library's purity contract (the wave's System Taxonomy: src/scripts/ads1/* may not read env, touch a
// DB, import performance-db / script-lifecycle / calibration-audit, name the quarantined withheld store,
// or carry a scorer-input token).

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { checks, runSelftest, DECLARED_CHECKS } from '../../src/scripts/ads1/selftest.js';

describe('ADS-1 known answers (the selftest corpus, one it() per check)', () => {
  for (const [name, fn] of checks()) {
    it(name, () => {
      expect(fn()).toBe(true);
    });
  }

  it('the corpus is not vacuous', () => {
    expect(checks().length).toBeGreaterThanOrEqual(DECLARED_CHECKS);
  });

  it('runSelftest prints exactly one PASS line', () => {
    const lines: string[] = [];
    expect(runSelftest((l) => lines.push(l))).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ADS1_SELFTEST: PASS \(\d+ checks\)$/);
  });
});

describe('ADS-1 library purity (System Taxonomy)', () => {
  const DIR = path.resolve(__dirname, '../../src/scripts/ads1');
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
  const code = (f: string) =>
    readFileSync(path.join(DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  it('the library exists (a purity check over nothing proves nothing)', () => {
    expect(files).toEqual(expect.arrayContaining(['spec.ts', 'core.ts', 'layers.ts', 'selftest.ts']));
  });

  it.each(files)('%s reads no env and imports no DB / lifecycle / calibration-audit module', (f) => {
    const src = code(f);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/performance-db|script-lifecycle|calibration-audit|from ['"]pg['"]/);
  });

  it.each(files)('%s names no withheld-store table and no scorer-input column', (f) => {
    const src = code(f);
    expect(src).not.toMatch(/\bhold_decisions\b|\bhold_decision_labels\b/);
    expect(src).not.toMatch(/\braw_final\b|\braw0\b|\brsi_score\b|\bema_score\b|\bfunding_score\b|\boi_score\b|\bvolume_score\b/);
  });

  it.each(files)('%s writes no max(...always...) comparator (population-comparison tripwire)', (f) => {
    expect(code(f)).not.toMatch(/(?:Math\.max|max|greatest)\s*\([^)]*\balways[_-]?(?:buy|sell|long|short)[^)]*\)/i);
  });

  it('only the DDL gate leg touches the filesystem', () => {
    const withFs = files.filter((f) => /from ['"]node:fs['"]|require\(['"]fs['"]\)/.test(code(f)));
    expect(withFs).toEqual(['ddl-parity-check.ts']);
  });
});
