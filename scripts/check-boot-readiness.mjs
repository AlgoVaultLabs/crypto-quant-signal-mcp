#!/usr/bin/env node
// @ts-check
/**
 * check-boot-readiness.mjs — every must-survive service must come back on its OWN.
 *
 * OPS-HOST-KERNEL-REBOOT-W1 / R3 — the generator for SEC-18.
 *
 * THE BUG CLASS. SEC-18 was "the kernel is 12 revisions behind", but the real exposure was that
 * NOBODY KNEW WHETHER THE BOX COMES BACK. A planned reboot is a test; an unplanned one (Hetzner
 * maintenance, a panic, an OOM) is a discovery. The classic casualty is a unit someone started by
 * hand and never enabled: perfectly healthy today, gone after boot, and invisible to every existing
 * gate because `is-active` says "running".
 *
 * WHY THIS IS NOT A ONE-LINE `is-enabled` GREP — and this is the whole design:
 * measured on both live hosts during R0, the naive check produces TWO false positives, and both are
 * on units whose "fix" would be actively harmful:
 *
 *   ssh.service                        is-enabled=disabled  → CORRECT: Ubuntu 24.04 socket-activates
 *                                                             it; ssh.socket is enabled. "Fixing" it
 *                                                             is a real misconfiguration, and SSH is
 *                                                             the one unit whose loss needs console.
 *   algovault-funnel-snapshot.service  is-enabled=disabled  → CORRECT: its .timer is enabled.
 *                                                             Enabling the .service would make it
 *                                                             run at boot instead of on schedule.
 *
 * A canary that cried wolf on SSH would be ignored within a week. So the contract in
 * scripts/data/boot-critical-units.json declares HOW each unit is legitimately activated
 * (`enabled` | `socket` | `timer`) and this asserts EFFECTIVE enablement.
 *
 * WHAT IT ASSERTS (static contract checks — no SSH, safe in CI):
 *   R1  Every declared unit has a coherent activation rule, and every `socket`/`timer` row names
 *       the unit that actually carries the enablement.
 *   R2  Every declared container appears in a committed compose file with an acceptable
 *       restart policy — so auto-recovery is guaranteed IN CODE, not just in live state.
 *   R3  Postgres declares a stop budget >= the contract floor, so a future 10 GB-plus database
 *       cannot be SIGKILLed into crash recovery at reboot.
 *
 * WHAT IT DOES NOT ASSERT — and this gap is REAL, not an oversight to be patched here.
 * Nothing above verifies that the hosts actually MATCH the contract. A `systemctl disable caddy`
 * would pass every check in this file until the next reboot took the site down. The contract is
 * checked for internal coherence; live effective enablement is checked by nobody, on no schedule.
 *
 * This docstring previously claimed `--host-check` "additionally probes a live host over SSH
 * (used by the scheduled run on the box)". That flag was NEVER implemented — there is no argv
 * handling for it — and there is no scheduled run on any box: measured 2026-08-15 by
 * OPS-HOST-KERNEL-REBOOT-W2, zero cron/timer entries on either host, no monitoring-inventory row,
 * and this script is not even present on aoe-1. The claim was referenced nowhere but itself, so
 * nothing broke; it simply made the continuous half of the boot-survival guarantee look shipped.
 *
 * Do NOT "fix" this by adding `--host-check` here. CI runs this gate and CI must never hold prod
 * SSH credentials. The live half belongs in a host-side scheduled canary of the same shape as
 * ops/monitoring/kernel-staleness-canary.sh (committed ancestor + inventory row + verdict token +
 * backup convention + per-host installed_at registry) — tracked as
 * OPS-BOOT-READINESS-HOST-CANARY-W{NEXT}. Reading LIVE restart policies there also covers aoe-1,
 * whose compose lives in another repo, without any cross-repo access (see the exemption note in
 * scripts/data/boot-critical-units.json).
 *
 * Usage:
 *   node scripts/check-boot-readiness.mjs --self-test
 *   node scripts/check-boot-readiness.mjs
 *
 * Verdict: exactly one terminal `BOOT_READINESS_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (new gate → the token-law default).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const CONTRACT = join(ROOT, 'scripts/data/boot-critical-units.json');
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.aoe.yml'];

const VALID_ACTIVATIONS = new Set(['enabled', 'socket', 'timer']);

function daysUntil(dateStr, now) {
  return Math.floor((new Date(`${dateStr}T00:00:00Z`).getTime() - now.getTime()) / 86_400_000);
}

/** Load + validate the contract. Never throws; never guesses. */
export function loadContract(raw, now) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `contract is unparseable: ${err instanceof Error ? err.message : err}` };
  }
  const hosts = d?.hosts;
  if (!hosts || typeof hosts !== 'object' || Object.keys(hosts).length === 0) {
    return { ok: false, reason: 'contract declares no hosts — it would verify nothing' };
  }
  const total = Object.values(hosts).reduce((n, h) => n + (Array.isArray(h.units) ? h.units.length : 0), 0);
  if (total === 0) return { ok: false, reason: 'contract declares no units — it would verify nothing' };
  // ── compose_exempt_containers (OPS-BOOT-CONTRACT-WIDEN-W1) ────────────────────────────────
  // The per-CONTAINER form of the pre-existing per-HOST `compose_in_this_repo: false` exemption,
  // for a container whose compose lives outside this repo while the rest of the host's does not.
  // Validated HERE, not in R2, because a malformed exemption is a defect in a corpus WE author:
  // that is INDETERMINATE ("could not decide"), never FAIL ("the tree is bad"). The reason is
  // MANDATORY — a missing/empty reason is INDETERMINATE, never a silent pass.
  for (const [host, h] of Object.entries(hosts)) {
    const ex = h.compose_exempt_containers;
    if (ex === undefined) continue;
    if (!Array.isArray(ex)) return { ok: false, reason: `host ${host} has a \`compose_exempt_containers\` that is not an array` };
    for (const row of ex) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.container !== 'string' || row.container.length === 0) {
        return { ok: false, reason: `host ${host} has a compose_exempt_containers row without a non-empty string \`container\`` };
      }
      if (typeof row.reason !== 'string' || row.reason.trim().length === 0) {
        return { ok: false, reason: `host ${host} exempts container ${row.container} from the R2 compose check with a missing or empty \`reason\` — the reason is MANDATORY, an unexplained exemption is INDETERMINATE and never a silent pass` };
      }
      if (!(h.containers ?? []).includes(row.container)) {
        return { ok: false, reason: `host ${host} exempts ${row.container} from the R2 compose check, but that container is not in its \`containers\` — exempting something nothing checks is a stale row, not an exemption` };
      }
    }
  }
  const revisit = d._TODO_revisit_by;
  if (typeof revisit === 'string' && daysUntil(revisit, now) < 0) {
    return { ok: false, reason: `contract is STALE — _TODO_revisit_by ${revisit} has passed; re-probe both hosts` };
  }
  return { ok: true, contract: d, unitCount: total };
}

/**
 * R1 — an activation rule that cannot be checked is worse than none, because it reads as coverage.
 * A `socket`/`timer` row MUST name the unit that carries the enablement, and that unit must be of
 * the matching type.
 */
export function findActivationContractErrors(contract) {
  const hits = [];
  for (const [host, h] of Object.entries(contract.hosts ?? {})) {
    for (const u of h.units ?? []) {
      if (!u.unit) { hits.push({ rule: 'R1', detail: `${host}: a unit row has no \`unit\`` }); continue; }
      if (!VALID_ACTIVATIONS.has(u.activation)) {
        hits.push({ rule: 'R1', detail: `${host}/${u.unit}: activation "${u.activation}" is not one of ${[...VALID_ACTIVATIONS].join('|')}` });
        continue;
      }
      if (u.activation === 'enabled') continue;
      if (!u.via) {
        hits.push({ rule: 'R1', detail: `${host}/${u.unit}: activation "${u.activation}" but no \`via\` — nothing to verify enablement against` });
        continue;
      }
      const wantSuffix = u.activation === 'socket' ? '.socket' : '.timer';
      if (!String(u.via).endsWith(wantSuffix)) {
        hits.push({ rule: 'R1', detail: `${host}/${u.unit}: activation "${u.activation}" but via="${u.via}" is not a ${wantSuffix} unit` });
      }
    }
  }
  return hits;
}

/** R2 — auto-recovery must be guaranteed in COMMITTED code, not merely in live state. */
export function findRestartPolicyGaps(contract, composeTexts) {
  const hits = [];
  const ok = new Set(contract.acceptable_restart_policies ?? ['always', 'unless-stopped']);
  const all = composeTexts.join('\n');
  if (!all.trim()) return [{ rule: 'R2', detail: 'no compose file content was readable — cannot verify restart policies' }];
  for (const [host, h] of Object.entries(contract.hosts ?? {})) {
    // A host whose compose lives in ANOTHER repo cannot be verified from here. That is an
    // EXEMPTION WITH A STATED REASON on the row (never a silent skip) — the caller reports it.
    if (h.compose_in_this_repo === false) continue;
    // A container whose compose lives outside this repo, declared ON THE ROW with a mandatory
    // reason (shape already validated by loadContract). Its live restart policy IS still asserted
    // daily by ops/monitoring/boot-contract-canary.sh via `docker inspect`, which is a stronger
    // instrument than this committed-YAML proxy — so the coverage moves, it does not vanish.
    const composeExempt = new Set((h.compose_exempt_containers ?? []).map((e) => e.container));
    for (const c of h.containers ?? []) {
      if (composeExempt.has(c)) continue;
      // Compose names containers `<project>-<service>-<n>` or via container_name. Derive the
      // service token and require a restart policy to exist somewhere in the composed stack.
      const svc = String(c).replace(/^crypto-quant-signal-mcp-/, '').replace(/-\d+$/, '');
      const named = new RegExp(`container_name:\\s*${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(all);
      const asService = new RegExp(`^\\s{2}${svc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm').test(all);
      if (!named && !asService) {
        hits.push({ rule: 'R2', detail: `${host}/${c}: not found in any committed compose file — its auto-restart is undeclared in code` });
      }
    }
  }
  const policies = [...all.matchAll(/restart:\s*([a-z-]+)/g)].map((m) => m[1]);
  if (policies.length === 0) hits.push({ rule: 'R2', detail: 'no `restart:` policy declared anywhere in compose' });
  for (const p of policies) {
    if (!ok.has(p)) hits.push({ rule: 'R2', detail: `compose declares restart: ${p} — not in ${[...ok].join('|')}; that container will NOT return after a reboot` });
  }
  return hits;
}

/** R3 — Postgres must not be SIGKILLed into crash recovery at reboot. */
export function findStopBudgetGaps(contract, composeTexts) {
  const min = Number(contract.postgres_stop_budget_seconds_min ?? 30);
  const all = composeTexts.join('\n');
  const m = all.match(/stop_grace_period:\s*(\d+)s/);
  if (!m) {
    return [{ rule: 'R3', detail: `no \`stop_grace_period\` declared — Docker's 10s default applies; contract floor is ${min}s` }];
  }
  const got = Number(m[1]);
  if (got < min) {
    return [{ rule: 'R3', detail: `stop_grace_period ${got}s is below the ${min}s contract floor` }];
  }
  return [];
}

export function scan(contract, composeTexts) {
  return [
    ...findActivationContractErrors(contract),
    ...findRestartPolicyGaps(contract, composeTexts),
    ...findStopBudgetGaps(contract, composeTexts),
  ];
}

// ── self-test ────────────────────────────────────────────────────────────────
const GOOD_CONTRACT = {
  _TODO_revisit_by: '2099-01-01',
  hosts: { h: { units: [
    { unit: 'ssh.service', activation: 'socket', via: 'ssh.socket' },
    { unit: 'docker.service', activation: 'enabled' },
    { unit: 'x.service', activation: 'timer', via: 'x.timer' },
  ], containers: ['postgres'] } },
  acceptable_restart_policies: ['always', 'unless-stopped'],
  postgres_stop_budget_seconds_min: 30,
};
const GOOD_COMPOSE = ['services:\n  postgres:\n    restart: unless-stopped\n    stop_grace_period: 120s\n'];

function selfTest() {
  const fails = [];
  const now = new Date('2026-07-31T00:00:00Z');

  // (a) the happy path is genuinely clean
  if (scan(GOOD_CONTRACT, GOOD_COMPOSE).length !== 0) fails.push('a valid contract + compose did not pass');

  // (b) MUST-FIRE R1: socket/timer rows without a `via`, or with the wrong unit type
  const noVia = JSON.parse(JSON.stringify(GOOD_CONTRACT));
  noVia.hosts.h.units[0] = { unit: 'ssh.service', activation: 'socket' };
  if (!scan(noVia, GOOD_COMPOSE).some((h) => h.rule === 'R1')) fails.push('socket activation with no `via` was not flagged');
  const wrongVia = JSON.parse(JSON.stringify(GOOD_CONTRACT));
  wrongVia.hosts.h.units[0] = { unit: 'ssh.service', activation: 'socket', via: 'ssh.timer' };
  if (!scan(wrongVia, GOOD_COMPOSE).some((h) => h.rule === 'R1')) fails.push('socket activation via a .timer was not flagged');
  // NB the fixture carries a VALID `via`, and the assertion matches the SPECIFIC message. Both
  // matter: an earlier version used `{activation:'magic'}` with no `via` and asserted only
  // `.some(rule === 'R1')` — so disabling the activation-type check entirely STILL passed, because
  // the row fell through to the no-`via` branch and produced an R1 hit for a different reason. The
  // deliberate-break proof is what surfaced that; a coarse "some rule fired" assertion cannot tell
  // two causes apart and silently stops guarding the one it names.
  const badAct = JSON.parse(JSON.stringify(GOOD_CONTRACT));
  badAct.hosts.h.units[1] = { unit: 'docker.service', activation: 'magic', via: 'docker.socket' };
  if (!scan(badAct, GOOD_COMPOSE).some((h) => h.rule === 'R1' && /is not one of/.test(h.detail))) {
    fails.push('an unknown activation kind was not flagged BY THE ACTIVATION-TYPE CHECK');
  }

  // (c) MUST-NOT-FIRE: the two REAL false positives that motivated this design
  const realWorld = JSON.parse(JSON.stringify(GOOD_CONTRACT));
  realWorld.hosts.h.units = [
    { unit: 'ssh.service', activation: 'socket', via: 'ssh.socket' },
    { unit: 'algovault-funnel-snapshot.service', activation: 'timer', via: 'algovault-funnel-snapshot.timer' },
  ];
  realWorld.hosts.h.containers = ['postgres'];
  if (scan(realWorld, GOOD_COMPOSE).length !== 0) {
    fails.push('the socket-activated ssh + timer-activated snapshot rows were flagged — the exact false positives this exists to avoid');
  }

  // (d) MUST-FIRE R2: a bad restart policy, and an undeclared container
  if (!scan(GOOD_CONTRACT, ['services:\n  postgres:\n    restart: no\n    stop_grace_period: 120s\n']).some((h) => h.rule === 'R2')) {
    fails.push('restart: no was not flagged');
  }
  if (!scan(GOOD_CONTRACT, ['services:\n  other:\n    restart: always\n    stop_grace_period: 120s\n']).some((h) => h.rule === 'R2')) {
    fails.push('a declared container missing from compose was not flagged');
  }

  // (e) MUST-FIRE R3: missing and below-floor stop budgets
  if (!scan(GOOD_CONTRACT, ['services:\n  postgres:\n    restart: always\n']).some((h) => h.rule === 'R3')) {
    fails.push('a missing stop_grace_period was not flagged');
  }
  if (!scan(GOOD_CONTRACT, ['services:\n  postgres:\n    restart: always\n    stop_grace_period: 5s\n']).some((h) => h.rule === 'R3')) {
    fails.push('a below-floor stop_grace_period was not flagged');
  }

  // (e2) compose_exempt_containers — the per-container R2 exemption (OPS-BOOT-CONTRACT-WIDEN-W1)
  // MUST-FIRE first: without the exemption an out-of-repo container IS flagged. Asserting only the
  // exempted case would pass just as happily if R2 had stopped checking containers altogether.
  const outOfRepo = JSON.parse(JSON.stringify(GOOD_CONTRACT));
  outOfRepo.hosts.h.containers = ['postgres', 'vendor-thing-1'];
  if (!scan(outOfRepo, GOOD_COMPOSE).some((x) => x.rule === 'R2' && /vendor-thing-1/.test(x.detail))) {
    fails.push('a container absent from committed compose was NOT flagged — R2 is not checking');
  }
  const exempted = JSON.parse(JSON.stringify(outOfRepo));
  exempted.hosts.h.compose_exempt_containers = [{ container: 'vendor-thing-1', reason: 'its compose lives in another repo' }];
  if (scan(exempted, GOOD_COMPOSE).some((x) => /vendor-thing-1/.test(x.detail))) {
    fails.push('a declared compose exemption did not suppress its own R2 finding');
  }
  // ...and it must suppress ONLY its own row.
  const exemptedPlusBad = JSON.parse(JSON.stringify(exempted));
  exemptedPlusBad.hosts.h.containers.push('another-missing-1');
  if (!scan(exemptedPlusBad, GOOD_COMPOSE).some((x) => x.rule === 'R2' && /another-missing-1/.test(x.detail))) {
    fails.push('the exemption suppressed a DIFFERENT container’s finding — it is not row-scoped');
  }
  const exemptRaw = (mutate) => {
    const c = JSON.parse(JSON.stringify(GOOD_CONTRACT));
    c.hosts.h.containers = ['postgres', 'vendor-thing-1'];
    c.hosts.h.compose_exempt_containers = [{ container: 'vendor-thing-1', reason: 'ok' }];
    mutate(c);
    return loadContract(JSON.stringify(c), now).ok;
  };
  if (!exemptRaw(() => {})) fails.push('a well-formed compose exemption failed to load');
  if (exemptRaw((c) => { delete c.hosts.h.compose_exempt_containers[0].reason; })) fails.push('an exemption with NO reason must not load');
  if (exemptRaw((c) => { c.hosts.h.compose_exempt_containers[0].reason = '  '; })) fails.push('an exemption with an ALL-WHITESPACE reason must not load');
  if (exemptRaw((c) => { c.hosts.h.compose_exempt_containers[0].container = 'not-declared'; })) fails.push('an exemption naming an undeclared container must not load');
  if (exemptRaw((c) => { c.hosts.h.compose_exempt_containers = { a: 1 }; })) fails.push('a non-array compose_exempt_containers must not load');

  // (f) FAIL-CLOSED on a broken / empty / stale contract
  if (loadContract('{not json', now).ok) fails.push('unparseable contract must not load');
  if (loadContract(JSON.stringify({ hosts: {} }), now).ok) fails.push('contract with no hosts must not load');
  if (loadContract(JSON.stringify({ hosts: { h: { units: [] } } }), now).ok) fails.push('contract with no units must not load');
  if (loadContract(JSON.stringify({ _TODO_revisit_by: '2020-01-01', hosts: { h: { units: [{ unit: 'a', activation: 'enabled' }] } } }), now).ok) {
    fails.push('a contract past its own revisit date must not load');
  }

  // (g) VACUITY GUARD: an empty compose corpus must be reported, never silently clean
  if (scan(GOOD_CONTRACT, []).length === 0) fails.push('an EMPTY compose corpus reported clean — vacuity guard missing');

  if (fails.length) {
    console.error('✖ self-test FAILED:');
    fails.forEach((f) => console.error('   - ' + f));
    return 'FAIL';
  }
  console.log('✓ self-test: happy path, 3 R1 must-fire, the 2 real-world false positives must-NOT-fire, 2 R2 must-fire, 3 compose-exemption must-fire/must-suppress/row-scoped, 5 exemption-shape fail-closed, 2 R3 must-fire, 4 fail-closed cases, vacuity guard.');
  return 'PASS';
}

function verdictAndExit(v) {
  console.log(`BOOT_READINESS_VERDICT=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

// ── main ─────────────────────────────────────────────────────────────────────
if (argv.includes('--self-test')) verdictAndExit(selfTest());

const st = selfTest();
if (st !== 'PASS') verdictAndExit(st); // a broken detector must never green-light the scan

if (!existsSync(CONTRACT)) {
  console.error(`✖ boot-survival contract missing at ${CONTRACT} — cannot decide, refusing to pass`);
  verdictAndExit('INDETERMINATE');
}
const loaded = loadContract(readFileSync(CONTRACT, 'utf8'), new Date());
if (!loaded.ok) {
  console.error(`✖ ${loaded.reason}`);
  verdictAndExit('INDETERMINATE');
}

const composeTexts = [];
for (const f of COMPOSE_FILES) {
  const p = join(ROOT, f);
  if (existsSync(p)) composeTexts.push(readFileSync(p, 'utf8'));
}
if (composeTexts.length === 0) {
  console.error('✖ no compose file readable — restart policies cannot be verified, refusing to pass');
  verdictAndExit('INDETERMINATE');
}

const findings = scan(loaded.contract, composeTexts);
const hostCount = Object.keys(loaded.contract.hosts).length;

// No silent caps: name every host whose restart policies this repo CANNOT enforce, and why.
for (const [host, h] of Object.entries(loaded.contract.hosts)) {
  if (h.compose_in_this_repo === false) {
    console.log(`\u2139 R2 NOT ENFORCED for ${host} (${(h.containers ?? []).length} container(s)) — ${h.compose_exemption_reason ?? 'no reason recorded'}`);
  }
  // NO SILENT CAPS: name every per-container exemption too, with its reason. A skipped check that
  // prints nothing is indistinguishable from a check that ran and passed.
  for (const e of h.compose_exempt_containers ?? []) {
    console.log(`\u2139 R2 NOT ENFORCED for ${host}/${e.container} — ${e.reason}`);
  }
}

if (findings.length) {
  console.error(`✖ ${findings.length} boot-readiness gap(s) across ${hostCount} host(s):`);
  for (const h of findings) console.error(`   - [${h.rule}] ${h.detail}`);
  verdictAndExit('FAIL');
}

console.log(`✓ boot readiness: ${loaded.unitCount} must-survive unit(s) across ${hostCount} host(s) declare a checkable activation rule; every declared container has an acceptable restart policy in committed compose; Postgres stop budget >= ${loaded.contract.postgres_stop_budget_seconds_min}s.`);
verdictAndExit('PASS');
