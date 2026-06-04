/**
 * EQUITIES-ENGINE-W1 — pure symbol normalization.
 *
 * Databento EQUS.MINI raw_symbol uses the Nasdaq convention: share classes are
 * dotted (BRK.B, BF.B). MCP clients / agents commonly send the dashed form
 * (BRK-B) or lowercase. We normalize ONE canonical internal form (dotted,
 * uppercase) used for every DB key, universe lookup, and Databento request.
 *
 * No I/O. Test-importable per the CLAUDE.md pure-constants rule.
 */

/**
 * Normalize a user/agent-supplied ticker to the canonical EQUS.MINI raw_symbol.
 *   "brk-b"  -> "BRK.B"
 *   "BRK.B"  -> "BRK.B"
 *   " aapl " -> "AAPL"
 * A dash is treated as a share-class separator and mapped to a dot ONLY when it
 * splits two non-empty alphanumeric chunks (so e.g. a malformed "-AAPL" is not
 * silently rewritten). Returns '' for empty/invalid input.
 */
export function normalizeSymbol(input: string | null | undefined): string {
  if (input == null) return '';
  const trimmed = String(input).trim().toUpperCase();
  if (trimmed === '') return '';
  // Allow only A-Z, 0-9, dot, dash in the raw input.
  if (!/^[A-Z0-9.\-]+$/.test(trimmed)) return '';
  // Map an internal class dash to a dot: ONE dash between two alnum chunks.
  const dashToDot = trimmed.replace(/^([A-Z0-9]+)-([A-Z0-9]+)$/, '$1.$2');
  return dashToDot;
}

/**
 * True if two raw user inputs refer to the same canonical symbol.
 */
export function sameSymbol(a: string, b: string): boolean {
  const na = normalizeSymbol(a);
  return na !== '' && na === normalizeSymbol(b);
}
