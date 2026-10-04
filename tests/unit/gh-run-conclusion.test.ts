/**
 * OPS-XREPO-CI-RED-W1 CH2 — the ONE derivation of a GitHub workflow's latest-run conclusion.
 *
 * On 2026-10-03T09:41Z the xrepo canary paged `xrepo_ci_red` naming run #144, which had SUCCEEDED:
 * the badge said `failing`, and nothing asserted that the run the alert named was the run whose
 * conclusion it read. ops/monitoring/gh-run-conclusion.mjs binds the two. This file pins:
 *   · the bound-conclusion table, every row × class (AC1), on the module's own fixture builders;
 *   · the incidents replayed on REAL captured markup (AC2–AC8, AC10), incl. the full live page with
 *     its pre-row chrome traps and the two WRONG badge bodies GitHub served during the episodes;
 *   · Recover through the canary-compatible FIXTURE seam (AC9) — the read sequence `.svg.2`, `.html.2`;
 *   · byte parity of the legacy sub-modes and of the fixture mangling with the canary's own bash;
 *   · the twin with deploy-drift's parseBadgeTitle — RETIRED by CH4 (parseBadgeTitle removed; one parser left);
 *   · the CONSUMER REGISTRY: every executable that reads the badge or the run page — or imports /
 *     execs the module — is the module or a REGISTERED consumer, and the module is the ONLY classifier
 *     (CH3 removed the canary from PENDING; CH4 emptied it — architect rulings Q7/Q8, 2026-10-04).
 *   · any ref is SAME-REF (ruling Q9): resolved from the newest finished run's own row, on REAL markup.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BIND_TABLE, CLASSES, EXIT, ICON_VOCAB, TOKEN, RECOVER_DEFAULTS, EPISODE_ENVELOPE, CACHE_BUSTER,
  readConclusion, verdictFor, parsePage, parseBadge, classifyIcon, mangle, badgeUrl, actionsUrl,
  memoryFetch, fixturePage, fixtureBadge, fixtureRow, spanCoversEnvelope, refOfRun, renderLines,
} from '../../ops/monitoring/gh-run-conclusion.mjs';
import ts from 'typescript';

const ROOT = resolve(__dirname, '..', '..');
const MODULE_REL = 'ops/monitoring/gh-run-conclusion.mjs';
const MODULE = join(ROOT, MODULE_REL);
const CANARY = join(ROOT, 'ops', 'cron', 'xrepo-ci-conclusion-canary.sh');
const FX = join(ROOT, 'tests', 'fixtures', 'gh-run-conclusion');
const fx = (f: string) => readFileSync(join(FX, f), 'utf8');

const MC = { repo: 'AlgoVaultLabs/algovault-skills', workflow: 'marketplace-check.yml', branch: 'main' };
const PV = { repo: 'AlgoVaultLabs/crypto-quant-signal-mcp', workflow: 'publish-lane-preverify.yml', branch: 'main' };
const noSleep = () => {};
const read = (input: object, seq: Record<string, object[]>, extra: object = {}) =>
  readConclusion({ cls: 'alerting', ...input, ...extra }, { fetchDoc: memoryFetch(seq), sleep: noSleep, reads: 3, spacingS: 60 });
/** A page made from REAL captured rows, wrapped in the measured pre-row chrome. */
const realPage = (...rows: string[]) => fixturePage(rows);
const titleBadge = (name: string, status: string) => ({ body: `<svg><title>${name} - ${status}</title></svg>` });

describe('gh-run-conclusion — self-test', () => {
  it('passes, offline, with exactly one terminal token and exit 0', { timeout: 60_000 }, () => {
    const r = spawnSync('node', [MODULE, '--self-test'], { encoding: 'utf8' });
    const tokens = r.stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
    expect(tokens).toEqual([`${TOKEN}=PASS`]);
    expect(r.stdout.trimEnd().split('\n').pop()).toBe(`${TOKEN}=PASS`);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/self-test: (\d+) passed, 0 failed/);
    expect(Number(/self-test: (\d+) passed/.exec(r.stdout)![1])).toBeGreaterThanOrEqual(60);
  });

  it('the derived-span law refuses a 30 s spacing (M6b direction): (3 − 1) × 30 ≤ 97', { timeout: 60_000 }, () => {
    const r = spawnSync('node', [MODULE, '--self-test'], { encoding: 'utf8', env: { ...process.env, GHRC_SPACING_S: '30' } });
    expect(r.stdout.trimEnd().split('\n').pop()).toBe(`${TOKEN}=FAIL`);
    expect(r.status).toBe(EXIT.FAIL);
    expect(spanCoversEnvelope(RECOVER_DEFAULTS)).toBe(true);
    expect((RECOVER_DEFAULTS.reads - 1) * RECOVER_DEFAULTS.spacingS).toBeGreaterThan(EPISODE_ENVELOPE.seconds);
  });
});

describe('AC1 — the bound-conclusion table, every row × every class', () => {
  const B = badgeUrl(MC);
  const P = actionsUrl(MC);
  const page = (...r: string[]) => ({ body: realPage(...r) });
  const ok = fx('row-success-37017230705.html');
  const bad = fx('row-failure-35616111211.html');
  const cases: Array<[string, Record<string, object[]>, number | string]> = [
    ['row 1', { [B]: [titleBadge('Marketplace Health Check', 'passing')], [P]: [page(ok)] }, 1],
    ['row 2', { [B]: [titleBadge('Marketplace Health Check', 'failing')], [P]: [page(bad)] }, 2],
    ['row 3', { [B]: [titleBadge('Marketplace Health Check', 'failing')], [P]: [page(ok)] }, 3],
    ['row 4', { [B]: [titleBadge('Marketplace Health Check', 'passing')], [P]: [page(bad)] }, 4],
    ['row 5', { [B]: [titleBadge('Marketplace Health Check', 'failing')], [P]: [{ http: 502 }] }, 5],
    ['row 6', { [B]: [titleBadge('Marketplace Health Check', 'passing')], [P]: [{ http: 502 }] }, 6],
    ['row 7', { [B]: [titleBadge('Deploy to Hetzner', 'passing')], [P]: [page(ok)] }, 7],
    ['row 8', { [B]: [titleBadge('Marketplace Health Check', 'no status')], [P]: [page(ok)] }, 8],
  ];
  for (const [label, seq, row] of cases) {
    it(`${label}: agreement + all three class verdicts come straight from BIND_TABLE`, () => {
      const rec = read(MC, seq);
      const spec = BIND_TABLE.find((r: { row: number | string }) => r.row === row)!;
      expect(rec.row).toBe(row);
      expect(rec.agreement).toBe(spec.agreement);
      for (const c of CLASSES) expect(verdictFor(rec, c)).toBe(spec[c]);
      expect('bound_run' in rec).toBe(spec.bound);
    });
  }
  it('the table matches the architect rulings cell for cell (row 4 attribution = failing; row 3 = unknown)', () => {
    const cell = (row: number, c: string) => BIND_TABLE.find((r: { row: number }) => r.row === row)[c];
    expect([1, 2, 3, 4, 5, 6, 7, 8, 'R'].map((r) => `${cell(r as number, 'alerting')}/${cell(r as number, 'blocking')}/${cell(r as number, 'attribution')}`)).toEqual([
      'PASS/PASS/passing', 'FAIL/FAIL/failing', 'INDETERMINATE/INDETERMINATE/unknown', 'FAIL/FAIL/failing',
      'FAIL/INDETERMINATE/unknown', 'PASS/INDETERMINATE/unknown', 'INDETERMINATE/INDETERMINATE/unknown', 'INDETERMINATE/INDETERMINATE/unknown',
      'INDETERMINATE/INDETERMINATE/unknown',
    ]);
    expect(BIND_TABLE.length).toBe(9);
    // blocking FAILs only where the run's own record supports it; every PASS needs the badge.
    expect(BIND_TABLE.filter((r: { blocking: string }) => r.blocking === 'FAIL').map((r: { row: number }) => r.row)).toEqual([2, 4]);
    expect(BIND_TABLE.filter((r: { alerting: string; blocking: string; attribution: string }) => r.alerting === 'PASS' || r.blocking === 'PASS' || r.attribution === 'passing')
      .every((r: { badge: string }) => r.badge === 'passing')).toBe(true);
  });
});

describe('the incidents, replayed on REAL captured markup', () => {
  const B = badgeUrl(MC);
  const P = actionsUrl(MC);
  const FULL = fx('page-marketplace-check-main-20261003.html');

  it('AC2 — 2026-10-03T09:41Z: badge failing + the real page (#144 success) → INDETERMINATE, no bound run, after GHRC_READS reads', () => {
    const rec = read(MC, { [B]: [titleBadge('Marketplace Health Check', 'failing')], [P]: [{ body: FULL }] });
    expect(rec.row).toBe(3);
    expect(rec.agreement).toBe('DISAGREE');
    expect(verdictFor(rec, 'alerting')).toBe('INDETERMINATE');
    expect(verdictFor(rec, 'blocking')).toBe('INDETERMINATE');
    expect(verdictFor(rec, 'attribution')).toBe('unknown');
    expect('bound_run' in rec).toBe(false);
    expect(rec.reads).toBe(RECOVER_DEFAULTS.reads);
    expect(rec.page.newest_terminal).toMatchObject({ run_id: '37017230705', run_number: 144, state: 'success', name: 'Marketplace Health Check' });
  });

  it('AC2b — the WRONG badge body GitHub actually served (episodes #1 and #2) against the real pre-verify page → row 3, never a RED', () => {
    const PB = badgeUrl(PV);
    const PP = actionsUrl(PV);
    const page = fx('page-publish-lane-preverify-main-20261003.html');
    for (const wrong of ['badge-WRONG-failing-publish-lane-preverify-episode1-20261003T110129Z.svg', 'badge-WRONG-failing-publish-lane-preverify-episode2-20261003T120215Z.svg']) {
      const rec = read(PV, { [PB]: [{ body: fx(wrong) }], [PP]: [{ body: page }] });
      expect(rec.row).toBe(3);
      expect(verdictFor(rec, 'alerting')).toBe('INDETERMINATE');
    }
    // and the same page against the CORRECT body binds the success run
    const good = read(PV, { [PB]: [{ body: fx('badge-passing-publish-lane-preverify-main.svg') }], [PP]: [{ body: page }] });
    expect(good.row).toBe(1);
    expect(good.bound_run.run_id).toBe('37116129802');
  });

  it('AC3 — 2026-09-21: badge failing + newest terminal #131 failure → FAIL in alerting and blocking, bound to 35616111211', () => {
    const rec = read(MC, { [B]: [titleBadge('Marketplace Health Check', 'failing')], [P]: [{ body: realPage(fx('row-failure-35616111211.html')) }] });
    expect(rec.row).toBe(2);
    expect(verdictFor(rec, 'alerting')).toBe('FAIL');
    expect(verdictFor(rec, 'blocking')).toBe('FAIL');
    expect(rec.bound_run).toMatchObject({ run_id: '35616111211', run_number: 131, state: 'failure' });
  });

  it('AC4 — the dangerous direction: badge passing + newest terminal failure → alerting FAIL, blocking FAIL, attribution failing (ruling)', () => {
    const rec = read(MC, { [B]: [titleBadge('Marketplace Health Check', 'passing')], [P]: [{ body: realPage(fx('row-failure-35616111211.html')) }] });
    expect(rec.row).toBe(4);
    expect(verdictFor(rec, 'alerting')).toBe('FAIL');
    expect(verdictFor(rec, 'blocking')).toBe('FAIL');
    expect(verdictFor(rec, 'attribution')).toBe('failing');
    expect(rec.bound_run.run_id).toBe('35616111211');
  });

  it('AC5 — prose never decides: a "completed successfully" aria over a failure icon reads failure; a prose-only row is UNMEASURED', () => {
    const lying = fx('row-failure-35616111211.html').replace(/aria-label="failed:  Run 131/, 'aria-label="completed successfully:  Run 131');
    expect(lying).toContain('completed successfully:  Run 131');
    expect(parsePage(realPage(lying))[0].state).toBe('failure');
    const proseOnly = fx('row-success-37017230705.html').replace(/<svg\b[^>]*class="octicon octicon-check-circle-fill color-fg-success"[^>]*>/, '');
    expect(proseOnly).toContain('completed successfully');
    const rec = read(MC, { [B]: [titleBadge('Marketplace Health Check', 'failing')], [P]: [{ body: realPage(proseOnly) }] });
    expect(rec.agreement).toBe('UNCORROBORATED');
    expect(rec.page.guard).toBe('icon_unmeasured');
  });

  it('AC6 — the chrome trap: the FULL real page reads #144 as success despite every pre-row icon R0 measured', () => {
    const preRow = FULL.slice(0, FULL.indexOf('id="check_suite_'));
    const count = (re: RegExp) => (preRow.match(re) || []).length;
    expect(count(/<svg[^>]*class="[^"]*octicon-alert color-fg-danger[^"]*"/g)).toBe(4);
    expect(count(/<svg[^>]*class="[^"]*\bocticon-alert\b(?!-)[^"]*"/g)).toBe(5);
    expect(count(/<svg[^>]*class="[^"]*\bocticon-stop\b[^"]*"/g)).toBe(4);
    expect(count(/<svg[^>]*class="[^"]*\bocticon-check-circle-fill\b[^"]*"/g)).toBe(4);
    expect(count(/<svg[^>]*class="[^"]*\bocticon-alert-fill\b[^"]*"/g)).toBe(4);
    expect(count(/<svg[^>]*class="[^"]*\banim-rotate\b[^"]*"/g)).toBe(10);
    const rows = parsePage(FULL);
    expect(rows.length).toBe(25);
    expect(rows[0]).toMatchObject({ run_id: '37017230705', run_number: 144, state: 'success', name: 'Marketplace Health Check' });
    // icon = API conclusion on every row of the real page (R0.4: 78/78 estate rows)
    expect(rows.every((r: { state: string }) => r.state === 'success' || r.state === 'failure')).toBe(true);
  });

  it('AC6 — an in-progress row whose first octicon is the octicon-calendar decoy reads in_progress', () => {
    const ip = fx('row-in_progress-37118831402.html');
    expect(ip).toMatch(/class="octicon octicon-calendar"/);
    expect(ip).toMatch(/class="anim-rotate"/);
    expect(parsePage(realPage(ip))[0]).toMatchObject({ run_id: '37118831402', state: 'in_progress' });
  });

  it('AC7 — identity: a badge name that differs from the row name → DISAGREE (row 7)', () => {
    const rec = read(MC, { [B]: [{ body: fx('badge-passing-publish-lane-preverify-main.svg') }], [P]: [{ body: FULL }] });
    expect(rec.row).toBe(7);
    expect(rec.agreement).toBe('DISAGREE');
    expect(rec.reason).toBe('identity_mismatch');
  });

  it('AC8 — the terminal walk: a measured non-terminal newest row is skipped; an unmeasured icon STOPS the walk', () => {
    const ip = fx('row-in_progress-37118831402.html').replace(/postgres-lane|Postgres test lane/g, (m) => (m === 'Postgres test lane' ? 'Marketplace Health Check' : m));
    const skipped = read(MC, { [B]: [titleBadge('Marketplace Health Check', 'passing')], [P]: [{ body: realPage(ip, fx('row-success-37017230705.html')) }] });
    expect(skipped.row).toBe(1);
    expect(skipped.page.newest.state).toBe('in_progress');
    expect(skipped.bound_run.run_id).toBe('37017230705');
    const unknownIcon = fx('row-success-37017230705.html').replace('octicon-check-circle-fill color-fg-success', 'octicon-hourglass color-fg-muted');
    const stopped = read(MC, { [B]: [titleBadge('Marketplace Health Check', 'passing')], [P]: [{ body: realPage(unknownIcon, fx('row-failure-35616111211.html')) }] });
    expect(stopped.agreement).toBe('UNCORROBORATED');
    expect(stopped.page.guard).toBe('icon_unmeasured');
  });

  it('AC8 — the measured third-party states: queued/waiting skip, skipped/action_required STOP with a named reason', () => {
    const base = fx('row-success-37017230705.html');
    for (const st of ['queued', 'waiting']) {
      const rec = read(MC, { [B]: [titleBadge('Marketplace Health Check', 'passing')], [P]: [{ body: realPage(fx(`row-${st}-synth.html`).replace(/37017230705/g, '37123657999'), base) }] });
      expect(rec.row).toBe(1);
    }
    for (const st of ['skipped', 'action_required']) {
      const rec = read(MC, { [B]: [titleBadge('Marketplace Health Check', 'failing')], [P]: [{ body: realPage(fx(`row-${st}-synth.html`)) }] });
      expect(rec.page.guard).toBe(`terminal_unbound:${st}`);
      expect(rec.row).toBe(5);
    }
    expect(parsePage(realPage(fx('row-startup_failure-synth.html')))[0].state).toBe('failure');
  });

  it('AC10 — guards: each UNCORROBORATED with a named reason; an unreadable badge is UNREADABLE', () => {
    const okBadge = { [B]: [titleBadge('Marketplace Health Check', 'passing')] };
    expect(read(MC, { ...okBadge, [P]: [{ body: '<html><body><div class="blankslate">There are no workflow runs yet.</div></body></html>' }] }).page.guard).toBe('vacuity');
    expect(read(MC, { ...okBadge, [P]: [{ body: FULL, contentType: 'image/svg+xml' }] }).page.guard).toBe('content_type');
    expect(read(MC, { ...okBadge, [P]: [{ body: FULL }] }, { minRunId: '37117281597' }).page.guard).toBe('monotonic');
    const atom = read({ ...MC, workflow: 'marketplace-check.yml.atom' }, { ...okBadge, [P]: [{ body: FULL }] });
    expect([atom.row, atom.agreement, atom.reason, atom.reads]).toEqual(['R', 'UNCORROBORATED', 'atom_trap', 0]);
    expect(CLASSES.map((c: string) => verdictFor(atom, c))).toEqual(['INDETERMINATE', 'INDETERMINATE', 'unknown']);
    expect(read(MC, { [B]: [{ body: fx('badge-nostatus-marketplace-check.svg') }], [P]: [{ body: FULL }] }).agreement).toBe('UNREADABLE');
    expect(read(MC, { [B]: [{ http: 500 }], [P]: [{ body: FULL }] }).agreement).toBe('UNREADABLE');
    expect(read(MC, { [B]: [{ body: '<svg>no title</svg>' }], [P]: [{ body: FULL }] }).agreement).toBe('UNREADABLE');
  });
});

describe('AC9 — Recover, through the canary-compatible FIXTURE seam (no test sleeps)', () => {
  const B = badgeUrl(MC);
  const P = actionsUrl(MC);
  const cli = (dir: string, extraEnv: Record<string, string> = {}) => spawnSync('node', [MODULE, '--repo', MC.repo, '--workflow', MC.workflow, '--branch', 'main', '--class', 'alerting'],
    { encoding: 'utf8', env: { ...process.env, XREPO_CI_FIXTURE_DIR: dir, GHRC_SPACING_S: '0', ...extraEnv } });
  const field = (out: string, k: string) => (out.split('\n').find((l) => l.startsWith(`GHRC_${k}=`)) ?? '').slice(`GHRC_${k}=`.length);
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'ghrc-fx-'));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const put = (dir: string, url: string, ext: string, body: string, n?: number) => writeFileSync(join(dir, `${mangle(url)}.${ext}${n ? `.${n}` : ''}`), body);

  it('DISAGREE then AGREE converges at read 2, both samples recorded', { timeout: 30_000 }, () => withDir((dir) => {
    put(dir, B, 'svg', '<svg><title>Marketplace Health Check - failing</title></svg>');
    put(dir, B, 'svg', fx('badge-passing-marketplace-check-main.svg'), 2);
    put(dir, P, 'html', fx('page-marketplace-check-main-20261003.html'));
    const r = cli(dir);
    expect(field(r.stdout, 'ROW')).toBe('1');
    expect(field(r.stdout, 'READS')).toBe('2');
    const rec = JSON.parse(field(r.stdout, 'RECORD'));
    expect(rec.samples.map((s: { row: number }) => s.row)).toEqual([3, 1]);
    expect(r.stdout.trimEnd().split('\n').pop()).toBe(`${TOKEN}=PASS`);
    expect(r.status).toBe(EXIT.PASS);
  }));

  it('a row-5 sequence (badge failing, page outage, then the page back with success) re-reads and ends in row 3 — NOT a FAIL', { timeout: 30_000 }, () => withDir((dir) => {
    put(dir, B, 'svg', '<svg><title>Marketplace Health Check - failing</title></svg>');
    put(dir, P, 'html', '');
    put(dir, P, 'code', '502');
    put(dir, P, 'html', fx('page-marketplace-check-main-20261003.html'), 2);
    put(dir, P, 'code', '200', 2);
    const r = cli(dir);
    const rec = JSON.parse(field(r.stdout, 'RECORD'));
    expect(rec.samples[0].row).toBe(5);
    expect(rec.row).toBe(3);
    expect(r.stdout.trimEnd().split('\n').pop()).toBe(`${TOKEN}=INDETERMINATE`);
    expect(r.status).toBe(EXIT.INDETERMINATE);
  }));

  it('a persistent non-AGREE stops at GHRC_READS (3), every sample recorded', { timeout: 30_000 }, () => withDir((dir) => {
    put(dir, B, 'svg', '<svg><title>Marketplace Health Check - failing</title></svg>');
    put(dir, P, 'html', fx('page-marketplace-check-main-20261003.html'));
    const rec = JSON.parse(field(cli(dir).stdout, 'RECORD'));
    expect(rec.reads).toBe(3);
    expect(rec.samples.length).toBe(3);
  }));

  it('the injected sleep receives (reads − 1) × spacing, so a live read waits; tests never sleep', () => {
    const slept: number[] = [];
    readConclusion({ ...MC, cls: 'alerting' }, { fetchDoc: memoryFetch({ [B]: [titleBadge('Marketplace Health Check', 'failing')], [P]: [{ body: realPage(fx('row-success-37017230705.html')) }] }), sleep: (s: number) => slept.push(s) });
    expect(slept).toEqual([RECOVER_DEFAULTS.spacingS, RECOVER_DEFAULTS.spacingS]);
  });

  it('the cache-buster ships ON (ruling Q6), with both adoption proofs recorded beside it', () => {
    expect(CACHE_BUSTER.enabled).toBe(true);
    expect(CACHE_BUSTER.param).toBe('ghrc_cb');
    expect(CACHE_BUSTER.provenance).toMatch(/plain 2\/30 wrong, busted 0\/30/);
    expect(CACHE_BUSTER.provenance).toMatch(/plain 3\/12 wrong.*busted 1\/12/);
  });

  it('every live request carries a ghrc_cb unique per read, while the fixture seam keys on the canonical URL', () => {
    const seen: Array<{ u: string; f: string }> = [];
    const inner = memoryFetch({ [B]: [titleBadge('Marketplace Health Check', 'failing')], [P]: [{ body: realPage(fx('row-success-37017230705.html')) }] });
    const rec = readConclusion({ ...MC, cls: 'alerting' }, {
      fetchDoc: (u: string, e: string, n: number, f: string) => { seen.push({ u, f }); return inner(u, e, n, f); },
      sleep: noSleep, reads: 3, spacingS: 60, nowEpoch: () => 1791100000,
    });
    expect(rec.row).toBe(3);
    const cbs = (url: string) => seen.filter((x) => x.u === url).map((x) => new URL(x.f).searchParams.get('ghrc_cb'));
    expect(cbs(B)).toEqual(['1791100000-1', '1791100000-2', '1791100000-3']);
    expect(cbs(P)).toEqual(['1791100000-1', '1791100000-2', '1791100000-3']);
    expect(rec.samples.map((x: { badge: { cb: string } }) => x.badge.cb)).toEqual(['1791100000-1', '1791100000-2', '1791100000-3']);
  });
});

describe('adversarial-review findings (CH2), replayed on real markup — each was a way to launder or misattribute', () => {
  const B = badgeUrl(MC);
  const P = actionsUrl(MC);
  const FAILED = fx('row-failure-35616111211.html');
  const OK = fx('row-success-37017230705.html');
  const passing = titleBadge('Marketplace Health Check', 'passing');
  const failing = titleBadge('Marketplace Health Check', 'failing');

  it('the run number is the STRUCTURED #N:; rewording the aria prose changes nothing', () => {
    const reworded = FAILED.replace('Run 131 of', 'Run #131 of');
    const contradicting = FAILED.replace('Run 131 of', 'Run 130 of');
    for (const body of [FAILED, reworded, contradicting]) {
      const rec = read(MC, { [B]: [passing], [P]: [{ body: realPage(body) }] });
      expect(rec.row).toBe(4);
      expect(rec.bound_run.run_number).toBe(131);
    }
    const noNumber = read(MC, { [B]: [passing], [P]: [{ body: realPage(FAILED.replace(/(<span class="text-bold" >Marketplace Health Check<\/span>)\s*#131:/, '$1')) }] });
    expect(noNumber.page.guard).toBe('row_identity_unreadable');
  });

  it('identity is checked when the walk STOPS too: a wrong-workflow failing badge is row 7, not a badge-only RED', () => {
    const unknownIcon = OK.replace('octicon-check-circle-fill color-fg-success', 'octicon-hourglass color-fg-muted');
    const rec = read(MC, { [B]: [titleBadge('Deploy to Hetzner', 'failing')], [P]: [{ body: realPage(unknownIcon) }] });
    expect(rec.row).toBe(7);
    expect(verdictFor(rec, 'alerting')).toBe('INDETERMINATE');
  });

  it('the monotonic floor rises inside the window: a stale page on an older run cannot AGREE past a confirmed failure', () => {
    const newerFailed = FAILED.replace(/35616111211/g, '37123657814').replace(/#131:/, '#145:');
    const rec = read(MC, { [B]: [passing], [P]: [{ body: realPage(newerFailed) }, { body: realPage(OK) }] });
    expect(rec.samples.map((s: { row: number }) => s.row)).toEqual([4, 6, 6]);
    expect(rec.samples[1].page.guard).toBe('monotonic');
    expect(rec.row).toBe(4);
    expect(verdictFor(rec, 'alerting')).toBe('FAIL');
  });

  it('a bound row 4 outranks later unbound row-7 reads of the same run', () => {
    const rec = read(MC, { [B]: [passing, titleBadge('Deploy to Hetzner', 'passing')], [P]: [{ body: realPage(FAILED) }] });
    expect(rec.samples.map((s: { row: number }) => s.row)).toEqual([4, 7, 7]);
    expect(rec.row).toBe(4);
  });

  it('page down all window: one glitched badge read never decides (majority of the readable badge states)', () => {
    expect(read(MC, { [B]: [passing, passing, failing], [P]: [{ http: 503 }] }).row).toBe(6);
    expect(read(MC, { [B]: [failing, failing, passing], [P]: [{ http: 503 }] }).row).toBe(5);
  });

  it('one declared read sequence reads identically through the fixture seam and the in-memory seam', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghrc-seam-'));
    try {
      writeFileSync(join(dir, `${mangle(B)}.svg`), '<svg><title>Marketplace Health Check - failing</title></svg>');
      writeFileSync(join(dir, `${mangle(B)}.svg.2`), fx('badge-passing-marketplace-check-main.svg'));
      writeFileSync(join(dir, `${mangle(P)}.html`), realPage(FAILED));
      const viaFiles = spawnSync('node', [MODULE, '--repo', MC.repo, '--workflow', MC.workflow, '--branch', 'main', '--class', 'alerting'],
        { encoding: 'utf8', env: { ...process.env, XREPO_CI_FIXTURE_DIR: dir, GHRC_SPACING_S: '0' } });
      const fileRec = JSON.parse((viaFiles.stdout.split('\n').find((l) => l.startsWith('GHRC_RECORD=')) ?? '').slice(12));
      const memRec = read(MC, { [B]: [failing, { body: fx('badge-passing-marketplace-check-main.svg') }], [P]: [{ body: realPage(FAILED) }] });
      expect(fileRec.samples.map((s: { row: number }) => s.row)).toEqual(memRec.samples.map((s: { row: number }) => s.row));
      expect(fileRec.row).toBe(memRec.row);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a dangling --min-run-id is a usage error, never a dropped floor', { timeout: 30_000 }, () => {
    const r = spawnSync('node', [MODULE, '--repo', MC.repo, '--workflow', MC.workflow, '--branch', 'main', '--class', 'alerting', '--min-run-id'], { encoding: 'utf8' });
    expect(r.stdout.trimEnd().split('\n').pop()).toBe(`${TOKEN}=INDETERMINATE`);
    expect(r.status).toBe(EXIT.INDETERMINATE);
  });
});

describe('AC11 / AC12 — the token and the boundaries', () => {
  const src = readFileSync(MODULE, 'utf8');
  it('exactly one token line; exit by token; a malformed call is INDETERMINATE', { timeout: 30_000 }, () => {
    const r = spawnSync('node', [MODULE, '--repo', 'x'], { encoding: 'utf8' });
    expect(r.stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`))).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.status).toBe(EXIT.INDETERMINATE);
  });
  it('no api.github.com, no network write, no Telegram, no process.exit, no job_groups_batch', () => {
    expect(src).not.toMatch(/api\.github\.com/);
    expect(src).not.toMatch(/send_telegram|api\.telegram\.org/);
    expect(src).not.toMatch(/-X\s*['"]?(POST|PUT|PATCH|DELETE)|method:\s*['"](POST|PUT|PATCH|DELETE)|--data\b/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/process\.exit\(/);
    expect(code).toMatch(/process\.exitCode = /);
    expect(code).not.toMatch(/job_groups_batch/);
  });
});

describe('the vocabulary is measured DATA — every entry is backed by a committed fixture', () => {
  it('each ICON_VOCAB entry classifies the status svg of a committed row fixture to itself', () => {
    const files = readdirSync(FX).filter((f) => f.startsWith('row-'));
    for (const e of ICON_VOCAB as Array<{ state: string; provenance: { run_id: string; source: string } }>) {
      const f = files.find((x) => x.startsWith(`row-${e.state}-`));
      expect(f, `fixture for ${e.state}`).toBeTruthy();
      const body = fx(f!);
      expect(body).toContain(e.provenance.run_id);
      expect(parsePage(realPage(body))[0].state).toBe(e.state);
    }
  });
  it('a third-party entry is labelled third-party and its fixture says SYNTHESIZED with the verbatim tag source', () => {
    for (const e of (ICON_VOCAB as Array<{ state: string; provenance: { source: string; run_id: string } }>).filter((x) => x.provenance.source === 'third-party')) {
      expect(fx(`row-${e.state}-synth.html`)).toMatch(new RegExp(`SYNTHESIZED row for state ${e.state}.*VERBATIM from .* run ${e.provenance.run_id}`));
    }
  });
  it('no fixture carries an unscrubbed token value (the repo is public)', () => {
    for (const f of readdirSync(FX)) {
      const s = fx(f);
      for (const m of s.matchAll(/name="(authenticity_token|request-id|html-safe-nonce|fetch-nonce|visitor-payload|visitor-hmac)"[^>]*?(value|content)="([^"]*)"/g)) expect(m[3], `${f} ${m[1]}`).toBe('SCRUBBED');
      expect(s, f).not.toMatch(/data-channel="[^"]*--[0-9a-f]{16,}"/);
      expect(s, f).not.toMatch(/data-hydro-(click|view)-hmac="(?!SCRUBBED)[0-9a-f]{16,}"/);
      expect(s, f).not.toMatch(/[A-Za-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail|proton)\.[a-z]+/);
      expect(s, f).not.toMatch(/data-nonce="(?!SCRUBBED")[^"]+"/);
      expect(s, f).not.toMatch(/auth_hydro_click_hmac(&quot;|")\s*:\s*(&quot;|")(?!SCRUBBED)[^&"]+/);
      expect(s, f).not.toMatch(/(nonce|hmac|token)(&quot;|["'])?\s*[:=]\s*(&quot;|["'])(?!SCRUBBED)[A-Za-z0-9+/_:=-]{16,}/i);
    }
  });
});

describe('byte parity with the canary (the CH3 shims delegate here)', () => {
  // The reference is FROZEN: the pre-migration bash parsers, verbatim (CH3 turned the canary's copies
  // into shims over this module, so comparing against the live canary would compare the module with itself).
  const bashFns = () => {
    const src = fx('legacy-canary-parsers.sh');
    const grab = (name: string) => { const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src); expect(m, name).toBeTruthy(); return m![0]; };
    const all = [grab('parse_badge_status'), grab('classify_status'), grab('parse_runs_page')].join('\n');
    expect(all).not.toMatch(/GHRC_JS|NODE_BIN/); // never a shim
    return all;
  };
  const corpusPages = [
    ...readdirSync(FX).filter((f) => f.endsWith('.html')).map((f) => fx(f)),
    '<div id="check_suite_1"><a href="/o/a/actions/runs/35616111211" aria-label="failed:  Run 131 of Marketplace Health Check."></a><relative-time     datetime="2026-09-21T15:01:35Z"></relative-time></div>',
    '<div id="check_suite_1"><a href="/o/a/actions/runs/9" aria-label="failed:  Run 1 of X."></a></div>',
    '<div id="check_suite_1"><a aria-label="failed:  Run 1 of X."></a><relative-time datetime="2026-01-01T00:00:00Z"></relative-time></div>',
    '<html><body>no rows</body></html>', '',
    'a\r\nid="check_suite_9">\r\n<a href="/o/b/actions/runs/12">Run\t7\tof</a><relative-time datetime="x"></relative-time>',
  ];
  const corpusBadges = [
    ...readdirSync(FX).filter((f) => f.endsWith('.svg')).map((f) => fx(f)),
    '<svg><title>Build - Deploy - passing</title></svg>', '<svg></svg>', '<svg><title>whatever</title></svg>',
    '<svg><title>a - b</title><title>c - d</title></svg>', '<svg><title>trailing - </title></svg>', '<svg>\n<title>multi\nline - failing</title></svg>',
  ];

  it('--parse-badge / --parse-page / --classify-status equal the canary functions, output AND return code', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghrc-par-'));
    try {
      const fns = join(dir, 'fns.sh');
      writeFileSync(fns, bashFns());
      const run = (kind: string, input: string) => {
        const inp = join(dir, 'in');
        writeFileSync(inp, input);
        const b = spawnSync('bash', ['-c', `source "${fns}"; x=$(cat "${inp}"); out=$(${kind} "$x"); rc=$?; printf '%s|rc=%s' "$out" "$rc"`], { encoding: 'utf8' });
        const mode = kind === 'parse_badge_status' ? '--parse-badge' : '--parse-page';
        const n = spawnSync('bash', ['-c', `x=$(cat "${inp}"); out=$(printf '%s' "$x" | node "${MODULE}" ${mode}); rc=$?; printf '%s|rc=%s' "$out" "$rc"`], { encoding: 'utf8' });
        return [b.stdout, n.stdout];
      };
      for (const p of corpusPages) { const [b, n] = run('parse_runs_page', p); expect(n).toBe(b); }
      for (const s of corpusBadges) { const [b, n] = run('parse_badge_status', s); expect(n).toBe(b); }
      for (const t of ['passing', 'failing', 'no status', 'brand new github word', '']) {
        const b = spawnSync('bash', ['-c', `source "${fns}"; classify_status "$1"`, '_', t], { encoding: 'utf8' }).stdout;
        const n = spawnSync('node', [MODULE, '--classify-status', t], { encoding: 'utf8' }).stdout;
        expect(n).toBe(b);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the CANARY\'s shims, sourced as cron runs them, equal the module sub-modes on the real corpus', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghrc-shim-'));
    try {
      const src = readFileSync(CANARY, 'utf8');
      const grab = (name: string) => new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)![0];
      const fns = join(dir, 'shims.sh');
      writeFileSync(fns, [grab('ghrc_ready'), grab('parse_badge_status'), grab('classify_status'), grab('parse_runs_page')].join('\n'));
      const node = execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim();
      for (const [kind, inputs] of [['parse_runs_page', corpusPages.slice(0, 6)], ['parse_badge_status', corpusBadges]] as const) {
        for (const input of inputs) {
          const inp = join(dir, 'in');
          writeFileSync(inp, input);
          const viaShim = spawnSync('bash', ['-c', `GHRC_JS="${MODULE}"; NODE_BIN="${node}"; source "${fns}"; x=$(cat "${inp}"); out=$(${kind} "$x"); printf '%s|rc=%s' "$out" "$?"`], { encoding: 'utf8' }).stdout;
          const viaFrozen = spawnSync('bash', ['-c', `source "${FX}/legacy-canary-parsers.sh"; x=$(cat "${inp}"); out=$(${kind} "$x"); printf '%s|rc=%s' "$out" "$?"`], { encoding: 'utf8' }).stdout;
          expect(viaShim).toBe(viaFrozen);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fixture-name mangling equals `printf %s "$url" | tr -c A-Za-z0-9 _` over a URL corpus', { timeout: 30_000 }, () => {
    const urls = [badgeUrl(MC), actionsUrl(MC), badgeUrl({ ...MC, branch: null }), actionsUrl({ ...MC, branch: null }),
      'https://github.com/o/a/commits/main.atom', 'https://x/y?a=b&c=d#frag', 'https://x/ü/é space', 'https://x/feature/branch-1.2_x'];
    // LC_ALL=C pins tr to BYTES. Under a UTF-8 locale (e.g. Python's PEP 538 coercion) macOS tr maps a
    // multi-byte char to ONE '_' — measured while building this test. That can never reach the module:
    // every URL it builds is pure ASCII by input validation (asserted just below).
    for (const u of urls) {
      const b = execFileSync('bash', ['-c', 'printf "%s" "$1" | LC_ALL=C tr -c "A-Za-z0-9" "_"', '_', u], { encoding: 'latin1' });
      expect(mangle(u)).toBe(b);
    }
  });

  it('every URL the module can build is pure ASCII, so the mangling is locale-independent by construction', () => {
    for (const bad of [{ ...MC, repo: 'o/ü' }, { ...MC, workflow: 'wé.yml' }, { ...MC, branch: 'feature/ü' }]) {
      const rec = read(bad, {});
      expect(rec.row).toBe('R');
      expect(rec.reads).toBe(0);
    }
    for (const u of [badgeUrl(MC), actionsUrl(MC), badgeUrl(PV), actionsUrl({ ...PV, branch: null })]) expect(/^[\x20-\x7e]+$/.test(u)).toBe(true);
  });
});

// The twin with deploy-drift's parseBadgeTitle (pinned CH2 → CH4) is RETIRED: CH4 removed
// parseBadgeTitle, so there is no second badge parser left to agree with. Its replacement guarantee is
// the registry's "exactly ONE classifier" below.

describe('the CONSUMER REGISTRY — exactly ONE classifier, consumers found by what they import or exec', () => {
  /** Every file that imports or execs the module (architect ruling Q8): enumerated here AND in the inventory row's consumed_by. */
  const REGISTERED = ['ops/cron/xrepo-ci-conclusion-canary.sh', 'ops/monitoring/deploy-drift-canary.mjs', 'scripts/check-release-readiness.mjs'];
  /** CH2 baseline of private classifiers. CH3 removed the canary; CH4 emptied the ratchet. It may only ever shrink. */
  const CH2_BASELINE = ['ops/cron/xrepo-ci-conclusion-canary.sh', 'ops/monitoring/deploy-drift-canary.mjs', 'scripts/check-release-readiness.mjs'];
  const PENDING: string[] = [];

  /**
   * Executable text = the file with its COMMENTS removed by a LEXER, never by a regex. The CH2 regex
   * strip ran /* … *\/ before //, so a "/*" inside a // comment or a string opened a false span that
   * deleted LIVE code up to the next "*\/" — measured 52 files / 119 spans / 3,836 lines across the
   * corpus (CH4 R0 §15.3), including deploy-drift's 'ops/monitoring/**' string: exactly where a private
   * parser could hide (M10b). JS/TS go through the TypeScript parser's own comment ranges (regex vs
   * division resolved by the parser); shell/YAML/Python keep the line-comment rule.
   */
  const stripJs = (file: string, text: string) => {
    const kind = /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const ranges = new Map<number, number>();
    const add = (rs: readonly ts.CommentRange[] | undefined) => { for (const r of rs ?? []) ranges.set(r.pos, r.end); };
    const walk = (n: ts.Node) => {
      add(ts.getLeadingCommentRanges(text, n.pos)); add(ts.getTrailingCommentRanges(text, n.end));
      for (const c of n.getChildren(sf)) walk(c);
    };
    walk(sf);
    add(ts.getLeadingCommentRanges(text, 0));
    const chars = text.split('');
    for (const [pos, end] of ranges) for (let k = pos; k < end; k++) if (chars[k] !== '\n') chars[k] = ' ';
    return chars.join('');
  };
  const executableText = (file: string, text: string) => {
    if (/\.(sh|ya?ml|py)$/.test(file)) return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    return stripJs(file, text);
  };
  /** The CH2 regex strip, kept ONLY to prove the lexer is load-bearing (M10b is invisible to it). */
  const naiveStrip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // A CLASSIFIER is a file that INTERPRETS a badge or a run page — a PARSE construct, never a mention:
  //   · a <title> CONTENT extraction: sed `<title>\([^<]`, grep `<title>[^<]`, a regex `<title>([^<]`;
  //   · a run-row split: split('id="check_suite_'), sed 's/id="check_suite_/', or a regex literal
  //     holding check_suite_ that is .exec/.test/.match-ed;
  //   · a call into a private badge parser (parseBadgeTitle).
  // A fixture WRITER (printf '<div id="check_suite_%s"…', `<title>${name}</title>`) is neither.
  const isClassifierText = (text: string) => /<title>\\?\(?\[\^</.test(text)
    || /split\(\s*['"`]id="check_suite_/.test(text) || /s\/id="check_suite_\//.test(text)
    || /\/[^/\n]*check_suite_[^/\n]*\/[gimsuy]*\.(exec|test)\(|\.match\(\s*\/[^/\n]*check_suite_/.test(text)
    || /\bparseBadgeTitle\s*\(/.test(text);
  const classify = (f: string, text: string) => {
    const literal = (/actions\/workflows\//.test(text) && /badge\.svg/.test(text)) || /check_suite_/.test(text);
    // Ruling Q8: a consumer is found by what it IMPORTS or EXECS — never by a URL string it happens to keep.
    const consumes = f !== MODULE_REL && /gh-run-conclusion\.mjs/.test(text);
    const reads = literal || consumes;
    // The classifier check covers every file that reads OR is registered (a registered file can never
    // hide a private parser by dropping its last URL literal).
    const classifier = (reads || REGISTERED.includes(f)) && isClassifierText(text);
    return { f, literal, consumes, reads, classifier };
  };

  // --others too: a rogue reader must fail BEFORE it is committed, not after.
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'ops', 'scripts', 'src', '.github'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => f && /\.(sh|mjs|cjs|js|ts|ya?ml|py)$/.test(f));
  const scan = tracked.map((f) => {
    let text = '';
    try { text = executableText(f, readFileSync(join(ROOT, f), 'utf8')); } catch { /* unreadable → skipped, counted below */ }
    return classify(f, text);
  });

  it('vacuity: the scan covered the tree, the module is a classifier, and EVERY registered file consumes the module', { timeout: 60_000 }, () => {
    expect(tracked.length).toBeGreaterThan(200);
    const mod = scan.find((s) => s.f === MODULE_REL);
    expect(mod?.literal && mod?.classifier).toBe(true);
    for (const r of REGISTERED) expect(scan.find((s) => s.f === r)?.consumes, r).toBe(true);
  });
  it('every file that imports or execs the module is REGISTERED (a new importer reds until it is enumerated)', () => {
    const unregistered = scan.filter((s) => s.consumes && !REGISTERED.includes(s.f)).map((s) => s.f);
    expect(unregistered).toEqual([]);
  });
  it('every executable that reads the badge or the run page is the module or a REGISTERED consumer', () => {
    const rogue = scan.filter((s) => s.reads && s.f !== MODULE_REL && !REGISTERED.includes(s.f)).map((s) => s.f);
    expect(rogue).toEqual([]);
  });
  it('exactly ONE classifier exists: the module (PENDING reached zero in CH4)', () => {
    expect(scan.filter((s) => s.classifier).map((s) => s.f)).toEqual([MODULE_REL]);
  });
  it('the ratchet reached zero and may only shrink: PENDING = [] ⊆ the CH2 baseline', () => {
    expect(PENDING).toEqual([]);
    for (const p of PENDING) expect(CH2_BASELINE).toContain(p);
  });
  it('the inventory row enumerates every registered consumer in consumed_by', () => {
    const inv = JSON.parse(readFileSync(join(ROOT, 'ops', 'monitoring', 'monitoring-inventory.json'), 'utf8'));
    const row = inv.artifacts.find((r: { id: string }) => r.id === 'gh-run-conclusion');
    expect([...row.consumed_by].sort()).toEqual([...REGISTERED].sort());
  });

  describe('mutations M10 / M10b (AC2) — proven able to fail, in memory, on the real deploy-drift text', () => {
    const DD = 'ops/monitoring/deploy-drift-canary.mjs';
    const raw = readFileSync(join(ROOT, DD), 'utf8');
    const PARSER = "\nconst __m10 = (svg) => (/<title>([^<]*)<\\/title>/.exec(String(svg)) || [])[1];\n";
    it('baseline: deploy-drift as shipped is a consumer and NOT a classifier', () => {
      const s = classify(DD, executableText(DD, raw));
      expect(s.consumes && !s.classifier).toBe(true);
    });
    it('M10: a private <title> parser appended to deploy-drift makes it a classifier (the registry reds)', () => {
      expect(classify(DD, executableText(DD, raw + PARSER)).classifier).toBe(true);
    });
    it("M10b: the same parser inside the former false span (the self-test's 'ops/monitoring/**' strings) is caught by the lexer — and was INVISIBLE to the CH2 regex strip", () => {
      // The span opens at the first "/**" inside a 'ops/monitoring/**' STRING and runs to the next "*/";
      // the IGN declaration is a complete statement inside it, so the mutant stays syntactically valid.
      const anchor = raw.indexOf("const IGN = ['ops/monitoring/**'");
      expect(anchor, "deploy-drift's self-test still carries the IGN statement inside the false span").toBeGreaterThan(0);
      const eol = raw.indexOf('\n', anchor);
      const mutated = raw.slice(0, eol + 1) + PARSER + raw.slice(eol + 1);
      expect(classify(DD, executableText(DD, mutated)).classifier).toBe(true);
      expect(isClassifierText(naiveStrip(mutated))).toBe(false);
    });
  });
});

describe('any ref is SAME-REF (ruling Q9) — on REAL captured markup', () => {
  const NPM = { repo: 'AlgoVaultLabs/crypto-quant-signal-mcp', workflow: 'publish-npm.yml', branch: null };
  const ref = (r: string) => ({ ...NPM, branch: r });
  const anyRefPage = () => realPage(fx('row-success-37201506699-anyref.html'), fx('row-success-37182060859-anyref.html'));
  it('refOfRun reads the branch-name title of THAT run on the real rows (#29 → v1.31.1, #28 → main)', () => {
    expect(refOfRun(anyRefPage(), '37201506699')).toEqual({ ref: 'v1.31.1', reason: null });
    expect(refOfRun(anyRefPage(), '37182060859')).toEqual({ ref: 'main', reason: null });
  });
  it('the 2026-10-04 v1.31.1 release: resolved to v1.31.1, both instruments read ON it, bound #29 — the no-param badge never requested', () => {
    const seen: string[] = [];
    const inner = memoryFetch({
      [actionsUrl(NPM)]: [{ body: anyRefPage() }],
      [badgeUrl(ref('v1.31.1'))]: [{ body: fx('badge-passing-publish-npm-v1.31.1.svg') }],
      [actionsUrl(ref('v1.31.1'))]: [{ body: realPage(fx('row-success-37201506699-anyref.html')) }],
    });
    const rec = readConclusion({ ...NPM, cls: 'blocking' }, { fetchDoc: (u: string, e: string, n: number, f: string) => { seen.push(u); return inner(u, e, n, f); }, sleep: noSleep, reads: 3, spacingS: 60, env: {}, host: 'https://github.com' });
    expect(rec.row).toBe(1);
    expect(rec.resolved_ref).toBe('v1.31.1');
    expect(rec.bound_run?.run_id).toBe('37201506699');
    expect(verdictFor(rec, 'blocking')).toBe('PASS');
    expect(seen).not.toContain(badgeUrl(NPM));
    expect(renderLines(rec, 'blocking')).toContain('GHRC_RESOLVED_REF=v1.31.1');
  });
  it('a ref the badge cannot take (a slash-ref) is refused with a named reason, never bound across runs', () => {
    const slashed = fx('row-success-37201506699-anyref.html').replace(/title="v1\.31\.1"/g, 'title="release/v1.31.1"');
    const rec = readConclusion({ ...NPM, cls: 'blocking' }, { fetchDoc: memoryFetch({ [actionsUrl(NPM)]: [{ body: realPage(slashed) }] }), sleep: noSleep, reads: 3, spacingS: 60, env: {}, host: 'https://github.com' });
    expect([rec.row, rec.agreement, rec.reason, verdictFor(rec, 'blocking')]).toEqual(['R', 'UNCORROBORATED', 'ref_out_of_vocabulary', 'INDETERMINATE']);
  });
});

describe('the inventory row — same commit as the module', () => {
  const inv = JSON.parse(readFileSync(join(ROOT, 'ops', 'monitoring', 'monitoring-inventory.json'), 'utf8'));
  const row = inv.artifacts.find((r: { id: string }) => r.id === 'gh-run-conclusion');
  it('exists, models the shared-library precedent, and is installed by the sanctioned installer (CH3)', () => {
    expect(row).toBeTruthy();
    expect(row).toMatchObject({ artifact: MODULE_REL, kind: 'executable', schedule: null, host: 'signal-1', host_path: '/opt/algovault-monitoring/gh-run-conclusion.mjs', install_state: 'installed', alert_ids: [] });
    expect(row.first_install).toEqual({ at: '20261004T095347Z', by: 'ops/scripts/install-monitoring-artifact.sh' });
    expect(row.installed_at).toEqual([{ host: 'signal-1', path: '/opt/algovault-monitoring/gh-run-conclusion.mjs' }]);
    expect(row.notes).toMatch(/^THE ONE DERIVATION of a GitHub workflow's latest-run conclusion/);
    for (const c of ['xrepo-ci-conclusion-canary', 'deploy-drift-canary', 'check-release-readiness']) expect(JSON.stringify([row.invoked_by, row.consumed_by]), c).toContain(c);
  });
  it('its sha256 is the module file’s', () => {
    expect(row.sha256).toBe(createHash('sha256').update(readFileSync(MODULE)).digest('hex'));
  });
  it('package.json wires the self-test as ghrc:selftest', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['ghrc:selftest']).toBe('node ops/monitoring/gh-run-conclusion.mjs --self-test');
  });
});

