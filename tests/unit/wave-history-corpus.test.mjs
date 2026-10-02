/**
 * OPS-HOST-KERNEL-REBOOT-W5 CH2 — the wave-history corpus has ONE path and ONE predicate.
 *
 * Every host consumer answering "what has already shipped" reads status.md ∪ wave-history.md.
 * Two things must not drift between them, and neither is visible to any single consumer's own
 * self-test, so they are pinned here, across files:
 *
 *  1. THE PATH. `WAVE_HISTORY_PATH`'s default is byte-identical in the bash wrapper, both python
 *     canaries, the sync's push target and the inventory row's installed_at — and in the AOE
 *     vendored wrapper when that checkout is present (in CI it is not; the AOE repo pins its copy
 *     by sha256 in tests/unit/test_vendored_wrapper_parity.py, which is what keeps it honest
 *     there). A consumer whose default differs reads a file nobody writes and resolves NOTHING,
 *     silently — the dark-guard class.
 *  2. THE PREDICATE. recommendation-drift-manifest.yaml's `status_md_completion_regex` was a
 *     second derivation of "completed wave" that disagreed with the resolver's (` — ` adjacency vs
 *     anchor-on-id): 94 vs 436 archived GREEN headings. Single-derivation rule: both must select
 *     IDENTICAL lines over one corpus, proven here by running the real resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const EXPECTED = '/var/lib/algovault-monitoring/wave-history.md';

/** Extract with a regex that MUST match — an extraction that finds nothing is a FAILURE, never a skip. */
function extract(label, text, re) {
  const m = text.match(re);
  assert.ok(m && m[1], `${label}: the WAVE_HISTORY_PATH default could not be located (pattern ${re})`);
  return m[1];
}

function defaults() {
  const out = {
    'ops/monitoring/send_telegram.sh': extract('send_telegram.sh', read('ops/monitoring/send_telegram.sh'),
      /^ {2}local history_path="\$\{WAVE_HISTORY_PATH:-([^}]+)\}"$/m),
    'ops/monitoring/decision-gate-orphan-canary.py': extract('decision-gate', read('ops/monitoring/decision-gate-orphan-canary.py'),
      /^WAVE_HISTORY_PATH = os\.environ\.get\("WAVE_HISTORY_PATH", "([^"]+)"\)$/m),
    'ops/monitoring/recommendation-drift-canary.py': extract('recommendation-drift', read('ops/monitoring/recommendation-drift-canary.py'),
      /^WAVE_HISTORY_PATH = os\.environ\.get\("WAVE_HISTORY_PATH", "([^"]+)"\)$/m),
  };
  const sync = read('ops/scripts/monitoring-results-sync.sh');
  const dir = extract('sync REMOTE_DIR', sync, /^REMOTE_DIR=\$\{MONITORING_SYNC_REMOTE_DIR:-([^}]+)\}$/m);
  const file = extract('sync REMOTE_WAVE_HISTORY', sync, /^REMOTE_WAVE_HISTORY="\$REMOTE_DIR\/([^"]+)"$/m);
  out['ops/scripts/monitoring-results-sync.sh (push target)'] = `${dir}/${file}`;
  const inv = JSON.parse(read('ops/monitoring/monitoring-inventory.json'));
  const row = inv.artifacts.find((r) => r.id === 'wave-history');
  assert.ok(row, 'monitoring-inventory.json carries no `wave-history` row — the push has no targets');
  assert.ok(Array.isArray(row.installed_at) && row.installed_at.length >= 2,
    'the `wave-history` row must name every consumer host in installed_at (signal-1 AND aoe-1)');
  for (const e of row.installed_at) out[`inventory installed_at[${e.host}]`] = e.path;
  return out;
}

test('WAVE_HISTORY_PATH has ONE default, byte-identical in every consumer and the push target', () => {
  const d = defaults();
  assert.ok(Object.keys(d).length >= 6, `parity ran over only ${Object.keys(d).length} sites`);
  for (const [site, value] of Object.entries(d)) {
    assert.equal(value, EXPECTED, `${site} defaults to ${value}, not ${EXPECTED}`);
  }
  console.log(`  wave-history path parity: ${Object.keys(d).length} sites == ${EXPECTED}`);
});

test('the AOE vendored wrapper carries the same default (when that checkout is present)', (t) => {
  const aoe = process.env.ALGOVAULT_AOE_REPO || path.resolve(REPO, '..', 'autonomous-optimizer');
  const vendored = path.join(aoe, 'monitoring', 'aoe-host', 'send_telegram.sh');
  if (!existsSync(vendored)) {
    t.skip(`no AOE checkout at ${aoe} — pinned on that side by its own sha256 parity pytest`);
    return;
  }
  const canonical = read('ops/monitoring/send_telegram.sh');
  const copy = readFileSync(vendored, 'utf8');
  assert.equal(
    extract('AOE vendored wrapper', copy, /^ {2}local history_path="\$\{WAVE_HISTORY_PATH:-([^}]+)\}"$/m),
    EXPECTED,
  );
  assert.equal(copy, canonical, 'the AOE vendored wrapper has diverged from the canonical bytes — re-vendor it');
});

// ── the predicate pin ───────────────────────────────────────────────────────────────────────
const CORPUS = [
  '# fixture',
  // conforming headings (Target ICP block right after the id — the case the old form could not match)
  '### 2026-07-10 — OPS-POSTGRES-RECAUDIT-W1 (Target ICP tier(s): META) — ✅ GREEN',
  '### 2026-07-20 — OPS-POSTGRES-RECAUDIT-W2 — ✅ GREEN',
  '### 2026-08-01 — OPS-POSTGRES-RECAUDIT-W3 (Target ICP tier(s): META · NO TG) — ⚠️ GREEN_WITH_CAVEAT',
  '### 2026-08-05 — OPS-POSTGRES-RECAUDIT-W4 (Target ICP tier(s): META) — 🛑 HALT',
  '### 2026-08-06 — OPS-OTHER-CLASS-W7 — ✅ GREEN',
  '### 2026-08-07 — OPS-OTHER-CLASS-W8 (Target ICP tier(s): T1) — ✅ GREEN',
  'body: OPS-POSTGRES-RECAUDIT-W9 — ✅ GREEN is prose, never a heading',
  '#### 2026-08-08 — OPS-POSTGRES-RECAUDIT-W9 — ✅ GREEN (h4 is not a wave heading)',
].join('\n') + '\n';

/** Lines python `re.match` selects — the canary's exact semantics (find_highest_green). */
function pythonSelect(regex, file) {
  const out = execFileSync('python3', ['-c', `
import re, sys, json
p = re.compile(sys.argv[1]); sel = []; hi = 0
for i, line in enumerate(open(sys.argv[2], encoding="utf-8")):
    m = p.match(line)
    if m and m.lastindex:
        sel.append(i); hi = max(hi, int(m.group(1)))
print(json.dumps({"lines": sel, "highest": hi}))`, regex, file], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** Lines the RESOLVER's predicate selects — send_telegram.sh's exact ERE, run through grep -E. */
function resolverSelect(cls, file) {
  const pat = `^### .*${cls}-W[0-9]+.*GREEN`;
  let out = '';
  try {
    out = execFileSync('grep', ['-nE', pat, file], { encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = no match; anything else is a broken probe
  }
  return out.split('\n').filter(Boolean).map((l) => Number(l.split(':')[0]) - 1);
}

function manifestRows() {
  // A minimal reader for this manifest's flat `- key: 'value'` rows — avoids a YAML dependency,
  // and fails loudly if the shape ever stops being that.
  const rows = [];
  let cur = null;
  for (const line of read('ops/monitoring/recommendation-drift-manifest.yaml').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(-\s+)?([a-z_]+):\s+'(.*)'\s*$/) || line.match(/^\s*(-\s+)?([a-z_]+):\s+(\S.*)$/);
    if (!m) continue;
    if (m[1]) rows.push((cur = {}));
    if (cur) cur[m[2]] = m[3].replace(/^'|'$/g, '');
  }
  assert.ok(rows.length >= 2 && rows.every((r) => r.status_md_completion_regex),
    `recommendation-drift-manifest.yaml parsed to ${rows.length} row(s) — the shape changed`);
  return rows;
}

test('the manifest completion regex selects EXACTLY the lines the resolver predicate selects', { timeout: 60000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wh-corpus-'));
  try {
    const f = path.join(dir, 'corpus.md');
    writeFileSync(f, CORPUS);
    for (const row of manifestRows()) {
      // The class the resolver would be handed: the literal id prefix for a class row, or the
      // any-OPS class expression the WEBSITE_DRIFT_CONSUMERS row encodes.
      const cls = row.status_md_completion_regex.match(/^\^### \.\*(.+)-W\(\[0-9\]\+\)\.\*GREEN$/)?.[1];
      assert.ok(cls, `${row.alert_class}: regex ${row.status_md_completion_regex} is not in the resolver's form`);
      const py = pythonSelect(row.status_md_completion_regex, f);
      const rs = resolverSelect(cls, f);
      assert.deepEqual(py.lines, rs, `${row.alert_class}: manifest selects ${py.lines}, resolver selects ${rs}`);
      assert.ok(py.lines.length > 0, `${row.alert_class}: the fixture selects nothing — the pin is vacuous`);
    }
    // The fixture DISCRIMINATES: the pre-W5 adjacency form selects fewer lines on the same corpus.
    const old = pythonSelect('^### .* — OPS-POSTGRES-RECAUDIT-W([0-9]+) — .*GREEN', f);
    const now = pythonSelect('^### .*OPS-POSTGRES-RECAUDIT-W([0-9]+).*GREEN', f);
    assert.ok(old.lines.length < now.lines.length, 'the fixture cannot tell the old form from the new one');
    assert.equal(old.highest, 2);
    assert.equal(now.highest, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real resolver agrees with the manifest on the highest GREEN wave (W3 -> W4)', { timeout: 60000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wh-resolve-'));
  try {
    const status = path.join(dir, 'status.md');
    const history = path.join(dir, 'wave-history.md');
    writeFileSync(status, '### 2026-10-02 — OPS-UNRELATED-W1 — ⏳ open\n');
    writeFileSync(history, CORPUS);
    const resolve = (wh) => execFileSync('bash', [path.join(REPO, 'ops/monitoring/send_telegram.sh'), '--resolve', '-'], {
      input: 'recommended_wave: OPS-POSTGRES-RECAUDIT-W{NEXT}\n',
      encoding: 'utf8',
      env: { ...process.env, STATUS_MD_PATH: status, WAVE_HISTORY_PATH: wh,
             ALERT_WRAPPER_STATE_DIR: path.join(dir, 'state'), ALERT_WRAPPER_LOG: path.join(dir, 'log') },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const pg = manifestRows().find((r) => r.alert_class === 'POSTGRES_RECAUDIT');
    const hi = pythonSelect(pg.status_md_completion_regex, history).highest;
    assert.equal(resolve(history), `recommended_wave: OPS-POSTGRES-RECAUDIT-W${hi + 1}`);
    // and in the other direction: without the corpus the same resolver cannot see the archive
    assert.equal(resolve(path.join(dir, 'absent.md')), 'recommended_wave: OPS-POSTGRES-RECAUDIT-W{NEXT}');
    assert.equal(existsSync(path.join(dir, 'state')), false, '--resolve created STATE_DIR');
    assert.equal(existsSync(path.join(dir, 'log')), false, '--resolve wrote the shared log');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
