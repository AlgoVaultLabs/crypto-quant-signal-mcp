/**
 * tool-timeframe-strings.test.ts — REGIME-TF-ADMISSION-W1 CH1 (AC2, AC3).
 *
 * Every served string that LISTS timeframes lists exactly its own tool's enum. "Its own" is read off a real
 * `tools/list` from the real server factory, never re-derived here, so the day get_market_regime gains a value
 * the snapshot tools do not, each string is judged against the enum that tool actually serves.
 *
 * Surfaces, each a corpus built in this file (the vacuity guards sit where the corpus is constructed):
 *   A  the served parameter descriptions on `tools/list`, and their `plain` (ChatGPT) projection;
 *   B  every exported string of src/tool-descriptions.ts and its plain projection — a listing string here must be
 *      HELD, so a string on no served tool (an unlisted tool, a Bazaar-only reuse) cannot slip past;
 *   C  the x402 Bazaar input-schema descriptions (the HTTP twin's own schema);
 *   D  the generated /docs parameter rows (landing/docs.html);
 *   E  the generated llms regions this repo writes (BUILD:LLMS_TOOLS_LIST, BUILD:LLMS_FULL_TOOLS).
 *
 * The SENTINEL: a string on any surface naming two or more product timeframes that this file does not HOLD fails.
 * Holding a string means declaring its FORM — `list` (exactly the enum, in order), `range` (`<first> to <last>`) or
 * `example` (an `e.g.` subset) — so a new timeframe-listing string has to be read and classified before it ships.
 *
 * AC2 sits here too: a 15m call to the two snapshot tools is refused before dispatch and the refusal names 1h, 4h
 * and 1d, over MCP and (pre_trade_check, the one with a twin) over the x402 HTTP twin's validator.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const spy = vi.hoisted(() => ({ callTool: 0 }));
vi.mock('../../src/lib/tool-call-pipeline.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/tool-call-pipeline.js')>();
  return {
    ...real,
    callTool: (req: Parameters<typeof real.callTool>[0]) => {
      spy.callTool += 1;
      return real.callTool(req);
    },
  };
});

import * as DESC from '../../src/tool-descriptions.js';
import { plainText } from '../../src/tool-descriptions.js';
import { TIMEFRAMES } from '../../src/lib/capabilities.js';
import { DEFAULT_PERP_TIMEFRAME } from '../../src/lib/market-route.js';
import { BAZAAR_ROUTES } from '../../src/lib/x402-bazaar.js';
import { validateToolInput } from '../../src/lib/x402-http-routes.js';
import { REGIME_SNAPSHOT_TIMEFRAMES } from '../../src/lib/regime-snapshots.js';
import { requestContext } from '../../src/lib/license.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ─────────────────────────────── the extractor and the judge ───────────────────────────────

type Form = 'list' | 'range' | 'example';
const PRODUCT_TF: ReadonlySet<string> = new Set(TIMEFRAMES);
const DURATION = /\b\d{1,2}[mhdw]\b/g;
const DEFAULT_CLAUSE = /\(?\bdefault:?\s+(\d{1,2}[mhdw])\b\)?/i;

/** Two or more distinct PRODUCT timeframes — the sentinel's predicate. `24h volume` names one, and no product one. */
function listsTimeframes(text: string): boolean {
  return new Set((text.match(DURATION) ?? []).filter((t) => PRODUCT_TF.has(t))).size >= 2;
}

/** The listed tokens (in order, the default clause removed) and the stated default, if any. */
function parse(text: string): { tokens: string[]; stated: string | null } {
  const m = DEFAULT_CLAUSE.exec(text);
  const rest = m ? text.replace(m[0], ' ') : text;
  return { tokens: rest.match(DURATION) ?? [], stated: m ? m[1] : null };
}

/** Problems with one string against one enum; empty = it states exactly what the tool serves. */
function judge(text: string, form: Form, values: readonly string[], dflt: string | null): string[] {
  const out: string[] = [];
  const { tokens, stated } = parse(text);
  const want = [...values];
  if (form === 'list' && JSON.stringify(tokens) !== JSON.stringify(want)) out.push(`lists [${tokens}] but the enum is [${want}]`);
  if (form === 'range') {
    const ends = [want[0], want[want.length - 1]];
    if (JSON.stringify(tokens) !== JSON.stringify(ends) || !text.includes(`${ends[0]} to ${ends[1]}`)) {
      out.push(`range [${tokens}] is not "${ends[0]} to ${ends[1]}" over [${want}]`);
    }
  }
  if (form === 'example') {
    if (!/\be\.g\./.test(text)) out.push('an example must say e.g.');
    const foreign = tokens.filter((t) => !want.includes(t));
    if (tokens.length === 0 || foreign.length) out.push(`example names [${foreign}] outside [${want}]`);
  }
  if (stated !== null && stated !== dflt) out.push(`states default ${stated} but the default is ${dflt ?? 'none'}`);
  return out;
}

/**
 * THE HOLD: every src/tool-descriptions.ts constant that lists timeframes, by NAME, with its form. A served default
 * wins; `runtimeDefault` is for a tool whose schema declares none (get_trade_call's resolver applies 15m).
 */
const HELD: Readonly<Record<string, { form: Form; runtimeDefault?: string }>> = {
  PARAM_DESC_REGIME_TIMEFRAME: { form: 'list' },
  PARAM_DESC_REGIME_SCAN_TIMEFRAME: { form: 'list' },
  PARAM_DESC_PRE_TRADE_TIMEFRAME: { form: 'list' },
  PARAM_DESC_TRADE_CALL_TIMEFRAME: { form: 'range', runtimeDefault: DEFAULT_PERP_TIMEFRAME },
  PARAM_DESC_SCAN_TIMEFRAME: { form: 'range' },
  PARAM_DESC_SCAN_OI_CHANGE_WINDOW: { form: 'list' },
  PARAM_DESC_SR_ZONES_TIMEFRAMES: { form: 'example' },
};

const descStrings = (): Array<[string, string]> =>
  Object.entries(DESC).filter((e): e is [string, string] => typeof e[1] === 'string');

/** text → the hold that covers it (the constant, and its plain projection). */
function heldByText(): Map<string, { name: string; form: Form; runtimeDefault?: string }> {
  const m = new Map<string, { name: string; form: Form; runtimeDefault?: string }>();
  for (const [name, spec] of Object.entries(HELD)) {
    const text = (DESC as Record<string, unknown>)[name];
    if (typeof text !== 'string') throw new Error(`HELD names ${name}, which src/tool-descriptions.ts does not export`);
    m.set(text, { name, ...spec });
    m.set(plainText(text), { name, ...spec });
  }
  return m;
}

// ─────────────────────────────── the served schema ───────────────────────────────

interface Prop { description?: string; enum?: string[]; default?: unknown; items?: Prop }
interface Listed { name: string; inputSchema: { properties?: Record<string, Prop> } }
let listed: Listed[] = [];
let mcp: { client: { close(): Promise<void>; callTool(a: unknown): Promise<unknown> }; server: { close(): Promise<void> } } | null = null;

beforeAll(async () => {
  const { createSandboxServer } = await import('../../src/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createSandboxServer();
  const client = new Client({ name: 'tool-timeframe-strings', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
  listed = (await client.listTools()).tools as unknown as Listed[];
  mcp = { client: client as never, server: server as never };
}, 60_000);
afterAll(async () => {
  await mcp?.client.close();
  await mcp?.server.close();
});

const propOf = (tool: string, param: string): Prop => {
  const t = listed.find((x) => x.name === tool);
  if (!t) throw new Error(`${tool} is not on tools/list`);
  const p = t.inputSchema.properties?.[param];
  if (!p) throw new Error(`${tool}.${param} is not a served parameter`);
  return p;
};
const enumOf = (p: Prop): string[] => p.enum ?? p.items?.enum ?? [];
const servedDefault = (p: Prop): string | null => (typeof p.default === 'string' ? p.default : null);

/** Surface A: every served parameter whose description lists timeframes — the corpus, built here. */
function servedListings(): Array<{ tool: string; param: string; prop: Prop; text: string }> {
  const out: Array<{ tool: string; param: string; prop: Prop; text: string }> = [];
  for (const t of listed) {
    for (const [param, prop] of Object.entries(t.inputSchema.properties ?? {})) {
      for (const text of [prop.description ?? '', plainText(prop.description ?? '')]) {
        if (listsTimeframes(text)) out.push({ tool: t.name, param, prop, text });
      }
    }
  }
  return out;
}

// ─────────────────────────────── the tests ───────────────────────────────

describe('the judge can fail (two-way self-test)', () => {
  it('flags a short list, a wrong range, a foreign example and a wrong default; passes the exact forms', () => {
    expect(judge('Regime timeframe: 1h or 4h (default 4h).', 'list', ['1h', '4h', '1d'], '4h')).toHaveLength(1);
    expect(judge('Regime timeframe: 1h, 4h or 1d (default 4h).', 'list', ['1h', '4h', '1d', '15m'], '4h')).toHaveLength(1);
    expect(judge('Candle timeframe, 1m to 4h.', 'range', TIMEFRAMES, null)).toHaveLength(1);
    expect(judge('e.g. ["1h", "3d"]', 'example', ['1h', '4h'], null)).toHaveLength(1);
    expect(judge('Regime timeframe: 1h, 4h or 1d (default 1d).', 'list', ['1h', '4h', '1d'], '4h')).toHaveLength(1);
    expect(judge('Regime timeframe: 1h, 4h or 1d (default 4h).', 'list', ['1h', '4h', '1d'], '4h')).toEqual([]);
    expect(judge('Candle timeframe, 1m to 1d. Default 15m.', 'range', TIMEFRAMES, '15m')).toEqual([]);
  });

  it('the sentinel predicate fires on an unheld listing and stays quiet on prose naming one or no product timeframe', () => {
    const held = heldByText();
    const injected = 'Candle timeframe: 1h or 4h.';
    expect(listsTimeframes(injected)).toBe(true);
    expect(held.has(injected)).toBe(false);
    expect(listsTimeframes('Drop assets whose 24h notional volume is below this floor.')).toBe(false);
    expect(listsTimeframes('A 4h call is relevant for several hours.')).toBe(false);
  });
});

describe('A — every served parameter description that lists timeframes states its own tool\'s enum', () => {
  it('the corpus is real: every held constant is served, on the tools it describes', () => {
    const rows = servedListings();
    expect(listed.length).toBeGreaterThanOrEqual(9);
    const keys = new Set(rows.map((r) => `${r.tool}.${r.param}`));
    for (const k of [
      'get_market_regime.timeframe', 'scan_market_regimes.timeframe', 'pre_trade_check.timeframe',
      'get_trade_call.timeframe', 'scan_trade_calls.timeframe', 'scan_trade_calls.oiChangeWindow',
      'scan_market_regimes.oiChangeWindow', 'get_support_resistance_zones.timeframes',
    ]) expect(keys, k).toContain(k);
  });

  it('each one is held, and judged against the enum and default that tool serves', () => {
    const held = heldByText();
    const problems: string[] = [];
    for (const r of servedListings()) {
      const h = held.get(r.text);
      if (!h) { problems.push(`UNHELD ${r.tool}.${r.param}: "${r.text}"`); continue; }
      const dflt = servedDefault(r.prop) ?? h.runtimeDefault ?? null;
      for (const p of judge(r.text, h.form, enumOf(r.prop), dflt)) problems.push(`${r.tool}.${r.param} (${h.name}): ${p}`);
    }
    expect(problems).toEqual([]);
  });

  it('the scan string AC names: scan_market_regimes serves "Regime timeframe: 1h, 4h or 1d (default 4h)."', () => {
    expect(propOf('scan_market_regimes', 'timeframe').description).toBe('Regime timeframe: 1h, 4h or 1d (default 4h).');
  });
});

describe('B — the sentinel over every tool-descriptions string', () => {
  it('no constant lists timeframes without a hold, and every hold still lists them (no stale hold)', () => {
    const held = heldByText();
    const strings = descStrings();
    expect(strings.length).toBeGreaterThan(50); // the corpus was built, not handed in empty
    const unheld: string[] = [];
    for (const [name, text] of strings) {
      for (const t of [text, plainText(text)]) if (listsTimeframes(t) && !held.has(t)) unheld.push(`${name}: "${t}"`);
    }
    expect(unheld).toEqual([]);
    for (const name of Object.keys(HELD)) {
      expect(listsTimeframes((DESC as Record<string, string>)[name]), `${name} no longer lists timeframes — drop the hold`).toBe(true);
    }
  });
});

describe('C — the x402 Bazaar schemas (the HTTP twin validates against them)', () => {
  it('every Bazaar property description that lists timeframes is held and states that property\'s own enum', () => {
    const held = heldByText();
    const problems: string[] = [];
    let props = 0;
    for (const [tool, spec] of Object.entries(BAZAAR_ROUTES)) {
      const properties = (spec.inputSchema as { properties?: Record<string, Prop> }).properties ?? {};
      for (const [param, prop] of Object.entries(properties)) {
        props += 1;
        const text = prop.description ?? '';
        if (!listsTimeframes(text)) continue;
        const h = held.get(text);
        if (!h) { problems.push(`UNHELD bazaar ${tool}.${param}: "${text}"`); continue; }
        for (const p of judge(text, h.form, enumOf(prop), servedDefault(prop) ?? h.runtimeDefault ?? null)) problems.push(`bazaar ${tool}.${param}: ${p}`);
      }
    }
    expect(props).toBeGreaterThan(10);
    expect(problems).toEqual([]);
    expect(enumOf((BAZAAR_ROUTES.pre_trade_check.inputSchema as { properties: Record<string, Prop> }).properties.timeframe)).toEqual([...REGIME_SNAPSHOT_TIMEFRAMES]);
  });
});

describe('D — the generated /docs parameter rows', () => {
  const html = read('landing/docs.html');
  const rows = [...html.matchAll(/<tr class="param-row"([^>]*)>([\s\S]*?)<\/tr>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
  const text = (body: string) => body.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

  it('every projected row lists exactly its tool\'s served enum and default', () => {
    const problems: string[] = [];
    let projected = 0;
    for (const r of rows) {
      const tool = /data-schema-tool="([^"]+)"/.exec(r.attrs)?.[1];
      const param = /data-schema-param="([^"]+)"/.exec(r.attrs)?.[1];
      if (!tool || !param) continue;
      const chips = [...r.body.matchAll(/data-enum-value="([^"]+)"/g)].map((m) => m[1]);
      if (!chips.some((c) => PRODUCT_TF.has(c))) continue;
      projected += 1;
      const prop = propOf(tool, param);
      if (JSON.stringify(chips) !== JSON.stringify(enumOf(prop))) problems.push(`/docs ${tool}.${param} lists [${chips}], served [${enumOf(prop)}]`);
      const d = /data-schema-default="([^"]+)"/.exec(r.attrs)?.[1] ?? null;
      if (d !== servedDefault(prop)) problems.push(`/docs ${tool}.${param} default ${d}, served ${servedDefault(prop)}`);
    }
    // get_trade_call, get_market_regime, scan_trade_calls (timeframe + oiChangeWindow), scan_market_regimes (both), pre_trade_check.
    expect(projected).toBe(7);
    expect(problems).toEqual([]);
  });

  it('a hand-written row that lists timeframes carries a held constant verbatim', () => {
    const held = heldByText();
    const unheld: string[] = [];
    for (const r of rows) {
      if (/data-schema-tool=/.test(r.attrs)) continue;
      const t = text(r.body);
      if (!listsTimeframes(t)) continue;
      if (![...held.keys()].some((h) => t.includes(h))) unheld.push(t);
    }
    expect(rows.length).toBeGreaterThan(50);
    expect(unheld).toEqual([]);
  });
});

describe('E — the generated llms regions', () => {
  /** Lines inside one BUILD region of a file, with the `### n. \`tool\`` section each sits under. */
  function region(rel: string, block: string): Array<{ tool: string | null; line: string }> {
    const src = read(rel);
    const start = src.indexOf(`<!-- BUILD:${block} -->`);
    const end = src.indexOf(`<!-- /BUILD:${block} -->`);
    expect(start, `${rel} ${block} start`).toBeGreaterThan(-1);
    expect(end, `${rel} ${block} end`).toBeGreaterThan(start);
    let tool: string | null = null;
    return src.slice(start, end).split('\n').map((line) => {
      const h = /^### \d+\. `([a-z_]+)`/.exec(line);
      if (h) tool = h[1];
      return { tool, line };
    });
  }

  it('every line listing timeframes in BUILD:LLMS_FULL_TOOLS / BUILD:LLMS_TOOLS_LIST states its tool\'s served enum', () => {
    const lines = [...region('landing/llms-full.txt', 'LLMS_FULL_TOOLS'), ...region('landing/llms.txt', 'LLMS_TOOLS_LIST')];
    expect(lines.length).toBeGreaterThan(20);
    const problems: string[] = [];
    let judged = 0;
    for (const { tool, line } of lines) {
      if (!listsTimeframes(line)) continue;
      const param = /^- `(\w+)`/.exec(line)?.[1];
      if (!tool || !param) { problems.push(`UNHELD llms line: "${line}"`); continue; }
      judged += 1;
      const quoted = [...line.matchAll(/`"([^"`]+)"`/g)].map((m) => m[1]);
      if (JSON.stringify(quoted) !== JSON.stringify(enumOf(propOf(tool, param)))) problems.push(`llms ${tool}.${param} lists [${quoted}], served [${enumOf(propOf(tool, param))}]`);
    }
    expect(judged).toBeGreaterThanOrEqual(1); // get_trade_call's timeframe enum line
    expect(problems).toEqual([]);
  });
});

describe('AC2 — 15m to a snapshot tool is refused before dispatch, naming 1h, 4h and 1d', () => {
  const ctx = { license: { tier: 'free', key: null, outcome: 'RESOLVED' }, sessionId: 'tf-strings', ipHash: 'v2:tfstrings000000', isAutomated: false };
  const call = (name: string, args: Record<string, unknown>) =>
    requestContext.run(ctx as never, () => mcp!.client.callTool({ name, arguments: args })) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

  for (const [tool, args] of [
    ['scan_market_regimes', { timeframe: '15m' }],
    ['pre_trade_check', { coin: 'BTC', side: 'long', sizeUsd: 1000, timeframe: '15m' }],
  ] as const) {
    it(`MCP: ${tool} refuses 15m in the SDK's zod parse — the pipeline (the only dispatcher and meter) never runs`, async () => {
      const before = spy.callTool;
      const r = await call(tool, { ...args });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Expected '1h' | '4h' | '1d', received '15m'");
      expect(spy.callTool, 'a refused call reached the pipeline').toBe(before);
      // Positive control: the same call on a served timeframe does reach the pipeline (a local install then
      // refuses it as hosted_only, before any quota or upstream read).
      await call(tool, { ...args, timeframe: '4h' });
      expect(spy.callTool).toBe(before + 1);
    });
  }

  it('x402 HTTP twin: pre_trade_check\'s validator refuses 15m with the allowed values 1h, 4h, 1d', () => {
    const r = validateToolInput('pre_trade_check', { coin: 'BTC', side: 'long', sizeUsd: 1000, timeframe: '15m' }, { 'content-type': 'application/json' });
    expect(r.ok).toBe(false);
    const rej = (r as { rejection: { kind: string; errors: Array<{ keyword: string; instancePath: string; params: { allowedValues?: string[] } }> } }).rejection;
    expect(rej.kind).toBe('invalid_input');
    const e = rej.errors.find((x) => x.keyword === 'enum' && x.instancePath === '/timeframe');
    expect(e?.params.allowedValues).toEqual(['1h', '4h', '1d']);
  });

  it('x402 HTTP twin: that refusal is unbilled — the route validates before it claims or settles a payment', () => {
    const s = read('src/lib/x402-http-routes.ts');
    const gate = s.indexOf('const gate = validateToolInput(tool, req.body');
    const claim = s.indexOf('await tryClaimPayment(');
    expect(gate).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(gate);
  });

  it('scan_market_regimes has no x402 HTTP twin to refuse on (httpX402: false) — MCP is its only rail', () => {
    expect(BAZAAR_ROUTES.scan_market_regimes).toBeUndefined();
  });
});
