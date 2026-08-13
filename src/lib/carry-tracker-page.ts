/**
 * EDGE-CARRY-SCOREBOARD-W1 — the /carry-tracker page. SHIPS DARK.
 *
 * Dark means: `noindex`, absent from sitemap.xml / llms.txt / llms-full.txt / every nav, and
 * reachable only by direct URL. `scripts/indexnow-ping.mjs` submits ONLY the `<loc>` set parsed
 * from landing/sitemap.xml, so staying out of the sitemap keeps the page out of IndexNow too.
 * It links live only when the pre-registered W34 gate clears AND the wording is approved.
 *
 * FUNCTION-RENDERED, NOT A landing/*.html FILE — and that was a measured decision, not a style
 * preference. `noindex` appears zero times across landing/*.html; all five real uses in this repo
 * are function-rendered pages (contact, referral-terms, per-ref landings, the two dashboards).
 * And `scripts/inject-footer.mjs` derives its targets from the glob `landing/**` minus one
 * declared exemption, with `inject-footer --check` wired as a deploy canary — so a hand-authored
 * static page cannot be "free of generator entanglement" no matter how it is written. Here it
 * genuinely is.
 *
 * WHAT THIS PAGE MAY AND MAY NOT SAY. Every number is a PAIRED PAPER LIFT: the ranker portfolio's
 * net carry minus the naive portfolio's, on the same funding interval, x2-hedged-cost basis,
 * live-forward since the HL flip on 2026-07-21. The naive counterfactual lives in a paper
 * portfolio scored on the same intervals BECAUSE SERVED TRAFFIC HAS NO COUNTERFACTUAL — you
 * cannot observe what the venue ordering would have returned had it not been re-ranked. So:
 *   * NOT served-traffic P&L, and never to be described as such;
 *   * NO uptime claim — the scorer run-history table (carry_scorer_runs) started accruing
 *     2026-08-13 and has no history to claim from yet;
 *   * NO absolute portfolio values — the endpoint serves differences and interval counts only;
 *   * NO anchoring claim — the daily Merkle publisher builds trees from SIGNAL HASHES against
 *     `publishRoot(batchId, root, signalCount)`; adding non-signal leaves would break the
 *     on-chain <-> dashboard equality canary. Anchoring is a named follow-up, not a promise;
 *   * NO "edge"/"alpha"/"premium" language;
 *   * NO volatile counts in prose (TDQS forward-stability) — the figures live in the chart,
 *     which is regenerated from the endpoint on every render.
 *
 * UNITS. `portfolio_net_carry_x2` is `mean(|funding_rate|) - turnover cost` over the picks
 * (gate.realize_interval), and `funding_rate` comes straight from `funding_rates_hist` — so it
 * is a PER-FUNDING-INTERVAL FRACTION. Rendered here in basis points (1bp = 0.0001) and labelled
 * as per-interval. Deliberately NOT annualised: annualising would require assumptions about
 * compounding, holding period and capital that this measurement does not make.
 */
import { getCarryTrackerPublic, type CarryTrackerPublic } from './carry-tracker-public.js';
import { renderBrandFooter } from './footer-content.js';

/** The scope banner. Copy-locked — it states exactly which venue the evidence covers and why the
 *  others are withheld, which is the honest answer to "why only one venue?". */
export const SCOPE_BANNER =
  'Live-forward since 2026-07-21 · Hyperliquid only (the venue that cleared the pre-registered bar) '
  + '· withheld elsewhere — venues flip only when their own bar clears.';

/** The refusal exhibit. Copy-locked and deliberately narrower than the spec's first draft, which
 *  said "the system demotes on decay". Measured 2026-08-13: it does not. The decay detector
 *  (carry_serving_state.DECAY_CONSECUTIVE_FAILS = 2) changes a DIGEST RENDER STRING and points at
 *  the runbook; its own docstring records that the state file is "deletable at any time with no
 *  effect on any live path". Rollback is an operator removing three env lines. Claiming automatic
 *  demotion would be asserting product behaviour that does not exist. */
export const REFUSAL_EXHIBIT =
  'Serving is gate-controlled (three-key ignition) and per-venue reversible on demand; '
  + 'a decay detector escalates to the operator after 2 consecutive failed re-checks.';

const BPS = 10_000;
const toBps = (x: number): number => x * BPS;
const fmtBps = (x: number): string => `${x >= 0 ? '+' : ''}${toBps(x).toFixed(2)}`;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
  *{box-sizing:border-box}
  body{margin:0;background:#0d1117;color:#e1e4e8;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .wrap{max-width:860px;margin:0 auto;padding:56px 24px 72px}
  h1{font-size:30px;line-height:1.25;margin:0 0 10px;font-weight:650}
  h2{font-size:17px;margin:40px 0 12px;font-weight:600;color:#e1e4e8}
  p{color:#c9d1d9;margin:0 0 14px}
  .banner{background:#161b22;border:1px solid #30363d;border-left:3px solid #3fb950;border-radius:8px;padding:14px 16px;color:#c9d1d9;font-size:14px;margin:0 0 28px}
  .stale{border-left-color:#d29922;background:rgba(210,153,34,0.08);color:#e3b341}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px}
  .hero{display:flex;flex-wrap:wrap;gap:28px;align-items:baseline;margin-bottom:6px}
  .big{font-size:38px;font-weight:660;color:#3fb950;font-variant-numeric:tabular-nums;line-height:1}
  .unit{font-size:14px;color:#8b949e;margin-left:6px;font-weight:400}
  .ci{color:#8b949e;font-size:14px;font-variant-numeric:tabular-nums}
  .chart{width:100%;height:auto;display:block;margin:22px 0 6px;overflow:visible}
  table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums;margin-top:8px}
  th,td{text-align:right;padding:8px 10px;border-bottom:1px solid #21262d}
  th{color:#8b949e;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  th:first-child,td:first-child{text-align:left}
  .tag{display:inline-block;font-size:11px;color:#d29922;border:1px solid rgba(210,153,34,.4);border-radius:4px;padding:1px 6px;margin-left:8px;letter-spacing:.02em}
  .note{color:#8b949e;font-size:13.5px}
  .note code{background:#161b22;border:1px solid #30363d;border-radius:4px;padding:1px 5px;font-size:12.5px}
  ul{color:#c9d1d9;padding-left:20px;margin:0 0 14px}
  li{margin-bottom:7px}
  .scroll{overflow-x:auto}
  @media (max-width:600px){.wrap{padding:36px 16px 56px}h1{font-size:24px}.big{font-size:30px}}
`;

/** Bar chart of the weekly series. Renders whatever is true — including a falling series. */
function chart(weeks: CarryTrackerPublic['weeks']): string {
  if (weeks.length === 0) return '<p class="note">No weekly data available.</p>';
  const W = 780; const H = 240; const padL = 52; const padB = 46; const padT = 16;
  const vals = weeks.map((w) => toBps(w.lift_mean));
  const top = Math.max(...vals, 0) * 1.25 || 1;
  const bw = (W - padL - 12) / weeks.length;
  const y = (v: number): number => padT + (H - padT - padB) * (1 - v / top);
  const bars = weeks.map((w, i) => {
    const v = toBps(w.lift_mean);
    const x = padL + i * bw + bw * 0.18;
    const bwidth = bw * 0.64;
    const yy = y(Math.max(v, 0));
    const h = Math.max(y(0) - yy, 1);
    const fill = w.partial ? 'url(#hatch)' : '#3fb950';
    return `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bwidth.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" stroke="#3fb950" stroke-width="${w.partial ? 1 : 0}" rx="2"/>`
      + `<text x="${(x + bwidth / 2).toFixed(1)}" y="${(yy - 6).toFixed(1)}" fill="#c9d1d9" font-size="12" text-anchor="middle" font-family="inherit">${v.toFixed(2)}</text>`
      + `<text x="${(x + bwidth / 2).toFixed(1)}" y="${(H - padB + 18).toFixed(1)}" fill="#8b949e" font-size="12" text-anchor="middle" font-family="inherit">${esc(w.iso_week)}</text>`
      + `<text x="${(x + bwidth / 2).toFixed(1)}" y="${(H - padB + 34).toFixed(1)}" fill="#6e7681" font-size="11" text-anchor="middle" font-family="inherit">n=${w.n}${w.partial ? ' ·partial' : ''}</text>`;
  }).join('');
  const ticks = [0, top / 2, top].map((t) => `<line x1="${padL}" y1="${y(t).toFixed(1)}" x2="${W - 6}" y2="${y(t).toFixed(1)}" stroke="#21262d" stroke-width="1"/>`
    + `<text x="${padL - 8}" y="${(y(t) + 4).toFixed(1)}" fill="#6e7681" font-size="11" text-anchor="end" font-family="inherit">${t.toFixed(1)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly paired lift, basis points per funding interval">
  <defs><pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
    <rect width="6" height="6" fill="#161b22"/><line x1="0" y1="0" x2="0" y2="6" stroke="#3fb950" stroke-width="3"/>
  </pattern></defs>
  ${ticks}${bars}
  <text x="4" y="12" fill="#6e7681" font-size="11" font-family="inherit">bps / interval</text>
</svg>`;
}

function table(weeks: CarryTrackerPublic['weeks']): string {
  const rows = weeks.map((w) => `<tr><td>${esc(w.iso_week)}${w.partial ? '<span class="tag">partial</span>' : ''}</td>`
    + `<td>${fmtBps(w.lift_mean)}</td><td>${w.n}</td><td>${w.n_deviating}</td></tr>`).join('');
  return `<div class="scroll"><table><thead><tr><th>ISO week</th><th>Paired lift (bps/interval)</th><th>Intervals</th><th>Deviating</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderCarryTrackerPage(data: CarryTrackerPublic): string {
  const p = data.pooled;
  const hero = p
    ? `<div class="hero"><div><span class="big" data-ct-field="pooled_lift">${fmtBps(p.lift_mean)}</span><span class="unit">bps / funding interval</span></div>
       <div class="ci">95% CI <span data-ct-field="pooled_ci">[${fmtBps(p.ci_lb)}, ${fmtBps(p.ci_ub)}]</span>
       · <span data-ct-field="pooled_n">${p.n}</span> intervals · <span data-ct-field="pooled_blocks">${p.blocks}</span> ISO-week blocks</div></div>`
    : '<p class="note">No pooled figure available.</p>';

  const banner = data.stale
    ? `<div class="banner stale">This page is showing the last successfully computed figures. The publisher has not reported since ${esc(data.updated_at ?? 'its last run')} — treat the numbers below as out of date.</div>`
    : `<div class="banner">${esc(SCOPE_BANNER)}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Carry re-rank tracker — AlgoVault</title>
<style>${CSS}</style>
</head>
<body><main class="wrap">
<h1>Carry re-rank tracker</h1>
<p class="note">Weekly paired lift of the carry re-ranker against the naive benchmark, measured live-forward since the flip. Updated daily.</p>
${banner}

<div class="card">
  ${hero}
  ${chart(data.weeks)}
  ${table(data.weeks)}
  <p class="note" style="margin-top:16px">Hatched bars are partial weeks. The first is measured from the flip on a Tuesday, so it covers fewer intervals than a full week; the last is still in progress. A confidence interval is shown for the pooled figure only — the interval is a block bootstrap over ISO-week clusters, so a single week is one cluster and its own interval would be degenerate.</p>
  <p class="note" id="ct-updated">Last computed: ${esc(data.updated_at ?? 'unknown')}</p>
</div>

<h2>What is being measured</h2>
<p>Two portfolios are scored on the same funding intervals: the re-ranker's picks and the naive benchmark's. The figure above is the <strong>difference</strong> between them, per interval, on a fully-hedged (&times;2) cost basis.</p>
<p>The benchmark portfolio is a <strong>paper</strong> portfolio. That is not a shortcut — served traffic has no counterfactual. Once a venue is re-ranked, what the previous ordering would have returned is unobservable, so the comparison is only possible against a benchmark scored in parallel. Everything on this page is therefore <strong>paired paper lift</strong>, not realised trading P&amp;L.</p>
<ul>
  <li><strong>Scope.</strong> Hyperliquid only. Other venues are measured continuously and stay withheld until each clears the same pre-registered bar on its own evidence.</li>
  <li><strong>Window.</strong> Live-forward from the flip, never backfilled. Nothing here is an in-sample or catch-up figure.</li>
  <li><strong>Uptime.</strong> Not claimed. The scorer's run history began accruing on 2026-08-13; a coverage figure will be published once that history is long enough to mean something.</li>
  <li><strong>Anchoring.</strong> Not claimed. These aggregates are not Merkle-anchored today; the on-chain batches cover signal records.</li>
</ul>

<h2>What happens when it stops working</h2>
<p>${esc(REFUSAL_EXHIBIT)}</p>
<p class="note">The chart shows the series as measured, including weeks where the lift falls. A tracker that only renders favourable weeks is not evidence of anything.</p>

</main>${renderBrandFooter('desktop')}
<script>
// Live-bind: re-read the endpoint the page was server-rendered from, so a tab left open does not
// quietly show yesterday's figures. The server render is the fallback — with JS off the page is
// still correct, it simply stops updating.
(function () {
  function fmt(x) { var v = x * 10000; return (v >= 0 ? '+' : '') + v.toFixed(2); }
  function set(k, s) { var e = document.querySelector('[data-ct-field="' + k + '"]'); if (e) e.textContent = s; }
  function refresh() {
    fetch('/api/carry-tracker-public', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.pooled) return;
        set('pooled_lift', fmt(d.pooled.lift_mean));
        set('pooled_ci', '[' + fmt(d.pooled.ci_lb) + ', ' + fmt(d.pooled.ci_ub) + ']');
        set('pooled_n', String(d.pooled.n));
        set('pooled_blocks', String(d.pooled.blocks));
        var u = document.getElementById('ct-updated');
        if (u && d.updated_at) u.textContent = 'Last computed: ' + d.updated_at;
      })
      .catch(function () { /* server-rendered values stand */ });
  }
  setInterval(refresh, 300000);
})();
</script>
</body>
</html>`;
}

export async function getCarryTrackerPageHtml(): Promise<string> {
  return renderCarryTrackerPage(await getCarryTrackerPublic());
}
