/**
 * REFERRAL-LIGHT-W1 / C4 — referral surface renderers (PURE; HTML-string only,
 * no DB/Stripe/HTTP). Every program number interpolates from REFERRAL_TERMS via
 * the constants renderers (a chapter gate greps this file for hardcoded program-
 * number literals). Reused by /account/referrals, /referral-terms, the admin
 * surfaces, and the future TG-REFERRAL-W1 + landing /referral consumers.
 */
import { maskEmail } from './email.js';
import {
  REFERRAL_TERMS,
  commissionPct,
  commissionMonthsLabel,
  bonusCallsLabel,
  usdcMinPayoutLabel,
  shareLink,
  formatUsdE2,
} from './referral-constants.js';

const FTC_URL = 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255';
const TERMS_PATH = '/referral-terms';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

// Minimal self-contained dark shell (mint accent) — matches the AlgoVault brand
// without depending on the account-page chrome, so this stays a pure renderer.
// `opts` is an optional TRAILING param so every existing caller (terms/stats/admin)
// stays byte-identical (default = noindex, no description). Only the public, indexable
// /referral landing page opts into index + a meta description (LANDING-REFERRAL-PAGE-W1).
function shell(title: string, body: string, opts?: { index?: boolean; description?: string }): string {
  const robots = opts?.index
    ? '<meta name="robots" content="index,follow">'
    : '<meta name="robots" content="noindex">';
  const desc = opts?.description ? `\n<meta name="description" content="${esc(opts.description)}">` : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${robots}${desc}
<title>${esc(title)}</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--fg-3:#8b949e;--mint:#3fb950}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.5}
  .wrap{max-width:720px;margin:0 auto;padding:40px 20px}
  h1{font-size:26px;margin:0 0 6px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:1px;color:var(--fg-3);margin:28px 0 12px}
  .sub{color:var(--fg-3);margin:0 0 24px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 16px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .code{font-size:22px;font-weight:700;color:var(--mint)}
  .link{word-break:break-all;color:var(--mint);text-decoration:none}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
  .stat .n{font-size:22px;font-weight:700}
  .stat .l{font-size:12px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.5px}
  a{color:var(--mint)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
  th{color:var(--fg-3);text-transform:uppercase;font-size:11px;letter-spacing:.5px}
  .muted{color:var(--fg-3);font-size:13px}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

export interface ReferralStatsView {
  code: string;
  baseUrl?: string;
  clicks: number;
  signups: number;
  conversions: number;
  bonusRemaining: number;
  accruedUsdE2: number;
  creditedUsdE2: number;
  usdcPendingUsdE2: number;
  usdcPaidUsdE2: number;
}

/** /account/referrals — a referrer's own stats. All program numbers interpolated. */
export function renderReferralStatsPage(v: ReferralStatsView): string {
  const link = shareLink(v.code, v.baseUrl);
  const body = `
    <h1>Your referral dashboard</h1>
    <p class="sub">Refer, earn ${commissionPct()}. Friends get ${bonusCallsLabel()} bonus calls; you earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()}.</p>
    <div class="card">
      <div class="l muted">YOUR CODE</div>
      <div class="code mono">${esc(v.code)}</div>
      <div style="margin-top:10px" class="l muted">SHARE LINK</div>
      <a class="link mono" href="${esc(link)}">${esc(link)}</a>
    </div>
    <h2>Activity</h2>
    <div class="grid">
      <div class="stat"><div class="n">${v.clicks}</div><div class="l">Clicks</div></div>
      <div class="stat"><div class="n">${v.signups}</div><div class="l">Signups</div></div>
      <div class="stat"><div class="n">${v.conversions}</div><div class="l">Conversions</div></div>
      <div class="stat"><div class="n">${v.bonusRemaining}</div><div class="l">Your bonus calls left</div></div>
    </div>
    <h2>Commission</h2>
    <div class="grid">
      <div class="stat"><div class="n">${formatUsdE2(v.accruedUsdE2)}</div><div class="l">Accrued</div></div>
      <div class="stat"><div class="n">${formatUsdE2(v.creditedUsdE2)}</div><div class="l">Credited</div></div>
      <div class="stat"><div class="n">${formatUsdE2(v.usdcPendingUsdE2)}</div><div class="l">USDC pending</div></div>
      <div class="stat"><div class="n">${formatUsdE2(v.usdcPaidUsdE2)}</div><div class="l">USDC paid</div></div>
    </div>
    <p class="muted" style="margin-top:16px">Commission is credited automatically to your next AlgoVault invoice once you have an active subscription. Otherwise it accrues and is payable in USDC on Base at ≥ ${usdcMinPayoutLabel()} (manual review). Read the <a href="${TERMS_PATH}">referral terms</a>.</p>
  `;
  return shell('AlgoVault — Referral dashboard', body);
}

/** GET /referral-terms — the program terms + the FTC disclosure clause. */
export function renderReferralTermsPage(): string {
  const body = `
    <h1>AlgoVault referral program terms</h1>
    <p class="sub">Effective terms for the AlgoVault Labs referral program.</p>
    <div class="card">
      <h2 style="margin-top:0">The program</h2>
      <p>Share your referral link. When someone signs up through it:</p>
      <ul>
        <li><strong>They</strong> receive <strong>${bonusCallsLabel()} bonus calls</strong> on top of the monthly free allowance.</li>
        <li><strong>You</strong> earn <strong>${commissionPct()}</strong> of their paid AlgoVault subscription revenue for <strong>${commissionMonthsLabel()}</strong> from their first invoice.</li>
      </ul>
      <h2>Payout</h2>
      <p>Commission is applied automatically as a credit toward your next AlgoVault invoice if you have an active subscription. Otherwise it accrues and is payable in USDC on Base once your balance reaches <strong>${usdcMinPayoutLabel()}</strong>, subject to manual review.</p>
      <h2>Eligibility &amp; one grant per person</h2>
      <p>Each person may be referred once (the bonus is granted a single time per email). Codes are for genuine referrals of distinct people.</p>
      <h2>Self-referral prohibited</h2>
      <p>You may not refer yourself. Attribution and bonuses are refused when the referred email or account matches the code owner.</p>
      <h2>Refund clawback</h2>
      <p>If a referred customer's payment is refunded, the corresponding commission is reversed (clawed back) — from your invoice credit or your pending USDC balance.</p>
      <h2 style="color:var(--mint)">Required disclosure (FTC)</h2>
      <p><strong>If you promote your referral link, you must clearly and conspicuously disclose that you earn a commission</strong> when someone subscribes through it. This is required by the U.S. Federal Trade Commission's Endorsement Guides (<a href="${FTC_URL}">16 CFR Part 255</a>).</p>
      <h2>Modifications</h2>
      <p>AlgoVault Labs may modify or end the program, or adjust these terms, at any time. Material changes apply prospectively.</p>
      <h2>Not financial advice</h2>
      <p>AlgoVault signals and this program are informational only and are not financial advice. Past performance does not guarantee future results.</p>
    </div>
    <p class="muted">Questions? <a href="mailto:support@algovault.com">support@algovault.com</a></p>
  `;
  return shell('AlgoVault — Referral terms', body);
}

/**
 * GET /referral — the public, indexable referral explainer + share destination.
 * The canonical landing surface every other referral channel (the TG bot, the
 * future in-product nudge, the welcome email) points to. Incentive-first; hands
 * the visitor the path to their link (NO join form — anonymous visitors route to
 * /account, which mints/exposes the code). Every program number interpolates from
 * the SoT label fns (zero hardcoded literals — the chapter grep gate enforces it).
 * PFE-only; no outcome_*. Indexable (a discovery surface, unlike the noindex terms
 * page). LANDING-REFERRAL-PAGE-W1.
 *
 * LINK ORIGINS (this page is served on the APEX algovault.com/referral via the Caddy
 * reverse_proxy, so a relative href resolves to the APEX): /account is api-canonical
 * (NOT on the apex — Stripe success_url is built from the request host) → ABSOLUTE
 * https://api.algovault.com/account; /referral-terms IS proxied onto the apex (Caddy
 * `handle /referral-terms`) → relative is fine; start-free → absolute apex #quickstart.
 */
export function renderReferralLandingPage(): string {
  const body = `
    <h1>Refer a friend — both win.</h1>
    <p class="sub">Your friend gets ${bonusCallsLabel()} bonus calls. You earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()} — paid automatically.</p>
    <div class="card" style="text-align:center;padding:24px 20px">
      <a class="link" style="display:inline-block;font-weight:700;font-size:16px;color:var(--bg);background:var(--mint);padding:12px 24px;border-radius:10px;text-decoration:none" href="https://api.algovault.com/account">Get your referral link &rarr;</a>
      <p class="muted" style="margin:14px 0 0">Every account has one automatically — paste your key on <a href="https://api.algovault.com/account">your account</a> to grab your link and stats.</p>
    </div>

    <h2>How it works</h2>
    <div class="card">
      <ol style="margin:0;padding-left:20px;line-height:1.9">
        <li><strong>Grab your link.</strong> Every account gets one automatically — find it in your account.</li>
        <li><strong>Share it.</strong> Your friend gets ${bonusCallsLabel()} bonus calls the moment they join.</li>
        <li><strong>Earn.</strong> Get ${commissionPct()} of their subscription every month for ${commissionMonthsLabel()} — auto-credited.</li>
      </ol>
    </div>

    <h2>FAQ</h2>
    <div class="card">
      <p><strong>Who can refer?</strong> Every account — your referral code is generated automatically, no sign-up step.</p>
      <p><strong>What counts?</strong> A friend who signs up or subscribes through your link.</p>
      <p><strong>How am I paid?</strong> Commission is credited automatically to your next AlgoVault invoice. No active subscription? It accrues and is payable in USDC on Base once your balance reaches ${usdcMinPayoutLabel()}.</p>
      <p style="margin-bottom:0"><strong>Full terms?</strong> Read the <a href="/referral-terms">referral terms</a> — including the required FTC disclosure when you promote your link.</p>
    </div>

    <p class="muted">Already using AlgoVault? Your link is in your <a href="https://api.algovault.com/account">account</a>. New here? <a href="https://algovault.com/#quickstart">Start free</a>, then share.</p>
  `;
  return shell('AlgoVault — Refer a friend, both win', body, {
    index: true,
    description: `Refer a friend to AlgoVault and you both win: they get ${bonusCallsLabel()} bonus calls, you earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()}, paid automatically.`,
  });
}

export interface AdminOverviewView {
  topReferrers: Array<{ code: string; signups: number; conversions: number; accruedUsdE2: number }>;
  recentLedger: Array<{ id: number; code: string; commissionUsdE2: number; status: string; createdAt: string }>;
  codeCount: number;
}

/** GET /admin/referrals — operator overview (admin-key-gated upstream). */
export function renderAdminReferralsPage(v: AdminOverviewView): string {
  const top = v.topReferrers.length
    ? v.topReferrers.map((r) => `<tr><td class="mono">${esc(r.code)}</td><td>${r.signups}</td><td>${r.conversions}</td><td>${formatUsdE2(r.accruedUsdE2)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="muted">No referrers yet.</td></tr>`;
  const led = v.recentLedger.length
    ? v.recentLedger.map((r) => `<tr><td>${r.id}</td><td class="mono">${esc(r.code)}</td><td>${formatUsdE2(r.commissionUsdE2)}</td><td><span class="pill">${esc(r.status)}</span></td><td class="muted">${esc(r.createdAt)}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted">No ledger entries yet.</td></tr>`;
  const body = `
    <h1>Referrals — admin</h1>
    <p class="sub">${v.codeCount} code(s) · program: ${commissionPct()} / ${commissionMonthsLabel()} / ${bonusCallsLabel()} bonus / ${usdcMinPayoutLabel()} min payout. <a href="/admin/referrals/payouts">USDC payout queue →</a></p>
    <h2>Top referrers</h2>
    <div class="card"><table><thead><tr><th>Code</th><th>Signups</th><th>Conversions</th><th>Accrued</th></tr></thead><tbody>${top}</tbody></table></div>
    <h2>Recent ledger</h2>
    <div class="card"><table><thead><tr><th>ID</th><th>Code</th><th>Commission</th><th>Status</th><th>Created</th></tr></thead><tbody>${led}</tbody></table></div>
  `;
  return shell('AlgoVault — Referrals admin', body);
}

export interface AdminPayoutsView {
  pending: Array<{ code: string; ownerEmail: string | null; pendingUsdE2: number; rowCount: number; ledgerIds: number[] }>;
}

/** GET /admin/referrals/payouts — USDC-pending queue ≥ the min payout. */
export function renderAdminPayoutsPage(v: AdminPayoutsView): string {
  const rows = v.pending.length
    ? v.pending.map((p) => `<tr>
        <td class="mono">${esc(p.code)}</td>
        <td>${p.ownerEmail ? esc(maskEmail(p.ownerEmail)) : '<span class="muted">—</span>'}</td>
        <td>${formatUsdE2(p.pendingUsdE2)}</td>
        <td>${p.rowCount}</td>
        <td class="mono muted">${p.ledgerIds.join(', ')}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="muted">No payouts pending ≥ ${esc(usdcMinPayoutLabel())}.</td></tr>`;
  const body = `
    <h1>USDC payout queue</h1>
    <p class="sub">Referrers with ≥ ${usdcMinPayoutLabel()} pending (no active subscription to auto-credit). Mark a ledger row paid via <span class="mono">POST /admin/referrals/payouts/:id/paid</span> with <span class="mono">{tx_ref}</span>.</p>
    <div class="card"><table><thead><tr><th>Code</th><th>Owner</th><th>Pending</th><th>Rows</th><th>Ledger IDs</th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
  return shell('AlgoVault — USDC payouts', body);
}

/** The min-payout threshold in e2-cents (for the route's gate). */
export const USDC_MIN_PAYOUT_E2 = REFERRAL_TERMS.USDC_MIN_PAYOUT_USD * 100;
