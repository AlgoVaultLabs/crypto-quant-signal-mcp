/**
 * client-claim-freshness.py — the canary's token grammar and exit-code contract, pinned
 * CROSS-LANGUAGE (OPS-CLIENT-CLAIM-FRESHNESS-W1 CH2; rebuilt for v2 by OPS-CLIENT-CLAIM-EVIDENCE-W1 CH2).
 *
 * `ops/monitoring/client-claim-freshness.py` is a Python canary whose callers are shell: the
 * cron line, and every gate block that greps its verdict. Nothing in the TypeScript tree can
 * import it, so the only honest way to pin its contract is to RUN it and read what it emits.
 *
 * Why this file exists at all, given the canary has its own `--self-test`: a hermetic self-test
 * is structurally blind to exactly what its own seam replaces. It asserts `_token_exit_map()` as
 * DATA; it never proves `main()` actually returns those codes, nor that the token reaches stdout
 * exactly once, line-anchored, on every path. Those are the two facts every caller depends on.
 *
 * v2 reads a GENERATED JSON corpus (src/lib/integrations-data/claim-evidence.json) instead of
 * regex-parsing the TypeScript rows, so the fixtures here are JSON documents whose anchors the
 * stubbed pages either evidence or do not — and the identifiers the canary and the TS contract
 * both cite (corpus name, path) are locked against each other below.
 *
 * It also discharges a gap stated by `scripts/check-alert-recommended-wave.mjs`: that gate scans
 * a HAND-MAINTAINED list containing no Python canaries and asks each one to assert the property
 * itself (`OPS-ALERT-WAVE-GATE-PY-COVERAGE-W{NEXT}` would close it centrally).
 *
 * SPAWN BUDGET DECLARED — every block here shells out to `python3`, and
 * `scripts/check-test-budget.mjs` blocks a spawning block that declares none. The budget sits in
 * the OPTIONS ARG, never as a trailing number: the gate reads `timeout:` from the text BEFORE
 * the callback, so `it(name, fn, 20_000)` declares nothing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLAIM_EVIDENCE_CORPUS, CLAIM_EVIDENCE_JSON } from '../../src/lib/integrations-data/claim-evidence.js';

const REPO = path.resolve(__dirname, '../..');
const PY = path.join(REPO, 'ops/monitoring/client-claim-freshness.py');
const SRC = readFileSync(PY, 'utf8');

const TOKEN = 'CLIENT_CLAIM_FRESHNESS_VERDICT';
const ALERT_ID = 'CLIENT_CLAIM_DRIFT';

const TMP = mkdtempSync(path.join(tmpdir(), 'ccf-test-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Every line that IS a terminal verdict token — anchored at column 0, nothing before it. */
function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
}

/**
 * Drive the SHIPPED `main()` with its effects stubbed. The self-test never calls main(), so the
 * token print and the exit-code mapping are only ever exercised here. `statePath` is a file the
 * run may READ (confirmations); writes are stubbed so no run can leak state into the next.
 */
function runMain(fetchPy: string, opts: { state?: object } = {}) {
  const statePath = path.join(TMP, `state-${Math.random().toString(36).slice(2)}.json`);
  if (opts.state) writeFileSync(statePath, JSON.stringify(opts.state));
  const code = [
    'import importlib.util, sys, json',
    `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    fetchPy,
    'm.scope_packages = lambda scope: ({}, True)',
    'm.fire = lambda body: None',
    'm.clear = lambda reason: None',
    'm.write_state = lambda *a: None',
    'sys.exit(m.main())',
  ].join('\n');
  return spawnSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLIENT_CLAIM_TODAY: '2026-09-29',
      CLIENT_CLAIM_STATE: statePath,
      CLIENT_CLAIM_LOG: path.join(TMP, 'run.log'),
    },
  });
}

/** A synthetic generated corpus: `n` rows stamped `stamp`, each with one anchor on its own page. */
function fakeCorpus(n: number, stamp: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    _generated_by: 'test',
    schema_version: 1,
    corpus: 'mcp-clients',
    rows: Array.from({ length: n }, (_, i) => ({
      slug: `row${i}`,
      kind: 'native',
      verifiedAt: stamp,
      source: `https://example.test/row${i}`,
      evidence: [{ claim: 'fixture add --flag', source: `https://example.test/page/row${i}`, expect: ['fixture add'] }],
    })),
    ...overrides,
  });
}

/**
 * Stub `fetch` (v2 returns a 4-tuple: http, body, note, final_url). The raw-SoT URL yields
 * `corpus`; `pages` maps a URL fragment to [status, body]; everything else evidences the anchor.
 */
function fetcher(corpus: string, pages: Record<string, [number, string]> = {}): string {
  return [
    `SOT = ${JSON.stringify(corpus)}`,
    `PAGES = ${JSON.stringify(pages)}`,
    'def _f(url, timeout=30):',
    '    if "raw.githubusercontent.com/AlgoVaultLabs" in url:',
    '        return 200, SOT, "", url',
    '    for frag, resp in PAGES.items():',
    '        if frag in url:',
    '            return resp[0], resp[1], "", url',
    '    return 200, "<p>fixture add --flag</p>", "", url',
    'm.fetch = _f',
  ].join('\n');
}

describe('client-claim-freshness — verdict token grammar', () => {
  it('the --self-test emits EXACTLY ONE token line and exits 0', { timeout: 120_000 }, () => {
    const r = spawnSync('python3', [PY, '--self-test'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const lines = tokenLines(r.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${TOKEN}=PASS`);
    expect(r.stdout).toMatch(/^SELF-TEST: PASS \(\d+ check\(s\) ran, floor \d+, 0 failure\(s\)\)$/m);
  });

  it('the token grammar admits exactly three values', { timeout: 20_000 }, () => {
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
  it('PASS exits 0 when every anchor is evidenced — even on rows whose human stamp is ancient',
    { timeout: 30_000 }, () => {
      // The whole point of v2: a 2020 verifiedAt is not a finding when the claim is confirmed today.
      const r = runMain(fetcher(fakeCorpus(12, '2020-01-01')));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
      expect(r.stdout).toMatch(/state=confirmed/);
    });

  it('FAIL exits 0 on a CONTRADICTED anchor — the alert IS the action', { timeout: 30_000 }, () => {
    const r = runMain(fetcher(fakeCorpus(12, '2026-09-01'), { 'page/row3': [200, '<p>nothing here</p>'] }));
    expect(r.status, r.stderr).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.stdout).toMatch(/slug=row3 .*state=contradicted/);
    expect(r.stdout).toMatch(/missing on source: "fixture add"/);
  });

  it('FAIL exits 0 on a STALE row: never confirmed, unreachable today, human stamp past 150 d',
    { timeout: 30_000 }, () => {
      const r = runMain(fetcher(fakeCorpus(12, '2026-09-01').replace(
        '"slug":"row5","kind":"native","verifiedAt":"2026-09-01"',
        '"slug":"row5","kind":"native","verifiedAt":"2026-01-01"'), { 'page/row5': [503, ''] }));
      expect(r.status, r.stderr).toBe(0);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(r.stdout).toMatch(/slug=row5 .*confirmed=never .*state=stale/);
    });

  it('a recent CONFIRMATION keeps an unreachable row out of stale -> INDETERMINATE, never PASS',
    { timeout: 30_000 }, () => {
      // Same stale row as above, but the state file records a confirmation of THIS evidence 10 d ago.
      const corpus = fakeCorpus(12, '2026-09-01').replace(
        '"slug":"row5","kind":"native","verifiedAt":"2026-09-01"',
        '"slug":"row5","kind":"native","verifiedAt":"2026-01-01"');
      const row5 = JSON.parse(corpus).rows[5];
      const sha = spawnSync('python3', ['-c', [
        'import importlib.util, json, sys',
        `spec = importlib.util.spec_from_file_location("c", ${JSON.stringify(PY)})`,
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        `print(m.evidence_sha(json.loads(${JSON.stringify(JSON.stringify(row5.evidence))})))`,
      ].join('\n')], { encoding: 'utf8' }).stdout.trim();
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      const r = runMain(fetcher(corpus, { 'page/row5': [503, ''] }), {
        state: { schema: 2, verdict: 'PASS', row_count: 12,
          confirmations: { 'mcp-clients/row5': { date: '2026-09-19', evidence_sha: sha } } },
      });
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
      expect(r.stdout).toMatch(/slug=row5 .*confirmed=2026-09-19 age=10d state=source unreachable/);
    });

  it('INDETERMINATE exits 3 when the SoT is unreadable — verified NOTHING never reads as clean',
    { timeout: 30_000 }, () => {
      const r = runMain('def _f(url, timeout=30): return 503, "", "", url\nm.fetch = _f');
      expect(r.status, r.stderr).toBe(3);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    });

  it('INDETERMINATE exits 3 on a corpus below its floor, and on a corpus that is not JSON',
    { timeout: 30_000 }, () => {
      for (const sot of [fakeCorpus(3, '2026-09-01'), 'export const MCP_CLIENTS = {};', fakeCorpus(12, '2026-09-01', { schema_version: 2 })]) {
        const r = runMain(fetcher(sot));
        expect(r.status, r.stderr).toBe(3);
        expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
      }
    });

  it('EVERY exit path emits exactly one token line — no path is silent, none doubles up',
    { timeout: 60_000 }, () => {
      const runs = [
        runMain(fetcher(fakeCorpus(12, '2026-09-01'))),
        runMain(fetcher(fakeCorpus(12, '2026-09-01'), { 'page/row0': [200, '<p>gone</p>'] })),
        runMain('def _f(url, timeout=30): return 503, "", "", url\nm.fetch = _f'),
      ];
      for (const r of runs) expect(tokenLines(r.stdout)).toHaveLength(1);
      // …and the three runs are not all the same verdict, or the assertion above is vacuous.
      expect(new Set(runs.map((r) => tokenLines(r.stdout)[0])).size).toBe(3);
    });
});

describe('client-claim-freshness — declarations the rest of the estate reads', () => {
  it('ALERT_ID is a module-level literal, which is what check-alert-registry.mjs matches', () => {
    expect(SRC).toMatch(new RegExp(`^ALERT_ID = "${ALERT_ID}"$`, 'm'));
  });

  it('the recommended wave is TEMPLATED W{NEXT}, never a literal wave number', () => {
    expect(SRC).toContain('RECOMMENDED_WAVE = "LANDING-{CORPUS}-CLAIMS-W{{NEXT}}"');
    const template = SRC.split('RECOMMENDED_WAVE = ')[1].split('\n')[0];
    expect(template).not.toMatch(/-W\d+/);
  });

  it('the CORPUS line names the SAME corpus and path as the TS contract (identifier lock)', () => {
    const line = SRC.match(/^\s*"(mcp-clients\|[^"]+)",$/m)?.[1];
    expect(line).toBeDefined();
    const [name, file, fields, floor] = line!.split('|');
    expect(name).toBe(CLAIM_EVIDENCE_CORPUS);
    expect(file).toBe(CLAIM_EVIDENCE_JSON);
    expect(fields.split(',')).toEqual(['slug', 'kind', 'verifiedAt', 'evidence']);
    expect(Number(floor)).toBe(8);
  });

  it('the SoT is read from the committed ref with a cache-buster, never a bare branch path', () => {
    expect(SRC).toContain('RAW_REF = "refs/heads/main"');
    expect(SRC).toMatch(/\?cb=%s/);
  });

  it('the age threshold is 150d and its justification travels with it', () => {
    expect(SRC).toContain('os.environ.get("CLIENT_CLAIM_AGE_DAYS", "150")');
    expect(SRC).toContain('AGE THRESHOLD: 150 DAYS, AND WHY NOT THE SPEC\'S 120');
  });

  it('the retired arms stay retired: no mcp-token SOURCE arm, no kind-keyed vendor table', () => {
    // A4: the evidence arm strictly supersedes the token count. A5: the vendor arm is keyed on the
    // CLAIM (npmScopeAbsence), so the kind-keyed table and its hand-maintained reasons are gone.
    expect(SRC).not.toMatch(/^def source_arm\(/m);
    expect(SRC).not.toMatch(/^VENDOR_SCOPE\b/m);
    expect(SRC).not.toMatch(/^VENDOR_SCOPE_REASON\b/m);
    expect(SRC).not.toMatch(/^VENDOR_ARTIFACT_KINDS\b/m);
    expect(SRC).not.toMatch(/^def parse_rows\(/m);
    expect(SRC).toContain('npmScopeAbsence');
  });

  it('the --clear invocation passes /dev/null on stdin', () => {
    const clearFn = SRC.split('def clear(')[1].split('\ndef ')[0];
    expect(clearFn).toContain('os.devnull');
    expect(clearFn).toContain('--clear');
  });
});
