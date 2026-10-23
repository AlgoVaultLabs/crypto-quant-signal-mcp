#!/usr/bin/env node
/**
 * session-budget.mjs — OPS-SESSION-BUDGET-W1
 *
 * The one entry point for the Claude Code session budget on this Mac. The hooks, the readout
 * and the tests all call it; every number it judges by lives in ops/session-budget.json.
 *
 *   --on prompt          UserPromptSubmit: refuse a second wave, hold a cold-cache prompt once
 *   --on compact         SessionStart(compact): one line naming the wave to re-orient on
 *   --on end             SessionEnd: spawn the ledger write detached, print nothing
 *   --report --since 7d  the same metrics over the transcripts on disk (read-only)
 *   --skill-overrides    the skillOverrides object the installer writes (JSON on line 1)
 *   --self-test          hermetic fixtures in the producer's vocabulary, both directions
 *
 * ── WHAT IT MEASURES, AND FROM WHERE ──────────────────────────────────────────
 * The PRODUCER: Claude Code's own transcript JSONL, `message.usage` on each assistant record,
 * never a proxy. Two measured facts shape the parser (R0, 2026-10-23):
 *   - one API response is SPLIT across several assistant records (one per content block) that
 *     share `message.id` and carry IDENTICAL usage — 3,207 records were 1,450 requests. Every
 *     metric dedupes by id; without it every figure inflates ~2.2x.
 *   - subagents write their own files, `<session>/subagents/agent-*.jsonl`, which SessionEnd's
 *     `transcript_path` does not name. The meter reads them beside the main file.
 * Context per request = input + cache_read + cache_creation. Records whose model is
 * `<synthetic>` (API errors) are not requests.
 *
 * ── VERDICT ───────────────────────────────────────────────────────────────────
 * One terminal line: SESSION_BUDGET_VERDICT=PASS|OVER|INDETERMINATE — exit 0 / 1 / 3. The 3 is
 * the token-law default for a NEW gate. A session is OVER when it carried more than one base
 * wave, had more human-triggered cold re-writes than allowed, or sent a request above the
 * window (WINDOW_NOT_APPLIED when no compaction followed, OVERSHOOT when one did — ruling Q1).
 * A transcript with model responses but no usage on any of them is INDETERMINATE: the vacuity
 * guard sits where the corpus is BUILT, because a schema change upstream would otherwise
 * measure nothing and call it clean. A transcript with no model response at all (a blocked
 * prompt, an auth failure) is EMPTY — reported, never judged. Zero sessions in a window is a
 * fact about the world, so it is a reported PASS, never a silent one.
 *
 * ── FAIL OPEN ON OUR OWN BUG ──────────────────────────────────────────────────
 * Every hook path catches everything: an internal error allows the prompt, exits 0 and writes
 * an error line to the ledger. A budget tool must never be the thing that stops the work. On
 * an allowed prompt the hook prints NOTHING — UserPromptSubmit stdout is added to context.
 *
 * ── MACHINE TURNS ─────────────────────────────────────────────────────────────
 * UserPromptSubmit also fires on task notifications, agent hand-backs and scheduled triggers
 * (measured: 3,680 / 110 / 59). Nobody is there to re-send a held one, so prompts starting
 * with a declared prefix skip the cold-cache hold and are counted (ruling Q2). The same
 * predicate tags every cold re-write human|machine in the ledger — ONE derivation for both.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync,
  renameSync, rmSync, openSync, readSync, closeSync, fstatSync, realpathSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const TAG = '[session-budget]';
export const EXIT = Object.freeze({ PASS: 0, OVER: 1, INDETERMINATE: 3 });
export const DEFAULT_CONFIG = join(HERE, '..', 'ops', 'session-budget.json');

// ── config ────────────────────────────────────────────────────────────────────

/** Load and validate the threshold file. A config we author is CONSTRUCTED: empty or missing = refuse. */
export function loadConfig(file = DEFAULT_CONFIG) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const pos = (v) => Number.isFinite(v) && v > 0;
  for (const k of ['window_tokens', 'overshoot_follow_requests', 'share_threshold_tokens', 'report_window_days',
    'backfill_idle_hours', 'backfill_max_per_run', 'compact_message_max_bytes', 'bytes_per_token',
    'skill_name_only_window_days', 'long_session_hours', 'latest_max_rows']) {
    if (!pos(c[k])) throw new Error(`config ${k} is not a positive number`);
  }
  for (const k of ['idle_seconds', 'min_context_tokens', 'rewrite_min_tokens']) {
    if (!pos(c.cold_cache?.[k])) throw new Error(`config cold_cache.${k} is not a positive number`);
  }
  if (!Number.isInteger(c.cold_cache.max_human_rewrites_per_session) || c.cold_cache.max_human_rewrites_per_session < 0) {
    throw new Error('config cold_cache.max_human_rewrites_per_session is not a non-negative integer');
  }
  if (!Array.isArray(c.exempt_prompt_prefixes) || c.exempt_prompt_prefixes.length === 0
    || c.exempt_prompt_prefixes.some((p) => typeof p !== 'string' || !p.startsWith('<'))) {
    throw new Error('config exempt_prompt_prefixes must be a non-empty list of "<tag" prefixes');
  }
  new RegExp(c.dispatch?.regex); new RegExp(c.dispatch?.base_strip);
  if (!c.dispatch.override_token) throw new Error('config dispatch.override_token is empty');
  const models = c.prices?.models || {};
  if (!Object.keys(models).length) throw new Error('config prices.models is empty');
  for (const [m, p] of Object.entries(models)) {
    for (const k of ['input', 'output', 'cache_read']) if (!pos(p[k])) throw new Error(`config price ${m}.${k} is not positive`);
  }
  for (const k of ['5m', '1h']) if (!pos(c.prices.cache_write_multiplier?.[k])) throw new Error(`config write multiplier ${k} missing`);
  if (!['5m', '1h'].includes(c.prices.default_write_ttl)) throw new Error('config prices.default_write_ttl must be 5m or 1h');
  return c;
}

// ── paths ─────────────────────────────────────────────────────────────────────

const home = (env = process.env) => env.HOME || homedir();
export const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(home(env), '.claude');
export const projectsDir = (env = process.env) => join(claudeDir(env), 'projects');
export const stateDir = (env = process.env) => join(home(env), '.local', 'state', 'algovault', 'session-budget');
export const claudeJsonPath = (env = process.env) =>
  (env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home(env), '.claude.json'));

/**
 * The vault root, PROJECTED from the one declared vault path by sourcing
 * scripts/lib/system-map-path.sh — never restated here. Sourcing inherits $SYSTEM_MAP_PATH,
 * so the override is the library's, not a second rule of ours. Refuses on an empty answer:
 * an empty path is not a degraded path, it is a different path.
 */
export function vaultRoot(env = process.env) {
  const lib = join(HERE, 'lib', 'system-map-path.sh');
  if (!existsSync(lib)) throw new Error(`the vault path SoT is missing: ${lib}`);
  const out = execFileSync('/bin/bash', ['-c', '. "$1"; printf "%s" "$ALGOVAULT_SYSTEM_MAP_PATH"', '_', lib],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
  if (!out) throw new Error('the vault path SoT defined no path');
  const root = dirname(out);
  if (!existsSync(root)) throw new Error(`the vault root does not exist: ${root}`);
  return root;
}
export const ledgerPath = (root) => join(root, 'Claude files', 'session-usage.jsonl');
export const latestPath = (root) => join(root, 'Claude files', 'session-budget-latest.md');

/** The commit this instrument came from: the pinned install's stamp, else the checkout's HEAD. */
export function instrumentSha() {
  const stamp = join(HERE, '..', '.installed-sha');
  if (existsSync(stamp)) return readFileSync(stamp, 'utf8').trim().slice(0, 12);
  try {
    const sha = execFileSync('git', ['-C', HERE, 'rev-parse', '--short=12', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // `git diff` is blind to an untracked file, so a not-yet-committed meter would read clean.
    const clean = execFileSync('git', ['-C', join(HERE, '..'), 'status', '--porcelain', '--', 'scripts/session-budget.mjs', 'ops/session-budget.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '';
    return clean ? sha : `${sha}-dirty`;
  } catch { return 'unknown'; }
}

// ── classification (ONE derivation, shared by the hook and the meter) ─────────

/** The human-or-machine text of a prompt record, or null when the record is not a prompt. */
export function promptText(rec) {
  if (!rec || rec.type !== 'user' || rec.isMeta || rec.isCompactSummary || rec.isSidechain
    || rec.toolUseResult !== undefined) return null;
  const c = rec.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return null;
    const t = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    return t || null;
  }
  return null;
}

/** Machine turn? Dispatch of which wave? Override token present? */
export function classifyPrompt(text, cfg) {
  const t = String(text ?? '');
  const lead = t.replace(/^\s+/, '');
  const machine = cfg.exempt_prompt_prefixes.some((p) => lead.startsWith(p));
  const m = new RegExp(cfg.dispatch.regex).exec(t);
  const dispatch = m && !machine ? { file: m[1], base: m[1].replace(new RegExp(cfg.dispatch.base_strip), '') } : null;
  return { machine, dispatch, override: t.includes(cfg.dispatch.override_token) };
}

/** Would a prompt arriving at `atMs` meet a cold cache over a large context? */
export function coldHoldApplies(last, atMs, cfg) {
  return Boolean(last) && atMs - last.ts > cfg.cold_cache.idle_seconds * 1000 && last.ctx > cfg.cold_cache.min_context_tokens;
}

export const contextOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const isRequestRecord = (r) => r?.type === 'assistant' && r.message?.model !== '<synthetic>' && !r.isApiErrorMessage;

// ── pricing ───────────────────────────────────────────────────────────────────

function priceFor(model, ctx, cfg) {
  const p = cfg.prices.models[model];
  if (!p) return null;
  return p.long_context && ctx > p.long_context_over_tokens ? { ...p, ...p.long_context } : p;
}

/** Split cache writes into TTL classes; a breakdown that does not sum to the total goes to the default TTL. */
function writesOf(u, cfg) {
  const total = u.cache_creation_input_tokens || 0;
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens || 0;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  if (w5 + w1 === total) return { '5m': w5, '1h': w1 };
  return cfg.prices.default_write_ttl === '1h' ? { '5m': 0, '1h': total } : { '5m': total, '1h': 0 };
}

/** List-price USD of one request, or null when its model is unpriced. */
export function requestCost(q, cfg) {
  const p = priceFor(q.model, q.ctx, cfg);
  if (!p) return null;
  const u = q.usage;
  const w = writesOf(u, cfg);
  const m = cfg.prices.cache_write_multiplier;
  return ((u.input_tokens || 0) * p.input + (u.cache_read_input_tokens || 0) * p.cache_read
    + w['5m'] * p.input * m['5m'] + w['1h'] * p.input * m['1h'] + (u.output_tokens || 0) * p.output) / 1e6;
}

// ── transcripts ───────────────────────────────────────────────────────────────

export function parseJsonl(text) {
  const recs = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { recs.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { recs, bad };
}

/** The main transcript plus its subagent files, parsed. */
export function readSessionFiles(transcript) {
  const main = parseJsonl(readFileSync(transcript, 'utf8'));
  const subDir = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents');
  const subagents = [];
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).filter((x) => x.endsWith('.jsonl')).sort()) {
      const p = parseJsonl(readFileSync(join(subDir, f), 'utf8'));
      let agentType = null;
      const meta = join(subDir, f.replace(/\.jsonl$/, '.meta.json'));
      if (existsSync(meta)) { try { agentType = JSON.parse(readFileSync(meta, 'utf8')).agentType ?? null; } catch { /* report-only field */ } }
      subagents.push({ file: f, agentType, recs: p.recs, bad: p.bad });
    }
  }
  return { main: main.recs, bad: main.bad, subagents };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0);
const textBytes = (c) => {
  if (typeof c === 'string') return Buffer.byteLength(c);
  if (Array.isArray(c)) return c.reduce((n, b) => n + (typeof b?.text === 'string' ? Buffer.byteLength(b.text) : 0), 0);
  return 0;
};
const SKILL_LOAD = /^Base directory for this skill: (.+?)\s*$/m;

function toolTarget(input) {
  if (!input || typeof input !== 'object') return null;
  for (const k of ['file_path', 'notebook_path', 'path', 'url', 'pattern', 'query']) if (typeof input[k] === 'string') return input[k];
  if (typeof input.command === 'string') return input.command.slice(0, 80);
  return null;
}

/**
 * Every per-session field the ledger carries, from parsed records. Pure: the hook, the report,
 * the backfill and the self-test all go through here.
 */
export function summarizeSession({ main, subagents = [], sessionId = null, transcript = null, bad = 0 }, cfg) {
  const reqs = [];
  const seen = new Set();
  let responses = 0;
  let withUsage = 0;
  const tools = new Map();
  const skills = {};
  const mcp = {};
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

  const ingest = (recs, side) => {
    for (const r of recs) {
      if (!isRequestRecord(r)) continue;
      responses += 1;
      for (const b of r.message?.content || []) {
        if (b?.type !== 'tool_use') continue;
        tools.set(b.id, { name: b.name, input: b.input });
        const mm = /^mcp__(.+?)__/.exec(b.name || '');
        if (mm) bump(mcp, mm[1]);
      }
      const id = r.message?.id || r.requestId || r.uuid;
      if (seen.has(id)) continue;
      seen.add(id);
      const u = r.message?.usage;
      if (!u || typeof u.input_tokens !== 'number') continue;
      withUsage += 1;
      reqs.push({ id, ts: Date.parse(r.timestamp), ctx: contextOf(u), model: r.message.model, usage: u, side });
    }
  };
  ingest(main, 'main');
  for (const s of subagents) ingest(s.recs, 'subagent');

  const prompts = [];
  const compactions = [];
  const results = [];
  let first = Infinity;
  let last = -Infinity;
  let project = null;
  for (const r of main) {
    const ts = Date.parse(r?.timestamp);
    if (Number.isFinite(ts)) { first = Math.min(first, ts); last = Math.max(last, ts); }
    if (!project && typeof r?.cwd === 'string') project = r.cwd;
    if (r?.type === 'system' && r.subtype === 'compact_boundary') compactions.push({ ts, trigger: r.compactMetadata?.trigger ?? null });
    if (r?.type !== 'user') continue;
    const t = promptText(r);
    if (t !== null) prompts.push({ ts, c: classifyPrompt(t, cfg) });
    const content = r.message?.content;
    const raw = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
    if (r.isMeta) { const sk = SKILL_LOAD.exec(raw); if (sk) bump(skills, basename(sk[1])); }
    if (Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_result') results.push({ id: b.tool_use_id, bytes: textBytes(b.content) });
    }
  }

  const mainReqs = reqs.filter((q) => q.side === 'main').sort((a, b) => a.ts - b.ts);
  const ctxs = mainReqs.map((q) => q.ctx).sort((a, b) => a - b);

  // cold re-writes: an idle gap, then a large write — tagged by the prompt that triggered it
  let coldHuman = 0; let coldMachine = 0; let coldUnattributed = 0;
  for (let i = 1; i < mainReqs.length; i++) {
    const q = mainReqs[i]; const prev = mainReqs[i - 1];
    if (!(q.ts - prev.ts > cfg.cold_cache.idle_seconds * 1000 && (q.usage.cache_creation_input_tokens || 0) > cfg.cold_cache.rewrite_min_tokens)) continue;
    const trig = prompts.filter((p) => p.ts > prev.ts && p.ts <= q.ts).pop();
    if (trig?.c.machine) coldMachine += 1;
    else { coldHuman += 1; if (!trig) coldUnattributed += 1; }
  }
  // the skips the hook makes, re-derived with the hook's own predicate
  let machineSkips = 0;
  for (const p of prompts) {
    if (!p.c.machine) continue;
    const before = mainReqs.filter((q) => q.ts < p.ts).pop();
    if (coldHoldApplies(before, p.ts, cfg)) machineSkips += 1;
  }
  // above the window: did a compaction follow within K main requests?
  let notApplied = 0; let overshoot = 0;
  mainReqs.forEach((q, i) => {
    if (q.ctx <= cfg.window_tokens) return;
    const until = mainReqs[i + cfg.overshoot_follow_requests]?.ts ?? Infinity;
    if (compactions.some((c) => c.ts > q.ts && c.ts <= until)) overshoot += 1; else notApplied += 1;
  });
  const waves = [...new Set(prompts.filter((p) => p.c.dispatch).map((p) => p.c.dispatch.base))];

  let usd = 0; let usdAbove = 0; let unpriced = 0; let out = 0; let writes = 0;
  for (const q of reqs) {
    out += q.usage.output_tokens || 0;
    writes += q.usage.cache_creation_input_tokens || 0;
    const c = requestCost(q, cfg);
    if (c === null) { unpriced += 1; continue; }
    usd += c;
    if (q.ctx > cfg.share_threshold_tokens) usdAbove += c;
  }
  const top = results
    .map((r) => ({ ...r, tool: tools.get(r.id)?.name ?? null, target: toolTarget(tools.get(r.id)?.input) }))
    .sort((a, b) => b.bytes - a.bytes).slice(0, 10)
    .map((r) => ({ tool: r.tool, target: r.target, est_tokens: Math.round(r.bytes / cfg.bytes_per_token) }));

  const overReason = notApplied ? 'WINDOW_NOT_APPLIED' : overshoot ? 'OVERSHOOT' : null;
  const reasons = [];
  if (waves.length > 1) reasons.push('MULTI_WAVE');
  if (coldHuman > cfg.cold_cache.max_human_rewrites_per_session) reasons.push('COLD_REWRITES');
  if (overReason) reasons.push(overReason);
  const verdict = responses === 0 ? 'EMPTY' : withUsage === 0 ? 'INDETERMINATE' : reasons.length ? 'OVER' : 'PASS';
  const round = (x) => Math.round(x * 10000) / 10000;

  return {
    v: 1,
    type: 'session',
    session_id: sessionId,
    project,
    project_dir: transcript ? basename(dirname(transcript)) : null,
    transcript: transcript ? basename(transcript) : null,
    first_ts: Number.isFinite(first) ? new Date(first).toISOString() : null,
    last_ts: Number.isFinite(last) ? new Date(last).toISOString() : null,
    hours: Number.isFinite(first) ? round((last - first) / 3.6e6) : 0,
    requests: { main: mainReqs.length, subagent: reqs.length - mainReqs.length },
    context: { first_request: mainReqs[0]?.ctx ?? 0, p50: pct(ctxs, 50), p90: pct(ctxs, 90), max: ctxs[ctxs.length - 1] ?? 0 },
    share_above_threshold: { threshold: cfg.share_threshold_tokens, cost_share: usd ? round(usdAbove / usd) : 0 },
    cache_write_tokens: writes,
    cold_rewrites_human: coldHuman,
    cold_rewrites_machine: coldMachine,
    cold_rewrites_unattributed: coldUnattributed,
    machine_skips: machineSkips,
    compactions: compactions.length,
    waves,
    skills,
    mcp,
    top_tool_results: top,
    output_tokens: out,
    list_usd: round(usd),
    list_usd_above_threshold: round(usdAbove),
    unpriced_requests: unpriced,
    unparsed_lines: bad + subagents.reduce((n, s) => n + (s.bad || 0), 0),
    responses,
    over_reason: overReason,
    over_reasons: reasons,
    verdict,
  };
}

export function summarizeFile(transcript, cfg) {
  const s = readSessionFiles(transcript);
  return summarizeSession({ ...s, transcript, sessionId: basename(transcript, '.jsonl') }, cfg);
}

// ── the prompt hook's fast reads ──────────────────────────────────────────────

function readTail(file, bytes) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), whole: start === 0 };
  } finally { closeSync(fd); }
}

/** The newest main-thread request: timestamp, context, model, usage. Reads the tail first. */
export function lastMainRequest(file) {
  for (const n of [512 * 1024, 8 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
    const { text, whole } = readTail(file, n);
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= (whole ? 0 : 1); i--) {
      if (!lines[i].includes('"assistant"')) continue;
      let r;
      try { r = JSON.parse(lines[i]); } catch { continue; }
      if (!isRequestRecord(r) || r.isSidechain || !r.message?.usage) continue;
      return { ts: Date.parse(r.timestamp), tsIso: r.timestamp, ctx: contextOf(r.message.usage), model: r.message.model, usage: r.message.usage };
    }
    if (whole) return null;
  }
  return null;
}

/** Every wave this transcript dispatched, in order — only lines carrying the literal are parsed. */
export function dispatchHistory(file, cfg) {
  const buf = readFileSync(file);
  const needle = Buffer.from('Read Prompt/');
  const out = [];
  let pos = 0;
  while ((pos = buf.indexOf(needle, pos)) !== -1) {
    const s = buf.lastIndexOf(0x0a, pos) + 1;
    let e = buf.indexOf(0x0a, pos);
    if (e === -1) e = buf.length;
    try {
      const r = JSON.parse(buf.toString('utf8', s, e));
      const t = promptText(r);
      const c = t === null ? null : classifyPrompt(t, cfg);
      if (c?.dispatch) out.push({ ...c.dispatch, ts: r.timestamp });
    } catch { /* a partial or foreign line is not a dispatch */ }
    pos = e + 1;
  }
  return out;
}

const kTok = (n) => `${Math.round((n || 0) / 1000)}k`;

function coldMessage(last, nowMs, cfg) {
  const gap = nowMs - last.ts;
  const idle = `${Math.floor(gap / 3_600_000)}:${String(Math.floor((gap % 3_600_000) / 60_000)).padStart(2, '0')}`;
  const ttl = (last.usage?.cache_creation?.ephemeral_1h_input_tokens || 0) > 0 ? '1h'
    : (last.usage?.cache_creation?.ephemeral_5m_input_tokens || 0) > 0 ? '5m' : cfg.prices.default_write_ttl;
  const mult = cfg.prices.cache_write_multiplier[ttl];
  const p = priceFor(last.model, last.ctx, cfg);
  const usd = p ? `≈ $${((last.ctx * p.input * mult) / 1e6).toFixed(2)} list` : '≈ $? list, model unpriced';
  return `Cache expired (idle ${idle}). Context ${kTok(last.ctx)} → this prompt re-writes it at ${mult}× (${usd}). `
    + 'Send again to continue, or start a new session from the wave\'s last status.md entry.';
}

/**
 * The prompt hook's whole decision, pure. Refusal is checked first: a second wave belongs in a
 * new session whether or not the cache is warm.
 */
export function decidePrompt({ text, history = [], last = null, state = {}, nowMs }, cfg) {
  const c = classifyPrompt(text, cfg);
  const s = { ...state };
  const bump = (k) => { s[k] = (s[k] || 0) + 1; };
  if (c.dispatch) {
    const prior = [...new Set(history.map((h) => h.base))];
    if (prior.length && !prior.includes(c.dispatch.base) && !c.override) {
      bump('refusals');
      const a = history[history.length - 1].base;
      return {
        action: 'block', kind: 'refuse_wave', state: s,
        reason: `This session already ran ${a} (context ${kTok(last?.ctx)}). Start a new session for ${c.dispatch.base} — one wave per session. Add ${cfg.dispatch.override_token} to override.`,
      };
    }
  }
  if (coldHoldApplies(last, nowMs, cfg)) {
    if (c.machine) { bump('machine_skips'); return { action: 'allow', kind: 'machine_skip', state: s }; }
    if (s.held_for !== last.tsIso) {
      bump('holds');
      s.held_for = last.tsIso;
      return { action: 'block', kind: 'cold_hold', state: s, reason: coldMessage(last, nowMs, cfg) };
    }
    return { action: 'allow', kind: 'cold_pass', state: s };
  }
  return { action: 'allow', kind: 'allow', state: null };
}

/** The ≤ max-bytes re-orientation line after a compaction, or '' when no wave is recorded. */
export function compactMessage(history, cfg) {
  if (!history.length) return '';
  const h = history[history.length - 1];
  let m = `Wave ${h.base} · spec Prompt/${h.file}.md · re-read the current chapter and the wave's last status.md entry before continuing.`;
  while (Buffer.byteLength(m) > cfg.compact_message_max_bytes) m = `${m.slice(0, -2)}…`;
  return m;
}

// ── state ─────────────────────────────────────────────────────────────────────

const safeId = (id) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`unsafe session id: ${String(id).slice(0, 40)}`);
  return id;
};
function readState(id, env) {
  const f = join(stateDir(env), `${safeId(id)}.json`);
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}
function writeState(id, s, env) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${safeId(id)}.json`);
  const tmp = `${f}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ ...s, updated_at: new Date().toISOString() })}\n`);
  renameSync(tmp, f);
}

// ── ledger + rolling readout ──────────────────────────────────────────────────

function appendLine(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

/** Best-effort: an error line in the ledger, else in the state dir. Never throws. */
function recordError(mode, err, env = process.env) {
  const line = { v: 1, type: 'error', at: new Date().toISOString(), mode, message: String(err?.message ?? err).slice(0, 300) };
  try { appendLine(ledgerPath(vaultRoot(env)), line); return; } catch { /* fall through */ }
  try { appendLine(join(stateDir(env), 'errors.jsonl'), line); } catch { /* nothing left to try */ }
}

export function readLedger(file) {
  if (!existsSync(file)) return [];
  return parseJsonl(readFileSync(file, 'utf8')).recs.filter((r) => r?.type === 'session' && r.session_id);
}

/** Latest line per session wins: a session that ends, resumes and ends again is re-measured whole. */
export function latestPerSession(lines) {
  const m = new Map();
  for (const l of lines) m.set(l.session_id, l);
  return [...m.values()];
}

function withLock(env, fn) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'ledger.lock');
  try { if (Date.now() - statSync(lock).mtimeMs > 600_000) rmSync(lock, { recursive: true, force: true }); } catch { /* no lock */ }
  try { mkdirSync(lock); } catch { return false; }
  try { fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
  return true;
}

/** Main transcripts (not subagent files) under the projects dir, with their mtimes. */
export function listTranscripts(env = process.env) {
  const root = projectsDir(env);
  const out = [];
  if (!existsSync(root)) return out;
  for (const p of readdirSync(root)) {
    const dir = join(root, p);
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, f);
      try { out.push({ file, project_dir: p, mtimeMs: statSync(file).mtimeMs }); } catch { /* raced a delete */ }
    }
  }
  return out;
}

export function rollup(sessions, cfg, { fromMs, toMs, instrument }) {
  const counted = sessions.filter((s) => s.verdict !== 'EMPTY');
  const by = (v) => counted.filter((s) => s.verdict === v);
  const reason = (r) => counted.filter((s) => s.over_reasons.includes(r)).length;
  const sum = (f, xs = counted) => xs.reduce((n, s) => n + (f(s) || 0), 0);
  const usd = sum((s) => s.list_usd);
  const firsts = counted.map((s) => s.context.first_request).filter((x) => x > 0).sort((a, b) => a - b);
  const over = by('OVER').length;
  const indet = by('INDETERMINATE').length;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    sessions: counted.length,
    empty: sessions.length - counted.length,
    over,
    over_by_reason: Object.fromEntries(['MULTI_WAVE', 'COLD_REWRITES', 'WINDOW_NOT_APPLIED', 'OVERSHOOT'].map((r) => [r, reason(r)])),
    indeterminate: indet,
    pass: by('PASS').length,
    cost_share_above_threshold: usd ? sum((s) => s.list_usd_above_threshold) / usd : 0,
    cost_share_long_sessions: usd ? sum((s) => s.list_usd, counted.filter((s) => s.hours >= cfg.long_session_hours)) / usd : 0,
    first_request_p50: pct(firsts, 50),
    cold_rewrites_human: sum((s) => s.cold_rewrites_human),
    cold_rewrites_machine: sum((s) => s.cold_rewrites_machine),
    machine_skips: sum((s) => s.machine_skips),
    max_human_rewrites_in_one_session: Math.max(0, ...counted.map((s) => s.cold_rewrites_human)),
    max_context: Math.max(0, ...counted.map((s) => s.context.max)),
    list_usd: usd,
    unpriced_requests: sum((s) => s.unpriced_requests),
    instrument,
    prices_as_of: cfg.prices.as_of,
    verdict: over ? 'OVER' : indet ? 'INDETERMINATE' : 'PASS',
  };
}

const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;

export function renderSummary(r, cfg) {
  const ob = r.over_by_reason;
  return [
    `${TAG} ${r.from} → ${r.to} · ${r.sessions} session(s) counted · ${r.empty} EMPTY · instrument ${r.instrument} · prices as_of ${r.prices_as_of}`,
    `${TAG}   OVER ${r.over} (MULTI_WAVE ${ob.MULTI_WAVE} · COLD_REWRITES ${ob.COLD_REWRITES} · WINDOW_NOT_APPLIED ${ob.WINDOW_NOT_APPLIED} · OVERSHOOT ${ob.OVERSHOOT}) · INDETERMINATE ${r.indeterminate} · PASS ${r.pass}`,
    `${TAG}   cost-weighted share above ${kTok(cfg.share_threshold_tokens)}: ${fmtPct(r.cost_share_above_threshold)} (E1 /usage baseline ${fmtPct(cfg.baseline.e1_share_above_150k)}) · sessions active ${cfg.long_session_hours} h+: ${fmtPct(r.cost_share_long_sessions)} of cost`,
    `${TAG}   first-request context p50 ${kTok(r.first_request_p50)} (baseline ${kTok(cfg.baseline.first_request_context_tokens)}) · max context ${kTok(r.max_context)} (window ${kTok(cfg.window_tokens)})`,
    `${TAG}   cold re-writes human ${r.cold_rewrites_human} · machine ${r.cold_rewrites_machine} · machine skips ${r.machine_skips} · most human in one session ${r.max_human_rewrites_in_one_session}`,
    `${TAG}   list estimate $${r.list_usd.toFixed(2)} · unpriced requests ${r.unpriced_requests}`,
  ].join('\n');
}

export function renderLatest(r, sessions, cfg) {
  const ob = r.over_by_reason;
  const rows = sessions.filter((s) => s.verdict !== 'EMPTY')
    .sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts))).slice(0, cfg.latest_max_rows)
    .map((s) => `| ${String(s.session_id).slice(0, 8)} | ${basename(String(s.project ?? '?'))} | ${s.hours.toFixed(1)} | ${kTok(s.context.max)} | ${s.waves.join(', ') || '—'} | ${s.cold_rewrites_human}/${s.cold_rewrites_machine} | ${s.list_usd.toFixed(2)} | ${s.verdict} | ${s.over_reasons.join(', ') || '—'} |`);
  return [
    `# Session budget — rolling ${cfg.report_window_days} d`,
    '',
    '> Generated by the session-budget meter (OPS-SESSION-BUDGET-W1) on every ledger write. Do not edit: it is rewritten whole.',
    '',
    `SESSION_BUDGET_VERDICT=${r.verdict}`,
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Window | ${r.from} → ${r.to} |`,
    `| Sessions | ${r.sessions} counted · ${r.empty} EMPTY |`,
    `| OVER | ${r.over} (MULTI_WAVE ${ob.MULTI_WAVE} · COLD_REWRITES ${ob.COLD_REWRITES} · WINDOW_NOT_APPLIED ${ob.WINDOW_NOT_APPLIED} · OVERSHOOT ${ob.OVERSHOOT}) |`,
    `| INDETERMINATE | ${r.indeterminate} |`,
    `| Cost-weighted share above ${kTok(cfg.share_threshold_tokens)} | ${fmtPct(r.cost_share_above_threshold)} (E1 /usage: ${fmtPct(cfg.baseline.e1_share_above_150k)}) |`,
    `| Sessions active ${cfg.long_session_hours} h+ | ${fmtPct(r.cost_share_long_sessions)} of cost |`,
    `| First-request context p50 | ${kTok(r.first_request_p50)} (baseline ${kTok(cfg.baseline.first_request_context_tokens)}) |`,
    `| Max context | ${kTok(r.max_context)} (window ${kTok(cfg.window_tokens)}) |`,
    `| Cold re-writes | human ${r.cold_rewrites_human} · machine ${r.cold_rewrites_machine} · machine skips ${r.machine_skips} · most human in one session ${r.max_human_rewrites_in_one_session} |`,
    `| List estimate | $${r.list_usd.toFixed(2)} (prices as_of ${r.prices_as_of}; ${r.unpriced_requests} unpriced requests) |`,
    `| Instrument | ${r.instrument} |`,
    '',
    '| Session | Project | Hours | Max ctx | Waves | Cold h/m | $ list | Verdict | Reasons |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Append lines for sessions idle past the backfill floor that have none. Bounded per run. */
function backfill(root, cfg, env) {
  const have = new Set(readLedger(ledgerPath(root)).map((l) => l.session_id));
  const now = Date.now();
  const lo = now - cfg.report_window_days * 86_400_000;
  const hi = now - cfg.backfill_idle_hours * 3_600_000;
  let n = 0;
  for (const t of listTranscripts(env).sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (n >= cfg.backfill_max_per_run) break;
    if (t.mtimeMs < lo || t.mtimeMs > hi) continue;
    const id = basename(t.file, '.jsonl');
    if (have.has(id)) continue;
    const s = summarizeFile(t.file, cfg);
    if (s.verdict === 'EMPTY') continue;
    appendLine(ledgerPath(root), { ...s, source: 'backfill', end_reason: null, hook: null, instrument: instrumentMeta(cfg), recorded_at: new Date().toISOString() });
    n += 1;
  }
  return n;
}

function writeLatest(root, cfg) {
  const now = Date.now();
  const from = now - cfg.report_window_days * 86_400_000;
  const sessions = latestPerSession(readLedger(ledgerPath(root))).filter((s) => Date.parse(s.last_ts) >= from);
  const r = rollup(sessions, cfg, { fromMs: from, toMs: now, instrument: instrumentSha() });
  writeAtomic(latestPath(root), renderLatest(r, sessions, cfg));
  return r;
}

const instrumentMeta = (cfg) => ({ sha: instrumentSha(), prices_as_of: cfg.prices.as_of, bytes_per_token: cfg.bytes_per_token });

/** The detached half of `--on end`: one line for this session, the backfill, the rolling readout. */
export function ledgerSession({ transcript, sessionId, reason }, cfg, env = process.env) {
  const root = vaultRoot(env);
  const s = summarizeSession({ ...readSessionFiles(transcript), transcript, sessionId }, cfg);
  let hook = null;
  try { const st = readState(sessionId, env); if (Object.keys(st).length) hook = st; } catch { /* report-only */ }
  appendLine(ledgerPath(root), { ...s, source: 'session_end', end_reason: reason ?? null, hook, instrument: instrumentMeta(cfg), recorded_at: new Date().toISOString() });
  withLock(env, () => { backfill(root, cfg, env); writeLatest(root, cfg); });
  return s;
}

// ── --report ──────────────────────────────────────────────────────────────────

export function parseSince(s) {
  const m = /^(\d+)([dh])$/.exec(String(s ?? ''));
  if (!m) throw new Error(`--since wants <n>d or <n>h, got ${s}`);
  return Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
}

export function report({ sinceMs, project = null }, cfg, env = process.env) {
  const now = Date.now();
  const from = now - sinceMs;
  const files = listTranscripts(env).filter((t) => t.mtimeMs >= from && (!project || t.project_dir.includes(project)));
  const sessions = [];
  for (const t of files) {
    const s = summarizeFile(t.file, cfg);
    if (s.last_ts && Date.parse(s.last_ts) >= from) sessions.push({ ...s, project_dir: t.project_dir });
  }
  return { r: rollup(sessions, cfg, { fromMs: from, toMs: now, instrument: instrumentSha() }), sessions, scanned: files.length };
}

// ── --skill-overrides ─────────────────────────────────────────────────────────

/**
 * Which user skills go name-only (ruling Q3): no retained transcript invokes them — by the Skill
 * tool, a slash command, or a loaded skill body — AND Claude Code's own skillUsage counter has
 * no use inside the window. Plugin skills are out of reach of skillOverrides and are not listed.
 */
export function skillOverrides(cfg, env = process.env, nowMs = Date.now()) {
  const dir = join(claudeDir(env), 'skills');
  const skills = [];
  for (const d of existsSync(dir) ? readdirSync(dir) : []) {
    const f = join(dir, d, 'SKILL.md');
    if (!existsSync(f)) continue;
    const name = /^name:\s*(.+?)\s*$/m.exec(readFileSync(f, 'utf8'))?.[1]?.replace(/^["']|["']$/g, '') || d;
    skills.push({ dir: d, name });
  }
  const used = new Map();
  const hit = (k) => used.set(k, (used.get(k) || 0) + 1);
  const files = listTranscripts(env).map((t) => t.file);
  for (const t of files) {
    const sub = join(dirname(t), basename(t, '.jsonl'), 'subagents');
    if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(join(sub, f));
  }
  let scanned = 0;
  for (const f of files) {
    let buf;
    try { buf = readFileSync(f); } catch { continue; }
    scanned += 1;
    for (const needle of ['"name":"Skill"', '<command-name>', 'Base directory for this skill:']) {
      const nb = Buffer.from(needle);
      let pos = 0;
      while ((pos = buf.indexOf(nb, pos)) !== -1) {
        const s = buf.lastIndexOf(0x0a, pos) + 1;
        let e = buf.indexOf(0x0a, pos);
        if (e === -1) e = buf.length;
        const line = buf.toString('utf8', s, e);
        try {
          const r = JSON.parse(line);
          for (const b of Array.isArray(r.message?.content) ? r.message.content : []) {
            if (b?.type === 'tool_use' && b.name === 'Skill' && typeof b.input?.skill === 'string') hit(b.input.skill);
          }
          const raw = typeof r.message?.content === 'string' ? r.message.content
            : (r.message?.content || []).filter?.((b) => b?.type === 'text').map((b) => b.text).join('\n') ?? '';
          for (const m of String(raw).matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) hit(m[1]);
          const sk = SKILL_LOAD.exec(String(raw));
          if (sk) hit(basename(sk[1]));
        } catch { /* a line we cannot parse names no skill */ }
        pos = e + 1;
      }
    }
  }
  let usage = {};
  try { usage = JSON.parse(readFileSync(claudeJsonPath(env), 'utf8')).skillUsage || {}; } catch { /* no counter: transcripts alone decide */ }
  const cutoff = nowMs - cfg.skill_name_only_window_days * 86_400_000;
  const nameOnly = {};
  const kept = [];
  for (const s of skills) {
    const inTranscripts = (used.get(s.name) || 0) + (s.dir !== s.name ? used.get(s.dir) || 0 : 0);
    const u = usage[s.name] || usage[s.dir];
    const recent = u && Number(u.lastUsedAt) >= cutoff;
    if (inTranscripts === 0 && !recent) nameOnly[s.name] = 'name-only';
    else kept.push({ name: s.name, transcripts: inTranscripts, last_used_at: u ? new Date(Number(u.lastUsedAt)).toISOString() : null });
  }
  return { nameOnly: Object.fromEntries(Object.entries(nameOnly).sort()), kept, skills: skills.length, scanned };
}

// ── self-test fixtures, in the producer's vocabulary ──────────────────────────

/**
 * Transcript records shaped as Claude Code writes them (measured R0): one API response split
 * across records sharing message.id with identical usage, the cache_creation TTL breakdown,
 * `<synthetic>` error records, compact_boundary with compactMetadata, prompt records with
 * origin, and subagent files with isSidechain.
 */
export const makeFixtures = (t0) => ({
  t0,
  at(min) { return new Date(this.t0 + min * 60_000).toISOString(); },
  prompt(min, text, kind = 'human') {
    return { type: 'user', message: { role: 'user', content: text }, timestamp: this.at(min), cwd: '/fixture/project',
      origin: { kind }, promptSource: 'sdk', uuid: `u-${min}-${text.length}`, sessionId: 'fixture' };
  },
  reply(min, id, ctx, { write = 0, out = 500, model = 'claude-opus-5-5', blocks = 2, sidechain = false, tool = null } = {}) {
    const usage = { input_tokens: 3, cache_read_input_tokens: Math.max(0, ctx - 3 - write), cache_creation_input_tokens: write,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write }, output_tokens: out,
      service_tier: 'standard', iterations: [] };
    const recs = [];
    for (let i = 0; i < blocks; i++) {
      const content = i === blocks - 1 && tool ? [{ type: 'tool_use', id: `${id}-t`, name: tool.name, input: tool.input }] : [{ type: 'thinking', thinking: '' }];
      recs.push({ type: 'assistant', message: { id, model, role: 'assistant', type: 'message', content, usage },
        requestId: `req-${id}`, timestamp: this.at(min), isSidechain: sidechain, uuid: `a-${id}-${i}`, cwd: '/fixture/project' });
    }
    return recs;
  },
  result(min, toolUseId, text) {
    return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
      toolUseResult: { type: 'text' }, timestamp: this.at(min), uuid: `r-${min}` };
  },
  compact(min, pre = 230000) {
    return { type: 'system', subtype: 'compact_boundary', timestamp: this.at(min),
      compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: 35000 } };
  },
  synthetic(min) {
    return { type: 'assistant', isApiErrorMessage: true, timestamp: this.at(min),
      message: { id: `syn-${min}`, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate' }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
  },
  jsonl(recs) { return `${recs.flat().map((r) => JSON.stringify(r)).join('\n')}\n`; },
});
export const fixtures = makeFixtures(Date.parse('2026-10-20T00:00:00.000Z'));

/** Named scenarios shared by --self-test and the vitest suite. */
export function scenarios(f = fixtures) {
  return {
    pass: [f.prompt(0, 'Read Prompt/OPS-A-W1.md. Plan-Mode required.'), f.reply(0.1, 'm1', 90000, { write: 60000 }),
      f.reply(1, 'm2', 95000, { tool: { name: 'Read', input: { file_path: '/fixture/big.md' } } }), f.result(1.1, 'm2-t', 'x'.repeat(4980)),
      f.prompt(2, 'Read Prompt/OPS-A-W1-V2.md'), f.reply(2.1, 'm3', 100000)],
    two_waves: [f.prompt(0, 'Read Prompt/OPS-A-W1.md'), f.reply(0.1, 'm1', 90000), f.prompt(5, 'Read Prompt/OPS-B-W1.md [same-session]'), f.reply(5.1, 'm2', 95000)],
    cold_human: [f.prompt(0, 'Read Prompt/OPS-A-W1.md'), f.reply(0.1, 'm1', 160000),
      f.prompt(70, 'continue'), f.reply(70.1, 'm2', 161000, { write: 160000 }),
      f.prompt(140, 'continue again'), f.reply(140.1, 'm3', 162000, { write: 161000 })],
    cold_machine: [f.prompt(0, 'Read Prompt/OPS-A-W1.md'), f.reply(0.1, 'm1', 160000),
      f.prompt(70, '<task-notification>done</task-notification>', 'task-notification'), f.reply(70.1, 'm2', 161000, { write: 160000 }),
      f.prompt(140, '<task-notification>done</task-notification>', 'task-notification'), f.reply(140.1, 'm3', 162000, { write: 161000 })],
    not_applied: [f.prompt(0, 'go'), f.reply(1, 'm1', 240000), f.reply(2, 'm2', 260000), f.reply(3, 'm3', 270000), f.reply(4, 'm4', 280000), f.reply(5, 'm5', 290000)],
    overshoot: [f.prompt(0, 'go'), f.reply(1, 'm1', 240000), f.reply(2, 'm2', 262000), f.compact(2.5), f.reply(3, 'm3', 40000)],
    no_usage: [f.prompt(0, 'go'), [{ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [] }, timestamp: f.at(1) }]],
    empty: [f.prompt(0, 'BLOCKME'), f.synthetic(0.1)],
    multiline_dispatch: [f.prompt(0, 'Read Prompt/OPS-A-W1.md\nPrompt/notes.md'), f.reply(0.1, 'm1', 90000)],
  };
}

function selfTest(cfg) {
  const fails = [];
  let n = 0;
  const eq = (label, got, want) => { n += 1; if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
  const sc = scenarios();
  const sum = (k) => summarizeSession({ main: parseJsonl(fixtures.jsonl(sc[k])).recs }, cfg);
  const built = Object.keys(sc).length;
  if (built === 0) fails.push('the fixture corpus is empty — the self-test built nothing');

  const pass = sum('pass');
  eq('pass: verdict', pass.verdict, 'PASS');
  eq('pass: split records dedupe to 3 requests', pass.requests.main, 3);
  eq('pass: -V2 is the same base wave', pass.waves, ['OPS-A-W1']);
  eq('pass: first-request context', pass.context.first_request, 90000);
  eq('pass: top tool result est_tokens', pass.top_tool_results[0]?.est_tokens, Math.round(4980 / cfg.bytes_per_token));
  eq('pass: top tool result target', pass.top_tool_results[0]?.target, '/fixture/big.md');
  eq('two waves: OVER MULTI_WAVE', [sum('two_waves').verdict, sum('two_waves').over_reasons], ['OVER', ['MULTI_WAVE']]);
  const ch = sum('cold_human');
  eq('cold human: 2 human re-writes ⇒ OVER', [ch.verdict, ch.cold_rewrites_human, ch.over_reasons], ['OVER', 2, ['COLD_REWRITES']]);
  const cm = sum('cold_machine');
  eq('cold machine: tagged machine, not judged', [cm.verdict, cm.cold_rewrites_machine, cm.cold_rewrites_human, cm.machine_skips], ['PASS', 2, 0, 2]);
  eq('not applied: WINDOW_NOT_APPLIED', [sum('not_applied').verdict, sum('not_applied').over_reason], ['OVER', 'WINDOW_NOT_APPLIED']);
  eq('overshoot: OVERSHOOT', [sum('overshoot').verdict, sum('overshoot').over_reason], ['OVER', 'OVERSHOOT']);
  eq('no usage: INDETERMINATE', sum('no_usage').verdict, 'INDETERMINATE');
  eq('empty: EMPTY', sum('empty').verdict, 'EMPTY');
  eq('a dispatch never spans a newline', sum('multiline_dispatch').waves, ['OPS-A-W1']);

  // the hook's decisions
  const last = { ts: fixtures.t0, tsIso: fixtures.at(0), ctx: 200000, model: 'claude-opus-5-5', usage: { cache_creation: { ephemeral_1h_input_tokens: 1 } } };
  const hist = [{ base: 'OPS-A-W1', file: 'OPS-A-W1' }];
  const warm = fixtures.t0 + 60_000;
  const cold = fixtures.t0 + (cfg.cold_cache.idle_seconds + 60) * 1000;
  eq('refuse a second wave', decidePrompt({ text: 'Read Prompt/OPS-B-W1.md', history: hist, last, nowMs: warm }, cfg).kind, 'refuse_wave');
  eq('allow a -V2 of the same wave', decidePrompt({ text: 'Read Prompt/OPS-A-W1-V2.md', history: hist, last, nowMs: warm }, cfg).action, 'allow');
  eq('allow an -R2 of the same wave', decidePrompt({ text: 'Read Prompt/OPS-A-W1-R2.md', history: hist, last, nowMs: warm }, cfg).action, 'allow');
  eq('allow [same-session]', decidePrompt({ text: 'Read Prompt/OPS-B-W1.md [same-session]', history: hist, last, nowMs: warm }, cfg).action, 'allow');
  const h1 = decidePrompt({ text: 'continue', history: hist, last, nowMs: cold }, cfg);
  eq('cold: held once', h1.kind, 'cold_hold');
  eq('cold: the hold names the cost', /≈ \$\d+\.\d\d list/.test(h1.reason), true);
  eq('cold: the next send passes', decidePrompt({ text: 'continue', history: hist, last, state: h1.state, nowMs: cold }, cfg).kind, 'cold_pass');
  eq('cold: a machine turn is skipped and counted', decidePrompt({ text: '<task-notification>x', history: hist, last, nowMs: cold }, cfg).state?.machine_skips, 1);
  eq('warm: plain allow, no state written', decidePrompt({ text: 'continue', history: hist, last, nowMs: warm }, cfg).state, null);
  eq('small context: no hold', decidePrompt({ text: 'continue', history: hist, last: { ...last, ctx: 1000 }, nowMs: cold }, cfg).kind, 'allow');
  const cmsg = compactMessage(hist, cfg);
  eq('compact: names the wave and spec', cmsg.startsWith('Wave OPS-A-W1 · spec Prompt/OPS-A-W1.md'), true);
  eq('compact: within the byte cap', Buffer.byteLength(compactMessage([{ base: 'X'.repeat(500), file: 'Y' }], cfg)) <= cfg.compact_message_max_bytes, true);
  eq('compact: nothing without a wave', compactMessage([], cfg), '');

  // the token → exit mapping, which a token-only assertion cannot see
  eq('exit map', [EXIT.PASS, EXIT.OVER, EXIT.INDETERMINATE], [0, 1, 3]);
  const ro = rollup([pass, ch, sum('empty')], cfg, { fromMs: 0, toMs: 1, instrument: 'x' });
  eq('rollup: OVER wins, EMPTY not counted', [ro.verdict, ro.sessions, ro.empty], ['OVER', 2, 1]);
  eq('rollup: zero sessions is a reported PASS', rollup([], cfg, { fromMs: 0, toMs: 1, instrument: 'x' }).verdict, 'PASS');

  if (fails.length) {
    fails.forEach((x) => console.error(`  ✗ ${x}`));
    console.error(`${TAG} self-test FAILED (${fails.length} of ${n})`);
    return 'INDETERMINATE';
  }
  console.log(`${TAG} self-test passed (${n} assertions over ${built} scenarios)`);
  return n > 0 ? 'PASS' : 'INDETERMINATE';
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

function verdict(v) {
  console.log(`SESSION_BUDGET_VERDICT=${v}`);
  process.exitCode = EXIT[v];
}

function hookInput() {
  const raw = readFileSync(0, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function main() {
  const on = arg('--on');
  if (on === 'prompt') {
    try {
      const cfg = loadConfig();
      const inp = hookInput();
      const id = safeId(inp.session_id);
      const tp = typeof inp.transcript_path === 'string' && existsSync(inp.transcript_path) ? inp.transcript_path : null;
      const d = decidePrompt({ text: inp.prompt, history: tp ? dispatchHistory(tp, cfg) : [], last: tp ? lastMainRequest(tp) : null,
        state: readState(id), nowMs: Date.now() }, cfg);
      if (d.state) writeState(id, d.state);
      if (d.action === 'block') process.stdout.write(`${JSON.stringify({ decision: 'block', reason: d.reason })}\n`);
    } catch (e) { recordError('prompt', e); }
    return;
  }
  if (on === 'compact') {
    try {
      const cfg = loadConfig();
      const inp = hookInput();
      const tp = typeof inp.transcript_path === 'string' && existsSync(inp.transcript_path) ? inp.transcript_path : null;
      const m = tp ? compactMessage(dispatchHistory(tp, cfg), cfg) : '';
      if (m) process.stdout.write(`${m}\n`);
    } catch (e) { recordError('compact', e); }
    return;
  }
  if (on === 'end') {
    try {
      const inp = hookInput();
      const id = safeId(inp.session_id);
      if (typeof inp.transcript_path !== 'string' || !existsSync(inp.transcript_path)) throw new Error('SessionEnd gave no readable transcript_path');
      const child = spawn(process.execPath, [SELF, '--ledger-session', inp.transcript_path, '--session-id', id, '--end-reason', String(inp.reason ?? '')],
        { detached: true, stdio: 'ignore', env: process.env });
      child.unref();
    } catch (e) { recordError('end', e); }
    return;
  }
  if (on !== null) { recordError('cli', new Error(`unknown --on ${on}`)); return; }

  if (process.argv.includes('--ledger-session')) {
    try {
      ledgerSession({ transcript: arg('--ledger-session'), sessionId: safeId(arg('--session-id')), reason: arg('--end-reason') || null }, loadConfig());
    } catch (e) { recordError('ledger', e); }
    return;
  }

  let cfg;
  try { cfg = loadConfig(arg('--config') || DEFAULT_CONFIG); } catch (e) {
    console.error(`${TAG} config unreadable: ${e.message}`);
    verdict('INDETERMINATE');
    return;
  }

  if (process.argv.includes('--self-test')) { verdict(selfTest(cfg)); return; }

  if (process.argv.includes('--report')) {
    try {
      const { r, sessions, scanned } = report({ sinceMs: parseSince(arg('--since') || `${cfg.report_window_days}d`), project: arg('--project') }, cfg);
      if (process.argv.includes('--json')) console.log(JSON.stringify({ rollup: r, sessions }, null, 2));
      else console.log(`${TAG} scanned ${scanned} transcript(s)\n${renderSummary(r, cfg)}`);
      verdict(r.verdict);
    } catch (e) {
      console.error(`${TAG} report failed: ${e.message}`);
      verdict('INDETERMINATE');
    }
    return;
  }

  if (process.argv.includes('--skill-overrides')) {
    try {
      const s = skillOverrides(cfg);
      if (s.scanned === 0 || s.skills === 0) {
        console.error(`${TAG} skill census is vacuous: ${s.scanned} transcript(s), ${s.skills} user skill(s)`);
        console.log('SESSION_BUDGET_SKILLS_VERDICT=INDETERMINATE');
        process.exitCode = 3;
        return;
      }
      console.log(JSON.stringify(s.nameOnly));
      console.error(`${TAG} ${Object.keys(s.nameOnly).length} of ${s.skills} user skill(s) name-only · ${s.kept.length} kept · ${s.scanned} transcript file(s) scanned · window ${cfg.skill_name_only_window_days} d`);
      for (const k of s.kept) console.error(`${TAG}   kept ${k.name} (transcripts ${k.transcripts}, last used ${k.last_used_at ?? 'never'})`);
      console.log('SESSION_BUDGET_SKILLS_VERDICT=PASS');
    } catch (e) {
      console.error(`${TAG} skill census failed: ${e.message}`);
      console.log('SESSION_BUDGET_SKILLS_VERDICT=INDETERMINATE');
      process.exitCode = 3;
    }
    return;
  }

  console.error('usage: session-budget.mjs --on prompt|compact|end · --report [--since 7d] [--project <s>] [--json] · --skill-overrides · --self-test');
  verdict('INDETERMINATE');
}

// The pinned install runs through a `current` symlink, and ESM resolves the main module's
// REAL path while argv[1] keeps the symlinked one — compare real paths, or every hook is a no-op.
const invoked = (() => { try { return realpathSync(process.argv[1] || ''); } catch { return ''; } })();
if (invoked === SELF) main();

