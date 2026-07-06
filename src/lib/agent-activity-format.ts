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
 *   💳 Paid (x402/a2mcp)  = any non-free non-internal tier (externalGenuine.paid)
 *   🔁 TG bot             = the algovault-bot's OWN daily metric, bridged via shared Postgres
 *                           (`tgBot`, from bot_daily_metrics) — Watch/Scanwatch/Scan + subscribers
 * plus a mirrored per-channel Sessions block. The "top IP %" concentration sits on the
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
 * Graceful-degrade: any absent field → '—'; `rawConcentration` falls back to the legacy
 * `externalConcentration`, and `topAssetsGenuine` to `topAssets`, so a digest fired during
 * the rollout window (before the /analytics deploy lands) still renders instead of throwing.
 */
export function formatAgentActivity(a: Record<string, unknown>): string {
  const num = (v: unknown, fallback: number | string = '—'): number | string =>
    typeof v === 'number' ? v : fallback;
  const genuine = (a.externalGenuine ?? {}) as Record<string, unknown>;
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

  return [
    '🤖 *Agent Activity (24h)*',
    `• 🟢 Recognized clients: ${num(genuine.free)}`,
    `• 🔌 Raw API clients: ${num(automated.total)}   (top IP ${num(rawConc.top1_pct)}%)`,
    `• 💳 Paid (x402 / a2mcp): ${num(genuine.paid)}`,
    ...(tgCallsLine ? [tgCallsLine] : []),
    `• Top assets (24h): ${assetList}`,
    '',
    '👥 *Sessions (24h)*',
    `• 🟢 Recognized clients: ${num(genuine.freeSessions)}`,
    `• 🔌 Raw API clients: ${num(automated.sessions)}`,
    `• 💳 Paid: ${num(genuine.paidSessions)}`,
    ...(tgSessionsLine ? [tgSessionsLine] : []),
  ].join('\n');
}
