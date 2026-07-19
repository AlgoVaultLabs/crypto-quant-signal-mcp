/**
 * OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1 (2026-07-03) · relabelled by
 * OPS-DIGEST-CHANNEL-LABELS-W1 (2026-07-06): golden-output tests for the digest renderer
 * `formatAgentActivity` (pure fn — no DB, always runs).
 *
 * The DB-dependent tests (logRequest is_automated stamp + getUsageStats split math +
 * per-channel session reconcile) live in tests/analytics-external-only.test.ts — the repo's
 * SINGLE external-row-writing file — so they run sequentially there and never race the
 * shared SQLite DB.
 */
import { describe, expect, it } from 'vitest';
import { formatAgentActivity } from '../src/lib/agent-activity-format.js';

describe('formatAgentActivity — digest renderer golden output (channel labels)', () => {
  it('renders the neutral channel-label calls block + Sessions block (no internal line)', () => {
    const payload = {
      totalCallsInternal: { last24h: 2036 }, // retained in payload, intentionally NOT rendered
      externalGenuine: { total: 104, free: 100, paid: 4, sessions: 61, freeSessions: 55, paidSessions: 3 },
      externalAutomated: { total: 965, sessions: 40 },
      externalConcentration: { top1_pct: 10.8, top5_pct: 46.9 }, // legacy all-external (kept, not used)
      rawConcentration: { top1_pct: 22.5, top5_pct: 60.0 }, // Raw-bucket concentration → digest
      topAssetsGenuine: [
        { asset: 'BTC', calls: 40 },
        { asset: 'ETH', calls: 12 },
        { asset: 'SOL', calls: 8 },
      ],
    };
    expect(formatAgentActivity(payload)).toBe(
      [
        '🤖 *Agent Activity (24h)*',
        '• Total Agent Calls: 1069', // 100 + 965 + 4 (no TG bot in this payload)
        '• 🟢 Recognized clients: 100',
        '• 🔌 Raw API clients: 965   (top IP 22.5%)',
        '• 💳 Paid: 4', // OPS-DIGEST-PAID-RAIL-SPLIT-W1: bare total — no rail split in this payload
        '• Top assets (24h): BTC, ETH, SOL',
        '',
        '👥 *Sessions (24h)*',
        '• Total Unique Sessions: 98', // 55 + 40 + 3
        '• 🟢 Recognized clients: 55',
        '• 🔌 Raw API clients: 40',
        '• 💳 Paid: 3',
      ].join('\n'),
    );
  });

  it('drops the removed "Internal bot" + judgmental "Genuine/Automated/crawler" framing, renders no deferred TG-bot line', () => {
    const out = formatAgentActivity({
      externalGenuine: { free: 1, paid: 0, freeSessions: 1, paidSessions: 0 },
      externalAutomated: { total: 2, sessions: 2 },
      rawConcentration: { top1_pct: 50 },
    });
    expect(out).not.toContain('Internal bot');
    expect(out).not.toContain('Genuine');
    expect(out).not.toContain('Automated');
    expect(out).not.toContain('crawler');
    expect(out).not.toContain('TG bot'); // deferred to OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1
    expect(out).not.toContain('caller-sessions');
    expect(out.length).toBeLessThanOrEqual(4096);
  });

  it('prefers rawConcentration but falls back to externalConcentration when the new field is absent', () => {
    expect(
      formatAgentActivity({ externalAutomated: { total: 10 }, rawConcentration: { top1_pct: 33.3 }, externalConcentration: { top1_pct: 5 } }),
    ).toContain('(top IP 33.3%)');
    // rollout-window payload (pre-deploy /analytics has no rawConcentration yet)
    expect(
      formatAgentActivity({ externalAutomated: { total: 10 }, externalConcentration: { top1_pct: 7.7 } }),
    ).toContain('(top IP 7.7%)');
  });

  it('graceful-degrades to em-dash + legacy topAssets when new fields are absent', () => {
    const legacy = { totalCallsInternal: { last24h: 5 }, topAssets: [{ asset: 'BTC', calls: 3 }] };
    const out = formatAgentActivity(legacy);
    expect(out).toContain('• 🟢 Recognized clients: —');
    expect(out).toContain('• 🔌 Raw API clients: —   (top IP —%)');
    expect(out).toContain('• 💳 Paid: —');
    expect(out).toContain('• Top assets (24h): BTC');
    expect(out).toContain('👥 *Sessions (24h)*');
  });

  it('renders 0 (not em-dash) for zero counts', () => {
    const out = formatAgentActivity({
      externalGenuine: { total: 0, free: 0, paid: 0, sessions: 0, freeSessions: 0, paidSessions: 0 },
      externalAutomated: { total: 0, sessions: 0 },
      rawConcentration: { top1_pct: 0 },
      topAssetsGenuine: [],
    });
    expect(out).toContain('• 🟢 Recognized clients: 0');
    expect(out).toContain('• 🔌 Raw API clients: 0   (top IP 0%)');
    // OPS-DIGEST-PAID-RAIL-SPLIT-W1: calls AND sessions lines both render the bare zero
    // total (this payload carries no rail split) — count them so the two stay distinguishable.
    expect(out.split('\n').filter((l) => l === '• 💳 Paid: 0')).toHaveLength(2);
    expect(out).toContain('• Top assets (24h): —');
  });
});
