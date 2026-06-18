/**
 * CTA-click funnel event-type classification (LANDING-CONVERSION-TRUST-W1, architect D3).
 *
 * The `/signup` handler records a `funnel_events` row for every click carrying an
 * `?upgrade_from=` source param. There are two semantically distinct populations:
 *
 *   - **In-product upgrade nudges** (`upgrade_from = quota | soft | aha | limit | tg_start`):
 *     a free/existing user hit a quota wall or saw an upgrade prompt. These are
 *     `upgrade_cta_clicked` — CANONICAL_STAGE_ORDER **stage 7** (the nudge→checkout step).
 *
 *   - **Cold-acquisition landing clicks** (`upgrade_from = landing_hero | landing_pricing |
 *     landing_free`): a brand-new visitor clicked a CTA on the public landing/pricing page.
 *     These are `landing_cta_clicked` — a NON-stage quality signal.
 *
 * `funnel-snapshot.ts` blanket-counts `upgrade_cta_clicked` for stage 7 (no `upgrade_from`
 * filter), so routing cold landing traffic into a DISTINCT event_type is the seam that keeps
 * acquisition clicks from inflating the nudge-conversion stage. Keep this the single source
 * of the split — both the handler and any future caller classify here, never inline.
 */
export type CtaEventType = 'landing_cta_clicked' | 'upgrade_cta_clicked';

/** All landing-sourced `upgrade_from` values share this prefix (landing_hero/pricing/free). */
export const LANDING_SOURCE_PREFIX = 'landing_';

export function classifyCtaEventType(upgradeFrom: string | undefined | null): CtaEventType {
  return typeof upgradeFrom === 'string' && upgradeFrom.startsWith(LANDING_SOURCE_PREFIX)
    ? 'landing_cta_clicked'
    : 'upgrade_cta_clicked';
}
