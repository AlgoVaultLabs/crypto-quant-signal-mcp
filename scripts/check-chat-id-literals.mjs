#!/usr/bin/env node
// @ts-check
/**
 * check-chat-id-literals.mjs — a real Telegram chat id never reaches this PUBLIC repo again.
 *
 * OPS-MCP-CHATID-SCRUB-W1. The port of AlgoVaultLabs/algovault-bot `scripts/check-chat-id-literals.py`
 * (ffd419e), ADAPTED to what this repo's tree measurably contains — read "THE RULE" before
 * "simplifying" it back to the bot's.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 * Waves that reproduce bot and referral defects against live data wrote the chat id they measured
 * into this repo: a referral test called `tgIdentity(<the operator's own chat id>)`, a shape
 * snapshot's drift-check curl carried `?tg=<id>`, and a monitoring script plus its inventory row
 * named the subscriber whose watch a liveness probe used to pin. The repo is public, and nothing
 * asked whether evidence is publishable. Redacting them retires the instances; this retires the
 * class.
 *
 * ─── THE RULE, AND WHY IT IS NOT THE BOT'S ──────────────────────────────────────────────────
 * The bot refuses ANY bare 8–16-digit run, because its tree carries zero legitimate ones. THIS
 * tree carried 7,311 such runs in 221 of 2,951 tracked files (4,344 are 13-digit millisecond
 * timestamps; 2,631 are 10-digit, mostly epoch seconds), and waves add ~386 more lines a month
 * (331 of them in audits/). A shape-only rule here would fire on every other wave and be disabled.
 *
 * So a finding needs BOTH:
 *   1. a Telegram-SHAPED run — 8–10 digits (user ids are at most 10 digits), or `-100` + 10 digits
 *      (a supergroup / channel id). A 13-digit millisecond timestamp is therefore never a
 *      candidate, which is what `<channel>:<ms>:<rand>` payment identities carry;
 *   2. an IDENTITY CONTEXT on the same line, within 60 chars before or 20 after:
 *      `chat` (not `chatgpt`) · a word starting `tg` (`tgIdentity(`, `tg_chat_id`, `?tg=`) ·
 *      a word starting `telegram` (so NOT `send_telegram.sh`) · `subscriber` · `BOT_ADMIN`.
 *      `user` / `admin` were measured and REJECTED: every hit was a GitHub avatar URL, a
 *      `…@users.noreply.github.com` identity or a `/Users/` path.
 * Exempt, besides the bot's three structural shapes (a decimal's fraction or integer part, a
 * digit-grouped `1_785_062_942`, a run inside an alphanumeric token): an 8-digit run that is a
 * valid 20xx calendar date (backup suffixes, model ids like `claude-haiku-4-5-<yyyymmdd>`).
 *
 * Measured on this repo's WHOLE public history (tree + every added line + every commit message):
 * 4,744 distinct id-shaped values, of which exactly 2 are live chat ids (checked read-only against
 * the bot's database). This rule catches all 17 lines that ever carried them, and fires on no
 * other line of today's tree and on 0 of 45 id-shaped historical commit messages.
 *
 * ─── WHAT IT DOES NOT CATCH — so it is never trusted for work it cannot do ──────────────────
 *   - a KEYWORD-FREE id — a bare tuple value, a test name. Measured on the bot's corpus this rule
 *     would miss 20 of 46 leaked tree lines and 11 of 16 leaked commit messages; that is why the
 *     bot keeps its stricter shape rule. Code that handles chat ids as plain data belongs there;
 *   - an id of 11+ digits (none issued as of 2026-09), digit-grouped, or glued to letters;
 *   - an 8-digit id that is also a valid 20xx date (only accounts from ~2013 have 8-digit ids);
 *   - anything encoded or HASHED — a SHA-256 of a 10-digit id is not a redaction, 10^10 inputs
 *     brute-force in minutes;
 *   - anything already in public history: this guards what is published NEXT;
 *   - `--push-range` scans the unpublished commits of HEAD; a push of some OTHER local ref is
 *     covered only by the tree scan in CI.
 * A legitimate Telegram-shaped number next to one of those words (an epoch in a TG log line)
 * fails too. That is the intended direction: fail toward NOISE, never toward silence. Write it
 * digit-grouped or as an ISO time, or add a measured exemption HERE — never a heuristic elsewhere.
 *
 * ─── MODES ──────────────────────────────────────────────────────────────────────────────────
 *   node scripts/check-chat-id-literals.mjs                  # = --check: every TRACKED file
 *   node scripts/check-chat-id-literals.mjs --push-range [remote]
 *       every commit of HEAD not yet on a `refs/remotes/<remote>/*` ref (default: origin) — its
 *       ADDED lines and its MESSAGE. A literal added in one commit and deleted in the next is
 *       still FAIL: the history publishes it. Reads NO stdin, deliberately: the shared pre-push
 *       hook's ref lines belong to its push-safety block, and a second reader would starve it.
 *   node scripts/check-chat-id-literals.mjs --self-test      # two-way, vacuity-guarded, offline
 *
 * ─── CONTRACT ───────────────────────────────────────────────────────────────────────────────
 * Exactly one terminal `CHAT_ID_LITERALS_VERDICT=PASS|FAIL|INDETERMINATE`; callers gate on the
 * TOKEN. Exit 0 / 1 / 3 (3 = the token-law default for a NEW gate). A finding prints as `…<last4>`
 * and NEVER in full — this repo's CI logs are public too. Self-test fixture ids are built from
 * arithmetic, so this file never contains the shape it forbids and needs no exemption for itself.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'CHAT_ID_LITERALS_VERDICT';
const EXIT = /** @type {const} */ ({ PASS: 0, FAIL: 1, INDETERMINATE: 3 });

/** A bare digit run, bounded by neither a digit nor an ASCII letter, and not part of a decimal. */
const RUN = /(?<![0-9A-Za-z])(?<![0-9]\.)([0-9]{8,16})(?![0-9A-Za-z])(?!\.[0-9])/g;
/** The identity context. Each alternative is justified by a measured hit or false positive above. */
export const IDENTITY_CONTEXT = /chat(?!gpt)|\btg|\btelegram|subscriber|BOT_ADMIN/i;
const BEFORE = 60;
const AFTER = 20;
const BINARY_SNIFF = 8192;

/** Masked form of a digit run: only the last four digits ever leave this process. */
export function mask(/** @type {string} */ digits) {
  return '…' + digits.slice(-4);
}

/** An 8-digit run that reads as a real calendar date in 2000–2099. */
export function isCompactDate(/** @type {string} */ v) {
  if (v.length !== 8 || !v.startsWith('20')) return false;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(4, 6));
  const d = Number(v.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Telegram-shaped: a user id (8–10 digits here) or a `-100`-prefixed supergroup/channel id. */
export function isTelegramShaped(/** @type {string} */ v, /** @type {string} */ charBefore) {
  if (v.length >= 8 && v.length <= 10) return true;
  return v.length === 13 && v.startsWith('100') && charBefore === '-';
}

/**
 * Every id-shaped literal on ONE line that sits in an identity context. Pure.
 * @param {string} line
 * @returns {string[]} the matched digit runs (callers mask them before printing)
 */
export function findInLine(line) {
  const out = [];
  for (const m of line.matchAll(RUN)) {
    const v = m[1];
    const at = m.index ?? 0;
    if (!isTelegramShaped(v, line.slice(at - 1, at))) continue;
    if (isCompactDate(v)) continue;
    if (IDENTITY_CONTEXT.test(line.slice(Math.max(0, at - BEFORE), at + v.length + AFTER))) out.push(v);
  }
  return out;
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {{ where: string, last4: string }[]}
 */
export function scanText(text, label) {
  /** @type {{ where: string, last4: string }[]} */
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const v of findInLine(line)) out.push({ where: `${label}:${i + 1}`, last4: mask(v) });
  });
  return out;
}

class Indeterminate extends Error {}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 */
function git(args, cwd, env) {
  try {
    return execFileSync('git', args, {
      cwd, env: env ?? process.env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = /** @type {any} */ (e);
    const why = String(err.stderr ?? err.message ?? '').trim().split('\n').pop();
    throw new Indeterminate(`\`git ${args.slice(0, 3).join(' ')}…\` failed: ${why}`);
  }
}

// ── mode 1: the tracked tree ─────────────────────────────────────────────────────────────────
/** @param {string} root */
export function scanTree(root) {
  const paths = git(['ls-files', '-z'], root).split('\0').filter(Boolean);
  /** @type {{ where: string, last4: string }[]} */
  const findings = [];
  let scanned = 0, binary = 0, absent = 0;
  for (const rel of paths) {
    const abs = join(root, rel);
    let buf;
    try {
      const st = lstatSync(abs);
      buf = st.isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : readFileSync(abs); // git publishes the link TEXT
    } catch {
      absent++; // tracked but deleted in the working tree
      continue;
    }
    if (buf.subarray(0, BINARY_SNIFF).includes(0)) { binary++; continue; }
    scanned++;
    findings.push(...scanText(buf.toString('utf8'), rel));
  }
  // WE construct this corpus, so building nothing is vacuity, never a clean pass. ONE guard, on
  // what was actually scanned: a separate "no tracked paths" check was measured to be MASKED by
  // this one (deleting it left the self-test green), so it was redundant and is gone.
  if (scanned === 0) throw new Indeterminate(`no readable text file among ${paths.length} tracked path(s) under ${root}`);
  return { findings, notes: [`tree: ${scanned} tracked text files scanned (${binary} binary, ${absent} absent)`] };
}

// ── mode 2: what a push publishes ────────────────────────────────────────────────────────────
/**
 * Commits of HEAD that no `refs/remotes/<remote>/*` ref contains yet, oldest first.
 * A stale remote-tracking ref only OVER-scans, which is the safe direction.
 * @param {string} root
 * @param {string} remote
 * @param {NodeJS.ProcessEnv} [env]
 */
export function commitsToPublish(root, remote, env) {
  return git(['rev-list', '--reverse', 'HEAD', '--not', `--remotes=${remote}`], root, env).split('\n').filter(Boolean);
}

/**
 * @param {string} root
 * @param {string} sha
 * @param {NodeJS.ProcessEnv} [env]
 */
export function scanCommit(root, sha, env) {
  const short = sha.slice(0, 8);
  const findings = scanText(git(['log', '-1', '--format=%B', sha], root, env), `${short} (message)`);
  const diff = git(['diff-tree', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--root',
    '--diff-merges=first-parent', '--no-commit-id', sha], root, env);
  let path = '?', newLine = 0, inHeader = true;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { inHeader = true; path = '?'; continue; }
    if (inHeader && raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim().replace(/^"|"$/g, '');
      path = target.startsWith('b/') ? target.slice(2) : target;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { newLine = Number(hunk[1]); inHeader = false; continue; }
    if (!inHeader && raw.startsWith('+')) {
      for (const v of findInLine(raw.slice(1))) findings.push({ where: `${short} ${path}:${newLine}`, last4: mask(v) });
      newLine++;
    }
  }
  return findings;
}

/**
 * @param {string} root
 * @param {string} remote
 * @param {NodeJS.ProcessEnv} [env]
 */
export function scanPush(root, remote, env) {
  const commits = commitsToPublish(root, remote, env);
  if (commits.length === 0) {
    // The WORLD builds this corpus: an up-to-date push is a fact, reported out loud.
    return { findings: [], notes: [`push range: 0 unpublished commits on HEAD vs ${remote} — nothing to publish`] };
  }
  const findings = commits.flatMap((sha) => scanCommit(root, sha, env));
  return { findings, notes: [`push range: ${commits.length} unpublished commit(s) on HEAD vs ${remote} scanned (added lines + messages)`] };
}

// ── verdict ──────────────────────────────────────────────────────────────────────────────────
/**
 * @param {'tree' | 'push'} mode
 * @param {string} root
 * @param {string} [remote]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ verdict: 'PASS' | 'FAIL' | 'INDETERMINATE', findings: { where: string, last4: string }[], notes: string[] }}
 */
export function run(mode, root, remote = 'origin', env) {
  try {
    const r = mode === 'push' ? scanPush(root, remote, env) : scanTree(root);
    return { verdict: r.findings.length ? 'FAIL' : 'PASS', ...r };
  } catch (e) {
    const msg = e instanceof Indeterminate ? e.message : `unexpected: ${/** @type {Error} */ (e).message}`;
    return { verdict: 'INDETERMINATE', findings: [], notes: [msg] };
  }
}

const REMEDY = [
  'A Telegram-shaped number (8-10 digits, or -100 + 10) next to chat / tg / telegram / subscriber',
  'reads as a chat id, and this repo is PUBLIC. Replace it with a synthetic id of <= 7 digits that',
  'keeps the last4 (19937 for last4 9937), a placeholder like <tg_chat_id>, or `chat last4 NNNN`.',
  'A genuine number in that context (an epoch): write it digit-grouped or as an ISO time.',
];
const REMEDY_PUSH = [
  'It is in a commit being PUSHED: deleting it in a NEW commit does not help, because the history',
  'publishes it. Rewrite the unpushed commit(s) (`git commit --amend`, or reword/edit them in a',
  'rebase onto the remote branch), then push again.',
];

/**
 * @param {'PASS' | 'FAIL' | 'INDETERMINATE'} verdict
 * @param {{ where: string, last4: string }[]} findings
 * @param {string[]} notes
 * @param {boolean} [push]
 * @param {(s: string) => void} [out]
 */
export function emit(verdict, findings, notes, push = false, out = (s) => console.log(s)) {
  for (const n of notes) out(`[chat-id-literals] ${n}`);
  if (verdict === 'FAIL') {
    out(`[chat-id-literals] ${findings.length} chat-id-shaped literal(s) in an identity context, masked:`);
    for (const f of findings) out(`[chat-id-literals]   ${f.where}: ${f.last4}`);
    for (const l of [...REMEDY, ...(push ? REMEDY_PUSH : [])]) out(`[chat-id-literals] ${l}`);
  }
  out(`${TOKEN}=${verdict}`);
  return EXIT[verdict];
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────
// Fixture ids are ARITHMETIC: no id-shaped run is ever written into this file.
const ID10 = String(7 * 10 ** 9 + 4_521);
const ID9 = String(5 * 10 ** 8 + 240);
const ID8 = String(3 * 10 ** 7 + 6_212);
const SUPERGROUP = '-100' + String(2 * 10 ** 9 + 9);
const MS13 = String(1_785_062_942_123);
const EPOCH10 = String(1_785_062_942);
const DATE8 = String(20_260_722);

const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => ![
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_QUARANTINE_PATH',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(k)));
const IDENT = ['-c', 'user.name=self-test', '-c', 'user.email=self-test@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

/** git on a FIXTURE repo. Inside a hook the stripped GIT_* vars point at the REAL repository. */
function fx(/** @type {string} */ repo, /** @type {string[]} */ ...args) {
  return git([...IDENT, ...args], repo, GIT_ENV).trim();
}
/** @param {string} dir @param {Record<string, string>} files */
function fxRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  fx(dir, 'init', '-q', '-b', 'main');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
    fx(dir, 'add', '--', rel);
  }
  fx(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  return dir;
}
/** @param {string} repo @param {string} rel @param {string} body @param {string} message */
function fxCommit(repo, rel, body, message) {
  writeFileSync(join(repo, rel), body);
  fx(repo, 'add', '--', rel);
  fx(repo, 'commit', '-q', '-m', message);
  return fx(repo, 'rev-parse', 'HEAD');
}

export function selfTest() {
  /** @type {[string, boolean, string][]} */
  const results = [];
  /** @param {string} label @param {unknown} got @param {unknown} want */
  const check = (label, got, want) =>
    results.push([label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`]);
  const fires = (/** @type {string} */ line) => findInLine(line).length;

  // (a) MUST FIRE — every shape a real id took in this repo's history, and in the bot's messages.
  /** @type {Record<string, string>} */
  const mustFire = {
    'referral drift-check curl': `curl -s 'http://127.0.0.1:3000/api/referral/code?tg=${ID10}'`,
    'tgIdentity call': `    const a = tgIdentity(${ID10});`,
    'tgIdentity string arg': `    expect(a).toBe(tgIdentity('${ID10}'));`,
    'liveness comment': `# This used to pin chat ${ID10} / ETH / 15m / BINANCE.`,
    'inventory note': `"notes": "the probe row was a hardcoded SUBSCRIBER watch (chat ${ID10} ETH/15m/BINANCE)"`,
    'tg_chat_id field, 9 digits': `-d '{"ref_code":"<code>","tg_chat_id":"${ID9}"}'`,
    'admin env': `BOT_ADMIN_CHAT_IDS=${ID10},42`,
    'commit message': `fix(tier): chat ${ID10} was shown the wrong plan`,
    'telegram prose': `the Telegram user ${ID10} blocked the bot`,
    'subscriber, 8-digit floor': `the subscriber ${ID8} was walled`,
    'supergroup id': `chat_id: ${SUPERGROUP}`,
  };
  for (const [label, line] of Object.entries(mustFire)) check(`(a) fires: ${label}`, fires(line), 1);

  // (b) MUST NOT FIRE — every measured legitimate shape, and the redacted forms that replace ids.
  /** @type {Record<string, string>} */
  const mustNotFire = {
    'ms timestamp in a payment identity': `E2 = ("evt_x", "2026-07-26 11:48:41+00", "tg_bot:${MS13}:3af913")`,
    'chatgpt case number': `| ChatGPT App directory | \`chatgpt\` | Case ${ID10} in review |`,
    'send_telegram backup suffix': `send_telegram.sh.bak.PRE-TEST-CONTEXT-GATE-${DATE8}`,
    'model id date beside chat': `expect(chat.match!.body).toContain('claude-haiku-4-5-${DATE8}');`,
    'github avatar url': `"avatar_url": "https://avatars.githubusercontent.com/u/${ID9}?v=4"`,
    'noreply identity': `const CANONICAL = '${ID9}+AlgoVaultFi@users.noreply.github.com';`,
    'digit-grouped epoch beside tg': 'TG alert fired at 1_785_062_942',
    'fractional part beside tg': 'tg funding -0.000011994',
    '11-digit run id beside chat': `chat_knowledge smoke: run ${String(36 * 10 ** 9 + 219)}`,
    'synthetic stand-in': "const a = tgIdentity(19937);",
    'placeholder': "curl -s 'http://127.0.0.1:3000/api/referral/code?tg=<tg_chat_id>'",
    'redacted prose': 'This used to pin chat last4 0162 / ETH / 15m / BINANCE.',
    // Documented scope, pinned so widening it is a deliberate act: no identity keyword, no finding.
    'keyword-free tuple (documented miss)': `args = (${ID10}, "ETH", "15m", "BINANCE")`,
    'epoch without identity context': `"at": ${EPOCH10},`,
    // Each boundary gets a case ONLY it can hold, so relaxing one of them turns this red on its own.
    'telegram mid-word (send_telegram)': `send_telegram.sh delivered at ${EPOCH10}`,
    'digits closing an alphanumeric token beside chat': `chat seam digest a${ID10}`,
    'digits opening an alphanumeric token beside chat': `chat seam digest ${ID10}b`,
    'decimal integer part beside subscriber': `subscriber revenue ${ID9}.25`,
  };
  for (const [label, line] of Object.entries(mustNotFire)) check(`(b) silent: ${label}`, fires(line), 0);

  // (c) the finding is located and MASKED.
  const located = scanText(`ok\ncurl '?tg=${ID10}'\n`, 'f.json');
  check('(c) located on its line', located.map((f) => f.where), ['f.json:2']);
  check('(c) masked to last4', located.map((f) => f.last4), ['…' + ID10.slice(-4)]);

  const tmp = mkdtempSync(join(tmpdir(), 'chat-id-literals-'));
  try {
    // (d) TREE mode, both ways; the printed output never carries the full literal.
    const dirty = fxRepo(join(tmp, 'dirty'), { 'ops/x.sh': `# pin chat ${ID10}\n`, 'README.md': 'ok\n' });
    const d = run('tree', dirty);
    check('(d) tree with an id in context → FAIL', d.verdict, 'FAIL');
    check('(d) tree names the file', d.findings.map((f) => f.where), ['ops/x.sh:1']);
    /** @type {string[]} */
    const lines = [];
    emit(d.verdict, d.findings, d.notes, false, (s) => lines.push(s));
    check('(d) FAIL output never prints the full literal', lines.join('\n').includes(ID10), false);
    check('(d) FAIL output prints the masked form', lines.join('\n').includes('…' + ID10.slice(-4)), true);
    const clean = fxRepo(join(tmp, 'clean'), { 'ops/x.sh': '# pin chat last4 4521\n' });
    check('(d) clean tree → PASS', run('tree', clean).verdict, 'PASS');

    // (e) TREE vacuity: WE build this corpus, so building nothing is INDETERMINATE.
    check('(e) no tracked files → INDETERMINATE', run('tree', fxRepo(join(tmp, 'empty'), {})).verdict, 'INDETERMINATE');
    mkdirSync(join(tmp, 'plain'));
    check('(e) not a git checkout → INDETERMINATE', run('tree', join(tmp, 'plain')).verdict, 'INDETERMINATE');

    // (f) PUSH mode — the corpus a tree scan structurally cannot see.
    const r = fxRepo(join(tmp, 'push'), { 'src/a.ts': 'const x = 1;\n' });
    const base = fx(r, 'rev-parse', 'HEAD');
    fx(r, 'update-ref', 'refs/remotes/origin/main', base); // "already published"
    const push = () => run('push', r, 'origin', GIT_ENV).verdict;
    check('(f) nothing unpublished → PASS', push(), 'PASS');
    fxCommit(r, 'src/a.ts', `const tg = ${ID10};\n`, 'add a value');
    check('(f) id in an ADDED line → FAIL', push(), 'FAIL');
    fx(r, 'reset', '-q', '--hard', base);
    fxCommit(r, 'src/a.ts', 'const x = 2;\n', `fix: chat ${ID10} saw the wrong tier`);
    check('(f) id only in the commit MESSAGE → FAIL', push(), 'FAIL');
    fx(r, 'reset', '-q', '--hard', base);
    fxCommit(r, 'src/a.ts', `const tg = ${ID10};\n`, 'add');
    fxCommit(r, 'src/a.ts', 'const x = 3;\n', 'remove again');
    check('(f) added then deleted inside the range → FAIL (history publishes it)', push(), 'FAIL');
    check('(f) ...though the final TREE is clean', run('tree', r).verdict, 'PASS');
    const prior = fxCommit(r, 'src/a.ts', `const tg = ${ID10};\n`, 'reintroduce');
    fx(r, 'update-ref', 'refs/remotes/origin/main', prior); // it went out earlier
    fxCommit(r, 'src/a.ts', 'const x = 4;\n', 'redact');
    check('(f) a REMOVAL-only commit publishes nothing new → PASS', push(), 'PASS');
    check('(f) a remote with no tracking refs scans all of HEAD → FAIL', run('push', r, 'nosuchremote', GIT_ENV).verdict, 'FAIL');
    check('(f) not a git checkout → INDETERMINATE', run('push', join(tmp, 'plain'), 'origin', GIT_ENV).verdict, 'INDETERMINATE');

    // (g) THE SEAM THE FIXTURES BYPASS: the real tree must be readable by the real corpus builder.
    const inGit = (() => { try { git(['rev-parse', '--is-inside-work-tree'], ROOT); return true; } catch { return false; } })();
    if (inGit) {
      const real = run('tree', ROOT);
      check('(g) the real tree is not INDETERMINATE', real.verdict !== 'INDETERMINATE', true);
      const n = Number((/tree: (\d+) tracked text files scanned/.exec(real.notes.join('\n')) ?? [])[1] ?? 0);
      check('(g) the real corpus is non-empty', n > 0, true);
    }
  } catch (e) {
    check(`self-test crashed: ${/** @type {Error} */ (e).message}`, false, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // (h) the TOKEN→EXIT mapping and exactly one token per run. Labels name the verdict WITHOUT
  // the token prefix: a label carrying the token would put a second one into this run's output.
  for (const [v, want] of /** @type {const} */ ([['PASS', 0], ['FAIL', 1], ['INDETERMINATE', 3]])) {
    /** @type {string[]} */
    const lines = [];
    const code = emit(v, v === 'FAIL' ? [{ where: 'x:1', last4: '…0000' }] : [], [], false, (s) => lines.push(s));
    check(`(h) ${v} -> exit ${want}`, code, want);
    check(`(h) ${v} token printed once`, lines.join('\n').split(`${TOKEN}=`).length - 1, 1);
  }

  const nFire = results.filter(([l]) => l.startsWith('(a)')).length;
  const nSilent = results.filter(([l]) => l.startsWith('(b)')).length;
  const failed = results.filter(([, ok]) => !ok);
  for (const [label, ok, why] of results) console.log(`[self-test] ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${why}`}`);
  if (nFire === 0 || nSilent === 0) {
    console.log(`[self-test] VACUOUS: ${nFire} must-fire, ${nSilent} must-not-fire`);
    console.log(`${TOKEN}=INDETERMINATE`);
    return 3;
  }
  console.log(`SELF-TEST: ${failed.length ? 'FAIL' : 'PASS'} (${results.length - failed.length} passed, ${failed.length} failed; ${nFire} must-fire, ${nSilent} must-not-fire)`);
  console.log(`${TOKEN}=${failed.length ? 'FAIL' : 'PASS'}`);
  return failed.length ? 1 : 0;
}

// A module import must NOT scan or exit; only a direct `node …/check-chat-id-literals.mjs` does.
// REAL paths on both sides: `import.meta.url` is symlink-resolved and argv[1] is not, so on macOS
// (`/var` → `/private/var`) a plain `resolve()` comparison made a gate invoked through a symlinked
// path print NOTHING and exit 0 — a silent no-op the CLI tests caught and the self-test could not.
const IS_MAIN = (() => {
  if (process.argv[1] == null) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (IS_MAIN) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest());
  const i = argv.indexOf('--push-range');
  if (i >= 0) {
    const remote = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'origin';
    const r = run('push', ROOT, remote);
    process.exit(emit(r.verdict, r.findings, r.notes, true));
  }
  const r = run('tree', ROOT);
  process.exit(emit(r.verdict, r.findings, r.notes));
}
