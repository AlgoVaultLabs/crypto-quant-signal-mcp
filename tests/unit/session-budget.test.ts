/**
 * session-budget.test.ts — OPS-SESSION-BUDGET-W1, cut down by OPS-SESSION-BUDGET-W1-R2.
 *
 * The two hooks that remain — the one-wave gate (--on prompt) and the compact line
 * (--on compact) — driven the way Claude Code drives them: the CLI, hook JSON on stdin, and a
 * scratch HOME holding transcripts in the producer's vocabulary. Nothing here touches the real
 * ~/.claude or the real state dir. R2 removed the cold-cache hold and the meter; the static
 * block below keeps them removed.
 *
 * The one real-world read is the last block: the newest local transcript, when there is one, so
 * the fixture shape cannot drift from what the producer writes without a test going red.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  loadConfig, classifyPrompt, decidePrompt, compactMessage, promptText, lastMainRequest,
} from '../../scripts/session-budget.mjs';

const REPO = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'session-budget.mjs');
const CONFIG = join(REPO, 'ops', 'session-budget.json');
const cfg = loadConfig();

interface World { T: string; home: string; proj: string; env: NodeJS.ProcessEnv }

function mkWorld(label: string): World {
  const T = realpathSync(mkdtempSync(join(tmpdir(), `session-budget-${label}-`)));
  const home = join(T, 'home');
  const proj = join(home, '.claude', 'projects', '-fixture-project');
  mkdirSync(proj, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  return { T, home, proj, env };
}

function run(w: World, args: string[], input = '', script = SCRIPT) {
  const r = spawnSync(process.execPath, [script, ...args], { env: w.env, input, encoding: 'utf8', timeout: 60_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

const errorsOf = (w: World) => {
  const f = join(w.home, '.local', 'state', 'algovault', 'session-budget', 'errors.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// ── fixtures, in the producer's vocabulary ───────────────────────────────────────────────
const makeFixtures = (t0: number) => ({
  at: (min: number) => new Date(t0 + min * 60_000).toISOString(),
  prompt(min: number, text: string) {
    return { type: 'user', message: { role: 'user', content: text }, timestamp: this.at(min), cwd: '/fixture/project',
      promptSource: 'sdk', uuid: `u-${min}-${text.length}`, sessionId: 'fixture' };
  },
  reply(min: number, id: string, ctx: number, write = 0) {
    const usage = { input_tokens: 3, cache_read_input_tokens: Math.max(0, ctx - 3 - write), cache_creation_input_tokens: write,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write }, output_tokens: 500 };
    // one API response is split across records that share message.id (W1 R0)
    return [0, 1].map((i) => ({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', type: 'message',
      content: [{ type: 'thinking', thinking: '' }], usage }, requestId: `req-${id}`, timestamp: this.at(min), uuid: `a-${id}-${i}` }));
  },
  jsonl: (recs: unknown[]) => `${recs.flat().map((r) => JSON.stringify(r)).join('\n')}\n`,
});
type Fx = ReturnType<typeof makeFixtures>;
const SCENARIOS: Record<string, (f: Fx) => unknown[]> = {
  one_wave: (f) => [f.prompt(0, 'Read Prompt/OPS-A-W1.md. Plan-Mode required.'), f.reply(0.1, 'm1', 90000),
    f.prompt(2, 'Read Prompt/OPS-A-W1-V2.md'), f.reply(2.1, 'm2', 100000)],
  // the last reply is idle for hours over 162k of context: the shape the retired hold blocked
  cold: (f) => [f.prompt(0, 'Read Prompt/OPS-A-W1.md'), f.reply(0.1, 'm1', 160000),
    f.prompt(70, 'continue'), f.reply(70.1, 'm2', 162000, 160000)],
  no_wave: (f) => [f.prompt(0, 'go'), f.reply(1, 'm1', 240000)],
};

/** One session transcript at fresh timestamps; returns its path. */
function writeSession(w: World, id: string, name: string, startMinAgo = 600): string {
  const f = makeFixtures(Date.now() - startMinAgo * 60_000);
  const file = join(w.proj, `${id}.jsonl`);
  writeFileSync(file, f.jsonl(SCENARIOS[name](f)));
  return file;
}

/** A copy of the hook script beside the shipped config, with one edit — how a mutant is judged. */
function mutantScript(w: World, label: string, edit: (src: string) => string): string {
  const t = join(w.T, `mutant-${label}`);
  mkdirSync(join(t, 'scripts'), { recursive: true });
  mkdirSync(join(t, 'ops'), { recursive: true });
  writeFileSync(join(t, 'ops', 'session-budget.json'), readFileSync(CONFIG, 'utf8'));
  const src = readFileSync(SCRIPT, 'utf8');
  const out = edit(src);
  expect(out, `${label}: the edit must change the source`).not.toBe(src);
  writeFileSync(join(t, 'scripts', 'session-budget.mjs'), out);
  return join(t, 'scripts', 'session-budget.mjs');
}
const BASE_COMPARISON = '!prior.includes(c.dispatch.base)';

// ── 1. the gate, pure ────────────────────────────────────────────────────────────────────
describe('decidePrompt — one wave per session', () => {
  const hist = [{ base: 'OPS-A-W1', file: 'OPS-A-W1' }];
  const last = { ctx: 162000 };
  const decide = (text: string, history = hist) => decidePrompt({ text, history, last }, cfg);

  it('refuses a second base wave, naming the wave it ran, the context and the override', () => {
    expect(decide('Read Prompt/OPS-B-W1.md')).toEqual({
      action: 'block', kind: 'refuse_wave',
      reason: `This session already ran OPS-A-W1 (context 162k). Start a new session for OPS-B-W1 — one wave per session. Add ${cfg.dispatch.override_token} to override.`,
    });
  });

  it('allows -V2 and -R2 of the same wave', () => {
    for (const p of ['Read Prompt/OPS-A-W1-V2.md', 'Read Prompt/OPS-A-W1-R2.md', 'Read Prompt/OPS-A-W1-V3.md. Plan-Mode required.']) {
      expect(decide(p).action, p).toBe('allow');
    }
  });

  it('allows [same-session]', () => {
    expect(decide(`Read Prompt/OPS-B-W1.md ${cfg.dispatch.override_token}`).action).toBe('allow');
  });

  it('non-dispatch prompts pass, including <task-notification and every machine turn', () => {
    const prompts = ['carry on', 'please Read Prompt/OPS-B-W1.md first', '<bash-input>ls</bash-input>',
      ...cfg.exempt_prompt_prefixes.map((p: string) => `${p}>Read Prompt/OPS-B-W1.md`)];
    expect(prompts).toContain('<task-notification>Read Prompt/OPS-B-W1.md');
    for (const p of prompts) expect(decide(p).action, p).toBe('allow');
  });

  it('the first dispatch of a session is allowed, and a machine turn is never a dispatch', () => {
    expect(decide('Read Prompt/OPS-B-W1.md', []).action).toBe('allow');
    for (const p of cfg.exempt_prompt_prefixes) expect(classifyPrompt(`${p}>x`, cfg)).toMatchObject({ machine: true, dispatch: null });
  });

  it('a dispatch names the first .md only: a second line in Prompt/ is not part of the wave', () => {
    expect(classifyPrompt('Read Prompt/OPS-A-W1.md\nPrompt/notes.md', cfg).dispatch).toEqual({ file: 'OPS-A-W1', base: 'OPS-A-W1' });
  });
});

// ── 2. the hooks, as Claude Code invokes them ────────────────────────────────────────────
describe('--on prompt — refuses a second wave, holds nothing', () => {
  let w: World;
  let tp: string;
  const SID = 'ffffffff-0000-0000-0000-000000000001';
  const hook = (prompt: string, transcript = tp, script = SCRIPT) =>
    run(w, ['--on', 'prompt'], JSON.stringify({ session_id: SID, transcript_path: transcript, prompt, cwd: '/fixture', hook_event_name: 'UserPromptSubmit' }), script);

  beforeAll(() => {
    w = mkWorld('prompt');
    tp = writeSession(w, SID, 'one_wave', 5);
  });
  afterAll(() => rmSync(w.T, { recursive: true, force: true }));

  it('refuses a second, different wave with the block JSON Claude Code reads', () => {
    const r = hook('Read Prompt/OPS-B-W1.md');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      decision: 'block',
      reason: `This session already ran OPS-A-W1 (context 100k). Start a new session for OPS-B-W1 — one wave per session. Add ${cfg.dispatch.override_token} to override.`,
    });
  });

  it('allows -V2, -R2, [same-session] and plain prompts — printing NOTHING', () => {
    for (const p of ['Read Prompt/OPS-A-W1-V2.md', 'Read Prompt/OPS-A-W1-R3.md', 'Read Prompt/OPS-B-W1.md [same-session]',
      'carry on', '<task-notification>done</task-notification>']) {
      const r = hook(p);
      expect(r.status, p).toBe(0);
      expect(r.stdout, p).toBe('');
    }
  });

  it('nothing is held after a long idle over a large context', () => {
    const cold = writeSession(w, 'ffffffff-0000-0000-0000-000000000002', 'cold', 400); // last reply ~330 min ago, 162k
    const tail = lastMainRequest(cold);
    expect(tail?.ctx).toBe(162000);
    expect(Date.now() - (tail?.ts ?? Date.now())).toBeGreaterThan(3 * 3_600_000);
    for (let i = 0; i < 2; i++) {
      const r = hook('continue', cold);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(existsSync(join(w.home, '.local', 'state', 'algovault', 'session-budget', `${SID}.json`))).toBe(false);
  });

  it('a brand-new session with no transcript yet is allowed', () => {
    expect(hook('Read Prompt/OPS-Z-W1.md', join(w.proj, 'missing.jsonl')).stdout).toBe('');
  });

  it('fails OPEN on garbage input: exit 0, nothing printed, an error line in the state dir', () => {
    const r = run(w, ['--on', 'prompt'], '{not json');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(errorsOf(w).some((l) => l.mode === 'prompt')).toBe(true);
  });

  it('a retired mode left registered by an older install fails open too', () => {
    const r = run(w, ['--on', 'end'], JSON.stringify({ session_id: SID, transcript_path: tp, reason: 'other' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(errorsOf(w).some((l) => l.mode === 'cli' && /unknown --on end/.test(l.message))).toBe(true);
  });

  it('fallibility: break the base comparison and the second-wave fixture passes', () => {
    const broken = mutantScript(w, 'base', (src) => src.replace(BASE_COMPARISON, 'prior.includes(c.dispatch.base)'));
    expect(hook('Read Prompt/OPS-B-W1.md', tp, broken).stdout).toBe('');
    expect(JSON.parse(hook('Read Prompt/OPS-B-W1.md').stdout).decision).toBe('block');
  });
});

describe('--on compact — the re-orientation line', () => {
  it('names the wave and its spec within the byte cap, and prints nothing without a wave', () => {
    const w = mkWorld('compact');
    const tp = writeSession(w, 'abababab-0000-0000-0000-000000000001', 'one_wave');
    const r = run(w, ['--on', 'compact'], JSON.stringify({ session_id: 'abababab-0000-0000-0000-000000000001', transcript_path: tp, source: 'compact' }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("Wave OPS-A-W1 · spec Prompt/OPS-A-W1-V2.md · re-read the current chapter and the wave's last status.md entry before continuing.");
    expect(Buffer.byteLength(r.stdout.trim())).toBeLessThanOrEqual(cfg.compact_message_max_bytes);
    expect(Buffer.byteLength(compactMessage([{ base: 'X'.repeat(500), file: 'Y' }], cfg))).toBeLessThanOrEqual(cfg.compact_message_max_bytes);
    const none = writeSession(w, 'abababab-0000-0000-0000-000000000002', 'no_wave');
    expect(run(w, ['--on', 'compact'], JSON.stringify({ session_id: 'abababab-0000-0000-0000-000000000002', transcript_path: none })).stdout).toBe('');
    rmSync(w.T, { recursive: true, force: true });
  });

  it('a bare invocation is a usage error, never a silent success', () => {
    const w = mkWorld('usage');
    const r = run(w, []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage');
    rmSync(w.T, { recursive: true, force: true });
  });
});

// ── 3. static: the hold and the meter stay removed; every value comes from the config ────
const REMOVED = ['coldHoldApplies', 'coldMessage', 'ledgerSession', 'SESSION_BUDGET_VERDICT', '--on end', 'backfill(',
  'summarizeSession', 'summarizeFile', 'rollup(', 'renderSummary', 'renderLatest', 'writeLatest', 'report(', '--report',
  'parseSince', 'requestCost', 'priceFor', 'writesOf', 'instrumentSha', 'instrumentMeta', 'skillOverrides(', '--skill-overrides',
  'cold_cache', 'session-usage.jsonl', 'session-budget-latest.md', '--self-test'];

const AC3 = /coldHoldApplies|ledgerSession|SESSION_BUDGET_VERDICT|--on end/g;
const leftovers = (src: string) => [...(src.match(AC3) ?? []), ...REMOVED.filter((id) => src.includes(id))];

describe('static', () => {
  it('no hold or meter code is left in the script (AC3)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src.length).toBeGreaterThan(1000);
    expect(leftovers(src)).toEqual([]);
  });

  it('the removed-code scan can fail: one planted identifier of each kind is seen', () => {
    for (const id of REMOVED) expect(leftovers(`const x = 1; // ${id}`).length, id).toBeGreaterThan(0);
  });

  it('the config holds only what the two hooks and the installer read (plus files.* keys)', () => {
    const raw = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const kept = ['_doc', 'window_tokens', 'window_reason', 'dispatch', 'exempt_prompt_prefixes', 'exempt_prompt_prefixes_reason',
      'compact_message_max_bytes', 'compact_message_reason', 'hook_timeout_seconds', 'hook_timeout_reason'];
    // files / files_reason belong to OPS-STATUS-INDEX-LEDGER-W1 (status-append reads them; this script does not)
    expect(Object.keys(raw).filter((k) => !/^files/.test(k)).sort()).toEqual([...kept].sort());
    expect(Object.keys(raw.dispatch).sort()).toEqual(['base_strip', 'base_strip_reason', 'override_token', 'regex', 'regex_reason']);
  });

  it('the script reads its numbers from the config and hardcodes none of them', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('cfg.compact_message_max_bytes');
    expect(src).not.toMatch(new RegExp(`\\b${cfg.compact_message_max_bytes}\\b`));
  });
});

// ── 4. the producer itself: the fixture shape must match what Claude Code writes ─────────
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
  it('the newest local transcript still carries text prompts and per-record usage the gate reads', () => {
    const recs = readFileSync(newest as string, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    expect(recs.some((r) => typeof promptText(r) === 'string' && (promptText(r) as string).length > 0)).toBe(true);
    const tail = lastMainRequest(newest as string);
    expect(tail).not.toBeNull();
    expect(tail?.ctx).toBeGreaterThan(0);
  });
});
