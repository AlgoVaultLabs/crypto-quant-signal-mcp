/**
 * `planPriceLabel` refuses for a contact-sales plan, and no caller can render the refusal.
 * OPS-PLANS-PUBLIC-ENTERPRISE-DEPRICE-W1 CH3.
 *
 * THE STRUCTURAL TWIN. CH1 stopped `/api/plans/public` publishing Enterprise's `299`. But
 * `planPriceLabel` was the ONLY price helper in `plans.ts` with no null branch — every sibling
 * (`planPrepayPriceLabel`, `planPrepayTotalUsd`, `planPrepayMonthlyRateUsd`, `planDailyCallsLabel`)
 * already returned null as a REFUSAL — and it returned `"$299"` for enterprise. Same loaded gun,
 * different door: the next surface to call it for enterprise re-publishes the number that
 * `brand-facts.md:552` lists as a HIGH-severity forbidden phrase.
 *
 * 🛑 TSC DOES NOT GUARD THIS, and that is why the call-site test below exists. Widening the return
 * to `string | null` compiles clean at every existing call site because they all interpolate into
 * a template literal, and TypeScript is happy to render `null` there. So the type system will not
 * stop someone adding `planPriceLabel('enterprise')` to a page — it would emit the literal text
 * "null" into public copy. The enumeration test is the actual control.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLANS, planPriceLabel, planPublishesSelfServePrice, CONTACT_SALES_PLANS, type PaidPlanId,
} from '../../src/lib/plans.js';

const ROOT = join(__dirname, '..', '..');

describe('planPriceLabel — null is a REFUSAL', () => {
  it('enterprise publishes no self-serve price', () => {
    expect(planPriceLabel('enterprise')).toBeNull();
    expect(planPublishesSelfServePrice('enterprise')).toBe(false);
  });

  it('the self-serve tiers are UNCHANGED — the other direction', () => {
    // Without this, "returns null" is satisfiable by a helper that returns null for everything.
    expect(planPriceLabel('starter')).toBe('$9.99');
    expect(planPriceLabel('pro')).toBe('$49');
    expect(planPublishesSelfServePrice('starter')).toBe(true);
    expect(planPublishesSelfServePrice('pro')).toBe(true);
  });

  it('trailing .00 is still never emitted', () => {
    expect(planPriceLabel('pro')).not.toContain('.00');
  });

  it('the refusal is declared, and every plan is decided one way or the other', () => {
    expect([...CONTACT_SALES_PLANS]).toEqual(['enterprise']);
    for (const id of Object.keys(PLANS) as PaidPlanId[]) {
      expect(planPriceLabel(id) === null, id).toBe(CONTACT_SALES_PLANS.includes(id));
    }
  });

  it('the ENFORCEMENT value is untouched — only the rendered price refuses', () => {
    // brand-facts forbids PUBLISHING the figure; Stripe still needs the Price for in-flight
    // subscriptions, and license.ts still enforces the quota. Enforcement is not the offer.
    expect(PLANS.enterprise.priceUsdMonthly).toBe(299);
    expect(PLANS.enterprise.monthlyCalls).toBe(100_000);
  });
});

describe('no caller can render the refusal — the control tsc cannot provide', () => {
  /** Every `planPriceLabel(<arg>)` call in shipped code, with its literal argument text. */
  const callSites = (): Array<{ file: string; line: number; arg: string }> => {
    const out: Array<{ file: string; line: number; arg: string }> = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
        const full = join(dir, e);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|mjs|js)$/.test(e) || /\.test\.|\.d\.ts$/.test(e)) continue;
        readFileSync(full, 'utf8').split('\n').forEach((l, i) => {
          // Skip the definition itself and any mention inside a comment — "a mention in a comment
          // is not an invocation" is a rule this repo's own gates already follow.
          if (/^\s*(\*|\/\/)/.test(l)) return;
          for (const m of l.matchAll(/planPriceLabel\(([^)]*)\)/g)) {
            if (/^export function/.test(l)) return;
            out.push({ file: full.slice(ROOT.length + 1), line: i + 1, arg: m[1].trim() });
          }
        });
      }
    };
    walk(join(ROOT, 'src'));
    walk(join(ROOT, 'scripts'));
    return out;
  };

  it('finds the call sites at all (vacuity guard)', () => {
    // A walker that silently matched nothing would make the assertion below trivially true —
    // the exact shape this wave has already had to repair once.
    expect(callSites().length).toBeGreaterThan(4);
  });

  /** Arguments provable safe from the call site alone. */
  const SAFE_ARGS = new Set(["'starter'", "'pro'", '"starter"', '"pro"', 'DEFAULT_UPGRADE_PLAN']);

  /** A call site's identity: the file plus the ARGUMENT EXPRESSION it passes. */
  const siteKey = (c: { file: string; arg: string }): string => `${c.file}::${c.arg}`;

  /**
   * PARAMETERISED call sites, each carrying the binding that makes it safe.
   *
   * A textual scan cannot see an enclosing binding, so each row below is declared rather than
   * inferred — the same shape as `bare_token_allowlist` and the served-surface registry's
   * `coverage_reason`: a declared exemption with a reason is fine, an undeclared one is not.
   * Each was traced to a literal before being listed here.
   *
   * 🛑 KEYED BY CALL SITE, NOT BY FILE, and the difference is the whole control. This record used
   * to be `Record<file, reason>` and the lookup `!DECLARED_PARAMETERISED[c.file]`, which exempted
   * `src/lib/signup-flow.ts` WHOLESALE — the file that renders the public pricing cards. A future
   * `planPriceLabel('enterprise')` added anywhere in it would have passed silently and emitted the
   * literal text "null" into public copy, which is the exact defect this file exists to prevent.
   * `callSites()` already collected `arg` and then discarded it at the lookup.
   *
   * The key is `<file>::<argument expression>`. A LINE NUMBER would go stale on any edit above it;
   * the argument expression is stable, and it is what the reason is actually about — so two call
   * sites in one file passing the same binding share one row, and a call site passing anything
   * else is a new, undeclared one.
   */
  const DECLARED_PARAMETERISED: Record<string, string> = {
    'src/lib/nudge-copy.ts::id': 'upgradeOfferPhrase() binds `const id = DEFAULT_UPGRADE_PLAN`, which is asserted self-serve below.',
    'src/lib/signup-flow.ts::id': 'prepayPriceBlock(id) is module-private and renderPlanCards() calls it only with the literals starter and pro — asserted below, not trusted.',
  };

  it('every shipped call site passes an id that PUBLISHES a price', () => {
    // Measured at CH3. A parameterised call reaching this helper with a contact-sales id would
    // render the literal text "null" into public copy, and tsc would not say a word — because
    // every call site interpolates into a template literal, where `string | null` compiles clean.
    // This is the assertion that would.
    const risky = callSites().filter((c) => !SAFE_ARGS.has(c.arg) && !DECLARED_PARAMETERISED[siteKey(c)]);
    expect(
      risky,
      'a planPriceLabel() call whose argument this test cannot prove is a self-serve plan. Either '
      + 'pass a literal, declare the binding in DECLARED_PARAMETERISED with a reason, or have the '
      + 'caller OMIT the price when planPublishesSelfServePrice() is false — never render a '
      + `fallback:\n${risky.map((r) => `  ${r.file}:${r.line} -> planPriceLabel(${r.arg})`).join('\n')}`,
    ).toEqual([]);
  });

  it('no DECLARED_PARAMETERISED row is stale — an exemption for a call site that no longer exists', () => {
    // A dead exemption reads as vetted and covers nothing. If a file stops calling the helper, its
    // row must go, so the next reader is never reassured by a rule about code that has moved on.
    // Call-site granularity, matching the key: a row survives only while a call site in that file
    // still passes that exact argument. A file-level check would keep a row alive after the one
    // call it described was rewritten to pass something else — an exemption covering nothing.
    const sites = new Set(callSites().map(siteKey));
    const stale = Object.keys(DECLARED_PARAMETERISED).filter((k) => !sites.has(k));
    expect(stale, `DECLARED_PARAMETERISED rows with no matching call site: ${stale.join(', ')}`).toEqual([]);
  });

  it('every exemption carries a prose reason — a bare key is not a declaration', () => {
    for (const [k, reason] of Object.entries(DECLARED_PARAMETERISED)) {
      expect(k, `${k} is not <file>::<arg>`).toMatch(/^[^:]+\.(ts|mjs|js)::.+$/);
      expect(reason.trim().length, `${k} has no usable reason`).toBeGreaterThan(30);
    }
    expect(Object.keys(DECLARED_PARAMETERISED).length).toBeGreaterThan(0);
  });

  it('the declared bindings really are self-serve — the exemption is not a loophole', async () => {
    // Verify the CLAIM each reason makes, rather than trusting the prose. If renderPlanCards ever
    // passed enterprise into prepayPriceBlock, or DEFAULT_UPGRADE_PLAN became a contact tier, the
    // reasons above would be false and this fails.
    const { DEFAULT_UPGRADE_PLAN } = await import('../../src/lib/plans.js');
    expect(planPublishesSelfServePrice(DEFAULT_UPGRADE_PLAN)).toBe(true);
    const signup = readFileSync(join(ROOT, 'src/lib/signup-flow.ts'), 'utf8');
    for (const m of signup.matchAll(/prepayPriceBlock\(([^)]*)\)/g)) {
      const arg = m[1].trim();
      if (arg === 'id: PaidPlanId') continue; // the definition
      expect(SAFE_ARGS.has(arg), `prepayPriceBlock(${arg}) — not a proven self-serve literal`).toBe(true);
    }
  });

  it('DEFAULT_UPGRADE_PLAN is itself a self-serve plan — the allowance above is not a loophole', async () => {
    const { DEFAULT_UPGRADE_PLAN } = await import('../../src/lib/plans.js');
    expect(planPublishesSelfServePrice(DEFAULT_UPGRADE_PLAN)).toBe(true);
  });
});
