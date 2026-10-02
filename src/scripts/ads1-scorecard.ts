// ads1-scorecard.ts — EDGE-ADS1-SCORECARD-W1-V2 CH3: the one-shot ADS-1 cell scorecard, computed LOCALLY.
//
// Three modes, and none touches a database from this process (ruling Q5 = A — no `performance-db` read
// path; the lifecycle wrapper imports it lazily and never opens it):
//
//   node dist/scripts/ads1-scorecard.js --print-session <counters|extract|labelfree>
//       prints the psql script for one part of the read session (src/scripts/ads1/extract-sql.ts, the
//       generator the pre-registration quotes). It is piped by the operator to
//       `ssh … docker exec -i <postgres> psql -U aoe_readonly -At -q`.
//
//   node dist/scripts/ads1-scorecard.js --print-parity-fixture
//       prints the cross-repo TS↔Python parity fixture (src/scripts/ads1/parity-fixture.ts), committed as
//       ops/ads1-parity-fixture.json and vendored by the autonomous-optimizer's dry-run objective.
//
//   node dist/scripts/ads1-scorecard.js --extract <file[.gz]> --labelfree <file> --counters-before <file>
//       --counters-after <file> --tiers <performance-public.json> --meta <pull-meta.json>
//       --manifest <lrw log>[,<lrw log>…] --header-from <wave spec .md> --out-md <audit.md> --out-json <audit.json>
//       (EDGE-ADS1-SCORECARD-W1-V3: the extract part carries `===FAMILY===`, the label-free part `===PRESENCE===`
//       — the registration §10 presence statement; `--manifest` is LRW's refusal manifest, the relabel runner's logs,
//       each file's sha256 recorded; the pull meta carries the amendment commit, the relabel launch epoch and LRW's
//       DONE-probe lines — `scripts/ads1/ads1-pull.sh` writes it.)
//       reads the session's outputs, scores every unit with the committed library, writes the PRIVATE
//       vault audit, and prints exactly one terminal line:
//         ADS1_SCORECARD_SELFCHECK: PASS (<k> checks)   exit 0
//         ADS1_SCORECARD_SELFCHECK: FAIL <checks>       exit 1
//
// NON-PROMOTABLE. The outputs are private; nothing here writes a table, a figure into the repo, or a
// public surface.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { runScript } from '../lib/script-lifecycle.js';
import { sessionScript, type SessionPart } from './ads1/extract-sql.js';
import { serializeParityFixture } from './ads1/parity-fixture.js';
import { parseManifest } from './lrw/completeness.js';
import {
  buildScorecard,
  extractHeaderClause,
  parseCensus,
  parseExtract,
  parsePresence,
  parseSideMix,
  renderMarkdown,
  selfCheck,
  tierMapOf,
  type PullMeta,
} from './ads1/scorecard.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function need(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

/** The session output's sections: the token line (first line) and `===NAME===`-delimited bodies. */
function sections(text: string): { token: string; parts: Record<string, string> } {
  const lines = text.split('\n');
  const token = (lines[0] ?? '').trim();
  const parts: Record<string, string> = {};
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (cur) parts[cur] = buf.join('\n'); };
  for (const l of lines.slice(1)) {
    const m = /^===([A-Z]+)===$/.exec(l.trim());
    if (m) { flush(); cur = m[1]; buf = []; } else buf.push(l);
  }
  flush();
  return { token, parts };
}

function counters(text: string): { token: string; ins: number; upd: number; del: number } {
  const s = sections(text);
  const m = /COUNTERS relname=directional_labels ins=(\d+) upd=(\d+) del=(\d+)/.exec(s.parts.COUNTERS ?? '');
  if (!m) throw new Error('counters: no directional_labels counter line');
  return { token: s.token, ins: Number(m[1]), upd: Number(m[2]), del: Number(m[3]) };
}

async function main(): Promise<number> {
  if (process.argv.includes('--print-parity-fixture')) {
    process.stdout.write(serializeParityFixture());
    return 0;
  }
  const part = arg('--print-session');
  if (part) {
    if (!['counters', 'extract', 'labelfree'].includes(part)) throw new Error(`--print-session ${part}: want counters|extract|labelfree`);
    process.stdout.write(sessionScript(part as SessionPart));
    return 0;
  }
  const extractPath = need('--extract');
  const raw = readFileSync(extractPath);
  const extractSha256 = createHash('sha256').update(raw).digest('hex');
  const ex = sections((extractPath.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  if (ex.parts.EXTRACT === undefined) throw new Error('extract: no ===EXTRACT=== section');
  if (ex.parts.FAMILY === undefined) throw new Error('extract: no ===FAMILY=== section');
  const extractFamily = ex.parts.FAMILY.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).join(' ');
  const lf = sections(readFileSync(need('--labelfree'), 'utf8'));
  for (const s of ['CENSUS', 'SIDEMIX', 'INTEGRITY', 'PRESENCE']) if (lf.parts[s] === undefined) throw new Error(`labelfree: no ===${s}=== section`);
  const manifestTexts = need('--manifest').split(',').map((f) => readFileSync(f));
  const manifest = parseManifest(manifestTexts.map((b) => b.toString('utf8')));
  const cb = counters(readFileSync(need('--counters-before'), 'utf8'));
  const ca = counters(readFileSync(need('--counters-after'), 'utf8'));
  const tiersRaw = readFileSync(need('--tiers'));
  const meta0 = JSON.parse(readFileSync(need('--meta'), 'utf8')) as Partial<PullMeta>;
  const integrity: Record<string, number> = {};
  for (const l of lf.parts.INTEGRITY.split('\n').slice(1)) {
    const [k, v] = l.split(',');
    if (k && v !== undefined) integrity[k] = Number(v);
  }
  const meta: PullMeta = {
    registrationPath: String(meta0.registrationPath),
    registrationCommit: String(meta0.registrationCommit),
    registrationCommitTs: Number(meta0.registrationCommitTs),
    amendmentCommit: String(meta0.amendmentCommit),
    amendmentCommitTs: Number(meta0.amendmentCommitTs),
    relabelLaunchTs: Number(meta0.relabelLaunchTs),
    extractFamily,
    doneTokens: Array.isArray(meta0.doneTokens) ? meta0.doneTokens.map(String) : [],
    manifestSha256: manifestTexts.map((b) => createHash('sha256').update(b).digest('hex')),
    pullStartTs: Number(meta0.pullStartTs),
    pullEndTs: Number(meta0.pullEndTs),
    tiersFetchedAt: String(meta0.tiersFetchedAt),
    tokenLines: [cb.token, ex.token, lf.token, ca.token],
    extractSha256,
    tiersSha256: createHash('sha256').update(tiersRaw).digest('hex'),
    countersBefore: { ins: cb.ins, upd: cb.upd, del: cb.del },
    countersAfter: { ins: ca.ins, upd: ca.upd, del: ca.del },
    integrity,
  };
  const sc = buildScorecard({
    rows: parseExtract(ex.parts.EXTRACT),
    tierMap: tierMapOf(JSON.parse(tiersRaw.toString('utf8'))),
    census: parseCensus(lf.parts.CENSUS),
    sideMix: parseSideMix(lf.parts.SIDEMIX),
    presence: parsePresence(lf.parts.PRESENCE),
    manifest,
    meta,
  });
  const check = selfCheck(sc);
  const header = extractHeaderClause(readFileSync(need('--header-from'), 'utf8'));
  writeFileSync(need('--out-md'), renderMarkdown(sc, header, check, extractPath));
  writeFileSync(need('--out-json'), JSON.stringify({ ...sc, selfCheck: check }, null, 1) + '\n');
  console.log(check.line);
  return check.pass ? 0 : 1;
}

if (require.main === module) {
  void runScript('ads1-scorecard', main);
}
