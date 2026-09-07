/**
 * CONVERSION-SURFACES-W2 CH3 — the ONE expansion of a snapshot-manifest `apply_to_files` entry.
 *
 * WHY IT EXISTS. The conversion band puts a `data-tr-field="timeframe_count"` span on every
 * content page. `check-claim-coverage.mjs` COV-3 then refuses the result — correctly — because
 * the field would read LIVE on the 3 hand-listed pages and FROZEN on the other 51, which is
 * precisely how one field name comes to carry two meanings. The gate offers two remedies: widen
 * the manifest, or file an orphan row accepting the freeze.
 *
 * Widening it by hand-listing 54 paths would re-create the staleness generator this estate has
 * already retired twice — `ops/footer-coverage-config.json` is glob-derived today because the
 * footer's hand-maintained TARGETS array went stale TWICE. So the manifest takes a glob, and this
 * module is the single place that resolves one.
 *
 * TWO CONSUMERS, ONE DERIVATION: `scripts/snapshot-landing-data.mjs` (which WRITES the values)
 * and `scripts/check-claim-coverage.mjs` (which AUDITS that every claim/file pairing matches
 * something). Two implementations of "which files does this claim apply to" would drift, and the
 * bug would then live in whichever copy nobody is watching.
 *
 * THE EXPANSION IS FILTERED BY THE CLAIM'S OWN `find_pattern`. That is not an optimisation: an
 * unfiltered glob would manufacture dozens of zero-match (claim, file) pairings, and COV-2 counts
 * a new zero-match as a silent no-op and a defect of its own. Filtering makes the target set
 * self-maintaining in both directions — a new banded page joins, a page that loses its span drops.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Escape a literal path segment for use inside a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Resolve one `apply_to_files` entry to concrete repo-relative paths.
 *
 * A plain path is returned as-is (never stat'ed — a missing file is a STALE-ROW defect the
 * coverage gate reports, and silently dropping it here would hide that).
 * A `*` entry is expanded: `*` matches within one segment, `**\/` spans directories.
 *
 * @param {string} entry            repo-relative path or glob
 * @param {string} findPattern      the claim's find_pattern; a file must match it to be included
 * @param {string} repoRoot         absolute repo root
 * @returns {string[]} sorted repo-relative paths
 */
export function expandApplyTo(entry, findPattern, repoRoot) {
  if (!entry.includes('*')) return [entry];

  const deep = entry.includes('**/');
  const rx = new RegExp(
    '^' +
      entry
        .split('**/')
        .map((part) => part.split('*').map(esc).join('[^/]*'))
        .join('(?:.*/)?') +
      '$',
  );
  const baseDir = entry.split('*')[0].replace(/\/[^/]*$/, '') || '.';
  if (!existsSync(resolve(repoRoot, baseDir))) return [];

  let re;
  try {
    re = new RegExp(findPattern);
  } catch {
    return []; // an unparseable pattern is the claim's defect; report it there, not here
  }

  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(resolve(repoRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel === '.' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (deep) walk(child);
        continue;
      }
      if (!rx.test(child)) continue;
      let body;
      try {
        body = readFileSync(join(repoRoot, child), 'utf8');
      } catch {
        continue;
      }
      if (re.test(body)) out.push(child);
    }
  };
  walk(baseDir);
  return out.sort();
}

/** Every concrete target of a claim, both key forms folded into one list. */
export function claimTargets(claim, repoRoot) {
  const out = [];
  for (const entry of claim.apply_to_files) out.push(...expandApplyTo(entry, claim.find_pattern, repoRoot));
  return [...new Set(out)];
}
