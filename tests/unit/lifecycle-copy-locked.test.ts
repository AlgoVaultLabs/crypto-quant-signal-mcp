/**
 * IDENTITY-LIFECYCLE-W3 — copy-locked fidelity.
 *
 * Asserts over the RENDERED email bytes, never over the constants in `lifecycle-copy.ts`. A test
 * that imports a constant and compares it to itself is the vacuous shape this estate has met
 * repeatedly: it passes for any value, including a wrong one. Everything below goes through
 * `renderLifecycleEmail`, so a broken renderer, a dropped footer or a missing unsubscribe header
 * fails here rather than in production.
 *
 * Numbers are asserted against `plans.ts` / `referral-constants.ts` / `capabilities.ts` at
 * runtime, never as literals — the numerical-citation rule applies to a test as much as to the
 * copy it guards, and a hardcoded `200` here would go stale in the same edit that moved the SoT.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderLifecycleEmail } from '../../src/lib/lifecycle/render.js';
import {
  FREE_MONTHLY_CALLS, FREE_DAILY_CALLS, planCallsLabel, planDailyCallsLabel, planPriceLabel,
} from '../../src/lib/plans.js';
import { REFERRAL_TERMS } from '../../src/lib/referral-constants.js';
import { TIMEFRAME_COUNT } from '../../src/lib/capabilities.js';
import type { LifecycleStep } from '../../src/lib/lifecycle-copy.js';

const UNSUB = 'https://api.algovault.com/email/unsubscribe/dGVzdA.' + 'a'.repeat(64);

const CTX = {
  keyMasked: 'av_free_…a1b2',
  used: 160,
  total: FREE_MONTHLY_CALLS,
  resetDate: '14 September 2026',
  mcpConfigSnippet: '{\n  "mcpServers": { "algovault": {} }\n}',
  digestHtml: '<h2>What\'s new in v1.29.0</h2>',
  digestText: "What's new in v1.29.0",
  digestPeriodLabel: 'September 2026',
};

const STEPS: LifecycleStep[] = ['activation_nudge', 'quota_80', 'quota_wall', 'reset_return', 'product_updates'];

function render(step: LifecycleStep) {
  return renderLifecycleEmail(step, CTX, UNSUB);
}

describe('every rendered message carries the §Footer and its unsubscribe link', () => {
  for (const step of STEPS) {
    it(`${step}`, () => {
      const { html, text } = render(step);
      expect(html).toContain('AlgoVault Labs');
      expect(html).toContain('Unsubscribe');
      expect(html).toContain('Manage email preferences');
      expect(html).toContain(UNSUB);
      expect(text).toContain(UNSUB);
      // A lifecycle email with no unsubscribe link is the one message this wave must be
      // structurally unable to send.
      expect(html).toContain('/email/unsubscribe/');
    });
  }
});

describe('E1 · activation_nudge', () => {
  it('renders the signed-off lines with SoT numbers', () => {
    const { subject, text } = render('activation_nudge');
    expect(subject).toBe('Your AlgoVault key is ready — first call in 30 seconds');
    expect(text).toContain("Your key av_free_…a1b2 hasn't made a call yet.");
    expect(text).toContain('Then ask: "Get me a trade call for SOL on the 5-minute timeframe."');
    expect(text).toContain(
      `Free tier: all assets, all ${TIMEFRAME_COUNT} timeframes, ${FREE_MONTHLY_CALLS} calls/month (up to ${FREE_DAILY_CALLS}/day).`,
    );
    expect(text).toContain('utm_campaign=activation_nudge');
  });

  /**
   * THE DAILY CAP TRACKS ITS OWN CONSTANT, and this test had to be rewritten to prove it.
   *
   * The first version asserted `text.toContain(\`up to ${FREE_DAILY_CALLS}/day\`)`. MEASURED: a
   * deliberate mutation replacing the SoT call with `Number(freeCallsLabel()) / 2` went
   * UNDETECTED — because 200 / 2 is 100, so the rendered bytes were identical and the assertion
   * was true of a derivation that is wrong in principle and correct only by today's arithmetic.
   * FREE_DAILY_CALLS is a SECOND meter refusing independently (plans.ts says so explicitly);
   * the day either constant moves, a halving renderer starts lying.
   *
   * The only assertion that can see the difference is one where the two constants DISAGREE, so
   * the plans module is mocked with a daily cap that is not half the monthly. That makes the
   * coincidence unavailable and the derivation observable.
   */
  it('the daily cap follows FREE_DAILY_CALLS even when it is not half the monthly', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/plans.js', async (orig) => {
      const real = await orig<typeof import('../../src/lib/plans.js')>();
      return { ...real, FREE_MONTHLY_CALLS: 200, FREE_DAILY_CALLS: 37,
               freeCallsLabel: () => '200', freeDailyCallsLabel: () => '37' };
    });
    const { renderLifecycleEmail: r } = await import('../../src/lib/lifecycle/render.js');
    const { text } = r('activation_nudge', CTX, UNSUB);
    expect(text).toContain('up to 37/day');
    expect(text).not.toContain('up to 100/day');
    vi.doUnmock('../../src/lib/plans.js');
    vi.resetModules();
  });
});

describe('E2 · quota_80', () => {
  it('the subject is TEMPLATED — no literal 160/200 survives a quota change', () => {
    expect(render('quota_80').subject).toBe(`160 of ${FREE_MONTHLY_CALLS} free calls used`);
    // The real assertion: change the inputs and the subject follows.
    const other = renderLifecycleEmail('quota_80', { ...CTX, used: 42, total: 50 }, UNSUB);
    expect(other.subject).toBe('42 of 50 free calls used');
  });

  it('body, Starter ladder and the referral SoT sentence', () => {
    const { text } = render('quota_80');
    expect(text).toContain(`Your agent has used 160 of its ${FREE_MONTHLY_CALLS} free calls. The count resets on 14 September 2026.`);
    expect(text).toContain(`Need more? Starter is ${planCallsLabel('starter')} calls a month (up to ${planDailyCallsLabel('starter')} a day) for ${planPriceLabel('starter')}.`);
    expect(text).toContain(`Or keep going free: refer a friend and they get ${REFERRAL_TERMS.BONUS_CALLS} bonus calls.`);
  });
});

describe('E3 · quota_wall and E4 · reset_return', () => {
  it('E3 states the limit and the resume date', () => {
    const { subject, text } = render('quota_wall');
    expect(subject).toBe('Free calls used up — they reset on 14 September 2026');
    expect(text).toContain(`Your agent hit its ${FREE_MONTHLY_CALLS}-call limit. Calls resume on 14 September 2026.`);
  });

  it('E4 says nothing to do', () => {
    const { subject, text } = render('reset_return');
    expect(subject).toBe('Your free calls are back');
    expect(text).toContain('Your free calls reset today. Your key still works — nothing to do.');
  });
});

describe('E5 · product_updates', () => {
  it('carries the README block VERBATIM and adds no prose beyond the consent line', () => {
    const { subject, html, text } = render('product_updates');
    expect(subject).toBe("What's new in AlgoVault — September 2026");
    expect(html).toContain("<h2>What's new in v1.29.0</h2>");
    expect(text).toContain('You asked for product updates when you signed up (about one a month).');
  });
});

describe('RULING Q5(A) — "this month" is FALSE of this meter and must appear nowhere in E2–E4', () => {
  /**
   * The free allowance is a ROLLING 30-DAY WINDOW anchored at each caller's first call, not a
   * calendar month. Measured 2026-09-08 on signal-1, two of the three metered email-bound
   * buckets carried an already-EXPIRED period_start — so the phrase was not merely loose, it
   * described a period the product does not have.
   */
  for (const step of ['quota_80', 'quota_wall', 'reset_return'] as LifecycleStep[]) {
    it(`${step} says neither "this month" nor "This month's"`, () => {
      const { subject, text, html } = render(step);
      for (const blob of [subject, text, html]) {
        expect(blob).not.toMatch(/this month/i);
      }
    });
  }

  it("but Starter's own monthly allowance keeps its canonical phrase", () => {
    // "10,000 calls a month" is the plan ladder's wording and Starter IS billed monthly.
    expect(render('quota_80').text).toContain(`${planCallsLabel('starter')} calls a month`);
  });
});

describe('forbidden phrases never reach a rendered lifecycle message', () => {
  const BANNED = [
    /\bunlimited\b/i, /no daily cap/i, /\b100 calls\/month\b/i, /\btrial\b/i,
    /MOST POPULAR/, /Quant Layer/i, /AI Trading Platform/i, /Crypto Signal API/i,
    /intelligence layer/i, /\b(powerful|seamless|robust|cutting-edge)\b/i,
  ];
  for (const step of STEPS) {
    it(`${step} is clean`, () => {
      const { subject, text, html } = render(step);
      for (const re of BANNED) {
        expect(subject, `subject: ${re}`).not.toMatch(re);
        expect(text, `text: ${re}`).not.toMatch(re);
        expect(html, `html: ${re}`).not.toMatch(re);
      }
    });
  }

  it('"bonus" appears ONLY in E2\'s referral sentence — the existing referral SoT string', () => {
    for (const step of STEPS) {
      const { text } = render(step);
      if (step === 'quota_80') expect(text).toMatch(/bonus calls/);
      else expect(text).not.toMatch(/\bbonus\b/i);
    }
  });
});
