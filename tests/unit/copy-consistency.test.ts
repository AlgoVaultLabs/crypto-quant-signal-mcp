/**
 * Unit tests for v1.10.3 FREE-UNLOCK-W1 copy-consistency guard.
 *
 * Greps the committed static landing surfaces for legacy/forbidden phrases
 * that would indicate the wave's free-tier unlock copy has drifted back.
 * Locks against future drift in CI.
 *
 * Acceptance Criteria (per the wave spec R9):
 *   - "11 timeframes" MUST appear in landing copy (zero hits = test fail).
 *   - "9 timeframes" used WITHOUT adjacent "track record" / "seeded" /
 *     "public history" context = test fail (catches drift back to the wrong
 *     number).
 *   - Legacy "BTC + ETH" / "15m + 1h" tier-gating phrases = test fail
 *     (those describe the pre-1.10.3 free tier).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

const LANDING_FILES = [
  'landing/index.html',
  'landing/skills.html',
  'landing/docs.html',
  'landing/verify.html',
  'landing/integrations.html',
  'landing/integrations/binance.html',
  'landing/integrations/bybit.html',
  'landing/integrations/okx.html',
  'landing/integrations/bitget.html',
  'landing/llms.txt',
  'landing/llms-full.txt',
  'README.md',
];

function read(rel: string): string | null {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

describe('Copy consistency — free-tier unlock + 11-timeframe canonical claim', () => {
  describe('"11 timeframes" canonical claim is present in major surfaces', () => {
    for (const f of ['landing/index.html', 'landing/llms-full.txt', 'README.md']) {
      it(`${f} contains "11 timeframes"`, () => {
        const txt = read(f);
        expect(txt).not.toBeNull();
        expect(txt).toContain('11 timeframes');
      });
    }
  });

  describe('Legacy free-tier-gating phrases are absent', () => {
    const FORBIDDEN_PHRASES: { phrase: RegExp; description: string }[] = [
      // The free tier no longer gates by coin or timeframe. Any of these legacy
      // phrases would indicate stale copy. Each regex is scoped to a TIER-context
      // shape (free tier label, pricing-card bullet, tier-table cell, or
      // freeGateMessage echo) so benign example-query enumerations like
      // "Get trade calls for BTC, ETH, SOL..." don't false-positive.
      { phrase: /Free tier:?\s*BTC[^A-Za-z]+ETH/i,                description: 'Free tier: BTC + ETH (pre-1.10.3)' },
      { phrase: /Free tier:?\s*15m\s*\+\s*1h/i,                   description: 'Free tier: 15m + 1h (pre-1.10.3)' },
      { phrase: /\bAssets\s*\|\s*BTC,\s*ETH\b/i,                  description: 'Tier table cell "Assets | BTC, ETH"' },
      { phrase: /\bTimeframes\s*\|\s*15m,\s*1h\b/i,               description: 'Tier table cell "Timeframes | 15m, 1h"' },
      { phrase: /BTC\s*\+\s*ETH\s+trade calls/i,                  description: '"BTC + ETH trade calls" pricing-card bullet' },
      { phrase: /15m\s*\+\s*1h\s+timeframes/i,                    description: '"15m + 1h timeframes" pricing-card bullet' },
      { phrase: /requires Starter[^.]*BTC and ETH only/i,         description: 'Old freeGateMessage coin-gating phrase' },
      { phrase: /requires Starter[^.]*15m and 1h only/i,          description: 'Old freeGateMessage timeframe-gating phrase' },
      { phrase: /BTC\s+and\s+ETH\s+(?:trade\s+calls|only)\s+on\s+15m/i, description: '"BTC and ETH trade calls/only on 15m" prose (pre-1.10.3 FAQ)' },
    ];

    for (const f of LANDING_FILES) {
      const txt = read(f);
      if (txt === null) continue;
      for (const { phrase, description } of FORBIDDEN_PHRASES) {
        it(`${f} does NOT contain forbidden legacy phrase: ${description}`, () => {
          expect(txt).not.toMatch(phrase);
        });
      }
    }
  });

  describe('"9 timeframes" only appears with track-record disambiguation context', () => {
    for (const f of LANDING_FILES) {
      const txt = read(f);
      if (txt === null) continue;
      if (!/9\s*(?:of\s*11\s*)?timeframes?/.test(txt)) continue;  // skip files with no "9 timeframes" mention
      it(`${f}: every "9 timeframes" reference sits within ±200 chars of track-record context`, () => {
        // Find every "9 timeframes" occurrence and check 200-char window for context.
        const re = /9\s*(?:of\s*11\s*)?timeframes?/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(txt!)) !== null) {
          const start = Math.max(0, m.index - 200);
          const end = Math.min(txt!.length, m.index + m[0].length + 200);
          const window = txt!.slice(start, end);
          const hasContext = /track[\s-]record|cron[\s-]seeded|public history|seeded for public|dashboard|of 11/i.test(window);
          expect(
            hasContext,
            `"${m[0]}" at offset ${m.index} in ${f} lacks track-record/seeded/dashboard/of-11 context within ±200 chars. Window:\n${window}`
          ).toBe(true);
        }
      });
    }
  });
});
