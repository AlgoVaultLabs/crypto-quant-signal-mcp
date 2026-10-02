/**
 * tests/fixtures/weight-budget-replay-slot.gen.ts — OPS-HL-SCAN-SLOT-RESERVE-W1 R7.
 *
 * Regenerates `weight-budget-replay-slot.golden.json` by replaying the synthetic production-scale corpus against a
 * PRE-WAVE copy of the engine (not a test; vitest never collects it). The pre-wave copy must sit in src/lib so its
 * relative imports resolve, and VITEST must be set so the rate-limit recorder stays offline:
 *
 *   git show 8deaf4da:src/lib/upstream-weight-budget.ts > src/lib/__prewave-weight-budget.tmp.ts
 *   VITEST=true npx tsx tests/fixtures/weight-budget-replay-slot.gen.ts src/lib/__prewave-weight-budget.tmp.ts 8deaf4da
 *   rm src/lib/__prewave-weight-budget.tmp.ts
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildProdCorpus, replayEvents, sha256Json, summarizeTrace, PROD_CONFIG } from './weight-budget-replay.js';

async function main(): Promise<void> {
  const [enginePath, sha] = process.argv.slice(2);
  if (!enginePath || !sha) throw new Error('usage: weight-budget-replay-slot.gen.ts <pre-wave engine copy> <its git sha>');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(path.resolve(enginePath)) as { WeightBudget: never; runAsCaller: <T>(c: string, f: () => T) => T };
  const corpus = buildProdCorpus();
  const trace = await replayEvents(mod.WeightBudget, mod.runAsCaller, { corpus });
  const golden = {
    generated_from: `${sha} src/lib/upstream-weight-budget.ts (pre-wave, byte-identical copy, sha256 ${crypto.createHash('sha256').update(fs.readFileSync(enginePath)).digest('hex').slice(0, 16)}…)`,
    config: PROD_CONFIG,
    corpus_sha256: sha256Json(corpus),
    trace_sha256: sha256Json(trace),
    summary: summarizeTrace(trace),
  };
  fs.writeFileSync(path.join(__dirname, 'weight-budget-replay-slot.golden.json'), JSON.stringify(golden, null, 1) + '\n');
  console.log(JSON.stringify(golden.summary));
}

if (require.main === module) void main().catch((e) => { console.error(e); process.exit(1); });
