#!/usr/bin/env node
/**
 * status-append.mjs — OPS-STATUS-INDEX-LEDGER-W1
 *
 * The one writer of the vault's status.md. A wave's entry goes VERBATIM into its month's ledger
 * (`Old Status/Status <Month> <Year>.md`) at write time; status.md keeps only its header, the
 * open-wave register and a generated index of ledger headings. The size is bounded here, by the
 * generator, never by a later trim.
 *
 *   <entry.md>      append one entry (strict heading grammar), upsert its own register row
 *   --sweep         no new entry: move any hand-appended `### ` block into its ledger, rebuild
 *   --report        read-only: files.* sizes against their caps, register rows over the cap,
 *                   and the verdicts this writer logged (STATUS_BUDGET_VERDICT)
 *   --self-test     hermetic fixtures, both directions (STATUS_APPEND_SELFTEST)
 *   --dry-run       compute and print, write nothing (append / sweep)
 *   --vault <dir> --budget <json> --now <ISO>   overrides (tests, migration rehearsal)
 *
 * ── WHERE THINGS LIVE ─────────────────────────────────────────────────────────
 * The vault root is PROJECTED from scripts/lib/system-map-path.sh, never restated. Its layout —
 * STATUS_FILE, ARCHIVE_DIR, ARCHIVE_FILENAME_PATTERN, SPLIT_FILES — is read from the vault's
 * trim-status-config.md, the same declaration wave-history-build.sh reads. The byte caps are
 * `files.*` in ops/session-budget.json, the one budget manifest for every start-read file.
 *
 * ── THE INDEX (rulings Q1, D2, CORRECTIONS) ───────────────────────────────────
 * DERIVED from the ledger headings on every write — one derivation, so a clobbered or
 * hand-edited index heals on the next write. One row per distinct heading, newest first, each
 * ≤ 200 B: `- \`<pointer>\` <rest of the heading>`. The pointer is the heading's own prefix —
 * timestamp + wave + step — extended word by word until no other ledger heading starts with it,
 * so `grep -F '### <pointer>'` in the ledger finds exactly one entry. The rest is the heading
 * text verbatim, backticks and bold stripped, cut at a code point. No glyph or outcome is
 * inferred from prose (trim-status-config policy v4). A heading with no wave token is indexed by
 * its raw text, never dropped. `(amended copy)` headings and SPLIT_FILES-routed waves are not
 * indexed here.
 * Window: the newest rows that fit after header + register, up to 30 days back, never fewer
 * than the last 7 days. OVER only when header + register + the 7-day floor exceed the cap.
 *
 * ── THE LEDGER (rulings Q5, D7; AC1) ──────────────────────────────────────────
 * An entry is inserted newest-first directly under the ledger's `## Archived entries
 * (newest-first)` (or `## Archived Activity Log`) line; every other byte of the ledger is kept,
 * and the written file is re-read and asserted equal to the old one plus the inserted block.
 * Dedupe across ALL ledgers: same heading + same body → nothing to do (a re-run is a no-op);
 * same heading + different body → `<heading> (amended copy)`, never dropped; an amended copy
 * already there with yet another body → INDETERMINATE. A missing month file is created with
 * the standard header.
 *
 * ── THE REGISTER (ruling Q3) ──────────────────────────────────────────────────
 * An entry carrying `Register: OWED|ARCHITECT [· Owed: <text>] · CLOSE_WHEN: <text>` inserts or
 * updates ITS OWN wave's row. Wave + State + What-is-owed ≤ 600 B (the owed text is cut and
 * points at the entry); CLOSE_WHEN verbatim, uncapped. The writer never sets CLOSED, never
 * touches a CLOSED/NOTED row and never touches another wave's row. A line
 * `<!-- status-append:register-count -->…` under the table is recounted from the table.
 *
 * ── CONTEXT FILES (OPS-CONTEXT-CORPUS-DIET-W1, rulings Q3, Q4, D6) ────────────
 * Every append and sweep also judges every `files.*` cap and prints
 * CONTEXT_FILES_VERDICT=PASS|OVER|INDETERMINATE just before the terminal line. Report-only: it
 * never refuses or changes the write, and the exit code stays the append's. A capped file that
 * is missing is INDETERMINATE (nothing was measured); a path in `files_retired` that exists
 * again is OVER, so a recreated retired file (the WIS log) shows on the next write. --report's
 * STATUS_BUDGET_VERDICT projects from the same contextFiles() value.
 *
 * ── VERDICT ───────────────────────────────────────────────────────────────────
 * One terminal line: STATUS_APPEND_VERDICT=PASS|OVER|INDETERMINATE — exit 0 / 1 / 3. OVER and
 * INDETERMINATE write NOTHING. Every write is compare-and-swap: each file's sha256 is taken when
 * it is read and re-checked just before its atomic rename; a mismatch is INDETERMINATE (the
 * 06:53 UTC lost-update class). A ledger already written when status.md loses the race keeps
 * the entry — the next write's index derives it. Every append/sweep logs one JSON line to
 * `<vault>/Claude files/status-append.jsonl`, which --report reads.
 */
import {
  readFileSync, writeFileSync, existsSync, renameSync, rmSync, readdirSync, mkdirSync, mkdtempSync,
  appendFileSync, realpathSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const REPO = join(HERE, '..', '..');
const TAG = '[status-append]';
export const EXIT = Object.freeze({ PASS: 0, OVER: 1, INDETERMINATE: 3 });
export const DEFAULT_BUDGET = join(REPO, 'ops', 'session-budget.json');
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// Ruled sizes (Q1, Q2). Contract, not tunables: a change is a new ruling, not a config edit.
export const ROW_MAX_BYTES = 200;
export const POINTER_MAX_BYTES = 160;
export const REGISTER_ROW_MAX_BYTES = 600;
export const WINDOW_MAX_DAYS = 30;
export const WINDOW_FLOOR_DAYS = 7;

export const INDEX_START = '<!-- status-append:index:start -->';
export const INDEX_END = '<!-- status-append:index:end -->';
export const COUNT_MARK = '<!-- status-append:register-count -->';
const LEDGER_ANCHORS = ['## Archived entries (newest-first)', '## Archived Activity Log'];
const AMENDED = ' (amended copy)';

/** The heading grammar a NEW entry must meet (ruling: strict for new entries, lenient for the index). */
export const STRICT_HEADING = /^### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC — ([A-Z][A-Z0-9]*(?:-(?:[A-Z0-9]+|v\d+(?:\.\d+)*))+) (\S.*?) — (✅|⚠️?|🛑|⏭️?|⏳) (\S.*)$/u;
export const STRICT_GRAMMAR = '### YYYY-MM-DD HH:MM UTC — <WAVE> <step> — <✅|⚠️|🛑|⏭️|⏳> <outcome>';
/** The lenient wave token the index reads from any heading (R0: 200 of 201 headings carry one). */
const WAVE_TOKEN = /\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\b/;
const REGISTER_LINE = /^Register: (OWED|ARCHITECT)(?: · Owed: (.+?))? · CLOSE_WHEN: (.+)$/;

export class Refusal extends Error {
  constructor(verdict, message) { super(message); this.verdict = verdict; }
}
const indeterminate = (m) => { throw new Refusal('INDETERMINATE', m); };

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Cut s to at most max UTF-8 bytes on a code-point boundary. */
export function cutBytes(s, max) {
  if (bytes(s) <= max) return s;
  let out = '';
  for (const ch of s) { if (bytes(out + ch) > max) break; out += ch; }
  return out;
}

/** cutBytes for a markdown table cell: an open code span or bold run is closed, a half `\|` escape dropped. */
export function cutCell(s, max) {
  if (bytes(s) <= max) return s;
  let out = cutBytes(s, Math.max(0, max - 3)).replace(/\\+$/, '').trimEnd();
  if ((out.match(/`/g) || []).length % 2) out += '`';
  if ((out.replace(/`[^`]*`/g, '').match(/\*\*/g) || []).length % 2) out += '**';
  return out;
}

// ── vault + layout ────────────────────────────────────────────────────────────

/** The vault root, projected from the one declared vault path. */
export function vaultRoot(env = process.env) {
  const lib = join(REPO, 'scripts', 'lib', 'system-map-path.sh');
  if (!existsSync(lib)) indeterminate(`the vault path SoT is missing: ${lib}`);
  const out = execFileSync('/bin/bash', ['-c', '. "$1"; printf "%s" "$ALGOVAULT_SYSTEM_MAP_PATH"', '_', lib],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
  if (!out) indeterminate('the vault path SoT defined no path');
  const root = dirname(out);
  if (!existsSync(root)) indeterminate(`the vault root does not exist: ${root}`);
  return root;
}

function section(text, name) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (i === -1) return null;
  const out = [];
  for (const l of lines.slice(i + 1)) { if (l.startsWith('## ')) break; out.push(l); }
  return out;
}
function firstValue(text, name) {
  const s = section(text, name);
  const v = s?.map((l) => l.trim()).find(Boolean);
  if (!v) indeterminate(`trim-status-config.md declares no \`## ${name}\``);
  return v;
}

/** The layout trim-status-config.md declares. Unknown pattern placeholders are refused, not guessed. */
export function loadLayout(vault) {
  const cfgPath = join(vault, 'trim-status-config.md');
  if (!existsSync(cfgPath)) indeterminate(`no trim-status-config.md in ${vault}`);
  const text = readFileSync(cfgPath, 'utf8');
  const statusFile = firstValue(text, 'STATUS_FILE');
  const archiveDir = firstValue(text, 'ARCHIVE_DIR');
  const pattern = firstValue(text, 'ARCHIVE_FILENAME_PATTERN');
  const unknown = (pattern.match(/<[^>]*>/g) || []).filter((p) => p !== '<Month>' && p !== '<Year>');
  if (unknown.length || !pattern.includes('<Month>') || !pattern.includes('<Year>')) {
    indeterminate(`ARCHIVE_FILENAME_PATTERN ${JSON.stringify(pattern)} is not <Month> + <Year>`);
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patternRe = new RegExp(`^${esc(pattern).replace(esc('<Month>'), `(${MONTHS.join('|')})`).replace(esc('<Year>'), '(\\d{4})')}$`);
  const routes = [];
  for (const l of section(text, 'SPLIT_FILES') || []) {
    const m = l.match(/^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/);
    if (!m || m[1] === statusFile) continue;
    const rule = m[2].split('|').pop().match(/`([^`]+)`/);
    if (!rule) indeterminate(`SPLIT_FILES row for ${m[1]} carries no backticked match rule`);
    routes.push({ file: m[1], re: new RegExp(rule[1]) });
  }
  return { vault, statusFile, statusPath: join(vault, statusFile), archiveDirName: archiveDir,
    archiveDir: join(vault, archiveDir), pattern, patternRe, routes };
}

export const ledgerName = (layout, date) =>
  layout.pattern.replace('<Month>', MONTHS[Number(date.slice(5, 7)) - 1]).replace('<Year>', date.slice(0, 4));

/** The byte caps: `files` in the budget manifest. A manifest we author is CONSTRUCTED — empty = refuse. */
export function loadBudget(file = DEFAULT_BUDGET) {
  const files = JSON.parse(readFileSync(file, 'utf8')).files;
  if (!files || typeof files !== 'object' || !Object.keys(files).length) indeterminate(`${file} has no \`files\` map`);
  for (const [k, v] of Object.entries(files)) {
    if (!Number.isInteger(v) || v <= 0) indeterminate(`${file} files.${k} is not a positive integer`);
  }
  return files;
}

/** Retired paths: `files_retired` in the budget manifest. Absent = none; any other shape = refuse. */
export function loadRetired(file = DEFAULT_BUDGET) {
  const retired = JSON.parse(readFileSync(file, 'utf8')).files_retired ?? [];
  if (!Array.isArray(retired) || retired.some((p) => typeof p !== 'string' || !p)) indeterminate(`${file} files_retired is not a list of paths`);
  return retired;
}

/** Every `files.*` cap judged once; --report and the per-append line both project from this. */
export function contextFiles({ vault, budgetFile = DEFAULT_BUDGET }) {
  const files = Object.entries(loadBudget(budgetFile)).map(([f, c]) => {
    const p = join(vault, f);
    return { file: f, cap: c, bytes: existsSync(p) ? bytes(readFileSync(p, 'utf8')) : null };
  });
  const missing = files.filter((f) => f.bytes === null);
  const over = files.filter((f) => f.bytes !== null && f.bytes > f.cap);
  const retired = loadRetired(budgetFile).filter((f) => existsSync(join(vault, f)));
  const verdict = missing.length ? 'INDETERMINATE' : over.length || retired.length ? 'OVER' : 'PASS';
  return { verdict, files, missing, over, retired };
}

export const contextLine = (c) => `${TAG} context files: ${c.files.length} capped`
  + ` · over: ${c.over.map((f) => `${f.file} ${f.bytes}/${f.cap} B`).join(', ') || 'none'}`
  + ` · missing: ${c.missing.map((f) => f.file).join(', ') || 'none'}`
  + ` · retired back: ${c.retired.join(', ') || 'none'}`;

// ── parsing ───────────────────────────────────────────────────────────────────

/**
 * Every `### ` block of a markdown text. A block runs to the line before the next `### `, `## `,
 * `# ` or `<!-- status-append:` line; trailing blank and `---` lines are separators, not body.
 */
export function splitBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  const ends = (l) => l.startsWith('### ') || l.startsWith('## ') || l.startsWith('# ') || l.startsWith('<!-- status-append:');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('### ')) continue;
    let j = i + 1;
    while (j < lines.length && !ends(lines[j])) j += 1;
    let last = j - 1;
    while (last > i && (lines[last].trim() === '' || lines[last].trim() === '---')) last -= 1;
    blocks.push({ heading: lines[i].slice(4), body: lines.slice(i + 1, last + 1).join('\n'), start: i, end: last });
    i = j - 1;
  }
  return blocks;
}
/**
 * The body as dedupe compares it. A trim's batch note (`_Appended … by TRIM-STATUS-019 …_`) sits
 * ABOVE its batch, so the entry above it parses with the note as its tail: whole-line italic
 * lines at the END are dropped before comparing, on both sides. Nothing written is changed.
 */
export const norm = (body) => {
  const l = body.trim().split('\n');
  while (l.length && (l[l.length - 1].trim() === '' || /^_[^_].*_$/.test(l[l.length - 1].trim()))) l.pop();
  return l.join('\n').trim();
};

/** heading → the normalised bodies it carries, across every ledger. */
export function ledgerMap(ledgers) {
  const m = new Map();
  for (const { text } of ledgers) {
    for (const b of splitBlocks(text)) {
      if (!m.has(b.heading)) m.set(b.heading, []);
      m.get(b.heading).push(norm(b.body));
    }
  }
  return m;
}

/** What to write for one entry: null (already there), the heading as is, or its amended copy. */
export function dedupe(map, heading, body) {
  const have = map.get(heading);
  if (!have) return heading;
  if (have.includes(norm(body))) return null;
  const am = map.get(heading + AMENDED);
  if (!am) return heading + AMENDED;
  if (am.includes(norm(body))) return null;
  return indeterminate(`"### ${heading}" is in the ledger with two other bodies already (original + amended copy) — a third version has no rule`);
}

export function readLedgers(layout) {
  if (!existsSync(layout.archiveDir)) indeterminate(`ARCHIVE_DIR ${layout.archiveDir} does not exist`);
  return readdirSync(layout.archiveDir)
    .map((name) => ({ name, m: name.match(layout.patternRe) }))
    .filter((x) => x.m)
    .sort((a, b) => (b.m[2] - a.m[2]) || (MONTHS.indexOf(b.m[1]) - MONTHS.indexOf(a.m[1])))
    .map(({ name }) => {
      const text = readFileSync(join(layout.archiveDir, name), 'utf8');
      return { name, path: join(layout.archiveDir, name), text, sha: sha(text) };
    });
}

// ── ledger insertion ──────────────────────────────────────────────────────────

export function newLedgerHeader(layout, date, nowIso) {
  return `# Status Archive — ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}\n\n`
    + `**Archived**: ${nowIso.slice(0, 10)} by \`ops/scripts/status-append.mjs\`\n`
    + `**Source**: ${layout.statusFile} (AlgoVault MCP)\n`
    + `**Scope**: Every ${layout.statusFile} entry, verbatim, newest-first, written when the entry is appended. ${layout.statusFile} keeps a ${WINDOW_MAX_DAYS}-day index of these headings.\n\n`
    + `---\n\n${LEDGER_ANCHORS[0]}\n`;
}

/** Insert blocks (newest first) directly under the ledger anchor. Returns { text, pos, insertion }. */
export function insertIntoLedger(text, blocks) {
  const lines = text.split('\n');
  const li = lines.findIndex((l) => LEDGER_ANCHORS.includes(l.trimEnd()));
  if (li === -1) indeterminate(`ledger has no ${LEDGER_ANCHORS.map((a) => `"${a}"`).join(' / ')} line to insert under`);
  let pos = lines.slice(0, li + 1).join('\n').length;
  let insertion = `\n${blocks.map((b) => `### ${b.heading}\n${b.body}`.replace(/\n+$/, '')).join('\n\n')}\n`;
  if (pos < text.length) pos += 1; // past the anchor's newline
  else insertion = `\n${insertion}`;
  return { text: text.slice(0, pos) + insertion + text.slice(pos), pos, insertion };
}

/** The byte-exact losslessness assertion: the new text is the old one with exactly the insertion added. */
export function assertInsertion(oldText, newText, pos, insertion) {
  if (newText.slice(0, pos) !== oldText.slice(0, pos) || newText.slice(pos + insertion.length) !== oldText.slice(pos)
    || newText.length !== oldText.length + insertion.length) {
    indeterminate('ledger losslessness assertion failed: the written ledger is not the old one plus the inserted block');
  }
}

// ── index ─────────────────────────────────────────────────────────────────────

/** Distinct ledger headings eligible for the index, newest first. */
export function indexHeadings(ledgers, layout) {
  const seen = new Set();
  const out = [];
  ledgers.forEach(({ text }, fi) => {
    text.split('\n').forEach((l, li) => {
      if (!l.startsWith('### ')) return;
      const h = l.slice(4);
      if (h.endsWith(AMENDED) || seen.has(h)) return;
      seen.add(h);
      const d = h.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}) UTC)?/);
      if (!d) return;
      const wave = h.slice(d[0].length).match(WAVE_TOKEN)?.[1] ?? null;
      if (wave && layout.routes.some((r) => r.re.test(wave))) return;
      out.push({ heading: h, date: d[1], time: d[2] ?? null, wave, fi, li });
    });
  });
  return out.sort((a, b) => (b.date.localeCompare(a.date))
    || ((b.time ?? '') .localeCompare(a.time ?? '')) || (a.fi - b.fi) || (a.li - b.li));
}

/** The heading's grep pointer: timestamp + wave + step, extended until unique, capped. */
export function pointerOf(h, all) {
  const parts = h.split(' — ');
  let p;
  if (parts.length >= 3) p = `${parts[0]} — ${parts[1]}`;
  else {
    const w = h.match(WAVE_TOKEN);
    if (w) {
      const end = w.index + w[0].length;
      p = h.slice(0, end) + (h.slice(end).match(/^\s+\S+/)?.[0] ?? '');
    } else p = parts[0];
  }
  p = cutBytes(p, POINTER_MAX_BYTES);
  const clash = () => all.some((o) => o !== h && o.startsWith(p));
  while (clash() && p.length < h.length && bytes(p) < POINTER_MAX_BYTES) {
    const next = h.slice(p.length).match(/^\s*\S+/);
    if (!next) break;
    const q = cutBytes(p + next[0], POINTER_MAX_BYTES);
    if (q === p) break;
    p = q;
  }
  return p;
}

export function indexRow(h, pointer) {
  const code = pointer.includes('`') ? `\`\` ${pointer} \`\`` : `\`${pointer}\``;
  const rest = h.slice(pointer.length).replace(/`|\*\*/g, '').replace(/\s+/g, ' ').trim();
  const head = `- ${code}`;
  if (!rest) return head;
  const full = `${head} ${rest}`;
  if (bytes(full) <= ROW_MAX_BYTES) return full;
  return `${cutBytes(`${head} ${rest}`, ROW_MAX_BYTES - bytes('…')).trimEnd()}…`;
}

const ageDays = (date, today) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);

export function renderIndex(rows, layout, sel) {
  const legend = `_Generated by \`ops/scripts/status-append.mjs\` on every write — never edit by hand. `
    + `${rows.length} row(s), newest first${rows.length ? `, ${sel.to} → ${sel.from}` : ''} `
    + `(the newest rows that fit, up to ${WINDOW_MAX_DAYS} days, never fewer than ${WINDOW_FLOOR_DAYS}). `
    + `A row's date names its ledger, \`${layout.archiveDirName}/${layout.pattern}\`; `
    + `\`grep -F '### <backticked text>'\` there finds the full entry._`;
  return [INDEX_START, legend, '', ...rows.map((r) => r.row), INDEX_END].join('\n');
}

/** Place the index block: replace the marked one, or put it under `## Recent Activity Log`. */
export function placeIndex(text, block) {
  const s = text.indexOf(INDEX_START);
  const e = text.indexOf(INDEX_END);
  const once = (m) => text.indexOf(m) === text.lastIndexOf(m);
  if (s !== -1 || e !== -1) {
    if (s === -1 || e === -1 || e < s || !once(INDEX_START) || !once(INDEX_END)) {
      indeterminate('the index markers are unbalanced or repeated — cannot tell where the index ends');
    }
    return text.slice(0, s) + block + text.slice(e + INDEX_END.length);
  }
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === '## Recent Activity Log');
  if (i === -1) indeterminate('status file has no index markers and no `## Recent Activity Log` heading to put the index under');
  lines.splice(i + 1, 0, '', block);
  return lines.join('\n');
}

// ── register ──────────────────────────────────────────────────────────────────

const cells = (line) => line.replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
const escPipe = (s) => s.replace(/(?<!\\)\|/g, '\\|');
/** Wave + State + What-is-owed, the part of a row the 600 B cap measures (ruling Q2). */
export const rowHeadBytes = (c) => bytes(`| ${c[0]} | ${c[1]} | ${c[2]} |`);

export function findRegister(lines) {
  const s = lines.findIndex((l) => l.startsWith('## ') && l.includes('Open-wave close register'));
  if (s === -1) return null;
  let e = lines.findIndex((l, i) => i > s && l.startsWith('## '));
  if (e === -1) e = lines.length;
  const h = lines.findIndex((l, i) => i > s && i < e && /^\|\s*Wave\s*\|\s*State\s*\|/.test(l));
  if (h === -1) return null;
  let r = h + 2;
  while (r < e && lines[r].startsWith('|')) r += 1;
  return { header: h, first: h + 2, end: r, sectionEnd: e };
}

export function parseRegisterLine(body) {
  const regs = body.split('\n').filter((l) => l.startsWith('Register:'));
  if (regs.length === 0) return null;
  if (regs.length > 1) indeterminate(`the entry carries ${regs.length} \`Register:\` lines — one wave, one row`);
  const m = regs[0].match(REGISTER_LINE);
  if (!m) indeterminate(`malformed register line (want \`Register: OWED|ARCHITECT [· Owed: <text>] · CLOSE_WHEN: <text>\`; the writer never sets CLOSED): ${regs[0].slice(0, 120)}`);
  return { state: m[1], owed: m[2] ?? null, closeWhen: m[3] };
}

export function registerRow(wave, reg, pointer) {
  const w = `\`${wave}\``;
  const owed = reg.owed ? escPipe(reg.owed) : `entry \`${pointer}\``;
  return `| ${w} | ${reg.state} | ${capOwed(w, reg.state, owed, pointer)} | ${escPipe(reg.closeWhen)} |`;
}

/** The owed cell cut so Wave + State + owed fit 600 B, ending in a pointer to the full text (ruling Q2). */
export function capOwed(w, state, owed, pointer) {
  if (rowHeadBytes([w, state, owed]) <= REGISTER_ROW_MAX_BYTES) return owed;
  const ptr = ` (full: \`${pointer}\`)`;
  const room = REGISTER_ROW_MAX_BYTES - rowHeadBytes([w, state, '']) - bytes(`…${ptr}`);
  return `${cutCell(owed, Math.max(0, room))}…${ptr}`;
}

/** Insert or update the entry's OWN row; never CLOSED, never a CLOSED/NOTED row, never another wave's. */
export function upsertRegister(lines, wave, reg, pointer) {
  const r = findRegister(lines);
  if (!r) indeterminate('the entry carries a `Register:` line but the status file has no open-wave register table');
  const own = [];
  for (let i = r.first; i < r.end; i += 1) if (cells(lines[i])[0] === `\`${wave}\``) own.push(i);
  if (own.length > 1) indeterminate(`the register holds ${own.length} rows for ${wave}`);
  const row = registerRow(wave, reg, pointer);
  if (own.length === 1) {
    const state = cells(lines[own[0]])[1];
    if (state !== 'OWED' && state !== 'ARCHITECT') indeterminate(`${wave}'s register row is ${state}; the writer never touches a ${state} row`);
    lines[own[0]] = row;
    return 'updated';
  }
  lines.splice(r.end, 0, row);
  return 'inserted';
}

/** Recount the marked count line from the table (single derivation). */
export function recount(lines) {
  const r = findRegister(lines);
  const i = lines.findIndex((l) => l.startsWith(COUNT_MARK));
  if (!r || i === -1) return;
  const n = {};
  for (let k = r.first; k < r.end; k += 1) { const s = cells(lines[k])[1]; n[s] = (n[s] || 0) + 1; }
  const order = ['OWED', 'ARCHITECT', 'NOTED', 'CLOSED', ...Object.keys(n).filter((s) => !['OWED', 'ARCHITECT', 'NOTED', 'CLOSED'].includes(s)).sort()];
  lines[i] = `${COUNT_MARK}**${order.map((s) => `${n[s] || 0} ${s}`).join(' · ')}** (${r.end - r.first} rows) — counted from the table by \`ops/scripts/status-append.mjs\` on every write.`;
}

// ── entry validation ──────────────────────────────────────────────────────────

export function parseEntry(text, layout) {
  const lines = text.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '').split('\n');
  const m = lines[0].match(STRICT_HEADING);
  if (!m || Number.isNaN(Date.parse(`${m[1]}T${m[2]}:00Z`))) {
    indeterminate(`the heading fails the strict grammar \`${STRICT_GRAMMAR}\`: ${lines[0].slice(0, 160)}`);
  }
  const extra = lines.slice(1).filter((l) => l.startsWith('### ') || l.startsWith('## ') || l.startsWith('# ') || l.startsWith('<!-- status-append:'));
  if (extra.length) indeterminate(`an entry is ONE \`### \` block: it may not carry another heading or marker line (${extra[0].slice(0, 80)})`);
  const wave = m[3];
  const route = layout.routes.find((r) => r.re.test(wave));
  if (route) indeterminate(`${wave} routes to ${route.file} (SPLIT_FILES); this writer does not write ${route.file}`);
  const body = lines.slice(1).join('\n');
  return { heading: lines[0].slice(4), body, date: m[1], wave, step: m[4], register: parseRegisterLine(body) };
}

// ── the write ─────────────────────────────────────────────────────────────────

/**
 * Plan (and unless dryRun, perform) one write. Pure until the write step; OVER/INDETERMINATE
 * throw a Refusal before anything is written. `hooks.beforeWrite` is the test seam for the
 * compare-and-swap race.
 */
export function run({ vault, budgetFile = DEFAULT_BUDGET, entryText = null, now = new Date(), dryRun = false, hooks = {} }) {
  const layout = loadLayout(vault);
  const caps = loadBudget(budgetFile);
  const cap = caps[layout.statusFile];
  if (!cap) indeterminate(`${budgetFile} declares no files["${layout.statusFile}"] cap`);
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);

  if (!existsSync(layout.statusPath)) indeterminate(`${layout.statusPath} does not exist`);
  const statusOld = readFileSync(layout.statusPath, 'utf8');
  const statusSha = sha(statusOld);
  const ledgers = readLedgers(layout);
  const map = ledgerMap(ledgers);
  const entry = entryText === null ? null : parseEntry(entryText, layout);

  // 1. what moves into the ledgers: stray `### ` blocks in the status file, then the new entry
  const strays = splitBlocks(statusOld);
  const undated = strays.find((b) => !/^\d{4}-\d{2}-\d{2}/.test(b.heading));
  if (undated) indeterminate(`a \`### \` block in ${layout.statusFile} has no date, so no ledger month: "${undated.heading.slice(0, 100)}"`);
  const moving = strays.map((b) => ({ heading: b.heading, body: b.body, date: b.heading.slice(0, 10) }));
  if (entry) moving.push({ heading: entry.heading, body: entry.body, date: entry.date });
  const plan = new Map(); // ledger name → blocks to insert (newest first after sort)
  const stats = { swept: strays.length, inserted: 0, amended: 0, already: 0 };
  for (const b of moving) {
    const h = dedupe(map, b.heading, b.body);
    if (h === null) { stats.already += 1; continue; }
    if (h !== b.heading) stats.amended += 1; else stats.inserted += 1;
    if (!map.has(h)) map.set(h, []);
    map.get(h).push(norm(b.body));
    const name = ledgerName(layout, b.date);
    if (!plan.has(name)) plan.set(name, []);
    plan.get(name).push({ heading: h, body: b.body, date: b.date });
  }

  // 2. the ledgers as they will be
  const writes = [];
  const after = ledgers.map((l) => ({ ...l }));
  for (const [name, blocks] of plan) {
    blocks.sort((a, b) => b.heading.localeCompare(a.heading));
    let l = after.find((x) => x.name === name);
    if (!l) {
      l = { name, path: join(layout.archiveDir, name), text: newLedgerHeader(layout, blocks[0].date, nowIso), sha: null, created: true };
      after.push(l);
    }
    const ins = insertIntoLedger(l.text, blocks);
    writes.push({ path: l.path, oldText: l.text, expectSha: l.created ? null : l.sha, ...ins });
    l.text = ins.text;
  }

  // 3. the status file without its strays, register upserted, count recounted
  let lines = statusOld.split('\n');
  for (const b of [...strays].reverse()) {
    let end = b.end + 1;
    while (end < lines.length && lines[end].trim() === '') end += 1;
    lines.splice(b.start, end - b.start);
  }
  const all = indexHeadings(after.sort((a, b) => {
    const ma = a.name.match(layout.patternRe); const mb = b.name.match(layout.patternRe);
    return (mb[2] - ma[2]) || (MONTHS.indexOf(mb[1]) - MONTHS.indexOf(ma[1]));
  }), layout);
  const allHeadings = all.map((x) => x.heading);
  let registerAction = null;
  if (entry?.register) {
    registerAction = upsertRegister(lines, entry.wave, entry.register, pointerOf(entry.heading, allHeadings));
  }
  recount(lines);
  const base = lines.join('\n');

  // 4. the index window (ruling Q1): newest rows that fit, ≤ 30 days, ≥ the 7-day floor
  const candidates = all.filter((x) => ageDays(x.date, today) < WINDOW_MAX_DAYS)
    .map((x) => ({ ...x, row: indexRow(x.heading, pointerOf(x.heading, allHeadings)) }));
  const floor = candidates.filter((x) => ageDays(x.date, today) < WINDOW_FLOOR_DAYS).length;
  const render = (n) => {
    const rows = candidates.slice(0, n);
    const sel = { from: rows[0]?.date, to: rows[rows.length - 1]?.date };
    return placeIndex(base, renderIndex(rows, layout, sel));
  };
  let n = floor;
  let text = render(n);
  if (bytes(text) > cap) {
    const fixed = bytes(render(0));
    throw new Refusal('OVER', `${layout.statusFile} would be ${bytes(text)} B > cap ${cap} B (header + register + index scaffolding ${fixed} B, `
      + `${WINDOW_FLOOR_DAYS}-day floor ${floor} rows ${bytes(text) - fixed} B) — ${layout.statusFile} is unchanged`);
  }
  while (n < candidates.length) {
    const next = render(n + 1);
    if (bytes(next) > cap) break;
    n += 1; text = next;
  }
  if (!text.endsWith('\n')) text += '\n';

  const summary = { status_bytes: bytes(text), cap, index_rows: n, index_floor: floor, index_candidates: candidates.length,
    window: n ? { from: candidates[0].date, to: candidates[n - 1].date } : null, ledgers: [...plan.keys()],
    ...stats, register: registerAction, wave: entry?.wave ?? null, changed: text !== statusOld || writes.length > 0 };
  if (dryRun) return { ...summary, dryRun: true, text, writes };

  // 5. write: ledgers first, then the status file — each compare-and-swap, temp + rename
  hooks.beforeWrite?.({ layout });
  for (const w of writes) atomicWrite(w.path, w.text, w.expectSha, (written) => assertInsertion(w.oldText, written, w.pos, w.insertion));
  if (text !== statusOld) {
    try { atomicWrite(layout.statusPath, text, statusSha); } catch (e) {
      if (writes.length && e instanceof Refusal) {
        e.message += ` — the ledger(s) ${writes.map((w) => basename(w.path)).join(', ')} WERE written; the next write's index derives them`;
      }
      throw e;
    }
  }
  return summary;
}

function atomicWrite(path, content, expectSha, verify = null) {
  const tmp = join(dirname(path), `.status-append-${process.pid}-${Date.now()}-${basename(path)}`);
  writeFileSync(tmp, content, { flag: 'wx' });
  try {
    const written = readFileSync(tmp, 'utf8');
    if (written !== content) indeterminate(`${tmp} did not read back as written`);
    if (verify) verify(written);
    const cur = existsSync(path) ? sha(readFileSync(path, 'utf8')) : null;
    if (cur !== expectSha) indeterminate(`${basename(path)} changed since it was read (compare-and-swap) — not written; re-run`);
    renameSync(tmp, path);
  } finally { if (existsSync(tmp)) rmSync(tmp); }
}

// ── log + report ──────────────────────────────────────────────────────────────

export const logPath = (vault) => join(vault, 'Claude files', 'status-append.jsonl');

function logLine(vault, rec) {
  try {
    mkdirSync(dirname(logPath(vault)), { recursive: true });
    appendFileSync(logPath(vault), `${JSON.stringify(rec)}\n`);
  } catch (e) { console.error(`${TAG} could not log to ${logPath(vault)}: ${e.message}`); }
}

export function report({ vault, budgetFile = DEFAULT_BUDGET, since = null }) {
  // compared as instants, never as strings: `2026-10-23T08:46Z` sorts after `2026-10-23T08:46:58Z`
  const from = since === null ? null : Date.parse(since);
  if (Number.isNaN(from)) throw new Error(`--since is not a date: ${since}`);
  const layout = loadLayout(vault);
  const { verdict, files, missing, over, retired } = contextFiles({ vault, budgetFile });
  const status = existsSync(layout.statusPath) ? readFileSync(layout.statusPath, 'utf8') : '';
  const lines = status.split('\n');
  const r = findRegister(lines);
  const wide = [];
  if (r) for (let i = r.first; i < r.end; i += 1) { const c = cells(lines[i]); if (rowHeadBytes(c) > REGISTER_ROW_MAX_BYTES) wide.push({ wave: c[0], bytes: rowHeadBytes(c) }); }
  const strays = splitBlocks(status).length;
  const s = status.indexOf(INDEX_START); const e = status.indexOf(INDEX_END);
  const rows = s !== -1 && e > s ? status.slice(s, e).split('\n').filter((l) => l.startsWith('- ')).length : 0;
  let log = [];
  if (existsSync(logPath(vault))) {
    log = readFileSync(logPath(vault), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { verdict: 'UNPARSEABLE' }; } })
      .filter((x) => from === null || !(Date.parse(x.ts) < from)); // a line with no readable ts stays counted
  }
  const verdicts = log.reduce((a, x) => ({ ...a, [x.verdict]: (a[x.verdict] || 0) + 1 }), {});
  return { verdict, files, missing, over, retired, wide, strays, rows, verdicts, writes: log.length,
    max_status_bytes: log.reduce((m, x) => Math.max(m, x.status_bytes || 0), 0) };
}

// ── self-test ─────────────────────────────────────────────────────────────────

const CONFIG_FIXTURE = `# fixture trim-status-config

## STATUS_FILE
status.md

## ARCHIVE_DIR
Old Status

## ARCHIVE_FILENAME_PATTERN
Status <Month> <Year>.md

## SPLIT_FILES

| Live file | Owns | Match rule |
|---|---|---|
| \`AOE-status.md\` | AOE | wave ID matches \`^(OPS-)?AOE-\` |
| \`status.md\` | everything else | default |

## KEEP_RULES
`;

export const STATUS_FIXTURE = `# fixture — Launch Status

> header prose that must survive every write.

---

## 🔓 Open-wave close register

| Wave | State | What is owed | CLOSE_WHEN |
|---|---|---|---|
| \`OPS-OTHER-W1\` | OWED | another wave's row | its own condition |
| \`OPS-DONE-W1\` | NOTED | a kept trigger row | never |

${COUNT_MARK}stale count

---

## Recent Activity Log

`;

const LEDGER_FIXTURE = (month) => `# Status Archive — ${month} 2026

**Archived**: fixture

---

${LEDGER_ANCHORS[0]}

_Appended by an earlier trim — a batch note that must survive._

### 2026-10-20 09:00 UTC — OPS-OLD-W1 CH1 — ✅ GREEN: an older entry
old body

### 2026-10-02 15:26 UTC — RETROACTIVE CLOSE (Mr.1): no wave token here — ✅ CLOSED
closed body

### 2026-10-19 08:00 UTC — AOE-PHASE-W3 CH1 — ✅ GREEN: routed to the split file
aoe body

### 2026-09-01 10:00 UTC — OPS-ANCIENT-W1 CH1 — ✅ GREEN: older than the window
ancient body
`;

/** A scratch vault: config, status file, budget manifest, one October ledger. */
export function makeVault(root, { cap = 40000, status = STATUS_FIXTURE } = {}) {
  mkdirSync(join(root, 'Old Status'), { recursive: true });
  writeFileSync(join(root, 'trim-status-config.md'), CONFIG_FIXTURE);
  writeFileSync(join(root, 'status.md'), status);
  writeFileSync(join(root, 'Old Status', 'Status October 2026.md'), LEDGER_FIXTURE('October'));
  const budget = join(root, 'budget.json');
  writeFileSync(budget, JSON.stringify({ files: { 'status.md': cap } }));
  return { vault: root, budgetFile: budget };
}

export const entryFixture = (heading, body = 'body line one\n\nsystem-map.md updated: n-a') => `### ${heading}\n\n${body}\n`;

function selfTest() {
  const fails = [];
  let n = 0;
  const eq = (label, got, want) => { n += 1; if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
  const T = mkdtempSync(join(tmpdir(), 'status-append-selftest-'));
  const NOW = new Date('2026-10-23T12:00:00Z');
  const attempt = (args) => { try { return { verdict: 'PASS', ...run({ now: NOW, ...args }) }; } catch (e) { return { verdict: e instanceof Refusal ? e.verdict : 'ERROR', message: e.message }; } };
  const snap = (v) => readdirSync(join(v, 'Old Status')).sort().map((f) => sha(readFileSync(join(v, 'Old Status', f), 'utf8'))).concat(sha(readFileSync(join(v, 'status.md'), 'utf8')));
  const led = (v) => readFileSync(join(v, 'Old Status', 'Status October 2026.md'), 'utf8');
  const st = (v) => readFileSync(join(v, 'status.md'), 'utf8');
  const count = (s, needle) => s.split('\n').filter((l) => l === needle).length;
  let built = 0;
  try {
    const H = '2026-10-23 10:00 UTC — OPS-FIX-W1 CH1 — ✅ GREEN: the fixture entry';
    // pass: the entry lands once in the ledger, status keeps no `### ` line, the index points at it
    const a = makeVault(join(T, 'a')); built += 1;
    const ledBefore = led(a.vault);
    const r1 = attempt({ ...a, entryText: entryFixture(H, 'body\n\nRegister: OWED · Owed: the day-7 read · CLOSE_WHEN: on/after 2026-10-30 the read is PASS') });
    eq('pass: verdict', r1.verdict, 'PASS');
    eq('pass: heading once in the ledger', count(led(a.vault), `### ${H}`), 1);
    eq('pass: ledger = old + inserted block (byte-exact)', led(a.vault).replace(`\n### ${H}\n\nbody\n\nRegister: OWED · Owed: the day-7 read · CLOSE_WHEN: on/after 2026-10-30 the read is PASS\n`, ''), ledBefore);
    eq('pass: no `### ` line left in status', st(a.vault).split('\n').filter((l) => l.startsWith('### ')).length, 0);
    eq('pass: newest index row points at the entry', st(a.vault).split('\n').find((l) => l.startsWith('- `')), '- `2026-10-23 10:00 UTC — OPS-FIX-W1 CH1` — ✅ GREEN: the fixture entry');
    eq('pass: header prose survives', st(a.vault).includes('> header prose that must survive every write.'), true);
    eq('pass: unparseable heading indexed by its raw text', st(a.vault).includes('- `2026-10-02 15:26 UTC — RETROACTIVE CLOSE (Mr.1): no wave token here`'), true);
    eq('pass: split-routed wave not indexed', st(a.vault).includes('AOE-PHASE-W3'), false);
    eq('pass: row older than 30 days not indexed', st(a.vault).includes('OPS-ANCIENT-W1'), false);
    eq('pass: every index row ≤ 200 B', st(a.vault).split('\n').filter((l) => l.startsWith('- `')).every((l) => bytes(l) <= ROW_MAX_BYTES), true);
    eq('pass: own register row inserted', st(a.vault).includes('| `OPS-FIX-W1` | OWED | the day-7 read | on/after 2026-10-30 the read is PASS |'), true);
    eq('pass: another wave\'s row untouched', st(a.vault).includes('| `OPS-OTHER-W1` | OWED | another wave\'s row | its own condition |'), true);
    eq('pass: count recounted from the table', st(a.vault).includes(`${COUNT_MARK}**2 OWED · 0 ARCHITECT · 1 NOTED · 0 CLOSED** (3 rows)`), true);
    eq('pass: batch note survives', led(a.vault).includes('_Appended by an earlier trim — a batch note that must survive._'), true);
    // idempotent: the same entry again changes nothing
    const s1 = snap(a.vault);
    eq('re-run: verdict', attempt({ ...a, entryText: entryFixture(H, 'body\n\nRegister: OWED · Owed: the day-7 read · CLOSE_WHEN: on/after 2026-10-30 the read is PASS') }).verdict, 'PASS');
    eq('re-run: nothing changed', snap(a.vault), s1);
    // amended: same heading, other body → `(amended copy)`, original kept
    eq('amended: verdict', attempt({ ...a, entryText: entryFixture(H, 'a corrected body') }).verdict, 'PASS');
    eq('amended: original + one amended copy', [count(led(a.vault), `### ${H}`), count(led(a.vault), `### ${H}${AMENDED}`)], [1, 1]);
    const s2 = snap(a.vault);
    eq('third body: INDETERMINATE', attempt({ ...a, entryText: entryFixture(H, 'yet another body') }).verdict, 'INDETERMINATE');
    eq('third body: nothing written', snap(a.vault), s2);
    // register: ARCHITECT updates the own row; CLOSED is refused; a NOTED row is never touched
    eq('register update: verdict', attempt({ ...a, entryText: entryFixture('2026-10-23 11:00 UTC — OPS-FIX-W1 CH2 — 🛑 HALTED: rulings owed', 'Register: ARCHITECT · CLOSE_WHEN: Q1 ruled') }).verdict, 'PASS');
    eq('register update: one own row, now ARCHITECT', st(a.vault).split('\n').filter((l) => l.startsWith('| `OPS-FIX-W1` |')).map((l) => cells(l)[1]), ['ARCHITECT']);
    const s3 = snap(a.vault);
    eq('register CLOSED: INDETERMINATE', attempt({ ...a, entryText: entryFixture('2026-10-23 11:30 UTC — OPS-FIX-W1 CH3 — ✅ GREEN: done', 'Register: CLOSED · CLOSE_WHEN: x') }).verdict, 'INDETERMINATE');
    eq('register NOTED row: INDETERMINATE', attempt({ ...a, entryText: entryFixture('2026-10-23 11:40 UTC — OPS-DONE-W1 CH9 — ✅ GREEN: x', 'Register: OWED · CLOSE_WHEN: x') }).verdict, 'INDETERMINATE');
    eq('register refusals: nothing written', snap(a.vault), s3);
    // strict grammar for a NEW entry; split-routed waves refused
    eq('grammar: missing time is INDETERMINATE', attempt({ ...a, entryText: entryFixture('2026-10-23 — OPS-FIX-W1 CH4 — ✅ GREEN: x') }).verdict, 'INDETERMINATE');
    eq('grammar: missing glyph is INDETERMINATE', attempt({ ...a, entryText: entryFixture('2026-10-23 12:00 UTC — OPS-FIX-W1 CH4 — GREEN: x') }).verdict, 'INDETERMINATE');
    eq('grammar: a second heading is INDETERMINATE', attempt({ ...a, entryText: entryFixture('2026-10-23 12:00 UTC — OPS-FIX-W1 CH4 — ✅ GREEN: x', 'b\n### 2026-10-23 12:01 UTC — OPS-X-W1 A — ✅ y') }).verdict, 'INDETERMINATE');
    eq('route: AOE wave is INDETERMINATE', attempt({ ...a, entryText: entryFixture('2026-10-23 12:00 UTC — AOE-PHASE-W3 CH2 — ✅ GREEN: x') }).verdict, 'INDETERMINATE');
    eq('refusals: nothing written', snap(a.vault), s3);
    // sweep: a hand-appended block moves to the ledger and the index heals
    const b = makeVault(join(T, 'b'), { status: `${STATUS_FIXTURE}### 2026-10-22 08:00 UTC — OPS-HAND-W1 CH1 — ✅ GREEN: appended by hand\nhand body\n` }); built += 1;
    const rs = attempt({ ...b });
    eq('sweep: verdict', [rs.verdict, rs.swept, rs.inserted], ['PASS', 1, 1]);
    eq('sweep: block now in the ledger', count(led(b.vault), '### 2026-10-22 08:00 UTC — OPS-HAND-W1 CH1 — ✅ GREEN: appended by hand'), 1);
    eq('sweep: indexed, no `### ` left', [st(b.vault).includes('- `2026-10-22 08:00 UTC — OPS-HAND-W1 CH1`'), st(b.vault).includes('\n### ')], [true, false]);
    // a missing month ledger is created with the standard header
    eq('new month: verdict', attempt({ ...b, now: new Date('2026-11-02T00:00:00Z'), entryText: entryFixture('2026-11-01 09:00 UTC — OPS-NOV-W1 CH1 — ✅ GREEN: november') }).verdict, 'PASS');
    const nov = join(b.vault, 'Old Status', 'Status November 2026.md');
    eq('new month: file has header + entry', existsSync(nov) && readFileSync(nov, 'utf8').startsWith('# Status Archive — November 2026') && readFileSync(nov, 'utf8').includes('### 2026-11-01 09:00 UTC — OPS-NOV-W1 CH1'), true);
    // budget: the floor does not fit → OVER and nothing written; a tighter cap trims the window, not the floor
    const c = makeVault(join(T, 'c'), { cap: 900 }); built += 1;
    const s4 = snap(c.vault);
    eq('budget: floor over the cap is OVER', attempt({ ...c, entryText: entryFixture(H) }).verdict, 'OVER');
    eq('budget: OVER wrote nothing', snap(c.vault), s4);
    const d = makeVault(join(T, 'd')); built += 1;
    const full = attempt({ ...d, entryText: entryFixture(H), dryRun: true });
    writeFileSync(d.budgetFile, JSON.stringify({ files: { 'status.md': full.status_bytes - 1 } }));
    const rd = attempt({ ...d, entryText: entryFixture(H) });
    eq('budget: window trimmed to fit, floor kept', [full.index_rows, rd.verdict, rd.index_rows, rd.index_floor, rd.status_bytes < full.status_bytes], [3, 'PASS', 2, 2, true]);
    // compare-and-swap: the status file changes after it was read → INDETERMINATE, status not overwritten
    const e = makeVault(join(T, 'e')); built += 1;
    const re = attempt({ ...e, entryText: entryFixture(H), hooks: { beforeWrite: ({ layout }) => appendFileSync(layout.statusPath, 'a concurrent write\n') } });
    eq('cas: INDETERMINATE', re.verdict, 'INDETERMINATE');
    eq('cas: the concurrent write survives', st(e.vault).endsWith('a concurrent write\n'), true);
    eq('cas: the ledger kept the entry', count(led(e.vault), `### ${H}`), 1);
    // pointer: two headings sharing timestamp + wave + step are told apart
    const ptr = pointerOf('2026-10-22 16:52 UTC — OPS-A-W1 CH2 — ✅ GREEN: one', ['2026-10-22 16:52 UTC — OPS-A-W1 CH2 — ✅ GREEN: one', '2026-10-22 16:52 UTC — OPS-A-W1 CH2 — ⚠️ other']);
    eq('pointer: extended until unique', ptr, '2026-10-22 16:52 UTC — OPS-A-W1 CH2 — ✅');
    eq('row: cut to ≤ 200 B on a code point', bytes(indexRow(`2026-10-23 10:00 UTC — OPS-LONG-W1 CH1 — ✅ ${'é'.repeat(300)}`, '2026-10-23 10:00 UTC — OPS-LONG-W1 CH1')) <= ROW_MAX_BYTES, true);
    eq('register: owed cut to the 600 B cap, CLOSE_WHEN verbatim', (() => { const row = registerRow('OPS-W-W1', { state: 'OWED', owed: 'x'.repeat(900), closeWhen: 'y'.repeat(700) }, 'p'); return [rowHeadBytes(cells(row)) <= REGISTER_ROW_MAX_BYTES, cells(row)[3].length]; })(), [true, 700]);
    eq('register: a cut never leaves an open code span or bold run', (() => { const c = cells(registerRow('OPS-W-W1', { state: 'OWED', owed: `**${'a'.repeat(300)} \`${'b'.repeat(400)}\`** tail`, closeWhen: 'y' }, 'p'))[2]; return [(c.match(/`/g) || []).length % 2, (c.replace(/`[^`]*`/g, '').split('**').length - 1) % 2, c.length > 400]; })(), [0, 0, true]);
    // context files: every files.* cap judged once; a retired path that is back is OVER
    const cf = (budget) => { writeFileSync(a.budgetFile, JSON.stringify(budget)); return contextFiles(a); };
    const caps2 = (cfg) => ({ 'status.md': 40000, 'trim-status-config.md': cfg });
    eq('context: every cap held is PASS', cf({ files: caps2(40000) }).verdict, 'PASS');
    eq('context: one over is OVER, named', (() => { const c = cf({ files: caps2(10) }); return [c.verdict, c.over.map((f) => f.file)]; })(), ['OVER', ['trim-status-config.md']]);
    eq('context: a capped file missing is INDETERMINATE', cf({ files: { ...caps2(40000), 'nope.md': 10 } }).verdict, 'INDETERMINATE');
    eq('context: a retired path absent is PASS', cf({ files: caps2(40000), files_retired: ['Claude files/RETIRED.md'] }).verdict, 'PASS');
    mkdirSync(join(a.vault, 'Claude files'), { recursive: true });
    writeFileSync(join(a.vault, 'Claude files', 'RETIRED.md'), 'back\n');
    eq('context: a retired path back is OVER, named', (() => { const c = cf({ files: caps2(40000), files_retired: ['Claude files/RETIRED.md'] }); return [c.verdict, c.retired]; })(), ['OVER', ['Claude files/RETIRED.md']]);
    eq('context: files_retired not a list is INDETERMINATE', (() => { try { return cf({ files: caps2(40000), files_retired: 'x' }).verdict; } catch (e) { return e instanceof Refusal ? e.verdict : 'ERROR'; } })(), 'INDETERMINATE');
    eq('exit map', [EXIT.PASS, EXIT.OVER, EXIT.INDETERMINATE], [0, 1, 3]);
  } catch (e) {
    fails.push(`self-test crashed: ${e.message}`);
  } finally { rmSync(T, { recursive: true, force: true }); }

  if (fails.length) {
    fails.forEach((x) => console.error(`  ✗ ${x}`));
    console.error(`${TAG} self-test FAILED (${fails.length} of ${n})`);
    return 'FAIL';
  }
  if (n < 40 || built < 5) {
    console.error(`${TAG} self-test is vacuous: ${n} assertions over ${built} vault(s)`);
    return 'INDETERMINATE';
  }
  console.log(`${TAG} self-test passed (${n} assertions over ${built} scratch vaults)`);
  return 'PASS';
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

function verdict(v, token = 'STATUS_APPEND_VERDICT') {
  console.log(`${token}=${v}`);
  process.exitCode = v === 'FAIL' ? 1 : EXIT[v];
}

function main() {
  if (process.argv.includes('--self-test')) { verdict(selfTest(), 'STATUS_APPEND_SELFTEST'); return; }
  let vault;
  try { vault = arg('--vault') || vaultRoot(); } catch (e) {
    console.error(`${TAG} ${e.message}`);
    verdict('INDETERMINATE');
    return;
  }
  const budgetFile = arg('--budget') || DEFAULT_BUDGET;

  if (process.argv.includes('--report')) {
    try {
      const r = report({ vault, budgetFile, since: arg('--since') });
      const w = Math.max(16, ...r.files.map((f) => f.file.length), ...r.retired.map((f) => f.length));
      for (const f of r.files) console.log(`${TAG} ${f.file.padEnd(w)} ${f.bytes === null ? 'MISSING' : String(f.bytes).padStart(7)} / ${f.cap} B${f.bytes > f.cap ? '  OVER' : ''}`);
      for (const f of r.retired) console.log(`${TAG} ${f.padEnd(w)} exists again (files_retired)  OVER`);
      console.log(`${TAG} register rows over ${REGISTER_ROW_MAX_BYTES} B (wave + state + owed): ${r.wide.length}${r.wide.map((w) => ` ${w.wave}=${w.bytes}`).join('')}`);
      console.log(`${TAG} index rows ${r.rows} · stray \`### \` blocks ${r.strays}`);
      console.log(`${TAG} logged writes${arg('--since') ? ` since ${arg('--since')}` : ''}: ${r.writes} · ${Object.entries(r.verdicts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'} · max status bytes ${r.max_status_bytes}`);
      verdict(r.verdict, 'STATUS_BUDGET_VERDICT');
    } catch (e) {
      console.error(`${TAG} report failed: ${e.message}`);
      verdict('INDETERMINATE', 'STATUS_BUDGET_VERDICT');
    }
    return;
  }

  const sweep = process.argv.includes('--sweep');
  const entryFile = sweep ? null : process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !['--vault', '--budget', '--now'].includes(all[i - 1]));
  if (!sweep && !entryFile) {
    console.error('usage: status-append.mjs <entry.md> | --sweep  [--dry-run] [--vault <dir>] [--budget <json>] [--now <ISO>] · --report [--since <ISO>] · --self-test');
    verdict('INDETERMINATE');
    return;
  }
  const dryRun = process.argv.includes('--dry-run');
  const now = arg('--now') ? new Date(arg('--now')) : new Date();
  const rec = { ts: new Date().toISOString(), mode: sweep ? 'sweep' : 'append', entry: entryFile ? basename(entryFile) : null };
  let v = 'PASS';
  try {
    if (Number.isNaN(now.getTime())) indeterminate(`--now ${arg('--now')} is not a date`);
    if (entryFile && !existsSync(entryFile)) indeterminate(`no entry file ${entryFile}`);
    const r = run({ vault, budgetFile, entryText: entryFile ? readFileSync(entryFile, 'utf8') : null, now, dryRun });
    Object.assign(rec, { status_bytes: r.status_bytes, cap: r.cap, index_rows: r.index_rows, window: r.window, wave: r.wave,
      swept: r.swept, inserted: r.inserted, amended: r.amended, already: r.already, ledgers: r.ledgers, register: r.register });
    console.log(`${TAG}${dryRun ? ' DRY-RUN' : ''} status ${r.status_bytes} / ${r.cap} B · index ${r.index_rows} row(s) (floor ${r.index_floor}, candidates ${r.index_candidates})`
      + `${r.window ? ` ${r.window.to} → ${r.window.from}` : ''} · swept ${r.swept} · ledger +${r.inserted} new +${r.amended} amended, ${r.already} already there`
      + `${r.ledgers.length ? ` (${r.ledgers.join(', ')})` : ''}${r.register ? ` · register ${r.register} ${r.wave}` : ''}${r.changed ? '' : ' · nothing to change'}`);
  } catch (e) {
    v = e instanceof Refusal ? e.verdict : 'INDETERMINATE';
    rec.message = e.message;
    console.error(`${TAG} ${v}: ${e.message}`);
  }
  rec.verdict = v;
  try {
    const c = contextFiles({ vault, budgetFile });
    rec.context_files = c.verdict;
    console.log(contextLine(c));
    console.log(`CONTEXT_FILES_VERDICT=${c.verdict}`);
  } catch (e) {
    rec.context_files = 'INDETERMINATE';
    console.error(`${TAG} context files: ${e.message}`);
    console.log('CONTEXT_FILES_VERDICT=INDETERMINATE');
  }
  if (!dryRun) logLine(vault, rec);
  verdict(v);
}

const invoked = (() => { try { return realpathSync(process.argv[1] || ''); } catch { return ''; } })();
if (invoked === SELF) main();
