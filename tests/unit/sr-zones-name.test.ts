/**
 * SR-ZONES-W2 R8 (Mr.1, Q1) — the served name is get_support_resistance_zones, with no alias.
 *
 * No served or generated public surface names the old get_sr_zones: tools/list (any caller), /capabilities,
 * landing/** and docs/** (the llms files included), lobehub-manifest.json, the x402 route and the Bazaar
 * declaration. A tools/call for get_sr_zones is refused as an unknown tool. Internal identifiers (the
 * src/lib/sr-zones/ modules, get-sr-zones.ts, runGetSrZones, GET_SR_ZONES_DESCRIPTION, these test files) keep
 * their names; that is what these tests do not read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_REGISTRY, getFeature, projectCapabilities } from '../../src/lib/feature-registry.js';
import { BAZAAR_ROUTES } from '../../src/lib/x402-bazaar.js';
import { HTTP_TOOLS } from '../../src/lib/x402-http-routes.js';
import { requestContext } from '../../src/lib/license.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD = 'get_sr_zones';
const NEW = 'get_support_resistance_zones';

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** A client on the REAL server factory (as /mcp builds it), for one caller user agent (null: no request context). */
async function withClient<T>(ua: string | null, body: (client: import('@modelcontextprotocol/sdk/client/index.js').Client) => Promise<T>): Promise<T> {
  const { createSandboxServer } = await import('../../src/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const ctx = { license: { tier: 'free', key: null }, sessionId: 'sr-name', ipHash: 'sr-name', isAutomated: false, userAgent: ua } as never;
  const server = ua === null ? createSandboxServer() : requestContext.run(ctx, () => createSandboxServer());
  const client = new Client({ name: 'sr-zones-name', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverT);
    await client.connect(clientT);
    return await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('SR-ZONES-W2 R8 — the served name is get_support_resistance_zones, and get_sr_zones is gone', () => {
  it('the registry row carries the new name and no alias; nothing is registered under the old one', () => {
    expect(getFeature(OLD)).toBeUndefined();
    expect(getFeature(NEW)).toMatchObject({ name: NEW, aliases: [], publicListing: true, beta: true });
    expect(FEATURE_REGISTRY.flatMap((f) => [f.name, ...f.aliases])).not.toContain(OLD);
  });

  it.each([null, 'openai-mcp/1.0.0'])('tools/list (caller %s) lists the new name and never the old', async (ua) => {
    const tools = await withClient(ua, async (c) => (await c.listTools()).tools);
    expect(tools.map((t) => t.name)).toContain(NEW);
    expect(JSON.stringify(tools)).not.toContain(OLD);
  });

  it('tools/call get_sr_zones is refused as an unknown tool', async () => {
    const outcome = await withClient(null, async (c) => {
      try {
        const r = (await c.callTool({ name: OLD, arguments: { coin: 'BTC', timeframes: ['1d'] } })) as { isError?: boolean; content?: Array<{ text?: string }> };
        return { threw: false, isError: r.isError === true, text: r.content?.map((x) => x.text ?? '').join(' ') ?? '' };
      } catch (err) {
        return { threw: true, isError: true, text: err instanceof Error ? err.message : String(err) };
      }
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/not found|unknown tool/i);
    expect(outcome.text).toContain(OLD);
  });

  it('/capabilities names the new name and never the old', () => {
    const caps = projectCapabilities();
    expect(caps.tools.map((t) => t.name)).toContain(NEW);
    expect(JSON.stringify(caps)).not.toContain(OLD);
  });

  it('the x402 route and the Bazaar declaration use the new name', () => {
    expect(HTTP_TOOLS).toContain(NEW);
    expect(HTTP_TOOLS as readonly string[]).not.toContain(OLD);
    expect(Object.keys(BAZAAR_ROUTES)).toContain(NEW);
    expect(BAZAAR_ROUTES[NEW as keyof typeof BAZAAR_ROUTES]!.toolName).toBe(NEW);
    expect(JSON.stringify(BAZAAR_ROUTES)).not.toContain(OLD);
  });

  it('lobehub-manifest.json lists the new name in api[] and never names the old', () => {
    const text = readFileSync(join(ROOT, 'lobehub-manifest.json'), 'utf8');
    const manifest = JSON.parse(text) as { api: Array<{ name: string }> };
    expect(manifest.api.map((a) => a.name)).toContain(NEW);
    expect(text).not.toContain(OLD);
  });

  it('no file under landing/ or docs/ (the llms files included) names get_sr_zones; the docs page, /tools and both llms files name the new one', () => {
    const files = [...filesUnder(join(ROOT, 'landing')), ...filesUnder(join(ROOT, 'docs'))];
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(OLD)).map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
    for (const f of ['landing/docs.html', 'landing/tools.html', 'landing/llms.txt', 'landing/llms-full.txt']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).toContain(NEW);
    }
  });
});
