/**
 * builder-code-constants.ts — Base Builder Code (ERC-8021) attribution.
 *
 * SINGLE DERIVATION POINT for the calldata suffix that attributes AlgoVault's
 * on-chain Base transactions to its Base Dashboard app (App Rankings / builder
 * rewards). Every caller that wants attribution reads `getBuilderCodeDataSuffix()`
 * — never builds a suffix itself.
 *
 * ── Encoding (why we do NOT hand-write the bytes) ────────────────────────────
 * Two DIFFERENT ERC-8021 encodings share the same 16-byte marker:
 *   • Base Dashboard's "Encoded String" = SCHEMA 0 — raw ASCII + 1-byte length.
 *   • The x402 protocol path            = SCHEMA 2 — CBOR {a,w,s} + 2-byte length.
 * We emit SCHEMA 2 via `encodeBuilderCodeSuffix` (architect Q2, 2026-07-30) so the
 * anchor tx is parsed by the same indexer path as x402 settlements. Hand-pasting the
 * dashboard hex would emit schema 0 — do not do it.
 *
 * ── Safety contract ─────────────────────────────────────────────────────────
 * Attribution is ADDITIVE TELEMETRY. It must never fail a transaction. Every
 * failure mode here returns `undefined` (⇒ caller publishes UNATTRIBUTED calldata):
 * flag off · malformed env override · encoder throw · round-trip mismatch.
 *
 * Flags:
 *   BASE_BUILDER_CODE_ENABLED = '1' | 'true'   (default OFF)
 *   BASE_BUILDER_CODE         override the code   (default 'bc_6auwl7of')
 *   BASE_BUILDER_CODE_SUFFIX  override the raw hex suffix (escape hatch; still validated)
 *
 * Wave: OPS-BASE-BUILDER-CODE-W1.
 */

import {
  encodeBuilderCodeSuffix,
  parseBuilderCodeSuffixFromCalldata,
  BUILDER_CODE_PATTERN,
} from '@x402/extensions/builder-code';

/** AlgoVault's Base Dashboard builder code (minted 2026-07-17). Public by design. */
export const BASE_BUILDER_CODE_DEFAULT = 'bc_6auwl7of';

/** Resolve the configured builder code (env override wins). */
export function getBuilderCode(): string {
  return process.env.BASE_BUILDER_CODE?.trim() || BASE_BUILDER_CODE_DEFAULT;
}

/** Is builder-code attribution switched on? Default OFF (instant rollback = unset the flag). */
export function isBuilderCodeEnabled(): boolean {
  const v = process.env.BASE_BUILDER_CODE_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Validate a candidate suffix by ROUND-TRIPPING it through the library parser:
 * a suffix we cannot parse back into our own code is not one we will broadcast.
 */
function roundTripsToCode(suffix: string, expectedCode: string): boolean {
  try {
    const hex = suffix.startsWith('0x') ? suffix : `0x${suffix}`;
    // Prepend a dummy 4-byte selector so the input looks like real calldata.
    const parsed = parseBuilderCodeSuffixFromCalldata(`0x00000000${hex.slice(2)}` as `0x${string}`);
    return parsed?.a === expectedCode;
  } catch {
    return false;
  }
}

/**
 * The ERC-8021 Schema-2 calldata suffix for AlgoVault, or `undefined` when
 * attribution is off or cannot be produced safely.
 *
 * NEVER throws — callers append it only when defined.
 */
export function getBuilderCodeDataSuffix(): `0x${string}` | undefined {
  if (!isBuilderCodeEnabled()) return undefined;

  const code = getBuilderCode();
  if (!BUILDER_CODE_PATTERN.test(code)) {
    console.warn(
      `[builder-code] code ${JSON.stringify(code)} fails ${BUILDER_CODE_PATTERN} — publishing UNATTRIBUTED`
    );
    return undefined;
  }

  const override = process.env.BASE_BUILDER_CODE_SUFFIX?.trim();
  if (override) {
    if (!roundTripsToCode(override, code)) {
      console.warn('[builder-code] BASE_BUILDER_CODE_SUFFIX failed round-trip — publishing UNATTRIBUTED');
      return undefined;
    }
    return (override.startsWith('0x') ? override : `0x${override}`) as `0x${string}`;
  }

  try {
    const suffix = encodeBuilderCodeSuffix({ a: code });
    if (!roundTripsToCode(suffix, code)) {
      console.warn('[builder-code] encoded suffix failed round-trip — publishing UNATTRIBUTED');
      return undefined;
    }
    return suffix as `0x${string}`;
  } catch (err) {
    console.warn(`[builder-code] encode failed — publishing UNATTRIBUTED: ${String(err)}`);
    return undefined;
  }
}
