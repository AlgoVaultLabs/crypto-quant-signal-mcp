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
    // README.md was intentionally forward-stabilized by GEO-REGISTRY-RANK-README-REFRESH-W1
    // (e511b28, "forward-stabilize hero + Tools venue/timeframe counts") — the hardcoded
    // "11 timeframes" count was removed per the forward-stability discipline (count-bound
    // claims → live/qualitative). The canonical literal claim lives on the landing copy
    // surfaces (per this guard's AC: "landing copy"), where it remains asserted exactly.
    for (const f of ['landing/index.html', 'landing/llms-full.txt']) {
      it(`${f} contains "11 timeframes"`, () => {
        const txt = read(f);
        expect(txt).not.toBeNull();
        expect(txt).toContain('11 timeframes');
      });
    }
  });

  describe('"performance://signal-performance" canonical MCP resource URI is present', () => {
    for (const f of ['landing/index.html', 'landing/docs.html']) {
      it(`${f} contains "performance://signal-performance"`, () => {
        const txt = read(f);
        expect(txt).not.toBeNull();
        expect(txt).toContain('performance://signal-performance');
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
      { phrase: /performance:\/\/signal-stats/i,                 description: 'Renamed MCP resource — was signal-stats, now signal-performance (FACTUALITY-RENAME-W1)' },
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

  describe('AUTO-TRACE-W1 capability-counter canary (no hardcoded literals outside proxy/snapshot)', () => {
    // After AUTO-TRACE-W1 every public-surface "5 exchanges" / "<N>+ assets" /
    // "<N> timeframes" literal MUST be wrapped in either:
    //   (a) a `data-tr-field="(exchange|asset|timeframe)_count"` span (Class A
    //       — JS-renderable; live-proxied via /api/performance-public)
    //   (b) a `<!-- SNAPSHOT-LINE -->` or `<!-- SNAPSHOT-LINE-TABLE -->` end-of-
    //       line marker (Class B — refreshed by `npm run snapshot:capabilities`)
    //   (c) a `# SNAPSHOT-LINE` plaintext-equivalent marker (.txt files)
    //
    // Any literal that survives outside both contexts is fresh drift —
    // typically a copy-paste from the spec PR, or a regression from a
    // future-wave commit that bypassed the snapshot pipeline.
    //
    // Excluded: `landing/integrations.html` autorun-line at 280
    // ("a 5th/6th/Nth exchange") — that's not a capability counter, it's
    // ordinal phrasing about a hypothetical onboarding event. Same for the
    // "v1.10.0 - 5-exchange + 20-skill catalog refresh" historical changelog
    // entry in README/CHANGELOG (changelog entries are immutable history).
    const COUNTER_PATTERNS = [
      { name: 'exchange_count', re: /\b\d+\s+exchanges?\b/g, fieldName: 'exchange_count' },
      { name: 'asset_count',    re: /\b\d+\+\s+assets?\b/g,  fieldName: 'asset_count' },
    ];

    function isWrappedOnLine(line: string, fieldName: string): boolean {
      // Same-line proxy span enclosing the digit?
      const SPAN = new RegExp(`data-tr-field="${fieldName}"`);
      if (SPAN.test(line)) return true;
      // Same-line SNAPSHOT-LINE or SNAPSHOT-LINE-TABLE marker?
      if (/<!--\s*SNAPSHOT-LINE(?:-TABLE)?\s*-->/.test(line)) return true;
      // Plaintext-equivalent SNAPSHOT-LINE marker (.txt files)?
      if (/(^|\s)#\s*SNAPSHOT-LINE\b/.test(line)) return true;
      return false;
    }

    /**
     * Track whether we're currently inside a `<script type="application/ld+json">`
     * block. Counter literals on `description`/`text` keys inside such blocks
     * are auto-managed by the snapshot script's Stage 2 JSON-LD rewrite (no
     * marker needed because JSON has no comment syntax).
     */
    function withJsonLdContext(lines: string[]): boolean[] {
      const inJsonLd = new Array(lines.length).fill(false);
      let inside = false;
      lines.forEach((line, i) => {
        if (/<script\s+type=["']application\/ld\+json["']/.test(line)) inside = true;
        inJsonLd[i] = inside;
        if (inside && /<\/script>/.test(line)) inside = false;
      });
      return inJsonLd;
    }

    for (const f of LANDING_FILES) {
      const txt = read(f);
      if (txt === null) continue;
      // CHANGELOG-style historical mentions are out-of-scope for the canary —
      // those describe past states, not current capability claims.
      const lines = txt.split('\n');
      const inJsonLd = withJsonLdContext(lines);
      for (const { re, fieldName } of COUNTER_PATTERNS) {
        it(`${f}: every "${fieldName}" literal is inside a proxy span or SNAPSHOT marker`, () => {
          const violations: { line: number; text: string }[] = [];
          lines.forEach((line, i) => {
            // Skip CHANGELOG/release-notes "v1.10.0 - 5-exchange" historical phrasing
            if (/^##\s+\[?\s*\d+\.\d+\.\d+\b/.test(line)) return;
            // Skip "ordinal" phrasing about hypothetical future onboarding
            if (/\b\d+(?:st|nd|rd|th)\/\d+(?:st|nd|rd|th)\/Nth\s+exchange/.test(line)) return;
            // Skip if the line is inside a JSON-LD `<script>` block AND the
            // counter sits inside a `description` or `text` key value (snapshot
            // script's Stage 2 auto-rewrite covers these).
            if (inJsonLd[i] && /"(?:description|text)"\s*:/.test(line)) return;
            // Skip lines that mention "5-exchange" hyphenated as adjective
            // (style choice for headlines, not a counter claim).
            const adjFormStripped = line.replace(/\b\d+-exchange(?:s)?\b/g, '');
            const localRe = new RegExp(re.source, re.flags);
            let m: RegExpExecArray | null;
            while ((m = localRe.exec(adjFormStripped)) !== null) {
              if (!isWrappedOnLine(line, fieldName)) {
                violations.push({ line: i + 1, text: line.trim().slice(0, 200) });
              }
            }
          });
          expect(
            violations,
            violations.length > 0
              ? `${f}: ${violations.length} unwrapped "${fieldName}" literal(s):\n` +
                violations.map((v) => `  L${v.line}: ${v.text}`).join('\n')
              : '',
          ).toEqual([]);
        });
      }
    }

    // src/index.ts is server-rendered HTML; same canary applies. Excluded
    // is internal-only narrative (line 389 INTEGRATION_EXCHANGES tuple)
    // because it's TypeScript code, not output text.
    it('src/index.ts: every "5 exchanges" / "290+ assets" inside HTML literals is inside a proxy span', () => {
      const txt = read('src/index.ts');
      expect(txt).not.toBeNull();
      const lines = txt!.split('\n');
      const violations: { line: number; text: string }[] = [];
      lines.forEach((line, i) => {
        // Skip TypeScript code lines (no HTML literals — heuristic: line
        // contains `<` AND not `:`/`from`/`import`/`const`/`let` declarations).
        if (/^\s*(import|export|const|let|var|function|class|interface|type)\s/.test(line)) return;
        // Skip the INTEGRATION_EXCHANGES tuple definition explicitly.
        if (/INTEGRATION_EXCHANGES\s*=\s*\[/.test(line)) return;
        // Pattern restricted to HTML literal bodies (heuristic).
        for (const { re, fieldName } of COUNTER_PATTERNS) {
          const adjFormStripped = line.replace(/\b\d+-exchange(?:s)?\b/g, '');
          const localRe = new RegExp(re.source, re.flags);
          let m: RegExpExecArray | null;
          while ((m = localRe.exec(adjFormStripped)) !== null) {
            const SPAN = new RegExp(`data-tr-field="${fieldName}"`);
            if (!SPAN.test(line)) {
              violations.push({ line: i + 1, text: line.trim().slice(0, 200) });
            }
          }
        }
      });
      expect(
        violations,
        violations.length > 0
          ? `src/index.ts: ${violations.length} unwrapped capability-counter literal(s):\n` +
            violations.map((v) => `  L${v.line}: ${v.text}`).join('\n')
          : '',
      ).toEqual([]);
    });
  });

  describe('"9 timeframes" only appears with track-record disambiguation context', () => {
    // ONE internal-loop test so the suite is never empty — vitest reports a
    // describe with zero registered `it`s as a file-level error ("No test found
    // in suite"). The previous per-file dynamic `it` registered nothing once
    // forward-stabilization removed every "9 timeframes" mention from landing
    // copy, failing the whole file despite 0 real defects. The invariant is
    // unchanged: every "9 timeframes" occurrence (if reintroduced) MUST sit
    // within ±200 chars of track-record / "of 11" disambiguation context;
    // vacuously satisfied when no surface mentions it.
    it('every "9 timeframes" reference across landing surfaces sits within ±200 chars of track-record context', () => {
      for (const f of LANDING_FILES) {
        const txt = read(f);
        if (txt === null) continue;
        const re = /9\s*(?:of\s*11\s*)?timeframes?/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(txt)) !== null) {
          const start = Math.max(0, m.index - 200);
          const end = Math.min(txt.length, m.index + m[0].length + 200);
          const window = txt.slice(start, end);
          const hasContext = /track[\s-]record|cron[\s-]seeded|public history|seeded for public|dashboard|of 11/i.test(window);
          expect(
            hasContext,
            `"${m[0]}" at offset ${m.index} in ${f} lacks track-record/seeded/dashboard/of-11 context within ±200 chars. Window:\n${window}`
          ).toBe(true);
        }
      }
    });
  });

  // ── CRYPTO-PERF-COPY-REMEDIATION-W1 (2026-07-25) — PFE-copy factuality bans ──
  // Mr.1-approved pack: the public copy must tell the same story as the DB.
  //   S1/S7/Q2 — "directional accuracy" may not describe the PFE metric on any
  //              public surface (card sub-label removed; llms.txt + JSON-LD
  //              Dataset desc scrubbed deletion-only).
  //   S4/S7    — the "improved monotonically" PFE-WR overclaim is deleted from
  //              the /how-it-works flywheel lead.
  //   S6/S7/Q3 — "regime-aware filters|gating" overclaim scrubbed (JSON-LD FAQ →
  //              visible twin; meta description reframed; skills.html desc).
  // Concept-level + fleet-wide + both-directions self-tested per the Q3 ruling.
  describe('CRYPTO-PERF-COPY-REMEDIATION-W1 — banned PFE-copy phrases (fleet-wide)', () => {
    const stripHtmlComments = (s: string): string => s.replace(/<!--[\s\S]*?-->/g, '');
    const BAN_DIRECTIONAL_ACCURACY = /directional[-\s]accuracy/i;
    const BAN_IMPROVED_MONOTONIC = /improved\s+monotonic/i;
    const BAN_REGIME_AWARE_FILTER = /regime-aware\s+(filter\w*|gating)/i; // Q3-specified

    const BANS = [
      { re: BAN_DIRECTIONAL_ACCURACY, description: '"directional accuracy" as a PFE descriptor (S1/S7/Q2)' },
      { re: BAN_IMPROVED_MONOTONIC,   description: '"improved monotonically" PFE-WR overclaim (S4/S7)' },
      { re: BAN_REGIME_AWARE_FILTER,  description: '"regime-aware filters/gating" overclaim (S6/S7/Q3)' },
    ];

    // how-it-works.html is a baked public surface carrying the flywheel lead (the
    // S4 target), so it joins the fleet scan alongside LANDING_FILES.
    const BAN_FILES = [...LANDING_FILES, 'landing/how-it-works.html'];

    for (const f of BAN_FILES) {
      const raw = read(f);
      if (raw === null) continue;
      const txt = stripHtmlComments(raw);
      for (const { re, description } of BANS) {
        it(`${f} does NOT contain banned phrase: ${description}`, () => {
          expect(txt).not.toMatch(re);
        });
      }
    }

    // Both-directions self-test: the bans must still MATCH their forbidden phrasing
    // (guards against a regex silently rotting into a no-op) and must NOT match the
    // benign near-misses that legitimately remain on the surfaces.
    it('ban regexes match the forbidden phrasings (positive control)', () => {
      expect('PFE directional accuracy and excursion analysis').toMatch(BAN_DIRECTIONAL_ACCURACY);
      expect('PFE (directional-accuracy) win rate').toMatch(BAN_DIRECTIONAL_ACCURACY);
      expect('Our PFE win rate has improved monotonically since launch').toMatch(BAN_IMPROVED_MONOTONIC);
      expect('scoring engine with regime-aware filtering').toMatch(BAN_REGIME_AWARE_FILTER);
      expect('pass through regime-aware filters and adaptive gates').toMatch(BAN_REGIME_AWARE_FILTER);
      expect('regime-aware gating before a verdict').toMatch(BAN_REGIME_AWARE_FILTER);
    });

    it('ban regexes do NOT match the benign phrasings that remain (negative control)', () => {
      // "called direction" (JSON-LD variableMeasured), "market regime" (kept copy),
      // "Regime-Aware Trading" (skill NAME, not a filter claim), and the legit
      // "Batch IDs increment monotonically" (llms-full.txt) must all survive.
      expect('price moved in the called direction').not.toMatch(BAN_DIRECTIONAL_ACCURACY);
      expect('Batch IDs increment monotonically').not.toMatch(BAN_IMPROVED_MONOTONIC);
      expect('Every call reports market regime — trending, ranging, or volatile').not.toMatch(BAN_REGIME_AWARE_FILTER);
      expect('Regime-Aware Trading').not.toMatch(BAN_REGIME_AWARE_FILTER);
    });
  });
});
