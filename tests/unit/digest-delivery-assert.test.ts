/**
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch4 — SEC-17: a load-bearing send that reported
 * success it never achieved.
 *
 * THE DEFECT, both halves:
 *   1. `sendDigest` returns a BOOLEAN and never throws. The weekly knowledge-page
 *      producer awaited it, DISCARDED the result, and logged "digest sent"
 *      unconditionally — so its catch block was unreachable. Three consecutive weeks of
 *      HTTP 400 rendered as success, and anyone triaging by grepping the log for
 *      "digest sent" concluded the path was healthy.
 *   2. The 400 itself was deterministic: `parse_mode: 'Markdown'` plus the single
 *      unescaped `_` in the source name `github_discussion`, which sat at BYTE OFFSET
 *      168 — byte-exact to Telegram's "Can't find end of the entity starting at byte
 *      offset 168". It would never have self-healed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  // telegram.ts reads the token/chat id at MODULE LOAD, so they must exist before import.
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-100123';
});

import { mdValue, sendDigest, sendAlert } from '../../src/lib/telegram.js';
import { buildDigestLines } from '../../scripts/refresh-knowledge-pages.mjs';

const PARSE_ERROR_BODY = JSON.stringify({
  ok: false,
  error_code: 400,
  description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 168",
});

let originalFetch: typeof fetch;
let calls: Array<Record<string, unknown>>;

/** Queue of responses; each fetch shifts one. */
function mockFetchSequence(responses: Array<{ status: number; body: string }>) {
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')));
    const r = responses.shift() ?? { status: 200, body: '{"ok":true}' };
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('mdValue — neutralises an interpolated value', () => {
  it('wraps in a code span so `_` cannot open an entity', () => {
    expect(mdValue('github_discussion')).toBe('`github_discussion`');
  });
  it('strips backticks that would close the span early', () => {
    expect(mdValue('a`b')).toBe('`ab`');
  });
  it('handles non-strings', () => {
    expect(mdValue(42)).toBe('`42`');
  });
});

describe('buildDigestLines — the byte-168 regression is pinned', () => {
  const perSource = [
    { source: 'devto', status: 'ok', count: 0 },
    { source: 'medium', status: 'ok', count: 10 },
    { source: 'youtube', status: 'ok', count: 0 },
    { source: 'github_discussion', status: 'ok', count: 0 },
  ];

  it('THE REGRESSION: no `_` or `[` survives OUTSIDE a code span', () => {
    const text = buildDigestLines(10, 10, perSource, [], mdValue).join('\n\n');
    let inCode = false;
    const bare: string[] = [];
    for (const ch of text) {
      if (ch === '`') { inCode = !inCode; continue; }
      if (!inCode && (ch === '_' || ch === '[')) bare.push(ch);
    }
    expect(bare).toEqual([]);
  });

  it('PROVES THE ASSERTION BITES: without mdValue the bare `_` reappears at byte 168', () => {
    // buildDigestLines defaults its renderer to identity, which IS the pre-fix behaviour.
    // If this did not fail the check above, the check above would be worthless.
    const text = buildDigestLines(10, 10, perSource, []).join('\n\n');
    let inCode = false;
    const bare: number[] = [];
    const buf = Buffer.from(text, 'utf8');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '`') { inCode = !inCode; continue; }
      if (!inCode && ch === '_') bare.push(i);
    }
    expect(bare.length).toBeGreaterThan(0);
    // …and it is exactly where Telegram said it was.
    expect(buf.indexOf(Buffer.from('_'))).toBe(168);
  });

  it('emits balanced entity markers (unbalanced is exactly what Telegram rejects)', () => {
    const text = buildDigestLines(10, 10, perSource, [], mdValue).join('\n\n');
    expect((text.match(/\*/g) ?? []).length % 2).toBe(0);
    expect((text.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it('still reports the same content (the fix must not hide the source name)', () => {
    const text = buildDigestLines(10, 10, perSource, [], mdValue).join('\n');
    expect(text).toContain('github_discussion');
    expect(text).toContain('Total pages: 10');
  });

  it('the error text of a failed source is neutralised too', () => {
    const withErr = [{ source: 'devto', status: 'failed', error: 'boom_under_score [x]' }];
    const text = buildDigestLines(0, 0, withErr, [], mdValue).join('\n');
    let inCode = false;
    const bare: string[] = [];
    for (const ch of text) {
      if (ch === '`') { inCode = !inCode; continue; }
      if (!inCode && (ch === '_' || ch === '[')) bare.push(ch);
    }
    expect(bare).toEqual([]);
  });
});

describe('sendDigest — asserts DELIVERY, not attempt', () => {
  it('returns true on a clean send', async () => {
    mockFetchSequence([{ status: 200, body: '{"ok":true}' }]);
    expect(await sendDigest(['hello'])).toBe(true);
  });

  it('a Markdown parse 400 falls back to PLAIN TEXT and still delivers', async () => {
    // Formatting must never cost delivery. First call (Markdown) 400s; the fallback
    // re-sends with no parse_mode and succeeds.
    //
    // OPS-GEO-DIGEST-DELIVERY-W1: the input is an unclosed `[`, deliberately NOT an
    // odd `_`. `hasUnbalancedMarkdown` now downgrades an odd `*`/`_`/backtick to plain
    // text PROACTIVELY, which would make the first POST plain and stop this test from
    // exercising the REACTIVE path at all. An unclosed bracket is outside that model,
    // so this keeps proving the reactive fallback still covers what the detector misses.
    mockFetchSequence([
      { status: 400, body: PARSE_ERROR_BODY },
      { status: 200, body: '{"ok":true}' },
    ]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendDigest(['a [b'])).toBe(true);
    expect(calls[0].parse_mode).toBe('Markdown');
    expect(calls[1].parse_mode).toBeUndefined(); // plain text
    expect(err.mock.calls.flat().join(' ')).toContain('DELIVERED AS PLAIN TEXT');
  });

  it('THE REGRESSION: returns FALSE when the send genuinely fails, so a caller cannot log success', async () => {
    // Every attempt rejected — including the plain-text fallback and the retry.
    mockFetchSequence([
      { status: 400, body: PARSE_ERROR_BODY },
      { status: 400, body: PARSE_ERROR_BODY },
      { status: 400, body: PARSE_ERROR_BODY },
      { status: 400, body: PARSE_ERROR_BODY },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendDigest(['a _b'])).toBe(false);
  });

  it('a non-parse 400 (e.g. bad chat id) does NOT trigger the plain-text fallback', async () => {
    mockFetchSequence([
      { status: 400, body: '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}' },
      { status: 400, body: '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}' },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendDigest(['x'])).toBe(false);
    expect(calls.every((c) => c.parse_mode === 'Markdown')).toBe(true);
  });

  it('logs the upstream HTTP status + body so a failure is diagnosable', async () => {
    mockFetchSequence([
      { status: 400, body: PARSE_ERROR_BODY },
      { status: 400, body: PARSE_ERROR_BODY },
      { status: 400, body: PARSE_ERROR_BODY },
      { status: 400, body: PARSE_ERROR_BODY },
    ]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sendDigest(['x']);
    const logged = err.mock.calls.flat().join(' ');
    expect(logged).toContain('[telegram] HTTP 400');
    expect(logged).toContain('byte offset 168');
  });

  it('sendAlert inherits the same delivery contract', async () => {
    mockFetchSequence([{ status: 200, body: '{"ok":true}' }]);
    expect(await sendAlert('escalation', 'warning')).toBe(true);
  });
});
