/**
 * OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1 (2026-07-03) · relabelled by
 * OPS-DIGEST-CHANNEL-LABELS-W1 (2026-07-06): pure renderer for the daily Telegram
 * digest's "🤖 Agent Activity" section.
 *
 * Extracted from `src/scripts/monitor.ts` (which runs `main()` on import → not
 * test-importable) so the layout is golden-testable in isolation. Consumes the
 * `getUsageStats()` / `/analytics` payload and renders neutral channel/client labels
 * (measurement clarity, NOT gating — Mr.1: free traffic stays wide-open):
 *   🟢 Recognized clients = free-tier, not isbot-flagged (externalGenuine.free)
 *   🔌 Raw API clients    = free-tier, isbot-flagged bare-SDK/HTTP UAs (externalAutomated)
 *   💳 Paid (x402/a2mcp)  = any non-free non-internal tier (externalGenuine.paid)
 * plus a mirrored per-channel Sessions block. The "top IP %" concentration sits on the
 * 🔌 Raw API clients line (where a poller surge shows), sourced from `rawConcentration`.
 * Top assets are the genuine (recognized+paid) slice, so bot-BTC-polling never dominates.
 *
 * REMOVED (OPS-DIGEST-CHANNEL-LABELS-W1, Mr.1 revision): the raw "🔁 Internal bot"
 * (tier=internal) line — that ~3.5k/day is the algovault-bot's own alert-engine polling,
 * covered by the SEPARATE `Algovault-Telegram-bot — Daily Digest`. A `🔁 TG bot` line
 * (Watch/Scanwatch/Scan + subscribers) sourced from the bot's own metric is DEFERRED to
 * `OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1` (the bot metric lives in the bot's private SQLite,
 * not readable from monitor.ts's container — see the wave endpoint-truth R0b). The
 * `totalCallsInternal` /analytics field is retained (additive) but no longer rendered.
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
  return [
    '🤖 *Agent Activity (24h)*',
    `• 🟢 Recognized clients: ${num(genuine.free)}`,
    `• 🔌 Raw API clients: ${num(automated.total)}   (top IP ${num(rawConc.top1_pct)}%)`,
    `• 💳 Paid (x402 / a2mcp): ${num(genuine.paid)}`,
    `• Top assets (24h): ${assetList}`,
    '',
    '👥 *Sessions (24h)*',
    `• 🟢 Recognized clients: ${num(genuine.freeSessions)}`,
    `• 🔌 Raw API clients: ${num(automated.sessions)}`,
    `• 💳 Paid: ${num(genuine.paidSessions)}`,
  ].join('\n');
}
