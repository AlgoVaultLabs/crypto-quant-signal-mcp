/**
 * FOOTER-UNIFY-W1 — single source of truth for the AlgoVault BRAND footer.
 *
 * Markup defined ONCE here and consumed by BOTH render paths (architect Q3 HARD REQ):
 *   - TypeScript / Express:  `renderBrandFooter('desktop')` imported by src/index.ts
 *     (the /track-record page) + src/lib/account-handlers.ts (the /account family).
 *   - Static `.mjs` build path: `scripts/inject-footer.mjs` (the build-time injector) +
 *     `scripts/render-jsx-static.mjs` + `scripts/render-integrations.mjs` import the
 *     COMPILED `dist/lib/footer-content.js` via `createRequire` (the established
 *     build_landing.mjs pattern — tsc emits CJS under module=Node16).
 *
 * This retires the 7→1 footer-drift class: the PH "Follow" badge + footer links live in
 * exactly one place. The footer-drift CI canary asserts no inline brand-footer markup
 * (the `oklch(0.13 0.012 265)` signature) survives outside this module.
 *
 * Scope = EVERY public page. FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1 **reverses Mr.1 ruling
 * Q2=A**, which had held the page-nav (faq/glossary), SEO (16 pages) and copyright/MIT
 * (skills/integrations) footers to be intentionally DIFFERENT types, left as-is. The architect
 * re-ruled "Unify + preserve" with those footers' measured contents in front of them: ONE footer
 * type everywhere, and the links unique to the retired types are CARRIED INTO the set below so
 * the replace loses nothing. A deliberate reversal, recorded so the next reader does not mistake
 * it for drift — and it CLOSES the deferred FOOTER-UNIFY-SEO-BADGE-W1.
 *
 * The `NON_BRAND_SURFACES` assertion in tests/unit/footer-unify-canary.test.mjs encoded Q2=A and
 * is flipped in the same wave: an exemption and the test that pins it are a pair, and leaving
 * either half behind half-disables the guard or makes the test a lie.
 *
 * Lifted verbatim from the committed apex footer (PH-BADGE-COMPACT-W1, commit 386cf33),
 * with the architect-ratified normalizations:
 *   - Q4: all internal links ABSOLUTE `https://algovault.com/...` (identical markup is
 *     correct on both algovault.com and api.algovault.com — no cross-host relative 404).
 *     Signup CTA -> `https://api.algovault.com/welcome` (unified sign-in; api-canonical).
 *   - Q5: SUPERSET link set (GitHub · X · Signup · Refer & Earn · Privacy) on every brand
 *     surface — /track-record + /account GAIN "Refer & Earn" (additive; zero link loss).
 *   - external links carry `rel="noopener noreferrer"` (Design.md §9; the apex used bare
 *     `noopener` — hardened here).
 */

/** Greppable marker the injector + drift canary key on; present on every shared brand footer. */
export const BRAND_FOOTER_MARKER = 'data-av-brand-footer';

/** The distinctive background signature that uniquely identifies a BRAND footer (vs the
 *  page-nav / SEO / copyright footer types). The injector matches on this to strip-and-reinject. */
export const BRAND_FOOTER_BG_SIGNATURE = 'oklch(0.13 0.012 265)';

export interface FooterLink {
  readonly href: string;
  readonly label: string;
  readonly external: boolean;
}

/**
 * Superset footer link set (Q5), absolute URLs (Q4). Label is HTML-ready (entities kept).
 *
 * EXPORTED so the coverage gate reads the same array this renders from — a test that hardcodes
 * its own copy of the expected links is a second derivation, and a duplicated fact goes stale.
 *
 * Order is architect-confirmed (FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1): navigation leads,
 * `Contact` sits after `Refer & Earn`, and the legal pair closes the list.
 *
 * `Home` / `Track Record` / `Glossary` were CARRIED IN from the page-nav footer this wave
 * retires (landing/faq.html). They are what makes the architect's "preserve" leg true — dropping
 * them while replacing that footer would be a user-visible content reduction, which the
 * Data-Integrity rule forbids as a side effect. Do not "tidy" them out.
 *
 * Every internal href was probed 200 on the apex at wave time; `/contact` is served there by the
 * `handle /contact` block CONTACT-PAGE-APEX-AND-INQUIRY-TYPE-W1 added. `Signup` stays on the api
 * host because the apex allowlist deliberately excludes /welcome + /signup.
 */
export const FOOTER_LINKS: ReadonlyArray<FooterLink> = [
  { href: 'https://algovault.com/', label: 'Home', external: false },
  { href: 'https://algovault.com/track-record', label: 'Track Record', external: false },
  { href: 'https://algovault.com/glossary', label: 'Glossary', external: false },
  { href: 'https://github.com/AlgoVaultLabs', label: 'GitHub', external: true },
  { href: 'https://x.com/AlgoVaultLabs', label: 'X / Twitter', external: true },
  // FUNNEL-FIX-NAV-CTA-WELCOME-W1: the Signup CTA leads to the unified sign-in /welcome (api-canonical; the apex allowlist excludes /welcome + /signup).
  { href: 'https://api.algovault.com/welcome', label: 'Signup', external: false },
  { href: 'https://algovault.com/referral', label: 'Refer &amp; Earn', external: false },
  { href: 'https://algovault.com/contact', label: 'Contact', external: false },
  { href: 'https://algovault.com/privacy', label: 'Privacy', external: false },
  { href: 'https://algovault.com/terms', label: 'Terms', external: false },
];

/**
 * The PH "Follow" badge — Dark + Small (86×32), count-free — inside the reusable
 * `data-slot="social-proof-badges"` container. SINGLE definition (the only Product Hunt
 * badge reference in source). 1px var(--line) border for contrast on the near-black footer.
 */
const PH_FOLLOW_BADGE_HTML =
  '<div data-slot="social-proof-badges" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
  '<a href="https://www.producthunt.com/products/algovault?utm_source=badge-follow&utm_medium=badge&utm_campaign=badge-algovault" ' +
  'target="_blank" rel="noopener noreferrer" style="display:inline-flex;border:1px solid var(--line);border-radius:4px;line-height:0">' +
  '<img src="https://api.producthunt.com/widgets/embed-image/v1/follow.svg?product_id=1254662&theme=dark&size=small" ' +
  'alt="Algovault - On-chain-verified trade calls for AI agents | Product Hunt" ' +
  'style="width: 86px; height: 32px;" width="86" height="32" /></a></div>';

export type FooterVariant = 'desktop' | 'mobile';

/**
 * Render the canonical brand footer for the given dual-render variant.
 * `desktop` = horizontal row (padding 44px); `mobile` = stacked column (padding 32px).
 * Express handlers use `'desktop'` (single footer; CSS-responsive page).
 */
export function renderBrandFooter(variant: FooterVariant = 'desktop'): string {
  const isDesktop = variant === 'desktop';
  const footerStyle = isDesktop
    ? `padding:44px 80px 56px;border-top:1px solid var(--line);background:${BRAND_FOOTER_BG_SIGNATURE};display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:24px;font-size:13px;color:var(--fg-3)`
    : `padding:32px 22px 36px;border-top:1px solid var(--line);background:${BRAND_FOOTER_BG_SIGNATURE};display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;gap:18px;font-size:13px;color:var(--fg-3)`;
  const linksGap = isDesktop ? '28px' : '18px';
  const links = FOOTER_LINKS.map((l) => {
    const ext = l.external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${l.href}"${ext} style="color:var(--fg-3);text-decoration:none">${l.label}</a>`;
  }).join('');
  return (
    `<footer ${BRAND_FOOTER_MARKER}="${variant}" style="${footerStyle}">` +
    '<div style="display:flex;align-items:center;gap:10px">' +
    '<img src="/logo.png" alt="AlgoVault" style="width:22px;height:22px;border-radius:6px;object-fit:contain;flex-shrink:0"/>' +
    '<span style="color:var(--fg-2)">Built by AlgoVault Labs</span></div>' +
    `<div style="display:flex;align-items:center;gap:${linksGap};flex-wrap:wrap">${links}</div>` +
    PH_FOLLOW_BADGE_HTML +
    '</footer>'
  );
}

// ── CONVERSION-SURFACES-W2 CH3 — the conversion band ─────────────────────────────────────────
//
// WHY IT LIVES BESIDE THE FOOTER. 63% of visitors (449 of 713 over 28d) enter on a page that
// ends with nothing to do — /verify 193 uniques at 98% bounce, /docs 93 at 97%,
// /integrations/* ~150 at ~100%. The brand footer is the ONE element already proven to reach
// every page through one generator (glob-derived static injection + the same function on every
// server-rendered surface), so putting the band on that path is what makes "no page ships
// without a door" structural instead of a rule someone has to remember.
//
// SELF-CONTAINED BY NECESSITY, not by preference. Measured 2026-09-07: `/carry-tracker` loads
// NEITHER cdn.tailwindcss.com NOR _design/algovault-design.css, so `order-*` utilities and the
// `.btn` classes do not exist there, while `/track-record` and every static landing page have
// both. A band that depended on either would render unstyled on a surface it is supposed to
// serve. So: inline styles, CSS variables with literal fallbacks (`--fg` and `--mint` are not
// defined on carry-tracker, only `--line`/`--fg-2`/`--fg-3`), and the one thing inline styles
// cannot express — the mobile B-first order — carried by a scoped <style> block keyed on this
// element's own data attribute. This is Design.md §5's option (b), taken because the probe it
// prescribes found no order utility in the design system.

import {
  BAND_EYEBROW,
  BAND_HEADING,
  BAND_CTA_PRIMARY_LABEL,
  BAND_CTA_PRIMARY_HREF,
  BAND_CTA_SECONDARY_LABEL,
  BAND_CTA_SECONDARY_HREF,
  BAND_LINK_LABEL,
  BAND_LINK_HREF,
  bandSubLine,
  bandSubLineHtml,
} from './conversion-copy.js';

/** Stamp the AC greps on, and the hook the scoped stylesheet is keyed to. */
export const CONVERSION_BAND_MARKER = 'data-conversion-band';

/** The injector's replaceable region. Its own markers, NOT the footer's — see the injector. */
export const CONVERSION_BAND_START = '<!-- CONVERSION-BAND:START -->';
export const CONVERSION_BAND_END = '<!-- CONVERSION-BAND:END -->';

/**
 * Where the band must NOT render, in TWO key spaces because there are two render paths and
 * neither can see the other's identifier.
 *
 * `paths` is what the static injector has: a repo-relative file path from its glob.
 * `routes` is what a server-rendered page has: the URL it answers on. `renderBrandFooter` takes
 * a variant and no route, so a route cannot be inferred inside this module — each server-rendered
 * caller passes its own.
 *
 * Every row is a page where a "next step" would be wrong, not merely unhelpful: `/` has its own
 * doors and its own hero; the transactional pages (`/welcome`, `/account`, `/signup`, `/join`)
 * are mid-flow, and a second CTA competes with the one the visitor is already on; `/contact`,
 * `/privacy`, `/terms`, `/referral`, `/referral-terms` are legal or carry their own sign-in card;
 * `/dashboard` is operator-only and never sees a visitor. `_templates/answer-page.template.html`
 * is a TEMPLATE inside the footer glob — banding it would bake the band into whatever it renders.
 */
export const CONVERSION_BAND_EXCLUDE: {
  readonly paths: readonly string[];
  readonly routes: readonly string[];
} = Object.freeze({
  paths: Object.freeze([
    'landing/index.html',
    'landing/privacy.html',
    'landing/terms.html',
    'landing/_templates/answer-page.template.html',
  ]),
  routes: Object.freeze([
    '/',
    '/welcome',
    '/account',
    '/signup',
    '/contact',
    '/privacy',
    '/terms',
    '/referral',
    '/referral-terms',
    '/join',
    '/dashboard',
  ]),
});

/** True when the static page at this repo-relative path must not carry the band. */
export function isBandExcludedPath(repoRelativePath: string): boolean {
  return CONVERSION_BAND_EXCLUDE.paths.includes(repoRelativePath.replace(/^\.\//, ''));
}

/** True when the server-rendered route must not carry the band. */
export function isBandExcludedRoute(route: string): boolean {
  const r = route.split('?')[0].replace(/\/+$/, '') || '/';
  return CONVERSION_BAND_EXCLUDE.routes.some((x) => (x.replace(/\/+$/, '') || '/') === r);
}

const BAND_STYLE_ID = 'av-conversion-band-css';

/**
 * The scoped stylesheet. Two rules only: the <640px B-first order the spec mandates, and a
 * button reset so the anchors look like buttons without `.btn` (absent on carry-tracker).
 * Emitted INSIDE the band so a page that carries the band always carries its rules, and keyed
 * to `[data-conversion-band]` so it can never leak onto the host page's own elements.
 */
const BAND_CSS =
  `<style id="${BAND_STYLE_ID}">` +
  '[data-conversion-band] .avcb-row{display:flex;flex-direction:row;align-items:center;gap:12px;flex-wrap:wrap}' +
  '[data-conversion-band] .avcb-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:9px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap}' +
  '[data-conversion-band] .avcb-a{background:var(--accent, var(--mint, oklch(0.86 0.16 165)));color:oklch(0.16 0.05 165);box-shadow:0 8px 24px -10px oklch(0.86 0.16 165 / 0.5)}' +
  '[data-conversion-band] .avcb-b{border:1px solid var(--line-2, var(--line, #30363d));background:oklch(0.22 0.012 265 / 0.6);color:var(--fg, #e6edf3)}' +
  '[data-conversion-band] .avcb-link{display:inline-flex;align-items:center;min-height:44px;padding:0 4px;font-size:13.5px;text-decoration:none;color:var(--accent, var(--mint, oklch(0.86 0.16 165)))}' +
  '@media (max-width:639px){' +
  '[data-conversion-band] .avcb-row{flex-direction:column;align-items:stretch}' +
  '[data-conversion-band] .avcb-a{order:2}' +
  '[data-conversion-band] .avcb-b{order:1}' +
  '[data-conversion-band] .avcb-link{order:3;justify-content:center}}' +
  '</style>';

/**
 * CONVERSION-SURFACES-W2 CH2 (Q2-A) tagging. The served /js/insights.js reads
 * `plausible-event-name(=|--)(.+)` off the element or <=3 ancestors, and `+` decodes to a space.
 * `page` is stamped per route so the 2026-09-21 readout can rank doors BY PAGE, which is the
 * whole point of putting a band on 40-odd surfaces rather than one.
 *
 * The Telegram anchor is cross-host and TAGGED, so it emits `CTA Click` INSTEAD OF
 * `Outbound Link: Click` — the script early-returns past its outbound branch for any tagged
 * element. That is deliberate and the readout unions the two across the cutover.
 */
const tag = (cta: string, page: string): string =>
  `plausible-event-name=CTA+Click plausible-event-location=band plausible-event-cta=${cta} plausible-event-page=${page}`;

/** `page` prop values must survive the class-token grammar — no spaces, no quotes. */
const pageToken = (route: string): string => {
  const r = route.split('?')[0].replace(/\/+$/, '') || '/';
  return r === '/' ? 'root' : r.replace(/^\//, '').replace(/[^A-Za-z0-9/_-]/g, '-').replace(/\//g, '.');
};

/**
 * Render the band for `route`. Returns '' for an excluded route, so a caller can interpolate it
 * unconditionally and the exclusion stays in ONE place rather than in every call site.
 */
export function renderConversionBand(opts: { route: string }): string {
  if (isBandExcludedRoute(opts.route)) return '';
  const page = pageToken(opts.route);
  return (
    `<section ${CONVERSION_BAND_MARKER} data-page="${page}" style="padding:56px 22px;border-top:1px solid var(--line, #30363d);background:transparent">` +
    BAND_CSS +
    '<div style="max-width:1440px;margin:0 auto">' +
    '<div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:16px;font-family:var(--font-mono, ui-monospace, monospace);font-size:11px;color:var(--fg-3, #8b949e);letter-spacing:0.14em;text-transform:uppercase">' +
    '<span style="width:5px;height:5px;border-radius:50%;background:var(--accent, var(--mint, oklch(0.86 0.16 165)))"></span>' +
    `${BAND_EYEBROW}</div>` +
    `<h2 style="font-family:var(--font-display, inherit);font-size:clamp(26px,4vw,38px);line-height:1.08;letter-spacing:-0.022em;font-weight:500;margin:0;text-wrap:balance;color:var(--fg, #e6edf3)">${BAND_HEADING}</h2>` +
    `<p style="font-size:15px;color:var(--fg-3, #8b949e);max-width:680px;margin:14px 0 26px;line-height:1.6">${bandSubLineHtml()}</p>` +
    '<div class="avcb-row">' +
    `<a class="avcb-btn avcb-a ${tag('quickstart', page)}" href="${BAND_CTA_PRIMARY_HREF}">${BAND_CTA_PRIMARY_LABEL}</a>` +
    `<a class="avcb-btn avcb-b ${tag('telegram', page)}" href="${BAND_CTA_SECONDARY_HREF}" target="_blank" rel="noopener noreferrer">${BAND_CTA_SECONDARY_LABEL}</a>` +
    `<a class="avcb-link ${tag('pricing', page)}" href="${BAND_LINK_HREF}">${BAND_LINK_LABEL}</a>` +
    '</div></div></section>'
  );
}

/** The band wrapped in its replaceable injector region. */
export function renderConversionBandRegion(opts: { route: string }): string {
  const band = renderConversionBand(opts);
  return band ? `${CONVERSION_BAND_START}\n${band}\n${CONVERSION_BAND_END}` : '';
}
