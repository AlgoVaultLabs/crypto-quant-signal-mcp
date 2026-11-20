/**
 * SR-ZONES-W2 CH2 — the Beta mark, projected from ONE registry flag (`beta`, feature-registry.ts).
 *
 * AC2.1 (the iff-test): every §0.3 surface ends ` (Beta)` exactly when the tool's registry row says `beta: true` —
 * tools/list description and title (default and ChatGPT), GET /capabilities, the label on the nav, /tools, the docs
 * heading and llms-full, the llms.txt name, and the lobehub `api[]` description. Planted: the flag off on get_support_resistance_zones
 * → no surface shows it; the flag on pre_trade_check → its surfaces show it.
 *
 * R3: every UNFLAGGED tool's served description, title and label is byte-identical to BASE (3935d83c). The fixture
 * `sr-zones-beta-base-surfaces.json` was captured at 2972dc94 (CH1, which touches no listing surface:
 * `git diff --name-only 3935d83c 2972dc94` names only src/lib/sr-zones/**, get-sr-zones.ts, binance.ts, types.ts and
 * tests). A flagged tool's texts are BASE + ` (Beta)`; the description constants themselves never carry the mark.
 *
 * Requires `npm run build`: the /tools renderer reads dist, so a planted flag is set on the dist registry too.
 *
 * R6 #3 (CH4 audit): two prose sentences that list tool names join the iff-test — the /rest-api FAQ answer "Which tools
 * work over REST, and which need MCP?" (its visible text and its FAQPage JSON-LD both print it) and the /docs TechArticle
 * JSON-LD tool clause. A name there is followed by ` (Beta)` exactly when its row is flagged; code identifiers
 * (`<code>`, curls, the lobehub `name`) stay bare.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BETA_SUFFIX,
  betaMarked,
  getFeature,
  isBetaTool,
  projectCapabilities,
  servedDescription,
  type FeatureSpec,
} from '../../src/lib/feature-registry.js';
import { buildNavModel, publicToolEntries, type NavDropdown } from '../../src/lib/nav-manifest.js';
import { flattenOutline, techArticleToolClause } from '../../src/lib/docs-outline.js';
import { CHANNELS } from '../../src/lib/channel-registry.js';
import { requestContext } from '../../src/lib/license.js';
import { GET_SR_ZONES_DESCRIPTION } from '../../src/tool-descriptions.js';
import * as srZonesSummary from '../../src/lib/sr-zones/summary.js';
import * as schema from '../../src/lib/tool-param-schema.js';
import { renderToolsSentence, renderToolsSections, LLMS_TXT, LLMS_FULL_TXT, LIST_BLOCK, FULL_BLOCK } from '../../scripts/build_llms_tools.mjs';
import { renderToolsPage } from '../../scripts/build_tools_page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
/** The dist registry — the instance the /tools renderer requires (same absolute path, same module). */
const DIST_REGISTRY = (require(join(ROOT, 'dist', 'lib', 'feature-registry.js')) as { FEATURE_REGISTRY: FeatureSpec[] }).FEATURE_REGISTRY;

interface BaseSurfaces {
  tools_list: Record<string, { description: string; title?: string }>;
  tools_list_chatgpt: Record<string, { description: string; title?: string }>;
  capabilities: Record<string, string>;
  labels: Record<string, string>;
}
const BASE = JSON.parse(readFileSync(join(ROOT, 'tests', 'unit', 'sr-zones-beta-base-surfaces.json'), 'utf8')) as BaseSurfaces;

/** ChatGPT's MCP client UA — the one caller served a projected (plain-text) tools/list. */
const CHATGPT_UA = 'openai-mcp/1.0.0';

interface ListedTool { name: string; description: string; annotations?: { title?: string } }

/** tools/list from the REAL server factory (as /mcp builds it), for one caller UA. */
async function listTools(ua: string | null): Promise<ListedTool[]> {
  const { createSandboxServer } = await import('../../src/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const ctx = { license: { tier: 'free', key: null }, sessionId: 'sr-beta', ipHash: 'sr-beta', isAutomated: false, userAgent: ua } as never;
  const server = ua === null ? createSandboxServer() : requestContext.run(ctx, () => createSandboxServer());
  const client = new Client({ name: 'sr-zones-beta', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverT);
    await client.connect(clientT);
    return (await client.listTools()).tools as unknown as ListedTool[];
  } finally {
    await client.close();
    await server.close();
  }
}

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&rarr;/g, '→').replace(/&amp;/g, '&');

/** One tool's text on one surface. */
type Row = { tool: string; surface: string; text: string };

/** The /rest-api FAQ question whose answer lists the tools by name (R6 #3). */
const REST_FAQ_Q = 'Which tools work over REST, and which need MCP?';
/** The source of that answer — what the visible FAQ and the FAQPage JSON-LD both print. */
const restFaqAnswer = (): string => CHANNELS.find((c) => c.key === 'rest-api')!.faq.find((f) => f.q === REST_FAQ_Q)!.a;
/** `name` as a sentence prints it: the bare name, or the name and its mark. */
const nameToken = (text: string, name: string): string | undefined => text.match(new RegExp(`\\b${name}\\b( \\(Beta\\))?`))?.[0];

/** Every §0.3 surface text for every tool that has one, from the CURRENT (possibly planted) registry. */
async function surfaceRows(): Promise<Row[]> {
  const rows: Row[] = [];
  const add = (tool: string, surface: string, text: string | undefined) => {
    if (text !== undefined) rows.push({ tool, surface, text });
  };
  for (const ua of [null, CHATGPT_UA]) {
    const tag = ua === null ? 'tools/list' : 'tools/list (ChatGPT)';
    for (const t of await listTools(ua)) {
      add(t.name, `${tag} description`, t.description);
      add(t.name, `${tag} title`, t.annotations?.title);
    }
  }
  for (const c of projectCapabilities().tools) add(c.name, '/capabilities description', c.description);
  const entries = publicToolEntries();
  for (const e of entries) add(e.name, 'label (publicToolEntries)', e.label);
  const platform = buildNavModel().groups.find((g): g is NavDropdown => g.kind === 'dropdown' && g.label === 'Platform')!;
  for (const item of platform.columns!.find((c) => c.title === 'Tools')!.items) {
    const e = entries.find((x) => item.href === x.href);
    if (e) add(e.name, 'nav Tools column', item.label);
  }
  for (const n of flattenOutline()) if (n.codeName) add(n.codeName, 'docs heading', n.label);
  const sentence = renderToolsSentence(entries, BETA_SUFFIX);
  for (const e of entries) add(e.name, 'llms.txt', sentence.match(new RegExp(`\`${e.name}\`( \\(Beta\\))?`))?.[0]);
  const sections = renderToolsSections(entries, servedDescription, schema).split(/^(?=### \d+\. )/m);
  entries.forEach((e, i) => {
    const lines = sections[i].split('\n');
    add(e.name, 'llms-full heading', lines[0]);
    add(e.name, 'llms-full description', lines[2]);
  });
  const page = renderToolsPage();
  for (const e of entries) {
    const card = page.match(new RegExp(`<article id="${e.anchor}" class="tools-card">([\\s\\S]*?)</article>`))?.[1] ?? '';
    add(e.name, '/tools card title', card.match(/<h3 class="tools-card-title">([^<]*)<\/h3>/)?.[1] && decode(card.match(/<h3 class="tools-card-title">([^<]*)<\/h3>/)![1]));
    add(e.name, '/tools card description', card.match(/<p class="tools-card-desc">([^<]*)<\/p>/)?.[1] && decode(card.match(/<p class="tools-card-desc">([^<]*)<\/p>/)![1]));
  }
  const restFaq = restFaqAnswer();
  const tech = techArticleToolClause();
  for (const e of entries) {
    add(e.name, '/rest-api FAQ', nameToken(restFaq, e.name));
    add(e.name, '/docs TechArticle', nameToken(tech, e.name));
  }
  return rows;
}

/** Every lobehub api[] row whose description is not the served one — what the lockstep test fails on. */
function lobehubOffenders(): string[] {
  const api = (JSON.parse(readFileSync(join(ROOT, 'lobehub-manifest.json'), 'utf8')) as { api: Array<{ name: string; description: string }> }).api;
  return api.filter((r) => r.description !== servedDescription(r.name)).map((r) => r.name);
}

/** The surfaces whose text disagrees with the flag: ends ` (Beta)` exactly when the tool is flagged. */
const iffViolations = (rows: Row[]): string[] =>
  rows.filter((r) => r.text.endsWith(BETA_SUFFIX) !== isBetaTool(r.tool)).map((r) => `${r.tool} · ${r.surface}: ${r.text.slice(-40)}`);

/** Run `fn` with `beta` set to `value` on `name` in the src AND dist registries; restored however `fn` ends. */
async function withFlag<T>(name: string, value: boolean | undefined, fn: () => Promise<T>): Promise<T> {
  const rows = [getFeature(name)!, DIST_REGISTRY.find((f) => f.name === name)!];
  const before = rows.map((r) => ({ had: Object.prototype.hasOwnProperty.call(r, 'beta'), v: r.beta }));
  try {
    for (const r of rows) r.beta = value;
    return await fn();
  } finally {
    rows.forEach((r, i) => {
      if (before[i].had) r.beta = before[i].v;
      else delete r.beta;
    });
  }
}

/** Every §0.3 surface kind, so a surface that silently stops producing rows fails rather than passing on less. */
const SURFACES = [
  'tools/list description', 'tools/list title', 'tools/list (ChatGPT) description', 'tools/list (ChatGPT) title',
  '/capabilities description', 'label (publicToolEntries)', 'nav Tools column', 'docs heading', 'llms.txt',
  'llms-full heading', 'llms-full description', '/tools card title', '/tools card description',
  '/rest-api FAQ', '/docs TechArticle',
];

describe('SR-ZONES-W2 AC2.1 — the Beta iff-test', () => {
  it('the registry flags exactly get_support_resistance_zones', () => {
    expect(publicToolEntries().filter((e) => e.beta).map((e) => e.name)).toEqual(['get_support_resistance_zones']);
    expect(getFeature('get_support_resistance_zones')!.beta).toBe(true);
  });

  it('every §0.3 surface ends " (Beta)" exactly when the row is flagged', async () => {
    const rows = await surfaceRows();
    expect(iffViolations(rows)).toEqual([]);
    // Non-vacuity, at construction: every surface kind produced the flagged tool's row, and the unflagged ones.
    expect(new Set(rows.filter((r) => r.tool === 'get_support_resistance_zones').map((r) => r.surface))).toEqual(new Set(SURFACES));
    expect(rows.filter((r) => r.tool === 'pre_trade_check').length).toBe(SURFACES.length);
    expect(lobehubOffenders()).toEqual([]);
  });

  it('the served strings: the description, the title and the label', async () => {
    const t = (await listTools(null)).find((x) => x.name === 'get_support_resistance_zones')!;
    expect(t.description).toBe(`${GET_SR_ZONES_DESCRIPTION} (Beta)`);
    expect(t.annotations?.title).toBe('Support and Resistance Zones (Beta)');
    expect(publicToolEntries().find((e) => e.name === 'get_support_resistance_zones')!.label).toBe('Support and Resistance Zones (Beta)');
    expect(servedDescription('get_support_resistance_zones')).toBe(`${GET_SR_ZONES_DESCRIPTION} (Beta)`);
  });

  it('the committed artifacts carry the mark: lobehub, llms.txt, llms-full, /tools, /docs', () => {
    const api = (JSON.parse(readFileSync(join(ROOT, 'lobehub-manifest.json'), 'utf8')) as { api: Array<{ name: string; description: string }> }).api;
    for (const r of api) expect(r.description.endsWith(BETA_SUFFIX), r.name).toBe(isBetaTool(r.name));
    const llms = readFileSync(LLMS_TXT, 'utf8');
    const list = llms.slice(llms.indexOf(`<!-- BUILD:${LIST_BLOCK} -->`), llms.indexOf(`<!-- /BUILD:${LIST_BLOCK} -->`));
    for (const e of publicToolEntries()) expect(list.includes(`\`${e.name}\` (Beta)`), e.name).toBe(e.beta);
    const full = readFileSync(LLMS_FULL_TXT, 'utf8');
    const fullBody = full.slice(full.indexOf(`<!-- BUILD:${FULL_BLOCK} -->`), full.indexOf(`<!-- /BUILD:${FULL_BLOCK} -->`));
    for (const e of publicToolEntries()) {
      const heading = fullBody.match(new RegExp(`^### \\d+\\. \`${e.name}\` — (.*)$`, 'm'))?.[1];
      expect(heading, e.name).toBe(e.label);
      expect(heading!.endsWith(BETA_SUFFIX), e.name).toBe(e.beta);
    }
    const docs = readFileSync(join(ROOT, 'landing', 'docs.html'), 'utf8');
    expect(docs).toContain('Support and Resistance Zones (Beta) <span class="text-gray-500 text-sm font-normal">get_support_resistance_zones</span>');
    expect(docs).toContain('<a href="#get-support-resistance-zones" class="sidebar-link" style="padding-left:32px">Support and Resistance Zones (Beta)</a>');
    const tools = readFileSync(join(ROOT, 'landing', 'tools.html'), 'utf8');
    expect(tools).toContain('<h3 class="tools-card-title">Support and Resistance Zones (Beta)</h3>');
    // Every mark on /docs belongs to get_support_resistance_zones: its label, or its name in the TechArticle clause (R6 #3).
    expect(docs.replace(/Support and Resistance Zones \(Beta\)|get_support_resistance_zones \(Beta\)/g, '')).not.toContain('(Beta)');
  });

  it('R6 #3 — the committed /rest-api FAQ (visible and FAQPage JSON-LD) and /docs TechArticle mark exactly the flagged names', () => {
    const rest = readFileSync(join(ROOT, 'landing', 'rest-api.html'), 'utf8');
    const q = REST_FAQ_Q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const visible = decode(rest.match(new RegExp(`<summary>${q}</summary><p>([^<]*)</p>`))![1]);
    const faqLd = JSON.parse(rest.match(/<script type="application\/ld\+json" data-algovault-jsonld="FAQPage">([\s\S]*?)<\/script>/)![1]) as {
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };
    const ld = faqLd.mainEntity.find((q) => q.name === REST_FAQ_Q)!.acceptedAnswer.text;
    const docs = readFileSync(join(ROOT, 'landing', 'docs.html'), 'utf8');
    const tech = (JSON.parse(docs.match(/<script type="application\/ld\+json">\s*(\{[\s\S]*?"@type":\s*"TechArticle"[\s\S]*?\})\s*<\/script>/)![1]) as {
      description: string;
    }).description;
    expect(visible).toBe(restFaqAnswer());
    expect(ld).toBe(restFaqAnswer());
    expect(tech).toContain(techArticleToolClause());
    for (const [where, text] of [['/rest-api FAQ', visible], ['/rest-api FAQPage', ld], ['/docs TechArticle', tech]] as const) {
      for (const e of publicToolEntries()) {
        const tok = nameToken(text, e.name);
        expect(tok, `${where} names ${e.name}`).toBeDefined();
        expect(tok!.endsWith(BETA_SUFFIX), `${where}: ${tok}`).toBe(e.beta);
      }
      expect((text.match(/\(Beta\)/g) ?? []).length, where).toBe(publicToolEntries().filter((e) => e.beta).length);
    }
  });

  it('planted: the flag OFF on get_support_resistance_zones → no surface shows the mark anywhere', async () => {
    await withFlag('get_support_resistance_zones', false, async () => {
      const rows = await surfaceRows();
      expect(iffViolations(rows)).toEqual([]);
      expect(rows.filter((r) => r.text.includes('(Beta)'))).toEqual([]);
      expect(new Set(rows.filter((r) => r.tool === 'get_support_resistance_zones').map((r) => r.surface))).toEqual(new Set(SURFACES));
      expect(publicToolEntries().find((e) => e.name === 'get_support_resistance_zones')!.label).toBe('Support and Resistance Zones');
      // The committed lobehub row still says Beta, so the lockstep gate fails until it is regenerated.
      expect(lobehubOffenders()).toEqual(['get_support_resistance_zones']);
    });
    expect(isBetaTool('get_support_resistance_zones')).toBe(true); // restored
  });

  it('planted: the flag ON pre_trade_check → its surfaces show the mark, the others do not change', async () => {
    await withFlag('pre_trade_check', true, async () => {
      const rows = await surfaceRows();
      expect(iffViolations(rows)).toEqual([]);
      const marked = rows.filter((r) => r.tool === 'pre_trade_check' && r.text.endsWith(BETA_SUFFIX)).map((r) => r.surface);
      expect(new Set(marked)).toEqual(new Set(SURFACES));
      expect(publicToolEntries().find((e) => e.name === 'pre_trade_check')!.label).toBe('Pre-Trade Check (Beta)');
      expect(new Set(rows.filter((r) => r.text.endsWith(BETA_SUFFIX)).map((r) => r.tool))).toEqual(new Set(['pre_trade_check', 'get_support_resistance_zones']));
      expect(lobehubOffenders()).toEqual(['pre_trade_check']);
    });
    expect(isBetaTool('pre_trade_check')).toBe(false); // restored
  });

  it('the composition rule: once, at the end, idempotent; and the llms.txt renderer never drops it silently', () => {
    expect(betaMarked('x', true)).toBe('x (Beta)');
    expect(betaMarked('x (Beta)', true)).toBe('x (Beta)');
    expect(betaMarked('x', false)).toBe('x');
    expect(betaMarked('x', undefined)).toBe('x');
    const flagged = publicToolEntries().filter((e) => e.beta);
    expect(flagged.length).toBeGreaterThan(0);
    expect(() => renderToolsSentence(flagged, undefined)).toThrow(/flagged beta/);
    expect(renderToolsSentence(flagged, BETA_SUFFIX)).toContain('`get_support_resistance_zones` (Beta)');
  });
});

describe('SR-ZONES-W2 R3 — every unflagged tool is served byte-identical to BASE', () => {
  const expected = (name: string, base: string): string => (isBetaTool(name) ? `${base}${BETA_SUFFIX}` : base);
  /** R8: BASE (3935d83c) served the tool as get_sr_zones; it is served as get_support_resistance_zones now, under no other name. */
  const RENAMED: Record<string, string> = { get_sr_zones: 'get_support_resistance_zones' };
  const renamed = <T,>(base: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(base).map(([k, v]) => [RENAMED[k] ?? k, v]));
  /** R8 (Mr.1 Q3): the renamed tool's description is a new text; BASE stays the reference for every other tool. */
  const R8_DESCRIPTION = 'Returns support and resistance zones for one coin on one venue\'s perpetuals, such as Binance, Bybit or OKX, for one to three timeframes. Read-only. Per timeframe: up to 3 support and 3 resistance zones, ranked outward from price, each with its low and high, distance from price, bars touched in the last 90, tests in the last 30, last touch, and whether it flipped between support and resistance after two closes through it. Also returns volume against its 20-bar average and flags such as no zone above (price above every zone in its history). Use with get_trade_call or get_market_regime for the same coin.';
  const described = (name: string, base: string): string => (name === 'get_support_resistance_zones' ? R8_DESCRIPTION : base);

  it('tools/list — description and title, default and ChatGPT callers', async () => {
    for (const [ua, base] of [[null, renamed(BASE.tools_list)], [CHATGPT_UA, renamed(BASE.tools_list_chatgpt)]] as const) {
      const now = await listTools(ua);
      expect(now.map((t) => t.name).sort()).toEqual(Object.keys(base).sort());
      for (const t of now) {
        expect(t.description, `${ua ?? 'default'} ${t.name}`).toBe(expected(t.name, described(t.name, base[t.name].description)));
        if (base[t.name].title === undefined) expect(t.annotations?.title, t.name).toBeUndefined();
        else expect(t.annotations?.title, `${ua ?? 'default'} ${t.name}`).toBe(expected(t.name, base[t.name].title!));
      }
    }
  });

  it('GET /capabilities descriptions', () => {
    const now = projectCapabilities().tools;
    const base = renamed(BASE.capabilities);
    expect(now.map((t) => t.name).sort()).toEqual(Object.keys(base).sort());
    for (const t of now) expect(t.description, t.name).toBe(expected(t.name, described(t.name, base[t.name])));
  });

  it('labels — BASE plus the one newly listed tool', () => {
    const now = Object.fromEntries(publicToolEntries().map((e) => [e.name, e.label]));
    expect(now).toEqual({ ...BASE.labels, get_support_resistance_zones: 'Support and Resistance Zones (Beta)' });
  });

  it('the description constant is the R8 text, unmarked; ORDER (R7) and NOTE (R8) are gone', () => {
    expect(GET_SR_ZONES_DESCRIPTION).toBe(R8_DESCRIPTION);
    expect(BASE.tools_list.get_sr_zones.description).not.toBe(R8_DESCRIPTION);
    expect(GET_SR_ZONES_DESCRIPTION.endsWith(BETA_SUFFIX)).toBe(false);
    expect('SR_ZONES_ORDER' in srZonesSummary).toBe(false);
    expect('SR_ZONES_NOTE' in srZonesSummary).toBe(false);
  });
});
