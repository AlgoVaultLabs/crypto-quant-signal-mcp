/**
 * tool-description-relational.test.ts — TDQS-RELATIONAL-DEFECTS-W1 CH1.
 *
 * The three existing tool-copy canaries each score ONE string in isolation:
 *   tool-description-forward-stability — volatile counts / win-rate % in one string
 *   tool-description-keywords          — one tool's ≥15/20 keyword coverage + length budget
 *   tool-annotations                   — one tool's annotation-hint shape
 *
 * None of them can see a RELATION — a property between a description and something else.
 * That gap shipped a real defect: three live descriptions referred agents to
 * `get_equity_call` / `get_equity_regime`, tools absent from `tools/list`, and it was found
 * by hand and fixed by hand in `ade0418` (OPS-KNOWLEDGE-BUNDLE-HOLD-PROMISE-W1 CH1). This
 * file makes that class, and three siblings, structurally unwritable.
 *
 *   REL-1  dead-route        — every tool-shaped token in the copy names a LIVE tool
 *   REL-2  collision         — no two live tools share a description
 *   REL-3  param↔enum        — a param's prose does not under-specify its own Zod enum
 *   REL-4  resource-advert   — CH3 owns it (stub below)
 *
 * FORWARD-GUARD STATUS, stated because it changes how a green result reads.
 * REL-1 has ZERO violations on this tree — `ade0418` already cleared them — and REL-4 will
 * have zero as well. They are forward-guards making the shape unwritable, not remediations;
 * the precedent is `scripts/check-jq-truthiness.mjs`, which also found nothing and is worth
 * shipping for the same reason. A guard with nothing to remediate has ONE source of evidence
 * that it works: its dirty-fixture self-test. Those self-tests are therefore load-bearing,
 * not ceremonial, and REL-1 prints an explicit positive line so a green REL-1 is
 * distinguishable from a REL-1 that checked nothing.
 *
 * REL-2 METRIC — max-containment, and the choice is the substance, not the number.
 * An alias is a strict SUPERSET of its parent's description, so the similarity metric must
 * be one that a superset saturates. Measured on this tree, `get_trade_call` vs
 * `get_trade_signal`: token-set Jaccard 0.7778, trigram Dice 0.8651 — BOTH pass a < 0.90
 * threshold, because both divide by the union and are diluted by the alias's added length.
 * Max-containment reads 1.0000. Across all 21 live pairs the runner-up is 0.6667
 * (`get_trade_call` vs `scan_trade_calls`), so the 0.90 line sits in a clean 0.667→1.000
 * gap rather than being tuned to today's wording.
 *
 * HERMETIC. Never introspects a running server, never imports `src/index.ts` (whose
 * bottom-of-file `startHttp()` / `startStdio()` bootstrap is the reason the description
 * constants were hoisted into `src/tool-descriptions.ts` in the first place). REL-3 reads
 * the `z.enum(...).describe(PARAM_DESC_*)` binding sites by STATIC PARSE of the source text
 * and resolves each enum identifier through the file's own imports — a hand-maintained
 * param↔enum table would be a fourth thing to drift, which is the bug class this file exists
 * to close.
 *
 * Prints one terminal `TDQS_RELATIONAL_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit 0 PASS · 1 FAIL · 3 INDETERMINATE (the token-law default for a new gate).
 * Callers gate on the TOKEN, never the code.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FEATURE_REGISTRY, getFeature } from '../../src/lib/feature-registry.js';
import { liveMcpToolNames } from '../../src/lib/equities/equity-tools-flag.js';
import * as DESC from '../../src/tool-descriptions.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

const failures: string[] = [];
/** Records into `failures` AND asserts, so the token can never disagree with the run. */
const check = (cond: boolean, msg: string): void => {
  if (!cond) failures.push(msg);
  expect(cond, msg).toBe(true);
};

/* ─────────────────────────── pure helpers (all self-tested below) ─────────────────────── */

/** Tool-shaped identifiers as they appear inside prose. */
export const TOOL_TOKEN_RE = /\b(?:get|scan|search|chat)_[a-z_]+\b/g;

export function extractToolTokens(text: string): string[] {
  return [...new Set(text.match(TOOL_TOKEN_RE) ?? [])];
}

/** lowercase · strip punctuation · collapse whitespace. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * max(|A∩B|/|A|, |A∩B|/|B|) over normalized token sets. Saturates at 1.0 when either
 * description's vocabulary is wholly contained in the other's — the shape of an alias.
 */
export function maxContainment(a: string, b: string): number {
  const x = new Set(normalize(a).split(' ').filter(Boolean));
  const y = new Set(normalize(b).split(' ').filter(Boolean));
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return Math.max(inter / x.size, inter / y.size);
}

export const COLLISION_THRESHOLD = 0.9;
/** The deprioritisation cue that exempts a declared alias pair. CH2's C2d writes it. */
export const ALIAS_EXEMPT_RE = /prefer \w+ for new integrations/i;
/**
 * "not an exhaustive list" markers.
 *
 * SPEC-LITERAL CORRECTION, recorded rather than silently absorbed. The spec (r2, REL-3)
 * writes this as `/\be\.g\.\b|\bsuch as\b/i`. That trailing `\b` can NEVER match: `e.g.`
 * ends in a non-word character, so a word boundary there requires the NEXT character to be
 * a word character — and every real usage is `e.g. Binance`, i.e. followed by a space.
 * Measured: `/\be\.g\.\b/i.test('e.g. Binance')` → false. Shipping the literal regex
 * flagged `PARAM_DESC_TRADE_CALL_EXCHANGE` and `PARAM_DESC_REGIME_EXCHANGE` — two params
 * that ARE correctly hedged — and would have broken AC 1.1's "exactly 1 param". The
 * trailing `\b` is dropped; the leading one stays, so a bare `eg` still does not hedge.
 * Found by this file's own dirty-fixture self-test on its first run.
 */
export const HEDGE_RE = /\be\.g\.|\bsuch as\b/i;

/** Whole-word, case-insensitive literal mention of an enum member. */
export function namesMember(text: string, member: string): boolean {
  return new RegExp(`\\b${member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

/**
 * `<member> to <member>` — a closed RANGE over two real enum members. Complete by
 * construction, so it is not a partial enumeration and needs no `e.g.` hedge. Without this
 * branch `'Candle timeframe, 1m to 1d. Default 15m.'` reads as "names 3 of 11, unhedged"
 * and false-fires on copy that is already correct.
 */
export function namesRange(text: string, members: readonly string[]): boolean {
  for (const m of text.matchAll(/([A-Za-z0-9_]+)\s+to\s+([A-Za-z0-9_]+)/g)) {
    const lo = m[1].toLowerCase();
    const hi = m[2].toLowerCase();
    const set = new Set(members.map((v) => v.toLowerCase()));
    if (set.has(lo) && set.has(hi)) return true;
  }
  return false;
}

export type ParamEnumVerdict = 'ok-names-all' | 'ok-hedged' | 'ok-range' | 'ok-under-2' | 'violation';

export function paramEnumVerdict(describeText: string, members: readonly string[]): ParamEnumVerdict {
  const named = members.filter((m) => namesMember(describeText, m));
  if (named.length < 2) return 'ok-under-2';
  if (named.length === members.length) return 'ok-names-all';
  if (HEDGE_RE.test(describeText)) return 'ok-hedged';
  if (namesRange(describeText, members)) return 'ok-range';
  return 'violation';
}

/* ───────────────────── static parse: z.enum(X)….describe(PARAM_DESC_Y) ────────────────── */

/** Index of the `)` matching the `(` at `openIdx`, skipping string literals. -1 if unbalanced. */
function matchParen(src: string, openIdx: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export interface EnumBinding { enumArg: string; paramConst: string }

/** Every `z.enum(<arg>)…​.describe(PARAM_DESC_*)` chain in one source text. */
export function findEnumParamBindings(src: string): EnumBinding[] {
  const out: EnumBinding[] = [];
  const NEEDLE = 'z.enum(';
  let i = 0;
  while ((i = src.indexOf(NEEDLE, i)) !== -1) {
    const openIdx = i + NEEDLE.length - 1;
    const closeIdx = matchParen(src, openIdx);
    if (closeIdx < 0) { i = openIdx + 1; continue; }
    const enumArg = src.slice(openIdx + 1, closeIdx).trim();
    let j = closeIdx + 1;
    let paramConst: string | null = null;
    // Walk the chained `.foo(...)` calls looking for `.describe(PARAM_DESC_X)`.
    for (;;) {
      const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(j, j + 400));
      if (!m) break;
      const callOpen = j + m[0].length - 1;
      const callClose = matchParen(src, callOpen);
      if (callClose < 0) break;
      if (m[1] === 'describe') {
        const inner = src.slice(callOpen + 1, callClose).trim();
        const pm = /^(PARAM_DESC_[A-Z0-9_]+)$/.exec(inner);
        if (pm) paramConst = pm[1];
        break;
      }
      j = callClose + 1;
    }
    if (paramConst) out.push({ enumArg, paramConst });
    i = closeIdx + 1;
  }
  return out;
}

/** `import { A, B as C } from './x.js'` → { A: './x.js', C: './x.js' }. */
export function parseNamedImports(src: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of src.matchAll(/import\s*(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const as = /^(\S+)\s+as\s+(\S+)$/.exec(part);
      map[as ? as[2] : part] = m[2];
    }
  }
  return map;
}

/** Inline array literal → its string members. `[]` for a non-literal. */
export function parseInlineEnumArray(arg: string): string[] {
  if (!arg.startsWith('[')) return [];
  return [...arg.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
}

/** Strip a trailing `as <type>` cast: `PROMOTED_VENUE_IDS as [X, ...X[]]` → `PROMOTED_VENUE_IDS`. */
export function stripCast(arg: string): string {
  return arg.replace(/\s+as\s+[\s\S]+$/, '').trim();
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

/* ─────────────────────────────────── corpus construction ──────────────────────────────── */

/** Every exported string constant in tool-descriptions.ts — the copy corpus. */
const COPY_STRINGS: Array<[string, string]> = Object.entries(DESC).filter(
  (e): e is [string, string] => typeof e[1] === 'string',
);

/**
 * Names reachable on the `mcp` channel with NO dark env flag set. Composed from two SoTs
 * rather than a literal: the registry supplies `enabled` + `channels.mcp`, and
 * `liveMcpToolNames({})` (empty env ⇒ every dark flag at its default) supplies the flag leg.
 */
const LIVE_MCP_NAMES: string[] = (() => {
  const undarkened = new Set(liveMcpToolNames({} as NodeJS.ProcessEnv));
  return FEATURE_REGISTRY.filter((f) => f.enabled && f.channels.mcp)
    .flatMap((f) => [f.name, ...f.aliases])
    .filter((n) => undarkened.has(n));
})();

/**
 * A tool's served description. An alias serves canonical + suffix (src/index.ts:583); the
 * suffix constant is found by CONVENTION off the descriptionRef, so a future alias needs no
 * edit here.
 */
function servedDescription(name: string): string {
  const spec = getFeature(name);
  if (!spec) return '';
  const base = (DESC as Record<string, unknown>)[spec.descriptionRef];
  if (typeof base !== 'string') return '';
  if (spec.name === name) return base;
  const suffixKey = spec.descriptionRef.replace(/_DESCRIPTION$/, '_ALIAS_SUFFIX');
  const suffix = (DESC as Record<string, unknown>)[suffixKey];
  return typeof suffix === 'string' ? base + suffix : base;
}

/** REL-3 binding sites, resolved to real enum values. */
interface ResolvedBinding { file: string; paramConst: string; members: string[] }
const bindingErrors: string[] = [];

const RESOLVED_BINDINGS: ResolvedBinding[] = await (async () => {
  const out: ResolvedBinding[] = [];
  for (const file of walkTs(SRC_ROOT)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('z.enum(')) continue;
    const bindings = findEnumParamBindings(src);
    if (bindings.length === 0) continue;
    const imports = parseNamedImports(src);
    for (const b of bindings) {
      const arg = stripCast(b.enumArg);
      if (arg.startsWith('[')) {
        const members = parseInlineEnumArray(arg);
        if (members.length === 0) {
          bindingErrors.push(`${file}: ${b.paramConst} — inline z.enum array parsed to zero members`);
          continue;
        }
        out.push({ file, paramConst: b.paramConst, members });
        continue;
      }
      const spec = imports[arg];
      if (!spec) {
        bindingErrors.push(`${file}: ${b.paramConst} — enum identifier '${arg}' has no named import`);
        continue;
      }
      const abs = spec.startsWith('.') ? resolve(dirname(file), spec) : spec;
      let mod: Record<string, unknown> | null = null;
      for (const cand of [abs, abs.replace(/\.js$/, '.ts')]) {
        try {
          mod = (await import(cand.startsWith('/') ? pathToFileURL(cand).href : cand)) as Record<string, unknown>;
          break;
        } catch { /* try the next candidate */ }
      }
      const value = mod?.[arg];
      if (!Array.isArray(value) || value.length === 0) {
        bindingErrors.push(`${file}: ${b.paramConst} — enum identifier '${arg}' from '${spec}' did not resolve to a non-empty array`);
        continue;
      }
      out.push({ file, paramConst: b.paramConst, members: value.map(String) });
    }
  }
  return out;
})();

/**
 * Vacuity guard, placed where the corpus is CONSTRUCTED. An empty corpus here means this
 * file built nothing — a defect in the test, never a pass. A binding we were HANDED and
 * could not parse is likewise INDETERMINATE, never a silent skip.
 */
const CORPUS_INDETERMINATE: string[] = [
  ...(COPY_STRINGS.length === 0 ? ['tool-descriptions.ts exported zero string constants'] : []),
  ...(LIVE_MCP_NAMES.length === 0 ? ['feature registry yielded zero live mcp-channel tools'] : []),
  ...(RESOLVED_BINDINGS.length === 0 ? ['static parse found zero z.enum(...).describe(PARAM_DESC_*) bindings'] : []),
  ...bindingErrors,
];

/* ──────────────────────────────────────── REL-1 ───────────────────────────────────────── */

describe('REL-1 — dead-route (FORWARD-GUARD: zero violations expected on this tree)', () => {
  it('every tool-shaped token in the copy names a live, non-dark mcp tool', () => {
    const live = new Set(LIVE_MCP_NAMES);
    const seen: string[] = [];
    const dead: string[] = [];
    for (const [constName, text] of COPY_STRINGS) {
      for (const token of extractToolTokens(text)) {
        seen.push(token);
        if (!live.has(token)) dead.push(`${constName} → ${token}`);
      }
    }
    if (dead.length) {
      for (const d of dead) failures.push(`REL-1 dead route: ${d}`);
      throw new Error(
        `REL-1: ${dead.length} dead route(s) — a description refers agents to a tool that is not on tools/list:\n` +
          dead.map((d) => `    ${d}`).join('\n'),
      );
    }
    // The positive line: a green REL-1 must be distinguishable from a REL-1 that checked nothing.
    console.log(`REL-1: ${seen.length} tool-shaped tokens checked, all resolve`);
    expect(seen.length).toBeGreaterThan(0);
  });
});

/* ──────────────────────────────────────── REL-2 ───────────────────────────────────────── */

describe('REL-2 — description collision (max-containment ≥ 0.90)', () => {
  it('no two live mcp tools share a description', () => {
    const offenders: string[] = [];
    for (let i = 0; i < LIVE_MCP_NAMES.length; i++) {
      for (let j = i + 1; j < LIVE_MCP_NAMES.length; j++) {
        const a = LIVE_MCP_NAMES[i];
        const b = LIVE_MCP_NAMES[j];
        const da = servedDescription(a);
        const db = servedDescription(b);
        const score = maxContainment(da, db);
        if (score < COLLISION_THRESHOLD) continue;

        // Exempt a DECLARED alias pair only when the alias's ADDED text carries the
        // deprioritisation cue. The cue and this regex are one contract (CH2 C2d).
        const specA = getFeature(a);
        const specB = getFeature(b);
        const aliasPair = specA && specB && specA.name === specB.name;
        const longer = da.length >= db.length ? da : db;
        const shorter = da.length >= db.length ? db : da;
        const added = longer.startsWith(shorter) ? longer.slice(shorter.length) : longer;
        if (aliasPair && ALIAS_EXEMPT_RE.test(added)) continue;

        offenders.push(
          `${a} vs ${b} — max-containment ${score.toFixed(4)} ≥ ${COLLISION_THRESHOLD}` +
            (aliasPair ? ` (declared alias pair, but its added text lacks the /prefer <tool> for new integrations/ cue)` : ''),
        );
      }
    }
    if (offenders.length) {
      for (const o of offenders) failures.push(`REL-2 collision: ${o}`);
      throw new Error(
        `REL-2: ${offenders.length} description collision(s):\n` + offenders.map((o) => `    ${o}`).join('\n'),
      );
    }
    console.log(`REL-2: ${(LIVE_MCP_NAMES.length * (LIVE_MCP_NAMES.length - 1)) / 2} live pairs checked, none collide`);
  });
});

/* ──────────────────────────────────────── REL-3 ───────────────────────────────────────── */

describe('REL-3 — param prose vs its own Zod enum', () => {
  it('an enum param naming ≥2 members names them all, hedges, or states a range', () => {
    const offenders: string[] = [];
    for (const b of RESOLVED_BINDINGS) {
      const text = (DESC as Record<string, unknown>)[b.paramConst];
      if (typeof text !== 'string') {
        // Handed a binding whose describe() constant does not exist — unparseable, not clean.
        bindingErrors.push(`${b.file}: ${b.paramConst} is not an exported string in tool-descriptions.ts`);
        continue;
      }
      if (paramEnumVerdict(text, b.members) !== 'violation') continue;
      const named = b.members.filter((m) => namesMember(text, m));
      offenders.push(
        `${b.paramConst} (${b.file.replace(REPO_ROOT + '/', '')}) — names ${named.length} of ` +
          `${b.members.length} enum members [${named.join(' ')}] with no e.g./such-as hedge and no range`,
      );
    }
    if (offenders.length) {
      for (const o of offenders) failures.push(`REL-3 param↔enum: ${o}`);
      throw new Error(
        `REL-3: ${offenders.length} param description(s) under-specifying their own enum:\n` +
          offenders.map((o) => `    ${o}`).join('\n') +
          `\n    (scan_trade_calls.exchange is the known live offender — see TDQS-RELATIONAL-DEFECTS-W1 C2c)`,
      );
    }
    console.log(`REL-3: ${RESOLVED_BINDINGS.length} enum-param bindings checked, none under-specify`);
  });
});

/* ──────────────────────────────────────── REL-4 ───────────────────────────────────────── */

describe('REL-4 — documented resource must be advertised', () => {
  it.todo('every resource URI cited in a committed landing/*.html is advertised — CH3 owns this');
});

/* ───────────────────────────── self-tests (prove each can fail) ───────────────────────── */

describe('self-test — REL-1/2/3 each proven to fail dirty and pass clean', () => {
  const LIVE = new Set(['get_trade_call', 'scan_trade_calls']);
  const rel1 = (text: string) => extractToolTokens(text).filter((t) => !LIVE.has(t));

  it('REL-1 clean fixture passes / dirty fixture fails', () => {
    // REL-1 has NO live violation, so this pair is the only evidence the check works.
    expect(rel1('For a whole-market scan use scan_trade_calls.')).toEqual([]);
    expect(rel1('For US stocks use get_equity_call instead.')).toEqual(['get_equity_call']);
    // The extractor itself must not silently stop matching.
    expect(extractToolTokens('a get_trade_call and a chat_knowledge')).toEqual(['get_trade_call', 'chat_knowledge']);
    expect(extractToolTokens('no tool tokens here at all')).toEqual([]);
  });

  it('REL-2 clean fixture passes / dirty fixture fails, and the metric is the one declared', () => {
    const parent = 'Returns a composite verdict for one crypto perpetual futures.';
    const aliasDirty = parent + ' [ALIAS] Same behavior, kept for backward compatibility.';
    const aliasClean = aliasDirty + ' Prefer get_trade_call for new integrations.';
    expect(maxContainment(parent, aliasDirty)).toBeGreaterThanOrEqual(COLLISION_THRESHOLD);
    expect(ALIAS_EXEMPT_RE.test(aliasDirty.slice(parent.length))).toBe(false);   // dirty: no exemption
    expect(ALIAS_EXEMPT_RE.test(aliasClean.slice(parent.length))).toBe(true);    // clean: exempt
    // Unrelated copy must stay well clear of the threshold.
    expect(maxContainment(parent, 'Ranked cross-venue funding arbitrage spreads.')).toBeLessThan(COLLISION_THRESHOLD);
    // Guard the metric CHOICE: a superset must saturate, which is why Jaccard/Dice were rejected.
    expect(maxContainment('alpha beta', 'alpha beta gamma delta epsilon zeta')).toBe(1);
  });

  it('REL-3 clean fixture passes / dirty fixture fails across all four branches', () => {
    const VENUES = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'ASTER'];
    expect(paramEnumVerdict('Venue: BINANCE (default) HL BYBIT OKX BITGET.', VENUES)).toBe('violation');
    expect(paramEnumVerdict('Crypto venue (default Binance), e.g. Binance Bybit OKX.', VENUES)).toBe('ok-hedged');
    expect(paramEnumVerdict('Venue: HL BINANCE BYBIT OKX BITGET ASTER.', VENUES)).toBe('ok-names-all');
    expect(paramEnumVerdict('Venue, such as Binance Bybit.', VENUES)).toBe('ok-hedged');
    expect(paramEnumVerdict('Any supported venue; BINANCE is the default.', VENUES)).toBe('ok-under-2'); // 1 named
    // The hedge marker must actually fire on the shape real copy uses, and only on it.
    expect(HEDGE_RE.test('Crypto venue (default Binance), e.g. Binance Bybit OKX.')).toBe(true);
    expect(HEDGE_RE.test('Venue: BINANCE (default) HL BYBIT OKX BITGET.')).toBe(false);
    expect(HEDGE_RE.test('eg Binance Bybit')).toBe(false);
    const TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
    expect(paramEnumVerdict('Candle timeframe, 1m to 1d. Default 15m.', TFS)).toBe('ok-range');
    expect(paramEnumVerdict('Candle timeframe: 1m 15m 1h. Default 15m.', TFS)).toBe('violation');
    // Whole-word matching: '1m' must not be found inside '15m'.
    expect(namesMember('Default 15m only.', '1m')).toBe(false);
    expect(namesMember('Default 15m only.', '15m')).toBe(true);
    // A range over tokens that are NOT both enum members is not a range.
    expect(namesRange('from dawn to dusk', TFS)).toBe(false);
  });

  /**
   * A hermetic self-test is blind to exactly what its own seam replaces. The three checks
   * above run on inline fixtures, so the STATIC PARSER and the corpus builder — the code
   * that decides what those checks ever see — would otherwise be the only code no scenario
   * executes. Assert the bypassed artifacts directly.
   */
  it('self-test — the bypassed seam: static parser, import resolver, corpus builder', () => {
    const FIXTURE = [
      `import { PUBLIC_VENUE_ENUM, ASSET_CLASSES } from './lib/tool-param-schema.js';`,
      `import { PROMOTED_VENUE_IDS, type PromotedVenueId } from './lib/capabilities.js';`,
      `const S = {`,
      `  timeframe: z.enum(['1m', '4h', '1d']).optional().describe(PARAM_DESC_TRADE_CALL_TIMEFRAME),`,
      `  exchange: z.enum(PUBLIC_VENUE_ENUM).optional().describe(PARAM_DESC_TRADE_CALL_EXCHANGE),`,
      `  scan: z.enum(PROMOTED_VENUE_IDS as [PromotedVenueId, ...PromotedVenueId[]]).default('BINANCE').describe(PARAM_DESC_SCAN_EXCHANGE),`,
      `  klass: z.enum(ASSET_CLASSES).describe(PARAM_DESC_TRADE_CALL_ASSET_CLASS),`,
      `  nodescribe: z.enum(['a', 'b']).optional(),`,
      `};`,
    ].join('\n');

    const found = findEnumParamBindings(FIXTURE);
    expect(found.map((b) => b.paramConst)).toEqual([
      'PARAM_DESC_TRADE_CALL_TIMEFRAME',
      'PARAM_DESC_TRADE_CALL_EXCHANGE',
      'PARAM_DESC_SCAN_EXCHANGE',
      'PARAM_DESC_TRADE_CALL_ASSET_CLASS',
    ]);
    expect(parseInlineEnumArray(found[0].enumArg)).toEqual(['1m', '4h', '1d']);
    // The `as [...]` cast must be stripped, or the identifier never resolves.
    expect(stripCast(found[2].enumArg)).toBe('PROMOTED_VENUE_IDS');
    const imports = parseNamedImports(FIXTURE);
    expect(imports.PUBLIC_VENUE_ENUM).toBe('./lib/tool-param-schema.js');
    expect(imports.PROMOTED_VENUE_IDS).toBe('./lib/capabilities.js');
    expect(imports.PromotedVenueId).toBe('./lib/capabilities.js'); // `type` prefix stripped
    // Balanced-paren scan: a chained call before .describe() must not swallow it.
    expect(findEnumParamBindings(`z.enum(['a']).default('x').describe(PARAM_DESC_A)`)[0].paramConst).toBe('PARAM_DESC_A');
    // A parser that finds nothing must find nothing, not everything.
    expect(findEnumParamBindings('const x = 1;')).toEqual([]);

    // The REAL corpus this file actually consumed — asserted, not assumed.
    expect(COPY_STRINGS.length).toBeGreaterThan(0);
    expect(LIVE_MCP_NAMES.length).toBeGreaterThan(0);
    expect(RESOLVED_BINDINGS.length).toBeGreaterThan(0);
    expect(bindingErrors, `unresolvable enum bindings: ${bindingErrors.join(' | ')}`).toEqual([]);
    // Every live tool must actually have served copy, or REL-2 silently compares empty strings.
    for (const n of LIVE_MCP_NAMES) expect(servedDescription(n).length, `${n} served description`).toBeGreaterThan(0);
  });

  /**
   * The token→exit-code MAPPING is itself a thing that can silently regress (measured
   * elsewhere in this estate: re-coding INDETERMINATE to 0 left a suite fully green).
   */
  it('self-test — verdict token maps to the declared exit code', () => {
    const exitFor = (v: string) => (v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
    expect(exitFor('PASS')).toBe(0);
    expect(exitFor('FAIL')).toBe(1);
    expect(exitFor('INDETERMINATE')).toBe(3);
    expect(verdictOf(['x'], [])).toBe('INDETERMINATE');   // indeterminate outranks failures
    expect(verdictOf([], ['boom'])).toBe('FAIL');
    expect(verdictOf([], [])).toBe('PASS');
  });
});

/* ─────────────────────────────────── terminal verdict ─────────────────────────────────── */

export function verdictOf(indeterminate: string[], fails: string[]): 'PASS' | 'FAIL' | 'INDETERMINATE' {
  if (indeterminate.length > 0) return 'INDETERMINATE';
  return fails.length === 0 ? 'PASS' : 'FAIL';
}

/** A bare `expect()` throws without touching `failures`, so capture it here. */
afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures.push(`test failed: ${ctx.task.name}`);
});

afterAll(() => {
  const verdict = verdictOf(CORPUS_INDETERMINATE, failures);
  for (const r of CORPUS_INDETERMINATE) console.error(`  ? ${r}`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`TDQS_RELATIONAL_VERDICT=${verdict}`);
  if (verdict === 'INDETERMINATE') process.exitCode = 3;
});
