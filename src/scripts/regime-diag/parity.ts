// regime-diag/parity.ts — EDGE-REGIME-DIAG-W1: the core-parity fixture (§1, guard leg v).
//
// A synthetic series, a fixed list of instants, and what the pinned core answered for each when the fixture was
// written. Before any outcome is computed the harness replays the list and compares, label for label: the rule
// that is read is the rule that was registered, on this machine too.
import { aggregate } from './archive.js';
import { quietly, served, SLOPES } from './replay.js';
import { rngFor } from './rng.js';
import { LABELS, TFS, type Span } from './diag-spec.js';
import { synthGrid } from './synth.js';

export const PARITY_FIXTURE = 'tests/fixtures/regime-diag/core-parity.json';
const KEY = 'core-parity';
const SPAN: Span = { t0Ms: Date.UTC(2021, 0, 1), n: 130 * 1440 };
const COUNT: Record<string, number> = { '1h': 40, '4h': 20, '1d': 10 };

export interface ParityCall { tf: string; m: number; label: string; confidence: number; slope: string; vol: number }

/** The fixture's calls, computed now. Half the instants sit on a bar boundary, half inside a bar. */
export function parityCalls(): ParityCall[] {
  const g = synthGrid(SPAN, KEY);
  const out: ParityCall[] = [];
  for (const tf of TFS) {
    const b = aggregate(g, tf.min);
    const rnd = rngFor(`${KEY}|${tf.key}`);
    const lo = tf.n * tf.min;
    for (let i = 0; i < COUNT[tf.key]; i++) {
      let m = lo + Math.floor(rnd() * (SPAN.n - lo));
      if (i % 2 === 0) m -= m % tf.min;
      const r = quietly(() => served(g, b, tf, m, 'SYNTH'));
      out.push({ tf: tf.key, m, label: LABELS[r.label], confidence: r.confidence, slope: SLOPES[r.slope], vol: r.vol });
    }
  }
  return out;
}

export const parityFixtureText = (): string =>
  `${JSON.stringify({ what: 'EDGE-REGIME-DIAG-W1 core-parity fixture: synthetic series, served(c, tf, t) per instant', key: KEY, t0Ms: SPAN.t0Ms, minutes: SPAN.n, calls: parityCalls() }, null, 1)}\n`;

/** Replays the fixture. Not ok — reason named — on any difference, and on a fixture that does not hold the whole list. */
export function checkCoreParity(text: string): { ok: boolean; calls: number; mismatches: number; reason: string } {
  let want: ParityCall[];
  try {
    want = (JSON.parse(text) as { calls: ParityCall[] }).calls;
  } catch {
    return { ok: false, calls: 0, mismatches: 0, reason: 'core-parity fixture is not JSON' };
  }
  const got = parityCalls();
  if (!Array.isArray(want) || want.length !== got.length) return { ok: false, calls: Array.isArray(want) ? want.length : 0, mismatches: 0, reason: `core-parity fixture holds ${Array.isArray(want) ? want.length : 0} calls, the list has ${got.length}` };
  let mismatches = 0;
  for (let i = 0; i < got.length; i++) {
    const a = got[i], b = want[i];
    if (!b || a.tf !== b.tf || a.m !== b.m || a.label !== b.label || a.confidence !== b.confidence || a.slope !== b.slope || a.vol !== b.vol) mismatches++;
  }
  return { ok: mismatches === 0, calls: got.length, mismatches, reason: mismatches === 0 ? '' : `core-parity: ${mismatches} of ${got.length} calls differ from the fixture` };
}
