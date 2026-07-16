/**
 * LANDING-CONVERSION-TRUST-W1 — surfaces the on-chain-verified track record at the buy
 * decision (additive trust band), adds a per-pricing verify link, wires the (previously
 * dead-#anchor) pricing CTAs to /signup with landing attribution, and surfaces a keyless
 * free-start path. Asserts against the built dual-render landing/index.html (desktop+mobile
 * artboards, so every additive element appears EXACTLY twice).
 *
 * LAW guards: Brain-Layer hero + the 4 Stripe + x402 card copy/chrome are byte-unchanged;
 * proof numbers are LIVE-bound via data-tr-field (never hardcoded).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../landing/index.html', import.meta.url), 'utf8');
const count = (s: string): number => html.split(s).length - 1;

describe('LANDING-CONVERSION-TRUST-W1 — trust band, verify link, free-start, CTA wiring', () => {
  it('trust band present in both artboards with the approved proof statement', () => {
    expect(count('Don’t trust — verify.')).toBe(2);
    expect(html).toContain('PFE win rate across');
    expect(html).toContain('every one Merkle-anchored on Base.');
  });

  it('proof numbers are LIVE-bound via data-tr-field, with % INSIDE the pfe_wr span', () => {
    expect(count('<span data-tr-field="pfe_wr">91.5%</span>')).toBe(2);
    expect(count('<span data-tr-field="call_count">246,980</span>+')).toBe(2);
    // Design.md data-tr-field-percent-suffix-discipline: % must never sit OUTSIDE the span.
    expect(html).not.toMatch(/<span data-tr-field="pfe_wr">[0-9.]+<\/span>%/);
  });

  it('grep gate: trust-band PFE WR + call count exist ONLY inside data-tr-field spans', () => {
    const i = html.indexOf('Don’t trust — verify.');
    const band = html.slice(html.lastIndexOf('<section', i), html.indexOf('</section>', i) + 10);
    const stripped = band.replace(/<span data-tr-field="[^"]+">[^<]*<\/span>/g, '');
    expect(stripped).not.toMatch(/\d+(\.\d+)?%/); // PFE WR % is span-bound (zero hardcoded)
    expect(stripped).not.toContain('246,980');    // call count is span-bound (zero hardcoded)
  });

  it('band proof link → clean /track-record (landing-section attribution via Plausible event); pricing verify link → pricing-section event', () => {
    // SEO-STRIP-TRACKING-PARAMS-W1: the ?from=landing / ?from=pricing URL params were stripped
    // (Google treats /track-record?from=… as a duplicate URL — crawl-budget waste). The
    // landing-vs-pricing section attribution now rides a Plausible 'CTA Click' event; the href
    // is the clean canonical path.
    expect(count('See the live track record →')).toBe(2);
    expect(count("plausible('CTA Click',{props:{source:'homepage',medium:'landing',campaign:'track-record'}})")).toBe(2);
    expect(count('Verify our track record →')).toBe(2);
    expect(count("plausible('CTA Click',{props:{source:'homepage',medium:'pricing',campaign:'track-record'}})")).toBe(2);
    expect(html).not.toContain('/track-record?from=');
  });

  it('on-chain + ERC-8004 trust badges deep-link to Basescan (target+rel; agentId live-bound)', () => {
    // Scope to the trust band: the anchor-contract address ALSO appears in the pre-existing
    // Tamper-Proof "View Contract" callout, so assert each badge WITHIN each band region.
    let from = 0, bands = 0;
    for (;;) {
      const i = html.indexOf('Don’t trust — verify.', from);
      if (i < 0) break;
      const band = html.slice(html.lastIndexOf('<section', i), html.indexOf('</section>', i) + 10);
      expect(band).toContain('On-Chain Verified');
      expect(band).toContain('basescan.org/address/0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81" target="_blank" rel="noopener noreferrer"');
      expect(band).toContain('basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=44544" target="_blank" rel="noopener noreferrer"');
      expect(band).toContain('<span data-tr-field="erc8004_agent_id">44544</span>');
      bands++;
      from = i + 1;
    }
    expect(bands).toBe(2);
  });

  it('keyless free-start CTA surfaced → #quickstart; the dead #free anchor is gone', () => {
    expect(count('Start free — 100 calls/month, no card. Get your first BTC verdict in 30 seconds →')).toBe(2);
    expect(html).not.toContain('href="#free"');
  });

  it('pricing buy buttons wired to /signup (plan= kept; upgrade_from stripped — attribution via Plausible event)', () => {
    for (const plan of ['starter', 'pro', 'enterprise']) {
      // SEO-STRIP-TRACKING-PARAMS-W1: upgrade_from=landing_pricing removed (redundant with the
      // 'Signup Click' Plausible event's source:'pricing-section' prop). plan= kept — it is
      // functional (selects the plan). href is now the clean canonical signup URL.
      expect(count(`href="https://api.algovault.com/signup?plan=${plan}"`)).toBe(2);
      expect(count(`plausible('Signup Click',{props:{plan:'${plan}',source:'pricing-section'}})`)).toBe(2);
      expect(html).not.toContain(`href="#${plan}"`);
    }
    // /signup is routed ONLY on api.algovault.com (algovault.com/signup 404s) — no relative /signup CTAs.
    expect(html).not.toContain('href="/signup?plan=');
    expect(html).not.toContain('upgrade_from=landing_pricing');
  });

  it('LAW: Brain-Layer hero + 4 Stripe card copy + x402 card are byte-unchanged (only hrefs wired)', () => {
    expect(html).toContain('The Brain Layer');
    expect(count('Subscribe to Starter')).toBe(2);
    expect(count('Subscribe to Pro')).toBe(2);
    expect(count('Subscribe to Enterprise')).toBe(2);
    expect(count('>Start Free<')).toBe(2);
    // 2 = x402 pricing card (untouched, desktop+mobile) + 2 = Connect-section x402 card
    // (added by LANDING-HERO-DEDENSIFY-W1; links to x402 docs, does not duplicate pricing).
    expect(count('/docs.html#x402')).toBe(4);
  });

  it('the primary nav "Signup" CTA leads to the unified sign-in /welcome on the absolute api host', () => {
    // FUNNEL-FIX-NAV-CTA-WELCOME-W1: the nav "Signup" front door now points to /welcome
    // (unified sign-in). /welcome + /signup + /account are api-canonical — NOT in the apex
    // Caddy allowlist (algovault.com/welcome AND /signup 404) — so the link MUST be absolute
    // api host. Paid "Subscribe" pricing links stay on /signup?plan= (the express-lane).
    expect(html).not.toContain('href="/signup"');   // no relative /signup (404s on apex)
    expect(html).not.toContain('href="/welcome"');   // no relative /welcome either (404s on apex)
    expect(html).not.toContain('href="/signup?');    // pricing CTAs are absolute too
    expect(html).toContain('href="https://api.algovault.com/welcome"');       // nav Signup -> unified /welcome
    expect(html).toContain('href="https://api.algovault.com/signup?plan=');   // paid pricing express-lane preserved
  });
});
