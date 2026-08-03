/**
 * OPS-VENUE-DAY30-DECISION-W1 / CH3 — the alert body stops lying.
 *
 * THE DEFECT: the manual_required body said
 *   `Action required: reply PROMOTE | RETIRE | EXTEND_AGAIN`
 * telegram.ts has ONE outbound post() helper and NO inbound handler, no
 * webhook, no getUpdates poller — so replying had never done anything. Worse,
 * EXTEND_AGAIN had no implementation at all: there was no extend-venue.ts and
 * no column an extension could write to.
 *
 * These assertions render a FIXTURE and read the resulting BODY. Grepping the
 * source would only prove a string exists somewhere in the module, not that it
 * reaches the message — and calling sendVenueStatusChange() asserts nothing,
 * because isConfigured() short-circuits without a bot token. That is exactly
 * the OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH2 lesson: a canary rendering entity
 * IDs must assert the rendered body, and the assertion must be proven able to
 * fail (see the CH3 red-verify in the wave gate).
 */
import { describe, it, expect } from 'vitest';
import { renderVenueStatusChange, mdValue } from '../../src/lib/telegram.js';
import type { VenueStatusChangeAlert } from '../../src/lib/telegram.js';

const CTR = process.env.ALGOVAULT_APP_CONTAINER || 'crypto-quant-signal-mcp-mcp-server-1';

/** WEEX's real live shape at wave time. */
function alert(o: Partial<VenueStatusChangeAlert> = {}): VenueStatusChangeAlert {
  return {
    venue: 'WEEX',
    action: 'manual_required',
    pfe_wr: 0.9515,
    buy_sell_count: 3412,
    min_buy_sell_sample: 7230,
    days_since: 53,
    extension_count: 1,
    next_review_at: '2026-08-10T06:00:00.000Z',
    deferral_count: 1,
    escalated: false,
    ...o,
  };
}

describe('CH3 — the fictional instruction is gone', () => {
  it('never INSTRUCTS a reply, in any action', () => {
    // Ban the instruction SHAPE, not the word: the honest disclaimer below
    // legitimately contains "reply", and a naive /\breply\b/ ban would demand
    // the deletion of the single most useful line in the body. Same trap as a
    // ban-grep matching the comment that documents the ban.
    for (const action of ['manual_required', 'extended', 'promoted'] as const) {
      const b = renderVenueStatusChange(alert({ action }));
      expect(b).not.toMatch(/reply\s+(PROMOTE|RETIRE|EXTEND)/i);
      expect(b).not.toContain('Action required:');
    }
  });

  it('mentions "reply" ONLY in the disclaimer saying replies are not read', () => {
    const b = renderVenueStatusChange(alert());
    const mentions = b.split('\n').filter(l => /\breply\b/i.test(l));
    expect(mentions).toEqual(['No reply to this message is read — this bot has no inbound handler.']);
  });

  it('never renders EXTEND_AGAIN', () => {
    expect(renderVenueStatusChange(alert())).not.toContain('EXTEND_AGAIN');
  });

  it('states plainly that no reply is read', () => {
    expect(renderVenueStatusChange(alert()))
      .toContain('No reply to this message is read — this bot has no inbound handler.');
  });
});

describe('CH3 — the three commands that actually exist', () => {
  const body = () => renderVenueStatusChange(alert());

  it('renders all three, each with the real container and the real venue id', () => {
    for (const script of ['promote-venue.js', 'retire-venue.js', 'extend-venue.js']) {
      expect(body()).toContain(`docker exec ${CTR} node dist/scripts/${script} WEEX`);
    }
  });

  it('gives EXTEND its --days argument (the flag extend-venue.ts requires)', () => {
    expect(body()).toContain(`dist/scripts/extend-venue.js WEEX --days <N>`);
  });

  it('renders the ssh line operators actually need', () => {
    expect(body()).toContain('ssh -i ~/.ssh/algovault_deploy root@204.168.185.24');
  });

  it('substitutes the venue id per-venue — not a hardcoded WEEX', () => {
    const b = renderVenueStatusChange(alert({ venue: 'EDGEX' }));
    expect(b).toContain(`dist/scripts/retire-venue.js EDGEX`);
    expect(b).not.toContain('WEEX');
  });

  it('never renders a placeholder container or venue token', () => {
    const b = body();
    for (const placeholder of ['<CTR>', '<VENUE>', '<CONTAINER>', 'undefined', 'null']) {
      expect(b).not.toContain(placeholder);
    }
  });

  it('carries the venue id WITH its noun, never bare', () => {
    // "renders the venue id without its noun" is a named CH3 failure mode:
    // a bare identifier next to a count reads as a quantity.
    const b = body();
    expect(b).toMatch(/PROMOTE venue `WEEX`/);
    expect(b).toMatch(/RETIRE venue `WEEX`/);
    expect(b).toMatch(/EXTEND venue `WEEX`/);
  });
});

describe('CH3 — Markdown safety (D-8: legacy parse mode has NO escape syntax)', () => {
  it('wraps every underscore-bearing value in a code span', () => {
    const b = renderVenueStatusChange(alert());
    // Every ssh/docker/ISO value must sit inside backticks. Outside code spans
    // an odd underscore count opens an entity that never closes and the whole
    // POST 400s — the exact failure that cost three weeks of silent digests.
    const outsideCodeSpans = b.replace(/`[^`]*`/g, '');
    expect(outsideCodeSpans).not.toContain('_');
  });

  it('balances its backticks', () => {
    expect((renderVenueStatusChange(alert()).match(/`/g) ?? []).length % 2).toBe(0);
  });

  it('never nests a code span inside bold — the legacy parser cannot do it', () => {
    const b = renderVenueStatusChange(alert({ escalated: true, deferral_count: 3 }));
    for (const line of b.split('\n')) {
      const boldSegments = line.match(/\*[^*]+\*/g) ?? [];
      for (const seg of boldSegments) expect(seg).not.toContain('`');
    }
  });

  it('routes interpolated values through mdValue rather than re-implementing it', () => {
    expect(renderVenueStatusChange(alert())).toContain(mdValue('WEEX'));
  });

  it('survives an adversarial venue id without leaking a stray entity', () => {
    const b = renderVenueStatusChange(alert({ venue: 'A_B*C' }));
    expect(b.replace(/`[^`]*`/g, '')).not.toMatch(/[_]/);
    expect(b).toContain(mdValue('A_B*C'));
  });
});

describe('CH3 — the self-throttle is stated, and escalation leads', () => {
  it('renders the next auto re-ask date', () => {
    expect(renderVenueStatusChange(alert()))
      .toContain('Next auto re-ask: `2026-08-10T06:00:00.000Z`');
  });

  it('omits the re-ask line when there is no deadline (rather than printing undefined)', () => {
    const b = renderVenueStatusChange(alert({ next_review_at: undefined }));
    expect(b).not.toContain('Next auto re-ask');
    expect(b).not.toContain('undefined');
  });

  it('leads with the escalation once escalated, naming the count', () => {
    const b = renderVenueStatusChange(alert({ escalated: true, deferral_count: 3 }));
    expect(b.split('\n')[0]).toContain('ESCALATION');
    expect(b.split('\n')[0]).toContain('deferred 3 times');
  });

  it('does NOT escalate below the threshold — renders nothing about it', () => {
    expect(renderVenueStatusChange(alert({ escalated: false, deferral_count: 2 })))
      .not.toContain('ESCALATION');
  });
});

describe('CH3 — non-manual actions are unchanged', () => {
  it('extended/promoted bodies carry no command block at all', () => {
    for (const action of ['extended', 'promoted'] as const) {
      const b = renderVenueStatusChange(alert({ action }));
      expect(b).not.toContain('docker exec');
      expect(b).not.toContain('Decide —');
      expect(b).not.toContain('No reply to this message is read');
    }
  });

  it('keeps the pre-existing stat lines verbatim', () => {
    const b = renderVenueStatusChange(alert({ action: 'extended' }));
    expect(b).toContain('PFE Win Rate: 95.2%');
    expect(b).toContain('BUY+SELL sample: 3412 / 7230');
    expect(b).toContain('Days since integration: 53');
    expect(b).toContain('Extensions used: 1 / 2');
  });

  it('still renders "n/a" for a null WR', () => {
    expect(renderVenueStatusChange(alert({ pfe_wr: null })))
      .toContain('PFE Win Rate: n/a (no Phase-E outcomes yet)');
  });
});
