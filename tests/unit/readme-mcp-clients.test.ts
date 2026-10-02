/**
 * LANDING-MCP-CLIENTS-CLAIMS-W1 CH2 (R14) — README.md's "MCP clients" table is generated from
 * MCP_CLIENTS, never hand-typed.
 *
 * THE BUG CLASS. The table was a hand-maintained twin of the SoT, outside every generated block,
 * and had drifted three ways at once: Claude's retired Settings → Connectors menu, a Claude Code
 * command without `--transport http`, and Cursor's old `~/.cursor/config.json`. Nothing bound it,
 * so nothing failed. It is now rendered by renderReadmeMcpClientsTable() into the
 * <!-- MCP_CLIENTS_README_TABLE:start/end --> region by scripts/build_readme_mcp_clients.mjs.
 *
 * WHAT THIS PINS: the region equals the renderer's output (lockstep) · the row order is the one the
 * table has always had · every README-only row carries a reason and is byte-identical to what the
 * README already said · the ratified R14 cells are present · README URLs stay bare · the renderer
 * refuses a broken order instead of emitting a partial table · the writer's own verdicts.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import MCP_CLIENTS from '../../src/lib/integrations-data/mcp-clients.js';
import { README_CELLS, README_MCP_CLIENT_ORDER, README_ONLY_MCP_CLIENT_ROWS } from '../../src/lib/integrations-data/readme-mcp-clients.js';
import { renderReadmeMcpClientsTable } from '../../src/lib/integrations-data/render.js';

const REPO = join(__dirname, '..', '..');
const README = readFileSync(join(REPO, 'README.md'), 'utf8');
const START = '<!-- MCP_CLIENTS_README_TABLE:start -->';
const END = '<!-- MCP_CLIENTS_README_TABLE:end -->';
const region = () => README.slice(README.indexOf(START) + START.length, README.indexOf(END));
const table = () => renderReadmeMcpClientsTable(MCP_CLIENTS, README_MCP_CLIENT_ORDER, README_ONLY_MCP_CLIENT_ROWS);

describe('the README region is the renderer output (lockstep)', () => {
  it('carries exactly one marker pair, start before end', () => {
    expect(README.split(START).length - 1).toBe(1);
    expect(README.split(END).length - 1).toBe(1);
    expect(README.indexOf(START)).toBeLessThan(README.indexOf(END));
  });

  it('the region deep-equals renderReadmeMcpClientsTable()', () => {
    expect(region()).toBe(`\n${table()}\n`);
  });

  it('the generated table is not empty — header, separator and every declared row', () => {
    expect(table().split('\n').length).toBe(2 + README_MCP_CLIENT_ORDER.length);
  });
});

describe('order and README-only rows', () => {
  it('keeps the order the table has always had', () => {
    expect([...README_MCP_CLIENT_ORDER]).toEqual(['claude-desktop', 'claude-code', 'cursor', 'cline', 'codex', 'windsurf', 'continue', 'any-other']);
    const clients = region().split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Client')).map((l) => l.split(' | ')[0].slice(2));
    expect(clients).toEqual(['**Claude Desktop**', '**Claude Code** (CLI)', '**Cursor**', '**Cline**', '**Codex** (OpenAI CLI)', '**Windsurf**', '**Continue.dev**', 'Any other MCP-spec-compliant client']);
  });

  it('every README-only row carries a reason', () => {
    for (const r of README_ONLY_MCP_CLIENT_ROWS) expect(r.reason.trim().length, r.key).toBeGreaterThan(20);
  });

  it('README-only rows are byte-identical to what the README already said (no copy change)', () => {
    const lines = region().split('\n');
    for (const want of [
      '| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` → `mcpServers.algovault.serverUrl = "https://api.algovault.com/mcp"` |',
      '| **Continue.dev** | `config.yaml` → `mcpServers: [{ name: algovault, type: streamable-http, url: "https://api.algovault.com/mcp" }]` |',
      '| Any other MCP-spec-compliant client | Configure the Streamable HTTP transport with URL `https://api.algovault.com/mcp` |',
    ]) expect(lines).toContain(want);
  });
});

describe('every README cell is attached to its row by slug', () => {
  it('each MCP_CLIENTS row with README cells carries exactly README_CELLS[slug]', () => {
    for (const e of MCP_CLIENTS.entries) {
      if (README_CELLS[e.slug]) expect(e.readme, e.slug).toBe(README_CELLS[e.slug]);
      else expect(e.readme, e.slug).toBeUndefined();
    }
    expect(Object.keys(README_CELLS).every((k) => MCP_CLIENTS.entries.some((e) => e.slug === k))).toBe(true);
  });
});

describe('R14 — the ratified cells', () => {
  it('carries the three corrected cells', () => {
    const r = region();
    expect(r).toContain('| **Claude Desktop** | Customize → Connectors → + → Add custom connector → `https://api.algovault.com/mcp` |');
    expect(r).toContain('| **Claude Code** (CLI) | `claude mcp add --transport http crypto-quant-signal https://api.algovault.com/mcp` |');
    expect(r).toContain('| **Cursor** | `~/.cursor/mcp.json` → `mcpServers` block → `url: "https://api.algovault.com/mcp"` |');
    expect(r).not.toMatch(/Settings → Connectors|claude mcp add crypto-quant-signal https|~\/\.cursor\/config\.json/);
  });

  it('README URLs stay bare — a ?src tag outranks Referer and would launder registry traffic', () => {
    expect(region()).not.toContain('?src');
  });
});

describe('the renderer refuses a broken order rather than emit a partial table', () => {
  const only = README_ONLY_MCP_CLIENT_ROWS;
  it.each([
    ['a duplicated key', [...README_MCP_CLIENT_ORDER, 'codex'], only],
    ['an unknown key', [...README_MCP_CLIENT_ORDER, 'nonesuch'], only],
    ['a missing key', README_MCP_CLIENT_ORDER.filter((k) => k !== 'cursor'), only],
    ['a README-only row with no reason', README_MCP_CLIENT_ORDER, only.map((r) => (r.key === 'windsurf' ? { ...r, reason: ' ' } : r))],
  ])('throws on %s', (_name, order, readmeOnly) => {
    expect(() => renderReadmeMcpClientsTable(MCP_CLIENTS, order as string[], readmeOnly as typeof only)).toThrow();
  });
});

describe('the writer (scripts/build_readme_mcp_clients.mjs)', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts', 'build_readme_mcp_clients.mjs'), ...args], { encoding: 'utf8', cwd: REPO });

  it('--check reads IN_SYNC on the committed README, with one terminal token', () => {
    const r = run('--check');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.match(/README_MCP_CLIENTS_VERDICT=/g)).toHaveLength(1);
    expect(r.stdout).toContain('README_MCP_CLIENTS_VERDICT=IN_SYNC');
  });

  it('--self-test proves IN_SYNC, DRIFT and INDETERMINATE in both directions', () => {
    const r = run('--self-test');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('README_MCP_CLIENTS_SELFTEST=PASS');
  });
});
