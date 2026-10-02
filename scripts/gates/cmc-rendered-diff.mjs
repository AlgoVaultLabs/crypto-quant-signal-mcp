#!/usr/bin/env node
// @ts-check
/**
 * cmc-rendered-diff.mjs — LANDING-MCP-CLIENTS-CLAIMS-W1 Build Rule 4: ratified diff only.
 *
 * Every changed unit of reader-facing text this wave produces must belong to exactly one row of
 * the ratified copy table (R1–R18 and R10b). The committed map
 * audits/LANDING-MCP-CLIENTS-CLAIMS-W1-rendered-diff.json lists them; --check recomputes the diff
 * and asserts BOTH directions: every changed unit is listed with an R-row, every listed unit is a
 * real change, and every required R-row occurs at least once. An unlisted change is a ride-along.
 *
 * UNITS, not lines. Several generated pages carry a whole artboard on ONE line (landing/index.html
 * line 578 is 69,255 characters), so a line diff would hide any ride-along inside a line that also
 * holds a ratified change. HTML is split after every `>`; every other file is split into lines.
 * The diff itself is git's (`git diff --no-index`), run over one unit per line.
 *
 * DERIVED units are the only non-copy changes allowed, and only in a file that also carries copy:
 * regenerating a page re-bakes its render date, its source-derived dateModified and its live
 * track-record fallbacks. Each derived class is a NAMED pattern below; a unit that matches none
 * is a ride-along, whatever it says.
 *
 * Modes:
 *   --emit  [--base <ref>] [--out <path>]   classify the current diff, write the map; exit 1 on any unmapped unit
 *   --check [--base <ref>] [--map <path>] [--rows R1,R2,…]   RENDERED_DIFF_VERDICT=MATCH|MISMATCH|INDETERMINATE
 *   --self-test                              RENDERED_DIFF_SELFTEST=PASS|FAIL
 *
 * Exit: 0 MATCH/PASS · 1 MISMATCH/FAIL · 3 INDETERMINATE (the token-law default for a new gate).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WAVE = 'LANDING-MCP-CLIENTS-CLAIMS-W1';
export const MAP_PATH = 'audits/LANDING-MCP-CLIENTS-CLAIMS-W1-rendered-diff.json';
export const REPO_PATHS = ['landing', 'README.md', 'docs'];
export const VAULT_JSX_DIR = '/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/Design/AlgoVault Landing Hero v1';
export const VAULT_JSX = 'v1-landing-rest.jsx';
export const VAULT_KEY = `vault:Design/AlgoVault Landing Hero v1/${VAULT_JSX}`;
export const ALL_ROWS = [...Array.from({ length: 18 }, (_, i) => `R${i + 1}`), 'R10b'];

// ── units ───────────────────────────────────────────────────────────────────────────────────────

/** @param {string} file @param {string} text */
export function toUnits(file, text) {
  return /\.html?$/.test(file) ? text.split(/(?<=>)/) : text.split('\n');
}
/** One unit per line for git, newlines inside a unit made visible and reversible. */
const esc = (u) => u.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/**
 * Changed units between two texts, grouped by hunk: [{ op, unit }][] — git's Myers diff.
 * @param {string} file @param {string} oldText @param {string} newText
 */
export function diffUnits(file, oldText, newText) {
  const dir = mkdtempSync(join(tmpdir(), 'cmc-rd.'));
  try {
    writeFileSync(join(dir, 'a'), toUnits(file, oldText).map(esc).join('\n') + '\n');
    writeFileSync(join(dir, 'b'), toUnits(file, newText).map(esc).join('\n') + '\n');
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U0', join(dir, 'a'), join(dir, 'b')], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff --no-index failed: ${r.stderr}`);
    /** @type {{op: string, unit: string}[][]} */
    const hunks = [];
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('@@')) hunks.push([]);
      else if (hunks.length && (line.startsWith('-') || line.startsWith('+')) && !line.startsWith('---') && !line.startsWith('+++')) {
        hunks[hunks.length - 1].push({ op: line[0], unit: line.slice(1) });
      }
    }
    return hunks.filter((h) => h.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── classification ──────────────────────────────────────────────────────────────────────────────

/**
 * Distinctive fragments per R-row, in PRIORITY order: the first row whose fragment a unit carries
 * wins, so a unit belongs to exactly one row. File scopes resolve the rows that share wording
 * (R8 vs R9 share `--client <name>`; R15 vs R16 share "paste the URL").
 * A unit carrying no fragment inherits the row of the nearest distinctive unit in its hunk.
 */
export const ROW_RULES = [
  { row: 'R16', files: /^landing\/faq\.html$/, frags: ['Add custom connector', 'Connectors'] },
  { row: 'R15', files: /^(landing\/index\.html|vault:)/, frags: ['Open Claude → Settings → Connectors', 'Open Claude → Customize → Connectors', 'Add custom connector → paste the URL'] },
  { row: 'R17', files: /^README\.md$/, frags: ['**1. Add the connector.**'] },
  { row: 'R14', files: /^README\.md$/, frags: ['| **Claude Desktop** |', '| **Claude Code** (CLI) |', '| **Cursor** |', 'MCP_CLIENTS_README_TABLE'] },
  // R13: the derived footer — renderFooterLinks() writes each link as `    <a class="text-mint-400 hover:underline" href="…">`
  { row: 'R13', frags: ['    <a class="text-mint-400 hover:underline" href="', 'MCP quickstart</a>', 'Claude custom connectors</a>',
    'Cline remote-server docs</a>', 'Cline MCP docs</a>', 'DeepSeek Harness</a>'] },
  { row: 'R18', files: /^landing\/index\.html$/, frags: ['DeepSeek Harness', '/integrations/deepseek-harness'] },
  { row: 'R7', frags: ['rejected the URL'] },
  { row: 'R6', frags: ['covers local stdio servers only', 'local stdio servers only', 'codex mcp add algovault --url', 'adds the free tier from the CLI', 'Config verified 2026-08-05 against <https://learn.chatgpt.com', 'Config verified 2026-10-01 against <https://learn.chatgpt.com', 'Config verified 2026-08-05 against <a href="https://learn.chatgpt.com', 'Config verified 2026-10-01 against <a href="https://learn.chatgpt.com'] },
  { row: 'R10b', frags: ['Continue.dev support is in beta', 'Claude Code and Codex, among others', 'Hit Enter at the API-key prompt',
    'no-header config', 'entry carries no API key', 'asks you to authorize it in your browser', 'Same result as hand-editing the JSON',
    'generates the right', 'server.smithery.ai/algovault/crypto-quant-signal-mcp/mcp', 'reach AlgoVault through that gateway',
    'add AlgoVault by hand instead', 'Which clients does Smithery support?', 'Free tier setup?', 'What does Smithery actually do?'] },
  { row: 'R10', frags: ['prompts for any required env vars', 'Smithery-gateway entry', 'smithery.ai/server/@AlgoVaultLabs', 'smithery.ai/servers/algovault', 'Client not detected', 'config-path', 'AlgoVault MCP installed for Claude Desktop', 'successfully installed for claude', 'Successfully resolved algovault', 'help improve Smithery', 'Installing remote server', 'Config written to ~/Library', 'Restart Claude Desktop to load', 'the CLI prompts for', 'skip to use the free tier', 'right MCP-server entry', 'mcp add algovault/crypto-quant-signal-mcp --client claude', 'install crypto-quant-signal-mcp --client claude'] },
  { row: 'R9', files: /(^landing\/integrations\/smithery\.html$|smithery\.md$)/, frags: ['@smithery/cli install crypto-quant-signal-mcp --client', '@smithery/cli mcp add algovault/crypto-quant-signal-mcp --client'] },
  { row: 'R9', frags: ['--client &lt;client&gt;', '--client <client>'] },
  { row: 'R8', frags: ['--client &lt;name&gt;</code>', '--client <name>'] },
  { row: 'R11', frags: ['"version":"1.10.3"', '&lt;current release&gt;'] },
  { row: 'R5', frags: ['restart Claude Desktop after saving the connector', 'enable it for the chat from', 'is set in the JSON env block, not just your shell', 'is set in the JSON env block as'] },
  { row: 'R4', frags: ['in the env block or your shell', 'Set your key in the env block', 'header and the env block', ' header, but keep the '] },
  { row: 'R3', frags: ['AUTH_HEADER', 'Authorization: Bearer ${AV_API_KEY}', 'Authorization: Bearer \\${AV_API_KEY}'] },
  { row: 'R2', frags: ['Easiest path (UI', 'Name it <code', '. Paste <code', 'as a custom header', 'The connector form takes OAuth credentials', 'Enable it per chat', 'Path 1 — UI (recommended)', 'Name: <code', ', then click', 'Open Claude Desktop → Customize', 'Open Claude Desktop → Settings',
    // the menu item alone, when git splits it off as its own hunk (only R2 wraps it in <em>)
    'Customize</em>', 'Settings</em>'] },
  { row: 'R1', frags: ['Settings &rarr; Connectors &rarr; <em>', 'Customize &rarr; Connectors &rarr; + &rarr; <em>'] },
  { row: 'R12', frags: ['mcp?src=docs', 'mcp?src=binance_agent_os'] },
];

/** Named derived classes: what regenerating a page may change besides its copy. */
export const DERIVED_RULES = [
  { cls: 'render-date', re: /^\\n<meta name="last-updated" content="\d{4}-\d{2}-\d{2}">$/, why: 'render-integrations.mjs stamps the render date' },
  { cls: 'date-modified', re: /"@type": "TechArticle"[\s\S]*"dateModified": "\d{4}-\d{2}-\d{2}T/, why: 'dateModified is DERIVED from the source markdown\'s last commit, which this wave made' },
  { cls: 'live-snapshot', re: /^\d[\d.,]*%?<\/span>$/, why: 'render-integrations.mjs re-bakes the live /api/performance-public fallbacks into data-tr-field spans' },
];

/** @param {string} file @param {string} unit @returns {string|null} */
export function rowOf(file, unit) {
  for (const r of ROW_RULES) {
    if (r.files && !r.files.test(file)) continue;
    if (r.frags.some((f) => unit.includes(f))) return r.row;
  }
  return null;
}
/**
 * Markup with no readable word in it: tags, arrows, `+`, punctuation, whitespace. A tag that carries
 * a link target (`href` / `src`) is never structural — a changed link IS content.
 * @param {string} unit
 */
export function isStructural(unit) {
  if (/\b(href|src)=/.test(unit)) return false;
  return unit.replace(/<[^>]*>/g, '').replace(/&(rarr|nbsp|mdash|middot);|\\n/g, ' ').replace(/[\s+→—·.,;:()-]/g, '') === '';
}
/** @param {string} unit */
export function derivedClassOf(unit) {
  const d = DERIVED_RULES.find((x) => x.re.test(unit));
  return d ? d.cls : null;
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unesc = (u) => u.replace(/\\(\\|n)/g, (_, c) => (c === 'n' ? '\n' : '\\'));

/**
 * A derived class is accepted only on its own evidence, never on its shape alone:
 *   live-snapshot  the value must sit inside a data-tr-field span on its side of the diff;
 *   date-modified  the -/+ pair must be identical once both dateModified values are masked.
 */
function derivedHolds(cls, u, hunk, oldText, newText) {
  if (cls === 'live-snapshot') {
    const side = u.op === '-' ? oldText : newText;
    return new RegExp(`data-tr-field="[a-z_]+">${reEsc(unesc(u.unit))}`).test(side);
  }
  if (cls === 'date-modified') {
    const mask = (s) => s.replace(/"dateModified": "[^"]*"/g, '"dateModified": "*"');
    const twin = hunk.find((x) => x.op !== u.op && derivedClassOf(x.unit) === 'date-modified');
    return Boolean(twin) && mask(twin.unit) === mask(u.unit);
  }
  return cls === 'render-date';
}

/**
 * Entries for one file: each unit → exactly one R-row (copy), or a derived class tagged with the
 * file's lowest copy row, or UNMAPPED.
 * @param {string} file @param {{op: string, unit: string}[][]} hunks
 * @param {string} [oldText] @param {string} [newText]
 */
export function classifyFile(file, hunks, oldText = '', newText = '') {
  /** @type {{file: string, op: string, unit: string, r_row: string|null, kind: string, class?: string}[]} */
  const out = [];
  for (const h of hunks) {
    const direct = h.map((u) => rowOf(file, u.unit));
    h.forEach((u, i) => {
      const d = derivedClassOf(u.unit);
      if (direct[i] === null && d) {
        if (derivedHolds(d, u, h, oldText, newText)) { out.push({ file, op: u.op, unit: u.unit, r_row: null, kind: 'derived', class: d }); return; }
        out.push({ file, op: u.op, unit: u.unit, r_row: null, kind: 'unmapped' });
        return;
      }
      let row = direct[i];
      for (let k = 1; row === null && k < h.length; k++) row = direct[i - k] ?? direct[i + k] ?? null;
      out.push({ file, op: u.op, unit: u.unit, r_row: row, kind: row ? 'copy' : 'unmapped' });
    });
  }
  // A hunk made ONLY of markup (git can split `<em>+</em> &rarr;` off as its own hunk) carries no
  // words to classify. Such purely STRUCTURAL units inherit the row of the nearest classified unit
  // in the same file. A unit with any real text never inherits across hunks — it stays unmapped.
  out.forEach((e, i) => {
    if (e.kind !== 'unmapped' || !isStructural(e.unit)) return;
    for (let k = 1; k < out.length; k++) {
      const n = [out[i - k], out[i + k]].find((x) => x && x.kind === 'copy');
      if (n) { e.r_row = n.r_row; e.kind = 'copy'; return; }
    }
  });
  const copyRows = out.filter((e) => e.kind === 'copy').map((e) => Number(e.r_row.slice(1))).sort((a, b) => a - b);
  for (const e of out) if (e.kind === 'derived') e.r_row = copyRows.length ? `R${copyRows[0]}` : null;
  return out;
}

// ── corpus ──────────────────────────────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
}
function defaultBase() {
  return git(['merge-base', 'HEAD', 'origin/main']).trim();
}
/** @returns {string|null} the one pre-wave backup of the vault JSX, or null */
export function vaultBackup(dir = VAULT_JSX_DIR) {
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir).filter((f) => f.startsWith(`${VAULT_JSX}.bak.PRE-${WAVE}-`));
  return hits.length === 1 ? join(dir, hits[0]) : null;
}

/** Recompute every changed unit (working tree vs base, plus the vault JSX vs its backup). */
export function recompute(base) {
  const files = git(['diff', '--name-only', base, '--', ...REPO_PATHS]).split('\n').filter(Boolean);
  const entries = [];
  for (const f of files) {
    const oldText = (() => { try { return git(['show', `${base}:${f}`]); } catch { return ''; } })();
    const newText = existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), 'utf8') : '';
    entries.push(...classifyFile(f, diffUnits(f, oldText, newText), oldText, newText));
  }
  const bak = vaultBackup();
  if (!bak) return { entries, vault: 'missing' };
  const cur = join(VAULT_JSX_DIR, VAULT_JSX);
  const [o, n] = [readFileSync(bak, 'utf8'), readFileSync(cur, 'utf8')];
  entries.push(...classifyFile(VAULT_KEY, diffUnits(VAULT_JSX, o, n), o, n));
  return { entries, vault: bak };
}

// ── check ───────────────────────────────────────────────────────────────────────────────────────

const key = (e) => `${e.file}\u0000${e.op}\u0000${e.unit}`;

/**
 * Both directions + coverage. `committed` = the map's entries, `actual` = recomputed.
 * @returns {{verdict: 'MATCH'|'MISMATCH', problems: string[]}}
 */
export function compare(committed, actual, requiredRows) {
  const problems = [];
  const count = (list) => list.reduce((m, e) => m.set(key(e), (m.get(key(e)) || 0) + 1), new Map());
  const want = count(committed);
  const got = count(actual);
  for (const [k, n] of got) if ((want.get(k) || 0) < n) problems.push(`unlisted change (ride-along): ${k.split('\u0000').join(' | ').slice(0, 220)}`);
  for (const [k, n] of want) if ((got.get(k) || 0) < n) problems.push(`listed but not a change: ${k.split('\u0000').join(' | ').slice(0, 220)}`);
  const copyFiles = new Set(committed.filter((e) => e.kind === 'copy').map((e) => e.file));
  for (const e of committed) {
    if (!ALL_ROWS.includes(e.r_row)) problems.push(`entry without a valid R-row: ${e.file} ${e.op} ${String(e.unit).slice(0, 120)}`);
    if (e.kind === 'derived') {
      if (!DERIVED_RULES.some((d) => d.cls === e.class && d.re.test(e.unit))) problems.push(`derived entry matches no named derived class: ${e.file} ${String(e.unit).slice(0, 120)}`);
      if (!copyFiles.has(e.file)) problems.push(`derived change in a file with no copy change: ${e.file}`);
    } else if (e.kind !== 'copy') problems.push(`entry kind ${e.kind}: ${e.file} ${String(e.unit).slice(0, 120)}`);
  }
  const seen = new Set(committed.filter((e) => e.kind === 'copy').map((e) => e.r_row));
  for (const r of requiredRows) if (!seen.has(r)) problems.push(`required row ${r} has no changed unit`);
  return { verdict: problems.length ? 'MISMATCH' : 'MATCH', problems };
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────────

export function selfTest() {
  const fails = [];
  let fire = 0;
  let quiet = 0;
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  // units: HTML splits after '>', text by line
  ok(JSON.stringify(toUnits('a.html', '<p>x</p><b>y')) === JSON.stringify(['<p>', 'x</p>', '<b>', 'y']), 'html unit split');
  ok(toUnits('a.md', 'a\nb').length === 2, 'line split');
  // a one-unit change inside a long single line is found as ONE unit, not as the whole line
  const old1 = '<div><p>Open Claude → Settings → Connectors</p><p>keep</p></div>';
  const new1 = '<div><p>Open Claude → Customize → Connectors</p><p>keep</p></div>';
  const h = diffUnits('landing/index.html', old1, new1);
  ok(h.length === 1 && h[0].length === 2 && h[0].every((u) => u.unit.includes('Connectors')), 'diffUnits finds the single changed unit inside one line');
  // classification: priority + file scope + inheritance
  ok(rowOf('landing/faq.html', 'Claude Desktop: Customize &rarr; Connectors') === 'R16', 'faq scope → R16');
  ok(rowOf('landing/index.html', 'Add custom connector → paste the URL</div>') === 'R15', 'index scope → R15');
  ok(rowOf('docs/integrations/mcp-clients/smithery.md', 'npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client <name>') === 'R9', 'smithery.md keeps <name> → R9');
  ok(rowOf('landing/docs.html', 'npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client &lt;name&gt;</code>') === 'R8', 'setupSummary → R8');
  ok(rowOf('landing/docs.html', 'codex mcp add algovault --url "https://api.algovault.com/mcp?src=docs"</code>') === 'R6', 'R6 outranks R12');
  const inh = classifyFile('landing/docs.html', [[{ op: '-', unit: 'AV_API_KEY</code>' }, { op: '-', unit: ' in the env block or your shell. Free tier: drop the <code class="text-xs">' }]]);
  ok(inh.every((e) => e.r_row === 'R4' && e.kind === 'copy'), 'generic unit inherits its hunk row');
  // a markup-only hunk inherits from its neighbour; a worded unit in an unclassified hunk does not
  const split = classifyFile('landing/docs.html', [
    [{ op: '-', unit: 'Easiest path (UI):</strong>' }, { op: '+', unit: 'Easiest path (UI, free tier):</strong>' }],
    [{ op: '+', unit: '+</em>' }, { op: '+', unit: ' &rarr; <em>' }],
    [{ op: '+', unit: 'Ten new tools!</p>' }],
  ]);
  ok(split[2].r_row === 'R2' && split[3].r_row === 'R2', 'markup-only hunk inherits the neighbouring row');
  fire++; ok(split[4].kind === 'unmapped', 'a worded unit never inherits across hunks');
  ok(isStructural('+</em>') && isStructural(' &rarr; <em>') && !isStructural('Add</em>'), 'isStructural separates markup from words');
  ok(!isStructural(' &middot;\\n    <a class="x" href="https://new.example/">'), 'a changed link target is content, never structural');
  const linkHunks = classifyFile('landing/docs.html', [
    [{ op: '-', unit: 'Easiest path (UI):</strong>' }, { op: '+', unit: 'Easiest path (UI, free tier):</strong>' }],
    [{ op: '+', unit: ' &middot;\\n    <a class="y" href="https://ride.example/">' }],
  ]);
  fire++; ok(linkHunks[2].kind === 'unmapped', 'a changed link in an unclassified hunk never inherits a neighbouring row');
  // compare(): MATCH, then each way of failing
  const real = classifyFile('landing/index.html', h);
  quiet++; ok(compare(real, real, ['R15']).verdict === 'MATCH', 'identical map and diff → MATCH');
  const ride = [...real, { file: 'landing/index.html', op: '+', unit: 'DeepSeek Harness</div>', r_row: null, kind: 'unmapped' }];
  fire++; ok(compare(real, ride, ['R15']).verdict === 'MISMATCH', 'a ride-along unit → MISMATCH');
  fire++; ok(compare(ride, real, ['R15']).verdict === 'MISMATCH', 'a listed non-change → MISMATCH');
  fire++; ok(compare(real, real, ['R15', 'R16']).verdict === 'MISMATCH', 'a required row with no unit → MISMATCH');
  const fake = [...real, { file: 'landing/index.html', op: '+', unit: 'Ten new tools!</p>', r_row: 'R15', kind: 'derived', class: 'live-snapshot' }];
  fire++; ok(compare(fake, fake, ['R15']).verdict === 'MISMATCH', 'a "derived" entry that matches no derived pattern → MISMATCH');
  const orphan = [{ file: 'landing/integrations/okx.html', op: '+', unit: '90.9%</span>', r_row: 'R2', kind: 'derived', class: 'live-snapshot' }];
  fire++; ok(compare(orphan, orphan, []).verdict === 'MISMATCH', 'a derived change in a file with no copy → MISMATCH');
  // derived patterns accept the real shapes
  ok(derivedClassOf('90.9%</span>') === 'live-snapshot' && derivedClassOf('916,636</span>') === 'live-snapshot', 'snapshot units are derived');
  ok(derivedClassOf('\\n<meta name="last-updated" content="2026-10-01">') === 'render-date', 'render date is derived');
  ok(derivedClassOf('DeepSeek Harness</div>') === null, 'copy is never derived');
  // ...but only on their own evidence
  const snapOld = '<p><span data-tr-field="pfe_wr">91.1%</span></p>';
  const snapNew = '<p><span data-tr-field="pfe_wr">90.9%</span></p>';
  const snap = classifyFile('landing/integrations/x.html', diffUnits('landing/integrations/x.html', snapOld, snapNew), snapOld, snapNew);
  quiet++; ok(snap.length === 2 && snap.every((e) => e.kind === 'derived'), 'a data-tr-field value change is derived');
  const priceOld = '<p><b>Starter</b> <span class="p">9.99</span></p>';
  const priceNew = '<p><b>Starter</b> <span class="p">12.99</span></p>';
  const price = classifyFile('landing/integrations/x.html', diffUnits('landing/integrations/x.html', priceOld, priceNew), priceOld, priceNew);
  fire++; ok(price.every((e) => e.kind === 'unmapped'), 'a bare number outside data-tr-field is NOT derived');
  const ldOld = '<script type="application/ld+json">{"@type": "TechArticle", "headline": "A", "dateModified": "2026-08-09T15:00:00+00:00"}</script>';
  const ldNew = '<script type="application/ld+json">{"@type": "TechArticle", "headline": "B", "dateModified": "2026-10-01T15:00:00+00:00"}</script>';
  const ld = classifyFile('landing/integrations/x.html', diffUnits('landing/integrations/x.html', ldOld, ldNew), ldOld, ldNew);
  fire++; ok(ld.every((e) => e.kind === 'unmapped'), 'a JSON-LD change beyond dateModified is NOT derived');
  if (fire === 0 || quiet === 0) fails.push('self-test is vacuous');
  return { pass: fails.length === 0, fails, fire, quiet };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

const INVOKED = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--self-test')) {
    const st = selfTest();
    for (const f of st.fails) console.error(`  ✗ ${f}`);
    console.log(st.pass ? `✓ self-test: ${st.fire} must-fire, ${st.quiet} must-not-fire` : '✗ self-test failed');
    console.log(`RENDERED_DIFF_SELFTEST=${st.pass ? 'PASS' : 'FAIL'}`);
    process.exit(st.pass ? 0 : 1);
  }
  let base;
  try { base = opt('--base') || defaultBase(); } catch (e) {
    console.error(`cannot resolve the base: ${e.message}`); console.log('RENDERED_DIFF_VERDICT=INDETERMINATE'); process.exit(3);
  }
  let rec;
  try { rec = recompute(base); } catch (e) {
    console.error(`cannot compute the diff: ${e.message}`); console.log('RENDERED_DIFF_VERDICT=INDETERMINATE'); process.exit(3);
  }
  if (rec.vault === 'missing') {
    console.error(`the vault JSX backup ${VAULT_JSX}.bak.PRE-${WAVE}-* is missing (or not unique) — cannot diff the homepage producer`);
    console.log('RENDERED_DIFF_VERDICT=INDETERMINATE'); process.exit(3);
  }
  if (argv.includes('--emit')) {
    const unmapped = rec.entries.filter((e) => e.kind === 'unmapped' || !e.r_row);
    const doc = {
      wave: WAVE,
      generated_by: 'scripts/gates/cmc-rendered-diff.mjs --emit',
      base,
      unit_rule: 'html: split after every ">"; other files: lines; a newline inside a unit is written \\n',
      derived_classes: Object.fromEntries(DERIVED_RULES.map((d) => [d.cls, d.why])),
      rows: Object.fromEntries(ALL_ROWS.map((r) => [r, rec.entries.filter((e) => e.r_row === r && e.kind === 'copy').length])),
      entries: rec.entries,
    };
    writeFileSync(resolve(ROOT, opt('--out') || MAP_PATH), `${JSON.stringify(doc, null, 2)}\n`);
    for (const u of unmapped) console.error(`  ✗ UNMAPPED ${u.file} ${u.op} ${u.unit.slice(0, 160)}`);
    console.log(`wrote ${opt('--out') || MAP_PATH}: ${rec.entries.length} unit(s), ${unmapped.length} unmapped`);
    process.exit(unmapped.length ? 1 : 0);
  }
  // --check
  const mapFile = resolve(ROOT, opt('--map') || MAP_PATH);
  if (!existsSync(mapFile)) { console.error(`map missing: ${mapFile}`); console.log('RENDERED_DIFF_VERDICT=INDETERMINATE'); process.exit(3); }
  let map;
  try { map = JSON.parse(readFileSync(mapFile, 'utf8')); } catch (e) {
    console.error(`map unparseable: ${e.message}`); console.log('RENDERED_DIFF_VERDICT=INDETERMINATE'); process.exit(3);
  }
  if (!Array.isArray(map.entries) || map.entries.length === 0) { console.error('map carries no entries'); console.log('RENDERED_DIFF_VERDICT=INDETERMINATE'); process.exit(3); }
  const required = (opt('--rows') || ALL_ROWS.join(',')).split(',').filter(Boolean);
  const res = compare(map.entries, rec.entries, required);
  for (const p of res.problems) console.error(`  ✗ ${p}`);
  console.log(`[rendered-diff] base=${base.slice(0, 8)} units=${rec.entries.length} listed=${map.entries.length} required=${required.join(',')}`);
  console.log(`RENDERED_DIFF_VERDICT=${res.verdict}`);
  process.exit(res.verdict === 'MATCH' ? 0 : 1);
}
