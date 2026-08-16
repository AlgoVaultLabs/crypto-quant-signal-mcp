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
 * OPS-TOP-IP-FORENSICS-W1 (2026-07-31) — the block carries a billing decomposition, projected
 * from the ONE derivation in call-class.ts (which itself derives from FEATURE_REGISTRY's quota
 * model — no parallel literal).
 *
 * OPS-OPERATOR-SURFACES-HOLD-RETIRE-W1 (2026-08-10) — the taxonomy, and why it changed.
 * `Total Agent Calls` now LEADS and the class lines beneath PARTITION it exactly:
 *   💰 Metered calls · 🔎 Unmetered · 🔁 Internal · [❓ Unclassified] · [🗄 legacy unbilled HOLD]
 * Every label comes from `BILLING_CLASS_LABELS`; none is typed here.
 * (🔁 Internal has since lost its line — see TG-DIGEST-INTERNAL-ROW-AND-PAID-SESSION-W1 below.)
 *
 * The old `🆓 Free-by-design HOLD` line and the `(all traffic incl. free HOLD)` annotation are
 * GONE. Since the flat-billing cutover (2026-08-08) every verdict is a metered call, HOLD
 * included, so for any 24h window that bucket is structurally zero — a permanently-empty line
 * asserting HOLD is free. No operator surface may make that claim for post-cutover traffic
 * (Mr.1 ruling, 2026-08-10). The dimension is NOT deleted: it renders, under a date-bounded
 * legacy label, whenever a window actually reaches back past the cutover and the count is > 0.
 *
 * The two conditional lines are ordered last so the steady-state render is stable: on the
 * healthy post-cutover path neither appears, and the block is exactly four lines.
 *
 * TG-DIGEST-INTERNAL-ROW-AND-PAID-SESSION-W1 (2026-08-11) — the 🔁 Internal row is DELETED, and the
 * class block now ends in a blank line, so the section reads as two blocks:
 *   call buckets   💰 Metered · 🔎 Unmetered · [❓ Unclassified] · [🗄 legacy unbilled HOLD]
 *   client rows    🟢 Recognized · 🔌 Raw API · 💳 Paid · 🔁 TG bot · Top assets
 * `🔁 Internal (algovault-bot) — Last 24h: N` rendered the SAME N as the 🔁 TG bot row two lines
 * below it, from the same expression, only without the per-command split — a duplicate under a
 * second name, which is how a reader ends up double-counting a partition. The class survives as
 * a TERM of that partition: the sum assertion reads its count out of the TG bot row, so deleting
 * the line cost the body no verifiability (and adding it back now FAILS the sum, by double-count).
 * `BILLING_CLASS_LABELS.internal` stays defined — `CallClass` includes it and `classifyCall`
 * still returns it; the map is total by type. It simply has no renderer here any more.
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
import { classLabel } from './call-class.js';

export function formatAgentActivity(a: Record<string, unknown>): string {
  const num = (v: unknown, fallback: number | string = '—'): number | string =>
    typeof v === 'number' ? v : fallback;
  const genuine = (a.externalGenuine ?? {}) as Record<string, unknown>;
  // Per-rail breakdown for the 💳 Paid lines. Rendered ONLY when both rail counts are
  // present (a digest fired before the /analytics deploy lands degrades to the bare
  // total). An unreconciled remainder surfaces as `other N` rather than vanishing —
  // a paid tier that is neither rail must be visible, not silently dropped.
  const asNumEarly = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const railSuffix = (total: unknown, subscription: unknown, x402: unknown, gap = '   '): string => {
    if (typeof subscription !== 'number' || typeof x402 !== 'number') return '';
    const parts = [`subscription ${subscription}`, `x402/a2mcp ${x402}`];
    const other = typeof total === 'number' ? total - subscription - x402 : 0;
    if (other > 0) parts.push(`other ${other}`);
    return `${gap}(${parts.join(' · ')})`;
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
  // OPS-DIGEST-TGBOT-TIER-AND-WALLED-W1: two annotations under the TG bot row.
  //  ↳ tier split — 💳 Paid counts API/MCP calls only, and bot traffic authenticates as
  //    `tier:'internal'`, so a paying subscriber's alerts can never appear there. Rendering
  //    `Paid: 0` beside 205 alerts delivered to paying users reads as "no paying customer was
  //    active", the inverse of the fact. Shown HERE, in the bot's own unit (delivered alerts),
  //    rather than folded into Paid — those are different quantities and adding them is what
  //    METERING-DIVERGENCE.md exists to forbid.
  //  ↳ walled — how many free subscribers are behind the bot's 100-alert wall RIGHT NOW, and
  //    how many of those were never told. `silent > 0` is by definition a seam defect
  //    (BOT-QUOTA-REFUSAL-SEAM-W1); in a healthy system it is always 0.
  // Both omit on a stale row: neither is a 24h counter, so a stale bridge must not render a
  // "now" claim.
  const tgPaidLinked = tgPresent && typeof tgBot!.calls_paid_linked === 'number' ? (tgBot!.calls_paid_linked as number) : null;
  const tgTierLine =
    !tgPresent || tgStale || tgPaidLinked === null
      ? null
      : `  ↳ 💳 paid-linked ${num(tgPaidLinked)} · free ${num(Math.max(0, asNumEarly(tgBot!.calls_total) - tgPaidLinked))}`;
  const tgWalled = tgPresent && typeof tgBot!.walled_now === 'number' ? (tgBot!.walled_now as number) : null;
  const tgWalledSilent = tgPresent && typeof tgBot!.walled_silent === 'number' ? (tgBot!.walled_silent as number) : 0;
  const tgWalledLine =
    !tgPresent || tgStale || tgWalled === null
      ? null
      : `  ↳ 🚧 ${num(tgWalled)} walled now (notified ${num(tgWalled - tgWalledSilent)} · silent ${num(tgWalledSilent)})`;
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
  // The bounded historical class. Post-cutover windows contain none, so the line is OMITTED
  // rather than rendered as a permanent zero under a label that asserts HOLD is free.
  const legacyFreeHold = ccPresent && typeof cc!.freeHold === 'number' ? (cc!.freeHold as number) : 0;
  // The `internal` class has NO line of its own: the 🔁 TG bot row below already renders the
  // very same number — `tgFresh ? tgBot.calls_total : 0`, the value the headline folds in — and
  // breaks it down per command. Two rows, one derivation, one of them strictly less informative.
  // The class is NOT dropped from the partition: the sum assertion reads its count out of that
  // TG bot row, so the decomposition stays verifiable against the rendered headline.
  const classLines = !ccPresent
    ? []
    : [
        // OPS-DIGEST-TGBOT-TIER-AND-WALLED-W1 (2026-08-16): the `billable` and `unmetered`
        // rows are RETIRED from the render. After the 2026-08-08 flat-billing cutover every
        // QuotaUnit maps to `always` (call-class.ts), so `billable` equals Recognized + Raw +
        // Paid exactly — the same number printed twice — and `unmetered` covers only
        // rate-limited tools, measured at 1 row in 7 days. The classes are still COMPUTED and
        // still partition the headline; they simply no longer earn two permanent rows.
        // An unregistered tool_name must remain VISIBLE, never folded into another class.
        ...(unclassified > 0 ? [`• ${classLabel('unclassified')} — Last 24h: ${unclassified}`] : []),
        // Only ever non-zero for a window reaching back past the cutover.
        ...(legacyFreeHold > 0 ? [`• ${classLabel('free_hold')} — Last 24h: ${legacyFreeHold}`] : []),
      ];

  return [
    '🤖 *Agent Activity (24h)*',
    // The headline leads, and the class lines beneath it PARTITION it exactly:
    // billable + unmetered + unclassified + legacy-free-hold (= external) + internal = Total.
    // `internal` is the one term with no line of its own — it is carried by the 🔁 TG bot row
    // further down, which is where the body-sum assertion in tests/call-class.test.ts reads it
    // from. That assertion parses THIS render rather than trusting the inputs.
    `• Total Agent Calls: ${totalAgentCalls}`,
    `• Top assets (24h): ${assetList}`,
    '',
    ...classLines,
    `• 🟢 Recognized clients: ${num(genuine.free)}`,
    // "top client", not "top IP": rawConcentration groups by session_id (analytics.ts), which
    // equals the ipHash only for callers that send no X-AlgoVault-Track-Token.
    `• 🔌 Raw API clients: ${num(automated.total)}   (top client ${num(rawConc.top1_pct)}%)`,
    // "API/MCP Calls" is load-bearing, not decoration: this row counts DIRECT API/MCP requests
    // and structurally excludes bot traffic (`is_bot_internal = false`), so an unlabelled
    // `Paid: 0` invites the reading "no paying customer was active" on a day when paying
    // subscribers took 205 alerts through the bot. The unit is now stated.
    `• 💳 Paid: ${num(genuine.paid)}   API/MCP Calls${railSuffix(genuine.paid, genuine.paidSubscription, genuine.paidX402, ' ')}`,
    ...(tgCallsLine ? ['', tgCallsLine] : []),
    ...(tgTierLine ? [tgTierLine] : []),
    ...(tgWalledLine ? [tgWalledLine] : []),
    '',
    '👥 *Sessions (24h)*',
    `• Total Unique Sessions: ${totalUniqueSessions}`,
    `• 🟢 Recognized clients: ${num(genuine.freeSessions)}`,
    `• 🔌 Raw API clients: ${num(automated.sessions)}`,
    `• 💳 Paid: ${num(genuine.paidSessions)}${railSuffix(genuine.paidSessions, genuine.paidSubscriptionSessions, genuine.paidX402Sessions)}`,
    ...(tgSessionsLine ? [tgSessionsLine] : []),
  ].join('\n');
}
