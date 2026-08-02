/**
 * OPS-QUOTA-EXHAUSTION-NOTICE-W1 — every tool call site must forward the RESOLVED license.
 *
 * Why this exists, and why it is a source scan rather than a behavioural test.
 *
 * The quota gate lives inside each core function and reads `input.license`, defaulting to
 * `{tier:'free', key:null}` when it is absent. That default is silent and plausible, so a call
 * site that simply forgets to pass the license produces no error, no type failure and no test
 * failure — it just meters the caller against the IP-derived free bucket instead of their own.
 *
 * That is not hypothetical. `get_market_regime` shipped for months without it: found live on
 * 2026-08-02, a keyed free caller whose own bucket read 100/100 was still SERVED by that tool
 * (its IP bucket read 8/100), so the operator-FROZEN cutoff did not hold there — and a PAID
 * caller's regime calls were metered against, and would eventually be refused by, the free
 * 100/mo cap. The x402 twin carried a comment asserting deliberate parity with the MCP handler;
 * the parity was real and both sides were wrong.
 *
 * The unit tests for the cutoff pass an explicit license, so they could never have caught it —
 * the bug is in the CALLER, above every seam a behavioural test can reach (`index.ts` boots the
 * server at import, so its handler closures are not importable). The wiring is therefore checked
 * where it lives: in the source, with comments stripped first so a mention in prose is not
 * mistaken for an invocation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

/** Strip line + block comments so a discussion of a call is never read as the call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, (line) =>
    // keep the code that precedes a trailing `//` comment
    line.slice(0, line.indexOf('//')),
  );
}

/** Every object-literal invocation `fn({ ... })`, returned as its argument text. */
function objectArgInvocations(src: string, fn: string): string[] {
  const out: string[] = [];
  const needle = `${fn}({`;
  let i = src.indexOf(needle);
  while (i !== -1) {
    let depth = 0;
    let j = i + fn.length + 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf(needle, j);
  }
  return out;
}

// The core functions whose quota gate reads `input.license`. A tool added without an entry
// here is invisible to this guard, so the list is asserted non-empty and every entry is
// asserted to have at least one real call site — a typo'd name would otherwise pass vacuously.
const GATED_CORE_FNS = ['getTradeSignal', 'getMarketRegime', 'scanFundingArb'] as const;

// The files that dispatch a caller's request into those functions.
const DISPATCH_FILES = ['src/index.ts', 'src/lib/x402-http-routes.ts'] as const;

describe('every tool dispatch forwards the caller license', () => {
  const sources = new Map<string, string>(
    DISPATCH_FILES.map((f) => [f, stripComments(readFileSync(resolve(ROOT, f), 'utf8'))]),
  );

  it('the guard is not vacuous — each gated fn has at least one real call site', () => {
    expect(GATED_CORE_FNS.length).toBeGreaterThan(0);
    for (const fn of GATED_CORE_FNS) {
      const total = [...sources.values()].reduce((n, s) => n + objectArgInvocations(s, fn).length, 0);
      expect(total, `${fn} has no dispatch call site — the name is stale or the guard is blind`).toBeGreaterThan(0);
    }
  });

  for (const file of DISPATCH_FILES) {
    for (const fn of GATED_CORE_FNS) {
      it(`${file}: every ${fn}({...}) passes license`, () => {
        for (const call of objectArgInvocations(sources.get(file)!, fn)) {
          expect(
            /(^|[\s,{])license\s*(,|:|\})/.test(call),
            `${fn} invoked without \`license\` in ${file}:\n${call}\n\n` +
              'Omitting it silently meters the caller against the IP-derived free bucket instead ' +
              'of their own — no error, no type failure, and the frozen cutoff stops holding.',
          ).toBe(true);
        }
      });
    }
  }

  it('runScanTradeCall passes the license positionally at every dispatch site', () => {
    // Positional rather than in the options object, so it needs its own shape check.
    for (const [file, src] of sources) {
      const sites = src.split('runScanTradeCall(').slice(1);
      for (const site of sites) {
        const head = site.slice(0, 1200);
        expect(
          /license/.test(head),
          `runScanTradeCall invoked without a license argument in ${file}`,
        ).toBe(true);
      }
    }
  });

  it('the comment stripper does not blind the guard (it removes prose, not code)', () => {
    // A trailing comment must not swallow the code before it, and a block comment that
    // MENTIONS a call must not register as one.
    const sample = 'getMarketRegime({ coin, license }); // getMarketRegime({ coin })\n' +
      '/* getMarketRegime({ coin }) */\n';
    const stripped = stripComments(sample);
    expect(objectArgInvocations(stripped, 'getMarketRegime')).toHaveLength(1);
    expect(objectArgInvocations(stripped, 'getMarketRegime')[0]).toContain('license');
  });
});
