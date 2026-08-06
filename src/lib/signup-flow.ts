/**
 * Single-source signup-flow copy for the "What happens after you subscribe"
 * 4-step block rendered in TWO surfaces:
 *   - getSignupPageHtml() in src/index.ts (dark inline-CSS theme)
 *   - landing/docs.html #pricing section (Tailwind theme; injected at build
 *     time by scripts/build_landing.mjs between BUILD:signup-flow markers)
 *
 * The data array SIGNUP_FLOW_STEPS is the single source of truth.
 * Both renderSignupFlowDark() and renderSignupFlowTailwind() read from it,
 * so copy drift between surfaces is impossible.
 */
import { EXCHANGE_COUNT } from './capabilities.js';
import {
  PLANS,
  planCallsLabel,
  planPriceLabel,
  planAnnualPriceLabel,
  planAnnualMonthlyEquivalent,
  planAnnualSavingsPct,
  planHasAnnual,
  type PaidPlanId,
} from './plans.js';

// CONTACT-PAGE-APEX-AND-INQUIRY-TYPE-W1: `ENTERPRISE_CONTACT_EMAIL` retired. The cards now link
// to the /contact FORM, not a mailbox, because Cloudflare rewrites every mailto: into
// /cdn-cgi/l/email-protection# and even decoded it needs an OS mail handler. The address still
// exists as the contact page's own secondary fallback — ONE owner, `contact-page.ts`
// CONTACT_FALLBACK_EMAIL — rather than two constants that can drift apart.

export interface SignupFlowStep {
  title: string;
  body: string; // may include limited inline HTML (<code>, <strong>) — render functions handle escaping context-appropriately
}

export const SIGNUP_FLOW_STEPS: readonly SignupFlowStep[] = [
  {
    title: 'Click "Subscribe to [Plan]"',
    body: 'on /signup. We redirect you to Stripe Checkout (we never see your card).',
  },
  {
    title: 'Pay on Stripe',
    body: 'Stripe sends you a receipt email. Behind the scenes, our webhook generates a unique API key for your subscription tier.',
  },
  {
    title: 'Land on the Welcome page',
    body: 'Your API key is shown in green — copy it. We also email it to your billing address (check spam, sender: <code>noreply@algovault.com</code>).',
  },
  {
    title: 'Make your first call',
    body: '<code>curl -H "Authorization: Bearer av_live_…" https://api.algovault.com/mcp …</code> or paste the key into your Claude Desktop / Cursor / Claude Code MCP config. Need to find your key later? Visit <code>/account</code>.',
  },
];

/** Dark-theme render for getSignupPageHtml() (inline CSS, matches existing #0f1117 palette). */
export function renderSignupFlowDark(): string {
  const items = SIGNUP_FLOW_STEPS.map((step, i) => `
    <li style="margin-bottom:14px;padding-left:8px">
      <strong style="color:#58a6ff">${step.title}</strong>
      <span style="color:#c9d1d9"> — ${step.body.replace(/<code>/g, '<code style="background:#0d1117;border:1px solid #21262d;border-radius:4px;padding:1px 6px;font-size:12px;color:#3fb950">')}</span>
    </li>`).join('');
  return `<section style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px 28px;margin:0 0 28px">
  <h2 style="font-size:14px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px">What happens after you subscribe</h2>
  <ol style="list-style:decimal;padding-left:24px;margin:0;font-size:14px;line-height:1.5;color:#e1e4e8">${items}
  </ol>
</section>`;
}

/** Tailwind-theme render for landing/docs.html #pricing section (uses bg-navy-700 + utility classes already in use). */
export function renderSignupFlowTailwind(): string {
  const items = SIGNUP_FLOW_STEPS.map((step) => `
        <li class="text-gray-300 text-sm leading-relaxed">
          <span class="font-semibold text-white">${step.title}</span>
          <span class="text-gray-400"> — ${step.body.replace(/<code>/g, '<code class="text-xs bg-navy-700/60 border border-white/5 rounded px-1.5 py-0.5 text-emerald-400">')}</span>
        </li>`).join('');
  return `      <div class="bg-navy-700 border border-white/5 rounded-xl p-5 mb-8">
        <ol class="list-decimal pl-5 space-y-2.5">${items}
        </ol>
      </div>`;
}

/**
 * REFERRAL-WEB-FIX-W1 — the 3 paid plan cards, SINGLE-SOURCE for getSignupPageHtml()
 * (api /signup) and the apex /join referee page. `signupBase` defaults to '' →
 * RELATIVE `/signup?plan=…` links (byte-IDENTICAL to the prior inline block on the
 * api-served /signup); /join passes 'https://api.algovault.com' because /signup is
 * api-canonical / NOT apex-proxied. First line starts at col 0 (the caller's
 * `  ${renderPlanCards()}` supplies the 2-space indent — same pattern as
 * renderSignupFlowDark), so the rendered bytes are unchanged.
 */
// OPS-QUOTA-EXHAUSTION-NOTICE-W1 (2026-08-02): the three prices + three call counts now
// interpolate from the ONE plan SoT (`plans.ts`) instead of being hand-typed literals. The
// rendered BYTES are unchanged (the SoT holds exactly these values), which the existing
// signup/join page tests assert — the point is that a price move is now a one-line edit in
// one file rather than a hunt across HTML, `getMonthlyQuota` and the quota-exhaustion copy.
// PRICING-ANNUAL-AND-HOLD-PROMISE-W1: annual-first pricing.
//
// The ANNUAL price leads on Starter and Pro (architect decision, Mr.1 2026-08-05) because the
// first-payment size is the acquisition constraint this wave exists to move. Three rules govern
// how it renders, and all three are Public-copy LAW rather than taste:
//
//   1. The annual TOTAL is always shown next to the effective monthly rate. Leading with
//      "$6.58/mo" for something that bills $79 once a year is the misleading framing.
//   2. The monthly option stays visible and one click away — never buried, never a dark pattern.
//   3. No countdown, no "limited time", no fake scarcity. The saving is a computed fact.
//
// Enterprise carries no self-serve price at all: its CTA is replaced by ONE contact line beneath
// the tier row (R4), so the card keeps its feature list without implying a checkout that does not
// exist. `ENTERPRISE_PRICE_ID` stays live and unarchived in Stripe — zero subscribers today, but
// an in-flight subscription must never break.

/** The price block for a plan sold annually: annual total, effective monthly, saving, monthly alt. */
function annualPriceBlock(id: PaidPlanId): string {
  return `<div class="price">${planAnnualPriceLabel(id)}<span>/yr</span></div>
      <div class="price-sub">${planAnnualMonthlyEquivalent(id)}/mo effective <span class="save">Save ${planAnnualSavingsPct(id)}%</span></div>
      <div class="price-alt">or ${planPriceLabel(id)}/mo billed monthly</div>`;
}

/** Both CTAs for a plan sold annually — annual primary, monthly a plain secondary link. */
function planCtas(id: PaidPlanId, signupBase: string): string {
  const label = PLANS[id].label;
  return `<a class="btn" href="${signupBase}/signup?plan=${id}&amp;interval=year">Subscribe to ${label} — annual</a>
      <a class="btn-alt" href="${signupBase}/signup?plan=${id}">or pay ${planPriceLabel(id)}/mo</a>`;
}

export function renderPlanCards(signupBase = ''): string {
  // Guard the invariant the markup below assumes, rather than silently rendering "null/yr" if a
  // future edit drops an annual price from the SoT.
  const annualBacked = planHasAnnual('starter') && planHasAnnual('pro');
  const starterPrice = annualBacked ? annualPriceBlock('starter') : `<div class="price">${planPriceLabel('starter')}<span>/mo</span></div>`;
  const proPrice = annualBacked ? annualPriceBlock('pro') : `<div class="price">${planPriceLabel('pro')}<span>/mo</span></div>`;
  const starterCta = annualBacked ? planCtas('starter', signupBase) : `<a class="btn" href="${signupBase}/signup?plan=starter">Subscribe to Starter</a>`;
  const proCta = annualBacked ? planCtas('pro', signupBase) : `<a class="btn" href="${signupBase}/signup?plan=pro">Subscribe to Pro</a>`;

  return `<div class="plans">
    <div class="plan">
      <h2>${PLANS.starter.label}</h2>
      ${starterPrice}
      <ul>
        <li>${planCallsLabel('starter')} calls/month</li>
        <li><span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> exchanges</li>
        <li>All assets (crypto + TradFi)</li>
        <li>All timeframes (1m to 1d)</li>
      </ul>
      ${starterCta}
    </div>
    <div class="plan popular">
      <div class="pop-badge">MOST POPULAR</div>
      <h2>${PLANS.pro.label}</h2>
      ${proPrice}
      <ul>
        <li>${planCallsLabel('pro')} calls/month</li>
        <li><span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> exchanges</li>
        <li>All assets (crypto + TradFi)</li>
        <li>All timeframes (1m to 1d)</li>
      </ul>
      ${proCta}
    </div>
  </div>
  <div class="plans-contact">Need ${PLANS.enterprise.label}? <a href="/contact">Contact us</a> for pricing.</div>`;
}

/**
 * Plan-card CSS — the ONE copy.
 *
 * PRICING-ANNUAL-AND-HOLD-PROMISE-W1: this used to carry the warning "getSignupPageHtml keeps its
 * OWN inline copy of these rules (byte-identity constraint — do not touch it); keep these in sync
 * if the card chrome ever changes". This wave IS that change, and a rule that says "remember to
 * edit the other copy too" is the defect, not the mitigation — so `getSignupPageHtml` now
 * interpolates this constant instead of restating it. The byte-identity constraint it protected is
 * deliberately retired here: the cards are supposed to look different now.
 *
 * The CARD MARKUP was already single-sourced (renderPlanCards); this is presentational only.
 */
export const PLAN_CARDS_CSS = `
  /* PRICING-MONTHLY-PATH-AND-CARD-CLEANUP-W1: 3 -> 2 columns. Enterprise is contact-us and no
     longer renders a card, here or on the landing page; the contact line below the row carries it. */
  .plans { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 768px) { .plans { grid-template-columns: 1fr; } }
  .plan { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; position: relative; display: flex; flex-direction: column; }
  .plan.popular { border-color: #34D199; }
  .plan h2 { font-size: 20px; margin-bottom: 4px; }
  .plan .price { font-size: 36px; font-weight: 700; color: #58a6ff; margin: 12px 0 2px; }
  .plan .price span { font-size: 16px; font-weight: 400; color: #8b949e; }
  .plan .price-sub { font-size: 14px; color: #c9d1d9; margin-bottom: 2px; }
  .plan .price-sub .save { display: inline-block; background: rgba(52,209,153,0.15); color: #34D199; border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: 600; margin-left: 4px; }
  .plan .price-alt { font-size: 13px; color: #8b949e; margin-bottom: 4px; }
  .plan ul { list-style: none; margin: 16px 0 24px; padding: 0; }
  .plan ul li { padding: 4px 0; color: #c9d1d9; font-size: 14px; }
  .plan ul li::before { content: '\\2713'; color: #3fb950; margin-right: 8px; }
  .plan .btn { margin-top: auto; }
  .btn { display: inline-block; background: #238636; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 16px; font-weight: 600; transition: background 0.15s; text-align: center; }
  .btn:hover { background: #2ea043; }
  .btn-alt { display: inline-block; margin-top: 10px; color: #8b949e; text-decoration: none; font-size: 13px; text-align: center; border-bottom: 1px solid #30363d; padding-bottom: 1px; align-self: center; }
  .btn-alt:hover { color: #c9d1d9; }
  .plans-contact { margin-top: 20px; text-align: center; color: #8b949e; font-size: 14px; }
  .plans-contact a { color: #58a6ff; text-decoration: none; }
  .plans-contact a:hover { text-decoration: underline; }
  .pop-badge { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: #34D199; color: #0f1117; font-size: 11px; font-weight: 700; padding: 3px 12px; border-radius: 20px; letter-spacing: 0.5px; }`;
