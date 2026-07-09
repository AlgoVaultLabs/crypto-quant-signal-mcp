/**
 * H0-C4-MEASURE-CLOSE — operator scoreboard HTML shell for GET /dashboard/funnel.
 *
 * Server-rendered static shell ONLY (no data embedded server-side). The route
 * itself is cookie-gated exactly like /dashboard (anonymous → 401), so this HTML
 * is served only to an authenticated operator; it then fetches the scoreboard
 * JSON from the gated /dashboard/api/funnel-scoreboard via a same-origin XHR that
 * carries the admin session cookie. INTERNAL metrics — never public.
 *
 * NO backticks / ${} inside the embedded <script> — avoids template-literal
 * collision per CLAUDE.md (mirrors renderSubscribersAdminHtml). The JS renders
 * counts into pre-declared DOM nodes; it builds only simple tables via
 * document.createElement.
 */
export function renderFunnelDashboardHtml(): string {
  const css = [
    ':root{color-scheme:dark}*{box-sizing:border-box}',
    'body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f14;color:#e6edf3}',
    'header{display:flex;align-items:baseline;gap:12px;padding:16px 24px;border-bottom:1px solid #1c2430;background:#0e141b}',
    'h1{font-size:18px;margin:0}.sub{color:#7d8590;font-size:12px}',
    'header .spacer{margin-left:auto}',
    'header button{background:#1c2430;color:#e6edf3;border:1px solid #2d3748;border-radius:6px;padding:6px 12px;cursor:pointer}',
    'main{padding:20px 24px;max-width:1180px;margin:0 auto}',
    '.warn{background:#3a2a12;border:1px solid #6b4b1a;color:#f0c674;border-radius:8px;padding:10px 14px;margin:0 0 16px;font-size:12px;display:none}',
    '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}',
    '.card{background:#0e141b;border:1px solid #1c2430;border-radius:10px;padding:16px}',
    '.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#7d8590;margin:0 0 10px}',
    '.big{font-size:34px;font-weight:650;line-height:1}',
    '.big.sm{font-size:22px}',
    '.muted{color:#7d8590;font-size:12px}',
    '.row{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px dashed #1c2430}',
    '.row:last-child{border-bottom:0}',
    '.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid #2d3748;color:#9db4d0}',
    '.pill.live{border-color:#1f6f43;color:#4ade80}.pill.warnp{border-color:#6b4b1a;color:#f0c674}',
    '.funnel-collapse{display:flex;align-items:center;gap:8px;font-size:13px;flex-wrap:wrap}',
    '.funnel-collapse b{font-size:18px}.arrow{color:#7d8590}',
    'section.panel{margin-top:22px}section.panel h2{font-size:13px;color:#c9d4e0;border-bottom:1px solid #1c2430;padding-bottom:6px}',
    'table{border-collapse:collapse;width:100%;font-size:12px}',
    'th,td{text-align:right;padding:5px 10px;border-bottom:1px solid #161d26}th:first-child,td:first-child{text-align:left}',
    'th{color:#7d8590;font-weight:500;position:sticky;top:0;background:#0b0f14}',
    '.tblwrap{overflow-x:auto;max-height:340px;overflow-y:auto;border:1px solid #1c2430;border-radius:8px}',
    'footer{color:#57606a;font-size:11px;padding:16px 24px}',
    '.err{color:#f87171}',
  ].join('');

  // Embedded renderer. Single-quoted throughout; NO backticks / ${}.
  const js = [
    "var API='/dashboard/api/funnel-scoreboard';",
    "function pct(x){return x==null?'—':(x*100).toFixed(1)+'%';}",
    "function num(x){return x==null?'—':String(x);}",
    "function el(tag,txt,cls){var e=document.createElement(tag);if(txt!=null)e.textContent=txt;if(cls)e.className=cls;return e;}",
    "function setText(id,v){var n=document.getElementById(id);if(n)n.textContent=v;}",
    "function table(container,cols,rows){var wrap=document.createElement('div');wrap.className='tblwrap';var t=document.createElement('table');var thead=document.createElement('thead');var htr=document.createElement('tr');cols.forEach(function(c){htr.appendChild(el('th',c));});thead.appendChild(htr);t.appendChild(thead);var tb=document.createElement('tbody');rows.forEach(function(r){var tr=document.createElement('tr');r.forEach(function(c){tr.appendChild(el('td',c==null?'—':String(c)));});tb.appendChild(tr);});t.appendChild(tb);wrap.appendChild(t);container.innerHTML='';container.appendChild(wrap);}",
    "function render(d){",
    "  var ps=d.paying_subscribers;",
    "  setText('ps-total',num(ps.total));",
    "  setText('ps-tier','starter '+num(ps.by_tier.starter)+' · pro '+num(ps.by_tier.pro)+' · ent '+num(ps.by_tier.enterprise));",
    "  setText('ps-x402','x402 (separate rail): '+num(ps.x402_separate.payments_in_window)+' payments in window');",
    "  var srcp=document.getElementById('ps-src');srcp.textContent=ps.headline_source;srcp.className='pill '+((ps.headline_source==='stripe_live')?'live':'warnp');",
    "  var rec=ps.reconciliation;setText('ps-recon','Stripe '+num(rec.stripe_total)+' vs profiles '+num(rec.profiles_total)+(rec.instrumentation_artifact?'  ⚠ instrumentation_artifact':(rec.divergent?'  (divergent)':'  ✓ reconciled')));",
    "  var fs=d.free_signups;",
    "  setText('fs-reach',num(fs.reach_mcp_connect_all_time));",
    "  setText('fs-intent',num(fs.signup_intent.total_all_time));",
    "  setText('fs-acct',num(fs.free_accounts));",
    "  var ch=fs.signup_intent.by_channel;var chs=Object.keys(ch).map(function(k){return k+' '+ch[k];}).join(' · ');setText('fs-chan',chs||'—');",
    "  var cv=d.conversion;",
    "  setText('cv-acct',pct(cv.paid_over_free_accounts));",
    "  setText('cv-intent',pct(cv.paid_over_signup_intent));",
    "  setText('cv-unattr',pct(cv.unattributable_pct));",
    "  setText('cv-cohort','attributed '+num(cv.joinable_cohort.attributed_conversions)+' / '+num(cv.joinable_cohort.total_conversions)+' conversions');",
    "  var rt=d.retention;var ov=rt.overall;",
    "  setText('rt-d7',pct(ov.d7));setText('rt-d14',pct(ov.d14));setText('rt-d30',pct(ov.d30));",
    "  setText('rt-d90',ov.d90==null?('null \\u2014 matures '+(ov.d90_matures_on||'?')):pct(ov.d90));",
    "  setText('rt-cohort','overall n='+num(ov.cohort_size)+'  \\u00b7  free d7 '+pct(rt.by_tier.free.d7)+'  \\u00b7  paid d7 '+pct(rt.by_tier.paid.d7)+'  \\u00b7  internal excl '+num(rt.internal_excluded));",
    "  function d90c(c){return c.d90==null?'\\u2014':pct(c.d90);}",
    "  var rtd=[['\\ud83d\\udfe2 Free',pct(rt.by_tier.free.d7),pct(rt.by_tier.free.d14),pct(rt.by_tier.free.d30),d90c(rt.by_tier.free),num(rt.by_tier.free.cohort_size)],['\\ud83d\\udcb3 Paid',pct(rt.by_tier.paid.d7),pct(rt.by_tier.paid.d14),pct(rt.by_tier.paid.d30),d90c(rt.by_tier.paid),num(rt.by_tier.paid.cohort_size)]];",
    "  table(document.getElementById('rt-tier'),['Tier','d7','d14','d30','d90','sessions'],rtd);",
    "  var rtc=rt.by_channel.map(function(x){return [x.channel,pct(x.curve.d7),pct(x.curve.d14),pct(x.curve.d30),d90c(x.curve),num(x.curve.cohort_size)];});",
    "  table(document.getElementById('rt-channel'),['Channel (conn ?src=)','d7','d14','d30','d90','sessions'],rtc);",
    "  setText('rt-caveat',rt.coverage_caveat);",
    "  var ip=d.intent_panel;",
    "  setText('ip-upgrade',num(ip.upgrade_cta_clicked));setText('ip-landing',num(ip.landing_cta_clicked));",
    "  setText('ip-quota','soft '+num(ip.quota_hits.soft)+' · hard '+num(ip.quota_hits.hard)+' · block '+num(ip.quota_hits.block));",
    "  setText('ip-tagged','tagged '+num(ip.tagged_vs_direct.tagged)+' · direct '+num(ip.tagged_vs_direct.direct)+' ('+pct(ip.tagged_vs_direct.direct_pct)+' direct)');",
    "  setText('ip-idcov','identified '+num(ip.identity_coverage.identified)+' / cov '+pct(ip.identity_coverage.coverage_pct));",
    "  var ca=d.client_activity_24h;",
    "  var rawTop=num(ca.calls.raw_api)+(ca.calls.raw_api_top1_pct!=null?(' (top IP '+ca.calls.raw_api_top1_pct+'%)'):'');",
    "  var tgb=ca.calls.tg_bot_breakdown;var tgCalls=num(ca.calls.tg_bot)+' (W'+num(tgb.watch)+'\\u00b7SW'+num(tgb.scanwatch)+'\\u00b7S'+num(tgb.scan)+')';",
    "  var crows=[['Total',num(ca.calls.total),num(ca.sessions.total)],['\\ud83d\\udfe2 Recognized',num(ca.calls.recognized),num(ca.sessions.recognized)],['\\ud83d\\udd0c Raw API',rawTop,num(ca.sessions.raw_api)],['\\ud83d\\udcb3 Paid (x402/a2mcp)',num(ca.calls.paid),num(ca.sessions.paid)],['\\ud83d\\udd01 TG bot',tgCalls,num(ca.sessions.tg_bot_subscribers)+' subs']];",
    "  table(document.getElementById('client'),['Client type','Calls (24h)','Sessions (24h)'],crows);",
    "  setText('client-note',ca.note);",
    "  var wk=fs.signup_intent.weekly.map(function(w){var c=w.by_channel;var cs=Object.keys(c).map(function(k){return k+' '+c[k];}).join(', ');return [w.week,w.total,cs];});",
    "  table(document.getElementById('weekly'),['Week (Mon)','Signups','By channel'],wk);",
    "  var dr=(d.daily||[]).slice().reverse().map(function(x){return [x.date,x.signup_intent,x.conversions];});",
    "  table(document.getElementById('daily'),['Date','Signup intent','Conversions'],dr);",
    "  setText('ft-computed','computed '+d.computed_at+'  ·  snapshot '+num(d.data_freshness.snapshot_generated_at)+'  ·  stripe '+d.data_freshness.stripe_source);",
    "  var wb=document.getElementById('warnbox');if(d.warnings&&d.warnings.length){wb.style.display='block';wb.textContent='warnings: '+d.warnings.join('  |  ');}else{wb.style.display='none';}",
    "}",
    "function load(){var days=(document.getElementById('days')&&document.getElementById('days').value)||'90';setText('ft-computed','loading…');fetch(API+'?days='+encodeURIComponent(days),{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(render).catch(function(e){var wb=document.getElementById('warnbox');wb.style.display='block';wb.className='warn err';wb.textContent='Failed to load scoreboard: '+e.message;});}",
    "document.addEventListener('DOMContentLoaded',function(){document.getElementById('refresh').addEventListener('click',load);load();});",
  ].join('\n');

  const cardsHtml = [
    '<div class="cards">',
    '<div class="card"><h2>Paying subscribers <span id="ps-src" class="pill">…</span></h2>',
    '<div class="big" id="ps-total">—</div><div class="muted" id="ps-tier">—</div>',
    '<div class="muted" id="ps-x402" style="margin-top:8px">—</div>',
    '<div class="muted" id="ps-recon" style="margin-top:6px">—</div></div>',
    '<div class="card"><h2>Free signups — micro-funnel</h2>',
    '<div class="funnel-collapse"><span>Reach <b id="fs-reach">—</b></span><span class="arrow">→</span>',
    '<span>Subscribe clicks <b id="fs-intent">—</b></span><span class="arrow">→</span><span>Free signups <b id="fs-acct">—</b></span></div>',
    '<div class="muted" style="margin-top:8px">reach = mcp_connect connections (context) · subscribe-clicks = /signup CTA · free-signups = email → free key (the conversion denominator)</div>',
    '<div class="muted" id="fs-chan" style="margin-top:6px">—</div></div>',
    '<div class="card"><h2>Free → paid conversion</h2>',
    '<div class="row"><span>vs free signups</span><b id="cv-acct">—</b></div>',
    '<div class="row"><span>vs subscribe clicks</span><b id="cv-intent">—</b></div>',
    '<div class="row"><span>unattributable</span><b id="cv-unattr">—</b></div>',
    '<div class="muted" id="cv-cohort" style="margin-top:6px">—</div></div>',
    '<div class="card"><h2>Client retention (excl. bot)</h2>',
    '<div class="row"><span>d7</span><b id="rt-d7">—</b></div>',
    '<div class="row"><span>d14</span><b id="rt-d14">—</b></div>',
    '<div class="row"><span>d30</span><b id="rt-d30">—</b></div>',
    '<div class="row"><span>d90</span><b id="rt-d90">—</b></div>',
    '<div class="muted" id="rt-cohort" style="margin-top:6px">—</div></div>',
    '</div>',
  ].join('');

  const intentHtml = [
    '<section class="panel"><h2>Intent panel (leading indicators)</h2>',
    '<div class="cards">',
    '<div class="card"><h2>Upgrade CTA</h2><div class="big sm" id="ip-upgrade">—</div><div class="muted">landing CTA: <span id="ip-landing">—</span></div></div>',
    '<div class="card"><h2>Free callers crossing quota</h2><div class="muted" id="ip-quota" style="font-size:14px">—</div></div>',
    '<div class="card"><h2>Traffic split</h2><div class="muted" id="ip-tagged" style="font-size:14px">—</div><div class="muted" id="ip-idcov" style="margin-top:6px">—</div></div>',
    '</div></section>',
  ].join('');

  const retentionHtml = [
    '<section class="panel"><h2>Retention detail — by tier &amp; by channel (internal bot excluded)</h2>',
    '<div class="muted" style="margin:0 0 6px">By tier — free vs paid (the pooled headline is dominated by the bot; this is the real user signal)</div>',
    '<div id="rt-tier"></div>',
    '<div class="muted" style="margin:12px 0 6px">By channel — connection <code>?src=</code> acquisition source (the only channel that joins to session activity)</div>',
    '<div id="rt-channel"></div>',
    '<div class="muted" id="rt-caveat" style="margin-top:8px"></div></section>',
  ].join('');

  const clientHtml = [
    '<section class="panel"><h2>Client activity (24h) — matches the Telegram daily digest</h2>',
    '<div id="client"></div><div class="muted" id="client-note" style="margin-top:8px"></div></section>',
  ].join('');

  const tablesHtml = [
    '<section class="panel"><h2>Subscribe-CTA clicks — weekly by channel</h2><div id="weekly"></div></section>',
    '<section class="panel"><h2>Daily timeseries (signup intent + conversions)</h2><div id="daily"></div></section>',
  ].join('');

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    '<title>Activation Funnel Scoreboard — AlgoVault (internal)</title>',
    '<style>', css, '</style></head><body>',
    '<header><h1>Activation Funnel Scoreboard</h1>',
    '<span class="sub">internal · operator-only · MEASUREMENT-ONLY</span>',
    '<span class="spacer"></span>',
    '<label class="sub">window(d) <input id="days" value="90" style="width:56px;background:#0b0f14;color:#e6edf3;border:1px solid #2d3748;border-radius:5px;padding:3px 6px"></label>',
    '<button id="refresh">Refresh</button></header>',
    '<main><div id="warnbox" class="warn"></div>',
    cardsHtml, intentHtml, retentionHtml, clientHtml, tablesHtml,
    '</main><footer id="ft-computed">—</footer>',
    '<script>', js, '</script></body></html>',
  ].join('');
}
