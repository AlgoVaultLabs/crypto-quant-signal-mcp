/**
 * LANDING-DUAL-RENDER-PARITY-W1 — dual-render copy-drift CI canary (node:test).
 *
 * Makes desktop/mobile landing-copy drift structurally impossible to SHIP: any divergence of
 * a `data-av-copy` node from the SoT (src/lib/landing-content.ts), a one-sided twin, or a bare
 * `· vN.N` version literal in a `lp-*` dual-render twin fails the pre-push gate + CI.
 *
 * Pure file reads (dist-free) — value-parity is checked against the SoT SOURCE, so the canary
 * runs even before `npm run build`. Pairs with `node scripts/inject-landing-copy.mjs --check`
 * (the build-time injector that re-syncs every marked node to the compiled SoT).
 *
 * Run: node --test tests/unit/landing-dual-render-parity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const MARKER = 'data-av-copy';

// A `lp-<name>-desktop` with no `-mobile` sibling is a documented SINGLE-VARIANT block (architect
// Q2 — the 16 integration pages), NOT a dual-render twin. Any OTHER unpaired `-desktop` is a
// dropped twin and MUST fail (we do not blanket-skip unpaired desktops).
const SINGLE_VARIANT_ALLOWLIST = [/^lp-integrations-/];

async function landingFiles() {
  const out = [];
  async function walk(rel) {
    for (const e of await readdir(path.join(ROOT, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) await walk(r);
      else if (e.name.endsWith('.html')) out.push(r);
    }
  }
  await walk('landing');
  return out.sort();
}

/**
 * Parse the SoT SOURCE (dist-free) → { 'hero.x': { desktop, mobile } | { derived: true } }.
 *
 * TWO entry shapes, and the distinction is load-bearing:
 *
 *   - A single-quoted STRING literal is static copy. Its bytes are readable straight from the
 *     source, so this file can compare a rendered node against it with no build — which is the
 *     whole point of the "dist-free" in test (a)'s name.
 *
 *   - A TEMPLATE literal is DERIVED copy: PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (CH7) made
 *     `hero.free_tier_note` interpolate the free allowances from `plans.ts`, because a hand-typed
 *     pricing figure in a copy registry is exactly the drift this wave exists to close. A regex
 *     cannot evaluate `${freeCallsLabel()}`, and faking it here would mean re-deriving the ladder
 *     in a third place.
 *
 * So a derived entry keeps every STRUCTURAL guarantee below (the key is known, the variant is
 * valid, both twins are marked) and delegates the BYTE comparison to
 * `scripts/inject-landing-copy.mjs --check`, which loads the COMPILED module and can actually
 * evaluate it. That check is wired into CI and the pre-push gate, so the assertion is relocated,
 * not dropped — and `derivedKeys` is asserted non-empty below so this branch cannot quietly
 * become a way to exempt every key.
 */
function parseSoT(src) {
  const map = {};
  const staticRe = /'(hero\.[a-z_]+)':\s*\{\s*desktop:\s*'((?:[^'\\]|\\.)*)',\s*mobile:\s*'((?:[^'\\]|\\.)*)',?\s*\}/g;
  let m;
  while ((m = staticRe.exec(src))) map[m[1]] = { desktop: m[2], mobile: m[3] };
  const derivedRe = /'(hero\.[a-z_]+)':\s*\{\s*desktop:\s*`(?:[^`\\]|\\.)*`,\s*mobile:\s*`(?:[^`\\]|\\.)*`,?\s*\}/g;
  while ((m = derivedRe.exec(src))) if (!map[m[1]]) map[m[1]] = { derived: true };
  return map;
}

/** Every marked leaf node in a file → [{ key, variant, inner }]. */
function markedNodes(html) {
  const re = new RegExp(`<(\\w+)\\b[^>]*\\b${MARKER}="([^"]+)"[^>]*>([\\s\\S]*?)</\\1>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const marker = m[2];
    const dot = marker.lastIndexOf('.');
    out.push({ key: marker.slice(0, dot), variant: marker.slice(dot + 1), inner: m[3] });
  }
  return out;
}

test('(a) every data-av-copy node matches the SoT value (dist-free parity)', async () => {
  const sot = parseSoT(await read('src/lib/landing-content.ts'));
  assert.ok(Object.keys(sot).length >= 5, `SoT parsed ≥5 hero keys (got ${Object.keys(sot).length})`);
  // Vacuity guards, both directions. If the derived branch ever swallowed every key this test
  // would pass having compared nothing, and if the static parser stopped matching it would pass
  // having found nothing to compare — the two failure modes a `continue` invites.
  const staticKeys = Object.keys(sot).filter((k) => !sot[k].derived);
  const derivedKeys = Object.keys(sot).filter((k) => sot[k].derived);
  assert.ok(staticKeys.length >= 4, `≥4 STATIC hero keys still byte-compared here (got ${staticKeys.length})`);
  assert.deepStrictEqual(derivedKeys, ['hero.free_tier_note'],
    'exactly one derived key is expected; a new one needs a deliberate decision, not a silent exemption');
  for (const f of await landingFiles()) {
    for (const n of markedNodes(await read(f))) {
      const entry = sot[n.key];
      assert.ok(entry, `${f}: marker "${n.key}" has no SoT entry`);
      assert.ok(n.variant === 'desktop' || n.variant === 'mobile', `${f}: bad variant "${n.variant}" on ${n.key}`);
      if (entry.derived) continue; // byte check owned by inject-landing-copy --check (see parseSoT)
      assert.strictEqual(n.inner, entry[n.variant],
        `${f}: ${n.key}.${n.variant} inner copy drifted from the SoT (run \`node scripts/inject-landing-copy.mjs\`)`);
    }
  }
});

test('(b) marked fields are two-sided: every KEY.desktop has KEY.mobile and vice-versa', async () => {
  for (const f of await landingFiles()) {
    const nodes = markedNodes(await read(f));
    if (!nodes.length) continue;
    const byKey = {};
    for (const n of nodes) (byKey[n.key] ||= new Set()).add(n.variant);
    for (const [key, variants] of Object.entries(byKey)) {
      assert.ok(variants.has('desktop') && variants.has('mobile'),
        `${f}: marked field "${key}" is one-sided (${[...variants].join(',')}) — a dual-render twin must mark BOTH viewports`);
    }
  }
});

test('(c) hero eyebrow: parity-guarded words around a LIVE exchange_count count span', async () => {
  const html = await read('landing/index.html');
  // LANDING-EYEBROW-LIVEBIND-W1: the eyebrow is prefix-span + live count span + suffix-span.
  for (const v of ['desktop', 'mobile']) {
    assert.ok(html.includes(`${MARKER}="hero.eyebrow_prefix.${v}"`), `${v} eyebrow prefix marker present`);
    assert.ok(html.includes(`${MARKER}="hero.eyebrow_suffix.${v}"`), `${v} eyebrow suffix marker present`);
  }
  // the venue COUNT live-binds to exchange_count (auto-tracks the 6th adapter) as a SIBLING span.
  assert.match(html, /<span data-tr-field="exchange_count">\d+<\/span>/, 'eyebrow count live-binds to exchange_count');
  // firewall BY STRUCTURE: no node carries BOTH data-av-copy AND data-tr-field.
  assert.doesNotMatch(html, /<[^>]*\bdata-av-copy="[^"]*"[^>]*\bdata-tr-field=/, 'no data-av-copy node also carries data-tr-field');
  assert.doesNotMatch(html, /<[^>]*\bdata-tr-field="[^"]*"[^>]*\bdata-av-copy=/, 'no data-tr-field node also carries data-av-copy');
});

test('(d) no bare "· vN.N" version literal inside any lp-* dual-render twin (site-wide)', async () => {
  const TWIN_RE = /<div class="lp-[a-z]+-(?:desktop|mobile)"[\s\S]*?(?=<div class="lp-[a-z]+-(?:desktop|mobile)"|$)/g;
  const BARE_VERSION = /·\s*v\d+\.\d+/;
  for (const f of await landingFiles()) {
    const html = await read(f);
    for (const block of html.match(TWIN_RE) || []) {
      assert.ok(!BARE_VERSION.test(block),
        `${f}: a lp-* dual-render twin contains a bare "· vN.N" version literal — a version belongs in a data-tr-field bind, not static copy`);
    }
  }
});

test('(e) unpaired lp-*-desktop wrappers are only the allowlisted single-variant type', async () => {
  for (const f of await landingFiles()) {
    const present = new Set();
    for (const m of (await read(f)).matchAll(/class="lp-([a-z]+)-(desktop|mobile)"/g)) {
      present.add(`${m[1]}:${m[2]}`);
    }
    const bases = new Set([...present].map((s) => s.split(':')[0]));
    for (const base of bases) {
      const hasD = present.has(`${base}:desktop`);
      const hasM = present.has(`${base}:mobile`);
      if (hasD && !hasM) {
        const cls = `lp-${base}-desktop`;
        assert.ok(SINGLE_VARIANT_ALLOWLIST.some((re) => re.test(cls)),
          `${f}: ${cls} has no -mobile sibling and is not in SINGLE_VARIANT_ALLOWLIST — a dropped dual-render twin?`);
      }
    }
  }
});
