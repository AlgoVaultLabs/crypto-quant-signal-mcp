/**
 * oiscore-shadow-measure.ts — SCAN-RANKBY-REFINEMENTS-W1 CH4
 *
 * READ-ONLY harness for the oiScore re-base shadow. Reports how often the would-be
 * OI-derived verdict (oiScore from the contracts-basis OI delta) DIVERGES from the live
 * priceChange-derived verdict + the confidence spread. It does NOT flip OISCORE_SOURCE
 * and does NOT write anything.
 *
 * It deliberately does NOT yet compute PFE-WR(price) vs PFE-WR(oi): that requires matured
 * Phase-E outcomes and a join methodology that is finalized in the SEPARATE ratified wave
 * SCAN-OISCORE-FLIP-W1 (the data-maturation gate). This wave only INSTRUMENTS + reports.
 *
 * Run: docker exec <ctr> node dist/scripts/oiscore-shadow-measure.js [windowDays=30]
 */
import { summarizeOiScoreShadow } from '../lib/oiscore-shadow.js';
import { runScript } from '../lib/script-lifecycle.js';

export async function runOiScoreShadowMeasure(windowDays = 30, nowMs: number = Date.now()): Promise<void> {
  const s = await summarizeOiScoreShadow(windowDays * 24 * 60 * 60 * 1000, nowMs);
  const pct = s.total ? ` (${((s.flips / s.total) * 100).toFixed(1)}%)` : '';
  console.log('[oiscore-shadow-measure] READ-ONLY divergence report — NO flip, NO WR (yet)');
  console.log(`  window:               last ${windowDays}d (since ${new Date(s.sinceMs).toISOString()})`);
  console.log(`  shadow rows:          ${s.total}`);
  console.log(`  verdict flips:        ${s.flips}${pct}  (call_price != call_oi)`);
  console.log(`  flip transitions:     ${JSON.stringify(s.byTransition)}`);
  console.log(`  mean |conf delta|:    ${s.meanAbsConfDelta.toFixed(2)} pts`);
  console.log('  NEXT (SCAN-OISCORE-FLIP-W1): join these rows to matured Phase-E outcomes,');
  console.log('       compare PFE-WR(price) vs PFE-WR(oi); flip OISCORE_SOURCE=oi ONLY on non-regression.');
}

// require.main guard (CJS, target ES2022) — cron/CLI invokes this directly; the logic is
// exported + test-importable.
if (require.main === module) {
  const windowDays = Number(process.argv[2] ?? 30) || 30;
  void runScript('oiscore-shadow-measure', () => runOiScoreShadowMeasure(windowDays)); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
