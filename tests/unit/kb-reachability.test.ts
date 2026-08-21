/**
 * OPS-KNOWLEDGE-BUNDLE-HOLD-PROMISE-W1 (CH3) — the reachability gate's own tests.
 *
 * The gate ships a `--self-test` and this file is NOT a second copy of it. `--self-test` proves the
 * pure classification logic; this proves the things a hermetic self-test is structurally blind to:
 * that the executable emits exactly ONE verdict token, that the token maps to the exit code the
 * token-law requires, and that the classifier's real-world traps stay closed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyEndpoint, extractToolRefs, normalizePath, routeResolves, statusIsReachable, hostFor, selfTest,
} from '../../scripts/check-kb-reachability.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = 'scripts/check-kb-reachability.mjs';

describe('classification — the traps that produced phantom findings on the real corpus', () => {
  it('reads an MCP tool endpoint as a TOOL claim', () => {
    expect(classifyEndpoint('MCP tool get_equity_call').tools).toEqual(['get_equity_call']);
  });

  it('`tools/call name=x` is a tool, and yields NO phantom /call route', () => {
    const c = classifyEndpoint('tools/call name=search_knowledge (MCP) — auth state');
    expect(c.tools).toEqual(['search_knowledge']);
    expect(c.paths).toEqual([]);
  });

  it('`tools/list` yields no phantom /list route', () => {
    expect(classifyEndpoint('POST /mcp (tools/list routing contract)').paths).toEqual(['/mcp']);
  });

  it('a non-HTTP resource URI is not a route', () => {
    // `algovault://venues` yielded a `//venues` "route" before this was handled.
    expect(classifyEndpoint('MCP resource algovault://venues — formatVenueForResource()').paths).toEqual([]);
  });

  it('one endpoint can make BOTH a tool and a route claim', () => {
    const c = classifyEndpoint('MCP tool scan_trade_calls + Streamable-HTTP /mcp');
    expect(c.tools).toEqual(['scan_trade_calls']);
    expect(c.paths).toEqual(['/mcp']);
  });

  it('a declared param route covers a concrete documented path', () => {
    // The x402 canonical alias is declared as DATA (`routePath: '/x402/get_trade_call'`), and the
    // family is mounted from a list — neither is an `app.post('literal')`.
    expect(routeResolves(new Set(['/x402/:tool']), '/x402/get_trade_call')).toBe('declared');
  });

  it('a prefix of declared routes resolves as a FAMILY and says so', () => {
    expect(routeResolves(new Set(['/x402/get_trade_call']), '/x402')).toBe('family');
  });

  it('a genuine miss is still a miss', () => {
    expect(routeResolves(new Set(['/api/a']), '/api/b')).toBe(false);
  });

  it('normalises an absolute URL and a .html page to their routes', () => {
    expect(normalizePath('https://algovault.com/docs.html')).toBe('/docs');
  });
});

describe("D4's lesson, encoded so it cannot be re-learned", () => {
  it('401 and 403 are REACHABLE — existence with refusal is not absence', () => {
    // /api/performance-shadow was reported as "a fictional endpoint published as real" on the
    // strength of a 404 read from the LANDING host. It answers 401 on the API host, and its
    // published contract was truthful the whole time.
    expect(statusIsReachable(401)).toBe(true);
    expect(statusIsReachable(403)).toBe(true);
    expect(statusIsReachable(404)).toBe(false);
  });

  it('no answer is INDETERMINATE, never a pass', () => {
    expect(statusIsReachable(null)).toBeNull();
  });

  it('routes an /api path to the API host and a rendered page to the landing host', () => {
    expect(hostFor('/api/performance-shadow', null)).toBe('api.algovault.com');
    expect(hostFor('/verify', null)).toBe('algovault.com');
    expect(hostFor('/verify', 'algovault.com')).toBe('algovault.com');
  });
});

describe('description scanning — class 3', () => {
  it('finds the referral that shipped to every agent', () => {
    expect(extractToolRefs('for a whole-market scan use scan_trade_calls, for US stocks use get_equity_call'))
      .toEqual(['scan_trade_calls', 'get_equity_call']);
  });
  it('is silent on corrected copy', () => {
    expect(extractToolRefs('Read-only: reads live exchange APIs, no orders.')).toEqual([]);
  });
});

describe('the gate runs for real', () => {
  it('its own self-test passes', () => {
    expect(selfTest()).toEqual([]);
  });

  // SPAWNS the gate — declared budget, per scripts/check-test-budget.mjs (options arg only).
  it('prints exactly ONE verdict token, as the last line, and exits 0 on PASS', { timeout: 120_000 }, () => {
    const out = execFileSync('node', [GATE, '--offline'], { cwd: ROOT, encoding: 'utf8' });
    const tokens = out.split('\n').filter((l) => l.startsWith('KB_REACHABILITY_VERDICT='));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toBe('KB_REACHABILITY_VERDICT=PASS');
    expect(out.trim().split('\n').at(-1)).toBe('KB_REACHABILITY_VERDICT=PASS');
  });

  it('prints the corpus SIZE beside the result — a zero finding with no denominator is not evidence', { timeout: 120_000 }, () => {
    const out = execFileSync('node', [GATE, '--offline'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/corpus \d+ response_shapes, \d+ live tools, \d+ declared routes/);
  });

  it('--self-test does NOT emit the verdict token it is testing', { timeout: 120_000 }, () => {
    const out = execFileSync('node', [GATE, '--self-test'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).not.toContain('KB_REACHABILITY_VERDICT=');
  });
});
