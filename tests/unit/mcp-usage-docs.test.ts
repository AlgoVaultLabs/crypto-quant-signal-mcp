/**
 * Unit tests for v1.10.3 MCP_USAGE_HTML constant.
 *
 * Asserts:
 *   - Section anchor `id="connect-mcp"` is present (deep-link target)
 *   - All 6 client surfaces appear (table rows + <details> blocks)
 *   - Per-client config snippets contain the verified URL/path/header markers
 *   - No raw-curl example without a pointer to the raw HTTP / curl guide (per the
 *     OUTPUT-SANITIZE-W1 follow-up rule about not shipping broken quickstart copy).
 *     DOCS-SAMPLE-EXECUTABLE-W1: that rule originally demanded a 3-step-handshake
 *     reference. The transport has been stateless since OPS-MCP-SESSION-RESILIENCE-W1,
 *     so a one-shot `tools/call` is correct and complete; the POINTER requirement is
 *     what survives, and this line is corrected rather than left stating the old
 *     premise as fact.
 *   - Verification footnote cites the 5 official-doc URLs
 *   - The handshake claim is absent from all six surfaces, and the working one-shot
 *     call is present (forbidden-phrase + positive-presence pair, bottom of file)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_USAGE_HTML } from '../../src/lib/mcp-usage-docs.js';
import { freeCallsLabel, freeDailyCallsLabel } from '../../src/lib/plans.js';

describe('MCP_USAGE_HTML — structural invariants', () => {
  it('contains the #connect-mcp anchor (deep-link target from welcome email + signup page)', () => {
    expect(MCP_USAGE_HTML).toContain('id="connect-mcp"');
  });

  it('has the "Connect Your MCP Client" section heading', () => {
    // The doc was restructured under a top-level "Integration" <h2> with
    // three <h3> subsections (MCP Client / AI Agent / Exchange Kit); the
    // MCP-client walkthrough heading is now an <h3> carrying id="connect-mcp".
    expect(MCP_USAGE_HTML).toMatch(/<h[23][^>]*>[\s\S]*Connect Your MCP Client[\s\S]*<\/h[23]>/);
  });

  it.each([
    ['Claude Desktop',     /claude_desktop_config\.json/],
    ['Cursor',             /\.cursor\/mcp\.json/],
    ['Cline',              /cline_mcp_settings\.json|streamableHttp/],
    ['Claude Code',        /claude mcp add/],
    ['Smithery',           /@smithery\/cli install/],
    ['Plain HTTP',         /api\.algovault\.com\/mcp/],
  ])('mentions %s with verified config marker', (name, configPattern) => {
    expect(MCP_USAGE_HTML).toContain(name);
    expect(MCP_USAGE_HTML).toMatch(configPattern);
  });

  it('uses streamableHttp (the recommended modern transport for Cline)', () => {
    expect(MCP_USAGE_HTML).toContain('streamableHttp');
  });

  it('cites all 5 verified upstream doc URLs in the footnote', () => {
    expect(MCP_USAGE_HTML).toContain('modelcontextprotocol.io/quickstart/user');
    expect(MCP_USAGE_HTML).toContain('cursor.com/docs/context/mcp');
    expect(MCP_USAGE_HTML).toContain('docs.cline.bot/mcp');
    expect(MCP_USAGE_HTML).toContain('code.claude.com/docs/en/mcp');
    expect(MCP_USAGE_HTML).toContain('@smithery/cli');
  });

  it('cites the verification fetch date so future drift is auditable', () => {
    expect(MCP_USAGE_HTML).toMatch(/verified \d{4}-\d{2}-\d{2}/i);
  });

  it('has at least one <details> walkthrough per client surface (≥6)', () => {
    // Shape-not-frozen-count (Build Rule 5): the doc grew from the original 6
    // MCP-client walkthroughs to also cover AI-agent + exchange-kit surfaces
    // (17 <details> at time of writing). The 6 enumerated client surfaces
    // above remain the floor — assert ≥6 rather than an exact count that
    // drifts every time a surface/walkthrough is added.
    const matches = MCP_USAGE_HTML.match(/<details[^>]*>/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  it('the Plain-HTTP block points at the raw HTTP / curl guide (no broken raw-curl repeat)', () => {
    // Per OUTPUT-SANITIZE-W1 fix-forward: don't ship a raw `tools/call` curl with no working
    // context OR no pointer to the #testing-with-curl section. The POINTER requirement survives
    // verbatim and is what this line asserts.
    //
    // DOCS-SAMPLE-EXECUTABLE-W1 inverted the PREMISE behind it, not the assertion. That rule was
    // written when a bare `tools/call` genuinely was broken without the initialize →
    // notifications/initialized → tools/call dance. The transport has been stateless since
    // OPS-MCP-SESSION-RESILIENCE-W1, so a one-shot `tools/call` is now correct AND complete — the
    // dance is optional. What still matters is that this block does not strand the reader.
    expect(MCP_USAGE_HTML).toMatch(/href="#testing-with-curl"/);
  });

  it('mentions free-tier unlock copy (all coins + all timeframes, the two allowance caps)', () => {
    expect(MCP_USAGE_HTML).toMatch(/every coin.*every timeframe|all 11 timeframes|every supported/i);
    // Derived from the plan SoT, not a literal: R-B moved the free cap 100 -> 200 and added a
    // second daily meter, and a hardcoded expectation here is what makes the next move a chore.
    expect(MCP_USAGE_HTML).toContain(`capped at ${freeCallsLabel()} calls/month`);
    expect(MCP_USAGE_HTML).toContain(`${freeDailyCallsLabel()} calls per UTC day`);
  });
});

describe('MCP_USAGE_HTML — channel-attribution track token (OPS-TRACK-TOKEN-STDIO-CLIENT-WRAPPER-W1)', () => {
  it('embeds the no-space mcp-remote args form X-AlgoVault-Track-Token:chan-docs', () => {
    // No space after the colon — dodges the Claude-Desktop/Cursor Windows
    // npx arg-mangling bug (geelen/mcp-remote README).
    expect(MCP_USAGE_HTML).toContain('"--header", "X-AlgoVault-Track-Token:chan-docs"');
  });

  it('embeds the headers-object JSON form "X-AlgoVault-Track-Token": "chan-docs"', () => {
    expect(MCP_USAGE_HTML).toContain('"X-AlgoVault-Track-Token": "chan-docs"');
  });

  it('uses a chan-docs slug that satisfies the C6 reader TOKEN_RE (8–64) so it actually records', () => {
    // Guards the R0 finding: a slug < 8 chars (e.g. the original "docs") is
    // SILENTLY rejected by extractHeaderTrackToken → zero attribution.
    expect('chan-docs').toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('rewrites the free-tier prose to keep the tracking header (auth dropped, tracking kept)', () => {
    expect(MCP_USAGE_HTML).not.toContain('drop the <code class="text-xs">--header</code> args entirely');
    expect(MCP_USAGE_HTML).toContain('keep the <code class="text-xs">X-AlgoVault-Track-Token</code> header');
  });
});

/**
 * DOCS-SAMPLE-EXECUTABLE-W1 CH1 — the forbidden-phrase + positive-presence pair
 * (Design.md §10 `forbidden-phrase-plus-positive-presence-test-template`).
 *
 * WHAT ROTTED, AND WHY A PAIR. The docs told every non-MCP integrator that Streamable-HTTP
 * "needs a 3-step handshake before tools/call". It was true until OPS-MCP-SESSION-RESILIENCE-W1
 * made the transport stateless, and then nobody revisited the sentence — while
 * `check-mcp-stateless.mjs` asserted the OPPOSITE, green, on every deploy. A forbidden-phrase test
 * alone catches drift BACK to the old claim; the positive half catches drift AWAY from the new one,
 * which is the direction a regeneration bug takes you.
 *
 * 🛑 THE NEGATION TRAP, and why the third pattern is not a plain substring ban. The spec's draft
 * banned `/handshake (is )?required/i`. `landing/docs.html` already contained
 * "No streamable-HTTP handshake required" — CORRECT copy asserting exactly what this wave wants —
 * and a substring ban reddens on it. The negator is not adjacent ("No streamable-HTTP handshake"),
 * so a fixed lookbehind does not help either. A match is therefore a violation only when no
 * negator appears in the preceding window. Design.md §10 `comment-vs-rendered-DOM-aware-canary`
 * supplies the other half: HTML and JS comments are stripped first, because a rollback note
 * quoting the old claim is archaeology, not an assertion.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The six surfaces the claim was duplicated across. */
const CLAIM_SURFACES = [
  'docs-src/partials/channel-mcp.html',
  'landing/docs.html',
  'landing/mcp.html',
  'src/lib/integrations-data/mcp-clients.ts',
  'src/lib/email.ts',
  'src/lib/welcome-page.ts',
];

/** Strip HTML + JS comments before any ban-grep. */
function stripComments(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Affirmative claims only — a match preceded by a negator inside the window is correct copy. */
function affirmativeHandshakeClaims(src: string): string[] {
  const hits: string[] = [];
  const patterns = [
    /(needs?|requires?) a 3-step handshake/gi,
    /3-step handshake/gi,
    /handshake (is )?required/gi,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      if (/\b(no|not|never|without|skip|skips)\b[^.]*$/i.test(before)) continue; // negated ⇒ correct
      hits.push(src.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20).replace(/\s+/g, ' '));
    }
  }
  return hits;
}

describe('DOCS-SAMPLE-EXECUTABLE-W1 — the handshake claim is gone, and the working call is present', () => {
  it.each(CLAIM_SURFACES)('FORBIDDEN: %s makes no affirmative 3-step-handshake claim', (rel) => {
    const hits = affirmativeHandshakeClaims(stripComments(readFileSync(resolve(ROOT, rel), 'utf8')));
    expect(hits, `${rel} still asserts the handshake is required:\n  ${hits.join('\n  ')}`).toEqual([]);
  });

  it.each(['docs-src/partials/channel-mcp.html', 'landing/mcp.html'])(
    'POSITIVE: %s ships the one-shot tools/call block',
    (rel) => {
      const src = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(src, `${rel} lost the one-shot call`).toMatch(/"method":\s*"tools\/call"/);
      // Both Accept types — the gotcha that costs integrator time, and P2's live-proven behaviour.
      expect(src, `${rel} lost the dual-Accept header`).toContain('application/json, text/event-stream');
    },
  );

  it('POSITIVE: the source partial states the transport is stateless, in prose', () => {
    const src = readFileSync(resolve(ROOT, 'docs-src/partials/channel-mcp.html'), 'utf8');
    expect(src).toMatch(/stateless/i);
    expect(src).toMatch(/no session id/i);
  });

  it('the negation guard works in BOTH directions (proven, not assumed)', () => {
    // Without this the forbidden test could pass because the matcher is broken rather than because
    // the copy is clean — and the false-positive it exists to tolerate is real, live prose.
    expect(affirmativeHandshakeClaims('the transport needs a 3-step handshake before tools/call')).toHaveLength(2);
    expect(affirmativeHandshakeClaims('No streamable-HTTP handshake required — just POST')).toEqual([]);
    expect(affirmativeHandshakeClaims('<!-- old: needs a 3-step handshake -->')).toHaveLength(2);
    expect(affirmativeHandshakeClaims(stripComments('<!-- old: needs a 3-step handshake -->'))).toEqual([]);
  });

  it('the retained handshake block is labelled OPTIONAL, not deleted', () => {
    // tests/build-docs.test.ts:81 and src/lib/docs-outline.ts both depend on the
    // #testing-with-curl section surviving; the block stays, its status changes.
    const src = readFileSync(resolve(ROOT, 'docs-src/partials/channel-mcp.html'), 'utf8');
    expect(src).toMatch(/Optional: the full MCP session handshake/i);
    expect(src).toMatch(/notifications\/initialized/);
  });
});
