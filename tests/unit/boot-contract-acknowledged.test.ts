/**
 * OPS-BOOT-CONTRACT-WIDEN-W1 — every live container is RULED ON, so the canary's undeclared
 * REPORT line can reach ZERO and stay there.
 *
 * WHY THIS FILE EXISTS AT ALL. `ops/monitoring/boot-contract-canary.sh` shipped reporting SEVEN
 * undeclared-but-live containers on every run, on both hosts, forever. A REPORT line that can
 * never reach zero is not a signal — it is background noise, and it trains every future reader to
 * skip the list that the first genuinely new container will land in. The fix is not "declare
 * seven more containers": it is to make the undeclared set REACHABLE to zero and kept there, in
 * both directions, so a non-empty one means "a container appeared that nobody has ruled on".
 *
 * THE TRAP THIS FILE IS THE STANDING PROOF AGAINST. `projectContract()` copies an EXPLICIT
 * WHITELIST of per-host keys into `ops/monitoring/boot-contract.json`, which is the ONLY copy
 * either host ever reads. A new per-host key that is not added to that whitelist is dropped
 * SILENTLY while `--check` still prints `BOOT_CONTRACT_PARITY_VERDICT=PASS` — source and
 * projection genuinely agree, because the field never entered the derivation. Measured on a
 * scratch copy 2026-08-28: a `_throwaway_probe_key` under `hosts['signal-1']` was absent from the
 * projection at verdict PASS, exit 0. So the whole wave could have shipped dark with every gate
 * green. `acknowledgedSurvivesTheRoundTrip` below is the assertion that says it did not, and the
 * one that must never be deleted.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  readFileSync, mkdtempSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SOT = path.join(ROOT, 'scripts/data/boot-critical-units.json');
const PROJECTION = path.join(ROOT, 'ops/monitoring/boot-contract.json');
const CANARY = path.join(ROOT, 'ops/monitoring/boot-contract-canary.sh');

type Ack = { container: string; reason: string };
type Host = {
  address: string;
  containers: string[];
  acknowledged_containers?: Ack[];
  compose_exempt_containers?: Ack[];
};

const sot = JSON.parse(readFileSync(SOT, 'utf8')) as { hosts: Record<string, Host> };
const projection = JSON.parse(readFileSync(PROJECTION, 'utf8')) as { hosts: Record<string, Host> };

/** Drive the canary end-to-end against a fixture contract with stubbed systemctl/docker. */
function runCanary(opts: { contract: unknown; live: string[] }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'boot-contract-ack-'));
  try {
    const contractPath = path.join(dir, 'contract.json');
    writeFileSync(contractPath, JSON.stringify(opts.contract));
    const systemctl = path.join(dir, 'systemctl');
    writeFileSync(systemctl, '#!/usr/bin/env bash\n[ "$1" = "is-enabled" ] || exit 1\necho enabled\n', { mode: 0o755 });
    const docker = path.join(dir, 'docker');
    // The live set goes through a QUOTED heredoc, not an interpolated printf: a `\n` inside a
    // single-quoted bash string stays two literal characters, and the first draft of this stub
    // emitted one container literally named `must-1\n`. The heredoc carries real newlines.
    writeFileSync(
      docker,
      '#!/usr/bin/env bash\n'
      + 'if [ "$1" = "ps" ]; then\n'
      + "cat <<'ALGOVAULT_PS_EOF'\n"
      + opts.live.map((n) => `${n}\n`).join('')
      + 'ALGOVAULT_PS_EOF\n'
      + 'exit 0\nfi\n'
      + 'if [ "$1" = "inspect" ]; then echo unless-stopped; exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    );
    return execFileSync('bash', [CANARY], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOOT_CONTRACT_FILE: contractPath,
        // A FRESH state file per run: the first cycle is report-only by design, which is what
        // keeps this suite from ever reaching the fire path.
        BOOT_CONTRACT_STATE: path.join(dir, 'seen'),
        BOOT_CONTRACT_LOG: '/dev/null',
        BOOT_CONTRACT_SYSTEMCTL: systemctl,
        BOOT_CONTRACT_DOCKER: docker,
        BOOT_CONTRACT_WRAPPER: path.join(dir, 'no-such-wrapper'),
        MONITORING_HOST_LABELS: 'h',
        // Never let a real page escape a unit test, belt-and-braces on top of the absent wrapper.
        ALGOVAULT_TG_TEST_INERT: '1',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fixture = (hostOverrides: Partial<Host>) => ({
  revisit_by: '2099-01-01',
  acceptable_restart_policies: ['always', 'unless-stopped'],
  postgres_stop_budget_seconds_min: 30,
  hosts: {
    h: {
      address: '10.0.0.1',
      units: [{ unit: 'docker.service', activation: 'enabled' }],
      containers: [],
      ...hostOverrides,
    },
  },
});

describe('boot contract — the acknowledged ruling survives to the host', () => {
  it('acknowledgedSurvivesTheRoundTrip: every host carries the key into the projection', () => {
    // The R0.3 trap, asserted DIRECTLY on the emitted artifact rather than inferred from a PASS
    // verdict — a PASS is exactly what the trap produces.
    for (const [label, h] of Object.entries(projection.hosts)) {
      expect(h, `${label} lost acknowledged_containers in the projection`).toHaveProperty('acknowledged_containers');
      expect(Array.isArray(h.acknowledged_containers), `${label} acknowledged_containers is not an array`).toBe(true);
    }
  });

  it('carries the same rows, byte-for-byte, as the SoT declares', () => {
    for (const [label, h] of Object.entries(sot.hosts)) {
      const want = (h.acknowledged_containers ?? []).map((a) => ({ container: a.container, reason: a.reason }));
      expect(projection.hosts[label].acknowledged_containers).toEqual(want);
    }
  });

  it('does NOT project compose_exempt_containers — build-time only, and that is a decision', () => {
    // The counter-example that keeps "not projected" honest: this key is read by
    // check-boot-readiness.mjs alone, and the canary asserts live policy via `docker inspect`
    // instead. If it ever becomes a host decision input it must be added to the whitelist.
    expect(sot.hosts['signal-1'].compose_exempt_containers?.length).toBeGreaterThan(0);
    for (const h of Object.values(projection.hosts)) {
      expect(h).not.toHaveProperty('compose_exempt_containers');
    }
  });
});

describe('boot contract — the committed rulings are internally coherent', () => {
  it('every acknowledged row carries a non-empty reason', () => {
    for (const [label, h] of Object.entries(sot.hosts)) {
      for (const a of h.acknowledged_containers ?? []) {
        expect(typeof a.reason, `${label}/${a.container}`).toBe('string');
        expect(a.reason.trim().length, `${label}/${a.container} has an empty reason`).toBeGreaterThan(0);
      }
    }
  });

  it('no container is both must-survive and acknowledged', () => {
    for (const [label, h] of Object.entries(sot.hosts)) {
      const must = new Set(h.containers);
      for (const a of h.acknowledged_containers ?? []) {
        expect(must.has(a.container), `${label}/${a.container} is in BOTH lists`).toBe(false);
      }
    }
  });

  it('every acknowledged reason names the mechanism that covers the container', () => {
    // Not decoration. `aoe-prefect-worker` is covered by aoe-supervisor's SPINE_CONTAINERS
    // (detect-only paging) while the three `autonomous-optimizer-*` rows are covered by the
    // _AOE_CONTAINER_NAME_FILTER prefix (auto-restart) — and the worker does NOT match that
    // prefix. Collapsing the two into one sentence hides that the prefix filter alone would leave
    // the executor of every AOE flow uncovered.
    const aoe = sot.hosts['aoe-1'].acknowledged_containers ?? [];
    const byName = Object.fromEntries(aoe.map((a) => [a.container, a.reason]));
    expect(byName['aoe-prefect-worker']).toContain('SPINE_CONTAINERS');
    for (const n of [
      'autonomous-optimizer-promotion-scanner-1',
      'autonomous-optimizer-mcp-server-1',
      'autonomous-optimizer-dashboard-internal-1',
    ]) {
      expect(byName[n], `${n} must name the prefix filter`).toContain('_AOE_CONTAINER_NAME_FILTER');
      // BOTH links of the chain: the recovering agent must be named, and it must itself be
      // declared must-survive, or a future wave demoting it cannot see this blast radius.
      expect(byName[n], `${n} must name the recovering agent`).toContain('aoe-supervisor');
    }
    expect(sot.hosts['aoe-1'].containers).toContain('aoe-supervisor');
  });
});

describe('boot contract — the canary reconciles in both directions', () => {
  it('undeclared REACHES ZERO when every live container is ruled on', () => {
    const out = runCanary({
      contract: fixture({
        containers: ['must-1'],
        acknowledged_containers: [{ container: 'ack-1', reason: 'not boot-critical' }],
      }),
      live: ['must-1', 'ack-1'],
    });
    expect(out).toContain('REPORT undeclared_containers=0');
    expect(out.trim().split('\n').pop()).toBe('BOOT_CONTRACT_VERDICT=OK');
  });

  it('an unruled live container is REPORTED — and never DRIFT', () => {
    const out = runCanary({
      contract: fixture({ containers: ['must-1'] }),
      live: ['must-1', 'nobody-ruled-on-me'],
    });
    expect(out).toContain('REPORT undeclared_containers=1');
    expect(out).toContain('nobody-ruled-on-me');
    // The contract is the authority on what MUST survive; a container it does not name is a
    // coverage gap, not a violation. This is the assertion that keeps it out of the page path.
    expect(out.trim().split('\n').pop()).toBe('BOOT_CONTRACT_VERDICT=OK');
  });

  it('acknowledged_but_absent FIRES when an acknowledged row goes stale', () => {
    const out = runCanary({
      contract: fixture({
        containers: [],
        acknowledged_containers: [{ container: 'ack-gone', reason: 'was here once' }],
      }),
      live: ['unrelated-1'],
    });
    expect(out).toContain('REPORT acknowledged_but_absent=1');
    expect(out).toContain('ack-gone');
    expect(out.trim().split('\n').pop()).toBe('BOOT_CONTRACT_VERDICT=OK');
  });

  it('both counts print as explicit zeros — a clean compare never reads as silence', () => {
    const out = runCanary({
      contract: fixture({ containers: ['must-1'] }),
      live: ['must-1'],
    });
    expect(out).toContain('REPORT undeclared_containers=0');
    expect(out).toContain('REPORT acknowledged_but_absent=0');
  });

  it('an EMPTY reason is INDETERMINATE, never a silent pass', () => {
    const out = runCanary({
      contract: fixture({
        containers: [],
        acknowledged_containers: [{ container: 'ack-1', reason: '' }],
      }),
      live: ['ack-1'],
    });
    expect(out.trim().split('\n').pop()).toBe('BOOT_CONTRACT_VERDICT=INDETERMINATE');
  });

  it('a name in BOTH lists is INDETERMINATE — "could not decide", never "the host drifted"', () => {
    const out = runCanary({
      contract: fixture({
        containers: ['both-1'],
        acknowledged_containers: [{ container: 'both-1', reason: 'contradicts the line above' }],
      }),
      live: ['both-1'],
    });
    expect(out.trim().split('\n').pop()).toBe('BOOT_CONTRACT_VERDICT=INDETERMINATE');
  });
});
