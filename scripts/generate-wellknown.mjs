#!/usr/bin/env node
/**
 * GEO-WELLKNOWN-DISCOVERY-W1 — render the /.well-known/ agent-discovery documents.
 *
 * GEO-AGENT-DISCOVERY-W2 removed `Disallow: /.well-known/` on the argument that it is where
 * agent-discovery documents live. This script is what pays that argument off.
 *
 *   node scripts/generate-wellknown.mjs --out <dir>   # render both documents into <dir>
 *   node scripts/generate-wellknown.mjs --check       # verify the COMMITTED copies' shape
 *   node scripts/generate-wellknown.mjs --self-test   # hermetic assertions, incl. bypassed seams
 *
 * VERDICT TOKEN: exactly one terminal `WELLKNOWN_VERDICT=PASS|FAIL|INDETERMINATE` line.
 * EXIT CODES: 0 = PASS, 1 = FAIL, 3 = INDETERMINATE.
 * `3` is the token-law default for a NEW gate; this script deploys no other code for
 * "could not verify", so there is nothing to stay consistent with and nothing to align.
 *
 * WHY --out RATHER THAN REWRITING THE REPO FILE. The deploy runs this on the host inside
 * /opt/crypto-quant-signal-mcp. `ops/deploy/checkout-parity.conf`'s dirty-tree allowlist for this
 * service is PATH-SCOPED — `README.md` and `landing/*.html` only — so rewriting
 * `landing/.well-known/security.txt` in the checkout would trip `ops/cron/checkout-parity.sh`'s
 * daily clean-tree assertion and manufacture a page. Rendering straight to the serve path
 * needs no new exemption, keeps ONE writer for the served copy, and leaves the committed file
 * as the artifact the unit tests read.
 *
 * CONSEQUENCE, STATED SO IT IS NOT READ AS DRIFT: the committed `Expires` and the served
 * `Expires` legitimately differ. Committed = whenever a wave last ran this script.
 * Served = last deploy + SECURITY_TXT_EXPIRY_DAYS. Freshness is asserted ONLY against the
 * SERVED copy, by `scripts/check-robots-ai-allowlist.mjs`. Asserting it at build time would
 * key a calendar-triggered failure to commit date in a pre-push hook shared by ~74 checkouts —
 * an outage nobody caused, and the same defect shape as measuring freshness on a rendered
 * artifact instead of its producer.
 *
 * NO TypeScript LOADER: this runs from the deploy checkout, whose `dist/` is a stale April
 * artifact with no `lib/` modules. So the SoT constants are read from the .ts file as TEXT,
 * exactly as `check-robots-ai-allowlist.mjs` reads AI_CRAWLER_ALLOWLIST. That gate imports the
 * readers below rather than re-implementing them — one parser, not two.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const CONSTANTS_SOURCE = join(REPO_ROOT, 'src', 'lib', 'ai-crawler-allowlist.ts');
export const WELL_KNOWN_DIR = join(REPO_ROOT, 'landing', '.well-known');
export const VERDICT_EXIT = Object.freeze({ PASS: 0, FAIL: 1, INDETERMINATE: 3 });

/** Filenames rendered by this script. `api-catalog` is EXTENSIONLESS per RFC 9727 §3. */
export const DOCUMENTS = Object.freeze(['security.txt', 'api-catalog']);

// ---------------------------------------------------------------------------
// Readers — parse the TS SoT as text. PURE.
// ---------------------------------------------------------------------------

/**
 * Read API_CATALOG_ENDPOINTS out of the .ts source.
 *
 * Returns [] when the literal cannot be located — every caller turns an empty read into
 * INDETERMINATE, never a silent pass. The corpus here is one WE author, so empty is vacuity.
 */
export function readEndpointsFromSource(tsSource) {
  const block = tsSource.match(
    /export const API_CATALOG_ENDPOINTS:[^=]*=\s*\[([\s\S]*?)\n\];/,
  );
  if (!block) return [];
  const out = [];
  // ONE ENTRY PER LINE — documented as load-bearing in the SoT's own docblock.
  for (const line of block[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    const href = trimmed.match(/href:\s*'([^']+)'/);
    const rel = trimmed.match(/rel:\s*'([^']+)'/);
    const probe = trimmed.match(/probe:\s*'([^']+)'/);
    const type = trimmed.match(/type:\s*'([^']+)'/);
    if (!href || !rel || !probe) continue;
    const entry = { href: href[1], rel: rel[1], probe: probe[1] };
    if (type) entry.type = type[1];
    out.push(entry);
  }
  return out;
}

/** Read a single-quoted `export const <NAME> = '...'` string literal. '' when absent. */
export function readStringConstFromSource(tsSource, name) {
  const m = tsSource.match(
    new RegExp(`export const ${name}(?::[^=]*)?\\s*=\\s*\\n?\\s*'([^']*)'`),
  );
  return m ? m[1] : '';
}

/** Read `export const <NAME> = <number>`. null when absent — callers must not default it. */
export function readNumberConstFromSource(tsSource, name) {
  const m = tsSource.match(new RegExp(`export const ${name}(?::[^=]*)?\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Builders — PURE. Every test drives these directly.
// ---------------------------------------------------------------------------

/** RFC 9116 §2.5 wants an ISO 8601 instant. Seconds precision, explicit Z, no milliseconds. */
export function formatExpires(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** `now` + `days`, as an RFC 9116 Expires value. PURE — `now` is always injected. */
export function computeExpires(now, days) {
  return formatExpires(new Date(now.getTime() + days * 24 * 60 * 60 * 1000));
}

/**
 * RFC 9116 security.txt.
 *
 * Contact is the /contact URL, NOT a mailto:. RFC 9116 §2.4 permits either; the URL routes into
 * the Turnstile gate and the `contact_leads` quarantine lane that already exists, which a bare
 * scrapeable address does not. No `Encryption:` — we publish no PGP key, and pointing at one
 * that does not exist is fabrication.
 *
 * `Canonical` names the apex URI ONLY. RFC 9116 §3: a security.txt "MUST only apply to the
 * domain or IP address in the URI used to retrieve it, not to any of its subdomains or parent
 * domains." So this document does not cover api.algovault.com and must not pretend to.
 */
export function buildSecurityTxt(expires) {
  return [
    '# AlgoVault Labs — security contact',
    '# https://www.rfc-editor.org/rfc/rfc9116',
    '#',
    '# TEMPLATE. scripts/generate-wellknown.mjs OWNS the Expires value below and regenerates it',
    '# on every deploy straight into /var/www/algovault/.well-known/. Hand-editing Expires in',
    '# this file changes NOTHING that is served — it only moves the committed copy out of step',
    '# with the generator. To refresh it here, run the generator; never retype the date.',
    '',
    'Contact: https://algovault.com/contact',
    `Expires: ${expires}`,
    'Preferred-Languages: en',
    'Canonical: https://algovault.com/.well-known/security.txt',
    '',
  ].join('\n');
}

/**
 * RFC 9727 api-catalog, as an RFC 9264 linkset.
 *
 * §4.1 — MUST include hyperlinks to API endpoints; §4.2 — MUST be application/linkset+json.
 * Object members are link RELATION TYPES, so the SoT's `probe` field is deliberately NOT
 * emitted: it is our gate's config, not a relation, and a conformance document carries no
 * private config. Anchor = the catalog's own canonical URI, per RFC 9727 Appendix A.2.
 */
export function buildApiCatalog(endpoints, anchor) {
  const context = { anchor };
  for (const e of endpoints) {
    const link = e.type ? { href: e.href, type: e.type } : { href: e.href };
    (context[e.rel] ??= []).push(link);
  }
  return `${JSON.stringify({ linkset: [context] }, null, 2)}\n`;
}

/** Both documents, keyed by filename. PURE — `now` injected, never read here. */
export function buildAll(tsSource, now) {
  const endpoints = readEndpointsFromSource(tsSource);
  const anchor = readStringConstFromSource(tsSource, 'API_CATALOG_URL');
  const days = readNumberConstFromSource(tsSource, 'SECURITY_TXT_EXPIRY_DAYS');
  if (endpoints.length === 0) throw new Error('API_CATALOG_ENDPOINTS could not be read from source');
  if (!anchor) throw new Error('API_CATALOG_URL could not be read from source');
  if (days === null) throw new Error('SECURITY_TXT_EXPIRY_DAYS could not be read from source');
  return {
    'security.txt': buildSecurityTxt(computeExpires(now, days)),
    'api-catalog': buildApiCatalog(endpoints, anchor),
  };
}

// ---------------------------------------------------------------------------
// Shape checks — what the COMMITTED copies must satisfy. PURE.
// ---------------------------------------------------------------------------

/**
 * security.txt SHAPE only — never freshness. See the header: freshness against a committed
 * file keys a calendar bomb to commit date. `Expires` must be PRESENT and PARSEABLE here;
 * whether it is far enough out is the live gate's question, about the served copy.
 */
export function checkSecurityTxtShape(body) {
  const reasons = [];
  if (!/^Contact:\s*https:\/\/algovault\.com\/contact$/m.test(body)) {
    reasons.push('security.txt: missing `Contact: https://algovault.com/contact`');
  }
  const expires = body.match(/^Expires:\s*(\S+)$/m);
  if (!expires) reasons.push('security.txt: missing `Expires:`');
  else if (Number.isNaN(Date.parse(expires[1]))) {
    reasons.push(`security.txt: Expires is not a parseable date (${expires[1]})`);
  }
  if (/mailto:/i.test(body)) reasons.push('security.txt: contains a mailto: address');
  if (/^Encryption:/mi.test(body)) reasons.push('security.txt: contains an Encryption: field');
  if (!/TEMPLATE\./.test(body)) {
    reasons.push('security.txt: missing the TEMPLATE header comment naming the generator');
  }
  return { ok: reasons.length === 0, reasons };
}

/** api-catalog SHAPE: parseable linkset, one anchored context, non-empty item[], no service-desc. */
export function checkApiCatalogShape(body) {
  const reasons = [];
  let doc;
  try {
    doc = JSON.parse(body);
  } catch (err) {
    return { ok: false, reasons: [`api-catalog: body is not valid JSON (${err.message})`] };
  }
  const ctx = Array.isArray(doc?.linkset) ? doc.linkset[0] : undefined;
  if (!ctx) reasons.push('api-catalog: linkset[0] is absent');
  else {
    if (!ctx.anchor) reasons.push('api-catalog: linkset[0].anchor is absent');
    if (!Array.isArray(ctx.item) || ctx.item.length === 0) {
      reasons.push('api-catalog: linkset[0].item is absent or empty');
    }
    if (ctx['service-desc']) {
      reasons.push('api-catalog: carries service-desc, but no OpenAPI document exists');
    }
    for (const link of ctx.item ?? []) {
      if (!link?.href) reasons.push('api-catalog: an item entry has no href');
      if (link && 'probe' in link) reasons.push('api-catalog: an item leaked the gate-only `probe` key');
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function emit(verdict, lines) {
  for (const l of lines) console.log(l);
  console.log(`WELLKNOWN_VERDICT=${verdict}`);
  return VERDICT_EXIT[verdict];
}

function renderTo(outDir, now) {
  const src = readFileSync(CONSTANTS_SOURCE, 'utf8');
  const docs = buildAll(src, now);
  mkdirSync(outDir, { recursive: true });
  const lines = [];
  for (const name of DOCUMENTS) {
    const path = join(outDir, name);
    writeFileSync(path, docs[name], 'utf8');
    lines.push(`rendered: ${path} (${Buffer.byteLength(docs[name])} bytes)`);
  }
  return emit('PASS', lines);
}

function checkCommitted() {
  const lines = [];
  const reasons = [];
  for (const name of DOCUMENTS) {
    const path = join(WELL_KNOWN_DIR, name);
    let body;
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      // A committed file we were told to verify and could not READ is INDETERMINATE, not FAIL:
      // we cannot distinguish "absent" from "unreadable" here, and only one of those is a defect.
      return emit('INDETERMINATE', [...lines, `${name}: UNREADABLE at ${path}`]);
    }
    const r = name === 'security.txt' ? checkSecurityTxtShape(body) : checkApiCatalogShape(body);
    lines.push(`${name}: ${r.ok ? 'shape OK' : 'shape FAIL'} (${Buffer.byteLength(body)} bytes)`);
    reasons.push(...r.reasons);
  }
  return emit(reasons.length === 0 ? 'PASS' : 'FAIL', [...lines, ...reasons.map((r) => `  ${r}`)]);
}

function selfTest() {
  const results = [];
  const check = (name, fn) => {
    try {
      const ok = fn();
      results.push([name, ok === true]);
    } catch (err) {
      // An assertion that RAISES is not an assertion — record it as a FAIL, never let it abort.
      results.push([`${name} (threw: ${err.message})`, false]);
    }
  };
  const FIXED = new Date('2026-01-01T00:00:00Z');
  const src = readFileSync(CONSTANTS_SOURCE, 'utf8');

  check('computeExpires is pure and 180d-correct', () =>
    computeExpires(FIXED, 180) === '2026-06-30T00:00:00Z');
  check('formatExpires emits seconds precision + Z, no milliseconds', () =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(formatExpires(FIXED)));
  check('readEndpointsFromSource finds the real literal', () =>
    readEndpointsFromSource(src).length >= 4);
  check('readEndpointsFromSource returns [] on an absent literal (vacuity, not a default)', () =>
    readEndpointsFromSource('const x = 1;').length === 0);
  check('exactly one endpoint uses the mcp-initialize probe', () =>
    readEndpointsFromSource(src).filter((e) => e.probe === 'mcp-initialize').length === 1);
  check('the mcp-initialize probe is the /mcp endpoint', () =>
    readEndpointsFromSource(src).find((e) => e.probe === 'mcp-initialize').href.endsWith('/mcp'));
  check('readStringConstFromSource reads API_CATALOG_URL', () =>
    readStringConstFromSource(src, 'API_CATALOG_URL').startsWith('https://algovault.com/'));
  check('readNumberConstFromSource reads SECURITY_TXT_EXPIRY_DAYS', () =>
    readNumberConstFromSource(src, 'SECURITY_TXT_EXPIRY_DAYS') === 180);
  check('buildApiCatalog never emits the gate-only probe key', () =>
    !JSON.stringify(buildApiCatalog(readEndpointsFromSource(src), 'x')).includes('probe'));
  check('buildApiCatalog groups by relation', () => {
    const doc = JSON.parse(buildApiCatalog(readEndpointsFromSource(src), 'anchor://x'));
    return doc.linkset[0].anchor === 'anchor://x'
      && doc.linkset[0].item.length >= 3
      && doc.linkset[0]['service-doc'].length === 1;
  });
  check('buildSecurityTxt carries no mailto and no Encryption', () => {
    const b = buildSecurityTxt('2026-06-30T00:00:00Z');
    return !/mailto:/i.test(b) && !/^Encryption:/mi.test(b);
  });
  check('buildSecurityTxt output passes its own shape check', () =>
    checkSecurityTxtShape(buildSecurityTxt('2026-06-30T00:00:00Z')).ok === true);
  check('shape check REJECTS a mailto Contact', () =>
    checkSecurityTxtShape('Contact: mailto:a@b.c\nExpires: 2026-06-30T00:00:00Z\nTEMPLATE.').ok === false);
  check('shape check REJECTS a missing Expires', () =>
    checkSecurityTxtShape('Contact: https://algovault.com/contact\nTEMPLATE.').ok === false);
  check('shape check REJECTS an unparseable Expires', () =>
    checkSecurityTxtShape('Contact: https://algovault.com/contact\nExpires: soon\nTEMPLATE.').ok === false);
  check('catalog shape REJECTS an empty item array', () =>
    checkApiCatalogShape(JSON.stringify({ linkset: [{ anchor: 'x', item: [] }] })).ok === false);
  check('catalog shape REJECTS a service-desc', () =>
    checkApiCatalogShape(JSON.stringify({
      linkset: [{ anchor: 'x', item: [{ href: 'y' }], 'service-desc': [{ href: 'z' }] }],
    })).ok === false);
  check('catalog shape REJECTS non-JSON', () =>
    checkApiCatalogShape('not json').ok === false);
  // BYPASSED-SEAM ASSERTIONS. --out and --check are the only code paths a hermetic run never
  // executes, so the artifacts they touch are asserted here directly rather than left dark.
  check('DOCUMENTS names the extensionless catalog file', () =>
    DOCUMENTS.includes('api-catalog') && DOCUMENTS.includes('security.txt'));
  check('the COMMITTED copies exist and pass their shape checks', () => {
    for (const name of DOCUMENTS) {
      const body = readFileSync(join(WELL_KNOWN_DIR, name), 'utf8');
      const r = name === 'security.txt' ? checkSecurityTxtShape(body) : checkApiCatalogShape(body);
      if (!r.ok) return false;
    }
    return true;
  });
  check('token↔exit mapping is 0/1/3', () =>
    VERDICT_EXIT.PASS === 0 && VERDICT_EXIT.FAIL === 1 && VERDICT_EXIT.INDETERMINATE === 3);

  const failed = results.filter(([, ok]) => !ok);
  for (const [name, ok] of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  // VACUITY GUARD: in --self-test WE build the corpus, so zero assertions means the test built
  // nothing. REFUSE — that is a defect in the test, never a pass.
  if (results.length === 0) return emit('INDETERMINATE', ['SELF-TEST: built ZERO assertions']);
  console.log(`SELF-TEST: ${results.length - failed.length}/${results.length} passed`);
  return emit(failed.length === 0 ? 'PASS' : 'FAIL', []);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  if (argv.includes('--check')) return checkCommitted();
  const i = argv.indexOf('--out');
  if (i !== -1 && argv[i + 1]) return renderTo(argv[i + 1], new Date());
  console.error('usage: generate-wellknown.mjs --out <dir> | --check | --self-test');
  return emit('INDETERMINATE', ['no mode selected']);
}

if (process.argv[1] && process.argv[1].endsWith('generate-wellknown.mjs')) {
  process.exit(main());
}
