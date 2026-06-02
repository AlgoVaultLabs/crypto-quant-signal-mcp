/**
 * GEO-MEASUREMENT-W2 (C3, Q-3-B) — byte-identical canary for the extracted
 * question-hash. Locks the hash output UNCHANGED vs the pre-extraction
 * chat-analytics implementation (sha256(q).hex.slice(0,16)). A drift here would
 * silently zero-match every demand weight forever.
 */
import { describe, it, expect } from 'vitest';
import { hashQuestion, QUESTION_HASH_BYTES } from '../../src/lib/question-hash.js';

describe('question-hash: byte-identical canary', () => {
  it('matches pre-extraction sha256(q).slice(0,16) for known inputs', () => {
    expect(hashQuestion('How do I build a crypto trading agent in Python?')).toBe('31b806182a10025f');
    expect(hashQuestion('')).toBe('e3b0c44298fc1c14');
    expect(hashQuestion("What's the best MCP server for crypto signals?")).toBe('9cc733e85dfddec5');
  });

  it('is exactly 16 lowercase-hex chars', () => {
    expect(QUESTION_HASH_BYTES).toBe(16);
    expect(hashQuestion('anything at all')).toMatch(/^[0-9a-f]{16}$/);
  });
});
