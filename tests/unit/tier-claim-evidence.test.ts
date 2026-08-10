/**
 * CONTACT-FORM-AND-SUPPORT-CLAIM-SWEEP-W1 (E6) — every public tier claim must name its evidence.
 *
 * THE GENERATOR FIX. CLAUDE.md mandates one after the third instance of a bug class, and
 * "public copy asserts a deliverable that does not exist" hit three times in a single day:
 *
 *   1. "HOLD calls always free"   — false; equity HOLDs ARE charged (removed earlier today)
 *   2. "Email support" / "Priority support" — neither exists
 *   3. "$0.015/call overage"      — no overage billing exists; the wall REFUSES, it does not bill
 *
 * Deleting three bullets fixes today. This retires the class: a rendered tier bullet that no
 * declared claim vouches for fails the build, and a declared claim whose evidence does not
 * resolve fails too. Both halves matter — a registry of claims pointing at symbols that do not
 * exist would be decoration.
 *
 * BOTH SURFACES are scanned (architect A9). This wave exists because a single-surface assumption
 * missed 28 of 29 occurrences of the support claim; gating only the function-rendered cards
 * would rebuild that exact hole.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TIER_CLAIMS, claimFor } from '../../src/lib/plans.js';
import { renderPlanCards } from '../../src/lib/signup-flow.js';

const ROOT = join(__dirname, '..', '..');

/** Rendered `<li>` text from the function-rendered checkout cards. */
function cardBullets(): string[] {
  const html = renderPlanCards();
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Rendered tier-card bullet text from the baked landing artboards.
 *
 * Scoped to the pricing tier cards by their exact `<li>` signature — the artboards contain many
 * other list items, and a looser scan would drown the gate in unrelated copy.
 */
function landingBullets(): string[] {
  const html = readFileSync(join(ROOT, 'landing/index.html'), 'utf8');
  return [...new Set(
    [...html.matchAll(/<li style="display:flex;gap:10px;align-items:flex-start;font-size:[\d.]+px;color:var\(--fg-2\);line-height:1\.5">[\s\S]*?<span>([^<]{2,90})<\/span><\/li>/g)]
      .map((m) => m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()),
  )];
}

// ── Badges (PRICING-BADGES-LIMITED-TIME-W1) ──
//
// Badges were OUTSIDE this gate's scan set until now, and that was a hole rather than a
// decision: a pill asserts something about the product in exactly the way a bullet does. It is
// how "MOST POPULAR" sat on the Pro card while Pro was the LEAST-subscribed paid plan — an
// unevidenced claim on the highest-intent surface the product has, passing every gate.
//
// Same two-surface rule as the bullets, for the same reason (a single-surface assumption once
// missed 28 of 29 occurrences), and each extractor gets its own vacuity guard: an extractor that
// silently stops matching would turn "no unvouched badge" into a green that proves nothing.

/** Rendered badge text from the function-rendered checkout cards. */
function cardBadges(): string[] {
  return [...renderPlanCards().matchAll(/<div class="pop-badge">([^<]{2,40})<\/div>/g)]
    .map((m) => m[1].trim());
}

/**
 * Rendered badge text from the baked landing artboards.
 *
 * Keyed on the pill's own absolutely-positioned signature rather than on its text, so a NEW
 * badge string lands as an orphan instead of going unseen — which is the whole point.
 */
function landingBadges(): string[] {
  const html = readFileSync(join(ROOT, 'landing/index.html'), 'utf8');
  return [...new Set(
    [...html.matchAll(/<div style="position:absolute;top:-11px;left:18px;[^"]*border-radius:999px;[^"]*">([^<]{2,40})<\/div>/g)]
      .map((m) => m[1].trim()),
  )];
}

describe('every declared tier claim has RESOLVABLE evidence', () => {
  it('the registry is non-empty (vacuity guard)', () => {
    // An empty registry would make every "is this bullet covered" assertion below trivially
    // satisfiable in the wrong direction, and a claim-less registry would report green.
    expect(TIER_CLAIMS.length).toBeGreaterThanOrEqual(5);
  });

  it.each(TIER_CLAIMS)('claim "$id" names evidence that actually exists', (claim) => {
    const ev = claim.evidence;
    if (ev.kind === 'contractual') {
      // Deliberately awkward: a human commitment needs a named owner and a reason, so nobody
      // can label a missing deliverable "contractual" to silence the gate.
      expect(ev.approvedBy.length, `${claim.id}: contractual evidence needs a named approver`).toBeGreaterThan(2);
      expect(ev.note.length, `${claim.id}: contractual evidence needs a note`).toBeGreaterThan(15);
      return;
    }
    const [file, symbol] = ev.ref.split('#');
    expect(existsSync(join(ROOT, file)), `${claim.id}: evidence file ${file} does not exist`).toBe(true);
    if (symbol) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      // The symbol must be EXPORTED — an internal helper is not evidence a public claim can cite.
      expect(
        new RegExp(`export (?:const|function|async function|class|type|interface)\\s+${symbol}\\b`).test(src),
        `${claim.id}: ${file} does not export ${symbol}`,
      ).toBe(true);
    }
  });
});

describe('every RENDERED tier bullet is covered by a claim — both surfaces (A9)', () => {
  it('the function-rendered checkout cards yield bullets at all (vacuity guard)', () => {
    expect(cardBullets().length).toBeGreaterThanOrEqual(6);
  });

  it('the baked landing artboards yield bullets at all (vacuity guard)', () => {
    expect(landingBullets().length).toBeGreaterThanOrEqual(6);
  });

  it('renderPlanCards: no bullet asserts something unvouched-for', () => {
    const orphans = cardBullets().filter((b) => claimFor(b) === null);
    expect(
      orphans,
      'add a TIER_CLAIMS row naming the code path, SoT symbol or approver that makes this true — '
      + 'or delete the bullet. This gate exists because "Email support", "Priority support" and '
      + '"$0.015/call overage" all shipped as public copy for deliverables that do not exist.',
    ).toEqual([]);
  });

  it('landing/index.html: no tier bullet asserts something unvouched-for', () => {
    const orphans = landingBullets().filter((b) => claimFor(b) === null);
    expect(orphans, 'unvouched-for claim on the landing pricing cards').toEqual([]);
  });

  it('the badge extractors yield badges at all (vacuity guard, both surfaces)', () => {
    // Without this, a markup change that stopped either regex matching would report a green
    // "no unvouched badge" over an empty set — the exact shape of a dark guard.
    expect(cardBadges().length, 'checkout cards yielded no badges').toBeGreaterThanOrEqual(2);
    expect(landingBadges().length, 'landing artboards yielded no badges').toBeGreaterThanOrEqual(2);
  });

  it('no rendered BADGE asserts something unvouched-for — both surfaces', () => {
    const orphans = [...new Set([...cardBadges(), ...landingBadges()])]
      .filter((b) => claimFor(b) === null);
    expect(
      orphans,
      'a pricing-card badge is vouched for by no TIER_CLAIMS row. A badge is public copy '
      + 'asserting a fact about the product — "MOST POPULAR" rode the Pro card while Pro was '
      + 'the least-subscribed paid plan. Add a row naming what makes it true, or drop the badge.',
    ).toEqual([]);
  });

  it('the two surfaces render the SAME badge set — no per-surface drift', () => {
    // This wave exists because they did not: "MOST POPULAR" on the checkout cards vs "POPULAR"
    // on the landing artboards, one badge, two words, for months.
    expect([...cardBadges()].sort()).toEqual([...landingBadges()].sort());
  });

  it('REGRESSION LOCK: the three removed claims would each be rejected', () => {
    // The exact strings this wave and its predecessor deleted. If a future copy wave
    // reintroduces one, it lands as an orphan and the two tests above fail.
    for (const dead of [
      'Email support', 'Priority support', 'Dedicated support',
      '$0.015/call overage', '$0.01/call overage', 'HOLD calls always free',
      'SLA guarantee',
      // HOLD-DEEMPHASIS-SWEEP-W1 (2026-08-10): the `all-verdicts-count` row retired with
      // this bullet. NOT re-pointed at the replacement docs sentence — this gate scans
      // rendered BULLETS (renderPlanCards + landing/index.html), and the replacement is
      // docs prose that claimFor() never sees.
      'Every verdict counts, including HOLD',
    ]) {
      expect(claimFor(dead), `"${dead}" must NOT be vouched for by any claim`).toBeNull();
    }
  });
});

/**
 * RELEASE-6MONTH-COPY-CORRECTION-W1 — the THIRD surface: README's pricing table.
 *
 * WHY THIS EXISTS. The `| Support | Community | Email | Priority | Dedicated |` row shipped on
 * npm for months asserting deliverables that do not exist — the same class this gate was built
 * for. It survived because the gate scanned `renderPlanCards()` and `landing/index.html` and
 * nothing else, while README.md is the most-read public surface the package ships.
 *
 * WHY NOT `claimFor()` DIRECTLY. TIER_CLAIMS `match` regexes are written against RENDERED BULLET
 * text ("10,000 calls/month"), not table cells ("10,000/mo") or row labels ("Monthly calls").
 * Measured: every legitimate row is unvouched under a naive cell scan, so reusing `claimFor` here
 * would report red on day one and be disabled within a week. Instead the table is gated by an
 * explicit ROW REGISTRY: a row may exist only if it is declared below. Adding a row is therefore
 * a deliberate act that forces the author to justify it — which is exactly the property the
 * Support row bypassed.
 */
const README_PRICING_ROWS: readonly string[] = [
  'Exchanges',
  'Assets',
  'Asset classes',
  'Timeframes',
  'Funding arb results',
  'Track record',
  'Monthly calls',
  'Daily calls',
  'Price',
];

function readmePricingRowLabels(): string[] {
  const md = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const table = md.match(/\n\| Feature \| Free \|[\s\S]*?\n\n/);
  if (!table) return [];
  return table[0]
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|[-\s|]+\|$/.test(l))
    .slice(1) // drop the header row
    .map((l) => l.split('|')[1].replace(/<[^>]*>/g, '').trim())
    .filter(Boolean);
}

describe("README pricing table: no row asserts an unregistered deliverable (A9, third surface)", () => {
  it('the table is found and yields rows at all (vacuity guard)', () => {
    // Without this, a renamed header would make every assertion below vacuously true — the exact
    // failure mode that let the Support row survive two gates.
    expect(readmePricingRowLabels().length).toBeGreaterThanOrEqual(6);
  });

  it('every rendered row label is registered', () => {
    const orphans = readmePricingRowLabels().filter((l) => !README_PRICING_ROWS.includes(l));
    expect(
      orphans,
      'a README pricing-table row is not in README_PRICING_ROWS. Register it here only if the '
      + 'deliverable actually exists (name the code path or SoT symbol in the PR) — or delete the '
      + 'row. "Support: Email / Priority / Dedicated" shipped for months as public copy for '
      + 'deliverables that do not exist; that is what this registry prevents.',
    ).toEqual([]);
  });

  it('the registry stays honest: no support-tier row may be registered', () => {
    // A belt-and-braces assertion: even a future edit that ADDS 'Support' to the registry fails,
    // because the deliverable is architect-ruled nonexistent, not merely undocumented.
    expect(README_PRICING_ROWS.map((r) => r.toLowerCase())).not.toContain('support');
  });
});
