/**
 * BINANCE-AGENT-OS-TRUTH-AND-PAGE-W1 CH1 — the WIRING for
 * scripts/check-partner-install-coords.mjs.
 *
 * This file is what makes the gate a gate. `check-canaries-wired.mjs` holds no registry: a
 * script counts as WIRED when something that is not a comment actually invokes it, and for the
 * sibling `check-attribution-src-coverage.mjs` that something is its unit test. Importing the
 * audit here puts the gate inside the pre-push test-baseline gate AND inside deploy.yml's
 * vitest step, so a push or a deploy that introduces an unresolvable partner coordinate is
 * refused without anyone reading a page.
 *
 * Network discipline: the assertions that touch the real tree use an INJECTED probe, so the
 * suite is deterministic and offline. The live-network audit is the CLI's job (`npm run
 * partner:install:check`), not the unit suite's — a test that fails because npm was slow
 * teaches people to ignore it.
 */
import { describe, it, expect } from 'vitest';
import {
  auditPartnerInstallCoords,
  extractCoordinates,
  classifyMcpProbe,
  classifyPresenceProbe,
  isLikelyMcpEndpoint,
  scanTargets,
  selfTest,
} from '../../scripts/check-partner-install-coords.mjs';

const resolved = () => ({ state: 'resolved', detail: 'stub' });

describe('partner install coordinates — gate wiring', () => {
  it('the gate\'s own two-way self-test passes', () => {
    expect(selfTest()).toBe(true);
  });

  it('scans a non-empty corpus (vacuity: a scan of nothing is not a pass)', () => {
    const targets = scanTargets();
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.some((t: string) => t.startsWith('src/lib/integrations-data/'))).toBe(true);
    expect(targets.some((t: string) => t.startsWith('docs/integrations/'))).toBe(true);
  });

  it('finds real partner coordinates in the live tree', () => {
    const out = auditPartnerInstallCoords({ useCache: false, probe: resolved });
    expect(out.coordinates).toBeGreaterThan(0);
    expect(out.verdict).toBe('CLEAN');
  });

  it('an empty corpus is INDETERMINATE, never CLEAN', () => {
    const out = auditPartnerInstallCoords({ useCache: false, targets: [], probe: resolved });
    expect(out.verdict).toBe('INDETERMINATE');
    expect(out.reasons[0]).toContain('0 coordinates');
  });

  it('one fictional coordinate is enough to produce DRIFT', () => {
    // Keyed on ORDINAL POSITION, never on a vendor value: a scenario keyed on the coordinate
    // this chapter removes stops exercising DRIFT the moment the repair lands.
    let n = 0;
    const out = auditPartnerInstallCoords({
      useCache: false,
      probe: () => (n++ === 0 ? { state: 'fictional', detail: '404' } : resolved()),
    });
    expect(out.verdict).toBe('DRIFT');
  });

  it('an unverifiable probe never launders into CLEAN', () => {
    const out = auditPartnerInstallCoords({
      useCache: false, probe: () => ({ state: 'indeterminate', detail: 'rate-limited' }),
    });
    expect(out.verdict).toBe('INDETERMINATE');
  });
});

describe('R2b — an auth challenge is proof of life, not absence of it', () => {
  it.each([
    ['200 + serverInfo', 0, 200, '', 'data: {"result":{"serverInfo":{"name":"x"}}}', 'resolved'],
    ['401 with challenge', 0, 401, 'www-authenticate: Bearer realm="x"', '', 'resolved'],
    ['401 without challenge', 0, 401, 'server: waf', '', 'indeterminate'],
    ['404', 0, 404, '', '', 'fictional'],
    ['connection refused', 7, 0, '', '', 'fictional'],
    ['timeout', 28, 0, '', '', 'indeterminate'],
  ])('%s', (_name, curlExit, httpCode, headers, body, want) => {
    expect(classifyMcpProbe({ curlExit, httpCode, headers, body }).state).toBe(want);
  });

  it('Binance\'s live endpoint shape classifies CLEAN, so CH2 can pass CH1', () => {
    // Measured 2026-08-25: HTTP 401, content-length 0, www-authenticate: Bearer
    // resource_metadata="https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp".
    const verdict = classifyMcpProbe({
      curlExit: 0, httpCode: 401,
      headers: 'HTTP/2 401\r\nwww-authenticate: Bearer resource_metadata="https://agent.binance.com/.well-known/oauth-protected-resource/gateway-mcp"',
      body: '',
    });
    expect(verdict.state).toBe('resolved');
  });
});

describe('presence classifier (seam-bypassed by the injected probe, so asserted directly)', () => {
  it.each([[200, 'resolved'], [404, 'fictional'], [403, 'indeterminate'], [429, 'indeterminate'], [0, 'indeterminate']])(
    'HTTP %i ⇒ %s', (code, want) => {
      expect(classifyPresenceProbe(code as number, 'x').state).toBe(want);
    },
  );
});

describe('"contains mcp" is not "is an MCP endpoint"', () => {
  it.each([
    ['https://agent.binance.com/mcp/agentic', true],
    ['https://code.claude.com/docs/en/mcp', false],
    ['https://www.npmjs.com/package/bitget-mcp-server', false],
    ['https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/issues', false],
    ['https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp', false],
  ])('%s ⇒ %s', (url, want) => {
    expect(isLikelyMcpEndpoint(url as string)).toBe(want);
  });

  it('the discriminator is wired into extraction, not merely correct in isolation', () => {
    const doc = extractCoordinates("  a: 'https://code.claude.com/docs/en/mcp',", 'x.ts');
    expect(doc.some((c: { kind: string }) => c.kind === 'mcp-endpoint')).toBe(false);
    const real = extractCoordinates("  a: 'https://agent.binance.com/mcp/agentic',", 'x.ts');
    expect(real.some((c: { kind: string }) => c.kind === 'mcp-endpoint')).toBe(true);
  });
});

describe('regression — the exact defect this chapter retired', () => {
  it('no source ships a claude-plugin coordinate for binance/binance-skills-hub', () => {
    const hits = [];
    for (const rel of scanTargets()) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const text = require('node:fs').readFileSync(require('node:path').join(process.cwd(), rel), 'utf8');
      for (const c of extractCoordinates(text, rel)) {
        if (c.kind === 'claude-plugin' && c.value === 'binance/binance-skills-hub') hits.push(`${rel}:${c.line}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('comment stripping preserves line numbers, so a finding names the line it read', () => {
    const text = ['/* a', ' * docblock', ' */', 'const a = 1;', "  x: 'claude plugin install owner/repo',"].join('\n');
    expect(extractCoordinates(text, 'x.ts')[0].line).toBe(5);
  });
});
