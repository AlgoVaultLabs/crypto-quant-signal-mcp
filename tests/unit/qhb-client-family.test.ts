/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH1 — both `quota_hit_block` emissions carry `client_family`, so
 * the readout's `chat_attempts_30d` can count a wall hit by family and not only by pool.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const events: Array<{ eventType: string; meta?: Record<string, unknown> }> = [];
vi.mock('../../src/lib/performance-db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/performance-db.js')>()),
  recordFunnelEvent: (e: { eventType: string; meta?: Record<string, unknown> }) => { events.push(e); },
}));

const license = await import('../../src/lib/license.js');
const { FREE_MONTHLY_CALLS, FREE_DAILY_CALLS } = await import('../../src/lib/plans.js');

let n = 0;
function freeKey() { n += 1; return { tier: 'free' as const, key: `av_free_qhbfamily${String(n).padStart(8, '0')}` }; }

function blockAs(userAgent: string, lic: ReturnType<typeof freeKey>) {
  return license.requestContext.run({ license: lic, userAgent } as never, () => license.checkQuota(lic));
}

describe('quota_hit_block carries client_family on both walls', () => {
  beforeEach(() => { events.length = 0; license._resetCallTrackersForTest(); });

  it('the daily wall', () => {
    const lic = freeKey();
    license.trackCall(lic, FREE_DAILY_CALLS);
    const r = blockAs('Claude-User/1.0 (+https://www.anthropic.com)', lic);
    expect(r.allowed).toBe(false);
    const qhb = events.filter((e) => e.eventType === 'quota_hit_block');
    expect(qhb).toHaveLength(1);
    expect(qhb[0].meta).toMatchObject({ limit: 'daily', client_family: 'claude' });
  });

  it('the monthly wall', () => {
    const lic = freeKey();
    license.trackCall(lic, FREE_MONTHLY_CALLS);
    const r = blockAs('openai-mcp/1.0.0', lic);
    expect(r.allowed).toBe(false);
    const qhb = events.filter((e) => e.eventType === 'quota_hit_block');
    expect(qhb).toHaveLength(1);
    expect(qhb[0].meta?.limit).not.toBe('daily');
    expect(qhb[0].meta).toHaveProperty('client_family', 'openai');
  });

  it('no user agent is still a family, never absent', () => {
    const lic = freeKey();
    license.trackCall(lic, FREE_MONTHLY_CALLS);
    license.requestContext.run({ license: lic } as never, () => license.checkQuota(lic));
    const qhb = events.filter((e) => e.eventType === 'quota_hit_block');
    expect(typeof qhb[0].meta?.client_family).toBe('string');
  });
});
