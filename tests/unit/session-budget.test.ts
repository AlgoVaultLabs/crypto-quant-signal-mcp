/**
 * session-budget.test.ts — OPS-SESSION-BUDGET-W1.
 *
 * The meter and its hooks, driven the way Claude Code drives them: the CLI, hook JSON on stdin,
 * a scratch HOME holding transcripts in the producer's vocabulary, and a scratch vault reached
 * through the vault-path SoT's own override (SYSTEM_MAP_PATH). Nothing here touches the real
 * ~/.claude, the real vault or the real state dir.
 *
 * The one real-world read is the last block: the newest local transcript, when there is one, so
 * the fixture shape cannot drift from what the producer writes without a test going red.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, copyFileSync, realpathSync,
} from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  loadConfig, makeFixtures, scenarios, summarizeFile, summarizeSession, parseJsonl, EXIT,
} from '../../scripts/session-budget.mjs';

const REPO = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'session-budget.mjs');
const cfg = loadConfig();

interface World { T: string; home: string; vault: string; proj: string; env: NodeJS.ProcessEnv }

function mkWorld(label: string): World {
  const T = realpathSync(mkdtempSync(join(tmpdir(), `session-budget-${label}-`)));
  const home = join(T, 'home');
  const vault = join(T, 'vault');
  const proj = join(home, '.claude', 'projects', '-fixture-project');
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(vault, 'Claude files'), { recursive: true });
  writeFileSync(join(vault, 'system-map.md'), '# fixture\n');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SYSTEM_MAP_PATH: join(vault, 'system-map.md') };
  delete env.CLAUDE_CONFIG_DIR;
  return { T, home, vault, proj, env };
}

function run(w: World, args: string[], input = '', script = SCRIPT) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script, ...args], { env: w.env, input, encoding: 'utf8', timeout: 60_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1, ms: Date.now() - t0 };
}
const token = (s: string) => s.trim().split('\n').pop();

/** Write one session transcript at fresh timestamps; returns its path. */
function writeSession(w: World, id: string, name: string, startMinAgo = 600): string {
  const f = makeFixtures(Date.now() - startMinAgo * 60_000);
  const file = join(w.proj, `${id}.jsonl`);
  writeFileSync(file, f.jsonl((scenarios(f) as Record<string, unknown[]>)[name]));
  return file;
}

const ledger = (w: World) => {
  const f = join(w.vault, 'Claude files', 'session-usage.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

function waitFor(pred: () => boolean, ms: number): boolean {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    execFileSync('sleep', ['0.2']);
  }
  return pred();
}

// ── 1. the self-test, and proof that it can fail ──────────────────────────────────────────
describe('--self-test', () => {
  it('passes on the shipped logic, with a non-zero assertion count', () => {
    const w = mkWorld('selftest');
    const r = run(w, ['--self-test']);
    expect(token(r.stdout)).toBe('SESSION_BUDGET_VERDICT=PASS');
    expect(r.status).toBe(EXIT.PASS);
    expect(r.stdout).toMatch(/self-test passed \([1-9]\d* assertions over [1-9]\d* scenarios\)/);
    rmSync(w.T, { recursive: true, force: true });
  });

  it('mutation proof: break the two-wave rule and the self-test goes INDETERMINATE, naming it', () => {
    const w = mkWorld('mutant');
    const mut = join(w.T, 'mut');
    mkdirSync(join(mut, 'scripts'), { recursive: true });
    mkdirSync(join(mut, 'ops'), { recursive: true });
    copyFileSync(join(REPO, 'ops', 'session-budget.json'), join(mut, 'ops', 'session-budget.json'));
    const src = readFileSync(SCRIPT, 'utf8');
    const broken = src.replace('if (waves.length > 1) reasons.push', 'if (waves.length > 2) reasons.push');
    expect(broken).not.toBe(src);
    writeFileSync(join(mut, 'scripts', 'session-budget.mjs'), broken);
    const r = run(w, ['--self-test'], '', join(mut, 'scripts', 'session-budget.mjs'));
    expect(token(r.stdout)).toBe('SESSION_BUDGET_VERDICT=INDETERMINATE');
    expect(r.status).toBe(EXIT.INDETERMINATE);
    expect(r.stderr).toContain('two waves');
    // ...and the two-wave fixture, judged by the broken copy, PASSES — the defect this suite exists to catch
    writeSession(w, 'aaaaaaaa-0000-0000-0000-000000000001', 'two_waves');
    expect(token(run(w, ['--report', '--since', '1d'], '', join(mut, 'scripts', 'session-budget.mjs')).stdout))
      .toBe('SESSION_BUDGET_VERDICT=PASS');
    rmSync(w.T, { recursive: true, force: true });
  });
});

// ── 2. --report verdicts over fixture worlds ─────────────────────────────────────────────
describe('--report — one terminal token, exit 0 / 1 / 3', () => {
  const cases: Array<[string, string, number, string | null]> = [
    ['pass', 'PASS', EXIT.PASS, null],
    ['two_waves', 'OVER', EXIT.OVER, 'MULTI_WAVE'],
    ['cold_human', 'OVER', EXIT.OVER, 'COLD_REWRITES'],
    ['not_applied', 'OVER', EXIT.OVER, 'WINDOW_NOT_APPLIED'],
    ['overshoot', 'OVER', EXIT.OVER, 'OVERSHOOT'],
    ['cold_machine', 'PASS', EXIT.PASS, null],
    ['no_usage', 'INDETERMINATE', EXIT.INDETERMINATE, null],
  ];
  for (const [name, verdict, code, reason] of cases) {
    it(`${name} ⇒ ${verdict}${reason ? ` (${reason})` : ''}`, () => {
      const w = mkWorld(name);
      writeSession(w, 'bbbbbbbb-0000-0000-0000-000000000001', name);
      const r = run(w, ['--report', '--since', '1d']);
      expect(token(r.stdout), r.stdout + r.stderr).toBe(`SESSION_BUDGET_VERDICT=${verdict}`);
      expect(r.status).toBe(code);
      const j = JSON.parse(run(w, ['--report', '--since', '1d', '--json']).stdout.replace(/\nSESSION_BUDGET_VERDICT=.*\n?$/, ''));
      expect(j.sessions).toHaveLength(1);
      if (reason) expect(j.sessions[0].over_reasons).toContain(reason);
      rmSync(w.T, { recursive: true, force: true });
    });
  }

  it('a machine-triggered cold re-write is tagged machine and counted as a skip, never judged', () => {
    const w = mkWorld('machine');
    writeSession(w, 'cccccccc-0000-0000-0000-000000000001', 'cold_machine');
    const j = JSON.parse(run(w, ['--report', '--since', '1d', '--json']).stdout.replace(/\nSESSION_BUDGET_VERDICT=.*\n?$/, ''));
    expect(j.sessions[0]).toMatchObject({ cold_rewrites_machine: 2, cold_rewrites_human: 0, machine_skips: 2, verdict: 'PASS' });
    rmSync(w.T, { recursive: true, force: true });
  });

  it('an EMPTY transcript is reported, not judged; zero sessions is a reported PASS', () => {
    const w = mkWorld('empty');
    let r = run(w, ['--report', '--since', '1d']);
    expect(token(r.stdout)).toBe('SESSION_BUDGET_VERDICT=PASS');
    expect(r.stdout).toContain('0 session(s) counted');
    writeSession(w, 'dddddddd-0000-0000-0000-000000000001', 'empty');
    r = run(w, ['--report', '--since', '1d']);
    expect(token(r.stdout)).toBe('SESSION_BUDGET_VERDICT=PASS');
    expect(r.stdout).toContain('1 EMPTY');
    rmSync(w.T, { recursive: true, force: true });
  });

  it('subagent files are read beside the main transcript', () => {
    const w = mkWorld('subagent');
    const main = writeSession(w, 'eeeeeeee-0000-0000-0000-000000000001', 'pass');
    const sub = join(w.proj, 'eeeeeeee-0000-0000-0000-000000000001', 'subagents');
    mkdirSync(sub, { recursive: true });
    const f = makeFixtures(Date.now() - 300 * 60_000);
    writeFileSync(join(sub, 'agent-a1.jsonl'), f.jsonl([f.reply(1, 's1', 30000, { sidechain: true, model: 'claude-sonnet-5-5' })]));
    writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
    const s = summarizeFile(main, cfg);
    expect(s.requests).toEqual({ main: 3, subagent: 1 });
    rmSync(w.T, { recursive: true, force: true });
  });
});

// ── 3. the hooks, as Claude Code invokes them ────────────────────────────────────────────
describe('--on prompt — one wave per session, a cold cache held once', () => {
  let w: World;
  let tp: string;
  const SID = 'ffffffff-0000-0000-0000-000000000001';
  const hook = (prompt: string, transcript = tp, sid = SID) =>
    run(w, ['--on', 'prompt'], JSON.stringify({ session_id: sid, transcript_path: transcript, prompt, cwd: '/fixture', hook_event_name: 'UserPromptSubmit' }));

  beforeAll(() => {
    w = mkWorld('prompt');
    tp = writeSession(w, SID, 'pass', 5); // warm: the last reply is ~3 min old
  });
  afterAll(() => rmSync(w.T, { recursive: true, force: true }));

  it('refuses a second, different wave and names the override', () => {
    const r = hook('Read Prompt/OPS-B-W1.md');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('This session already ran OPS-A-W1');
    expect(out.reason).toContain('Start a new session for OPS-B-W1');
    expect(out.reason).toContain(cfg.dispatch.override_token);
  });

  it('allows a -V2 and an -R2 of the same wave, and [same-session] — printing NOTHING', () => {
    for (const p of ['Read Prompt/OPS-A-W1-V2.md', 'Read Prompt/OPS-A-W1-R3.md', 'Read Prompt/OPS-B-W1.md [same-session]', 'carry on']) {
      const r = hook(p);
      expect(r.status, p).toBe(0);
      expect(r.stdout, p).toBe('');
    }
  });

  it('holds a cold-cache prompt over a large context once, then lets the resend through', () => {
    const cold = writeSession(w, 'ffffffff-0000-0000-0000-000000000002', 'cold_human', 400); // last reply ~260 min ago, 162k
    const sid = 'ffffffff-0000-0000-0000-000000000002';
    const a = hook('continue', cold, sid);
    const out = JSON.parse(a.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/^Cache expired \(idle \d+:\d\d\)\. Context 162k → this prompt re-writes it at 2× \(≈ \$\d+\.\d\d list\)\./);
    const b = hook('continue', cold, sid);
    expect(b.stdout).toBe('');
    const st = JSON.parse(readFileSync(join(w.home, '.local', 'state', 'algovault', 'session-budget', `${sid}.json`), 'utf8'));
    expect(st.holds).toBe(1);
  });

  it('never holds a machine turn: it is skipped and counted', () => {
    const cold = writeSession(w, 'ffffffff-0000-0000-0000-000000000003', 'cold_human', 400);
    const sid = 'ffffffff-0000-0000-0000-000000000003';
    for (const p of cfg.exempt_prompt_prefixes) expect(hook(`${p}>x`, cold, sid).stdout, p).toBe('');
    const st = JSON.parse(readFileSync(join(w.home, '.local', 'state', 'algovault', 'session-budget', `${sid}.json`), 'utf8'));
    expect(st.machine_skips).toBe(cfg.exempt_prompt_prefixes.length);
    expect(st.holds).toBeUndefined();
  });

  it('fails OPEN on garbage input: exit 0, nothing printed, an error line in the ledger', () => {
    const r = run(w, ['--on', 'prompt'], '{not json');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(ledger(w).some((l) => l.type === 'error' && l.mode === 'prompt')).toBe(true);
  });

  it('a brand-new session with no transcript yet is allowed', () => {
    expect(hook('Read Prompt/OPS-Z-W1.md', join(w.proj, 'missing.jsonl'), 'ffffffff-0000-0000-0000-000000000009').stdout).toBe('');
  });
});

describe('--on compact — the re-orientation line', () => {
  it('names the wave and its spec within the byte cap, and prints nothing without a wave', () => {
    const w = mkWorld('compact');
    const tp = writeSession(w, 'abababab-0000-0000-0000-000000000001', 'pass');
    const r = run(w, ['--on', 'compact'], JSON.stringify({ session_id: 'abababab-0000-0000-0000-000000000001', transcript_path: tp, source: 'compact' }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("Wave OPS-A-W1 · spec Prompt/OPS-A-W1-V2.md · re-read the current chapter and the wave's last status.md entry before continuing.");
    expect(Buffer.byteLength(r.stdout.trim())).toBeLessThanOrEqual(cfg.compact_message_max_bytes);
    const none = writeSession(w, 'abababab-0000-0000-0000-000000000002', 'not_applied');
    expect(run(w, ['--on', 'compact'], JSON.stringify({ session_id: 'abababab-0000-0000-0000-000000000002', transcript_path: none })).stdout).toBe('');
    rmSync(w.T, { recursive: true, force: true });
  });
});

describe('--on end — detached ledger write, rolling readout', () => {
  it('returns in under a second printing nothing, then leaves ONE line with every field and a verdict file', () => {
    const w = mkWorld('end');
    const sid = 'cdcdcdcd-0000-0000-0000-000000000001';
    const tp = writeSession(w, sid, 'pass');
    const old = writeSession(w, 'cdcdcdcd-0000-0000-0000-000000000002', 'cold_human', 3000);
    const past = new Date(Date.now() - 2 * 86_400_000);
    execFileSync('touch', ['-t', `${past.getFullYear()}${String(past.getMonth() + 1).padStart(2, '0')}${String(past.getDate()).padStart(2, '0')}1200`, old]);
    const r = run(w, ['--on', 'end'], JSON.stringify({ session_id: sid, transcript_path: tp, reason: 'other', hook_event_name: 'SessionEnd' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(1000);
    const latest = join(w.vault, 'Claude files', 'session-budget-latest.md');
    expect(waitFor(() => existsSync(latest), 15_000)).toBe(true);
    const lines = ledger(w).filter((l) => l.type === 'session');
    const mine = lines.filter((l) => l.session_id === sid);
    expect(mine).toHaveLength(1);
    for (const k of ['session_id', 'project', 'first_ts', 'last_ts', 'hours', 'requests', 'context', 'share_above_threshold',
      'cache_write_tokens', 'cold_rewrites_human', 'cold_rewrites_machine', 'machine_skips', 'compactions', 'waves', 'skills', 'mcp',
      'top_tool_results', 'output_tokens', 'list_usd', 'over_reason', 'over_reasons', 'verdict', 'instrument', 'source']) {
      expect(mine[0], k).toHaveProperty(k);
    }
    expect(mine[0].source).toBe('session_end');
    // the idle session that never fired SessionEnd is backfilled, once
    expect(lines.filter((l) => l.session_id === 'cdcdcdcd-0000-0000-0000-000000000002' && l.source === 'backfill')).toHaveLength(1);
    const md = readFileSync(latest, 'utf8');
    expect(md).toMatch(/^SESSION_BUDGET_VERDICT=(PASS|OVER|INDETERMINATE)$/m);
    expect(md).toContain('SESSION_BUDGET_VERDICT=OVER'); // the backfilled session is COLD_REWRITES
    rmSync(w.T, { recursive: true, force: true });
  }, 30_000);
});

// ── 4. --skill-overrides ─────────────────────────────────────────────────────────────────
describe('--skill-overrides — name-only only when nothing used it in the window', () => {
  it('keeps a transcript-invoked skill and a recently used one, names the rest', () => {
    const w = mkWorld('skills');
    for (const s of ['used-in-transcript', 'used-recently', 'stale', 'never']) {
      mkdirSync(join(w.home, '.claude', 'skills', s), { recursive: true });
      writeFileSync(join(w.home, '.claude', 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: d\n---\nbody\n`);
    }
    const f = makeFixtures(Date.now() - 60 * 60_000);
    writeFileSync(join(w.proj, 'aaaa0000-0000-0000-0000-000000000001.jsonl'),
      f.jsonl([f.prompt(0, 'go'), f.reply(1, 'm1', 1000, { tool: { name: 'Skill', input: { skill: 'used-in-transcript' } } })]));
    const day = 86_400_000;
    writeFileSync(join(w.home, '.claude.json'), JSON.stringify({ skillUsage: {
      'used-recently': { usageCount: 3, lastUsedAt: Date.now() - 10 * day },
      stale: { usageCount: 9, lastUsedAt: Date.now() - (cfg.skill_name_only_window_days + 5) * day },
    } }));
    const r = run(w, ['--skill-overrides']);
    expect(token(r.stdout)).toBe('SESSION_BUDGET_SKILLS_VERDICT=PASS');
    expect(JSON.parse(r.stdout.split('\n')[0])).toEqual({ never: 'name-only', stale: 'name-only' });
    rmSync(w.T, { recursive: true, force: true });
  });

  it('a census over zero transcripts is INDETERMINATE and writes no JSON', () => {
    const w = mkWorld('skills-vacuous');
    mkdirSync(join(w.home, '.claude', 'skills', 'x'), { recursive: true });
    writeFileSync(join(w.home, '.claude', 'skills', 'x', 'SKILL.md'), '---\nname: x\n---\n');
    const r = run(w, ['--skill-overrides']);
    expect(r.stdout.trim()).toBe('SESSION_BUDGET_SKILLS_VERDICT=INDETERMINATE');
    expect(r.status).toBe(3);
    rmSync(w.T, { recursive: true, force: true });
  });
});

// ── 5. static: every number comes from the threshold file ────────────────────────────────
describe('static', () => {
  it('the meter reads every threshold from the config and hardcodes none of their values (fixtures aside)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const logic = src.slice(0, src.indexOf('// ── self-test fixtures'));
    expect(logic.length).toBeGreaterThan(1000);
    const keys: Array<[string, number]> = [
      ['cfg.window_tokens', cfg.window_tokens], ['cfg.cold_cache.idle_seconds', cfg.cold_cache.idle_seconds],
      ['cfg.cold_cache.min_context_tokens', cfg.cold_cache.min_context_tokens], ['cfg.cold_cache.rewrite_min_tokens', cfg.cold_cache.rewrite_min_tokens],
      ['cfg.share_threshold_tokens', cfg.share_threshold_tokens], ['cfg.skill_name_only_window_days', cfg.skill_name_only_window_days],
      ['cfg.long_session_hours', cfg.long_session_hours], ['cfg.latest_max_rows', cfg.latest_max_rows],
      ['cfg.overshoot_follow_requests', cfg.overshoot_follow_requests], ['cfg.cold_cache.max_human_rewrites_per_session', cfg.cold_cache.max_human_rewrites_per_session],
    ];
    for (const [key, v] of keys) {
      expect(logic, key).toContain(key);
      // a one-digit value is too short to scan for: it collides with byte sizes and slice lengths
      if (v >= 10) expect(logic, `${key}=${v}`).not.toMatch(new RegExp(`\\b${v}\\b`));
    }
  });

  it('the static scan can fail: it sees a planted literal', () => {
    expect(`const idle = ${cfg.cold_cache.idle_seconds};`).toMatch(new RegExp(`\\b${cfg.cold_cache.idle_seconds}\\b`));
  });
});

// ── 6. the producer itself: the fixture shape must match what Claude Code writes ─────────
const REAL = join(homedir(), '.claude', 'projects');
const newest = (() => {
  if (!existsSync(REAL)) return null;
  let best: { f: string; m: number } | null = null;
  for (const p of readdirSync(REAL)) {
    let names: string[] = [];
    try { names = readdirSync(join(REAL, p)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = join(REAL, p, n);
      const st = statSync(f);
      if (st.size > 200_000 && (!best || st.mtimeMs > best.m)) best = { f, m: st.mtimeMs };
    }
  }
  return best?.f ?? null;
})();

describe.skipIf(!newest)('the real producer (local only)', () => {
  it('the newest local transcript still carries per-record usage, split by message.id', () => {
    const { recs } = parseJsonl(readFileSync(newest as string, 'utf8'));
    const assistant = recs.filter((r: { type?: string; message?: { model?: string } }) => r.type === 'assistant' && r.message?.model !== '<synthetic>');
    const ids = new Set(assistant.map((r: { message: { id: string } }) => r.message.id));
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant.some((r: { message: { usage?: { input_tokens?: number } } }) => typeof r.message.usage?.input_tokens === 'number')).toBe(true);
    const s = summarizeSession({ main: recs }, cfg);
    expect(s.verdict).not.toBe('INDETERMINATE');
    expect(s.requests.main).toBeLessThanOrEqual(ids.size);
  });
});
