/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH1 — the classifier truth table.
 *
 * Runs against the REAL `classifyTraffic` / `isbot` (never a mock) for the UA legs, because the
 * whole point of projecting from the canonical classifier is that its verdicts are the ones that
 * reach production. The injectable seam is exercised separately, and ONLY to pin the ORDERING —
 * which layer wins when two fire at once — since that is the part a UA fixture cannot show.
 *
 * The UA fixtures are drawn from the actual 28d `signup_attribution` population measured on
 * signal-1 for the window ending 2026-09-05 (268 rows: 113 isbot-flagged, 150 browser-shaped,
 * 5 empty-UA), so a regression shows up against traffic this route really receives.
 */
import { describe, it, expect } from 'vitest';
import { classifyBrowserIntent, type IntentHeaders } from '../../src/lib/browser-intent.js';

/** The Accept a real browser navigation sends (Fetch spec). Built without a literal wildcard. */
const NAV_ACCEPT = `text/html,application/xhtml+xml,application/xml;q=0.9,${'*'}/${'*'};q=0.8`;
/** What curl, axios and every scripted fetch send. */
const WILDCARD_ACCEPT = `${'*'}/${'*'}`;

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/** A real browser navigation: UA + fetch metadata + an HTML-bearing Accept. */
function nav(extra: IntentHeaders = {}): IntentHeaders {
  return {
    'user-agent': CHROME_UA,
    accept: NAV_ACCEPT,
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    ...extra,
  };
}

describe('classifyBrowserIntent — bot (a positive signal withholds the Checkout Session)', () => {
  // Every UA below appears in the live 28d sample.
  const botUas: Array<[string, string]> = [
    ['Baiduspider', 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)'],
    ['bingbot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116 Safari/537.36'],
    ['SemrushBot', 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)'],
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['curl', 'curl/8.7.1'],
  ];

  for (const [name, ua] of botUas) {
    it(`${name} → bot, even with perfect navigation headers`, () => {
      // The UA layer must beat the navigation evidence: a crawler that spoofs Sec-Fetch is still
      // a crawler, and this is the leg that stops most of the live bot population minting
      // Sessions.
      const v = classifyBrowserIntent(nav({ 'user-agent': ua }));
      expect(v.cls).toBe('bot');
      expect(v.reason).toBe('ua_automated');
    });
  }
});

/**
 * MEASURED 2026-09-06, and the reason this block exists rather than being folded into the one
 * above: TWO UAs in the live 28d sample are un-tagged as HUMAN by the canonical classifier, so
 * the UA layer alone does NOT catch them on this route.
 *
 *   `Python/3.10 aiohttp/3.13.0` (20 rows) → `client-registry` kind `bare_sdk` → human. That is
 *   the ratified ICP un-tag: on `/mcp` a bare SDK IS the target customer, and
 *   OPS-ACTIVATION-LEAK-FIX-W1 measured "Recognized clients: 0" without it.
 *
 *   `…GPTBot/1.4; +https://openai.com/gptbot` (4 rows) → matches the registry's `openai`
 *   `agent_client` pattern via the URL in its own UA string → human. GPTBot is OpenAI's
 *   CRAWLER, not the ChatGPT MCP client, so this is a genuine false-human — but `agent_client`
 *   deliberately outranks `crawler` ("never drop a real agent"), and narrowing that pattern
 *   would change a ratified bias on the `/mcp` funnel, which is explicitly outside CH1's scope.
 *
 * On THIS route they are still caught — by the navigation evidence, because neither sends
 * `text/html`. That is the composition working as designed, and pinning it here is what makes a
 * future registry change visible instead of silently re-opening the mint path.
 *
 * RESIDUAL, stated rather than hidden: a crawler that sends NO `Accept` and no fetch metadata
 * classifies `unknown` and still gets the 303. That is Build Rule 5 (fail-open) choosing a
 * spoofed human over a blocked one, and it is why `unknown` is reported as its own series.
 */
describe('classifyBrowserIntent — UAs the canonical classifier un-tags as human', () => {
  const unTagged: Array<[string, string]> = [
    ['python aiohttp (bare_sdk un-tag)', 'Python/3.10 aiohttp/3.13.0'],
    ['GPTBot (openai agent_client pattern)', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)'],
  ];

  for (const [name, ua] of unTagged) {
    it(`${name}: passes the UA layer, caught by the Accept layer`, () => {
      // Their REAL header shape — a wildcard Accept and no fetch metadata.
      const v = classifyBrowserIntent({ 'user-agent': ua, accept: WILDCARD_ACCEPT });
      expect(v.cls).toBe('bot');
      expect(v.reason).toBe('non_html_accept');
    });

    it(`${name}: is NOT caught by the UA layer (pins the measured un-tag)`, () => {
      // If this ever flips to `ua_automated`, the registry changed — which is fine, but the
      // change must be a decision rather than a surprise, because it also moves the `/mcp`
      // funnel's denominator.
      expect(classifyBrowserIntent(nav({ 'user-agent': ua })).cls).toBe('browser');
    });
  }
});

describe('classifyBrowserIntent — bot by navigation evidence (no UA signal needed)', () => {
  it('prefetch → bot, and BEATS a navigate/document pair (Chrome prerender sends both)', () => {
    const v = classifyBrowserIntent(nav({ 'sec-purpose': 'prefetch;prerender' }));
    expect(v.cls).toBe('bot');
    // If this reads `browser`, the ordering regressed and every speculative prerender in Chrome
    // mints a live Checkout Session on hover.
    expect(v.reason).toBe('prefetch');
  });

  it('legacy `Purpose: prefetch` → bot (older Chrome / some CDNs)', () => {
    expect(classifyBrowserIntent(nav({ purpose: 'prefetch' })).cls).toBe('bot');
  });

  it('XHR / fetch() from a page → bot (non-navigate mode)', () => {
    const v = classifyBrowserIntent(nav({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }));
    expect(v.cls).toBe('bot');
    expect(v.reason).toBe('non_navigate_mode');
  });

  it('an <img>/<script> subresource fetch → bot (non-document dest)', () => {
    const v = classifyBrowserIntent(nav({ 'sec-fetch-dest': 'image' }));
    expect(v.cls).toBe('bot');
    expect(v.reason).toBe('non_document_dest');
  });

  it('spoofed browser UA + bare wildcard Accept + no fetch metadata → bot (the STRICT rule)', () => {
    // This is the 56 % cohort: browser-shaped UA, no JS, no fetch metadata. Plausible counted 3
    // humans in the window this population contributed ~150 rows to.
    const v = classifyBrowserIntent({ 'user-agent': CHROME_UA, accept: WILDCARD_ACCEPT });
    expect(v.cls).toBe('bot');
    expect(v.reason).toBe('non_html_accept');
  });

  it('an API-shaped Accept → bot', () => {
    const v = classifyBrowserIntent({ 'user-agent': CHROME_UA, accept: 'application/json' });
    expect(v.cls).toBe('bot');
    expect(v.reason).toBe('non_html_accept');
  });
});

describe('classifyBrowserIntent — browser (a real navigation)', () => {
  it('desktop Chrome navigation → browser', () => {
    const v = classifyBrowserIntent(nav());
    expect(v.cls).toBe('browser');
    expect(v.reason).toBeNull();
  });

  it('Android Chrome navigation → browser', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36';
    expect(classifyBrowserIntent(nav({ 'user-agent': ua })).cls).toBe('browser');
  });

  it('iOS Safari navigation → browser', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1';
    expect(classifyBrowserIntent(nav({ 'user-agent': ua })).cls).toBe('browser');
  });

  it('Telegram in-app browser (Android) → browser, NOT the tg_bot channel', () => {
    // The in-app webview is a HUMAN tapping a link in a chat — the single largest source of
    // legitimate mobile traffic this product has. Reading it as automated would suppress the
    // funnel's warmest cohort.
    const ua =
      'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Telegram-Android/10.2.0';
    expect(classifyBrowserIntent(nav({ 'user-agent': ua })).cls).toBe('browser');
  });

  it('Telegram in-app browser (iOS) → browser', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Telegram-iOS/10.2';
    expect(classifyBrowserIntent(nav({ 'user-agent': ua })).cls).toBe('browser');
  });

  it('Firefox navigation → browser', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0';
    expect(classifyBrowserIntent(nav({ 'user-agent': ua })).cls).toBe('browser');
  });
});

describe('classifyBrowserIntent — unknown (FAIL-OPEN: a human is never blocked from paying)', () => {
  it('browser UA + HTML Accept + no fetch metadata → unknown, not bot', () => {
    // An older client that omits Sec-Fetch entirely. Absence proves nothing, so it still gets the
    // 303 — this is Build Rule 5, and it is what the CH1 gate's `U` leg asserts live.
    const v = classifyBrowserIntent({ 'user-agent': CHROME_UA, accept: NAV_ACCEPT });
    expect(v.cls).toBe('unknown');
    expect(v.reason).toBe('no_fetch_metadata');
  });

  it('no headers at all → unknown, not bot', () => {
    // An EMPTY UA must not be a bot verdict here: `classifyTraffic`'s empty-UA path is a
    // COMBINING signal that needs a datacenter IP, which this route does not feed it.
    const v = classifyBrowserIntent({});
    expect(v.cls).toBe('unknown');
    expect(v.uaClass).toBe('unknown');
  });

  it('navigate mode alone, without a document dest, is not enough for `browser`', () => {
    const v = classifyBrowserIntent({ 'user-agent': CHROME_UA, accept: NAV_ACCEPT, 'sec-fetch-mode': 'navigate' });
    expect(v.cls).toBe('unknown');
  });
});

describe('classifyBrowserIntent — ua_class projects the ONE UA→identity map', () => {
  it('names a known crawler', () => {
    const ua = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    expect(classifyBrowserIntent({ 'user-agent': ua }).uaClass).toBe('googlebot');
  });

  it('an absent UA is `unknown`, an unmatched one is `other` — never guessed', () => {
    expect(classifyBrowserIntent({}).uaClass).toBe('unknown');
    expect(classifyBrowserIntent({ 'user-agent': 'Totally-Novel-Client/9' }).uaClass).toBe('other');
  });
});

describe('classifyBrowserIntent — layer ORDERING (the part UA fixtures cannot show)', () => {
  // The injected seam exists ONLY for these: it isolates which layer wins, with the UA verdict
  // forced rather than inferred.
  const alwaysAutomated = () => true;
  const neverAutomated = () => false;

  it('prefetch beats the UA layer', () => {
    const v = classifyBrowserIntent(nav({ 'sec-purpose': 'prefetch' }), { isAutomatedUa: alwaysAutomated });
    expect(v.reason).toBe('prefetch');
  });

  it('the UA layer beats the fetch-metadata layer', () => {
    const v = classifyBrowserIntent(nav({ 'sec-fetch-mode': 'cors' }), { isAutomatedUa: alwaysAutomated });
    expect(v.reason).toBe('ua_automated');
  });

  it('the fetch-metadata layer beats the Accept layer', () => {
    const v = classifyBrowserIntent(
      { 'user-agent': CHROME_UA, accept: WILDCARD_ACCEPT, 'sec-fetch-mode': 'cors' },
      { isAutomatedUa: neverAutomated },
    );
    expect(v.reason).toBe('non_navigate_mode');
  });

  it('a forced-human UA still reaches `browser` on a full navigation', () => {
    expect(classifyBrowserIntent(nav(), { isAutomatedUa: neverAutomated }).cls).toBe('browser');
  });
});

describe('classifyBrowserIntent — purity and header handling', () => {
  it('is pure: same headers in, same verdict out', () => {
    const h = nav();
    expect(classifyBrowserIntent(h)).toEqual(classifyBrowserIntent(h));
  });

  it('tolerates array-valued headers (Node exposes repeated headers as arrays)', () => {
    const v = classifyBrowserIntent({ ...nav(), 'sec-purpose': ['prefetch', 'x'] });
    expect(v.cls).toBe('bot');
    expect(v.reason).toBe('prefetch');
  });

  it('is case-insensitive on header VALUES', () => {
    expect(classifyBrowserIntent(nav({ 'sec-fetch-mode': 'NAVIGATE', 'sec-fetch-dest': 'Document' })).cls).toBe('browser');
  });
});
