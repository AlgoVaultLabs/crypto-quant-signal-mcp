/**
 * OPS-DIGEST-DELIVERY-DURABLE-W1 CH1 — the transport classifies, waits, and says why.
 *
 * THE INCIDENT (2026-10-15 08:00Z, signal-1): the daily monitor digest logged
 *   [telegram] attempt 1 failed: fetch failed
 *   [telegram] attempt 2 failed: fetch failed
 * — two attempts with ZERO delay between them, the errno discarded — and the escalation sent
 * seconds later over the same token and chat was delivered. The failure had already cleared;
 * the transport lost the day's digest anyway, and the page told the operator to read a
 * `[telegram] HTTP` line that does not exist for a network failure.
 *
 * Fixture provenance (never invented phrasing):
 *   - 400 entity / 400 too long — verbatim response bodies from signal-1's producer logs
 *     (shadow-digest.log, geo-weekly-cron.log; R0.3 census).
 *   - 400 chat not found — the body this repo's delivery suites already pin.
 *   - 429 / 5xx / 401 / 403 / 404 — the Bot API response object as documented at
 *     core.telegram.org/bots/api ("Making requests": ok · error_code · description ·
 *     parameters; ResponseParameters.retry_after). The classifier reads the STATUS and
 *     `parameters.retry_after`, never the description text, for these rows.
 *   - the network rejections are REAL shapes: undici's `TypeError('fetch failed')` with an
 *     errno `cause`, and the DOMException `AbortSignal.timeout()` actually raises.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  // telegram.ts reads the token/chat id at MODULE LOAD, so they must exist before import.
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-100123';
});

import {
  sendDigest,
  sendAlert,
  deliverText,
  classifyTelegramFailure,
  redactBotToken,
  renderDigestFailurePage,
  TELEGRAM_RETRY_POLICY,
  _setTelegramTimeForTest,
  _setDigestLedgerForTest,
} from '../../src/lib/telegram.js';
import { memoryDigestLedger, unavailableDigestLedger } from '../harness/memory-digest-ledger.js';

// ── fixtures ────────────────────────────────────────────────────────────────────────
const ENTITY_400 = JSON.stringify({
  ok: false,
  error_code: 400,
  description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 444",
});
const TOO_LONG_400 = '{"ok":false,"error_code":400,"description":"Bad Request: message is too long"}';
const CHAT_NOT_FOUND_400 = '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}';
const flood429 = (s: number) =>
  JSON.stringify({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${s}`, parameters: { retry_after: s } });
const BAD_GATEWAY_502 = '{"ok":false,"error_code":502,"description":"Bad Gateway"}';
const UNAUTHORIZED_401 = '{"ok":false,"error_code":401,"description":"Unauthorized"}';
const BLOCKED_403 = '{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}';
const NOT_FOUND_404 = '{"ok":false,"error_code":404,"description":"Not Found"}';
const OK = '{"ok":true,"result":{}}';
/** A token-SHAPED string built at runtime — `<digits>:<35 url-safe chars>` — so no literal credential shape is committed. */
const FAKE_SECRET = `AAH${'x'.repeat(32)}`;
const FAKE_TOKEN = `123456:${FAKE_SECRET}`;

const eaiAgain = () =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN api.telegram.org'), { code: 'EAI_AGAIN' }) });
/** What R0.2 actually logged: `fetch failed`, the cause carrying no errno. */
const bareFetchFailed = () => new TypeError('fetch failed');
async function realTimeoutRejection(): Promise<unknown> {
  const sig = AbortSignal.timeout(1);
  await new Promise((r) => setTimeout(r, 25));
  return sig.reason; // the exact object fetch rejects with
}

// ── a fake clock + a scripted fetch ─────────────────────────────────────────────────
type Step = { status: number; body: string } | { throws: unknown };
let clock = 0;
let sleeps: number[] = [];
let posts: Array<{ at: number; body: Record<string, unknown> }> = [];
let originalFetch: typeof fetch;
let errLines: string[] = [];
let ledger: ReturnType<typeof memoryDigestLedger>;

function script(steps: Step[], fallback: Step = { status: 200, body: OK }) {
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    posts.push({ at: clock, body });
    const s = steps.shift() ?? fallback;
    if ('throws' in s) throw s.throws;
    return new Response(s.body, { status: s.status });
  }) as unknown as typeof fetch;
}
/** Digest POSTs fail per `steps`; anything carrying the alert header is accepted. */
function scriptDigestOnly(steps: Step[]) {
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    posts.push({ at: clock, body });
    if (String(body.text).includes('AlgoVault Alert')) return new Response(OK, { status: 200 });
    const s = steps.shift() ?? { status: 200, body: OK };
    if ('throws' in s) throw s.throws;
    return new Response(s.body, { status: s.status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  clock = 1_000_000;
  sleeps = [];
  posts = [];
  errLines = [];
  // CH2: a labelled run settles against the durable ledger — in memory here, never the laptop DB.
  ledger = memoryDigestLedger();
  _setDigestLedgerForTest(ledger);
  _setTelegramTimeForTest({
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0,
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errLines.push(a.map(String).join(' '));
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  _setTelegramTimeForTest(null);
  _setDigestLedgerForTest(null);
  vi.restoreAllMocks();
});

// ── the disposition table ───────────────────────────────────────────────────────────
describe('classifyTelegramFailure — ONE disposition, derived once', () => {
  it.each([
    ['429 → transient, retry_after read', { httpStatus: 429, body: flood429(7) }, 'transient', 7],
    ['502 → transient', { httpStatus: 502, body: BAD_GATEWAY_502 }, 'transient', null],
    ['400 entity → entity', { httpStatus: 400, body: ENTITY_400 }, 'entity', null],
    ['400 chat not found → config', { httpStatus: 400, body: CHAT_NOT_FOUND_400 }, 'config', null],
    ['401 → config', { httpStatus: 401, body: UNAUTHORIZED_401 }, 'config', null],
    ['403 bot blocked → config', { httpStatus: 403, body: BLOCKED_403 }, 'config', null],
    ['404 → config', { httpStatus: 404, body: NOT_FOUND_404 }, 'config', null],
    ['400 message is too long → content', { httpStatus: 400, body: TOO_LONG_400 }, 'content', null],
  ])('%s', (_name, input, disposition, retryAfterS) => {
    const f = classifyTelegramFailure(input);
    expect(f.disposition).toBe(disposition);
    expect(f.retryAfterS).toBe(retryAfterS);
    expect(f.code).toBe(`HTTP ${input.httpStatus}`);
  });

  it('a no-response error goes through the SHARED webhook classifier and is transient', () => {
    const f = classifyTelegramFailure({ error: eaiAgain() });
    expect(f).toMatchObject({ disposition: 'transient', klass: 'conn', code: 'EAI_AGAIN' });
    expect(f.desc).toContain('EAI_AGAIN');
  });

  it('the R0.2 shape — `fetch failed` with no errno — is transient and SAYS it had no errno', () => {
    const f = classifyTelegramFailure({ error: bareFetchFailed() });
    expect(f.disposition).toBe('transient');
    expect(f.code).toBe('no-errno');
    expect(f.desc).toContain('fetch failed');
  });

  it('a real AbortSignal.timeout rejection classifies as ETIMEDOUT / timeout (not code 23)', async () => {
    const f = classifyTelegramFailure({ error: await realTimeoutRejection() });
    expect(f).toMatchObject({ disposition: 'transient', klass: 'timeout', code: 'ETIMEDOUT' });
  });
});

// ── the scheduled profile ───────────────────────────────────────────────────────────
describe('scheduled profile (sendDigest default) — backs off, honours retry_after', () => {
  it('429 retry_after=3 then 200 ⇒ delivered, the second POST ≥ 3 s after the first', async () => {
    script([{ status: 429, body: flood429(3) }, { status: 200, body: OK }]);
    expect(await sendDigest(['hello'])).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[1].at - posts[0].at).toBeGreaterThanOrEqual(3_000);
  });

  it('502, 502, 200 ⇒ delivered on attempt 3, with the 2 s and 8 s waits', async () => {
    script([{ status: 502, body: BAD_GATEWAY_502 }, { status: 502, body: BAD_GATEWAY_502 }, { status: 200, body: OK }]);
    expect(await sendDigest(['hello'])).toBe(true);
    expect(posts).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 8_000]);
  });

  it('EAI_AGAIN ×3 ⇒ false, and every attempt line carries the errno and the disposition', async () => {
    script([{ throws: eaiAgain() }, { throws: eaiAgain() }, { throws: eaiAgain() }]);
    expect(await sendDigest(['hello'])).toBe(false);
    expect(posts).toHaveLength(3);
    const attemptLines = errLines.filter((l) => l.startsWith('[telegram] attempt '));
    expect(attemptLines).toHaveLength(3);
    for (const l of attemptLines) {
      expect(l).toContain('code=EAI_AGAIN');
      expect(l).toContain('disposition=transient');
    }
    expect(errLines.some((l) => l.startsWith('[telegram] DELIVERY_FAILED disposition=transient code=EAI_AGAIN attempts=3'))).toBe(true);
  });

  it('a real AbortSignal.timeout rejection ×3 ⇒ code=ETIMEDOUT', async () => {
    const t = await realTimeoutRejection();
    script([{ throws: t }, { throws: t }, { throws: t }]);
    expect(await sendDigest(['hello'])).toBe(false);
    expect(errLines.filter((l) => l.includes('code=ETIMEDOUT'))).not.toHaveLength(0);
    expect(errLines.join('\n')).not.toContain('code=23');
  });

  it('429 retry_after=120 ⇒ stops INSIDE the 45 s budget and returns the wait for the caller', async () => {
    script([{ status: 429, body: flood429(120) }]);
    const r = await deliverText('hello', { policy: 'scheduled' });
    expect(r.ok).toBe(false);
    expect(r.retryAfterS).toBe(120);
    expect(r.failure?.disposition).toBe('transient');
    expect(errLines.some((l) => l.includes('DELIVERY_FAILED') && l.includes('retry_after_s=120'))).toBe(true);
    expect(posts).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(TELEGRAM_RETRY_POLICY.scheduled.budgetMs).toBe(45_000);
  });
});

// ── the serving profile ─────────────────────────────────────────────────────────────
describe('serving profile (sendAlert default) — the pre-wave latency envelope', () => {
  it('502, 502 ⇒ exactly 2 POSTs and NO sleep', async () => {
    script([{ status: 502, body: BAD_GATEWAY_502 }, { status: 502, body: BAD_GATEWAY_502 }]);
    expect(await sendAlert('page', 'warning')).toBe(false);
    expect(posts).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  it('a 429 on a serving path does NOT wait its retry_after (a user is waiting on /contact)', async () => {
    script([{ status: 429, body: flood429(30) }, { status: 200, body: OK }]);
    expect(await sendAlert('page', 'warning')).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it('opt-in: sendAlert({ policy: "scheduled" }) backs off', async () => {
    script([{ status: 502, body: BAD_GATEWAY_502 }, { status: 200, body: OK }]);
    expect(await sendAlert('page', 'warning', { policy: 'scheduled' })).toBe(true);
    expect(sleeps).toEqual([2_000]);
  });
});

// ── config / content / entity ───────────────────────────────────────────────────────
describe('terminal dispositions', () => {
  it('400 chat not found ⇒ exactly ONE POST, disposition=config (was two: the retry could never help)', async () => {
    script([{ status: 400, body: CHAT_NOT_FOUND_400 }, { status: 400, body: CHAT_NOT_FOUND_400 }]);
    expect(await sendDigest(['x'])).toBe(false);
    expect(posts).toHaveLength(1);
    expect(errLines.some((l) => l.includes('disposition=config'))).toBe(true);
  });

  it('400 message is too long then 200 ⇒ ONE degraded resend: no parse_mode, ≤ 3,800 units, loud', async () => {
    script([{ status: 400, body: TOO_LONG_400 }, { status: 200, body: OK }]);
    expect(await sendDigest(['*Digest*\nbody'])).toBe(true);
    expect(posts).toHaveLength(2);
    expect(posts[0].body.parse_mode).toBe('Markdown');
    expect(posts[1].body.parse_mode).toBeUndefined();
    expect(String(posts[1].body.text).length).toBeLessThanOrEqual(3_800);
    expect(errLines.some((l) => l.startsWith('[telegram] DELIVERED DEGRADED (Bad Request: message is too long)'))).toBe(true);
  });

  it('the degraded resend scrubs a lone surrogate and C0 controls', async () => {
    script([{ status: 400, body: TOO_LONG_400 }, { status: 200, body: OK }]);
    expect(await sendDigest([`asset ${'\uD83D'} x${'\u0007'}y`])).toBe(true);
    expect(String(posts[1].body.text)).toBe('asset � xy');
  });

  it('entity path ⇒ ≤ 4 POSTs and false (never more than the pre-wave transport)', async () => {
    script([], { status: 400, body: ENTITY_400 });
    expect(await sendDigest(['a [b'])).toBe(false);
    expect(posts.length).toBeLessThanOrEqual(4);
    expect(errLines.some((l) => l.startsWith('[telegram] HTTP 400'))).toBe(true);
  });

  it('entity then a TRANSIENT plain-fallback failure ⇒ retried, and the retry goes out plain', async () => {
    script([{ status: 400, body: ENTITY_400 }, { status: 502, body: BAD_GATEWAY_502 }, { status: 200, body: OK }]);
    expect(await sendDigest(['a [b'])).toBe(true);
    expect(posts.map((p) => p.body.parse_mode ?? 'plain')).toEqual(['Markdown', 'plain', 'plain']);
  });
});

// ── redaction + the page ────────────────────────────────────────────────────────────
describe('the cause is never discarded, and never leaks the credential', () => {
  // Premise moved in CH2: a TRANSIENT labelled failure is QUEUED silently (no page), so the
  // credential must be absent from the log AND from what the ledger persists; the PAGE path
  // is exercised through the ledger-unavailable fallback, which pages CH1's cause at once.
  it('an error embedding bot<id>:<secret> is logged, persisted and paged as bot<redacted>', async () => {
    const leak = () =>
      new TypeError('fetch failed', {
        cause: Object.assign(new Error(`connect ECONNRESET https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`), { code: 'ECONNRESET' }),
      });
    scriptDigestOnly([{ throws: leak() }, { throws: leak() }, { throws: leak() }]);
    expect(await sendDigest(['x'], { label: 'monitor-daily-digest' })).toBe(false);
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.runs[0].status).toBe('queued');
    const persisted = ledger.runs[0].causes.join('\n');
    expect(persisted).toContain('bot<redacted>');
    expect(persisted).not.toContain(FAKE_SECRET);

    _setDigestLedgerForTest(unavailableDigestLedger());
    scriptDigestOnly([{ throws: leak() }, { throws: leak() }, { throws: leak() }]);
    expect(await sendDigest(['x'], { label: 'monitor-daily-digest' })).toBe(false);
    const all = errLines.join('\n') + posts.map((p) => String(p.body.text)).join('\n');
    expect(all).toContain('bot<redacted>');
    expect(all).not.toContain(FAKE_SECRET);
    const page = posts.find((p) => String(p.body.text).includes('AlgoVault Alert'));
    expect(String(page?.body.text)).toContain('bot<redacted>');
    expect(String(page?.body.text)).toContain('NOT QUEUED');
  });

  it('redactBotToken is structural: the bare <id>:<secret> shape is removed too', () => {
    expect(redactBotToken(`x ${FAKE_TOKEN} y`)).toBe('x <redacted> y');
    expect(redactBotToken('nothing secret 12:34')).toBe('nothing secret 12:34');
  });

  // Premise moved in CH2: the page for a TRANSIENT failure is CH1's text only when the ledger
  // cannot queue it (NOT QUEUED); a queued digest does not page at all.
  it('AC2 — the page names label, disposition and code, and no longer points at a non-existent log line', async () => {
    _setDigestLedgerForTest(unavailableDigestLedger());
    scriptDigestOnly([{ throws: eaiAgain() }, { throws: eaiAgain() }, { throws: eaiAgain() }]);
    expect(await sendDigest(['x'], { label: 'monitor-daily-digest' })).toBe(false);
    const pages = posts.filter((p) => String(p.body.text).includes('AlgoVault Alert'));
    expect(pages).toHaveLength(1);
    const text = String(pages[0].body.text);
    expect(text).toContain('monitor-daily-digest');
    expect(text).toContain('FAILED to deliver');
    expect(text).toContain('cause transient');
    expect(text).toContain('EAI_AGAIN');
    expect(text).toContain('3 attempt(s)');
    expect(text).not.toContain('See the [telegram] HTTP line');
  });

  it('AC2 (CH2) — a transient labelled failure QUEUES silently: no page', async () => {
    scriptDigestOnly([{ throws: eaiAgain() }, { throws: eaiAgain() }, { throws: eaiAgain() }]);
    expect(await sendDigest(['x'], { label: 'monitor-daily-digest' })).toBe(false);
    expect(ledger.runs.map((r) => r.status)).toEqual(['queued']);
    expect(posts.some((p) => String(p.body.text).includes('AlgoVault Alert'))).toBe(false);
  });

  it('AC2 (CH2) — a config failure is DEAD at once and its page carries label + code', async () => {
    scriptDigestOnly([{ status: 400, body: CHAT_NOT_FOUND_400 }]);
    expect(await sendDigest(['x'], { label: 'venue-readiness-report' })).toBe(false);
    const pages = posts.filter((p) => String(p.body.text).includes('AlgoVault Alert'));
    expect(pages).toHaveLength(1);
    const text = String(pages[0].body.text);
    expect(text).toContain('venue-readiness-report');
    expect(text).toContain('FAILED to deliver');
    expect(text).toContain('HTTP 400');
    expect(text).toContain('chat not found');
  });

  it('AC2 — the three producer lines point at DELIVERY_FAILED, never at the non-existent HTTP line', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['src/scripts/monitor.ts', 'src/scripts/geo-weekly-cron.ts', 'scripts/refresh-knowledge-pages.mjs']) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toContain('see the [telegram] HTTP line above');
      expect(src, f).toContain('see the [telegram] DELIVERY_FAILED line above');
    }
  });

  it('renderDigestFailurePage wraps every interpolated value so a `_` cannot open an entity', () => {
    const text = renderDigestFailurePage({
      label: 'rate-limit-digest-weekly',
      parts: 1,
      sections: 4,
      result: {
        ok: false, degraded: false, attempts: 3, posts: 3, elapsedMs: 10_400, retryAfterS: null,
        failure: { disposition: 'transient', klass: 'conn', code: 'EAI_AGAIN', desc: 'snake_case_cause', retryAfterS: null },
      },
    });
    expect(text).toContain('`snake_case_cause`');
    expect(text).toContain('over 10 s');
  });
});

// ── AC7 (post-wave direction) — R0.2's actual failure shape ─────────────────────────
describe('AC7 — the 2026-10-15 shape: `fetch failed` ×2, then the network is back', () => {
  it('the post-wave transport DELIVERS where the pre-wave one returned false after 2 zero-delay POSTs', async () => {
    script([{ throws: bareFetchFailed() }, { throws: bareFetchFailed() }, { status: 200, body: OK }]);
    expect(await sendDigest(['📊 *AlgoVault Daily Digest*'], { label: 'monitor-daily-digest' })).toBe(true);
    expect(posts).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 8_000]);
    expect(posts.some((p) => String(p.body.text).includes('AlgoVault Alert'))).toBe(false);
  });
});
