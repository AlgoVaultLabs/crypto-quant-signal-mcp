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
import { PLANS, planCallsLabel, planPriceLabel } from './plans.js';

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
export function renderPlanCards(signupBase = ''): string {
  return `<div class="plans">
    <div class="plan">
      <h2>${PLANS.starter.label}</h2>
      <div class="price">${planPriceLabel('starter')}<span>/mo</span></div>
      <ul>
        <li>${planCallsLabel('starter')} calls/month</li>
        <li><span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> exchanges (HL, Binance, Bybit, OKX, Bitget)</li>
        <li>All assets (crypto + TradFi)</li>
        <li>All timeframes (1m to 1d)</li>
        <li>Email support</li>
      </ul>
      <a class="btn" href="${signupBase}/signup?plan=starter">Subscribe to Starter</a>
    </div>
    <div class="plan popular">
      <div class="pop-badge">MOST POPULAR</div>
      <h2>${PLANS.pro.label}</h2>
      <div class="price">${planPriceLabel('pro')}<span>/mo</span></div>
      <ul>
        <li>${planCallsLabel('pro')} calls/month</li>
        <li><span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> exchanges (HL, Binance, Bybit, OKX, Bitget)</li>
        <li>All assets (crypto + TradFi)</li>
        <li>All timeframes (1m to 1d)</li>
        <li>Priority support</li>
      </ul>
      <a class="btn" href="${signupBase}/signup?plan=pro">Subscribe to Pro</a>
    </div>
    <div class="plan">
      <h2>${PLANS.enterprise.label}</h2>
      <div class="price">${planPriceLabel('enterprise')}<span>/mo</span></div>
      <ul>
        <li>${planCallsLabel('enterprise')} calls/month</li>
        <li><span data-tr-field="exchange_count">${EXCHANGE_COUNT}</span> exchanges (HL, Binance, Bybit, OKX, Bitget)</li>
        <li>All assets &amp; timeframes</li>
        <li>SLA guarantee</li>
        <li>Dedicated support</li>
      </ul>
      <a class="btn ent" href="${signupBase}/signup?plan=enterprise">Subscribe to Enterprise</a>
    </div>
  </div>`;
}

/**
 * Plan-card CSS for surfaces that DON'T already carry it (the apex /join page uses
 * the minimal /referral shell, which has no .plans/.plan rules). getSignupPageHtml
 * keeps its OWN inline copy of these rules (byte-identity constraint — do not touch
 * it); keep these in sync if the card chrome ever changes. The CARD MARKUP is the
 * single-sourced part (renderPlanCards); this is presentational only.
 */
export const PLAN_CARDS_CSS = `
  .plans { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }
  @media (max-width: 768px) { .plans { grid-template-columns: 1fr; } }
  .plan { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; position: relative; }
  .plan.popular { border-color: #34D199; }
  .plan h2 { font-size: 20px; margin-bottom: 4px; }
  .plan .price { font-size: 36px; font-weight: 700; color: #58a6ff; margin: 12px 0; }
  .plan .price span { font-size: 16px; font-weight: 400; color: #8b949e; }
  .plan ul { list-style: none; margin: 16px 0 24px; padding: 0; }
  .plan ul li { padding: 4px 0; color: #c9d1d9; font-size: 14px; }
  .plan ul li::before { content: '\\2713'; color: #3fb950; margin-right: 8px; }
  .btn { display: inline-block; background: #238636; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 16px; font-weight: 600; transition: background 0.15s; }
  .btn:hover { background: #2ea043; }
  .btn.ent { background: #8957e5; }
  .pop-badge { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: #34D199; color: #0f1117; font-size: 11px; font-weight: 700; padding: 3px 12px; border-radius: 20px; letter-spacing: 0.5px; }`;
