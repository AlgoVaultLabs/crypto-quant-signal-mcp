/**
 * The Cursor-manifest DERIVATION — one projection of root `plugin.json`, shared by the gate and
 * the unit suite.
 *
 * WHY IT IS A LEAF MODULE. `scripts/check-plugin-manifests.mjs` calls `main()` at module scope
 * (the estate's gate convention), so importing it would run the live gate and exit the process.
 * The derivation is the part that must be asserted OFFLINE — `tests/unit/plugin-manifest-lockstep
 * .test.ts` runs in CI and in the pre-push gate, where there is no network — and an invariant that
 * only a networked gate can check is one a version desync can land past. So the projection lives
 * here, with no side effects, and both consumers project from it. Same reasoning as
 * `scripts/lib/baked-venue-count.mjs` and `scripts/lib/mcp-tools-list.mjs`.
 *
 * Consumers:
 *   - scripts/check-plugin-manifests.mjs        (PLUGIN_MANIFESTS_VERDICT, + schema and live legs)
 *   - tests/unit/plugin-manifest-lockstep.test.ts (the offline invariants)
 */

/**
 * The logo asset, declared HERE and nowhere else.
 *
 * It cannot live in root `plugin.json` (closed schema, see above), so the derived manifest needs
 * a source for it. A relative path is what Cursor prefers — parse.ts:596 rewrites it to
 * `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>` — which means a path naming a
 * file that is not committed yields a BROKEN IMAGE on the public listing and nothing anywhere
 * says so. That is why `logoExists` is a FAIL condition and not a comment.
 */
export const LOGO_PATH = 'logo.png';


// ── pure derivation ───────────────────────────────────────────────────────────────────────────

/**
 * Project root `plugin.json` onto the Cursor-proprietary manifest.
 *
 * EVERY field here is a projection — nothing is authored. The key order is FIXED so the
 * serialization is byte-stable and `--sync` is idempotent; an object-key-order-dependent
 * generator would rewrite the file on alternate runs and make the drift check unreadable.
 *
 * `$schema` is deliberately ABSENT: the Cursor format has no published schema, so emitting a
 * `$schema` pointer would name a document that does not exist. `displayName` is absent for the
 * same class of reason — it would be a NEW string with no source, i.e. a second author.
 */
export function deriveCursorManifest(plugin, logoPath = LOGO_PATH) {
  return {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    homepage: plugin.homepage,
    repository: plugin.repository,
    license: plugin.license,
    keywords: plugin.keywords,
    logo: logoPath,
  };
}

/**
 * The projected key list, in emission order — declared ONCE so the generator, the gate's
 * assertion and the unit suite cannot disagree about what a derived manifest contains.
 */
export const CURSOR_MANIFEST_KEYS = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'logo'];

/** The exact bytes `--sync` writes. Two spaces + trailing newline, matching every manifest here. */
export function serializeCursorManifest(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Field-by-field drift report between the derived projection and what is on disk. */
export function derivationDrift(plugin, onDisk, logoPath = LOGO_PATH) {
  const want = deriveCursorManifest(plugin, logoPath);
  const out = [];
  for (const k of Object.keys(want)) {
    const a = JSON.stringify(want[k]);
    const b = JSON.stringify(onDisk?.[k]);
    if (a !== b) out.push(`${k}: derived=${a} on-disk=${b}`);
  }
  for (const k of Object.keys(onDisk ?? {})) {
    if (!(k in want)) out.push(`${k}: present on disk, not produced by the derivation`);
  }
  return out;
}
