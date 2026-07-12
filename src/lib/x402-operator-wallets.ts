/**
 * x402-operator-wallets.ts — OPS-X402-WALLET-ATTRIBUTION-W1 R4/Q2.
 *
 * OPERATOR x402 payer wallets (the self-settle harness buyer / dev). These are EXCLUDED from the
 * distinct-paying-wallet CONVERSION metric on /dashboard/funnel so the agent funnel measures REAL
 * agent conversion, not operator self-settle — the `instrumentation_artifact: operator_dev_key`
 * pattern (CLAUDE.md Data Integrity: tier-tagged/dev rows are cross-checked + never inflate a
 * conversion count). All 7 historical `processed_x402_payments` rows resolved on-chain to the one
 * harness buyer below (2026-06-30 self-settle burst that listed the Bazaar routes).
 *
 * This is the RUNTIME source (the runtime image ships `dist/`, not `audits/`). The documented,
 * greppable, extensible mirror is `audits/OPERATOR_X402_WALLET_FILTER.json`; a canary test asserts
 * the two never drift. To exclude a new operator/dev wallet: add it (lowercased) to BOTH.
 *
 * INTERNAL-ONLY: these addresses are on-chain-public but are NEVER surfaced in public copy or a
 * public endpoint; operator-dashboard display is truncated (`truncateWallet`).
 */

/** Lowercased operator payer wallets excluded from the distinct-paying-wallet conversion count. */
export const OPERATOR_X402_WALLETS: readonly string[] = [
  '0x76de895fdd3f7b5814eb59ccd244b06b47d8c755', // self-settle harness buyer (on-chain-confirmed 2026-06-30; all 7 pre-instrumentation rows)
];

/** Case-insensitive membership test. */
export function isOperatorWallet(w: string | null | undefined): boolean {
  return typeof w === 'string' && OPERATOR_X402_WALLETS.includes(w.toLowerCase());
}

/**
 * SQL fragment + bind params to EXCLUDE operator wallets from a distinct-wallet count. Dual-backend
 * (`?` placeholders; `lower()` is supported on PG + SQLite). Empty allow-list ⇒ no clause.
 */
export function operatorExclusionSql(column = 'payer_wallet'): { clause: string; params: string[] } {
  if (OPERATOR_X402_WALLETS.length === 0) return { clause: '', params: [] };
  const placeholders = OPERATOR_X402_WALLETS.map(() => '?').join(', ');
  return { clause: ` AND lower(${column}) NOT IN (${placeholders})`, params: [...OPERATOR_X402_WALLETS] };
}

/** Truncate an address for operator-only display: `0x76de…c755`. NEVER publish the full address. */
export function truncateWallet(w: string): string {
  return w.length >= 10 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}
