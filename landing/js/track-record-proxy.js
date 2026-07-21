/**
 * AlgoVault track-record proxy
 * ============================
 *
 * Fetches https://algovault.com/api/performance-public on DOMContentLoaded and
 * populates every element marked with `data-tr-field="<field>"` with the live
 * value. On fetch failure the existing static text remains as fallback (each
 * existing static value MUST carry an HTML comment `<!-- snapshot: YYYY-MM-DD
 * — live source of truth: /api/performance-public -->` next to it).
 *
 * Supported fields (v1.10.0 OUTPUT-SANITIZE-W1 C5 cutover — `signal_count`
 * dropped; the canonical hook is `call_count`):
 *   - pfe_wr          → "89.4%" (rounded to 1 decimal, % suffix)
 *   - call_count      → "60,853" (locale-formatted with thousands separators)
 *   - batch_count     → "16" (integer, no commas — small numbers)
 *   - last_updated    → "2026-04-26" (ISO date) or "26 Apr 2026" (localised)
 *   - hold_rate       → "98.2%" (rounded to 1 decimal, % suffix; computed
 *                       server-side as totalHolds / (totalHolds + totalCalls)
 *                       × 100 — see src/index.ts:/api/performance-public for
 *                       the server-side formula.)
 *   - asset_count     → "710" (round-floored to nearest 10; rendered as
 *                       "<span>710</span>+ assets" so the literal "+" lives
 *                       outside the span — AUTO-TRACE-W1)
 *   - exchange_count  → "5" (raw integer; auto-updates when 6th adapter
 *                       lands in src/lib/capabilities.ts EXCHANGES list)
 *   - timeframe_count → "11" (raw integer; matches Zod enum length)
 *
 * Live snapshot at deploy time (initial-render fallback if fetch fails BEFORE
 * any cache hit):
 *   - pfeWinRate: 0.8945  (89.4%)
 *   - totalCalls: 60,853 (v1.10.0; was totalSignals pre-1.10)
 *   - batches: 16 (latest batch_id; published 2026-04-26T00:05:04Z)
 *
 * Endpoint contract (v1.10.0):
 *   GET /api/performance-public →
 *   {
 *     "totalCalls": 60853,
 *     "period": { "from": "2026-04-10", "to": "2026-04-28" },
 *     "overall": {
 *       "totalCalls": 60853,
 *       "totalEvaluated": 60413,
 *       "pfeWinRate": 0.8944
 *     },
 *     "byCallType": { ... },
 *     "byTimeframe": { ... },
 *     ...
 *   }
 *
 *   GET /api/merkle-batches → { batches: [...] } — batch_count = batches.length
 *
 * ZERO dependencies. Pure browser JS. Cacheable for 5 minutes via the
 * Cache-Control header set by Caddy on the static-served file.
 */
(function () {
  'use strict';

  var PERF_URL = '/api/performance-public';
  var MERKLE_URL = '/api/merkle-batches';
  var ERC8004_URL = '/api/erc-8004-reputation';

  function formatPfe(rate) {
    if (typeof rate !== 'number' || isNaN(rate)) return null;
    return (Math.round(rate * 1000) / 10).toFixed(1) + '%';
  }

  function formatPercent(n) {
    // hold_rate arrives as a server-side-rounded number like 98.2 (one decimal
    // place, NOT a 0..1 ratio). Format defensively so 98 → "98.0%" not "98%".
    if (typeof n !== 'number' || isNaN(n)) return null;
    return n.toFixed(1) + '%';
  }

  function formatCount(n) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    return n.toLocaleString('en-US');
  }

  // AUTO-TRACE-W1: capability-counter formatters.
  //
  // formatAssetCount(718) → "710"  (rendered as "<span>710</span>+ assets" so
  //                                 the literal "+" sits OUTSIDE the span,
  //                                 letting the span hold a pure integer for
  //                                 deterministic-formatting)
  // formatExchangeCount(5) → "5"    (raw integer; exchange list is enumerable
  //                                 so no plus suffix needed)
  // formatTimeframeCount(11) → "11" (raw integer)
  //
  // Round-floor to nearest 10 for assets — never overstates the count if a
  // coin gets delisted between fetch + render.
  function formatAssetCount(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
    return String(Math.floor(n / 10) * 10);
  }

  function formatRawInt(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
    return String(Math.floor(n));
  }

  function formatDate(iso) {
    if (typeof iso !== 'string') return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  function setField(name, value) {
    if (value === null || value === undefined) return;
    var nodes = document.querySelectorAll('[data-tr-field="' + name + '"]');
    for (var i = 0; i < nodes.length; i++) {
      // textContent (NOT innerHTML) — defends against any unexpected upstream shape
      nodes[i].textContent = String(value);
    }
  }

  function fetchJson(url) {
    return fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
        return r.json();
      });
  }

  function refresh() {
    fetchJson(PERF_URL).then(function (perf) {
      var rate = perf && perf.overall && perf.overall.pfeWinRate;
      // v1.10.0: read canonical `totalCalls` only. Legacy `totalSignals` was
      // dropped from the API response in C5 — old static HTML/cached pages
      // would render the snapshot fallback if they're somehow served against
      // a pre-1.10 API, which is intended (graceful degradation).
      var n = perf && perf.totalCalls;
      // /api/performance-public#period.to is the most recent date covered by
      // the rolling-window evaluation (effectively "live data refreshed up to
      // YYYY-MM-DD"). Used by GEO last_updated recency signal.
      var to = perf && perf.period && perf.period.to;
      var holdRate = perf && perf.hold_rate;
      setField('pfe_wr', formatPfe(rate));
      // v1.10.0 cutover: `call_count` is the only DOM-hook write; legacy
      // `signal_count` write was dropped per spec OUTPUT-SANITIZE-W1 C5.
      setField('call_count', formatCount(n));
      setField('hold_rate', formatPercent(holdRate));
      if (to) setField('last_updated', formatDate(to));
      // AUTO-TRACE-W1 capability counters (added 2026-04-30). Static fallback
      // values inside each span stay visible if the fetch fails; on success
      // the span text content is replaced so the live number wins.
      setField('asset_count',     formatAssetCount(perf && perf.asset_count));
      setField('exchange_count',  formatRawInt(perf && perf.exchange_count));
      setField('timeframe_count', formatRawInt(perf && perf.timeframe_count));
      // OPS-LANDING-FUNDING-VENUE-RECONCILE-W1: funding-arb venue count (=7), live-bound
      // exactly like exchange_count. Static span fallback stays visible if the fetch fails.
      setField('funding_venue_count', formatRawInt(perf && perf.funding_venue_count));
      // DESIGN-W7 H-PR1: total_calls_executed = totalCalls + totalHolds (= "Agent Calls" hero counter).
      // Computed CLIENT-SIDE (no server-side schema change). Refresh cadence: shared with hero
      // counter — see refreshHeroCounter setInterval at end of this module (3s) which calls refresh().
      var tc = (perf && typeof perf.totalCalls === 'number') ? perf.totalCalls : 0;
      var th = (perf && typeof perf.totalHolds === 'number') ? perf.totalHolds : 0;
      var totalExecuted = tc + th;
      setField('total_calls_executed', formatCount(totalExecuted));
    }).catch(function (err) {
      // Silent — fallback static text remains visible. Console.debug-only so
      // ad-blockers / network failures don't spam the user's console.
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[track-record-proxy] perf fetch failed:', err.message || err);
      }
    });

    fetchJson(MERKLE_URL).then(function (data) {
      // OPS-MERKLE-BATCH-IDENTITY-W1: `data.batches` is LIMIT-capped (100) server-side,
      // so its length is NOT the batch count and its size is NEVER the batch number.
      // Prefer the explicitly-served truth; fall back to the array only so the page
      // still renders against an older server mid-deploy (never to a hardcoded value).
      // OPS-CAPPED-COLLECTION-GUARD-W1: the server-derived COUNT(*) is the ONLY
      // source. The previous array-length fallback was the wrong-number shape kept
      // alive: `data.batches` is a LIMIT-capped page, so its length pins at the cap
      // (100) once more batches exist — exactly the bug this replaced. If the field
      // is absent (an older server mid-deploy) we leave the baked fallback in the
      // markup rather than overwrite it with a value we know to be short.
      var n = data && typeof data.batch_count === 'number' ? data.batch_count : null;
      if (n !== null) setField('batch_count', formatCount(n));
      // OPS-WEBSITE-COPY-DRIFT-CLEANUP-W1 (2026-05-25): pages use BOTH `batch_count`
      // and `merkle_batch_count` span keys (per OPS-DASHBOARD-DRIFT-CANARY-W1 first-fire
      // surfacing). Populate both for backward compat; canary expects `merkle_batch_count`
      // on / and /how-it-works. Without this, those Class A spans never hydrate.
      if (n !== null) setField('merkle_batch_count', formatCount(n));
      // OPS-WEBSITE-COPY-DRIFT-CLEANUP-W1: verify-page latest-batch hydration.
      // Closes VERIFY_LATEST_BATCH_FRESH drift (static fallback "2026-05-09 18:00 UTC"
      // was 16d stale because no hydrator existed for these keys).
      if (data && Array.isArray(data.batches) && data.batches.length > 0) {
        var sorted = data.batches.slice().sort(function (a, b) {
          return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
        });
        var latest = sorted[0];
        if (latest && latest.published_at) {
          var d = new Date(latest.published_at);
          if (!isNaN(d.getTime())) {
            var pad = function (x) { return x < 10 ? '0' + x : String(x); };
            // Match verify-page static fallback shape "YYYY-MM-DD HH:MM UTC".
            var ymd = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
            var hm = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
            setField('latest_batch_at', ymd + ' ' + hm);
          }
        }
        // OPS-MERKLE-BATCH-IDENTITY-W1: these two are the batch IDENTITY, not a count.
        // They previously reused `n` (a row count) — correct only while fewer batches
        // existed than the LIMIT. Batch 101 crossed it and /verify froze at "#100"
        // while the sibling timestamp above kept updating.
        var latestId = data && typeof data.latest_batch_id === 'number'
          ? data.latest_batch_id
          : (latest && latest.batch_id != null ? Number(latest.batch_id) : null);
        setField('latest_batch_n', formatCount(latestId));
        setField('latest_batch', '#' + formatCount(latestId));
      }
    }).catch(function (err) {
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[track-record-proxy] merkle fetch failed:', err.message || err);
      }
    });

    // ERC-8004-W1 C3: hydrate the agentId span in the "ERC-8004 Verified Agent"
    // badge (landing/index.html hero + landing/verify.html). The Basescan
    // deep-link href ships hardcoded with the same agentId (44544) — if the
    // NFT is ever transferred to a new agentId via safeTransferFrom, update
    // the static fallback in both HTML files in the same wave.
    fetchJson(ERC8004_URL).then(function (data) {
      if (data && typeof data.agent_id === 'string') {
        setField('erc8004_agent_id', data.agent_id);
      }
    }).catch(function (err) {
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[track-record-proxy] erc-8004 fetch failed:', err.message || err);
      }
    });
  }

  // ── Plausible custom-event detectors (WEBSITE-REFRESH-W1 follow-up) ──
  // Fires plausible() events on page load when the visitor is arriving from
  // an AI tool, OR a UTM-tagged AI campaign, OR landing directly on a
  // /docs/integrations/* mirror. The corresponding Plausible Goal config
  // (Settings → Goals, Custom event type) consumes these event names:
  //   - "AI Referrer"      (props: source = referrer hostname)
  //   - "AI Campaign"      (props: source = utm_source value)
  //   - "Integration View" (props: exchange = slug, source = "direct")
  //
  // Plausible script loads async; we poll briefly for window.plausible
  // before firing so events on the very first pageview aren't dropped.

  var AI_REFERRER_HOSTS = [
    'chatgpt.com', 'chat.openai.com', 'claude.ai', 'perplexity.ai',
    'gemini.google.com', 'copilot.microsoft.com', 'you.com',
    'duckduckgo.com', 'kagi.com'
  ];
  var AI_CAMPAIGN_SOURCES = [
    'chatgpt', 'claude', 'perplexity', 'gemini', 'copilot', 'ai-overview'
  ];

  function firePlausible(name, props, retries) {
    if (typeof window.plausible === 'function') {
      try { window.plausible(name, { props: props }); } catch (_) { /* swallow */ }
      return;
    }
    if (retries > 0) {
      setTimeout(function () { firePlausible(name, props, retries - 1); }, 200);
    }
  }

  function detectAIReferrer() {
    var ref = document.referrer || '';
    if (!ref) return;
    for (var i = 0; i < AI_REFERRER_HOSTS.length; i++) {
      if (ref.indexOf(AI_REFERRER_HOSTS[i]) !== -1) {
        firePlausible('AI Referrer', { source: AI_REFERRER_HOSTS[i] }, 10);
        return;
      }
    }
  }

  function detectAICampaign() {
    if (typeof URLSearchParams !== 'function') return;
    var params = new URLSearchParams(location.search || '');
    var src = (params.get('utm_source') || '').toLowerCase();
    if (src && AI_CAMPAIGN_SOURCES.indexOf(src) !== -1) {
      firePlausible('AI Campaign', { source: src }, 10);
    }
  }

  function detectIntegrationView() {
    var m = (location.pathname || '').match(/^\/docs\/integrations\/([a-z0-9-]+)/);
    if (m) {
      firePlausible('Integration View', { exchange: m[1], source: 'direct' }, 10);
    }
  }

  function wireOnLoad() {
    refresh();
    detectAIReferrer();
    detectAICampaign();
    detectIntegrationView();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireOnLoad);
  } else {
    wireOnLoad();
  }

  // DESIGN-W7 H-PR1 + Q-W7-4: hero-counter + 4-stat row 3s refresh cadence.
  // Mr.1 ratification: "Refresh every 3s based on total calls (both hold & trade calls)".
  // refresh() polls /api/performance-public + /api/merkle-batches and updates ALL data-tr-field
  // spans (existing W3+W5+W6 fields + new total_calls_executed). 3s cadence is hero-friendly
  // and matches Mr.1's Live counter UX expectation.
  setInterval(refresh, 3000);
})();
