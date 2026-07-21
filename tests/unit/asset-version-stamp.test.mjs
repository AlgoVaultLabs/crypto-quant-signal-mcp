// OPS-LANDING-ASSET-CACHE-BUST-W1 — asset-version stamper canary.
//
// Guards the rule that keeps a deployed landing-JS fix VISIBLE: every first-party
// `/js/*.js` ref carries its file's current content hash.
//
// Background: Caddy serves landing assets max-age=60, but Cloudflare rewrites that to
// max-age=14400 (4h) for responses it caches. A correct deploy therefore stayed invisible
// to returning visitors for up to 4h — OPS-MERKLE-BATCH-IDENTITY-W1 shipped a fixed
// track-record-proxy.js and /verify still rendered "#100" against an on-chain "#102",
// because the browser kept running its cached copy AND the proxy's refresh interval
// re-wrote the hydrated span back to the stale value.
//
// The last test is the one that actually bites in CI: it asserts the COMMITTED repo is
// in sync, so "changed the JS, forgot to re-stamp" is a build failure rather than a
// silent 4h regression.
import { test } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stampHtml,
  assetHashes,
  htmlFiles,
  hashFile,
  ASSET_REF_RE,
  JS_DIR,
} from '../../scripts/build_asset_versions.mjs';
import * as fs from 'node:fs';

const HASHES = { 'track-record-proxy.js': 'abc12345' };

test('stamps a bare first-party ref', () => {
  const { out, changed } = stampHtml('<script src="/js/track-record-proxy.js" defer></script>', HASHES);
  assert.equal(changed, 1);
  assert.match(out, /src="\/js\/track-record-proxy\.js\?v=abc12345"/);
});

test('replaces a STALE version rather than appending a second one', () => {
  const { out, changed } = stampHtml('<script src="/js/track-record-proxy.js?v=deadbeef"></script>', HASHES);
  assert.equal(changed, 1);
  assert.match(out, /\?v=abc12345"/);
  assert.ok(!out.includes('deadbeef'), 'stale hash must be gone');
  assert.equal((out.match(/\?v=/g) || []).length, 1, 'exactly one version token');
});

test('is idempotent — an already-correct ref is left byte-identical', () => {
  const src = '<script src="/js/track-record-proxy.js?v=abc12345"></script>';
  const { out, changed } = stampHtml(src, HASHES);
  assert.equal(changed, 0);
  assert.equal(out, src);
});

test('leaves assets we do not own untouched (proxied /js/insights.js)', () => {
  // insights.js is a Caddy reverse-proxy to Plausible CE, not a file in landing/js/,
  // and it lives inside build_analytics.mjs's ANALYTICS marker region — stamping it
  // would fight that injector's --check.
  const src = '<script src="/js/insights.js" defer></script>';
  const { out, changed } = stampHtml(src, HASHES);
  assert.equal(changed, 0);
  assert.equal(out, src);
});

test('the hash changes when the file bytes change', () => {
  const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp-asset-hash-probe.js');
  fs.writeFileSync(tmp, 'a');
  const h1 = hashFile(tmp);
  fs.writeFileSync(tmp, 'b');
  const h2 = hashFile(tmp);
  fs.unlinkSync(tmp);
  assert.notEqual(h1, h2, 'content hash must move with content');
  assert.match(h1, /^[a-f0-9]{8}$/);
});

test('the regex only matches src="" attributes, not arbitrary text', () => {
  const re = new RegExp(ASSET_REF_RE.source, 'g');
  assert.ok(!re.test('see /js/track-record-proxy.js for details'), 'prose must not match');
});

test('COMMITTED repo is in sync — every first-party ref carries its current hash', () => {
  const hashes = assetHashes();
  assert.ok(Object.keys(hashes).length > 0, `expected first-party assets under ${JS_DIR}`);
  const drifted = [];
  for (const file of htmlFiles()) {
    const src = fs.readFileSync(file, 'utf-8');
    const { changed } = stampHtml(src, hashes);
    if (changed) drifted.push(path.basename(file));
  }
  assert.deepEqual(
    drifted,
    [],
    `Landing JS changed but its ?v= did not — returning visitors would run the OLD script for up to 4h. ` +
      `Run \`node scripts/build_asset_versions.mjs\` and commit. Drifted: ${drifted.join(', ')}`,
  );
});
