/**
 * OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1 (2026-07-03) · relabelled by
 * OPS-DIGEST-CHANNEL-LABELS-W1 (2026-07-06) · 🔁 TG bot line restored by
 * OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1 (2026-07-06): pure renderer for the daily Telegram
 * digest's "🤖 Agent Activity" section.
 *
 * Extracted from `src/scripts/monitor.ts` (which runs `main()` on import → not
 * test-importable) so the layout is golden-testable in isolation. Consumes the
 * `getUsageStats()` / `/analytics` payload and renders neutral channel/client labels
 * (measurement clarity, NOT gating — Mr.1: free traffic stays wide-open):
 *   🟢 Recognized clients = free-tier, not isbot-flagged (externalGenuine.free)
 *   🔌 Raw API clients    = free-tier, isbot-flagged bare-SDK/HTTP UAs (externalAutomated)
 *   💳 Paid               = any non-free non-internal tier (externalGenuine.paid), broken
 *                           down BY PAYMENT RAIL — `subscription` (Stripe starter/pro/
 *                           enterprise) vs `x402/a2mcp` (pay-per-call). Rails come from the
 *                           one canonical map in payment-rail.ts. Pre-OPS-DIGEST-PAID-RAIL-
 *                           SPLIT-W1 this line was labelled "Paid (x402 / a2mcp)" while
 *                           counting ANY paid tier — it read 162 on 2026-07-19 with the x402
 *                           rail at zero settlements, i.e. the label named two rails that
 *                           contributed nothing. The breakdown is OMITTED (bare total) when
 *                           the split fields are absent, so a digest fired during the
 *                           rollout window still renders.
 *   🔁 TG bot             = the algovault-bot's OWN daily metric, bridged via shared Postgres
 *                           (`tgBot`, from bot_daily_metrics) — Watch/Scanwatch/Scan + subscribers
 * plus a mirrored per-channel Sessions block. The "top client %" concentration sits on the
 * 🔌 Raw API clients line (where a poller surge shows), sourced from `rawConcentration`.
 * Top assets are the genuine (recognized+paid) slice, so bot-BTC-polling never dominates.
 *
 * 🔁 TG bot freshness (resolved upstream in getUsageStats::deriveTgBot; renderer just projects):
 *   fresh (present, not stale)  → `🔁 TG bot: {calls} (Watch w · Scanwatch sw · Scan sc)` + `{subs} subscribers`
 *   stale (row > ~26h old)      → `🔁 TG bot: — (metrics stale)` (a skipped 03:00 bot digest)
 *   missing (no row / no bridge)→ the line is OMITTED (fail-open — a missing bot row must NEVER
 *                                 crash or block the main digest).
 * The raw `tier=internal` polling count is NOT shown here (it's the bot's alert-engine noise,
 * covered by the bot's own digest); `totalCallsInternal` stays in the payload, unrendered.
 *
 * OPS-TOP-IP-FORENSICS-W1 (2026-07-31) — the block now LEADS with the billable decomposition:
 *   💰 Billable / 🆓 Free-by-design HOLD / 🔎 Unmetered / ❓ Unclassified, all projected from the
 * ONE derivation in call-class.ts (which itself derives from FEATURE_REGISTRY's quota model —
 * no parallel literal). `Total Agent Calls` is PRESERVED unchanged beside them (add before you
 * remove) but is now annotated as a VOLUME figure: it counts every logged dispatch including
 * free-by-design HOLDs, so it is not a demand number.
 *
 * Why: the 2026-07-31 digest read `Total Agent Calls 3080 · Raw API clients 2955 (top IP 91.6%)`
 * and was read as one caller making ~2,707 unmetered calls. Forensics found the metering fully
 * intact — that caller's chargeable calls reconciled byte-exactly with its quota counter (67→67)
 * — and 2,819 of the 2,955 rows were HOLD verdicts, free by explicit design. The headline was
 * conflating free-by-design compute with billable demand at ~50x.
 *
 * Also relabelled: `(top IP …%)` → `(top client …%)`. The underlying `rawConcentration` query
 * groups by `session_id`, which equals the ipHash ONLY for callers sending no track token.
 *
 * Graceful-degrade: any absent field → '—'; `rawConcentration` falls back to the legacy
 * `externalConcentration`, `topAssetsGenuine` to `topAssets`, and an absent `callClasses` omits
 * the four new lines entirely, so a digest fired during the rollout window (before the
 * /analytics deploy lands) renders exactly the prior layout instead of throwing.
 */
export function formatAgentActivity(a: Record<string, unknown>): string {
  const num = (v: unknown, fallback: number | string = '—'): number | string =>
    typeof v === 'number' ? v : fallback;
  const genuine = (a.externalGenuine ?? {}) as Record<string, unknown>;
  // Per-rail breakdown for the 💳 Paid lines. Rendered ONLY when both rail counts are
  // present (a digest fired before the /analytics deploy lands degrades to the bare
  // total). An unreconciled remainder surfaces as `other N` rather than vanishing —
  // a paid tier that is neither rail must be visible, not silently dropped.
  const railSuffix = (total: unknown, subscription: unknown, x402: unknown): string => {
    if (typeof subscription !== 'number' || typeof x402 !== 'number') return '';
    const parts = [`subscription ${subscription}`, `x402/a2mcp ${x402}`];
    const other = typeof total === 'number' ? total - subscription - x402 : 0;
    if (other > 0) parts.push(`other ${other}`);
    return `   (${parts.join(' · ')})`;
  };
  const automated = (a.externalAutomated ?? {}) as Record<string, unknown>;
  // Concentration re-scoped to the Raw bucket; fall back to the legacy all-external field.
  const rawConc = (a.rawConcentration ?? a.externalConcentration ?? {}) as Record<string, unknown>;
  const topAssets = a.topAssetsGenuine ?? a.topAssets ?? a.top_assets;
  const assetList =
    Array.isArray(topAssets) && topAssets.length > 0
      ? topAssets
          .slice(0, 5)
          .map((t: Record<string, unknown>) => t.asset ?? t.coin ?? t.symbol)
          .join(', ')
      : '—';

  // 🔁 TG bot (bridged bot metric). present/stale computed upstream; missing → omit both lines.
  const tgBot = (a.tgBot ?? null) as Record<string, unknown> | null;
  const tgPresent = !!tgBot && tgBot.present === true;
  const tgStale = tgPresent && tgBot!.stale === true;
  const tgCallsLine = !tgPresent
    ? null
    : tgStale
      ? '• 🔁 TG bot: — (metrics stale)'
      : `• 🔁 TG bot: ${num(tgBot!.calls_total)}   (Watch ${num(tgBot!.calls_watch)} · Scanwatch ${num(tgBot!.calls_scanwatch)} · Scan ${num(tgBot!.calls_scan)})`;
  const tgSessionsLine = !tgPresent
    ? null
    : tgStale
      ? '• 🔁 TG bot: — (metrics stale)'
      : `• 🔁 TG bot: ${num(tgBot!.subscribers)} subscribers`;

  // OPS-DIGEST-TOTALS-W1: per-block headline totals = the SUM of every channel line in the
  // block, INCLUDING the 🔁 TG bot metric (Mr.1: fold it in). Total Agent Calls = Recognized
  // + Raw + Paid + TG-bot-calls; Total Unique Sessions = the per-channel sessions +
  // TG-bot-subscribers. A stale/missing TG bot contributes 0 (its line shows "—" / is
  // omitted), so each total always equals the sum of the visible numeric lines below it.
  const asNum = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const tgFresh = tgPresent && !tgStale;
  const totalAgentCalls =
    asNum(genuine.free) + asNum(automated.total) + asNum(genuine.paid) + (tgFresh ? asNum(tgBot!.calls_total) : 0);
  const totalUniqueSessions =
    asNum(genuine.freeSessions) + asNum(automated.sessions) + asNum(genuine.paidSessions) + (tgFresh ? asNum(tgBot!.subscribers) : 0);

  // OPS-TOP-IP-FORENSICS-W1: the billable/free/unmetered decomposition, projected from the ONE
  // derivation in call-class.ts. Rendered ONLY when the field is present, so a digest fired
  // before the /analytics deploy lands degrades to exactly the prior layout (fail-open, same
  // discipline as tgBot + rawConcentration).
  const cc = (a.callClasses ?? null) as Record<string, unknown> | null;
  const ccPresent = !!cc && typeof cc.billable === 'number';
  const unclassified = ccPresent && typeof cc!.unclassified === 'number' ? (cc!.unclassified as number) : 0;
  const classLines = !ccPresent
    ? []
    : [
        `• 💰 Billable calls — Last 24h: ${num(cc!.billable)}   (${num(cc!.billableSessions)} sessions)`,
        `• 🆓 Free-by-design HOLD — Last 24h: ${num(cc!.freeHold)}`,
        `• 🔎 Unmetered (rate-limited) — Last 24h: ${num(cc!.unmetered)}`,
        // An unregistered tool_name must be VISIBLE, never folded into another class.
        ...(unclassified > 0 ? [`• ❓ Unclassified — Last 24h: ${unclassified}`] : []),
      ];

  return [
    '🤖 *Agent Activity (24h)*',
    ...classLines,
    // Add-before-remove: the pre-existing series is preserved unchanged alongside the new
    // breakdown so nobody loses continuity. NB it counts every logged dispatch — billable AND
    // free-by-design HOLD AND internal — so it is a VOLUME figure, not a demand figure.
    `• Total Agent Calls: ${totalAgentCalls}${ccPresent ? '   (all traffic incl. free HOLD)' : ''}`,
    `• 🟢 Recognized clients: ${num(genuine.free)}`,
    // "top client", not "top IP": rawConcentration groups by session_id (analytics.ts), which
    // equals the ipHash only for callers that send no X-AlgoVault-Track-Token.
    `• 🔌 Raw API clients: ${num(automated.total)}   (top client ${num(rawConc.top1_pct)}%)`,
    `• 💳 Paid: ${num(genuine.paid)}${railSuffix(genuine.paid, genuine.paidSubscription, genuine.paidX402)}`,
    ...(tgCallsLine ? [tgCallsLine] : []),
    `• Top assets (24h): ${assetList}`,
    '',
    '👥 *Sessions (24h)*',
    `• Total Unique Sessions: ${totalUniqueSessions}`,
    `• 🟢 Recognized clients: ${num(genuine.freeSessions)}`,
    `• 🔌 Raw API clients: ${num(automated.sessions)}`,
    `• 💳 Paid: ${num(genuine.paidSessions)}${railSuffix(genuine.paidSessions, genuine.paidSubscriptionSessions, genuine.paidX402Sessions)}`,
    ...(tgSessionsLine ? [tgSessionsLine] : []),
  ].join('\n');
}
