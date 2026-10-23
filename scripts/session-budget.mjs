#!/usr/bin/env node
/**
 * session-budget.mjs — OPS-SESSION-BUDGET-W1, cut down by OPS-SESSION-BUDGET-W1-R2
 *
 * Two Claude Code hooks on this Mac, and nothing else. Every value they read lives in
 * ops/session-budget.json.
 *
 *   --on prompt     UserPromptSubmit: refuse a second base wave in one session
 *   --on compact    SessionStart(compact): one line naming the wave to re-orient on
 *
 * ── WHAT R2 REMOVED, AND WHY ──────────────────────────────────────────────────
 * The cold-cache hold, and the meter that wrote a per-session ledger and a rolling readout.
 * Measured at R2's R0 (vault audits/OPS-SESSION-BUDGET-W1-R2-endpoint-truth.md): 2 of 2 held
 * prompts were re-sent unchanged within 41 s, so the hold cost a step and saved no re-write;
 * and the readout only generated questions. Claude Code's own /usage is the scoreboard. The
 * token savers — the 250k autoCompactWindow the installer writes, this one-wave gate, the
 * compact line, auto memory off in the vault, the frozen skillOverrides — cost nothing to run.
 *
 * ── ONE WAVE PER SESSION ──────────────────────────────────────────────────────
 * A dispatch is a prompt matching dispatch.regex (`Read Prompt/<wave>.md`). Its BASE strips a
 * trailing -V<n> / -R<n>, which is a later dispatch of the same wave (ruling Q6). A dispatch
 * whose base differs from every base this transcript already dispatched is refused, unless the
 * prompt carries dispatch.override_token. The history is read from the transcript itself, so
 * the hook keeps no state of its own.
 *
 * ── MACHINE TURNS ─────────────────────────────────────────────────────────────
 * UserPromptSubmit also fires on task notifications, agent hand-backs, scheduled triggers and
 * side-session wake-ups (measured in ~/.claude/session-log.md). A prompt starting with a
 * declared exempt prefix is never a dispatch, whatever dispatch.regex matches, so no edit to
 * the regex can make a machine turn refusable.
 *
 * ── FAIL OPEN ON OUR OWN BUG ──────────────────────────────────────────────────
 * Every hook path catches everything: an internal error allows the prompt, exits 0 and writes
 * an error line under ~/.local/state/algovault/session-budget/. A session tool must never be
 * the thing that stops the work. On an allowed prompt the hook prints NOTHING —
 * UserPromptSubmit stdout is added to context. An unknown --on mode is the same: exit 0,
 * nothing printed, an error line — so a registration left behind by an older install, still
 * held by a running session, never fails that session.
 */
import {
  readFileSync, existsSync, mkdirSync, appendFileSync, openSync, readSync, closeSync, fstatSync, realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
export const DEFAULT_CONFIG = join(HERE, '..', 'ops', 'session-budget.json');

// ── config ────────────────────────────────────────────────────────────────────

/** Load and validate the config. A config we author is CONSTRUCTED: empty or missing = refuse. */
export function loadConfig(file = DEFAULT_CONFIG) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const pos = (v) => Number.isFinite(v) && v > 0;
  for (const k of ['window_tokens', 'compact_message_max_bytes', 'hook_timeout_seconds']) {
    if (!pos(c[k])) throw new Error(`config ${k} is not a positive number`);
  }
  if (!Array.isArray(c.exempt_prompt_prefixes) || c.exempt_prompt_prefixes.length === 0
    || c.exempt_prompt_prefixes.some((p) => typeof p !== 'string' || !p.startsWith('<'))) {
    throw new Error('config exempt_prompt_prefixes must be a non-empty list of "<tag" prefixes');
  }
  new RegExp(c.dispatch?.regex); new RegExp(c.dispatch?.base_strip);
  if (!c.dispatch.override_token) throw new Error('config dispatch.override_token is empty');
  return c;
}

// ── paths ─────────────────────────────────────────────────────────────────────

const home = (env = process.env) => env.HOME || homedir();
export const stateDir = (env = process.env) => join(home(env), '.local', 'state', 'algovault', 'session-budget');

// ── classification ────────────────────────────────────────────────────────────

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

export const contextOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const isRequestRecord = (r) => r?.type === 'assistant' && r.message?.model !== '<synthetic>' && !r.isApiErrorMessage;

// ── transcripts ───────────────────────────────────────────────────────────────

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

/** The prompt hook's whole decision, pure: refuse a second base wave, allow everything else. */
export function decidePrompt({ text, history = [], last = null }, cfg) {
  const c = classifyPrompt(text, cfg);
  if (c.dispatch) {
    const prior = [...new Set(history.map((h) => h.base))];
    if (prior.length && !prior.includes(c.dispatch.base) && !c.override) {
      const a = history[history.length - 1].base;
      return {
        action: 'block', kind: 'refuse_wave',
        reason: `This session already ran ${a} (context ${kTok(last?.ctx)}). Start a new session for ${c.dispatch.base} — one wave per session. Add ${cfg.dispatch.override_token} to override.`,
      };
    }
  }
  return { action: 'allow', kind: 'allow' };
}

/** The ≤ max-bytes re-orientation line after a compaction, or '' when no wave is recorded. */
export function compactMessage(history, cfg) {
  if (!history.length) return '';
  const h = history[history.length - 1];
  let m = `Wave ${h.base} · spec Prompt/${h.file}.md · re-read the current chapter and the wave's last status.md entry before continuing.`;
  while (Buffer.byteLength(m) > cfg.compact_message_max_bytes) m = `${m.slice(0, -2)}…`;
  return m;
}

// ── errors ────────────────────────────────────────────────────────────────────

/** Best-effort: one error line in the state dir. Never throws. */
function recordError(mode, err, env = process.env) {
  const line = { v: 1, type: 'error', at: new Date().toISOString(), mode, message: String(err?.message ?? err).slice(0, 300) };
  try {
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'errors.jsonl'), `${JSON.stringify(line)}\n`);
  } catch { /* nothing left to try */ }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

function hookInput() {
  const raw = readFileSync(0, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

const readableTranscript = (inp) => (typeof inp.transcript_path === 'string' && existsSync(inp.transcript_path) ? inp.transcript_path : null);

function main() {
  const on = arg('--on');
  if (on === 'prompt') {
    try {
      const cfg = loadConfig();
      const inp = hookInput();
      const tp = readableTranscript(inp);
      const history = tp ? dispatchHistory(tp, cfg) : [];
      // only a refusal names the context, and a refusal needs a prior dispatch
      const d = decidePrompt({ text: inp.prompt, history, last: history.length ? lastMainRequest(tp) : null }, cfg);
      if (d.action === 'block') process.stdout.write(`${JSON.stringify({ decision: 'block', reason: d.reason })}\n`);
    } catch (e) { recordError('prompt', e); }
    return;
  }
  if (on === 'compact') {
    try {
      const cfg = loadConfig();
      const tp = readableTranscript(hookInput());
      const m = tp ? compactMessage(dispatchHistory(tp, cfg), cfg) : '';
      if (m) process.stdout.write(`${m}\n`);
    } catch (e) { recordError('compact', e); }
    return;
  }
  if (on !== null) { recordError('cli', new Error(`unknown --on ${on}`)); return; }
  console.error('usage: session-budget.mjs --on prompt|compact   (hook JSON on stdin)');
  process.exitCode = 2;
}

// The pinned install runs through a `current` symlink, and ESM resolves the main module's
// REAL path while argv[1] keeps the symlinked one — compare real paths, or every hook is a no-op.
const invoked = (() => { try { return realpathSync(process.argv[1] || ''); } catch { return ''; } })();
if (invoked === SELF) main();
