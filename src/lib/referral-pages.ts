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
  payoutScheduleLabel,
  shareLink,
  formatUsdE2,
} from './referral-constants.js';
import { renderPlanCards, PLAN_CARDS_CSS } from './signup-flow.js';

const FTC_URL = 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-255';
const TERMS_PATH = '/referral-terms';
// REFERRAL-WEB-FIX-W1: /signup is api-canonical (Stripe success_url from request host;
// NOT apex-proxied), so the apex /join plan cards must link to it ABSOLUTELY.
const SIGNUP_BASE = 'https://api.algovault.com';
// REFERRAL-WEB-FIX-W1 (C2): friend-facing share text (mirrors the TG bot's framing); the
// caller's link is appended client-side. Bonus number from the SoT (never hardcoded).
function shareTextPrefix(): string {
  return `I'm using AlgoVault for verifiable crypto trade signals — composite BUY/SELL/HOLD across the top perp venues, on-chain track record. Grab ${bonusCallsLabel()} bonus calls free with my link: `;
}

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
  // REFERRAL-PAYOUT-OPS-W1 / C1 — payout-address management (optional, trailing, so
  // every existing test/caller that omits them stays valid; the card renders with
  // empty state when apiKey is absent).
  apiKey?: string;
  payoutAddress?: string | null;
  savedFlash?: boolean;
  addressError?: string | null;
}

// REFERRAL-WEB-FIX-W1 (C2) — copy/native-share for the /account stats link (graceful
// desktop fallback: execCommand copy + hide Share when navigator.share absent).
const STATS_SHARE_JS = `
(function(){
  var box=document.getElementById("av-stats-share"); if(!box) return;
  var link=box.getAttribute("data-link")||"", text=(box.getAttribute("data-sharetext-prefix")||"")+link;
  var copyBtn=document.getElementById("av-stats-copy"), shareBtn=document.getElementById("av-stats-share-btn");
  if(copyBtn){ copyBtn.onclick=function(){ var ok=function(){copyBtn.textContent="Copied!";setTimeout(function(){copyBtn.textContent="Copy link";},1500);}; if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(ok).catch(function(){copyBtn.textContent="Copy failed";});} else {var t=document.createElement("textarea");t.value=text;document.body.appendChild(t);t.select();try{document.execCommand("copy");ok();}catch(e){}document.body.removeChild(t);} }; }
  if(shareBtn){ if(navigator.share){ shareBtn.onclick=function(){navigator.share({text:text}).catch(function(){});}; } else { shareBtn.style.display="none"; } }
})();
`;

/** /account/referrals — a referrer's own stats. All program numbers interpolated. */
export function renderReferralStatsPage(v: ReferralStatsView): string {
  const link = shareLink(v.code, v.baseUrl);

  // REFERRAL-PAYOUT-OPS-W1 / C1 — payout-address card. All program numbers via SoT.
  const eligible = v.usdcPendingUsdE2 >= REFERRAL_TERMS.USDC_MIN_PAYOUT_USD * 100;
  const hasAddr = !!(v.payoutAddress && v.payoutAddress.length);
  const payoutFlash = v.savedFlash
    ? `<p style="color:var(--mint);font-weight:600;margin:0 0 10px">&#10003; Payout address saved.</p>`
    : v.addressError
      ? `<p style="color:#f85149;font-weight:600;margin:0 0 10px">${esc(v.addressError)}</p>`
      : '';
  const payoutHint = eligible && hasAddr
    ? `<p style="color:var(--mint);margin:0 0 10px">&#10003; You've reached ${usdcMinPayoutLabel()} and your address is set — you're in the next payout batch.</p>`
    : eligible
      ? `<p style="color:#d29922;margin:0 0 10px">&#9888; You've reached ${usdcMinPayoutLabel()} pending — add your Base USDC address below to receive your payout.</p>`
      : `<p class="muted" style="margin:0 0 10px">Add your Base USDC address now so you're ready when your pending balance reaches ${usdcMinPayoutLabel()}.</p>`;
  const inputStyle = 'width:100%;background:#0d1117;border:1px solid var(--line);border-radius:8px;padding:11px 13px;color:var(--fg);font-family:ui-monospace,Menlo,monospace;font-size:13px;box-sizing:border-box';
  const addressForm = v.apiKey
    ? `<form method="post" action="/account/referrals/payout-address" style="margin-top:14px">
        <input type="hidden" name="api_key" value="${esc(v.apiKey)}">
        <div class="l muted" style="margin-bottom:6px">BASE USDC PAYOUT ADDRESS</div>
        <input type="text" name="payout_address" value="${esc(v.payoutAddress ?? '')}" placeholder="0x…" autocomplete="off" spellcheck="false" style="${inputStyle}">
        <label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0;font-size:13px;color:var(--fg-3);cursor:pointer">
          <input type="checkbox" name="confirm" value="1" style="margin-top:2px">
          <span>I confirm this is my correct Base USDC address. Sends are <strong>irreversible</strong> — a wrong address means lost funds.</span>
        </label>
        <button type="submit" style="font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px;border:1px solid var(--mint);background:var(--mint);color:var(--bg);cursor:pointer">Save payout address</button>
      </form>`
    : `<p class="muted" style="margin-top:10px">Paste your API key on <a href="/account">/account</a> → Referrals to set your payout address.</p>`;

  const body = `
    <h1>Your referral dashboard</h1>
    <p class="sub">Refer, earn ${commissionPct()}. Friends get ${bonusCallsLabel()} one-time bonus calls (on top of their 100/mo free); you earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()}.</p>
    <div class="card">
      <div class="l muted">YOUR CODE</div>
      <div class="code mono">${esc(v.code)}</div>
      <div style="margin-top:10px" class="l muted">SHARE LINK</div>
      <a class="link mono" href="${esc(link)}">${esc(link)}</a>
      <div id="av-stats-share" data-link="${esc(link)}" data-sharetext-prefix="${esc(shareTextPrefix())}" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button type="button" id="av-stats-copy" style="font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid var(--mint);background:transparent;color:var(--mint);cursor:pointer">Copy link</button>
        <button type="button" id="av-stats-share-btn" style="font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid var(--mint);background:var(--mint);color:var(--bg);cursor:pointer">Share &rarr;</button>
      </div>
    </div>
    <script>${STATS_SHARE_JS}</script>
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
    <h2>Payout</h2>
    <div class="card">
      <p style="margin:0 0 12px">Next payout at <strong>${usdcMinPayoutLabel()}</strong> — paid in <strong>USDC on Base</strong> ${payoutScheduleLabel()}. Active subscribers are auto-credited to their next AlgoVault invoice at any amount instead.</p>
      ${payoutFlash}
      ${payoutHint}
      ${addressForm}
    </div>
    <p class="muted" style="margin-top:16px">Read the <a href="${TERMS_PATH}">referral terms</a> for the full payout policy — schedule, refund clawback, and tax responsibility.</p>
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
        <li><strong>They</strong> receive a one-time grant of <strong>${bonusCallsLabel()} bonus calls</strong> on top of the monthly free allowance.</li>
        <li><strong>You</strong> earn <strong>${commissionPct()}</strong> of their paid AlgoVault subscription revenue for <strong>${commissionMonthsLabel()}</strong> from their first invoice.</li>
      </ul>
      <h2>Payout</h2>
      <p>Commission of <strong>${usdcMinPayoutLabel()}</strong> or more is paid in <strong>USDC on Base</strong> to the address you provide on your <a href="/account">account</a>, <strong>${payoutScheduleLabel()}</strong> — the delay covers the refund-clawback window. Active subscribers are auto-credited to their next AlgoVault invoice at any amount instead.</p>
      <h2>Taxes</h2>
      <p>You are responsible for your own taxes. For cumulative payouts approaching U.S. 1099 reporting thresholds (around $600 per year to one U.S. person), AlgoVault Labs may request a W-9 or W-8 form before further payout.</p>
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

// REFERRAL-FREE-KEY-SIGNUP-W1 — client JS for the free-account form. Plain string
// (NO backticks / ${} inside — template-literal-collision-safe). POSTs same-origin
// to /api/signup-email (the apex proxies it), renders the link inline, fail-soft.
const REFERRAL_SIGNUP_FORM_JS = `
(function(){
  var f=document.getElementById("av-ref-form"); if(!f) return;
  var out=document.getElementById("av-ref-result"), btn=document.getElementById("av-ref-submit");
  var origBtn=btn.textContent;
  function errMsg(c){
    if(c==="disposable_email") return "Please use a non-disposable email address.";
    if(c==="no_mx") return "That email domain cannot receive mail - please check it.";
    if(c==="invalid_email") return "Please enter a valid email address.";
    return "Something went wrong - please try again.";
  }
  function fail(m){ out.innerHTML=""; var p=document.createElement("p"); p.className="muted"; p.style.color="#f85149"; p.textContent=m; out.appendChild(p); }
  function shareRow(link){
    var prefix=f.getAttribute("data-sharetext-prefix")||"";
    var text=prefix+link;
    var row=document.createElement("div"); row.style.cssText="display:flex;gap:8px;margin:12px 0 0;flex-wrap:wrap";
    var bcss="font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid var(--mint);background:transparent;color:var(--mint);cursor:pointer";
    var copyBtn=document.createElement("button"); copyBtn.type="button"; copyBtn.textContent="Copy link"; copyBtn.style.cssText=bcss;
    copyBtn.onclick=function(){ var ok=function(){copyBtn.textContent="Copied!";setTimeout(function(){copyBtn.textContent="Copy link";},1500);}; if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(ok).catch(function(){copyBtn.textContent="Copy failed";}); } else { var t=document.createElement("textarea"); t.value=text; document.body.appendChild(t); t.select(); try{document.execCommand("copy");ok();}catch(e){} document.body.removeChild(t); } };
    row.appendChild(copyBtn);
    if(navigator.share){ var shareBtn=document.createElement("button"); shareBtn.type="button"; shareBtn.textContent="Share \\u2192"; shareBtn.style.cssText=bcss+";background:var(--mint);color:var(--bg)"; shareBtn.onclick=function(){ navigator.share({text:text}).catch(function(){}); }; row.appendChild(shareBtn); }
    return row;
  }
  function success(data){
    f.style.display="none"; out.innerHTML="";
    if(data.bonus_calls){ var b=document.createElement("p"); b.style.cssText="color:var(--mint);font-weight:700;margin:0 0 10px;font-size:15px"; b.textContent="\\u2713 "+data.bonus_calls+" one-time bonus calls added (on top of your 100/mo free)!"; out.appendChild(b); }
    var lbl=document.createElement("div"); lbl.className="l muted"; lbl.style.cssText="font-size:12px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.5px"; lbl.textContent="Your referral link"; out.appendChild(lbl);
    var a=document.createElement("a"); a.className="link mono"; a.href=data.referral_link; a.textContent=data.referral_link; a.style.cssText="display:block;margin:6px 0 0"; out.appendChild(a);
    out.appendChild(shareRow(data.referral_link));
    var p=document.createElement("p"); p.className="muted"; p.style.margin="12px 0 0"; p.textContent="We emailed your free API key for next time."; out.appendChild(p);
  }
  f.addEventListener("submit",function(e){
    e.preventDefault();
    var email=(document.getElementById("av-ref-email").value||"").trim();
    var consent=document.getElementById("av-ref-consent").checked;
    var src=f.getAttribute("data-source")||"referral-page";
    var ref=f.getAttribute("data-ref")||"";
    var body={email:email,optin_consent:consent,source:src};
    if(ref){ body.ref=ref; }
    btn.disabled=true; btn.textContent="Creating..."; out.textContent="";
    fetch("/api/signup-email",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
      .then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
      .then(function(res){
        btn.disabled=false; btn.textContent=origBtn;
        if(res.s===200 && res.j && res.j.referral_link){ success(res.j); }
        else { fail(errMsg((res.j&&res.j.error)||"error")); }
      })
      .catch(function(){ btn.disabled=false; btn.textContent=origBtn; fail("Something went wrong - please try again."); });
  });
})();
`;

/**
 * REFERRAL-FREE-KEY-SIGNUP-W1 — the reusable free-account email form (D1/D2): enter
 * email → mint an av_free_ key → render the referral link INLINE (+ key emailed).
 * Pure HTML + a self-contained inline script; reused by /referral now, /account /
 * /register later. The form POSTs same-origin to /api/signup-email (apex-proxied).
 * Program facts from the SoT label fns. `inputId` salt keeps multiple instances
 * unique if ever embedded twice on one page.
 */
export function renderReferralSignupForm(opts?: { ref?: string; source?: string; heading?: string; cta?: string }): string {
  // heading/cta are trusted copy (may carry intentional HTML entities like &rarr;) → raw.
  // ref/source go into data-attrs → esc (defensive; the values are already known-safe).
  const heading = opts?.heading ?? 'Get your referral link — free, no card.';
  const cta = opts?.cta ?? 'Create my link &rarr;';
  const dataSource = ` data-source="${esc(opts?.source ?? 'referral-page')}"`;
  const dataRef = opts?.ref ? ` data-ref="${esc(opts.ref)}"` : '';
  return `
    <div class="card">
      <h2 style="margin-top:0;text-transform:none;letter-spacing:0;font-size:20px;color:var(--fg)">${heading}</h2>
      <form id="av-ref-form"${dataSource}${dataRef} data-sharetext-prefix="${esc(shareTextPrefix())}" style="margin:0">
        <input type="email" id="av-ref-email" required autocomplete="email" placeholder="you@example.com"
          style="width:100%;box-sizing:border-box;padding:11px 13px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:15px;margin:0 0 10px">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg-3);margin:0 0 14px">
          <input type="checkbox" id="av-ref-consent"> Email me product updates
        </label>
        <button type="submit" id="av-ref-submit"
          style="width:100%;font-weight:700;font-size:16px;color:var(--bg);background:var(--mint);border:none;padding:12px 24px;border-radius:10px;cursor:pointer">${cta}</button>
      </form>
      <div id="av-ref-result" style="margin-top:14px"></div>
      <p class="muted" style="margin:14px 0 0">Already have an account? <a href="https://api.algovault.com/account">Paste your key &rarr;</a></p>
    </div>
    <script>${REFERRAL_SIGNUP_FORM_JS}</script>`;
}

/**
 * GET /referral — the public, indexable referral explainer + share destination, with
 * the free-account email form as the primary entry (REFERRAL-FREE-KEY-SIGNUP-W1: anyone
 * gets a link, no card). The canonical landing surface every other referral channel
 * (the TG bot, the in-product nudge, the welcome email) points to. Every program number
 * interpolates from the SoT label fns (zero hardcoded literals — grep-gated). PFE-only;
 * no outcome_*. Indexable (a discovery surface, unlike the noindex terms page).
 *
 * LINK ORIGINS (served on the APEX via Caddy reverse_proxy, so a relative href resolves
 * to the APEX): /account is api-canonical (Stripe success_url from request host) → ABSOLUTE
 * https://api.algovault.com/account; /referral-terms IS apex-proxied → relative OK;
 * start-free → absolute apex #quickstart; the form POSTs same-origin /api/signup-email
 * (apex-proxied this wave).
 */
export function renderReferralLandingPage(): string {
  const body = `
    <h1>Refer a friend — both win.</h1>
    <p class="sub">Your friend gets ${bonusCallsLabel()} one-time bonus calls. You earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()} — paid automatically.</p>
    ${renderReferralSignupForm()}

    <h2>How it works</h2>
    <div class="card">
      <ol style="margin:0;padding-left:20px;line-height:1.9">
        <li><strong>Grab your link.</strong> Every account gets one automatically — find it in your account.</li>
        <li><strong>Share it.</strong> Your friend gets ${bonusCallsLabel()} one-time bonus calls (on top of the free 100/mo) the moment they join.</li>
        <li><strong>Earn.</strong> Get ${commissionPct()} of their subscription every month for ${commissionMonthsLabel()} — auto-credited.</li>
      </ol>
    </div>

    <h2>FAQ</h2>
    <div class="card">
      <p><strong>Who can refer?</strong> Anyone — paid or free. No key yet? Create a free account above (just an email, no card) and your link is generated automatically.</p>
      <p><strong>What counts?</strong> A friend who signs up or subscribes through your link.</p>
      <p><strong>How am I paid?</strong> Commission is credited automatically to your next AlgoVault invoice. No active subscription? It accrues and is payable in USDC on Base once your balance reaches ${usdcMinPayoutLabel()}.</p>
      <p style="margin-bottom:0"><strong>Full terms?</strong> Read the <a href="/referral-terms">referral terms</a> — including the required FTC disclosure when you promote your link.</p>
    </div>

    <p class="muted">Just want to use AlgoVault? No signup needed — <a href="https://algovault.com/#quickstart">start free in 30s</a>.</p>
  `;
  return shell('AlgoVault — Refer a friend, both win', body, {
    index: true,
    description: `Refer a friend to AlgoVault and you both win: they get ${bonusCallsLabel()} bonus calls, you earn ${commissionPct()} of their subscription for ${commissionMonthsLabel()}, paid automatically.`,
  });
}

/**
 * GET /join?ref=CODE — REFERRAL-WEB-FIX-W1 — the branded apex referee landing every
 * web share link points to (the friend's first impression). A valid ref → a give-get
 * hero + a "start free" form that carries the ref → /api/signup-email?ref= →
 * processFreeReferralSignup actually grants the one-time bonus (fixes the #1 bug: the
 * old /signup?ref= 400'd a free friend). Invalid/missing ref → a graceful general
 * start-free (NO bonus claim). Paid plans below (renderPlanCards, absolute-api links).
 * noindex (per-ref transactional landing; the indexable referral SEO surface is /referral).
 */
export function renderJoinPage(opts: { refValid: boolean; code?: string }): string {
  if (opts.refValid && opts.code) {
    const body = `
    <style>${PLAN_CARDS_CSS}</style>
    <h1>A friend gave you ${bonusCallsLabel()} bonus calls.</h1>
    <p class="sub">Start free, no card — you'll get ${bonusCallsLabel()} one-time bonus calls on top of the 100 free calls every account gets.</p>
    ${renderReferralSignupForm({ ref: opts.code, source: 'join-page', heading: 'Start free — no card', cta: `Claim my ${bonusCallsLabel()} calls — start free &rarr;` })}
    <h2>Or pick a plan</h2>
    ${renderPlanCards(SIGNUP_BASE)}
  `;
    return shell('AlgoVault — Claim your bonus calls', body);
  }
  const body = `
    <style>${PLAN_CARDS_CSS}</style>
    <h1>Start free with AlgoVault.</h1>
    <p class="sub">100 calls a month, no card. Composite BUY/SELL/HOLD trade calls across the top perp venues, every call Merkle-anchored on Base.</p>
    ${renderReferralSignupForm({ source: 'join-page', heading: 'Create your free account', cta: 'Create my free account &rarr;' })}
    <h2>Or pick a plan</h2>
    ${renderPlanCards(SIGNUP_BASE)}
  `;
  return shell('AlgoVault — Start free', body);
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
  pending: Array<{ code: string; ownerEmail: string | null; payoutAddress: string | null; pendingUsdE2: number; rowCount: number; ledgerIds: number[] }>;
  // REFERRAL-PAYOUT-OPS-W1 / C2 — batch total + the Approve-all form key + a post-run flash.
  batchTotalUsdE2?: number;
  adminKey?: string;
  result?: {
    senderKind: string;
    paidCount: number;
    totalPaidUsdE2: number;
    skippedNoAddress: string[];
    failed: Array<{ code: string; reason: string }>;
  };
}

/** GET /admin/referrals/payouts — USDC-pending queue ≥ the min payout + Approve-all. */
export function renderAdminPayoutsPage(v: AdminPayoutsView): string {
  const total = v.batchTotalUsdE2 ?? v.pending.reduce((s, p) => s + p.pendingUsdE2, 0);
  const shortAddr = (a: string) => (a.length >= 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  const rows = v.pending.length
    ? v.pending.map((p) => `<tr>
        <td class="mono">${esc(p.code)}</td>
        <td>${p.ownerEmail ? esc(maskEmail(p.ownerEmail)) : '<span class="muted">—</span>'}</td>
        <td>${p.payoutAddress ? `<span class="mono">${esc(shortAddr(p.payoutAddress))}</span>` : '<span class="pill" style="color:#d29922">no address</span>'}</td>
        <td>${formatUsdE2(p.pendingUsdE2)}</td>
        <td>${p.rowCount}</td>
        <td class="mono muted">${p.ledgerIds.join(', ')}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="muted">No payouts pending ≥ ${esc(usdcMinPayoutLabel())}.</td></tr>`;

  let resultBlock = '';
  if (v.result) {
    const r = v.result;
    const stub = r.senderKind === 'stub';
    const headline = stub
      ? '⚠ CDP wallet not configured — no USDC sent.'
      : `✓ Sent ${r.paidCount} payout(s) — ${formatUsdE2(r.totalPaidUsdE2)} total.`;
    const stubNote = stub ? '<p class="muted" style="margin:8px 0 0">Set <span class="mono">CDP_WALLET_SECRET</span> + fund the payout wallet, then Approve all again — or mark rows paid manually below.</p>' : '';
    const skipped = r.skippedNoAddress.length ? `<p class="muted" style="margin:8px 0 0">Skipped (no address): ${esc(r.skippedNoAddress.join(', '))}</p>` : '';
    const failed = r.failed.length ? `<p style="margin:8px 0 0;color:#f85149">Failed: ${esc(r.failed.map((f) => `${f.code} (${f.reason})`).join(', '))}</p>` : '';
    resultBlock = `<div class="card" style="border-color:${stub ? '#d29922' : 'var(--mint)'}"><strong>${headline}</strong>${stubNote}${skipped}${failed}</div>`;
  }

  const approveAll = (v.pending.length && v.adminKey)
    ? `<form method="post" action="/admin/referrals/payouts/approve-all?key=${encodeURIComponent(v.adminKey)}" onsubmit="return confirm('Send USDC on Base to all ${v.pending.length} referrer(s) with an address (${formatUsdE2(total)} total)? This is irreversible.')" style="margin:16px 0">
        <button type="submit" style="font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px;border:1px solid var(--mint);background:var(--mint);color:var(--bg);cursor:pointer">Approve all &amp; send (${formatUsdE2(total)}) &rarr;</button>
      </form>`
    : '';

  const body = `
    <h1>USDC payout queue</h1>
    <p class="sub">Referrers with ≥ ${usdcMinPayoutLabel()} pending (no active subscription to auto-credit). Batch total: <strong>${formatUsdE2(total)}</strong>. <strong>Approve all</strong> sends USDC on Base to each address (${payoutScheduleLabel()}); rows without an address are skipped until the referrer adds one. Manual fallback: <span class="mono">POST /admin/referrals/payouts/:id/paid</span> with <span class="mono">{tx_ref}</span>.</p>
    ${resultBlock}
    ${approveAll}
    <div class="card"><table><thead><tr><th>Code</th><th>Owner</th><th>Address</th><th>Pending</th><th>Rows</th><th>Ledger IDs</th></tr></thead><tbody>${rows}</tbody></table></div>
  `;
  return shell('AlgoVault — USDC payouts', body);
}

/** The min-payout threshold in e2-cents (for the route's gate). */
export const USDC_MIN_PAYOUT_E2 = REFERRAL_TERMS.USDC_MIN_PAYOUT_USD * 100;
