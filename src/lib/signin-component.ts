/**
 * FUNNEL-FIX-AUTH-UNIFY-W1 — the ONE shared sign-in component.
 *
 * Root-cause fix for four front doors across three pages: `/signup` (email +
 * OAuth), `/account` (paste key first), `/referral` (email only). This is the
 * single sign-in card reused identically on /welcome, /account and /referral so
 * a future auth method is added once and appears everywhere, and the referral
 * loop becomes reachable by one-tap (Google/GitHub), not email-only.
 *
 * Two identity models, made consistent: HUMAN LOGIN (Google/GitHub/email) is the
 * primary; the API KEY (agent / existing user) is a clearly-labeled secondary
 * ("I have an API key →" + "Recover lost key"). Each page renders its OWN
 * post-auth context; this component renders only the sign-in card.
 *
 * REUSE, don't rebuild — the buttons drive the ALREADY-shipped routes:
 *   - Google/GitHub → GET /auth/:provider  (FUNNEL-FIX-HUMAN-SIGNUP-W1 + OPS-OAUTH-APPS-WIRE-W1;
 *     the callback already issues/returns the key AND renders the referral link).
 *   - email         → POST /api/signup-email (mint/MERGE key + email it; idempotent per email).
 *   - start-free    → POST /api/start-free   (INSTANT ephemeral key, NO email — distinct path).
 *   - paste / recover → link to /account (the working forms live there; not re-implemented).
 *
 * OAuth + start-free render ONLY when the inner `newSignupEnabled` firewall is on
 * (those routes 404 otherwise). The OUTER firewall `UNIFIED_SIGNIN_ENABLED` gates
 * whether a page renders THIS component at all (legacy layout byte-identical when off).
 *
 * The `entitlement` path (`resolveLicense`/`resolveFromApiKeyAsync`) is NOT touched.
 */

export type SigninPage = 'welcome' | 'account' | 'referral';

export interface SigninComponentOptions {
  /** Which page is hosting the card — sets the default post-auth redirect + copy. */
  page: SigninPage;
  /** Per-provider LIVE flag — a button renders ONLY when its real creds exist. */
  oauthProviders?: { google: boolean; github: boolean };
  /** Inner firewall (NEW_SIGNUP_ENABLED) — start-free + OAuth need it; off ⇒ email + paste only. */
  newSignupEnabled?: boolean;
  /** Post-auth redirect target for the OAuth `next` param (default `/${page}`). */
  next?: string;
  /** First-touch `?src` to preserve through the sign-in + OAuth redirect (attribution). */
  src?: string | null;
  /** Optional heading / subhead override (defaults are per-page). */
  heading?: string;
  subhead?: string;
}

/** Internal-only redirect target: must be a same-origin absolute path (leading `/`, no `//`). */
function safeNext(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  // strip anything outside a conservative path charset; cap length
  const cleaned = raw.replace(/[^a-zA-Z0-9/_?=&.\-]/g, '').slice(0, 128);
  return cleaned.startsWith('/') && !cleaned.startsWith('//') ? cleaned : fallback;
}

/** UTM/src-ish token → URL-injection-free chars, length-capped. Empty for non-strings. */
function sanitizeToken(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9_:.\-]/g, '').slice(0, 64);
}

const DEFAULT_COPY: Record<SigninPage, { heading: string; subhead: string }> = {
  welcome: { heading: 'Continue to AlgoVault', subhead: 'One click. No password. Get a key in seconds.' },
  account: { heading: 'Sign in to your account', subhead: 'Google, GitHub, or email — or paste your API key below.' },
  referral: { heading: 'Get your referral link', subhead: 'Sign in to grab your link — you and your friend both win.' },
};

/**
 * Render the shared sign-in card. Pure + self-contained (scoped `.avsi-*` CSS +
 * one namespaced IIFE) so any page can drop it in without CSS/JS collisions.
 */
export function renderSigninComponent(opts: SigninComponentOptions): string {
  const page = opts.page;
  const copy = DEFAULT_COPY[page];
  const heading = typeof opts.heading === 'string' ? opts.heading : copy.heading;
  const subhead = typeof opts.subhead === 'string' ? opts.subhead : copy.subhead;
  const next = safeNext(opts.next, `/${page}`);
  const src = sanitizeToken(opts.src);
  const newSignup = opts.newSignupEnabled === true;
  const providers = opts.oauthProviders ?? { google: false, github: false };

  // Attribution: preserve ?src through both the OAuth redirect (query) and the
  // AJAX start-free/email calls. `next` routes the OAuth callback context.
  const srcQ = src ? `&src=${encodeURIComponent(src)}` : '';
  const authHref = (id: 'google' | 'github') =>
    `/auth/${id}?next=${encodeURIComponent(next)}${srcQ}`;

  const oauthButtons = newSignup
    ? [
        providers.google ? `<a class="avsi-btn avsi-google" href="${authHref('google')}">Continue with Google</a>` : '',
        providers.github ? `<a class="avsi-btn avsi-github" href="${authHref('github')}">Continue with GitHub</a>` : '',
      ].join('')
    : '';

  // "Continue with email" — the existing /api/signup-email path (mint/MERGE key +
  // email it). A returning email returns its EXISTING key (idempotent). If the
  // visitor used "Get started free" first, the ephemeral key is merged in.
  const emailForm = `
    <form class="avsi-email-form" novalidate>
      <div class="avsi-email-row">
        <input type="email" class="avsi-email-input" name="email" placeholder="you@example.com" autocomplete="email" aria-label="Email address" required>
        <button type="submit" class="avsi-btn avsi-email">Continue with email</button>
      </div>
      <label class="avsi-consent"><input type="checkbox" class="avsi-consent-box"> <span>Also email me product updates (~1/mo, optional).</span></label>
      <div class="avsi-email-msg" aria-live="polite"></div>
    </form>`;

  // "Get started free — no card" — the INSTANT ephemeral path (NO identity, NO
  // email). Labeled distinct from "Continue with email" per the Q2 clarity rider.
  const startFree = newSignup
    ? `
    <button type="button" class="avsi-btn avsi-startfree" data-src="${src}">⚡ Get started free — no card, no email · instant key</button>
    <div class="avsi-startfree-result" style="display:none"></div>`
    : '';

  const srcAttr = src ? ` data-src="${src}"` : '';

  return `
<div class="avsi-card"${srcAttr}>
  <style>
    .avsi-card{background:#0f141a;border:1px solid #21262d;border-radius:14px;padding:22px;max-width:380px;margin:0 auto;text-align:left;color:#c9d1d9;font-size:14px;line-height:1.5}
    .avsi-card *{box-sizing:border-box}
    .avsi-eyebrow{font-size:10px;letter-spacing:.6px;color:#2dd4bf;text-transform:uppercase}
    .avsi-h{font-size:20px;font-weight:600;color:#f0f6fc;margin:4px 0 2px}
    .avsi-sub{font-size:12.5px;color:#8b949e;margin-bottom:16px}
    .avsi-btn{display:block;width:100%;border-radius:9px;padding:11px;font-size:13.5px;font-weight:600;text-align:center;margin-bottom:9px;border:1px solid #30363d;cursor:pointer;text-decoration:none;background:#161b22;color:#c9d1d9}
    .avsi-btn:hover{border-color:#3fb950}
    .avsi-google{background:#f6f8fa;color:#1f2328;border-color:#f6f8fa}
    .avsi-github{background:#21262d;color:#f0f6fc;border-color:#30363d}
    .avsi-email-form{margin:0}
    .avsi-email-row{display:flex;gap:8px;margin-bottom:8px}
    .avsi-email-input{flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:9px;padding:11px;font-size:13.5px}
    .avsi-email-input:focus{outline:none;border-color:#2dd4bf}
    .avsi-email .avsi-email-row>.avsi-email{width:auto}
    .avsi-email-form .avsi-email{width:auto;margin:0;white-space:nowrap;background:#161b22}
    .avsi-consent{display:flex;align-items:center;gap:6px;color:#8b949e;font-size:11px;margin-bottom:2px;cursor:pointer}
    .avsi-consent input{margin:0}
    .avsi-email-msg{color:#f85149;font-size:12px;min-height:15px;margin-top:2px}
    .avsi-email-msg.ok{color:#56d364}
    .avsi-divider{display:flex;align-items:center;gap:10px;color:#6e7681;font-size:11px;margin:14px 0}
    .avsi-divider::before,.avsi-divider::after{content:"";flex:1;height:1px;background:#21262d}
    .avsi-keyrow{background:#0d1117;border:1px dashed #30363d;border-radius:9px;padding:10px 12px;font-size:12px;color:#8b949e;margin-bottom:10px}
    .avsi-keyrow a{color:#2dd4bf;text-decoration:none;font-weight:600}
    .avsi-startfree{background:#2dd4bf;color:#062a24;border:0;font-weight:700;margin-top:2px}
    .avsi-startfree:hover{background:#4fe3d0}
    .avsi-startfree-result{margin-top:10px;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px;font-size:12.5px}
    .avsi-startfree-result pre{user-select:all;background:#0b0f14;border:1px solid #30363d;border-radius:6px;padding:8px;overflow:auto;margin:6px 0;font-size:12px;color:#3fb950}
    .avsi-recover{display:inline-block;color:#8b949e;font-size:11.5px;margin-top:4px;text-decoration:none}
    .avsi-recover:hover{color:#58a6ff}
  </style>
  <div class="avsi-eyebrow">· sign in</div>
  <div class="avsi-h">${heading}</div>
  <div class="avsi-sub">${subhead}</div>
  ${oauthButtons}
  ${emailForm}
  ${startFree}
  <div class="avsi-divider">or</div>
  <div class="avsi-keyrow">Already have an API key? <a href="/account">Paste it →</a></div>
  <a class="avsi-recover" href="/account">Recover a lost key</a>
  <script>
  (function(){
    var card=document.currentScript&&document.currentScript.closest?document.currentScript.closest('.avsi-card'):document.querySelector('.avsi-card');
    if(!card)return;
    var src=card.getAttribute('data-src')||'';
    // Continue with email → /api/signup-email (mint/merge key + email it).
    var f=card.querySelector('.avsi-email-form');
    if(f){var msg=f.querySelector('.avsi-email-msg');var btn=f.querySelector('button[type="submit"]');
      f.addEventListener('submit',function(e){e.preventDefault();msg.className='avsi-email-msg';msg.textContent='';
        var email=(f.querySelector('.avsi-email-input').value||'').trim();
        if(!email||email.length>254||email.indexOf('@')<1||email.lastIndexOf('.')<email.indexOf('@')){msg.textContent='Please enter a valid email.';return;}
        btn.disabled=true;btn.textContent='Sending…';
        var body={email:email,source:'signin-${page}',optin_consent:!!f.querySelector('.avsi-consent-box').checked};
        if(window.__avsiEphemeralKey)body.ephemeral_key=window.__avsiEphemeralKey;
        if(src)body.src=src;
        fetch('/api/signup-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
          .then(function(r){return r.json().catch(function(){return{ok:false,error:'parse_error'};});})
          .then(function(d){if(d&&d.ok===true){msg.className='avsi-email-msg ok';msg.textContent='✓ Check your email — we sent your API key + referral link.';btn.textContent='Sent ✓';}
            else{var c=(d&&d.error)||'send_failed';msg.textContent=c==='invalid_email'?'Please enter a valid email.':c==='disposable_email'?'Please use a non-disposable email.':'Could not send — try again or email admin@algovault.com.';btn.disabled=false;btn.textContent='Continue with email';}})
          .catch(function(){msg.textContent='Network error. Try again.';btn.disabled=false;btn.textContent='Continue with email';});
      });}
    // Get started free → /api/start-free (instant ephemeral key, no email).
    var sf=card.querySelector('.avsi-startfree');
    if(sf){var res=card.querySelector('.avsi-startfree-result');
      sf.addEventListener('click',function(){sf.disabled=true;sf.textContent='Getting your key…';
        var q=src?('?src='+encodeURIComponent(src)):'';
        fetch('/api/start-free'+q,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
          .then(function(r){return r.json();}).then(function(d){res.style.display='block';
            if(!d.ok){res.textContent='Could not start — use email above.';sf.disabled=false;sf.textContent='⚡ Get started free — no card, no email · instant key';return;}
            window.__avsiEphemeralKey=d.key;
            var sig=d.signal?('BTC 1h: '+(d.signal.verdict||d.signal.call||'—')+(d.signal.confidence!=null?(' · confidence '+d.signal.confidence):'')):'signal warming up';
            res.innerHTML='<div style="color:#56d364;font-weight:600">'+sig+'</div><div style="margin-top:6px">Your free API key (100/mo, no card):</div><pre>'+d.key+'</pre><div style="color:#8b949e">Add an email above anytime to keep it + earn referrals.</div>';
            sf.style.display='none';})
          .catch(function(){res.style.display='block';res.textContent='Network error — use email above.';sf.disabled=false;sf.textContent='⚡ Get started free — no card, no email · instant key';});
      });}
  })();
  </script>
</div>`;
}
