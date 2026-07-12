// NAV-PLATFORM-GENERATOR-W1 CH2 — the ONE nav renderer (single-derivation).
//
// `renderSiteNav()` projects the desktop bar + mobile drawer from `buildNavModel()`
// (src/lib/nav-manifest.ts). Both the function-rendered routes (/track-record via
// src/index.ts, /account via account-handlers.ts) AND the build-time injector
// (scripts/build_nav.mjs, which imports THIS compiled function) render from the same call —
// so every one of the 26 nav surfaces is byte-identical. There is NO second hand-authored
// nav. (Supersedes LANDING-MOBILE-NAV-FUNCTION-RENDERED-W1's per-page `active`/`trackRecordHref`
// options: the model uses absolute hrefs uniformly (A6), and the current-page highlight is now
// applied CLIENT-SIDE by the controller matching location.pathname — so one region works on
// both the apex- and api-served origins with no server-side variation.)
//
// Parity (desktop⇄mobile item set) is enforced by tests/build-nav.test.mjs; structural
// mobile-presence by scripts/check_mobile_nav_parity.sh; byte-shape by tests/site-nav.test.ts.
import {
  buildNavModel,
  type NavModel,
  type NavLink,
  type NavDropdown,
  type NavColumn,
  type NavMenuItem,
} from './nav-manifest.js';

// ── shared class tokens ──────────────────────────────────────────────────────────────────
const HOVER = 'hover:text-white transition';
const SIGNUP_PILL =
  'px-3 py-1 bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 rounded-full text-xs font-semibold transition';
const PANEL_CARD = 'rounded-xl border border-white/10 p-4'; // navy card shared by mega + simple dropdown panels
const PANEL_STYLE =
  'background:rgba(10,14,26,0.98);backdrop-filter:blur(16px);box-shadow:0 20px 60px -12px rgba(0,0,0,0.7)';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Off-site items (t.me, …) get target=_blank + rel=noopener (tabnabbing + external-link discipline). */
const extAttr = (it: NavMenuItem): string => (it.external ? ' target="_blank" rel="noopener noreferrer"' : '');
const panelId = (label: string, prefix = ''): string =>
  `nav-${prefix}${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}-panel`;

const CHEVRON =
  '<svg class="w-3.5 h-3.5 opacity-70" data-nav-chevron fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>';

// ── desktop ──────────────────────────────────────────────────────────────────────────────
function megaColumn(col: NavColumn): string {
  const items = col.items
    .map(
      (it: NavMenuItem) =>
        `          <a href="${it.href}"${extAttr(it)} class="block py-1.5 group/i">` +
        `<span class="block text-sm text-gray-200 group-hover/i:text-mint-400 transition">${esc(it.label)}</span>` +
        (it.blurb ? `<span class="block text-[11px] text-gray-500 leading-snug">${esc(it.blurb)}</span>` : '') +
        `</a>`,
    )
    .join('\n');
  const more = col.more
    ? `\n          <a href="${col.more.href}" class="inline-block mt-2 text-xs font-medium text-mint-400 hover:text-mint-300 transition">${esc(col.more.label)} →</a>`
    : '';
  return (
    `        <div>\n` +
    `          <div class="text-[11px] font-semibold uppercase tracking-wider text-gray-400">${esc(col.title)}</div>\n` +
    (col.caption ? `          <div class="text-[11px] text-gray-500 mb-2.5">${esc(col.caption)}</div>\n` : '') +
    `${items}${more}\n` +
    `        </div>`
  );
}

function desktopDropdown(g: NavDropdown): string {
  const id = panelId(g.label);
  let panelInner: string;
  let width: string;
  if (g.columns) {
    width = 'w-[640px] grid grid-cols-3 gap-6';
    panelInner = g.columns.map(megaColumn).join('\n');
  } else {
    width = 'w-60';
    panelInner = (g.items ?? [])
      .map(
        (it) =>
          `        <a href="${it.href}"${extAttr(it)} class="block px-3 py-2 rounded-lg hover:bg-white/5 transition group/i">` +
          `<span class="block text-sm text-gray-200 group-hover/i:text-mint-400 transition">${esc(it.label)}</span>` +
          (it.blurb ? `<span class="block text-[11px] text-gray-500">${esc(it.blurb)}</span>` : '') +
          `</a>`,
      )
      .join('\n');
  }
  return `<div class="relative" data-nav-dropdown>
      <button type="button" data-nav-dropdown-toggle aria-haspopup="true" aria-expanded="false" aria-controls="${id}" class="inline-flex items-center gap-1 ${HOVER}">${esc(g.label)} ${CHEVRON}</button>
      <div id="${id}" data-nav-dropdown-panel class="hidden absolute left-0 top-full pt-3 z-50">
        <div class="${width} ${PANEL_CARD}" style="${PANEL_STYLE}">
${panelInner}
        </div>
      </div>
    </div>`;
}

function desktopBar(model: NavModel): string {
  const rows = model.groups.map((g) =>
    g.kind === 'link'
      ? `      <a href="${(g as NavLink).href}" class="${HOVER}" data-nav-link>${esc(g.label)}</a>`
      : `      ${desktopDropdown(g as NavDropdown)}`,
  );
  rows.push(`      <a href="${model.cta.href}" class="${SIGNUP_PILL}" data-nav-link>${esc(model.cta.label)}</a>`);
  return `<div class="hidden sm:flex items-center gap-6 text-sm text-gray-400">\n${rows.join('\n')}\n    </div>`;
}

// ── mobile ───────────────────────────────────────────────────────────────────────────────
const MOBILE_BUTTON = `      <button type="button" data-mobile-nav-toggle id="mobile-nav-toggle" aria-label="Open menu" aria-controls="mobile-menu" aria-expanded="false" class="sm:hidden inline-flex items-center justify-center w-11 h-11 -mr-2 text-gray-400 hover:text-white transition">
        <svg data-mobile-nav-icon-open class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg>
        <svg data-mobile-nav-icon-close class="w-6 h-6 hidden" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>`;

function mobileAccordion(g: NavDropdown): string {
  const id = panelId(g.label, 'm-');
  const items: NavMenuItem[] = g.columns
    ? g.columns.flatMap((c) => [...c.items, ...(c.more ? [c.more] : [])])
    : g.items ?? [];
  const links = items
    .map(
      (it) =>
        `          <a href="${it.href}"${extAttr(it)} class="block pl-9 pr-6 py-2.5 text-sm text-gray-400 hover:text-white hover:bg-white/5 transition">${esc(it.label)}</a>`,
    )
    .join('\n');
  return `        <button type="button" data-nav-accordion-toggle aria-expanded="false" aria-controls="${id}" class="w-full flex items-center justify-between px-6 py-3 text-sm text-gray-300 hover:text-white hover:bg-white/5 transition">${esc(g.label)} ${CHEVRON}</button>
        <div id="${id}" data-nav-accordion-panel class="hidden">
${links}
        </div>`;
}

function mobileDrawer(model: NavModel): string {
  const body = model.groups
    .map((g) =>
      g.kind === 'link'
        ? `        <a href="${(g as NavLink).href}" class="block px-6 py-3 text-sm text-gray-300 hover:text-white hover:bg-white/5 transition">${esc(g.label)}</a>`
        : mobileAccordion(g as NavDropdown),
    )
    .join('\n');
  return `<div id="mobile-menu" data-mobile-nav-panel class="hidden sm:hidden border-t border-white/5" style="background:rgba(6,10,20,0.97);backdrop-filter:blur(12px)">
${body}
        <div class="px-6 py-3">
          <a href="${model.cta.href}" class="block px-4 py-3 rounded-lg text-sm text-center bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 font-semibold transition">${esc(model.cta.label)}</a>
        </div>
      </div>`;
}

// ── controller (shared, byte-identical across every surface) ───────────────────────────────
// Mobile hamburger + desktop dropdowns (hover + click + keyboard) + mobile accordions + a11y
// (aria-expanded, Escape, click-outside) + client-side active-link highlight by URL. Null-safe
// IIFE — inert when the nav is absent (jsdom-testable).
const NAV_SCRIPT = `<script>
/* NAV-PLATFORM-GENERATOR-W1 controller (shared, identical across all surfaces) */
(function(){
  var mToggle = document.querySelector('[data-mobile-nav-toggle]');
  var mPanel = document.getElementById('mobile-menu');
  var navEl = mToggle ? mToggle.closest('nav') : document.querySelector('nav');
  function mIsOpen(){ return mPanel && !mPanel.classList.contains('hidden'); }
  function mSet(open){
    if(!mPanel||!mToggle) return;
    mPanel.classList.toggle('hidden', !open);
    mToggle.setAttribute('aria-expanded', open ? 'true':'false');
    mToggle.setAttribute('aria-label', open ? 'Close menu':'Open menu');
    var io=mToggle.querySelector('[data-mobile-nav-icon-open]'), ic=mToggle.querySelector('[data-mobile-nav-icon-close]');
    if(io) io.classList.toggle('hidden', open);
    if(ic) ic.classList.toggle('hidden', !open);
  }
  if(mToggle&&mPanel){
    mToggle.addEventListener('click', function(e){ e.stopPropagation(); mSet(!mIsOpen()); });
  }
  // desktop dropdowns
  var dropdowns = [].slice.call(document.querySelectorAll('[data-nav-dropdown]'));
  function ddClose(dd){
    var b=dd.querySelector('[data-nav-dropdown-toggle]'), p=dd.querySelector('[data-nav-dropdown-panel]');
    if(p) p.classList.add('hidden'); if(b) b.setAttribute('aria-expanded','false');
  }
  function ddSet(dd, open){
    var b=dd.querySelector('[data-nav-dropdown-toggle]'), p=dd.querySelector('[data-nav-dropdown-panel]');
    if(!b||!p) return;
    dropdowns.forEach(function(o){ if(o!==dd) ddClose(o); });
    p.classList.toggle('hidden', !open); b.setAttribute('aria-expanded', open?'true':'false');
  }
  dropdowns.forEach(function(dd){
    var b=dd.querySelector('[data-nav-dropdown-toggle]'), p=dd.querySelector('[data-nav-dropdown-panel]');
    if(!b||!p) return;
    b.addEventListener('click', function(e){ e.stopPropagation(); ddSet(dd, p.classList.contains('hidden')); });
    dd.addEventListener('mouseenter', function(){ ddSet(dd, true); });
    dd.addEventListener('mouseleave', function(){ ddClose(dd); });
    dd.addEventListener('focusout', function(e){ if(!dd.contains(e.relatedTarget)) ddClose(dd); });
  });
  // mobile accordions
  [].slice.call(document.querySelectorAll('[data-nav-accordion-toggle]')).forEach(function(b){
    var p=document.getElementById(b.getAttribute('aria-controls'));
    if(!p) return;
    b.addEventListener('click', function(){ var open=p.classList.contains('hidden'); p.classList.toggle('hidden', !open); b.setAttribute('aria-expanded', open?'true':'false'); });
  });
  // global close
  document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ dropdowns.forEach(ddClose); if(mIsOpen()) mSet(false); } });
  document.addEventListener('click', function(e){
    dropdowns.forEach(function(dd){ if(!dd.contains(e.target)) ddClose(dd); });
    if(mIsOpen() && navEl && !navEl.contains(e.target)) mSet(false);
  });
  if(mPanel) mPanel.addEventListener('click', function(e){ if(e.target.closest('a')) mSet(false); });
  // client-side current-page highlight (byte-identical HTML on every page; JS marks active)
  try {
    var here = location.origin + location.pathname.replace(/\\/$/, '');
    [].slice.call(document.querySelectorAll('nav [data-nav-link]')).forEach(function(a){
      var h = (a.getAttribute('href')||'').split('#')[0].replace(/\\/$/, '');
      if(h && h === here){ a.classList.remove('text-gray-400'); a.classList.add('text-mint-400','font-medium'); }
    });
  } catch(_){}
})();
</script>`;

/**
 * The canonical fixed-top site nav — brand + desktop bar (Platform mega-menu + Track Record
 * dropdown + links + Signup pill) + mobile hamburger + #mobile-menu accordion drawer +
 * controller. One arg-less call renders the complete, byte-identical unit for every surface.
 */
export function renderSiteNav(): string {
  const model = buildNavModel();
  return `<nav class="fixed top-0 w-full z-50 border-b border-white/5" style="background:rgba(6,10,20,0.85);backdrop-filter:blur(12px)">
  <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
    <a href="${model.brand.href}" class="flex items-center gap-2.5" aria-label="AlgoVault home">
      <img src="${model.brand.logo}" alt="AlgoVault Logo" class="w-7 h-7 rounded-md">
      <span class="text-white font-semibold text-sm">${esc(model.brand.label)}</span>
    </a>
    ${desktopBar(model)}
${MOBILE_BUTTON}
  </div>
      ${mobileDrawer(model)}
</nav>
${NAV_SCRIPT}`;
}
