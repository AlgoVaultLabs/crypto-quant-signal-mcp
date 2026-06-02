/**
 * Canonical question-hash — extracted from chat-analytics.ts in GEO-MEASUREMENT-W2
 * (C3, Q-3-B) so the PII-safe SHA256 fingerprint is computed IDENTICALLY by both
 * the chat-analytics recorder (write side) and geo-demand-mining (read side). A
 * divergent re-implementation would silently zero-match every demand weight
 * forever — hence one shared source.
 *
 * PII GUARD: this hashes the user's input and is intentionally lossy — the
 * source text is NEVER stored. SHA256 truncated to 16 hex chars (64 bits):
 * collision-resistant at AlgoVault scale and clusters semantically-identical
 * rephrasings into one bucket (desirable for top-N-asked analytics).
 */
import crypto from 'node:crypto';

export const QUESTION_HASH_BYTES = 16; // SHA256 truncated to 16 hex chars = 64 bits

export function hashQuestion(question: string): string {
  return crypto.createHash('sha256').update(question).digest('hex').slice(0, QUESTION_HASH_BYTES);
}
