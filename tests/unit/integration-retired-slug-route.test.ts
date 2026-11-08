/**
 * GET /integrations/:slug against a REAL Express app (no supertest: a listening server plus the
 * platform fetch, the pattern in tests/unit/rail-mount.test.ts).
 *
 * The retired slug is named literally. Deriving it from the table would let an emptied table pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RETIRED_INTEGRATION_SLUGS,
  integrationPageHandler,
} from '../../src/lib/integrations-data/retired-slugs.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.get('/integrations/:slug', integrationPageHandler(new Map([['cursor', '<h1>Cursor</h1>']])));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = (path: string) => fetch(`${base}${path}`, { redirect: 'manual' });

describe('GET /integrations/:slug', () => {
  it.each(['/integrations/smithery', '/integrations/smithery.html', '/integrations/Smithery'])(
    '%s -> 301 Location: /integrations',
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('/integrations');
    },
  );

  it('an unknown slug -> 404, not a redirect', async () => {
    const res = await get('/integrations/not-a-real-slug');
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('an inherited object member is not a retired slug', async () => {
    expect((await get('/integrations/constructor')).status).toBe(404);
    expect((await get('/integrations/__proto__')).status).toBe(404);
  });

  it('a live slug -> 200 with its page', async () => {
    const res = await get('/integrations/cursor');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toBe('<h1>Cursor</h1>');
  });

  it('every retired row redirects to a site-relative path', () => {
    const rows = Object.entries(RETIRED_INTEGRATION_SLUGS);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const [slug, row] of rows) {
      expect(row.to, slug).toMatch(/^\/[^/]/);
      expect(row.retired, slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.why.trim(), slug).not.toBe('');
    }
  });
});

describe('the served route uses this handler', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');

  it("src/index.ts mounts it on '/integrations/:slug'", () => {
    expect(src).toContain("app.get('/integrations/:slug', integrationPageHandler(INTEGRATION_HTML));");
  });

  it('/docs/integrations/:slug still chains to the canonical path', () => {
    expect(src).toMatch(/app\.get\('\/docs\/integrations\/:slug'[\s\S]{0,200}res\.redirect\(301, `\/integrations\/\$\{slug\}`\)/);
  });
});
