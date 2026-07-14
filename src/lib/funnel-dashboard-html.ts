/**
 * FUNNEL-SCOREBOARD-V2 — operator dual-funnel dashboard shell for GET /dashboard/funnel.
 *
 * Server-rendered static shell ONLY (no data embedded). Cookie-gated exactly like
 * /dashboard (route enforces auth); this HTML fetches the scoreboard JSON from the
 * gated /dashboard/api/funnel-scoreboard?window=<w> via a same-origin XHR carrying
 * the admin cookie. INTERNAL metrics — never public.
 *
 * Two side-by-side funnels (human web→Stripe · agent MCP→x402) with step-% + drop +
 * RAG benchmark bands + auto biggest-leak; a HOLD-monetization upside panel
 * (external calls only); the bridge note; channel breakdown inside each; cross-cutting
 * flags; a 7D/30D/90D/180D/365D/All timeframe filter; and the retained detail panels
 * (retention by tier/channel, client-activity 24h, daily timeseries).
 *
 * NO backticks / ${} inside the embedded <script> — avoids template-literal collision
 * per CLAUDE.md. All render logic is string concatenation.
 */
export function renderFunnelDashboardHtml(): string {
  const css = [
    ':root{color-scheme:dark}*{margin:0;padding:0;box-sizing:border-box}',
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:22px;max-width:1200px;margin:0 auto;font-size:14px}",
    'h1{font-size:20px;font-weight:600;color:#f0f6fc}',
    '.sub{font-size:12.5px;color:#8b949e;margin-top:3px;line-height:1.5}',
    '.topbar{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:14px;margin-bottom:14px}',
    '.tf{display:flex;gap:6px;flex-wrap:wrap}',
    '.tf button{background:#161b22;border:1px solid #30363d;color:#8b949e;border-radius:8px;padding:6px 13px;font-size:13px;font-weight:500;cursor:pointer}',
    '.tf button:hover{border-color:#58a6ff;color:#c9d1d9}',
    '.tf button.on{background:#1f6feb;border-color:#1f6feb;color:#fff}',
    '.tf-label{font-size:11px;color:#6e7681;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}',
    '.g{color:#56d364}.a{color:#d29922}.r{color:#ff7b72}.b{color:#58a6ff}.o{color:#EF9F27}',
    '.warnbox{background:#3a2a12;border:1px solid #6b4b1a;color:#f0c674;border-radius:8px;padding:9px 13px;font-size:12px;margin-bottom:14px;display:none}',
    '.splitnote{background:#0e1a2d;border:1px solid #1f4d80;border-left:4px solid #58a6ff;border-radius:0 8px 8px 0;padding:9px 14px;font-size:12px;line-height:1.5;margin-bottom:16px}',
    '.splitnote b{color:#58a6ff}',
    '.duo{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
    '.fcard{background:#0f141a;border:1px solid #21262d;border-radius:12px;padding:16px 18px}',
    '.fhead{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #21262d;padding-bottom:10px;margin-bottom:12px}',
    '.fhead .ft{font-size:15px;font-weight:600;color:#f0f6fc}.fhead .fp{font-size:11px;color:#8b949e;margin-top:2px}',
    '.money{font-size:10.5px;font-weight:600;padding:3px 9px;border-radius:9px}',
    '.money-stripe{background:#132a1e;color:#56d364;border:1px solid #1b5e3a}',
    '.money-x402{background:#3d2b06;color:#EF9F27;border:1px solid #5e4914}',
    '.proxyband{background:#12161c;border:1px dashed #30363d;border-radius:7px;padding:7px 11px;font-size:11px;color:#8b949e;margin-bottom:10px}',
    '.proxyband b{color:#c9d1d9}.proxyband .hint{color:#6e7681}',
    '.stage{margin:0 auto;border-radius:6px;padding:9px 13px;display:flex;justify-content:space-between;align-items:center;border:1px solid}',
    '.stage .snm{font-size:12px;font-weight:600;color:#f0f6fc}',
    '.stage .sst{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.3px}',
    '.stage .scount{font-size:19px;font-weight:700}',
    '.conn{text-align:center;font-size:11.5px;color:#8b949e;padding:4px 0}.conn .rate{font-weight:700;font-size:13px}',
    '.pill{display:inline-block;font-size:9.5px;font-weight:600;padding:1px 7px;border-radius:8px;letter-spacing:.3px;margin-left:5px}',
    '.pill-r{background:#3d1618;color:#ff7b72;border:1px solid #8b2828}.pill-g{background:#0d2d1a;color:#56d364;border:1px solid #1b5e3a}',
    '.leakline{margin-top:12px;background:#1c0f11;border:1px solid #8b2828;border-radius:7px;padding:9px 12px;font-size:11.5px;line-height:1.5}.leakline b{color:#ff7b72}',
    '.fixline{margin-top:8px;background:#111a12;border:1px solid #1b5e3a;border-radius:7px;padding:9px 12px;font-size:11.5px;line-height:1.5}.fixline b{color:#56d364}',
    '.chsec{margin-top:13px;border-top:1px dashed #21262d;padding-top:11px}',
    '.chlab{font-size:10px;color:#6e7681;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}',
    '.chan{display:flex;align-items:center;gap:9px;margin-bottom:7px}',
    '.chan .nm{width:64px;font-size:11.5px;color:#c9d1d9;white-space:nowrap}',
    '.chan .track{flex:1;background:#0d1117;border-radius:4px;height:19px;overflow:hidden;border:1px solid #21262d}',
    '.chan .fill{height:100%;display:flex;align-items:center;padding-left:7px;font-size:10.5px;font-weight:600;color:#0d1117;white-space:nowrap}',
    '.chan .n{width:64px;text-align:right;font-size:10.5px;color:#8b949e}',
    '.bridge{background:#161b22;border:1px solid #21262d;border-left:4px solid #bc8cff;border-radius:0 10px 10px 0;padding:12px 16px;margin:16px 0;font-size:12.5px;line-height:1.6}.bridge b{color:#bc8cff}',
    '.st{font-size:14px;font-weight:600;color:#f0f6fc;margin:20px 0 8px;padding-bottom:7px;border-bottom:1px solid #21262d}',
    '.hold{background:#0f141a;border:1px solid #21262d;border-radius:12px;padding:16px 18px}',
    '.hold-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}',
    '.hm{background:#161b22;border:1px solid #21262d;border-radius:9px;padding:11px 13px}',
    '.hm .lab{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}',
    '.hm .val{font-size:21px;font-weight:700;color:#f0f6fc;margin-top:3px}.hm .hint{font-size:10.5px;color:#8b949e;margin-top:3px}',
    '.upside{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}',
    '.up{background:#12100a;border:1px solid #5e4914;border-radius:9px;padding:11px 13px;text-align:center}',
    '.up .pr{font-size:11px;color:#EF9F27;font-weight:600}.up .amt{font-size:20px;font-weight:700;color:#EF9F27;margin-top:3px}.up .yr{font-size:10.5px;color:#8b949e;margin-top:2px}',
    '.cross{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
    '.warn{background:#2d2206;border:1px solid #5e4914;border-radius:8px;padding:10px 13px;font-size:12px;line-height:1.55}.warn b{color:#EF9F27}',
    'table{border-collapse:collapse;width:100%;font-size:12px}',
    'th,td{text-align:right;padding:5px 10px;border-bottom:1px solid #161d26}th:first-child,td:first-child{text-align:left}',
    'th{color:#8b949e;font-weight:500}',
    '.tblwrap{overflow-x:auto;border:1px solid #21262d;border-radius:8px}',
    '.muted{color:#8b949e;font-size:11.5px;margin-top:6px}',
    '.foot{font-size:11px;color:#6e7681;margin-top:20px;line-height:1.6;border-top:1px solid #21262d;padding-top:12px}',
    '.err{color:#ff7b72}',
    '@media(max-width:840px){.duo,.cross{grid-template-columns:1fr}.hold-grid,.upside{grid-template-columns:1fr}}',
  ].join('');

  const js = [
    "var API='/dashboard/api/funnel-scoreboard';",
    "var COL={r:'#ff7b72',a:'#d29922',g:'#56d364',b:'#58a6ff'};",
    "var BAR={r:{bg:'#231316',bd:'#8b2828'},a:{bg:'#231d0e',bd:'#5e4914'},g:{bg:'#0e2318',bd:'#1b5e3a'},b:{bg:'#0e1a2d',bd:'#1f4d80'}};",
    "function f(n){return n==null?'\\u2014':Math.round(n).toLocaleString();}",
    "function pct(x){return x==null?'\\u2014':(x*100).toFixed(1)+'%';}",
    "function el(id){return document.getElementById(id);}",
    "function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');}",
    "function table(container,cols,rows){var w=document.createElement('div');w.className='tblwrap';var t=document.createElement('table');var th=document.createElement('thead');var htr=document.createElement('tr');cols.forEach(function(c){var e=document.createElement('th');e.textContent=c;htr.appendChild(e);});th.appendChild(htr);t.appendChild(th);var tb=document.createElement('tbody');rows.forEach(function(r){var tr=document.createElement('tr');r.forEach(function(c){var td=document.createElement('td');td.textContent=(c==null?'\\u2014':String(c));tr.appendChild(td);});tb.appendChild(tr);});t.appendChild(tb);w.appendChild(t);container.innerHTML='';container.appendChild(w);}",
    // Generic funnel renderer, driven by the live JSON stages+transitions+leak+channels.
    "function funnel(elm,cfg){",
    "  var n=cfg.stages.length;var W=n===4?[100,70,44,26]:(n===3?[100,60,32]:[100,50]);",
    "  var h='<div class=\"fhead\"><div><div class=\"ft\">'+cfg.title+'</div><div class=\"fp\">'+cfg.path+'</div></div><span class=\"money '+cfg.moneyCls+'\">'+cfg.money+'</span></div>';",
    "  if(cfg.proxyBand)h+=cfg.proxyBand;",
    "  for(var i=0;i<n;i++){var s=cfg.stages[i];var bc=BAR.b,cc=COL.b;if(i>0){var v=cfg.transitions[i-1].verdict;bc=BAR[v]||BAR.a;cc=COL[v]||COL.a;}",
    "    h+='<div class=\"stage\" style=\"width:'+W[i]+'%;background:'+bc.bg+';border-color:'+bc.bd+'\"><div><div class=\"snm\">'+esc(s.label)+'</div><div class=\"sst\">'+esc(s.sublabel)+'</div></div><div class=\"scount\" style=\"color:'+cc+'\">'+f(s.count)+'</div></div>';",
    "    if(i<n-1){var t=cfg.transitions[i];var lc=t.low_confidence?'<span class=\"pill\" style=\"background:#22233a;color:#8b949e;border:1px solid #30363d\">n&lt;30</span>':'';",
    "      h+='<div class=\"conn\"><span class=\"rate '+t.verdict+'\">'+pct(t.rate)+'</span> \\u00b7 \\u2212'+f(t.drop)+(t.verdict==='r'?'<span class=\"pill pill-r\">LEAK</span>':(t.verdict==='g'?'<span class=\"pill pill-g\">healthy</span>':''))+lc+'</div>';}}",
    "  if(cfg.leak){h+='<div class=\"leakline\"><b>Biggest leak: '+esc(cfg.leak.from)+' \\u2192 '+esc(cfg.leak.to)+' ('+pct(cfg.leak.rate)+').</b> '+cfg.leakExtra+'</div>';}",
    "  h+=cfg.fixHtml;",
    "  h+='<div class=\"chsec\"><div class=\"chlab\">'+cfg.chLab+'</div>';",
    "  cfg.chans.forEach(function(c){h+='<div class=\"chan\"><div class=\"nm\">'+esc(c.nm)+'</div><div class=\"track\"><div class=\"fill\" style=\"width:'+c.w+'%;background:'+c.col+'\">'+c.txt+'</div></div><div class=\"n\">'+c.n+'</div></div>';});",
    "  elm.innerHTML=h+'</div>';",
    "}",
    "function render(d){",
    "  var hf=d.human_funnel,af=d.agent_funnel,hu=d.hold_upside;",
    // human channels
    "  var hc=(hf.by_channel||[]).slice(0,4).map(function(c){return {nm:c.channel,w:Math.max(4,Math.round((c.pct||0)*100)),col:(c.channel==='direct'?'#8b949e':(c.channel==='tg_bot'?'#58a6ff':'#bc8cff')),txt:f(c.count),n:pct(c.pct)};});",
    "  var ep=hf.engagement_proxy;",
    "  var proxy='<div class=\"proxyband\">Engagement (proxy \\u00b7 not a funnel parent): track-record views <b>'+f(ep.track_record_viewed)+'</b> \\u00b7 landing CTA <b>'+f(ep.landing_cta_clicked)+'</b><div class=\"hint\">'+esc(ep.caveat)+'</div></div>';",
    "  funnel(el('human'),{title:'Human funnel',path:'Web \\u2192 account \\u2192 subscription',money:'Stripe',moneyCls:'money-stripe',stages:hf.stages,transitions:hf.transitions,leak:hf.biggest_leak,proxyBand:proxy,",
    "    leakExtra:'Human web-flow friction, not traffic. vs the 30\\u201355% signup-form norm.',",
    "    fixHtml:'<div class=\"fixline\"><b>Fix (deferred \\u2192 FUNNEL-FIX-HUMAN-SIGNUP-W1):</b> OAuth / one-tap \\u00b7 defer the email + referral step to AFTER first value. (Nudge layer already shipped.)</div>',",
    "    chLab:'By channel (human source)',chans:hc});",
    // OPS-ATTRIBUTION-AI-REFERRAL-W1 — AI-referral family (human funnel · floor): AI-referred signups
    "  var air=hf.ai_referral;if(air){var airRows=(air.by_source||[]).map(function(s){return [String(s.source).replace('ai_',''),f(s.count),pct(s.pct)];});if(!airRows.length)airRows=[['\\u2014 none yet',0,'\\u2014']];table(el('aireferral'),['AI surface','Signups','Share'],airRows);el('aireferral-note').textContent='AI-referred signups (floor): '+f(air.total)+'. '+air.floor_note;}",
    // agent channels = retention.by_channel (d7 quality signal)
    "  var ac=(d.retention&&d.retention.by_channel||[]).slice(0,4).map(function(x){return {nm:x.channel,w:Math.max(6,Math.round((x.curve.d7||0)*100)),col:(x.curve.d7>=0.3?'#56d364':(x.curve.d7>0?'#d29922':'#ff7b72')),txt:pct(x.curve.d7)+' d7',n:'n='+f(x.curve.cohort_size)};});",
    "  funnel(el('agent'),{title:'Agent funnel',path:'MCP / API \\u2192 x402 \\u00b7 no signup',money:'x402',moneyCls:'money-x402',stages:af.stages,transitions:af.transitions,leak:af.biggest_leak,",
    "    leakExtra:'quota\\u2192paid rate is unit-approximate (keys vs payment events) \\u2014 '+esc(af.paid_note.split('.')[0])+'. Quota detail: hard/block '+f(af.quota_detail.windowed_hard_block)+' \\u00b7 approaching(soft) '+f(af.quota_detail.soft_approaching)+' \\u00b7 all-time PQLs '+f(af.quota_detail.all_time_pqls)+'.',",
    "    fixHtml:'<div class=\"fixline\"><b>Fix (deferred \\u2192 FUNNEL-FIX-AGENT-X402-NUDGE-W1):</b> surface x402 pay-per-call in-protocol at the quota edge (the shipped nudge points to a Stripe sub, not x402).</div>',",
    "    chLab:'By channel (retention d7 \\u2014 quality signal)',chans:ac});",
    // HOLD upside
    "  var up=hu.upside.map(function(u){return '<div class=\"up\"><div class=\"pr\">$'+u.price+' / HOLD</div><div class=\"amt\">$'+f(u.amount)+'</div><div class=\"yr\">this window</div></div>';}).join('');",
    "  el('hold').innerHTML='<div class=\"hold-grid\">'",
    "    +'<div class=\"hm\"><div class=\"lab\">Avg calls / active agent</div><div class=\"val b\">'+(hu.avg_calls_per_active_agent==null?'\\u2014':hu.avg_calls_per_active_agent.toFixed(1))+'</div><div class=\"hint\">'+f(hu.external_calls)+' external \\u00f7 '+f(hu.active_agents)+' active</div></div>'",
    "    +'<div class=\"hm\"><div class=\"lab\">HOLD calls (free today)</div><div class=\"val o\">'+f(hu.hold_calls)+'</div><div class=\"hint\">'+pct(hu.hold_rate)+' HOLD \\u00b7 billed $0</div></div>'",
    "    +'<div class=\"hm\"><div class=\"lab\">Trade calls (billable)</div><div class=\"val g\">'+f(hu.trade_calls)+'</div><div class=\"hint\">BUY/SELL \\u00b7 already priced</div></div>'",
    "    +'<div class=\"hm\"><div class=\"lab\">Non-verdict calls</div><div class=\"val\">'+f(hu.non_verdict_calls)+'</div><div class=\"hint\">chat/search/regime \\u00b7 excl. from split</div></div>'",
    "    +'</div><div style=\"font-size:11.5px;color:#8b949e;margin-bottom:9px\">If HOLD calls were priced later (free forever today), the upside from <b style=\"color:#c9d1d9\">this window\\u2019s</b> external HOLD volume:</div>'",
    "    +'<div class=\"upside\">'+up+'</div>'",
    "    +'<div style=\"font-size:11px;color:#6e7681;margin-top:10px;line-height:1.5\">'+esc(hu.caveat)+'</div>';",
    // bridge + cross-cutting
    "  el('bridge').innerHTML='<b>The bridge:</b> the two funnels connect through the API key \\u2014 a human signs up \\u2192 gets a key + referral code \\u2192 wires it into agents, which then appear \\u201crecognized\\u201d in the agent funnel. Most agents never enter the human funnel (free tier needs no signup). <b>Humans are the buyers; agents are the consumers.</b>';",
    "  var directPct=null,tot=0,direct=0;(hf.by_channel||[]).forEach(function(c){tot+=c.count;if(c.channel==='direct')direct=c.count;});if(tot>0)directPct=direct/tot;",
    "  el('cross').innerHTML='<div class=\"warn\"><b>Attribution is '+pct(directPct)+' blind.</b> Most human clicks + agent connects are untagged \\u201cdirect\\u201d \\u2014 you can\\u2019t yet tell which channel produces payers. Fix = UTM every owned link + server-side ?src= first-touch.</div>'"
    ,
    "    +'<div class=\"warn\"><b>No activation-timing stage.</b> Neither funnel measures time-to-first-call (TTFC) \\u2014 the documented precursor to retention + payment. Activated counts \\u22651 call but not <em>how fast</em>.</div>';",
    "  var sc=d.source_channels;if(sc){var scrows=sc.by_source.map(function(x){return [x.source,x.medium,f(x.count),pct(x.pct)+(x.low_confidence?' n<30':'')];});table(el('srcchan'),['Source','Medium','Sessions','Share'],scrows);el('srccov').textContent='Coverage '+pct(sc.coverage_pct)+' classified ('+f(sc.classified)+' of '+f(sc.total)+' sessions). '+esc(sc.note);}",
    // detail panels (retained)
    "  var rt=d.retention;if(rt){var d90=function(c){return c.d90==null?'\\u2014':pct(c.d90);};",
    "    table(el('rt-tier'),['Tier','d7','d14','d30','d90','sessions'],[['\\ud83d\\udfe2 Free',pct(rt.by_tier.free.d7),pct(rt.by_tier.free.d14),pct(rt.by_tier.free.d30),d90(rt.by_tier.free),f(rt.by_tier.free.cohort_size)],['\\ud83d\\udcb3 Paid',pct(rt.by_tier.paid.d7),pct(rt.by_tier.paid.d14),pct(rt.by_tier.paid.d30),d90(rt.by_tier.paid),f(rt.by_tier.paid.cohort_size)]]);",
    "    table(el('rt-channel'),['Channel (conn ?src=)','d7','d14','d30','d90','sessions'],rt.by_channel.map(function(x){return [x.channel,pct(x.curve.d7),pct(x.curve.d14),pct(x.curve.d30),d90(x.curve),f(x.curve.cohort_size)];}));",
    "    el('rt-note').textContent='Overall (excl. bot) d7 '+pct(rt.overall.d7)+' \\u00b7 internal excluded '+f(rt.internal_excluded)+' \\u00b7 '+esc(rt.coverage_caveat);}",
    "  var ca=d.client_activity_24h;if(ca){var rawTop=f(ca.calls.raw_api)+(ca.calls.raw_api_top1_pct!=null?(' (top IP '+ca.calls.raw_api_top1_pct+'%)'):'');var tgb=ca.calls.tg_bot_breakdown;",
    "    table(el('client'),['Client type','Calls (24h)','Sessions (24h)'],[['Total',f(ca.calls.total),f(ca.sessions.total)],['\\ud83d\\udfe2 Recognized',f(ca.calls.recognized),f(ca.sessions.recognized)],['\\ud83d\\udd0c Raw API',rawTop,f(ca.sessions.raw_api)],['\\ud83d\\udcb3 Paid (x402/a2mcp)',f(ca.calls.paid),f(ca.sessions.paid)],['\\ud83d\\udd01 TG bot',f(ca.calls.tg_bot)+' (W'+f(tgb.watch)+'\\u00b7SW'+f(tgb.scanwatch)+'\\u00b7S'+f(tgb.scan)+')',f(ca.sessions.tg_bot_subscribers)+' subs']]);}",
    "  var dr=(d.daily||[]).slice().reverse().map(function(x){return [x.date,x.signup_intent,x.conversions];});table(el('daily'),['Date','Subscribe clicks','Conversions'],dr);",
    "  el('foot').innerHTML='Window: <b style=\"color:#c9d1d9\">'+esc(d.window.days)+'d ('+esc(CURW)+')</b> \\u00b7 computed '+esc(d.computed_at)+'<br>Guards: benchmark bands (vs dev-tool medians) \\u00b7 n&lt;30 flagged \\u00b7 retention = cohort curve (d90 maturing) \\u00b7 channel = server-side ?src= \\u00b7 internal vs external calls separated \\u00b7 HOLD upside = external-only estimate.';",
    "  var wb=el('warnbox');if(d.warnings&&d.warnings.length){wb.style.display='block';wb.textContent='warnings: '+d.warnings.slice(0,6).join('  |  ');}else{wb.style.display='none';}",
    "}",
    "var CURW='all';",
    "function load(w){CURW=w;el('foot').textContent='loading\\u2026';fetch(API+'?window='+encodeURIComponent(w),{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(render).catch(function(e){var wb=el('warnbox');wb.style.display='block';wb.className='warnbox err';wb.textContent='Failed to load: '+e.message;});}",
    "document.addEventListener('DOMContentLoaded',function(){document.getElementById('tf').addEventListener('click',function(e){if(e.target.tagName!=='BUTTON')return;document.querySelectorAll('#tf button').forEach(function(b){b.classList.remove('on');});e.target.classList.add('on');load(e.target.getAttribute('data-w'));});load('all');});",
  ].join('\n');

  const body = [
    '<div class="topbar"><div><h1>AlgoVault — Funnel Scoreboard</h1>',
    '<p class="sub">Two audiences, two funnels, two leaks. Internal · operator-only · MEASUREMENT-ONLY.</p></div>',
    '<div><div class="tf-label">Timeframe</div><div class="tf" id="tf">',
    '<button data-w="7">7D</button><button data-w="30">30D</button><button data-w="90">90D</button>',
    '<button data-w="180">180D</button><button data-w="365">365D</button><button data-w="all" class="on">All</button>',
    '</div></div></div>',
    '<div id="warnbox" class="warnbox"></div>',
    '<div class="splitnote"><b>Primary split = Human vs Agent.</b> The journeys don\'t share stages — "signup / referral" is human-only, "x402 pay-per-call" is agent-only, on different rails (Stripe vs x402). Channel is the secondary breakdown inside each.</div>',
    '<div class="duo"><div class="fcard" id="human"></div><div class="fcard" id="agent"></div></div>',
    '<div class="st">AI referral (human funnel · floor) <span style="font-size:11px;font-weight:400;color:#8b949e;float:right">AI-referred signups · anonymous AI visitors land with the 1K-visitor beacon</span></div>',
    '<div id="aireferral"></div><div class="muted" id="aireferral-note"></div>',
    '<div class="st">Agent engagement + HOLD-monetization upside <span style="font-size:11px;font-weight:400;color:#8b949e;float:right">~99% of external calls are free HOLDs today — the untapped ceiling</span></div>',
    '<div class="hold" id="hold"></div>',
    '<div class="bridge" id="bridge"></div>',
    '<div class="st">Cross-cutting gaps (fix these to see clearly)</div><div class="cross" id="cross"></div>',
    '<div class="st">Source-classified channels (first-touch) <span style="font-size:11px;font-weight:400;color:#8b949e;float:right">new-traffic-forward · coverage grows as the log-sampler + owned-link tags land</span></div>',
    '<div id="srcchan"></div><div class="muted" id="srccov"></div>',
    '<div class="st">Retention detail — by tier &amp; by channel (internal bot excluded)</div>',
    '<div class="muted">By tier (free vs paid)</div><div id="rt-tier"></div>',
    '<div class="muted" style="margin-top:10px">By channel (connection ?src= source)</div><div id="rt-channel"></div>',
    '<div class="muted" id="rt-note"></div>',
    '<div class="st">Client activity (24h) — matches the Telegram daily digest</div><div id="client"></div>',
    '<div class="st">Daily timeseries (subscribe clicks + conversions)</div><div id="daily"></div>',
    '<div class="foot" id="foot">—</div>',
  ].join('');

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    '<title>Funnel Scoreboard v2 — AlgoVault (internal)</title>',
    '<style>', css, '</style></head><body>',
    body,
    '<script>', js, '</script></body></html>',
  ].join('');
}
