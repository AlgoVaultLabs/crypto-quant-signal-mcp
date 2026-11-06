/**
 * DECISION-CALL-V2-W5 CH2 — the anchor's three host-side artifacts, RUN and pinned.
 *
 *   ops/cron/publish-call-ledger-batch.sh          the call-ledger anchor's cron wrapper (new)
 *   ops/monitoring/pre-trade-health-canary.sh      the hourly canary, now with a third token (call_ledger_stale)
 *   ops/monitoring/owed-read-call-ledger-week-1.py the first week's owed read (new)
 *
 * No other gate runs these self-tests (CI runs node checks; scripts/monitoring-census.mjs tests only itself), so
 * this file does — keyed on each one's SELF_TEST_VERDICT token, never its exit code alone, with each count pinned
 * to the script's OWN floor: an assertion added without its floor, or one silently lost, is red here.
 *
 * Then the cross-file contracts a single file cannot see: each inventory row is the committed bytes; the ONE
 * crontab line is declared alike in the wrapper, its inventory row and its interlock row; each alert's owner
 * is the file that pages it; and the wrapper never puts the key on a command line.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const sha256 = (f: string) => createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex');

const WRAPPER = 'ops/cron/publish-call-ledger-batch.sh';
const CANARY = 'ops/monitoring/pre-trade-health-canary.sh';
const OWED = 'ops/monitoring/owed-read-call-ledger-week-1.py';
const HOST_REPO = '/opt/crypto-quant-signal-mcp';
const CRON_LINE = `13 0 * * * flock -n /var/lock/algovault-publish-call-ledger-batch.lock ${HOST_REPO}/${WRAPPER} >> /var/log/publish-call-ledger-batch.log 2>&1`;

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const inventory = JSON.parse(read('ops/monitoring/monitoring-inventory.json')).artifacts as Row[];
const interlock = JSON.parse(read('ops/scripts/cron-interlock-registry.json')) as Row;
const alerts = JSON.parse(read('ops/monitoring/alert-registry.json')).alerts as Row[];
const inv = (id: string) => inventory.find((r) => r.id === id)!;
const lockRow = (id: string) => (interlock.rows as Row[]).find((r) => r.id === id)!;
const alert = (id: string) => alerts.find((r) => r.alert_id === id)!;

function selfTest(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const tokens = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('SELF_TEST_VERDICT='));
  return { status: r.status, tokens, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

/** A pending row carries its clock; an installed one, its install record (monitoring-inventory-reconcile.py). */
function expectInstallRecord(row: Row) {
  if (row.install_state === 'pending') {
    expect(row.pending_since, `${row.id}: a pending row without pending_since is the reconciler's NO_PENDING_SINCE breach`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  } else {
    expect(row.install_state).toBe('installed');
    expect(row.first_install?.at, `${row.id}: installed without first_install`).toMatch(/^\d{8}T\d{6}Z$/);
  }
}

describe('the self-tests — run here, judged by their token, counted against their own floor', () => {
  it.each([
    ['the cron wrapper', 'bash', [WRAPPER, '--self-test'], WRAPPER, /expected >= (\d+)\)/, /^SELF_TEST_VERDICT=PASS — (\d+) assertions /],
    ['the health canary', 'bash', [CANARY, '--self-test'], CANARY, /expected >= (\d+)\)/, /^SELF_TEST_VERDICT=PASS — (\d+) assertions /],
    ['the week-1 owed read', 'python3', [OWED, '--self-test'], OWED, /^_SELF_TEST_MIN_CHECKS = (\d+)$/m, /^SELF_TEST_VERDICT=PASS — (\d+) checks /],
  ] as const)('%s', (_, cmd, args, file, floorRe, passRe) => {
    const floor = Number(read(file).match(floorRe)?.[1]);
    expect(floor, `${file} declares no self-test floor`).toBeGreaterThan(0);
    const r = selfTest(cmd, [...args]);
    expect(r.tokens, r.out.slice(-3000)).toHaveLength(1);
    const ran = Number(r.tokens[0].match(passRe)?.[1]);
    expect(ran, r.tokens[0]).toBe(floor); // the floor IS the count: nothing added unpinned, nothing lost
    expect(r.status).toBe(0);
  }, 200_000);
});

describe('the inventory rows are the committed bytes, and say how they run', () => {
  it.each([
    ['pre-trade-health-canary', CANARY],
    ['publish-call-ledger-batch', WRAPPER],
    ['owed-read-call-ledger-week-1', OWED],
  ])('%s: sha256 matches %s', (id, file) => {
    expect(inv(id).artifact).toBe(file);
    expect(inv(id).sha256, 'inventory sha256 is stale — re-stamp it in the same commit as the edit').toBe(sha256(file));
  });

  it('the canary pages all three of its alerts, hourly, installed', () => {
    const r = inv('pre-trade-health-canary');
    expect(r.alert_ids).toEqual(['pre_trade_check_degraded', 'venue_fee_table_stale', 'call_ledger_stale']);
    expect(r.schedule).toBe('47 * * * *');
    expectInstallRecord(r);
  });

  it('the wrapper is repo-resident at the checkout, daily at 00:13, paging anchor_root_mismatch', () => {
    const r = inv('publish-call-ledger-batch');
    expect(r.repo_resident).toBe(true);
    expect(r.host_path).toBe(`${HOST_REPO}/${WRAPPER}`);
    expect(r.installed_at).toEqual([{ host: 'signal-1', path: `${HOST_REPO}/${WRAPPER}`, schedule: '13 0 * * *' }]);
    expect(r.schedule).toBe('13 0 * * *');
    expect(r.alert_ids).toEqual(['anchor_root_mismatch']);
    expect(r.owner_wave).toBe('DECISION-CALL-V2-W5');
    expectInstallRecord(r);
  });

  it('the owed read is called by the runner, never scheduled, and pages nothing of its own', () => {
    const r = inv('owed-read-call-ledger-week-1');
    expect(r.invoked_by).toBe('called-by:owed-read-runner');
    expect(r.schedule).toBeNull();
    expect(r.host_path).toBe('/opt/algovault-monitoring/owed-read-call-ledger-week-1.py');
    expect(r.alert_ids).toEqual([]);
    expectInstallRecord(r);
  });
});

describe('ONE crontab line, declared alike everywhere', () => {
  it('the wrapper header declares it verbatim', () => {
    expect(read(WRAPPER)).toContain(`#   ${CRON_LINE}  # DECISION-CALL-V2-W5 CH2 call-ledger anchor (inventory row publish-call-ledger-batch; preempt-and-catchup)`);
  });

  it('its inventory row quotes it', () => {
    expect(inv('publish-call-ledger-batch').notes).toContain(CRON_LINE);
  });

  it('its interlock row matches it: preempt-and-catchup, one line, the same spec, a cron_match inside the line', () => {
    const r = lockRow('publish-call-ledger-batch');
    expect(r).toMatchObject({ host: 'signal-1', class: 'preempt-and-catchup', cron: '13 0 * * *', cron_lines: 1, script: WRAPPER, owner_wave: 'DECISION-CALL-V2-W5' });
    expect(CRON_LINE.startsWith(`${r.cron} `)).toBe(true);
    expect(r.cron_match.length).toBeGreaterThan(0);
    for (const m of r.cron_match) expect(CRON_LINE).toContain(m);
    expect(read(WRAPPER)).toContain(`SCRIPT="${r.process_pattern}.js"`);
    expect(r.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the signal publisher is preempt-and-catchup now, at its own minute, and no longer a no-safe-kill residual', () => {
    const r = lockRow('publish-merkle-batch');
    expect(r).toMatchObject({ class: 'preempt-and-catchup', cron: '5 0 * * *', owner_wave: 'DECISION-CALL-V2-W5' });
    expect(r.cron).not.toBe(lockRow('publish-call-ledger-batch').cron);
    for (const ev of Object.values(interlock._residual_no_safe_kill['signal-1']) as Row[]) {
      expect(ev.ids).not.toContain('publish-merkle-batch');
      expect(ev.ids).not.toContain('publish-call-ledger-batch');
      expect(ev.count).toBe(ev.ids.length);
    }
  });

  it('the script the cron line runs is built from a source with the CJS entry guard', () => {
    const src = 'src/scripts/publish-call-ledger-batch.ts';
    expect(existsSync(join(ROOT, src))).toBe(true);
    expect(read(src)).toContain('if (require.main === module) {');
  });
});

describe('each alert is paged by the file that owns it', () => {
  it.each([
    ['call_ledger_stale', CANARY, 'LEDGER_ALERT_ID="call_ledger_stale"'],
    ['anchor_root_mismatch', WRAPPER, 'ALERT_ID="anchor_root_mismatch"'],
  ])('%s → %s', (id, owner, decl) => {
    const a = alert(id);
    expect(a).toMatchObject({ owner, hosts: ['signal-1'], adopted: true, announce_resolution: false });
    expect(a.envelope_follow_up_wave).toBe(`OPS-ENVELOPE-ADOPT-${id.toUpperCase()}-W{NEXT}`);
    expect(read(owner)).toContain(decl);
  });
});

describe('the wrapper never handles the key', () => {
  const src = read(WRAPPER);

  it('never names it (outside the self-test assertion that says so, which its own grep excludes the same way)', () => {
    const lines = src.split('\n');
    expect(lines.filter((l) => /^\s*hasnt '/.test(l) && l.includes('MERKLE_PUBLISHER_KEY'))).toHaveLength(1);
    expect(lines.filter((l) => !/^\s*hasnt '/.test(l)).join('\n')).not.toMatch(/MERKLE_PUBLISHER_KEY/);
  });

  it('execs the container’s node with no -e, so no secret can ride the command line', () => {
    const execs = src.split('\n').filter((l) => /^\s*[^#\s].*\bdocker\b.*\bexec\b/.test(l) || /"\$DOCKER" exec/.test(l));
    expect(execs.length).toBeGreaterThan(0);
    for (const l of execs) expect(l, l).not.toMatch(/\s-e\s|--env\b/);
  });

  it('recommends a templated wave, never a literal number', () => {
    expect(src).toContain('Recommended wave: DECISION-CALL-V2-W{NEXT}');
    expect(src).not.toMatch(/Recommended wave: [A-Z0-9-]+-W\d/);
  });
});
