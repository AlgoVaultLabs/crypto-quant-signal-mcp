#!/usr/bin/env node
/**
 * Local preview server for landing/ with /api/* proxied to live algovault.com.
 * Used by .claude/launch.json (landing-preview config) for in-IDE preview
 * verification of landing-page changes (e.g. LANDING-LIVE-CALL-TICKER-W1).
 *
 * Zero deps — Node built-ins only. NOT for production. NOT committed to deploy.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 5500);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANDING_DIR = path.join(REPO_ROOT, 'landing');
const PROXY_HOST = 'api.algovault.com';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function proxyApi(req, res) {
  const opts = {
    host: PROXY_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: PROXY_HOST },
  };
  const upstream = https.request(opts, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream proxy failed', detail: err.message }));
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const safe = decodeURIComponent(req.url.split('?')[0]);
  let rel = safe === '/' ? '/index.html' : safe;
  // Caddy try_files {path} {path}.html semantics for /faq, /glossary, /verify, etc.
  const candidates = [rel, rel + '.html', path.join(rel, 'index.html')];
  for (const c of candidates) {
    const abs = path.join(LANDING_DIR, c);
    if (abs.startsWith(LANDING_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const mime = MIME[path.extname(abs)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
      fs.createReadStream(abs).pipe(res);
      return;
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found: ' + safe);
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/')) {
    proxyApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[preview-landing] http://localhost:${PORT}/  (api/* → https://${PROXY_HOST}/api/*)`);
});
