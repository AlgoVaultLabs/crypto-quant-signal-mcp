/**
 * OPS-PFE-PROBE-INDETERMINATE-W1 — the GATE that makes "a monitor HTTP probe
 * pages cycle-1 because the transient classifier cannot see its failure string"
 * structurally impossible.
 *
 * ## The incident this locks (2026-09-01, 4th of the class)
 *
 * `/var/log/algovault-monitor.log` 06:44:01Z paged
 *   `PFE check failed: performance-public HTTP 0 after 3 attempts`
 * at `consecutive=1`, and auto-recovered at 06:46. Nothing was wrong with the
 * win rate; `/api/performance-public` was healthy. The probe had aborted because
 * a cold `[perf-stats]` recompute took 69,744 ms against a 15 s per-attempt budget
 * (same 3 h window: n=96, p99 3,164 ms). WHY that one recompute was 28× p99 is a
 * separate, still-open question — see OPS-PERFPUBLIC-LATENCY-TAIL-W{NEXT}.
 *
 * The page itself, though, was a GENERATOR defect, not a latency defect.
 * `OPS-MONITOR-TRANSIENT-CLASSIFY-W1` exists precisely to floor a
 * could-not-measure failure to `TRANSIENT_MIN_CYCLES` — and its own header
 * names this very check as prior lane-fix #3. It did not fire, because
 * `extractHttpStatus` matched `\d{3}` and `HTTP 0` is ONE digit. `HTTP 0` is
 * not an exotic input: it is `fetchJson()`'s universal "the fetch threw"
 * sentinel and therefore the single most common failure string the monitor can
 * emit. The classifier's own suite tested the PFE shape with `HTTP 503` — a
 * status that path had produced twice in three weeks — and never with the
 * shape it produces on every abort.
 *
 * ## What makes this a GATE rather than a fixture
 *
 * G1 enumerates the alert REGISTRY, not a hand-written list, so a probe alert
 * added later is covered the day it is written. G2 asserts the registry is
 * complete with respect to the module's own exports, so the enumeration cannot
 * silently go stale. G3 forbids the inline `HTTP ${...}` alert template that
 * produced all three current call sites, so a 4th check cannot reintroduce an
 * unclassified string. G4 is the two-way half: a CONFIRMED breach must keep its
 * cycle-1 threshold, so the gate cannot be satisfied by classifying everything
 * transient.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alerts from '../../src/scripts/monitor-probe-alerts.js';
import {
  FETCH_THROW_STATUS,
  pfeProbeAlert,
  serverHealthProbeAlert,
  facilitatorProbeAlert,
} from '../../src/scripts/monitor-probe-alerts.js';

/**
 * The enumeration, taken from the MODULE'S OWN EXPORTS rather than a second
 * hand-kept list. The naming convention is the contract: any exported
 * `*ProbeAlert` is discovered here, so a probe alert added later is gated the day
 * it is written. (A registry array was tried first and correctly refused by
 * `check-dark-exports.mjs` — exported, tested, called by nothing in src/.)
 */
type ProbeAlertFn = (status: number, attempts: number, reason?: string | null) => string;
const HTTP_PROBE_ALERTS: readonly { key: string; format: ProbeAlertFn }[] =
  Object.entries(alerts)
    .filter(([n, v]) => n.endsWith('ProbeAlert') && typeof v === 'function')
    .map(([key, format]) => ({ key, format: format as ProbeAlertFn }));
import {
  classifyProbeFailure,
  effectiveFailThreshold,
  TRANSIENT_MIN_CYCLES,
} from '../../src/lib/probe-failure-class.js';
import { isReadablePerfBody, pfeReadVerdict, pfeUnreadableVerdict } from '../../src/scripts/monitor-pfe.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reasons `fetchJson()` actually surfaces when the fetch throws, verbatim from Node 20/22. */
const THROW_REASONS = [
  'TimeoutError: The operation was aborted due to timeout',
  'TypeError: fetch failed',
  'Error: connect ECONNREFUSED 127.0.0.1:3000',
  'Error: socket hang up',
  null, // a throw whose reason we could not compose — the string must STILL classify transient
];

describe('G1 — every registered HTTP probe alert is transient at the fetch-throw sentinel', () => {
  it('has a non-empty registry (a vacuous enumeration must not pass)', () => {
    expect(HTTP_PROBE_ALERTS.length).toBeGreaterThanOrEqual(3);
  });

  for (const alert of HTTP_PROBE_ALERTS) {
    for (const reason of THROW_REASONS) {
      it(`${alert.key} @ HTTP ${FETCH_THROW_STATUS} (reason: ${reason ?? 'none'}) classifies transient`, () => {
        const msg = alert.format(FETCH_THROW_STATUS, 3, reason);
        expect(msg, 'the sentinel must be visible in the operator-facing string').toContain(
          `HTTP ${FETCH_THROW_STATUS}`,
        );
        expect(classifyProbeFailure(msg), msg).toBe('transient');
        // …and the floor must actually reach the alerting decision, not just the label.
        expect(effectiveFailThreshold(1, msg), msg).toBe(TRANSIENT_MIN_CYCLES);
      });
    }
  }

  it('a real 5xx from the same formatters stays transient (no regression on the shape that DID work)', () => {
    for (const alert of HTTP_PROBE_ALERTS) {
      expect(classifyProbeFailure(alert.format(503, 3, null))).toBe('transient');
    }
  });

  it('surfaces the throw reason so the next incident is diagnosable from the monitor log alone', () => {
    const msg = pfeProbeAlert(FETCH_THROW_STATUS, 3, 'TimeoutError: The operation was aborted due to timeout');
    expect(msg).toContain('TimeoutError');
    expect(msg).toContain('aborted due to timeout');
  });
});

describe('G2 — the enumeration is discovered, not hand-kept', () => {
  it('picks up exactly the three live formatters, by convention', () => {
    expect(HTTP_PROBE_ALERTS.map((a) => a.key).sort()).toEqual(
      ['facilitatorProbeAlert', 'pfeProbeAlert', 'serverHealthProbeAlert'],
    );
    expect(HTTP_PROBE_ALERTS.map((a) => a.format)).toEqual(
      expect.arrayContaining([serverHealthProbeAlert, facilitatorProbeAlert, pfeProbeAlert]),
    );
  });

  it('a formatter added to the module is enumerated WITHOUT editing this file', () => {
    // The property the deleted registry was supposed to give, asserted directly:
    // discovery is by export name, so nothing can be added and silently uncovered.
    const fake = { extraProbeAlert: (s: number, a: number) => `x (HTTP ${s}) after ${a} attempts` };
    const discovered = Object.entries({ ...alerts, ...fake })
      .filter(([n, v]) => n.endsWith('ProbeAlert') && typeof v === 'function')
      .map(([n]) => n);
    expect(discovered).toContain('extraProbeAlert');
    expect(discovered.length).toBe(HTTP_PROBE_ALERTS.length + 1);
  });

  it('the enumeration is not vacuous', () => {
    expect(HTTP_PROBE_ALERTS.length).toBeGreaterThanOrEqual(3);
  });
});

describe('G3 — monitor.ts composes no inline HTTP-status alert string of its own', () => {
  it('every returned alert string carrying an HTTP status comes from the registry module', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/scripts/monitor.ts'), 'utf-8');
    // A `return`ed template literal that interpolates an HTTP status is exactly the
    // shape that produced all three unclassified strings. Console/log lines are fine.
    const offenders = src
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /return\s+[`{].*HTTP \$\{/.test(line) || /error:\s*`[^`]*HTTP \$\{/.test(line));
    expect(offenders, `inline HTTP alert templates found:\n${offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n')}`)
      .toEqual([]);
  });

  it('monitor.ts imports the registry module (the gate is not vacuous)', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/scripts/monitor.ts'), 'utf-8');
    expect(src).toMatch(/from '\.\/monitor-probe-alerts\.js'/);
  });
});

describe('G4 — two-way: a CONFIRMED breach keeps cycle-1 visibility', () => {
  it('a real win-rate drop is confirmed and still pages on the first cycle', () => {
    const breach = 'PFE win rate dropped to 83.0% (< 85%)';
    expect(classifyProbeFailure(breach)).toBe('confirmed');
    expect(effectiveFailThreshold(1, breach)).toBe(1);
  });

  it('a confirmed absence is not laundered into transient by the widened status parse', () => {
    expect(classifyProbeFailure('devto-http-404')).toBe('confirmed');
    expect(classifyProbeFailure('devto-http-410')).toBe('confirmed');
    expect(classifyProbeFailure('Backfill queue stuck: 61,000 pending (> 50,000)')).toBe('confirmed');
  });
});

/**
 * G5-G7 — OPS-PFE-PROBE-INDETERMINATE-W1 CH2: the two PFE verdicts travel on
 * SEPARATE channels.
 *
 * The false-negative this closes is not hypothetical arithmetic: `runCritical`
 * keys both `consecutiveFails` and the 30-minute `lastAlerted` dedup window on
 * the check key, so one UNREADABLE page would have swallowed a genuine
 * win-rate page for the next half hour — the single alert the check exists to
 * deliver.
 */
describe('G5 — exactly one verdict field is ever set', () => {
  it('a read endpoint yields a BREACH verdict and never an unreadable one', () => {
    const bad = pfeReadVerdict({ overall: { pfeWinRate: 0.83 } });
    expect(bad.breach).toBe('PFE win rate dropped to 83.0% (< 85%)');
    expect(bad.unreadable).toBeNull();
    expect(bad.rate).toBe(0.83);

    const good = pfeReadVerdict({ overall: { pfeWinRate: 0.9168 } });
    expect(good.breach).toBeNull();
    expect(good.unreadable).toBeNull();
  });

  it('an unread endpoint yields an UNREADABLE verdict and NEVER a win-rate claim', () => {
    const v = pfeUnreadableVerdict(pfeProbeAlert(FETCH_THROW_STATUS, 3, 'TimeoutError: aborted'));
    expect(v.unreadable).toContain('HTTP 0');
    // The load-bearing assertion: an unreadable probe must not touch the WR channel,
    // so it can neither advance its counter nor burn its dedup window.
    expect(v.breach).toBeNull();
    expect(v.rate).toBeNull();
  });

  it('mutual exclusivity holds across every representative input', () => {
    const verdicts = [
      pfeReadVerdict({ overall: { pfeWinRate: 0.9168 } }),
      pfeReadVerdict({ overall: { pfeWinRate: 0.83 } }),
      pfeReadVerdict({ overall: { pfeWinRate: null } }),
      pfeReadVerdict({}),
      pfeReadVerdict(null),
      pfeUnreadableVerdict(pfeProbeAlert(FETCH_THROW_STATUS, 3, null)),
      pfeUnreadableVerdict(pfeProbeAlert(503, 3, null)),
    ];
    for (const v of verdicts) {
      expect(v.breach === null || v.unreadable === null, JSON.stringify(v)).toBe(true);
    }
  });
});

describe('G6 — the channels are wired to distinct keys with distinct thresholds', () => {
  const src = () => fs.readFileSync(path.join(REPO, 'src/scripts/monitor.ts'), 'utf-8');

  it('both keys exist in FAIL_THRESHOLDS and pfe_probe is sustained-only', () => {
    const s = src();
    expect(s).toMatch(/pfe_winrate:\s*1\b/);
    const m = s.match(/pfe_probe:\s*(\d+)/);
    expect(m, 'pfe_probe must have its own threshold').not.toBeNull();
    expect(Number(m![1]), 'a could-not-measure channel must never page cycle-1').toBeGreaterThanOrEqual(2);
  });

  it('runCritical registers both channels off ONE memoised probe', () => {
    const s = src();
    expect(s).toMatch(/\['pfe_winrate', async \(\) => \(await pfeOnce\(\)\)\.breach\]/);
    expect(s).toMatch(/\['pfe_probe', async \(\) => \(await pfeOnce\(\)\)\.unreadable\]/);
    // One fetch per cycle: the probe is already the dominant driver of the
    // recompute it fails to read; evaluating it twice would double that.
    expect((s.match(/await checkPfeWinRate\(\)/g) ?? []).length).toBe(1);
  });
});

describe('G7 — the unreadable channel is not silent (no dark guard)', () => {
  it('a SUSTAINED unreadable endpoint still pages, on its own channel', () => {
    const alert = pfeUnreadableVerdict(
      pfeProbeAlert(FETCH_THROW_STATUS, 3, 'TimeoutError: The operation was aborted due to timeout'),
    ).unreadable!;
    // transient ⇒ floored to TRANSIENT_MIN_CYCLES, but pfe_probe's own threshold is
    // higher, and effectiveFailThreshold takes the MAX — so it pages at 3, not never.
    expect(effectiveFailThreshold(3, alert)).toBe(3);
    expect(classifyProbeFailure(alert)).toBe('transient');
    // …and the body names the cause, so the page is actionable on arrival.
    expect(alert).toContain('performance-public');
    expect(alert).toContain('aborted due to timeout');
  });
});

/**
 * G8-G11 — OPS-PFE-PROBE-INDETERMINATE-W1 CH3: a 200 we could not READ is
 * UNREADABLE, never CLEAN.
 *
 * The page that fired on 2026-09-01 and a silent clean verdict are two coin-flips
 * of the SAME 69.7 s event. Abort before headers ⇒ throw ⇒ `HTTP 0` ⇒ the page.
 * Abort mid-way through the 568 KB body ⇒ `res.json()` rejects ⇒ the old
 * `.catch(() => null)` returned `{ ok: true, status: 200, data: null }` ⇒
 * `evaluatePfeWinRate(null)` ⇒ `error: null` ⇒ `runCritical` logs `auto-recovered`
 * and resets the counter. Silent, clean, and wrong — "exit 0 encoding both
 * 'verified, clean' and 'verified nothing'" in one return statement.
 */
describe('G8 — a structurally unreadable body is not adjudicable', () => {
  it('rejects the shapes an aborted or malformed body actually produces', () => {
    for (const bad of [null, undefined, 'not json', 42, [], {}, { overall: null }, { overall: 'nope' }]) {
      expect(isReadablePerfBody(bad), JSON.stringify(bad) ?? 'undefined').toBe(false);
    }
  });

  it('accepts a well-formed body — INCLUDING one honestly reporting no matured data', () => {
    expect(isReadablePerfBody({ overall: { pfeWinRate: 0.9168 } })).toBe(true);
    // The documented "unknown rate is not a drop" rule must survive CH3 untouched:
    // a present `overall` with a null rate is READ, and read-and-unknown is clean.
    expect(isReadablePerfBody({ overall: { pfeWinRate: null } })).toBe(true);
    const v = pfeReadVerdict({ overall: { pfeWinRate: null } });
    expect(v.breach).toBeNull();
    expect(v.unreadable).toBeNull();
    expect(v.rate).toBeNull();
  });
});

describe('G9 — the unread-body reason classifies transient through the shared lexicon', () => {
  it('a body-read failure never pages cycle-1', () => {
    for (const reason of [
      'parse-error: TypeError: terminated',
      'parse-error: SyntaxError: Unexpected end of JSON input',
      'parse-error: body has no `overall` block (unreadable, not clean)',
    ]) {
      const alert = pfeProbeAlert(200, 3, reason);
      // NB: 200 is NOT transient by the numeric leg — the `parse-error` token is what
      // carries it. That is the defence-in-depth CH1 installed, doing real work here.
      expect(classifyProbeFailure(alert), alert).toBe('transient');
      expect(effectiveFailThreshold(1, alert)).toBe(TRANSIENT_MIN_CYCLES);
    }
  });
});

describe('G10 — the probe does not adjudicate on `ok` alone', () => {
  const src = () => fs.readFileSync(path.join(REPO, 'src/scripts/monitor.ts'), 'utf-8');

  it('the PFE read is gated on parse success AND body shape, not just `ok`', () => {
    const s = src();
    expect(s).toMatch(/if \(ok && !parseError && isReadablePerfBody\(data\)\) return pfeReadVerdict\(data\);/);
    // The bare form is the defect. It must not come back.
    expect(s).not.toMatch(/if \(ok\) return pfeReadVerdict\(data\);/);
  });

  it('fetchJson reports the body-read failure instead of swallowing it', () => {
    // Scoped to fetchJson's body ON PURPOSE. `checkGasWallet` uses the same
    // discard-and-substitute-null form legitimately at monitor.ts:354 — its
    // `parseGasBalanceResult` handles a null explicitly, which is the whole point of
    // "never coerce a missing RPC result to 0 ETH" (d8164113). A repo-wide ban would
    // fail on that correct call site and teach the next reader to delete the gate.
    const s = src();
    const start = s.indexOf('async function fetchJson(');
    expect(start, 'fetchJson must exist for this gate to mean anything').toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf('\n}', start));
    expect(body).not.toMatch(/\.catch\(\(\) => null\)/);
    expect(body).toMatch(/parseError/);
    expect(body).toMatch(/parseError: string \| null/);
  });
});

/**
 * G11 — OPS-PFE-PROBE-INDETERMINATE-W1 CH4: the PFE probe takes ONE observation
 * per cycle.
 *
 * The removed 3×15 s loop was a non-control that read as a control:
 * `perfStatsInflight` is keyed by bucket and cleared only on settle, so attempts 2
 * and 3 awaited the SAME promise attempt 1 started. Three aborts of one observation.
 * Reintroducing it would restore ~55 s of serial wall-clock inside a 120 s cron
 * period and buy no additional probability, so the gate refuses it rather than
 * relying on a comment — the prior comment IS what this replaces.
 *
 * `checkServerHealth` and `checkFacilitator` keep their loops on purpose: those
 * probes hit `/health` and the facilitator, share no in-flight promise, and their
 * attempts are genuinely independent draws.
 */
describe('G11 — one observation per cycle, and the sustained gate does the rest', () => {
  const pfeBody = () => {
    const s = fs.readFileSync(path.join(REPO, 'src/scripts/monitor.ts'), 'utf-8');
    const start = s.indexOf('async function checkPfeWinRate(');
    expect(start, 'checkPfeWinRate must exist for this gate to mean anything').toBeGreaterThan(-1);
    return s.slice(start, s.indexOf('\n}\n', start));
  };

  it('checkPfeWinRate fetches exactly once and has no retry loop', () => {
    const body = pfeBody();
    expect((body.match(/await fetchJson\(/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/for \(let attempt/);
    expect(body).not.toMatch(/MAX_ATTEMPTS/);
    expect(body).not.toMatch(/RETRY_DELAY_MS/);
  });

  it('the genuinely-independent probes KEEP their retries (this is not a blanket ban)', () => {
    const s = fs.readFileSync(path.join(REPO, 'src/scripts/monitor.ts'), 'utf-8');
    for (const fn of ['checkServerHealth', 'checkFacilitator']) {
      const start = s.indexOf(`async function ${fn}(`);
      const body = s.slice(start, s.indexOf('\n}\n', start));
      expect(body, `${fn} must keep its independent-sample retry`).toMatch(/for \(let attempt/);
    }
  });

  it('the unreadable alert honestly reports ONE attempt', () => {
    const body = pfeBody();
    expect(body).toMatch(/pfeProbeAlert\(status, 1, why\)/);
    expect(pfeProbeAlert(FETCH_THROW_STATUS, 1, 'TimeoutError: aborted')).toContain('after 1 attempts');
  });
});
