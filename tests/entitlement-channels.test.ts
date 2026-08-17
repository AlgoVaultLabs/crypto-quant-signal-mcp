/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH1 — the channel billing policy SoT.
 *
 * Placed FLAT in tests/, beside its subjects' neighbours: feature-registry.test.ts,
 * x402-idempotency-store's suite and the webhook-* files are all flat (Step-0 probe P5).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHANNEL_BILLING_POLICY,
  asChannelId,
  policyFor,
  type ChannelId,
} from '../src/lib/entitlement-channels.js';
import { FEATURE_REGISTRY } from '../src/lib/feature-registry.js';

describe('CHANNEL_BILLING_POLICY — key-set identity with feature-registry, both directions', () => {
  const registryKeys = new Set<string>();
  for (const f of Object.values(FEATURE_REGISTRY as Record<string, { channels?: Record<string, unknown> }>)) {
    for (const k of Object.keys(f.channels ?? {})) registryKeys.add(k);
  }

  it('every registry channel has a policy', () => {
    expect(registryKeys.size).toBeGreaterThanOrEqual(6); // vacuity guard
    for (const k of registryKeys) {
      expect(CHANNEL_BILLING_POLICY, `${k} is in feature-registry but has no policy`).toHaveProperty(k);
    }
  });

  it('every policy names a channel the registry still has — a stale entry is a permission slip', () => {
    for (const k of Object.keys(CHANNEL_BILLING_POLICY)) {
      expect(registryKeys, `${k} has a policy but no registry channel`).toContain(k);
    }
  });

  it('every entry carries a non-trivial rationale — the prose is the point, not decoration', () => {
    for (const [k, p] of Object.entries(CHANNEL_BILLING_POLICY)) {
      expect(p.rationale.length, `${k}'s rationale is too thin to explain anything`).toBeGreaterThan(80);
    }
  });
});

describe('the ratified asymmetry is DECLARED, not hardcoded at a call site', () => {
  it('bot refuses at the wall (architect R-1); mcp does not', () => {
    expect(policyFor('bot').refusesAtWall).toBe(true);
    expect(policyFor('mcp').refusesAtWall).toBe(false);
  });

  it('mcp is request-context; bot and webhook are by-key; x402 is settled', () => {
    expect(policyFor('mcp').debitMode).toBe('request-context');
    expect(policyFor('bot').debitMode).toBe('by-key');
    expect(policyFor('webhook').debitMode).toBe('by-key');
    expect(policyFor('httpX402').debitMode).toBe('settled');
  });

  it('undecided channels are `none` — declared, never silently defaulted onto a plan', () => {
    expect(policyFor('a2mcp').debitMode).toBe('none');
    expect(policyFor('acp').debitMode).toBe('none');
  });

  it("mcp's rationale names the follow-up wave, so the decision is findable", () => {
    expect(policyFor('mcp').rationale).toContain('PRICING-PAID-HARD-WALL-W1');
  });
});

describe('asChannelId — default-deny', () => {
  it('narrows every real channel', () => {
    for (const k of Object.keys(CHANNEL_BILLING_POLICY)) expect(asChannelId(k)).toBe(k);
  });

  it('refuses anything else, with no fallback channel', () => {
    // A fallback here would let a typo'd or hostile `channel` field debit somebody's plan
    // through whichever policy happened to be default.
    for (const bad of ['discord', 'MCP', '', 'bot ', null, undefined, 42, {}, ['bot']]) {
      expect(asChannelId(bad), `${JSON.stringify(bad)} must not narrow`).toBeNull();
    }
  });

  it('is not fooled by inherited Object properties', () => {
    // `'constructor' in obj` is true for every object — a naive `in` check would admit it.
    for (const proto of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(asChannelId(proto)).toBeNull();
    }
  });
});

describe('the module stays a leaf', () => {
  it('imports no runtime module — importing license.ts would invert the dependency', () => {
    const src = readFileSync(join(__dirname, '../src/lib/entitlement-channels.ts'), 'utf8');
    const imports = [...src.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);
  });

  it('holds no allowance NUMBER — those live in plans.ts', () => {
    const src = readFileSync(join(__dirname, '../src/lib/entitlement-channels.ts'), 'utf8');
    // Strip the rationale prose, which legitimately cites measured figures as evidence.
    const code = src.replace(/rationale:[\s\S]*?',\n/g, '');
    expect(code).not.toMatch(/\b\d{3,}\b/);
  });
});
