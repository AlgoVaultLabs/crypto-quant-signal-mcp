/**
 * CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH2 — the Turnstile challenge gate.
 *
 * NO NETWORK. `fetchImpl` is injected, and every stubbed response body below is BYTE-ACCURATE to
 * what Cloudflare actually returned when the documented test secrets were probed live on
 * 2026-08-25 — including `metadata.result_with_testing_key`, which the spec's own fact table did
 * not mention. A fixture invented from documentation would be a fixture that agrees with the
 * documentation rather than with the vendor.
 *
 * AC2.1  all six policy branches
 * AC2.2  failed challenge → 400 and ZERO rows
 * AC2.3  secret unset → the form works exactly as before this chapter
 * AC2.4  siteverify outage → lead captured, notified, tagged, +10
 * AC2.5  the secret appears in no log line and no response body
 * AC2.9  token absent/empty/whitespace → ZERO siteverify calls, captured, tagged
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A HERMETIC SELF-TEST IS STRUCTURALLY BLIND TO EXACTLY WHAT ITS OWN SEAM REPLACES.
 * `fetchImpl` is that seam, so the request it would have made is the ONE thing no scenario here
 * exercises — which is precisely where this repo has been bitten before (a %-formatted SQL string
 * and a left-to-right key parser, both invisible because they were the only code no scenario
 * called). The `seam-blindness` block at the bottom asserts the BYPASSED ARTIFACTS directly: the
 * URL is the literal documented endpoint, the body carries `secret` and `response`, and the
 * method and content-type are what the vendor expects.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  verifyTurnstile, turnstileTags, _resetTurnstileWarnLatchForTest,
  TURNSTILE_SITEVERIFY_URL, TURNSTILE_RESPONSE_FIELD, TURNSTILE_MAX_TOKEN_CHARS,
  TURNSTILE_UNVERIFIED_REASON,
} from '../../src/lib/turnstile.js';
import { scoreLead, EMPTY_LOOKBACK, SPAM_RULES } from '../../src/lib/contact-spam.js';
import { handleContactSubmission, type ContactSubmitDeps } from '../../src/lib/contact-submit.js';

/** Cloudflare's documented test secrets. */
const SECRET_PASS = '1x0000000000000000000000000000000AA';
const SECRET_FAIL = '2x0000000000000000000000000000000AA';
const SECRET_SPENT = '3x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** Byte-accurate live responses, captured 2026-08-25. All three returned HTTP 200. */
const LIVE = {
  pass: { challenge_ts: '2026-08-25T02:53:41.373Z', 'error-codes': [], hostname: 'example.com', metadata: { result_with_testing_key: true }, success: true },
  fail: { 'error-codes': ['invalid-input-response'], success: false, messages: [], metadata: { result_with_testing_key: true } },
  spent: { 'error-codes': ['timeout-or-duplicate'], success: false, messages: [], metadata: { result_with_testing_key: true } },
} as const;

function stubFetch(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), {
    status, headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

function collector() {
  const lines: string[] = [];
  return { lines, log: (l: string) => { lines.push(l); } };
}

beforeEach(() => { _resetTurnstileWarnLatchForTest(); });

describe('AC2.1 — the six policy branches', () => {
  it('1. secret unset → skip, untagged, no fetch', async () => {
    const f = stubFetch(LIVE.pass);
    const v = await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => undefined, fetchImpl: f, log: () => {} });
    expect(v).toEqual({ kind: 'skip' });
    expect(turnstileTags(v)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('2. always-pass secret → pass, untagged', async () => {
    const v = await verifyTurnstile(DUMMY_TOKEN, '1.2.3.4', {
      getSecret: () => SECRET_PASS, fetchImpl: stubFetch(LIVE.pass), log: () => {},
    });
    expect(v).toEqual({ kind: 'pass' });
    expect(turnstileTags(v)).toEqual([]);
  });

  it('3. always-fail secret → reject with the live error code', async () => {
    const v = await verifyTurnstile(DUMMY_TOKEN, null, {
      getSecret: () => SECRET_FAIL, fetchImpl: stubFetch(LIVE.fail), log: () => {},
    });
    expect(v).toEqual({ kind: 'reject', errorCodes: ['invalid-input-response'] });
    expect(turnstileTags(v)).toEqual([]);
  });

  it('4. already-spent secret → treated as a failure, NOT a crash', async () => {
    // `timeout-or-duplicate` is a replayed token. It is a rejection like any other; the danger
    // is a parser that special-cases it or throws on the unfamiliar code.
    const v = await verifyTurnstile(DUMMY_TOKEN, null, {
      getSecret: () => SECRET_SPENT, fetchImpl: stubFetch(LIVE.spent), log: () => {},
    });
    expect(v).toEqual({ kind: 'reject', errorCodes: ['timeout-or-duplicate'] });
  });

  it('5. siteverify throws → unverified, TAGGED, never a reject', async () => {
    const c = collector();
    const throwing = vi.fn(async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
    const v = await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_PASS, fetchImpl: throwing, log: c.log });
    expect(v.kind).toBe('unverified');
    expect(turnstileTags(v)).toEqual([TURNSTILE_UNVERIFIED_REASON]);
    expect(c.lines.join('\n')).toContain('failing OPEN');
  });

  it('5b. a 5xx is an outage, not a failed challenge', async () => {
    const v = await verifyTurnstile(DUMMY_TOKEN, null, {
      getSecret: () => SECRET_PASS, fetchImpl: stubFetch({}, 503), log: () => {},
    });
    expect(v.kind).toBe('unverified');
    expect(turnstileTags(v)).toEqual([TURNSTILE_UNVERIFIED_REASON]);
  });

  it('5c. an AbortSignal timeout is an outage, not a failed challenge', async () => {
    const timeout = vi.fn(async () => { throw new DOMException('The operation was aborted.', 'TimeoutError'); }) as unknown as typeof fetch;
    const v = await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_PASS, fetchImpl: timeout, log: () => {} });
    expect(v.kind).toBe('unverified');
  });

  it('5d. malformed JSON is an outage, not a pass', async () => {
    const garbage = vi.fn(async () => new Response('<html>502</html>', { status: 200 })) as unknown as typeof fetch;
    const v = await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_PASS, fetchImpl: garbage, log: () => {} });
    expect(v.kind).toBe('unverified');
  });

  it('6. a token over the documented maximum is rejected BEFORE the call', async () => {
    const f = stubFetch(LIVE.pass);
    const v = await verifyTurnstile('x'.repeat(TURNSTILE_MAX_TOKEN_CHARS + 1), null, {
      getSecret: () => SECRET_PASS, fetchImpl: f, log: () => {},
    });
    expect(v.kind).toBe('reject');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('AC2.9 — an ABSENT token is not a failed challenge', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   \t\n  '],
    ['a non-string', 42],
  ])('%s → unverified + TAGGED, and ZERO siteverify calls', async (_label, token) => {
    const f = stubFetch(LIVE.fail);
    const v = await verifyTurnstile(token, null, { getSecret: () => SECRET_PASS, fetchImpl: f, log: () => {} });
    expect(v).toMatchObject({ kind: 'unverified', why: 'token-absent' });
    expect(turnstileTags(v)).toEqual([TURNSTILE_UNVERIFIED_REASON]);
    // Never called: there is nothing to verify, and a round-trip to be told
    // `missing-input-response` is a round-trip spent learning what we already know.
    expect(f).not.toHaveBeenCalled();
  });

  it('the boundary is deliberate — a PRESENT token that fails still rejects', async () => {
    // The two halves of the architect's split, asserted side by side so the distinction cannot
    // be collapsed by a later "simplification".
    const absent = await verifyTurnstile('', null, { getSecret: () => SECRET_PASS, fetchImpl: stubFetch(LIVE.fail), log: () => {} });
    const present = await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_FAIL, fetchImpl: stubFetch(LIVE.fail), log: () => {} });
    expect(absent.kind).toBe('unverified');
    expect(present.kind).toBe('reject');
  });
});

describe('AC2.4 — an unverified challenge contributes exactly +10 and never quarantines alone', () => {
  it('the tag scores 10 and leaves a genuine lead un-quarantined', () => {
    const v = scoreLead(
      { name: 'Ada Lovelace', company: 'Analytical Engines', monthlyVolume: '250,000',
        message: 'We need 500k calls/month across 12 venues.', src: 'unknown' },
      EMPTY_LOOKBACK,
      [TURNSTILE_UNVERIFIED_REASON],
    );
    expect(v.score).toBe(10);
    expect(v.reasons).toEqual([TURNSTILE_UNVERIFIED_REASON]);
    expect(v.quarantined).toBe(false);
  });

  it('the reason id is in CH1\'s frozen vocabulary — CH2 declares no rule of its own', () => {
    const rule = SPAM_RULES.find((r) => r.id === TURNSTILE_UNVERIFIED_REASON);
    expect(rule).toBeDefined();
    expect(rule?.score).toBe(10);
    expect(rule?.tier).toBe('weak');
  });
});

describe('AC2.3 / AC2.4 — end-to-end through the submission handler', () => {
  const VALID_LEAD = {
    name: 'Ada Lovelace', email: 'ada@analytical.example', company: 'Analytical Engines',
    monthly_volume: '250,000', message: 'We need 500k calls/month across 12 venues.',
  };

  function deps() {
    const emailed: unknown[] = [];
    const scored: Array<{ score: number; reasons: string | null; quarantined: boolean }> = [];
    const d: ContactSubmitDeps = {
      validateEmail: async () => ({ ok: true }),
      insertLead: async () => 42,
      markNotified: () => {},
      sendEmail: async (a) => { emailed.push(a); return { id: 're_1' }; },
      sendAlert: async () => true,
      log: () => {},
      markScored: async (_id, score, reasons, quarantined) => { scored.push({ score, reasons, quarantined }); return true; },
      countRecentQuarantines: async () => 0,
    };
    return { d, emailed, scored };
  }

  it('AC2.3 — secret unset: the lead is notified and carries NO tag', async () => {
    const v = await verifyTurnstile(undefined, null, { getSecret: () => undefined, log: () => {} });
    const h = deps();
    const r = await handleContactSubmission(
      VALID_LEAD, { src: 'unknown', ipHash: 'v2:abc', spamTags: turnstileTags(v) }, h.d,
    );
    expect(r).toMatchObject({ kind: 'ok', emailed: true, quarantined: false, spamScore: 0 });
    expect(h.scored[0]).toEqual({ score: 0, reasons: null, quarantined: false });
    expect(h.emailed).toHaveLength(1);
  });

  it('AC2.4 — siteverify outage: captured, notified, TAGGED, +10', async () => {
    const throwing = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const v = await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_PASS, fetchImpl: throwing, log: () => {} });
    const h = deps();
    const r = await handleContactSubmission(
      VALID_LEAD, { src: 'unknown', ipHash: 'v2:abc', spamTags: turnstileTags(v) }, h.d,
    );
    // Still captured. Still notified. Just visible as unverified.
    expect(r).toMatchObject({ kind: 'ok', emailed: true, quarantined: false, spamScore: 10 });
    expect(h.scored[0]).toEqual({ score: 10, reasons: 'turnstile-unverified', quarantined: false });
    expect(h.emailed).toHaveLength(1);
  });

  it('a spam lead that ALSO evaded the challenge still quarantines on CH1\'s rules', async () => {
    // The honest cost of the absent-token fail-open, asserted rather than asserted-away: a bot
    // that omits the token reaches the scorer, and the scorer is what catches it.
    const v = await verifyTurnstile('', null, { getSecret: () => SECRET_PASS, log: () => {} });
    const h = deps();
    const r = await handleContactSubmission(
      { name: 'Roberttic', email: 'x@gmail.com', company: 'google', monthly_volume: 'Roberttic', message: 'pricing please' },
      { src: 'unknown', ipHash: 'v2:abc', spamTags: turnstileTags(v) }, h.d,
    );
    // 70 = same-name-volume 50 + turnstile-unverified 10 + thin-message 10. The message is 14
    // characters, so the "dormant" forward-guard fires here — worth stating, because it is the
    // first real demonstration that the rule is dormant rather than dead.
    expect(r).toMatchObject({ quarantined: true, spamScore: 70 });
    expect(h.scored[0].reasons).toBe('same-name-volume,thin-message,turnstile-unverified');
    expect(h.emailed).toHaveLength(0);
  });
});

describe('AC2.5 — the secret never leaks', () => {
  it('appears in no log line across EVERY branch', async () => {
    const c = collector();
    const branches: Array<() => Promise<unknown>> = [
      () => verifyTurnstile(DUMMY_TOKEN, '1.2.3.4', { getSecret: () => SECRET_PASS, fetchImpl: stubFetch(LIVE.pass), log: c.log }),
      () => verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_FAIL, fetchImpl: stubFetch(LIVE.fail), log: c.log }),
      () => verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_SPENT, fetchImpl: stubFetch(LIVE.spent), log: c.log }),
      () => verifyTurnstile('', null, { getSecret: () => SECRET_PASS, log: c.log }),
      () => verifyTurnstile('x'.repeat(9999), null, { getSecret: () => SECRET_PASS, log: c.log }),
      () => verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_PASS, fetchImpl: stubFetch({}, 500), log: c.log }),
      () => verifyTurnstile(DUMMY_TOKEN, null, {
        getSecret: () => SECRET_PASS, log: c.log,
        // An error whose MESSAGE carries the secret — the second leak path CLAUDE.md names,
        // beyond request logging. If the catch block ever interpolated `err.message`, this fires.
        fetchImpl: (async () => { throw new Error(`connect failed for secret=${SECRET_PASS}`); }) as unknown as typeof fetch,
      }),
      () => verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => undefined, log: c.log }),
    ];
    for (const b of branches) await b();

    expect(c.lines.length).toBeGreaterThan(0); // vacuity guard: a scan over zero lines passes everything
    const all = c.lines.join('\n');
    for (const s of [SECRET_PASS, SECRET_FAIL, SECRET_SPENT]) expect(all).not.toContain(s);
  });

  it('never appears in a returned verdict', async () => {
    const verdicts = [
      await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_FAIL, fetchImpl: stubFetch(LIVE.fail), log: () => {} }),
      await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_PASS, fetchImpl: stubFetch({}, 502), log: () => {} }),
      await verifyTurnstile('', null, { getSecret: () => SECRET_PASS, log: () => {} }),
    ];
    for (const v of verdicts) expect(JSON.stringify(v)).not.toContain('0000000000000');
  });

  it('the unconfigured warning is logged ONCE, not per request', async () => {
    const c = collector();
    for (let i = 0; i < 5; i++) {
      await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => undefined, log: c.log });
    }
    expect(c.lines.filter((l) => l.includes('TURNSTILE_SECRET_KEY unset'))).toHaveLength(1);
  });
});

describe('seam blindness — assert the artifacts the fetch stub bypasses', () => {
  it('the URL is the literal documented endpoint', async () => {
    const f = stubFetch(LIVE.pass);
    await verifyTurnstile(DUMMY_TOKEN, '1.2.3.4', { getSecret: () => SECRET_PASS, fetchImpl: f, log: () => {} });
    const [url] = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
  });

  it('the request carries secret + response + remoteip, as POST JSON', async () => {
    const f = stubFetch(LIVE.pass);
    await verifyTurnstile(DUMMY_TOKEN, '1.2.3.4', { getSecret: () => SECRET_PASS, fetchImpl: f, log: () => {} });
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const sent = JSON.parse(init.body as string) as Record<string, string>;
    expect(sent.secret).toBe(SECRET_PASS);
    expect(sent.response).toBe(DUMMY_TOKEN);
    expect(sent.remoteip).toBe('1.2.3.4');
    expect(init.signal).toBeDefined(); // never wait indefinitely
  });

  it('remoteip is OMITTED rather than sent null when unknown', async () => {
    const f = stubFetch(LIVE.pass);
    await verifyTurnstile(DUMMY_TOKEN, null, { getSecret: () => SECRET_PASS, fetchImpl: f, log: () => {} });
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const sent = JSON.parse(init.body as string) as Record<string, string>;
    expect('remoteip' in sent).toBe(false);
  });

  it('the client field name matches what the widget injects', () => {
    // Renamed upstream, this is the value that silently makes every submission tokenless.
    expect(TURNSTILE_RESPONSE_FIELD).toBe('cf-turnstile-response');
  });
});

describe('the widget renders only when configured — AC2.3 (page half) + AC2.8', () => {
  const ORIGINAL = process.env.TURNSTILE_SITEKEY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TURNSTILE_SITEKEY;
    else process.env.TURNSTILE_SITEKEY = ORIGINAL;
    vi.resetModules();
  });

  async function page(sitekey: string | undefined) {
    if (sitekey === undefined) delete process.env.TURNSTILE_SITEKEY;
    else process.env.TURNSTILE_SITEKEY = sitekey;
    vi.resetModules();
    const { renderContactPage } = await import('../../src/lib/contact-page.js');
    return renderContactPage();
  }

  it('sitekey UNSET → neither the script nor the div renders, and the form still submits', async () => {
    const html = await page(undefined);
    expect(html).not.toContain('challenges.cloudflare.com');
    expect(html).not.toContain('cf-turnstile');
    // Still a valid, submittable form — the CH1-only deploy, every dev box and CI live here.
    expect(html).toContain('<form method="POST" action="/contact">');
    expect(html).toContain('<button type="submit">Send</button>');
  });

  it('sitekey SET → the script and the widget render, widget ABOVE the Send button', async () => {
    const html = await page('0xTESTSITEKEY123');
    expect(html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(html).toContain('data-sitekey="0xTESTSITEKEY123"');
    expect(html.indexOf('cf-turnstile')).toBeLessThan(html.indexOf('<button type="submit">'));
  });

  it('an empty or whitespace sitekey renders NOTHING, not a broken widget', async () => {
    // An empty `data-sitekey` renders a permanently-failing challenge — strictly worse than no
    // widget, because the visitor sees something they cannot pass.
    for (const bad of ['', '   ']) {
      const html = await page(bad);
      expect(html, JSON.stringify(bad)).not.toContain('cf-turnstile');
    }
  });

  it('AC2.8 — NO other copy on the page changes when the widget appears', async () => {
    const without = await page(undefined);
    const withKey = await page('0xTESTSITEKEY123');

    // Compare the NON-Turnstile lines rather than byte-diffing after a hand-written strip: the
    // strip would have to reproduce this file's exact indentation, so it would be asserting my
    // template formatting rather than the property. Dropping every line that mentions Turnstile
    // and requiring the remainder to be identical says exactly "nothing else changed".
    // STRICT: whitespace-only lines are NOT excused. The single-insertion-point design means the
    // two turnstile lines are the ONLY difference, so this can hold the strong form of the claim
    // — every other line byte-identical, blank lines included. An earlier draft dropped blank
    // lines to paper over a stray newline the template was emitting when unconfigured; the
    // template was fixed instead, and the assertion tightened back.
    const isTurnstile = (l: string) => l.includes('cf-turnstile') || l.includes('challenges.cloudflare.com');
    const rest = (html: string) => html.split('\n').filter((l) => !isTurnstile(l));

    // Vacuity guard: prove the filter actually removed something, or "the remainder matches"
    // would be trivially true for two identical pages.
    expect(withKey.split('\n').filter(isTurnstile).length).toBeGreaterThan(0);
    expect(without.split('\n').filter(isTurnstile)).toHaveLength(0);

    expect(rest(withKey)).toEqual(rest(without));
  });

  it('the sitekey is sanitised before it reaches an HTML attribute', async () => {
    // Our own config rather than user input, but an attribute is not a place to trust provenance.
    const html = await page('0xABC"><script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('data-sitekey="0xABCscriptalert1script"');
  });
});
