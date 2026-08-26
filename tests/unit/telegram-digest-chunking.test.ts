/**
 * OPS-GEO-DIGEST-DELIVERY-W1 — the operator digest outgrew Telegram and every
 * producer sharing `sendDigest` inherited a silent size cliff.
 *
 * THE DEFECT, measured on the live host 2026-08-26:
 *   `sendDigest` was `post(sections.join('\n\n'))` — ONE message, no chunker.
 *   The GEO weekly digest grew 39 → 67 → 69 sections and reached 5,583 UTF-16
 *   code units against Telegram's 4,096 limit. Every Monday from 2026-07-20 the
 *   POST returned `400 message is too long`, and the plain-text fallback — the
 *   one safety net — returned the SAME error, because dropping `parse_mode`
 *   does not shorten a message. Six consecutive digests were lost, and the only
 *   symptom was a `DIGEST SEND FAILED` line in a log nobody tails.
 *
 * Sections here are SYNTHETIC. The real digest carries internal funnel and
 * revenue figures and this repository is public.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-100123';
});

import { chunkSections, hasUnbalancedMarkdown, TELEGRAM_MAX_MESSAGE } from '../../src/lib/markdown-safe.js';
import { sendDigest, sendAlert } from '../../src/lib/telegram.js';

/** Section list whose joined length reproduces the measured 2026-08-17 overflow. */
function oversizedSections(totalUnits = 5583): string[] {
  const out: string[] = [];
  let n = 0;
  let i = 0;
  while (n < totalUnits) {
    const s = `*Section ${i}* — ${'x'.repeat(120)}`;
    out.push(s);
    n += s.length + 2;
    i++;
  }
  return out;
}

const stripMarker = (c: string) => c.replace(/\n\n— part \d+\/\d+$/, '');

describe('chunkSections — no message may exceed the Telegram limit', () => {
  it('the limit is the real one, in the units Telegram counts', () => {
    expect(TELEGRAM_MAX_MESSAGE).toBe(4096);
  });

  it('empty input produces no messages (nothing to send is not a failure to send)', () => {
    expect(chunkSections([])).toEqual([]);
  });

  it('a small digest stays ONE message with no part marker', () => {
    const chunks = chunkSections(['alpha', 'beta']);
    expect(chunks).toEqual(['alpha\n\nbeta']);
  });

  it('THE REGRESSION: the measured 5,583-unit digest splits, and every part fits', () => {
    const sections = oversizedSections();
    const joined = sections.join('\n\n');
    // Guard the fixture itself: if this ever stops overflowing, the test below is vacuous.
    expect(joined.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE);

    const chunks = chunkSections(sections);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
  });

  it('loses NOTHING — every section survives somewhere in the output', () => {
    const sections = oversizedSections();
    const all = chunkSections(sections).map(stripMarker).join('\n\n');
    for (const s of sections) expect(all).toContain(s);
  });

  it('splits on SECTION boundaries — a section that fits is never cut', () => {
    const sections = oversizedSections();
    for (const c of chunkSections(sections)) {
      for (const line of stripMarker(c).split('\n\n')) {
        if (line.startsWith('*Section')) expect(sections).toContain(line);
      }
    }
  });

  it('marks every part i/n so a partial delivery cannot look complete', () => {
    const chunks = chunkSections(oversizedSections());
    chunks.forEach((c, i) => expect(c.endsWith(`— part ${i + 1}/${chunks.length}`)).toBe(true));
  });

  it('the part marker is BUDGETED — it can never push a chunk back over the limit', () => {
    // Adversarial: sizes chosen so a naive "chunk then append the marker" lands
    // each chunk exactly at the limit before the marker is added.
    for (const width of [4094, 4095, 4096, 4090, 2048]) {
      const sections = [ 'a'.repeat(width), 'b'.repeat(width), 'c'.repeat(width) ];
      for (const c of chunkSections(sections)) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    }
  });

  it('a single OVER-LONG section is hard-split rather than dropped', () => {
    const monster = Array.from({ length: 400 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
    expect(monster.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE);
    const chunks = chunkSections([monster]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    expect(chunks.map(stripMarker).join('\n\n')).toContain('line 399');
  });

  it('an unbroken over-long LINE is still cut to fit (never silently dropped)', () => {
    const oneLine = 'z'.repeat(10_000);
    const chunks = chunkSections([oneLine]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    expect(chunks.map(stripMarker).join('').replace(/— part \d+\/\d+/g, '')).toContain('z'.repeat(4000));
  });
});

describe('hasUnbalancedMarkdown — the structural half of the mdValue lesson', () => {
  it('balanced entities pass', () => {
    expect(hasUnbalancedMarkdown('*bold* and _italic_ and `code`')).toBe(false);
  });

  it('the GEO defect: a bare snake_case value is caught', () => {
    expect(hasUnbalancedMarkdown('Move: pursue_placement · score 0.67')).toBe(true);
  });

  it('the original defect: `github_discussion` is caught', () => {
    expect(hasUnbalancedMarkdown('source github_discussion failed')).toBe(true);
  });

  it('the SAME value wrapped by mdValue is safe — code spans are literal', () => {
    expect(hasUnbalancedMarkdown('Move: `pursue_placement` · score 0.67')).toBe(false);
  });

  it('an odd backtick (an unclosed code span) is caught', () => {
    expect(hasUnbalancedMarkdown('a `b c')).toBe(true);
  });

  it('an underscore inside a fenced block is NOT an entity', () => {
    expect(hasUnbalancedMarkdown('```\na_b\n```')).toBe(false);
  });
});

describe('sendDigest — an oversized digest now DELIVERS', () => {
  let originalFetch: typeof fetch;
  let sent: Array<Record<string, unknown>>;

  const CHAT_NOT_FOUND = '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}';

  function mockFetch(status = 200, body = '{"ok":true}') {
    globalThis.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? '{}'));
      sent.push(payload);
      // The realistic failure: the DIGEST is rejected while the short escalation alert
      // gets through. Accepting the alert is what lets this count ONE escalation rather
      // than counting post()'s retry attempts on a mock that rejects everything.
      if (String(payload.text).includes('AlgoVault Alert')) return new Response('{"ok":true}', { status: 200 });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sent = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends several messages, each within the limit, and reports success', async () => {
    mockFetch();
    expect(await sendDigest(oversizedSections())).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
    for (const c of sent) expect(String(c.text).length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
  });

  it('PROVES THE FIX BITES: pre-fix this was ONE over-limit POST', async () => {
    // The defect verbatim — what the old implementation would have put on the wire.
    const preFix = oversizedSections().join('\n\n');
    expect(preFix.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE);
    mockFetch();
    await sendDigest(oversizedSections());
    expect(sent.some((c) => String(c.text) === preFix)).toBe(false);
  });

  it('never DOUBLE-marks a part — post() re-chunks what sendDigest already bounded', async () => {
    // sendDigest chunks on section boundaries, then every chunk passes through post(),
    // which chunks again as the generator-level backstop. The second pass must be a
    // no-op on an already-bounded message, or the operator sees `— part 1/2 — part 1/1`.
    mockFetch();
    await sendDigest(oversizedSections());
    for (const c of sent) {
      expect(String(c.text).match(/— part \d+\/\d+/g) ?? []).toHaveLength(1);
    }
  });

  it('a labelled producer ESCALATES once when delivery fails', async () => {
    mockFetch(400, CHAT_NOT_FOUND);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendDigest(['x'], { label: 'geo-weekly-cron' })).toBe(false);
    const alerts = sent.filter((c) => String(c.text).includes('AlgoVault Alert'));
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0].text)).toContain('geo-weekly-cron');
    expect(String(alerts[0].text)).toContain('FAILED to deliver');
  });

  it('an UNLABELLED producer stays silent — escalation is opt-in', async () => {
    mockFetch(400, CHAT_NOT_FOUND);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendDigest(['x'])).toBe(false);
    expect(sent.filter((c) => String(c.text).includes('AlgoVault Alert'))).toHaveLength(0);
  });

  it('sendAlert INHERITS the chunker — the fix is at the generator, not in one lane', async () => {
    // sendDigest was the lane that failed, but sendAlert sat behind the same un-chunked
    // post() and would have failed identically on a long enough body.
    mockFetch();
    const huge = Array.from({ length: 300 }, (_, i) => `finding ${i}: ${'d'.repeat(30)}`).join('\n');
    expect(huge.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE);
    expect(await sendAlert(huge, 'critical')).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
    for (const c of sent) expect(String(c.text).length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
  });

  it('a SUCCESSFUL digest never escalates', async () => {
    mockFetch();
    expect(await sendDigest(['x'], { label: 'geo-weekly-cron' })).toBe(true);
    expect(sent.filter((c) => String(c.text).includes('AlgoVault Alert'))).toHaveLength(0);
  });
});
