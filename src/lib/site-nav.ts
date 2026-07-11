// LANDING-MOBILE-NAV-FUNCTION-RENDERED-W1 — shared site-nav generator.
//
// Unifies the two previously-duplicated function-rendered navs — the inline
// /track-record nav (formerly src/index.ts) and ACCOUNT_NAV_HTML (formerly
// inline in src/lib/account-handlers.ts) — into ONE source of truth, and adds
// the mobile hamburger + slide-down panel + controller, byte-consistent with
// the static landing/*.html pages (MOBILE-NAV-HEADER-LANDING, 2026-07-03).
//
// The DESKTOP `hidden sm:flex` links container is reproduced byte-IDENTICALLY
// to the prior inline navs (guarded by tests/unit/site-nav-byte-equivalence.test.ts
// against the frozen origin/main nav containers). The mobile button/panel/script
// are strictly additive. Parity is enforced by scripts/check_mobile_nav_parity.sh
// (extended to cover src/**).

export interface SiteNavOptions {
  /** Which link renders active (text-mint-400 font-medium); the other is hover. */
  active: 'track-record' | 'account';
  /**
   * Track Record link href. Relative `/track-record` on algovault.com-served
   * pages (e.g. /track-record itself); absolute `https://algovault.com/track-record`
   * on api.algovault.com-served pages (e.g. /account — cross-origin). Every other
   * link is already absolute, so only this one varies by serving origin.
   */
  trackRecordHref: string;
}

const HOVER = 'hover:text-white transition';
const ACTIVE = 'text-mint-400 font-medium';
const SIGNUP_PILL =
  'px-3 py-1 bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 rounded-full text-xs font-semibold transition';
const SIGNUP_HREF = 'https://api.algovault.com/welcome'; // FUNNEL-FIX-NAV-CTA-WELCOME-W1: nav Signup CTA -> unified sign-in /welcome (absolute api host — /welcome 404s on the apex allowlist)

/** Ordered nav links shared by both surfaces (Signup handled separately). */
function navLinks(o: SiteNavOptions): Array<{ href: string; label: string }> {
  return [
    { href: o.trackRecordHref, label: 'Track Record' },
    { href: 'https://algovault.com/how-it-works', label: 'How it works' },
    { href: 'https://algovault.com/#pricing', label: 'Pricing' },
    { href: 'https://algovault.com/integrations', label: 'Integrations' },
    { href: 'https://algovault.com/skills', label: 'Skills' },
    { href: 'https://algovault.com/docs.html', label: 'Docs' },
    { href: 'https://algovault.com/verify', label: 'Verify' },
    { href: 'https://api.algovault.com/account', label: 'Account' },
  ];
}

/**
 * The desktop `hidden sm:flex` links container — byte-identical to the prior
 * inline navs. Track Record + Account carry active-or-hover per `active`; the
 * 6-space `<a>` indent and 4-space `</div>` match the frozen originals exactly.
 */
function desktopLinksContainer(o: SiteNavOptions): string {
  const trCls = o.active === 'track-record' ? ACTIVE : HOVER;
  const acctCls = o.active === 'account' ? ACTIVE : HOVER;
  const rows = [
    `      <a href="${o.trackRecordHref}" class="${trCls}">Track Record</a>`,
    `      <a href="https://algovault.com/how-it-works" class="${HOVER}">How it works</a>`,
    `      <a href="https://algovault.com/#pricing" class="${HOVER}">Pricing</a>`,
    `      <a href="https://algovault.com/integrations" class="${HOVER}">Integrations</a>`,
    `      <a href="https://algovault.com/skills" class="${HOVER}">Skills</a>`,
    `      <a href="https://algovault.com/docs.html" class="${HOVER}">Docs</a>`,
    `      <a href="https://algovault.com/verify" class="${HOVER}">Verify</a>`,
    `      <a href="https://api.algovault.com/account" class="${acctCls}">Account</a>`,
    `      <a href="${SIGNUP_HREF}" class="${SIGNUP_PILL}">Signup</a>`,
  ];
  return `<div class="hidden sm:flex items-center gap-6 text-sm text-gray-400">\n${rows.join('\n')}\n    </div>`;
}

/** sm:hidden hamburger button — byte-consistent with the static landing pages. */
const MOBILE_BUTTON = `      <button type="button" data-mobile-nav-toggle id="mobile-nav-toggle" aria-label="Open menu" aria-controls="mobile-menu" aria-expanded="false" class="sm:hidden inline-flex items-center justify-center w-11 h-11 -mr-2 text-gray-400 hover:text-white transition">
        <svg data-mobile-nav-icon-open class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg>
        <svg data-mobile-nav-icon-close class="w-6 h-6 hidden" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>`;

/** #mobile-menu slide-down panel — this nav's own links + full-width Signup CTA. */
function mobilePanel(o: SiteNavOptions): string {
  const links = navLinks(o)
    .map(
      (l) =>
        `        <a href="${l.href}" class="block px-6 py-3 text-sm text-gray-300 hover:text-white hover:bg-white/5 transition">${l.label}</a>`,
    )
    .join('\n');
  return `<div id="mobile-menu" data-mobile-nav-panel class="hidden sm:hidden border-t border-white/5" style="background:rgba(6,10,20,0.97);backdrop-filter:blur(12px)">
${links}
        <div class="px-6 py-3">
          <a href="${SIGNUP_HREF}" class="block px-4 py-3 rounded-lg text-sm text-center bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 font-semibold transition">Signup</a>
        </div>
      </div>`;
}

/** Null-safe controller IIFE — byte-identical to the static landing pages. */
const MOBILE_SCRIPT = `<script>
/* mobile-nav-header controller (shared, identical across all landing pages) */
(function(){
  var toggle = document.querySelector('[data-mobile-nav-toggle]');
  var panel = document.getElementById('mobile-menu');
  if (!toggle || !panel) return;
  var nav = toggle.closest('nav');
  var iconOpen = toggle.querySelector('[data-mobile-nav-icon-open]');
  var iconClose = toggle.querySelector('[data-mobile-nav-icon-close]');
  function isOpen(){ return !panel.classList.contains('hidden'); }
  function setOpen(open){
    panel.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (iconOpen) iconOpen.classList.toggle('hidden', open);
    if (iconClose) iconClose.classList.toggle('hidden', !open);
  }
  toggle.addEventListener('click', function(e){ e.stopPropagation(); setOpen(!isOpen()); });
  panel.addEventListener('click', function(e){ if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && isOpen()) setOpen(false); });
  document.addEventListener('click', function(e){ if (isOpen() && nav && !nav.contains(e.target)) setOpen(false); });
})();
</script>`;

/**
 * The canonical fixed-top site nav for function-rendered pages: brand block +
 * desktop links (byte-identical to the prior inline navs) + mobile hamburger +
 * #mobile-menu panel + controller. One call renders the complete, working unit.
 */
export function renderSiteNav(o: SiteNavOptions): string {
  return `<nav class="fixed top-0 w-full z-50 border-b border-white/5" style="background:rgba(6,10,20,0.85);backdrop-filter:blur(12px)">
  <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
    <a href="https://algovault.com/" class="flex items-center gap-2.5" aria-label="AlgoVault home">
      <img src="/logo.png" alt="AlgoVault Logo" class="w-7 h-7 rounded-md">
      <span class="text-white font-semibold text-sm">AlgoVault Labs</span>
    </a>
    ${desktopLinksContainer(o)}
${MOBILE_BUTTON}
  </div>
      ${mobilePanel(o)}
</nav>
${MOBILE_SCRIPT}`;
}
