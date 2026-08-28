/**
 * OPS-CLIENT-CLAIM-FRESHNESS-W1 CH2 — the canary's token grammar and exit-code contract,
 * pinned CROSS-LANGUAGE.
 *
 * `ops/monitoring/client-claim-freshness.py` is a Python canary whose callers are shell: the
 * cron line, and every gate block that greps its verdict. Nothing in the TypeScript tree can
 * import it, so the only honest way to pin its contract is to RUN it and read what it emits.
 *
 * Why this file exists at all, given the canary already has a 47-assertion `--self-test`:
 * a hermetic self-test is structurally blind to exactly what its own seam replaces. It asserts
 * `_token_exit_map()` as DATA; it never proves `main()` actually returns those codes, nor that
 * the token reaches stdout exactly once, line-anchored, on every path. Those are the two facts
 * every caller depends on, and they are the ones a refactor silently breaks.
 *
 * It also closes a gap in the estate's own coverage, stated rather than assumed:
 * `scripts/check-alert-recommended-wave.mjs` scans a HAND-MAINTAINED file list that contains no
 * Python canaries — its header names `OPS-ALERT-WAVE-GATE-PY-COVERAGE-W{NEXT}` as the wave that
 * would close that centrally, and asks each Python canary to assert the property itself in the
 * meantime. The templated-wave block below is this canary discharging that.
 *
 * SPAWN BUDGET DECLARED — every block here shells out to `python3`, and
 * `scripts/check-test-budget.mjs` blocks a spawning block that declares none. The budget sits in
 * the OPTIONS ARG, never as a trailing number: the gate reads `timeout:` from the text BEFORE
 * the callback, so `it(name, fn, 20_000)` declares nothing.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const PY = path.join(REPO, 'ops/monitoring/client-claim-freshness.py');
const SRC = readFileSync(PY, 'utf8');

const TOKEN = 'CLIENT_CLAIM_FRESHNESS_VERDICT';
const ALERT_ID = 'CLIENT_CLAIM_DRIFT';

/** Every line that IS a terminal verdict token — anchored at column 0, nothing before it. */
function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
}

/**
 * Drive the SHIPPED `main()` with its two effects stubbed. This is the point of the file: the
 * self-test never calls main(), so the token print and the exit-code mapping are only ever
 * exercised here.
 */
function runMain(fetchPy: string, extraEnv: Record<string, string> = {}) {
  const code = [
    'import importlib.util, sys, json',
    `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    fetchPy,
    'm.scope_packages = lambda scope: ({}, True)',
    'm.fire = lambda body: None',
    'm.clear = lambda reason: None',
    'm.write_state = lambda t, n: None',
    'sys.exit(m.main())',
  ].join('\n');
  return spawnSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, CLIENT_CLAIM_TODAY: '2026-08-28', ...extraEnv },
  });
}

/** A synthetic committed-SoT body: `n` rows, all `native`, all stamped `stamp`. */
function fakeSot(n: number, stamp: string): string {
  return Array.from({ length: n }, (_, i) =>
    `    {\n      slug: 'row${i}',\n      kind: 'native',\n` +
    `      source: 'https://example.test/row${i}',\n      verifiedAt: '${stamp}',\n    },\n`,
  ).join('');
}

/** Stub `fetch`: the raw-SoT URL yields `sot`; every other URL yields an MCP-evidencing page. */
function fetcher(sot: string, sourceStatus = 200): string {
  return [
    `SOT = ${JSON.stringify(sot)}`,
    'def _f(url, timeout=30):',
    '    if "raw.githubusercontent.com" in url:',
    '        return 200, SOT, ""',
    `    return ${sourceStatus}, "mcp mcp mcp", ""`,
    'm.fetch = _f',
  ].join('\n');
}

describe('client-claim-freshness — verdict token grammar', () => {
  it('the --self-test emits EXACTLY ONE token line and exits 0', { timeout: 60_000 }, () => {
    const r = spawnSync('python3', [PY, '--self-test'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const lines = tokenLines(r.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${TOKEN}=PASS`);
    expect(r.stdout).toMatch(/^SELF-TEST: PASS \(\d+ check\(s\) ran, floor \d+, 0 failure\(s\)\)$/m);
  });

  it('the token grammar admits exactly three values', { timeout: 20_000 }, () => {
    // The vocabulary is asserted against the SHIPPED mapping, not against a copy in this file.
    const r = spawnSync('python3', ['-c', [
      'import importlib.util',
      `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'import json; print(json.dumps(m._token_exit_map()))',
    ].join('\n')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ PASS: 0, FAIL: 0, INDETERMINATE: 3 });
  });
});

describe('client-claim-freshness — exit-code contract, through the real main()', () => {
  it('PASS exits 0 and prints one token', { timeout: 30_000 }, () => {
    const r = runMain(fetcher(fakeSot(11, '2026-08-05')));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
  });

  it('FAIL exits 0 — the alert IS the action, so a finding must not bounce the cron line',
    { timeout: 30_000 }, () => {
      const r = runMain(fetcher(fakeSot(11, '2020-01-01')));   // every row far past 150d
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    });

  it('INDETERMINATE exits 3 when the SoT is unreadable — verified NOTHING never reads as clean',
    { timeout: 30_000 }, () => {
      const r = runMain([
        'def _f(url, timeout=30): return 503, "", ""',
        'm.fetch = _f',
      ].join('\n'));
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    });

  it('a truncated parse is INDETERMINATE, not a clean PASS over three rows',
    { timeout: 30_000 }, () => {
      const r = runMain(fetcher(fakeSot(3, '2026-08-05')));
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    });

  it('an unreachable per-row source degrades to INDETERMINATE, never to PASS',
    { timeout: 30_000 }, () => {
      const r = runMain(fetcher(fakeSot(11, '2026-08-05'), 503));
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    });

  it('EVERY exit path emits exactly one token line — no path is silent, none doubles up',
    { timeout: 60_000 }, () => {
      const runs = [
        runMain(fetcher(fakeSot(11, '2026-08-05'))),
        runMain(fetcher(fakeSot(11, '2020-01-01'))),
        runMain('def _f(url, timeout=30): return 503, "", ""\nm.fetch = _f'),
      ];
      for (const r of runs) expect(tokenLines(r.stdout)).toHaveLength(1);
      // …and the three runs are not all the same verdict, or the assertion above is vacuous.
      expect(new Set(runs.map((r) => tokenLines(r.stdout)[0])).size).toBe(3);
    });
});

describe('client-claim-freshness — declarations the rest of the estate reads', () => {
  it('ALERT_ID is a module-level literal, which is what check-alert-registry.mjs matches', () => {
    // Its SHAPE 1 is /\bALERT_ID\s*=\s*"?([A-Za-z][A-Za-z0-9_-]{3,})"?/m. Its SHAPE 3 anchors on
    // a variable literally named `TG`; this canary uses the `WRAPPER` idiom, which SHAPE 3 does
    // not match — so the module-level literal is the ONLY thing keeping the id enumerable.
    expect(SRC).toMatch(new RegExp(`^ALERT_ID = "${ALERT_ID}"$`, 'm'));
  });

  it('the recommended wave is TEMPLATED W{NEXT}, never a literal wave number', () => {
    // check-alert-recommended-wave.mjs scans a hand-maintained list carrying no Python canaries
    // (its header defers that to OPS-ALERT-WAVE-GATE-PY-COVERAGE-W{NEXT} and asks each Python
    // canary to assert the property itself). This is that assertion.
    expect(SRC).toContain('LANDING-{VENDOR}-CLIENT-SURFACE-W{{NEXT}}');
    // Scoped to the TEMPLATE CONSTANT, not to the rest of the file. The ban is on emitting a
    // literal wave number as an Action line; CITING the wave that made a change is how every
    // correction in this estate is written, and a whole-remainder ban fails on the canary's own
    // correction record (VENDOR_SCOPE_REASON names LANDING-DSH-CLIENT-SURFACE-W1 as history).
    // Same over-broad-regex defect the canary's own --self-test hit on the same day.
    const template = SRC.split('RECOMMENDED_WAVE = ')[1].split('\n')[0];
    expect(template).not.toMatch(/-W\d+/);
  });

  it('the CORPUS uses declaration-sync.sh\'s name|path|fields idiom', () => {
    const line = SRC.match(/^\s*"(mcp-clients\|[^"]+)",$/m)?.[1];
    expect(line).toBeDefined();
    expect(line!.split('|')).toEqual([
      'mcp-clients', 'src/lib/integrations-data/mcp-clients.ts', 'kind,source,verifiedAt',
    ]);
  });

  it('the SoT is read from the committed ref with a cache-buster, never a bare branch path', () => {
    // raw.githubusercontent.com is CDN-cached at max-age=300 in BOTH ref forms. The ref form is
    // not a freshness control and never was; the cache-buster is.
    expect(SRC).toContain('RAW_REF = "refs/heads/main"');
    expect(SRC).toMatch(/\?cb=%s/);
  });

  it('the age threshold is 150d and its justification travels with it', () => {
    // A number with no recorded derivation gets widened by the next wave that finds it noisy.
    expect(SRC).toContain('os.environ.get("CLIENT_CLAIM_AGE_DAYS", "150")');
    expect(SRC).toContain('AGE THRESHOLD: 150 DAYS, AND WHY NOT THE SPEC\'S 120');
  });

  it('the --clear invocation passes /dev/null on stdin', () => {
    // A wrapper left reading stdin hung a real cron run.
    const clearFn = SRC.split('def clear(')[1].split('\ndef ')[0];
    expect(clearFn).toContain('os.devnull');
    expect(clearFn).toContain('--clear');
  });
});
