/**
 * OPS-NODE-SECURITY-FLOOR-W1 CH2 R2 — refuseEncodedBodies, the first middleware of each app.
 *
 *   1. The judgement, mode by mode and coding by coding, over a real socket.
 *   2. Router-stack walk: every route src/ registers on `app` with a literal path is registered
 *      on a harness app behind the middleware, mounted as production mounts it (first). The walk
 *      sends each body-bearing route a br, gzip, deflate and identity body in both modes, and
 *      each GET route a bodiless request labelled `br`. Routes on computed paths (okx-a2mcp,
 *      x402-http-routes) are covered because the refusal never looks at the path, which an
 *      unregistered path proves below.
 *   3. Source rule: in every file that builds an express app, the mount is the first use of
 *      `app` after `express()`.
 *   4. REFUSE_ENCODED_BODIES_MODE resolution and the boot line.
 *   5. The Stripe webhook route: a signed body crosses the mount byte for byte and verifies; the
 *      same event labelled `br` is refused before verification.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import ts from 'typescript';
import express from 'express';
import Stripe from 'stripe';
import { refuseEncodedBodies, refuseEncodedBodiesFromEnv, type RefuseEncodedBodiesMode } from '../../src/lib/refuse-encoded-bodies.js';

const PLAIN = { query: 'btc' };
const PLAIN_BYTES = Buffer.from(JSON.stringify(PLAIN));
const BODY_IN: Record<string, Buffer> = {
  identity: PLAIN_BYTES,
  gzip: zlib.gzipSync(PLAIN_BYTES),
  deflate: zlib.deflateSync(PLAIN_BYTES),
  br: zlib.brotliCompressSync(PLAIN_BYTES), // valid bytes: never fed to a decoder anyway
};
const REFUSAL = {
  ok: false,
  code: 'unsupported_content_encoding',
  error: 'compressed request bodies are not accepted',
  suggested_action: 'Send the body uncompressed (omit the Content-Encoding header).',
};

// ── a real socket ───────────────────────────────────────────────────────────

interface Reply { status: number; json: any }

/** One request on its own connection. `chunked` sends the body without a Content-Length. */
function send(port: number, method: string, urlPath: string, opts: { coding?: string; body?: Buffer; chunked?: boolean; headers?: http.OutgoingHttpHeaders } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { ...opts.headers };
    if (opts.coding !== undefined) headers['content-encoding'] = opts.coding;
    if (opts.body) {
      headers['content-type'] = 'application/json';
      if (!opts.chunked) headers['content-length'] = opts.body.length;
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = text;
        try { json = JSON.parse(text); } catch { /* not JSON — keep the text */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function serve(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** The app head as production builds it: the refusal first, then a route that echoes what it parsed. */
function oneRouteApp(mount: express.RequestHandler): express.Express {
  const app = express();
  app.use(mount);
  app.post('/echo', express.json(), (req, res) => { res.json({ reached: true, body: req.body }); });
  app.get('/echo', (_req, res) => { res.json({ reached: true }); });
  return app;
}

// ── 1. the judgement ────────────────────────────────────────────────────────

describe('refuseEncodedBodies: the judgement', () => {
  const servers: Record<RefuseEncodedBodiesMode, { port: number; close: () => Promise<void> }> = {} as never;

  beforeAll(async () => {
    servers.brotli = await serve(oneRouteApp(refuseEncodedBodies({ mode: 'brotli' })));
    servers.all = await serve(oneRouteApp(refuseEncodedBodies({ mode: 'all' })));
  });
  afterAll(async () => { await servers.brotli.close(); await servers.all.close(); });

  // [mode, Content-Encoding header (undefined = absent), body bytes, refused?]
  const rows: [RefuseEncodedBodiesMode, string | undefined, keyof typeof BODY_IN, boolean][] = [
    ['brotli', undefined, 'identity', false],
    ['brotli', '', 'identity', false],
    ['brotli', 'identity', 'identity', false],
    ['brotli', 'gzip', 'gzip', false],
    ['brotli', 'GZIP', 'gzip', false],
    ['brotli', 'deflate', 'deflate', false],
    ['brotli', 'br', 'br', true],
    ['brotli', 'BR', 'br', true],
    ['brotli', ' br ', 'br', true],
    ['brotli', 'gzip, br', 'br', true],
    ['brotli', 'br, gzip', 'br', true],
    ['brotli', 'zstd', 'identity', true],
    ['brotli', 'x-gzip', 'gzip', true],
    ['brotli', 'compress', 'identity', true],
    ['all', undefined, 'identity', false],
    ['all', '', 'identity', false],
    ['all', 'identity', 'identity', false],
    ['all', 'gzip', 'gzip', true],
    ['all', 'deflate', 'deflate', true],
    ['all', 'br', 'br', true],
    ['all', 'identity, gzip', 'gzip', true],
  ];

  for (const [mode, coding, bodyKey, refused] of rows) {
    it(`${mode}: Content-Encoding ${coding === undefined ? '(absent)' : JSON.stringify(coding)} → ${refused ? '415' : 'passes, body parsed'}`, async () => {
      const reply = await send(servers[mode].port, 'POST', '/echo', { coding, body: BODY_IN[bodyKey] });
      if (refused) expect(reply).toEqual({ status: 415, json: REFUSAL });
      else expect(reply).toEqual({ status: 200, json: { reached: true, body: PLAIN } });
    });
  }

  it('a chunked body (Transfer-Encoding, no Content-Length) is judged too', async () => {
    const reply = await send(servers.brotli.port, 'POST', '/echo', { coding: 'br', body: BODY_IN.br, chunked: true });
    expect(reply).toEqual({ status: 415, json: REFUSAL });
  });

  it('a GET that carries a br body is refused — the test is the body, not the method', async () => {
    const reply = await send(servers.brotli.port, 'GET', '/echo', { coding: 'br', body: BODY_IN.br });
    expect(reply).toEqual({ status: 415, json: REFUSAL });
  });

  it('a bodiless GET labelled br passes in both modes', async () => {
    for (const mode of ['brotli', 'all'] as const) {
      expect(await send(servers[mode].port, 'GET', '/echo', { coding: 'br' })).toEqual({ status: 200, json: { reached: true } });
    }
  });

  it('the refusal never looks at the path: an unregistered path is refused before routing', async () => {
    expect(await send(servers.brotli.port, 'POST', '/no/such/route', { coding: 'br', body: BODY_IN.br })).toEqual({ status: 415, json: REFUSAL });
    expect((await send(servers.brotli.port, 'POST', '/no/such/route', { body: BODY_IN.identity })).status).toBe(404);
  });
});

// ── 2. router-stack walk ────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);
const BODY_METHODS = new Set(['post', 'put', 'patch', 'delete', '_all']);

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

const parse = (file: string, text: string): ts.SourceFile => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

interface RouteDecl { file: string; method: string; path: string }

/** Every `app.<method>('<literal path>', …handlers)` in src/ (a one-argument app.get is a settings read). */
function literalRoutes(): RouteDecl[] {
  const out: RouteDecl[] = [];
  for (const file of tsFiles(SRC)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app'
        && ROUTE_METHODS.has(node.expression.name.text) && node.arguments.length >= 2) {
        const first = node.arguments[0];
        if ((ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && first.text.startsWith('/')) {
          out.push({ file: rel(file), method: node.expression.name.text, path: first.text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file, fs.readFileSync(file, 'utf8')));
  }
  return out;
}

/** A concrete URL the express 4 path pattern matches: params become 1, wildcards become x. */
const concrete = (pattern: string): string => pattern.replace(/:\w+(\([^)]*\))?\??/g, '1').replace(/\*/g, 'x');

interface StackLayer { route?: { path: string; methods: Record<string, boolean> } }

describe('router-stack walk: every route src/ registers, behind the mount', () => {
  const routes = literalRoutes();
  const bodyRoutes = routes.filter((r) => r.method !== 'get');

  it('the walk is not vacuous — the anchor routes of both apps are in it', () => {
    const keys = new Set(routes.map((r) => `${r.method.toUpperCase()} ${r.path} (${r.file})`));
    for (const anchor of [
      'POST /api/search (index.ts)',
      'POST /webhooks/stripe (index.ts)',
      'ALL /mcp (index.ts)',
      'POST /verify (facilitator.ts)',
      'POST /settle (facilitator.ts)',
      'POST /api/webhooks/:id/test (lib/webhook-api.ts)',
    ]) expect(keys, anchor).toContain(anchor);
    expect(bodyRoutes.length).toBeGreaterThanOrEqual(20);
  });

  /**
   * Register every enumerated route on a harness app, walk its router stack and send each route
   * what the mode must refuse and what it must pass. `mountFirst: false` is the negative control.
   */
  async function walk(mode: RefuseEncodedBodiesMode, { mountFirst }: { mountFirst: boolean }): Promise<{ layers: number; requests: number; failures: string[] }> {
    const app = express();
    if (mountFirst) app.use(refuseEncodedBodies({ mode }));
    for (const r of routes) {
      const key = `${r.method.toUpperCase()} ${r.path}`;
      (app as unknown as Record<string, (...a: unknown[]) => void>)[r.method](r.path, express.json(), (req: express.Request, res: express.Response) => {
        res.json({ reached: key, body: req.body });
      });
    }
    if (!mountFirst) app.use(refuseEncodedBodies({ mode }));
    const stack = (app as unknown as { _router: { stack: StackLayer[] } })._router.stack;
    const layers = stack.filter((l): l is Required<StackLayer> => l.route !== undefined);

    const { port, close } = await serve(app);
    const failures: string[] = [];
    let requests = 0;
    const attempt = async (label: string, run: () => Promise<Reply>, ok: (r: Reply) => boolean): Promise<void> => {
      requests += 1;
      try {
        const reply = await run();
        if (!ok(reply)) failures.push(`${label} → ${reply.status}`);
      } catch (err) {
        failures.push(`${label} → ${(err as Error).message}`);
      }
    };
    try {
      for (const layer of layers) {
        const url = concrete(layer.route.path);
        for (const method of Object.keys(layer.route.methods)) {
          if (method === 'get') {
            await attempt(`GET ${url} (bodiless, br)`, () => send(port, 'GET', url, { coding: 'br' }), (r) => r.status === 200 && Boolean(r.json?.reached));
            continue;
          }
          // app.all registers every verb; HEAD, OPTIONS, CONNECT and the rest carry no JSON body.
          if (!BODY_METHODS.has(method)) continue;
          const verb = method === '_all' ? 'POST' : method.toUpperCase();
          for (const coding of ['identity', 'gzip', 'deflate', 'br']) {
            const refuse = mode === 'all' ? coding !== 'identity' : coding === 'br';
            await attempt(
              `${verb} ${url} ${coding} (want ${refuse ? 415 : 200})`,
              () => send(port, verb, url, { coding: coding === 'identity' ? undefined : coding, body: BODY_IN[coding] }),
              (r) => (refuse
                ? r.status === 415 && JSON.stringify(r.json) === JSON.stringify(REFUSAL)
                : r.status === 200 && JSON.stringify(r.json?.body) === JSON.stringify(PLAIN)),
            );
          }
        }
      }
    } finally {
      await close();
    }
    return { layers: layers.length, requests, failures };
  }

  for (const mode of ['brotli', 'all'] as const) {
    it(`${mode}: each body-bearing route refuses what the mode refuses and parses the rest; each GET passes`, async () => {
      const result = await walk(mode, { mountFirst: true });
      expect(result.layers).toBe(routes.length);
      expect(result.requests).toBeGreaterThan(bodyRoutes.length * 4);
      expect(result.failures).toEqual([]);
    }, 60_000);
  }

  it('the walk can fail — mounted after the routes, br bodies reach them', async () => {
    const result = await walk('brotli', { mountFirst: false });
    expect(result.failures.filter((f) => f.includes(' br (want 415)')).length).toBeGreaterThanOrEqual(bodyRoutes.length);
  }, 60_000);
});

// ── 3. source rule: the mount comes first ───────────────────────────────────

const MOUNT_CALL = 'refuseEncodedBodiesFromEnv';

const mentionsApp = (node: ts.Node): boolean => {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(n) && n.text === 'app') { hit = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
};

const isAppCall = (stmt: ts.Statement, method: string): stmt is ts.ExpressionStatement & { expression: ts.CallExpression } =>
  ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)
  && ts.isPropertyAccessExpression(stmt.expression.expression)
  && ts.isIdentifier(stmt.expression.expression.expression) && stmt.expression.expression.expression.text === 'app'
  && stmt.expression.expression.name.text === method;

/**
 * Null when the first statement to use `app` after `const app = express()` (settings writes
 * aside) is `app.use(refuseEncodedBodiesFromEnv())`; otherwise what came first.
 */
function mountViolation(file: string, text: string): string | null {
  const sf = parse(file, text);
  let found: string | null = 'no `const app = express()` found';
  const visit = (node: ts.Node): void => {
    if (!(ts.isSourceFile(node) || ts.isBlock(node))) { ts.forEachChild(node, visit); return; }
    const stmts = node.statements;
    const at = stmts.findIndex((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) =>
      ts.isIdentifier(d.name) && d.name.text === 'app' && d.initializer !== undefined
      && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === 'express'));
    if (at === -1) { ts.forEachChild(node, visit); return; }
    const first = stmts.slice(at + 1).find((s) => mentionsApp(s) && !isAppCall(s, 'set'));
    if (!first) { found = 'nothing uses `app` after express()'; return; }
    const arg = isAppCall(first, 'use') && first.expression.arguments.length === 1 ? first.expression.arguments[0] : undefined;
    const mounted = arg !== undefined && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === MOUNT_CALL;
    found = mounted ? null : `first use of app is: ${first.getText(sf).split('\n')[0]}`;
  };
  visit(sf);
  return found;
}

/** Files under src/ that call express() to build an app. */
function expressAppFiles(): string[] {
  return tsFiles(SRC).filter((file) => {
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'express' && n.arguments.length === 0) { hit = true; return; }
      ts.forEachChild(n, visit);
    };
    visit(parse(file, fs.readFileSync(file, 'utf8')));
    return hit;
  }).map(rel).sort();
}

describe('source rule: refuseEncodedBodiesFromEnv is the first middleware of every app', () => {
  it('the rule can fail — it flags a late mount, an earlier router hand-off and a missing mount', () => {
    expect(mountViolation('a.ts', "const app = express(); app.set('trust proxy', 1); app.use(refuseEncodedBodiesFromEnv()); app.use(express.json());")).toBeNull();
    expect(mountViolation('a.ts', 'async function s() { const app = express(); const port = 1; app.use(refuseEncodedBodiesFromEnv()); }')).toBeNull();
    expect(mountViolation('a.ts', 'const app = express(); app.use(express.json()); app.use(refuseEncodedBodiesFromEnv());')).toMatch(/express\.json/);
    expect(mountViolation('a.ts', 'const app = express(); registerRoutes(app); app.use(refuseEncodedBodiesFromEnv());')).toMatch(/registerRoutes/);
    expect(mountViolation('a.ts', "const app = express(); app.post('/x', h);")).toMatch(/app\.post/);
    expect(mountViolation('a.ts', 'const app = express(); app.use(refuseEncodedBodies({ mode: "all" }));')).toMatch(/refuseEncodedBodies\(/);
  });

  it('every file that builds an express app is checked — the two known apps, no third', () => {
    expect(expressAppFiles()).toEqual(['facilitator.ts', 'index.ts']);
  });

  for (const file of ['index.ts', 'facilitator.ts']) {
    it(`src/${file}: the mount is the first use of app`, () => {
      expect(mountViolation(file, fs.readFileSync(path.join(SRC, file), 'utf8'))).toBeNull();
    });
  }
});

// ── 4. REFUSE_ENCODED_BODIES_MODE ───────────────────────────────────────────

function quietLog(): { log: Pick<Console, 'log' | 'warn'>; lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  return { log: { log: (m: string) => { lines.push(m); }, warn: (m: string) => { warnings.push(m); } }, lines, warnings };
}

describe('refuseEncodedBodiesFromEnv', () => {
  const cases: [string | undefined, RefuseEncodedBodiesMode, boolean][] = [
    [undefined, 'brotli', false],
    ['', 'brotli', false],
    ['brotli', 'brotli', false],
    ['all', 'all', false],
    ['ALL', 'brotli', true],
    ['none', 'brotli', true],
  ];
  for (const [value, mode, warns] of cases) {
    it(`REFUSE_ENCODED_BODIES_MODE=${value === undefined ? '(unset)' : JSON.stringify(value)} → mode=${mode}${warns ? ', with a boot warning' : ''}`, async () => {
      const q = quietLog();
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { REFUSE_ENCODED_BODIES_MODE: value };
      const handler = refuseEncodedBodiesFromEnv(env, q.log);
      expect(q.lines).toEqual([`[ingress] refuse-encoded-bodies mode=${mode}`]);
      expect(q.warnings).toHaveLength(warns ? 1 : 0);
      if (warns) expect(q.warnings[0]).toContain(JSON.stringify(value));
      // The handler behaves as the boot line says: only 'all' refuses gzip.
      const { port, close } = await serve(oneRouteApp(handler));
      try {
        const reply = await send(port, 'POST', '/echo', { coding: 'gzip', body: BODY_IN.gzip });
        expect(reply.status).toBe(mode === 'all' ? 415 : 200);
      } finally {
        await close();
      }
    });
  }
});

// ── 5. the Stripe webhook keeps its signed raw body ─────────────────────────

/** The body parser src/index.ts gives POST /webhooks/stripe, as written there. */
function stripeRouteParser(): string | undefined {
  const file = path.join(SRC, 'index.ts');
  const sf = parse(file, fs.readFileSync(file, 'utf8'));
  let parser: string | undefined;
  const visit = (node: ts.Node): void => {
    if (parser === undefined && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app'
      && node.expression.name.text === 'post' && node.arguments.length >= 3
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/webhooks/stripe') {
      parser = node.arguments[1].getText(sf);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return parser;
}

describe('the Stripe webhook route keeps its signed raw body', () => {
  // Synthetic, generated per run: Stripe's signature is an HMAC over `<t>.<raw body>`, so any
  // secret proves the bytes arrive unchanged. No Stripe key or account is involved.
  const secret = randomBytes(32).toString('hex');
  const payload = JSON.stringify({ id: 'evt_synthetic', object: 'event', type: 'customer.subscription.updated' });
  const signature = (): http.OutgoingHttpHeaders => ({ 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }) });

  /** The route head as src/index.ts mounts it, behind the refusal; verification stands in for the handler. */
  function stripeApp(mode: RefuseEncodedBodiesMode): express.Express {
    const app = express();
    app.use(refuseEncodedBodies({ mode }));
    app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
      try {
        const event = Stripe.webhooks.constructEvent(req.body as Buffer, req.headers['stripe-signature'] as string, secret);
        res.json({ verified: true, id: event.id });
      } catch {
        res.status(400).json({ verified: false });
      }
    });
    return app;
  }

  it('the harness parses the body exactly as src/index.ts does', () => {
    expect(stripeRouteParser()).toBe("express.raw({ type: 'application/json' })");
  });

  for (const mode of ['brotli', 'all'] as const) {
    it(`${mode}: a signed body verifies through the mount; the same event labelled br is refused first`, async () => {
      const { port, close } = await serve(stripeApp(mode));
      try {
        expect(await send(port, 'POST', '/webhooks/stripe', { body: Buffer.from(payload), headers: signature() }))
          .toEqual({ status: 200, json: { verified: true, id: 'evt_synthetic' } });
        expect(await send(port, 'POST', '/webhooks/stripe', { coding: 'br', body: zlib.brotliCompressSync(Buffer.from(payload)), headers: signature() }))
          .toEqual({ status: 415, json: REFUSAL });
        // The verification can fail: a changed body no longer matches its signature.
        expect(await send(port, 'POST', '/webhooks/stripe', { body: Buffer.from(payload.replace('updated', 'deleted')), headers: signature() }))
          .toEqual({ status: 400, json: { verified: false } });
      } finally {
        await close();
      }
    });
  }
});
