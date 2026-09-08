/**
 * IDENTITY-LIFECYCLE-W3 CH4 — the digest parser, the census, and the scoreboard anchors.
 *
 * The census assertions carry the most weight. `elicitation_capable` is NULLABLE for a reason —
 * the transport is stateless and `initialize` is optional, so "never handshook" must never be
 * counted as "not capable". A boolean column would have made that mistake unrepresentable in the
 * data and invisible in the number, which is exactly how a go/no-go gets decided on a figure that
 * measures something else.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'a'.repeat(48);

function freshEnv(): void {
  vi.resetModules();
  process.env.PERFORMANCE_DB_PATH = ':memory:';
  process.env.ALGOVAULT_IP_HASH_KEY = KEY;
  delete process.env.DATABASE_URL;
  delete process.env.LIFECYCLE_MODE;
}

const README = `# AlgoVault

Intro prose that must never be mailed.

## What's new in v1.29.0

- **Something shipped** with a \`code span\` and a [link](https://algovault.com).
- A second bullet.

### v1.28.x highlights (recap)

- This is a RECAP and must not be mailed again.

## Something else entirely

Not a what's-new block.
`;

describe('digest — parsing the README', () => {
  beforeEach(freshEnv);

  it('extracts the version block and EXCLUDES the recap', async () => {
    const { parseWhatsNew } = await import('../../src/lib/lifecycle/digest.js');
    const blocks = parseWhatsNew(README);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].version).toBe('v1.29.0');
    expect(blocks[0].markdown).toContain('Something shipped');
    // Recaps are a rolling 3-minor window the release process trims. Mailing them would re-send
    // content a reader already had, every month, for three months.
    expect(blocks[0].markdown).not.toContain('RECAP');
    expect(blocks[0].markdown).not.toContain('Not a what');
  });

  it('a README with no what\'s-new block yields NOTHING rather than an empty digest', async () => {
    const { parseWhatsNew } = await import('../../src/lib/lifecycle/digest.js');
    expect(parseWhatsNew('# AlgoVault\n\nNo releases yet.\n')).toHaveLength(0);
  });

  it('converts the block verbatim — no new prose is introduced', async () => {
    const { parseWhatsNew, markdownToEmailHtml, markdownToEmailText } = await import('../../src/lib/lifecycle/digest.js');
    const b = parseWhatsNew(README)[0];
    const html = markdownToEmailHtml(b.markdown);
    expect(html).toContain('<strong>Something shipped</strong>');
    expect(html).toContain('<code');
    expect(html).toContain('href="https://algovault.com"');
    const text = markdownToEmailText(b.markdown);
    expect(text).toContain('• Something shipped');
    // The markdown SOURCE must not leak into a plain-text email.
    expect(text).not.toContain('**');
    expect(text).toContain('link (https://algovault.com)');
    // The ONLY sentence the wave adds anywhere is the consent line, and it is not in the body.
    expect(html).not.toMatch(/we thought you|excited|check out/i);
  });

  it('escapes HTML in the source — a README is not a trusted template', async () => {
    const { markdownToEmailHtml } = await import('../../src/lib/lifecycle/digest.js');
    expect(markdownToEmailHtml('- <script>alert(1)</script>')).not.toContain('<script>');
  });
});

describe('census — a handshake is not the same as a capability', () => {
  beforeEach(freshEnv);

  it('reads the elicitation capability off an initialize envelope', async () => {
    const { capabilityFromInitialize } = await import('../../src/lib/lifecycle/census.js');
    const cap = capabilityFromInitialize({
      method: 'initialize',
      params: { capabilities: { elicitation: {} }, clientInfo: { name: 'claude-code', version: '2.1' } },
    });
    expect(cap).toEqual({ elicitationCapable: true, clientName: 'claude-code', clientVersion: '2.1' });
  });

  it('an EMPTY elicitation object still means capable — presence is the signal', async () => {
    const { capabilityFromInitialize } = await import('../../src/lib/lifecycle/census.js');
    // The 2025-11-25 spec declares elicitation as an object; clients are not required to put a
    // flag inside it, so testing truthiness of a nested field would under-count every one of them.
    expect(capabilityFromInitialize({ method: 'initialize', params: { capabilities: { elicitation: {} } } })?.elicitationCapable).toBe(true);
    expect(capabilityFromInitialize({ method: 'initialize', params: { capabilities: {} } })?.elicitationCapable).toBe(false);
  });

  it('a plain tool call records NOTHING — only initialize is a handshake', async () => {
    const { capabilityFromInitialize } = await import('../../src/lib/lifecycle/census.js');
    expect(capabilityFromInitialize({ method: 'tools/call', params: { name: 'get_trade_call' } })).toBeNull();
    expect(capabilityFromInitialize(null)).toBeNull();
    expect(capabilityFromInitialize('not an object')).toBeNull();
    expect(capabilityFromInitialize({ method: 'initialize' })?.elicitationCapable).toBe(false);
  });

  it('malformed caller-controlled input never throws', async () => {
    const { capabilityFromInitialize } = await import('../../src/lib/lifecycle/census.js');
    for (const bad of [{ method: 'initialize', params: 'x' }, { method: 'initialize', params: { capabilities: 7, clientInfo: [] } }]) {
      expect(() => capabilityFromInitialize(bad)).not.toThrow();
    }
  });

  it('NO HANDSHAKE is reported separately and NEVER as incapable', async () => {
    const { readCensus, ensureCensusColumns } = await import('../../src/lib/lifecycle/census.js');
    const { dbExec, dbRun } = await import('../../src/lib/performance-db.js');
    dbExec(`CREATE TABLE IF NOT EXISTS agent_sessions (session_id TEXT PRIMARY KEY, first_seen BIGINT, last_seen BIGINT, call_count INTEGER, tools_used TEXT, tiers_seen TEXT, first_tool TEXT, first_tier TEXT, ip_hash_first TEXT, first_touch_source TEXT, last_touch_source TEXT)`);
    ensureCensusColumns();
    // Two handshakes (one capable), and three sessions that never sent initialize.
    const ins = (id: string, cap: number | null, name: string | null) => dbRun(
      `INSERT INTO agent_sessions (session_id, first_seen, last_seen, call_count, elicitation_capable, client_name)
       VALUES (?, 1, 1, 1, ?, ?)`, id, cap, name);
    ins('a', 1, 'claude-code');
    ins('b', 0, 'claude-desktop');
    for (const id of ['c', 'd', 'e']) ins(id, null, null);

    const c = await readCensus();
    expect(c.handshaking).toBe(2);
    expect(c.capable).toBe(1);
    expect(c.noHandshake).toBe(3);
    // The denominator is HANDSHAKING sessions. Counting the 3 as incapable would report 1/5 = 20%
    // and would be measuring how many clients skip the handshake, not how many support the
    // feature — and 20% vs 50% is the difference between building the next wave and dropping it.
    expect(c.byClient.find((x) => x.name === 'claude-code')?.capable).toBe(1);
  });

  it('a share below n=30 is NULL, and says so — a percentage over 2 sessions is noise', async () => {
    const { readCensus, ensureCensusColumns, CENSUS_MIN_N } = await import('../../src/lib/lifecycle/census.js');
    const { dbExec, dbRun } = await import('../../src/lib/performance-db.js');
    dbExec(`CREATE TABLE IF NOT EXISTS agent_sessions (session_id TEXT PRIMARY KEY, first_seen BIGINT, last_seen BIGINT, call_count INTEGER)`);
    ensureCensusColumns();
    for (let i = 0; i < 5; i += 1) dbRun(`INSERT INTO agent_sessions (session_id, first_seen, last_seen, call_count, elicitation_capable) VALUES ('s${i}', 1, 1, 1, 1)`);
    const small = await readCensus();
    expect(small.capableShare).toBeNull();
    expect(small.lowSample).toBe(true);

    for (let i = 5; i < CENSUS_MIN_N + 1; i += 1) dbRun(`INSERT INTO agent_sessions (session_id, first_seen, last_seen, call_count, elicitation_capable) VALUES ('s${i}', 1, 1, 1, 1)`);
    const big = await readCensus();
    expect(big.lowSample).toBe(false);
    expect(big.capableShare).toBe(1);
  });

  it('an unreadable table degrades to a low-sample zero, never a confident number', async () => {
    const { readCensus } = await import('../../src/lib/lifecycle/census.js');
    const c = await readCensus();
    expect(c.handshaking).toBe(0);
    expect(c.capableShare).toBeNull();
    expect(c.lowSample).toBe(true);
  });
});

describe('scoreboard — the CH4 gate anchors render', () => {
  beforeEach(freshEnv);

  it('the dashboard carries all three headings the gate greps for', async () => {
    const { renderFunnelDashboardHtml } = await import('../../src/lib/funnel-dashboard-html.js');
    const html = renderFunnelDashboardHtml();
    for (const anchor of ['Lifecycle sends', 'Identity claim rate', 'Elicitation-capable']) {
      expect(html, anchor).toContain(anchor);
    }
  });

  it('the panel says WHY a zero is a zero — state beside the count', async () => {
    const { renderFunnelDashboardHtml } = await import('../../src/lib/funnel-dashboard-html.js');
    const html = renderFunnelDashboardHtml();
    // `shadow` next to a 0 reads as "not lit yet"; a bare 0 reads as "broken". For most of this
    // wave's life every count IS 0 by construction, so the label is what makes the panel usable.
    expect(html).toContain("'Step','State','Would send'");
    expect(html).toContain('never sent initialize, which is NOT the same as not capable');
  });
});
