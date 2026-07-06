/**
 * OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1 (2026-07-06): the bridged 🔁 TG bot line.
 * `deriveTgBot` (pure freshness mapping) + the renderer's fresh/stale/missing branches.
 */
import { describe, expect, it } from 'vitest';
import { deriveTgBot, TG_BOT_STALE_MS } from '../src/lib/analytics.js';
import { formatAgentActivity } from '../src/lib/agent-activity-format.js';

const NOW = Date.parse('2026-07-06T08:00:00+00:00'); // a fixed "main digest 08:00 UTC"

describe('deriveTgBot — freshness mapping', () => {
  it('returns null for a missing row (renderer omits the line)', () => {
    expect(deriveTgBot(undefined, NOW)).toBeNull();
  });

  it('maps a fresh row (bot digest ~5h ago) → present, not stale, fields projected', () => {
    const tg = deriveTgBot(
      {
        metric_date: '2026-07-06',
        calls_total: '23',
        calls_watch: '19',
        calls_scanwatch: '3',
        calls_scan: '1',
        subscribers: '21',
        generated_at: '2026-07-06 03:00:00.5+00', // PG timestamptz text, ~5h before NOW
      },
      NOW,
    );
    expect(tg).toMatchObject({
      present: true,
      stale: false,
      calls_total: 23,
      calls_watch: 19,
      calls_scanwatch: 3,
      calls_scan: 1,
      subscribers: 21,
    });
  });

  it('flags stale when the row is older than the 26h threshold (skipped bot digest)', () => {
    const gen = new Date(NOW - (TG_BOT_STALE_MS + 60_000)).toISOString();
    expect(deriveTgBot({ subscribers: '5', generated_at: gen }, NOW)).toMatchObject({ present: true, stale: true });
  });

  it('is fresh right at the boundary (age just under 26h)', () => {
    const gen = new Date(NOW - (TG_BOT_STALE_MS - 60_000)).toISOString();
    expect(deriveTgBot({ generated_at: gen }, NOW)).toMatchObject({ stale: false });
  });

  it('treats an unparseable generated_at as stale (conservative)', () => {
    expect(deriveTgBot({ generated_at: 'not-a-timestamp' }, NOW)).toMatchObject({ present: true, stale: true });
  });
});

describe('formatAgentActivity — 🔁 TG bot line', () => {
  const base = {
    externalGenuine: { free: 5, paid: 0, freeSessions: 5, paidSessions: 0 },
    externalAutomated: { total: 427, sessions: 28 },
    rawConcentration: { top1_pct: 19.4 },
    topAssetsGenuine: [{ asset: 'BTC', calls: 5 }],
  };

  it('renders the fresh TG bot calls + subscribers lines in the right slots', () => {
    const out = formatAgentActivity({
      ...base,
      tgBot: { present: true, stale: false, calls_total: 23, calls_watch: 19, calls_scanwatch: 3, calls_scan: 1, subscribers: 21 },
    });
    expect(out).toBe(
      [
        '🤖 *Agent Activity (24h)*',
        '• 🟢 Recognized clients: 5',
        '• 🔌 Raw API clients: 427   (top IP 19.4%)',
        '• 💳 Paid (x402 / a2mcp): 0',
        '• 🔁 TG bot: 23   (Watch 19 · Scanwatch 3 · Scan 1)',
        '• Top assets (24h): BTC',
        '',
        '👥 *Sessions (24h)*',
        '• 🟢 Recognized clients: 5',
        '• 🔌 Raw API clients: 28',
        '• 💳 Paid: 0',
        '• 🔁 TG bot: 21 subscribers',
      ].join('\n'),
    );
  });

  it('renders "metrics stale" on both blocks when the row is stale', () => {
    const out = formatAgentActivity({ ...base, tgBot: { present: true, stale: true, calls_total: 99, subscribers: 99 } });
    expect((out.match(/🔁 TG bot: — \(metrics stale\)/g) ?? []).length).toBe(2);
    expect(out).not.toContain('99'); // stale numbers never rendered
  });

  it('omits both TG bot lines when the bridge row is missing (fail-open)', () => {
    const out = formatAgentActivity(base); // no tgBot
    expect(out).not.toContain('TG bot');
    expect(out).toContain('• 💳 Paid (x402 / a2mcp): 0');
    expect(out).toContain('👥 *Sessions (24h)*');
    expect(out.length).toBeLessThanOrEqual(4096);
  });
});
