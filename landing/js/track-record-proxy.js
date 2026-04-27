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
 * Supported fields:
 *   - pfe_wr        → "89.4%" (rounded to 1 decimal, % suffix)
 *   - signal_count  → "56,375" (locale-formatted with thousands separators)
 *   - batch_count   → "16" (integer, no commas — small numbers)
 *   - last_updated  → "2026-04-26" (ISO date) or "26 Apr 2026" (localised)
 *   - hold_rate     → "98.2%" (rounded to 1 decimal, % suffix; computed
 *                     server-side as totalHolds / (totalHolds + totalSignals)
 *                     × 100 — see src/index.ts:/api/performance-public for the
 *                     server-side formula. WEBSITE-REFRESH-CLEANUP-W1 R2.)
 *
 * Live snapshot at deploy time (initial-render fallback if fetch fails BEFORE
 * any cache hit):
 *   - pfeWinRate: 0.8945  (89.4%)
 *   - totalSignals: 56,375
 *   - batches: 16 (latest batch_id; published 2026-04-26T00:05:04Z)
 *
 * Endpoint contract (verified 2026-04-26):
 *   GET /api/performance-public →
 *   {
 *     "totalSignals": 56375,
 *     "period": { "from": "2026-04-10", "to": "2026-04-26" },
 *     "overall": {
 *       "totalSignals": 56375,
 *       "totalEvaluated": 55935,
 *       "pfeWinRate": 0.8944846697059087
 *     },
 *     "bySignalType": { ... },
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
      var n = perf && perf.totalSignals;
      // /api/performance-public#period.to is the most recent date covered by
      // the rolling-window evaluation (effectively "live data refreshed up to
      // YYYY-MM-DD"). Used by C7 GEO last_updated recency signal.
      var to = perf && perf.period && perf.period.to;
      var holdRate = perf && perf.hold_rate;
      setField('pfe_wr', formatPfe(rate));
      setField('signal_count', formatCount(n));
      setField('hold_rate', formatPercent(holdRate));
      if (to) setField('last_updated', formatDate(to));
    }).catch(function (err) {
      // Silent — fallback static text remains visible. Console.debug-only so
      // ad-blockers / network failures don't spam the user's console.
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[track-record-proxy] perf fetch failed:', err.message || err);
      }
    });

    fetchJson(MERKLE_URL).then(function (data) {
      var n = data && Array.isArray(data.batches) ? data.batches.length : null;
      setField('batch_count', formatCount(n));
    }).catch(function (err) {
      if (typeof console !== 'undefined' && console.debug) {
        console.debug('[track-record-proxy] merkle fetch failed:', err.message || err);
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
})();
