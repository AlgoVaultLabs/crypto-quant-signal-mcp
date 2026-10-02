#!/usr/bin/env node
// @ts-check
/**
 * build_readme_mcp_clients.mjs — README.md's "MCP clients" table, generated from MCP_CLIENTS.
 *
 * LANDING-MCP-CLIENTS-CLAIMS-W1 CH2 (R14). The table was a hand-maintained copy of the SoT, sat
 * outside every generated block, and had drifted three ways at once (a retired Claude menu, a
 * Claude Code command without `--transport http`, Cursor's old config path). It now lives
 * between two markers in a cqsm-owned namespace — never `BUILD:`, which belongs to the
 * algovault-skills writer — and is rendered by renderReadmeMcpClientsTable() from each row's
 * `readme` cells plus the declared README-only rows.
 *
 * Usage:
 *   node scripts/build_readme_mcp_clients.mjs              # write the region
 *   node scripts/build_readme_mcp_clients.mjs --check      # README_MCP_CLIENTS_VERDICT=IN_SYNC|DRIFT|INDETERMINATE
 *   node scripts/build_readme_mcp_clients.mjs --self-test  # README_MCP_CLIENTS_SELFTEST=PASS|FAIL
 *
 * Exit: 0 IN_SYNC (or written) · 1 DRIFT · 3 INDETERMINATE (missing/duplicated markers, missing
 * dist/, a renderer refusal). 3 is the token-law default for a new gate. No network, ever.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const START = '<!-- MCP_CLIENTS_README_TABLE:start -->';
export const END = '<!-- MCP_CLIENTS_README_TABLE:end -->';

/** The compiled renderer + SoT. Null = cannot verify (run `npm run build`). */
function loadSot(root = ROOT) {
  const dir = join(root, 'dist', 'lib', 'integrations-data');
  if (!existsSync(join(dir, 'render.js')) || !existsSync(join(dir, 'mcp-clients.js'))) return null;
  try {
    const render = require(join(dir, 'render.js'));
    const mod = require(join(dir, 'mcp-clients.js'));
    return { render, mod };
  } catch {
    return null;
  }
}

/**
 * Splice `table` into `readme` between the markers.
 * @returns {{ok: true, text: string, current: string} | {ok: false, why: string}}
 */
export function splice(readme, table) {
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s < 0 || e < 0) return { ok: false, why: 'marker pair missing' };
  if (readme.indexOf(START, s + 1) >= 0 || readme.indexOf(END, e + 1) >= 0) return { ok: false, why: 'marker duplicated' };
  if (e < s) return { ok: false, why: 'end marker precedes start marker' };
  const current = readme.slice(s + START.length, e);
  const text = readme.slice(0, s + START.length) + `\n${table}\n` + readme.slice(e);
  return { ok: true, text, current };
}

/** @returns {'IN_SYNC'|'DRIFT'|'INDETERMINATE'} */
export function verdictFor(readme, table) {
  const r = splice(readme, table);
  if (!r.ok) return 'INDETERMINATE';
  return r.text === readme ? 'IN_SYNC' : 'DRIFT';
}

export function selfTest() {
  const fails = [];
  const T = '| Client | Config |\n|---|---|\n| **A** | `a` |';
  const good = `# X\n\n${START}\n${T}\n${END}\n\nmore\n`;
  if (verdictFor(good, T) !== 'IN_SYNC') fails.push('in-sync region must read IN_SYNC');
  if (verdictFor(good.replace('`a`', '`b`'), T) !== 'DRIFT') fails.push('an edited cell must read DRIFT');
  if (verdictFor(good.replace(START, ''), T) !== 'INDETERMINATE') fails.push('a missing start marker must read INDETERMINATE');
  if (verdictFor(good.replace(END, ''), T) !== 'INDETERMINATE') fails.push('a missing end marker must read INDETERMINATE');
  if (verdictFor(good + START, T) !== 'INDETERMINATE') fails.push('a duplicated marker must read INDETERMINATE');
  // the writer touches its region and nothing else
  const w = splice(good.replace('`a`', '`b`'), T);
  if (!w.ok || w.text !== good) fails.push('splice must restore exactly the region');
  if (!w.ok || !w.text.startsWith('# X\n\n') || !w.text.endsWith('\n\nmore\n')) fails.push('splice must not touch text outside the markers');
  return { pass: fails.length === 0, fails };
}

const INVOKED = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    const st = selfTest();
    for (const f of st.fails) console.error(`  ✗ ${f}`);
    console.log(`README_MCP_CLIENTS_SELFTEST=${st.pass ? 'PASS' : 'FAIL'}`);
    process.exit(st.pass ? 0 : 1);
  }
  const done = (v, msg) => { if (msg) console.error(msg); console.log(`README_MCP_CLIENTS_VERDICT=${v}`); process.exit(v === 'IN_SYNC' ? 0 : v === 'DRIFT' ? 1 : 3); };
  const sot = loadSot();
  if (!sot) done('INDETERMINATE', '✗ dist/lib/integrations-data not loadable — run `npm run build`.');
  let table;
  try {
    table = sot.render.renderReadmeMcpClientsTable(sot.mod.default, sot.mod.README_MCP_CLIENT_ORDER, sot.mod.README_ONLY_MCP_CLIENT_ROWS);
  } catch (e) {
    done('INDETERMINATE', `✗ the renderer refused: ${e && e.message}`);
  }
  const path = join(ROOT, 'README.md');
  const readme = readFileSync(path, 'utf8');
  const r = splice(readme, table);
  if (!r.ok) done('INDETERMINATE', `✗ README.md: ${r.why} (${START} … ${END})`);
  if (argv.includes('--check')) {
    if (r.text === readme) { console.log(`✓ README.md "MCP clients" region matches MCP_CLIENTS (${table.split('\n').length - 2} rows).`); done('IN_SYNC'); }
    done('DRIFT', '✗ README.md "MCP clients" region differs from MCP_CLIENTS — run `npm run readme:clients` and commit.');
  }
  if (r.text !== readme) {
    writeFileSync(`${path}.tmp`, r.text);
    renameSync(`${path}.tmp`, path);
    console.log(`✓ wrote README.md "MCP clients" region (${table.split('\n').length - 2} rows).`);
  } else {
    console.log('✓ README.md "MCP clients" region already in sync.');
  }
  done('IN_SYNC');
}
