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
 * Scope = the BRAND footer TYPE only (apex, /track-record, /account, how-it-works, the 4
 * integration tutorials). The page-nav (faq/glossary), SEO (16 pages), and copyright/MIT
 * (skills/integrations) footers are intentionally DIFFERENT types and are left as-is
 * (Mr.1 ruling Q2=A); SEO badging is the deferred FOOTER-UNIFY-SEO-BADGE-W1.
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

/** Superset footer link set (Q5), absolute URLs (Q4). Label is HTML-ready (entities kept). */
const FOOTER_LINKS: ReadonlyArray<{ href: string; label: string; external: boolean }> = [
  { href: 'https://github.com/AlgoVaultLabs', label: 'GitHub', external: true },
  { href: 'https://x.com/AlgoVaultLabs', label: 'X / Twitter', external: true },
  // FUNNEL-FIX-NAV-CTA-WELCOME-W1: the Signup CTA leads to the unified sign-in /welcome (api-canonical; the apex allowlist excludes /welcome + /signup).
  { href: 'https://api.algovault.com/welcome', label: 'Signup', external: false },
  { href: 'https://algovault.com/referral', label: 'Refer &amp; Earn', external: false },
  { href: 'https://algovault.com/privacy', label: 'Privacy', external: false },
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
