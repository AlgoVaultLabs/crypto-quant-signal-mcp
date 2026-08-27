#!/usr/bin/env node
/**
 * check-shipped-set-divergence.mjs — OPS-PUBLISH-LANE-PRE-VERIFY-W1 R3.
 *
 * WHAT WOULD SHIP DIFFERENTLY IF WE PUBLISHED THIS TREE INSTEAD OF THAT TAG?
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────────
 * NPM-PUBLISH-v1.28.2-W1 had to answer exactly this question mid-release, by hand, with a bespoke
 * `npm pack --dry-run` analysis, at the last possible moment: the tag and `main` had diverged and
 * nobody could say whether the difference mattered. The answer turned out to be 24 `dist/scripts/`
 * entries — build outputs of six operator scripts, none of them on the MCP server path — so the
 * divergence was declarable and the release proceeded. That reasoning should not be re-derived
 * from scratch every release, and the distinction that made it SAFE should be COMPUTED.
 *
 * ── INVOKED BY THE RELEASE WAVE, NOT SCHEDULED — AND THAT IS THE DESIGN ─────────────────────
 * `main` legitimately runs ahead of the last tag between releases. A daily divergence alarm would
 * therefore fire on almost every day of normal operation, which is how a guard earns the
 * reputation that gets it ignored. This answers a question when a release asks it.
 *
 * ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
 *   SHIPPED_SET_DIVERGENCE_VERDICT=IDENTICAL              exit 0
 *   SHIPPED_SET_DIVERGENCE_VERDICT=DIVERGENT_NON_SERVER   exit 0   ← a declarable FACT
 *   SHIPPED_SET_DIVERGENCE_VERDICT=DIVERGENT_SERVER_PATH  exit 1   ← stop and think
 *   SHIPPED_SET_DIVERGENCE_VERDICT=INDETERMINATE          exit 3
 *
 * Divergence OUTSIDE the server path is not a failure — it is a fact a release states. Divergence
 * INSIDE it is the case a release must stop and think about, because it changes what the MCP
 * server itself does. Callers gate on the TOKEN, never the bare exit code: IDENTICAL and
 * DIVERGENT_NON_SERVER share exit 0 deliberately, so the code alone cannot tell them apart.
 *
 * INDETERMINATE is NOT part of the three-state answer and is never a divergence verdict. It exists
 * because the token law forbids dying without one: a ref that will not resolve, a tree git cannot
 * read, an unparseable package.json — input we were HANDED and could not parse — is always
 * INDETERMINATE, never a silent pass. 3 is the token-law default for a new gate.
 *
 * ── HOW THE SHIPPED SET IS DERIVED (and what it deliberately does NOT cover) ────────────────
 * `files[]` comes from package.json — NEVER a hardcoded list, and the declaration is compared
 * across both refs so a change to what ships is itself reported.
 *
 * Most entries are committed paths and diff directly. `dist` is not: it is gitignored, so there is
 * nothing to diff. It is derived instead from the tsc contract in tsconfig.json — `rootDir` →
 * `outDir`, with the emit suffixes implied by `declaration` / `declarationMap` / `sourceMap`, and
 * `exclude` honoured. That is why six changed sources render as twenty-four dist entries.
 *
 * EXCLUDED, AND PRINTED RATHER THAN ASSUMED: any `dist/**` written by a producer that is not tsc.
 * `scripts/build-knowledge-json.mjs` writes `dist/knowledge/**`, and `publish-npm.yml` does not run
 * it — so those files do not exist on a clean publish runner and are outside this model. A sweep
 * that searched nothing looks exactly like a clean one, so the exclusion is named in every report.
 *
 * Usage:
 *   node scripts/check-shipped-set-divergence.mjs                    # newest v* tag vs HEAD
 *   node scripts/check-shipped-set-divergence.mjs --from v1.28.2 --to main
 *   node scripts/check-shipped-set-divergence.mjs --self-test        # all three verdicts, offline
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'SHIPPED_SET_DIVERGENCE_VERDICT';

/** 0=IDENTICAL / 0=DIVERGENT_NON_SERVER / 1=DIVERGENT_SERVER_PATH / 3=INDETERMINATE. */
export const EXIT = {
  IDENTICAL: 0,
  DIVERGENT_NON_SERVER: 0,
  DIVERGENT_SERVER_PATH: 1,
  INDETERMINATE: 3,
};

/** Producers that write into the shipped `dist/` but are NOT tsc. Named, never silently skipped. */
export const NON_TSC_DIST_PRODUCERS = [
  {
    producer: 'scripts/build-knowledge-json.mjs',
    writes: 'dist/knowledge/**',
    why_excluded:
      'publish-npm.yml does not run `npm run build:knowledge`, so these files do not exist on a clean publish runner and cannot differ between two refs of a lane that never creates them.',
  },
];

// ── pure derivation ────────────────────────────────────────────────────────────────────────────

/** The suffixes tsc emits per source module, from the compiler options themselves. */
export function emitSuffixes(compilerOptions = {}) {
  const out = ['.js'];
  if (compilerOptions.sourceMap) out.push('.js.map');
  if (compilerOptions.declaration) out.push('.d.ts');
  if (compilerOptions.declaration && compilerOptions.declarationMap) out.push('.d.ts.map');
  return out;
}

/** Every artifact `<outDir>` gets for one `<rootDir>` source. Empty for a non-emitting path. */
export function distPathsFor(srcPath, { rootDir, outDir, suffixes }) {
  if (!srcPath.startsWith(`${rootDir}/`)) return [];
  if (!/\.(ts|tsx|mts|cts)$/.test(srcPath) || /\.d\.ts$/.test(srcPath)) return [];
  const stem = srcPath.slice(rootDir.length + 1).replace(/\.(ts|tsx|mts|cts)$/, '');
  return suffixes.map((s) => `${outDir}/${stem}${s}`);
}

/**
 * THE DISTINCTION THAT MADE v1.28.2 SAFE, COMPUTED RATHER THAN RE-REASONED.
 *
 * A source is on the MCP SERVER PATH when it is under `<rootDir>/` and NOT under
 * `<rootDir>/scripts/`. `src/scripts/**` are operator/CLI programs: they are compiled into the
 * tarball because tsc emits the whole rootDir, but nothing the MCP server serves imports them, so
 * a change there cannot alter what a caller receives. Everything else under `src/` can.
 */
export function isServerPath(srcPath, { rootDir }) {
  return srcPath.startsWith(`${rootDir}/`) && !srcPath.startsWith(`${rootDir}/scripts/`);
}

/**
 * @param {Array<{path:string, status:string, origin:string|null, server:boolean}>} entries
 */
export function classify(entries) {
  const server = entries.filter((e) => e.server);
  const nonServer = entries.filter((e) => !e.server);
  if (entries.length === 0) return { verdict: 'IDENTICAL', server, nonServer };
  return { verdict: server.length ? 'DIVERGENT_SERVER_PATH' : 'DIVERGENT_NON_SERVER', server, nonServer };
}

/** Expand one `files[]` declaration + one changed committed path into shipped entries. */
export function shippedEntriesFor(change, { filesSet, rootDir, outDir, suffixes }) {
  const { path: p, status } = change;
  // A changed source under rootDir ships as its emitted dist artifacts, when `dist` is declared.
  if (filesSet.has(outDir)) {
    const dist = distPathsFor(p, { rootDir, outDir, suffixes });
    if (dist.length) {
      const server = isServerPath(p, { rootDir });
      return dist.map((d) => ({ path: d, status, origin: p, server }));
    }
  }
  // Otherwise it ships only if it is itself a declared file.
  if (filesSet.has(p)) return [{ path: p, status, origin: null, server: false }];
  return [];
}

// ── git ────────────────────────────────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !opts.tolerant) {
    const msg = `${(r.stderr || '').trim() || `git ${args.join(' ')} failed`}`;
    const e = new Error(msg);
    e.indeterminate = true;
    throw e;
  }
  return (r.stdout ?? '').trim();
}

function readJsonAtRef(ref, file) {
  try {
    return JSON.parse(git(['show', `${ref}:${file}`]));
  } catch (e) {
    const err = new Error(`cannot read ${file} at ${ref}: ${e.message}`);
    err.indeterminate = true;
    throw err;
  }
}

function newestVersionTag() {
  const tags = git(['tag', '--list', 'v*', '--sort=-v:refname']).split('\n').filter(Boolean);
  if (!tags.length) {
    const e = new Error('no v* tag exists in this repository — pass --from explicitly');
    e.indeterminate = true;
    throw e;
  }
  return tags[0];
}

// ── report ─────────────────────────────────────────────────────────────────────────────────────

function report(from, to) {
  const fromSha = git(['rev-parse', `${from}^{commit}`]);
  const toSha = git(['rev-parse', `${to}^{commit}`]);

  const pkgTo = readJsonAtRef(to, 'package.json');
  const pkgFrom = readJsonAtRef(from, 'package.json');
  const filesTo = Array.isArray(pkgTo.files) ? pkgTo.files : [];
  const filesFrom = Array.isArray(pkgFrom.files) ? pkgFrom.files : [];
  if (filesTo.length === 0) {
    const e = new Error('package.json declares no files[] — there is no shipped set to compare');
    e.indeterminate = true;
    throw e;
  }
  const filesSet = new Set(filesTo);

  const tsconfig = JSON.parse(git(['show', `${to}:tsconfig.json`]).replace(/^\s*\/\/.*$/gm, ''));
  const co = tsconfig.compilerOptions ?? {};
  const rootDir = (co.rootDir ?? 'src').replace(/\/$/, '');
  const outDir = (co.outDir ?? 'dist').replace(/\/$/, '');
  const suffixes = emitSuffixes(co);
  const excluded = new Set(tsconfig.exclude ?? []);

  const changed = git(['diff', '--name-status', fromSha, toSha])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], path: rest[rest.length - 1] };
    })
    .filter((c) => !excluded.has(c.path));

  const entries = changed.flatMap((c) => shippedEntriesFor(c, { filesSet, rootDir, outDir, suffixes }));
  const result = classify(entries);

  const filesDeclChanged = JSON.stringify(filesFrom) !== JSON.stringify(filesTo);

  console.log('─── shipped-set divergence ───────────────────────────────────────────');
  console.log(`  from                 : ${from} (${fromSha.slice(0, 8)})`);
  console.log(`  to                   : ${to} (${toSha.slice(0, 8)})`);
  console.log(`  files[] (from pkg)   : ${filesTo.join(', ')}`);
  if (filesDeclChanged) {
    console.log(`  ⚠ files[] ITSELF CHANGED — was: ${filesFrom.join(', ')}`);
  }
  console.log(`  tsc emit contract    : ${rootDir}/ → ${outDir}/ ${suffixes.join(' ')}`);
  console.log(`  commits compared     : ${changed.length} changed path(s), ${entries.length} shipped entr(ies)`);
  for (const p of NON_TSC_DIST_PRODUCERS) {
    console.log(`  NOT covered          : ${p.writes} (${p.producer}) — ${p.why_excluded}`);
  }
  console.log('');

  const render = (label, list) => {
    console.log(`  ${label}: ${list.length}`);
    const byOrigin = new Map();
    for (const e of list) {
      const k = e.origin ?? '(declared file)';
      if (!byOrigin.has(k)) byOrigin.set(k, []);
      byOrigin.get(k).push(e);
    }
    for (const [origin, list2] of [...byOrigin.entries()].sort()) {
      console.log(`    ${origin}`);
      for (const e of list2.sort((a, b) => a.path.localeCompare(b.path))) {
        console.log(`      ${e.status} ${e.path}`);
      }
    }
  };

  render('MCP SERVER PATH (src/ outside src/scripts/) — a release must stop and think', result.server);
  render('everything else — a declarable fact, not a failure', result.nonServer);
  console.log('');
  console.log(`${TOKEN}=${result.verdict}`);
  return EXIT[result.verdict];
}

// ── self-test ──────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    let ok = false;
    let detail = '';
    try {
      ok = fn() === true;
    } catch (e) {
      detail = ` (threw: ${e && e.message})`;
    }
    if (ok) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${detail}`); }
  };

  const CFG = { rootDir: 'src', outDir: 'dist', suffixes: emitSuffixes({ declaration: true, declarationMap: true, sourceMap: true }) };
  const FILES = new Set(['dist', 'README.md', 'LICENSE', 'logo.png', 'server.json', 'smithery.yaml']);
  const expand = (changes) => changes.flatMap((c) => shippedEntriesFor(c, { filesSet: FILES, ...CFG }));

  console.log('── the tsc emit contract, derived and never hardcoded ──');
  check('all four suffixes when declaration+declarationMap+sourceMap are on', () => CFG.suffixes.length === 4);
  check('js only when every optional emit is off', () =>
    emitSuffixes({}).join() === '.js');
  check('no .d.ts.map without declaration', () =>
    emitSuffixes({ declarationMap: true }).join() === '.js');
  check('one source renders four dist artifacts', () =>
    distPathsFor('src/scripts/edge-stats.ts', CFG).join() ===
      'dist/scripts/edge-stats.js,dist/scripts/edge-stats.js.map,dist/scripts/edge-stats.d.ts,dist/scripts/edge-stats.d.ts.map');
  check('a non-TS file under rootDir emits nothing', () => distPathsFor('src/data/x.json', CFG).length === 0);
  check('a .d.ts input is not itself a source', () => distPathsFor('src/types/pkg.d.ts', CFG).length === 0);
  check('a path outside rootDir emits nothing', () => distPathsFor('scripts/x.ts', CFG).length === 0);

  console.log('── the server-path distinction ──');
  check('src/tools/get-trade-call.ts IS the server path', () => isServerPath('src/tools/get-trade-call.ts', CFG) === true);
  check('src/scripts/edge-stats.ts is NOT', () => isServerPath('src/scripts/edge-stats.ts', CFG) === false);
  check('README.md is NOT (it is not under rootDir at all)', () => isServerPath('README.md', CFG) === false);

  console.log('── all three verdicts, on synthetic inputs ──');
  check('no changed shipped path is IDENTICAL', () => classify(expand([])).verdict === 'IDENTICAL');
  check('a changed path that does not ship is still IDENTICAL', () =>
    classify(expand([{ status: 'M', path: 'tests/unit/x.test.ts' }, { status: 'M', path: 'audits/y.md' }])).verdict === 'IDENTICAL');

  // The real v1.28.2 shape: six operator scripts, twenty-four dist entries, no server path.
  const v1282 = expand([
    'calibration-audit', 'directional-labeler', 'dwr-baseline-report',
    'dwr-baseline-snapshot', 'dwr-baseline', 'edge-stats',
  ].map((n) => ({ status: 'M', path: `src/scripts/${n}.ts` })));
  check('six src/scripts sources expand to 24 dist entries', () => v1282.length === 24);
  check('…all of them under dist/scripts/', () => v1282.every((e) => e.path.startsWith('dist/scripts/')));
  check('…and the verdict is DIVERGENT_NON_SERVER', () => classify(v1282).verdict === 'DIVERGENT_NON_SERVER');
  check('a README-only change also ships, as a declared file', () => {
    const e = expand([{ status: 'M', path: 'README.md' }]);
    return e.length === 1 && e[0].path === 'README.md' && classify(e).verdict === 'DIVERGENT_NON_SERVER';
  });
  check('one src/ file outside src/scripts flips it to DIVERGENT_SERVER_PATH', () =>
    classify(expand([{ status: 'M', path: 'src/tools/get-trade-call.ts' }])).verdict === 'DIVERGENT_SERVER_PATH');
  check('a server path MIXED with non-server still flips it — the strictest wins', () =>
    classify(expand([
      { status: 'M', path: 'src/scripts/edge-stats.ts' },
      { status: 'M', path: 'src/lib/x402.ts' },
    ])).verdict === 'DIVERGENT_SERVER_PATH');

  console.log('── the exit-code MAPPING, not just the tokens ──');
  // Asserting tokens alone once left a gate fully green after its INDETERMINATE mapping was
  // re-coded to 0. The mapping is part of the contract.
  check('IDENTICAL and DIVERGENT_NON_SERVER SHARE exit 0 — the code cannot tell them apart', () =>
    EXIT.IDENTICAL === 0 && EXIT.DIVERGENT_NON_SERVER === 0);
  check('DIVERGENT_SERVER_PATH exits 1', () => EXIT.DIVERGENT_SERVER_PATH === 1);
  check('INDETERMINATE exits 3, the token-law default for a new gate', () => EXIT.INDETERMINATE === 3);

  console.log('── vacuity: WE build this corpus, so an empty one is a defect here ──');
  check('an empty files[] set ships nothing at all — which must NOT read as IDENTICAL by luck', () => {
    const e = [{ status: 'M', path: 'src/lib/x402.ts' }].flatMap((c) =>
      shippedEntriesFor(c, { filesSet: new Set(), ...CFG }));
    // With no declaration there is nothing to compare; the runtime path REFUSES before reaching
    // here (see report()), and this asserts the expansion really is empty rather than defaulting.
    return e.length === 0;
  });

  console.log('');
  console.log(`  self-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(`${TOKEN}=INDETERMINATE`); return EXIT.INDETERMINATE; }
  if (passed === 0) { console.log(`${TOKEN}=INDETERMINATE`); return EXIT.INDETERMINATE; }
  console.log(`${TOKEN}=IDENTICAL`);
  return EXIT.IDENTICAL;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  let code;
  try {
    if (args.includes('--self-test')) {
      code = selfTest();
    } else {
      code = report(arg('--from', null) ?? newestVersionTag(), arg('--to', 'HEAD'));
    }
  } catch (e) {
    // Never die without a token. Input we were handed and could not parse is INDETERMINATE.
    console.log(`  cannot compare: ${e && e.message}`);
    console.log(`${TOKEN}=INDETERMINATE`);
    code = EXIT.INDETERMINATE;
  }
  process.exit(code);
}

if (!existsSync(path.join(REPO, 'package.json'))) {
  throw new Error(`check-shipped-set-divergence: no package.json at ${REPO}`);
}
