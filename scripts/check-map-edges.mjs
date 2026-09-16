#!/usr/bin/env node
// @ts-check
/**
 * check-map-edges.mjs — the bidirectional-consistency gate over the system map.
 *
 * OPS-SYSTEM-MAP-DIRECTORY-W1 CH5. The map is a router (`system-map.md`: a §3 component index and
 * a §4 external-surface table) plus one card per component (`system-map/<component>.md`) holding
 * that component's `## Consumes` and `## Produces` edges. Until this gate, nothing could tell
 * whether the two ends of an edge agreed: §2 was a TREE, which recorded each edge ONCE, under one
 * end, so "A produces to B" and "B consumes from A" were never the same fact.
 *
 * ─── WHAT A COUNTERPART IS, AND WHY THE GRAMMAR IS NARROW ───────────────────────────────────
 * A counterpart is recognised ONLY as a backticked §3 id immediately after the coupling flag:
 *
 *     - [tight] `aoe` — Redis algovault:aoe:recommended_weights:* …
 *
 * Those edges get reciprocity AND id-in-index enforced. A backticked §4 surface name is
 * existence-checked and carries no reciprocity, because an external has no card. EVERY OTHER EDGE
 * IS UNRESOLVED DEBT — counted per card in the lock and SHRINK-ONLY, so a card that GAINS debt
 * FAILs and a new edge must therefore use the grammar.
 *
 * ALIAS INFERENCE IS REJECTED AND MUST NOT BE REINTRODUCED. The cards carry the §2 prose verbatim,
 * where counterparts appear as free-text aliases (`signal-MCP`, `AOE`, `blog-assets`). Two
 * reasonable alias tables gave 53 vs 59 unnamed edges on the same corpus: a number that moves with
 * the table is not an edge. The debt is burned down by a vault-side card-normalisation wave
 * against live source, one card at a time — not by guessing here.
 *
 * ─── CORPUS vs LOCK ─────────────────────────────────────────────────────────────────────────
 * The corpus is the vault — private, outside this PUBLIC repo, unreachable from CI. So the gate
 * keeps a committed lock, `ops/system-map-edges.lock.json`, holding IDENTIFIERS ONLY (component
 * ids, edge ids, flags, per-card debt counts). Locally it re-derives from the corpus and compares;
 * in CI (corpus unreachable) it verifies the lock's own consistency — the direction that catches a
 * hand-edit. `extracted_from_corpus_sha256` is PROVENANCE, never compared live: freshness is
 * EDGE-SET equality, because a whole-file hash over a concurrently edited vault makes false
 * invalidation the steady state (`Claude files/rules/verification-gates.md`).
 *
 * ─── VERDICT CONTRACT ───────────────────────────────────────────────────────────────────────
 *   exactly one terminal `MAP_EDGES_VERDICT=PASS|FAIL|INDETERMINATE`
 *   exactly one `MAP_EDGES_RECIPROCITY_COVERAGE=<resolved>/<total>` (or `unknown`) beside it
 *   exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a NEW gate)
 *
 * A STALE LOCK REPORTS, IT DOES NOT BLOCK. The cards are edited by concurrent vault sessions; a
 * blocking staleness check on a shared corpus deadlocked three times in this estate. What FAILs is
 * a reciprocity / index / flag violation, or debt GROWTH — all of them authored by whoever edited
 * the card, and all fixable at the card.
 *
 * FAIL-CLOSED ON VACUITY: zero cards, zero edges parsed from a non-empty corpus, a missing or
 * unparseable lock, or a card missing a required section is INDETERMINATE and blocks. Empty input
 * is only vacuity when someone was supposed to fill it — here the world builds the corpus, but a
 * corpus of zero cards means we could not read it, not that the map has no components.
 *
 * Usage:
 *   node scripts/check-map-edges.mjs                 # verify (default). CI: lock mode.
 *   node scripts/check-map-edges.mjs --sync          # regenerate the lock from the corpus
 *   node scripts/check-map-edges.mjs --self-test     # two-directional, vacuity-guarded
 *   node scripts/check-map-edges.mjs --lock <path>   # seam: drive a fixture lock (tests only)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK = join(ROOT, 'ops', 'system-map-edges.lock.json');
const PATH_LIB = join(ROOT, 'scripts', 'lib', 'system-map-path.sh');
const GENERATED_BY = 'scripts/check-map-edges.mjs --sync';
export const FLAGS = new Set(['tight', 'loose', 'documented-only']);
export const LOCK_KEYS = ['components', 'debt', 'edges', 'extracted_from_corpus_sha256', 'generated_by', 'surfaces_referenced'];

// ── paths ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the router path and the card directory from the ONE declaration,
 * `scripts/lib/system-map-path.sh`, by SOURCING it — never by parsing it and never by restating
 * the path here. Sourcing also inherits $SYSTEM_MAP_PATH, so the override's precedence is the
 * library's, not a second rule of our own.
 */
export function resolveMapPaths(env = process.env) {
  if (!existsSync(PATH_LIB)) return { error: `the vault path SoT is missing: ${PATH_LIB}` };
  let out;
  try {
    out = execFileSync(
      'bash',
      ['-c', '. "$1"; printf "%s\\n%s\\n" "$ALGOVAULT_SYSTEM_MAP_PATH" "$ALGOVAULT_SYSTEM_MAP_DIR"', '_', PATH_LIB],
      { encoding: 'utf8', env },
    );
  } catch (e) {
    return { error: `the vault path SoT would not source: ${e instanceof Error ? e.message : String(e)}` };
  }
  const [router, dir] = out.split('\n');
  if (!router || !dir) return { error: 'the vault path SoT defined no router path or no card directory' };
  return { router, dir };
}

// ── router ────────────────────────────────────────────────────────────────────

/** Split a markdown table row into cells, honouring the `\|` escape the map-shape gate mandates. */
export function cells(line) {
  return line
    .replace(/\\\|/g, '\u0000')
    .split('|')
    .map((c) => c.replace(/\u0000/g, '\\|').trim());
}

/**
 * The §3 component index and the §4 surface table.
 *
 * §3 rows are recognised STRUCTURALLY — a first cell that links into `system-map/` — never by
 * heading number, so renumbering a section cannot silently empty the corpus. §4 is anchored on its
 * own header row (`| Surface | Role |`) for the same reason.
 */
export function parseRouter(text) {
  const components = [];
  const surfaces = [];
  let inSurfaces = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const m = /^\|\s*\[`([^`]+)`\]\(system-map\/([^)]+\.md)\)\s*\|/.exec(line);
    if (m) {
      components.push({ id: m[1], card: m[2] });
      inSurfaces = false;
      continue;
    }
    if (/^\|\s*Surface\s*\|\s*Role\s*\|/.test(line)) { inSurfaces = true; continue; }
    if (!inSurfaces) continue;
    if (!line.startsWith('|')) { inSurfaces = false; continue; }
    const c = cells(line);
    if (!c[1] || /^-+$/.test(c[1])) continue;
    surfaces.push(c[1]);
  }
  return { components, surfaces };
}

// ── cards ─────────────────────────────────────────────────────────────────────

/**
 * A card's two edge sections. Only `## Consumes` and `## Produces` are read; `## Tree` holds the
 * verbatim §2 fragment, which contains edge-shaped lines that are NOT edges — reading it would
 * double-count the whole corpus.
 */
export function parseCard(text) {
  /** @type {{consumes?: string[], produces?: string[]}} */
  const sections = {};
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = /^## Consumes\b/.test(line) ? 'consumes' : /^## Produces\b/.test(line) ? 'produces' : null;
      if (current) sections[current] = [];
      continue;
    }
    if (current && line.startsWith('- ')) sections[current].push(line);
  }
  if (!sections.consumes) return { error: 'no "## Consumes" section' };
  if (!sections.produces) return { error: 'no "## Produces" section' };
  return { consumes: sections.consumes, produces: sections.produces };
}

/** One edge line → flag + counterpart kind. `ids`/`surfaces` are Sets from the router. */
export function parseEdge(line, ids, surfaces) {
  const m = /^- \[([^\]]*)\]\s*(.*)$/.exec(line);
  if (!m || !FLAGS.has(m[1])) return { error: 'MISSING_FLAG' };
  const flag = m[1];
  const c = /^`([^`]+)`/.exec(m[2]);
  if (!c) return { flag, kind: 'debt' };
  const name = c[1];
  if (ids.has(name)) return { flag, kind: 'component', counterpart: name };
  if (surfaces.has(name)) return { flag, kind: 'external', counterpart: name };
  return { flag, kind: 'unknown', counterpart: name, error: 'UNKNOWN_COUNTERPART' };
}

/**
 * The ONE canonical edge id: `<card>:<direction>:<target>=<flag>`, where target is the counterpart
 * id, `ext:<surface>`, or `debt:<n>`. The FLAG is part of identity — an id that encoded only its
 * subject would let an edge change what it asserts while the id set stayed byte-identical, which
 * is the defect this estate has already recorded in its claim verifier.
 */
export function edgeId(e) {
  const target = e.kind === 'debt' ? `debt:${e.index}` : e.kind === 'external' ? `ext:${e.counterpart}` : e.counterpart;
  return `${e.card}:${e.direction}:${target}=${e.flag}`;
}

// ── corpus state ──────────────────────────────────────────────────────────────

/**
 * Read the corpus and derive every fact the verdict needs. `io` is injected so the self-test drives
 * the SAME code with fixture corpora instead of a seam that only the test ever takes.
 */
export function buildState({ router, dir }, io = { read: (p) => readFileSync(p, 'utf8'), list: (p) => readdirSync(p), exists: existsSync }) {
  /** @type {{level: 'FAIL'|'INDETERMINATE'|'REPORT', code: string, msg: string}[]} */
  const findings = [];
  if (!io.exists(router)) return { unreachable: true, findings };
  const { components, surfaces } = parseRouter(io.read(router));
  if (components.length === 0) {
    findings.push({ level: 'INDETERMINATE', code: 'NO_COMPONENTS', msg: `the router at ${router} yielded no §3 component rows — the index could not be parsed` });
    return { components: [], surfaces, edges: [], debt: {}, findings };
  }
  if (surfaces.length === 0) {
    findings.push({ level: 'INDETERMINATE', code: 'NO_SURFACES', msg: `the router at ${router} yielded no §4 surface rows — the external table could not be parsed` });
    return { components, surfaces: [], edges: [], debt: {}, findings };
  }
  if (!io.exists(dir)) {
    findings.push({ level: 'INDETERMINATE', code: 'NO_CARDS', msg: `no card directory at ${dir} — the corpus is unreadable, which is not the same as a map with no edges` });
    return { components, surfaces, edges: [], debt: {}, findings };
  }

  const ids = new Set(components.map((c) => c.id));
  const surfaceSet = new Set(surfaces);
  const byCard = new Map(components.map((c) => [c.id, c.card]));

  // Index ↔ card-file bijection, both directions.
  for (const { id, card } of components) {
    if (!io.exists(join(dir, card))) findings.push({ level: 'FAIL', code: 'MISSING_CARD', msg: `§3 lists \`${id}\` → system-map/${card}, which does not exist` });
  }
  const referenced = new Set(components.map((c) => c.card));
  for (const f of io.list(dir).filter((f) => f.endsWith('.md')).sort()) {
    if (!referenced.has(f)) findings.push({ level: 'FAIL', code: 'ORPHAN_CARD', msg: `system-map/${f} is not referenced by any §3 row — a card no traversal can reach` });
  }

  /** @type {{card: string, direction: string, kind: string, counterpart?: string, index?: number, flag: string, line: string}[]} */
  const edges = [];
  /** @type {Record<string, number>} */
  const debt = {};
  let cards = 0;
  for (const { id, card } of components) {
    const path = join(dir, card);
    if (!io.exists(path)) continue;
    cards++;
    const parsed = parseCard(io.read(path));
    if (parsed.error) {
      findings.push({ level: 'INDETERMINATE', code: 'CARD_UNPARSEABLE', msg: `system-map/${card}: ${parsed.error} — handed to us and unparseable` });
      continue;
    }
    debt[id] = 0;
    for (const direction of ['consumes', 'produces']) {
      let debtIndex = 0;
      for (const line of parsed[direction]) {
        const e = parseEdge(line, ids, surfaceSet);
        if (e.error === 'MISSING_FLAG') {
          findings.push({ level: 'FAIL', code: 'MISSING_FLAG', msg: `system-map/${card} ${direction}: an edge carries no coupling flag — ${line.slice(0, 60)}…` });
          continue;
        }
        if (e.error === 'UNKNOWN_COUNTERPART') {
          findings.push({ level: 'FAIL', code: 'UNKNOWN_COUNTERPART', msg: `system-map/${card} ${direction}: \`${e.counterpart}\` is in neither the §3 index nor the §4 table` });
          continue;
        }
        const index = e.kind === 'debt' ? ++debtIndex : undefined;
        if (e.kind === 'debt') debt[id] += 1;
        edges.push({ card: id, direction, kind: e.kind, counterpart: e.counterpart, index, flag: e.flag, line });
      }
    }
  }

  if (cards === 0) findings.push({ level: 'INDETERMINATE', code: 'NO_CARDS', msg: `the card directory ${dir} yielded no readable cards` });
  else if (edges.length === 0) findings.push({ level: 'INDETERMINATE', code: 'NO_EDGES', msg: `${cards} card(s) parsed but ZERO edges — the edge grammar is dead, which is not the same as a map with no edges` });

  // Reciprocity, over GRAMMAR edges only. `documented-only` is not exempt: the flag says how much
  // to verify downstream, never whether the map has to agree with itself.
  const opposite = { produces: 'consumes', consumes: 'produces' };
  const pairs = new Set(edges.filter((e) => e.kind === 'component').map((e) => `${e.card}|${e.direction}|${e.counterpart}`));
  for (const e of edges.filter((e) => e.kind === 'component')) {
    const mirror = `${e.counterpart}|${opposite[e.direction]}|${e.card}`;
    if (!pairs.has(mirror)) {
      findings.push({
        level: 'FAIL',
        code: 'ONE_SIDED',
        msg: `system-map/${byCard.get(e.card)} ${e.direction} \`${e.counterpart}\` has no matching \`${opposite[e.direction]}\` naming \`${e.card}\` in system-map/${byCard.get(e.counterpart)}`,
      });
    }
  }

  return { components, surfaces, edges, debt, cards, findings };
}

export const resolvedOf = (edges) => edges.filter((e) => e.kind !== 'debt').length;

// ── lock ──────────────────────────────────────────────────────────────────────

export function buildLock(state, corpusSha) {
  return {
    generated_by: GENERATED_BY,
    extracted_from_corpus_sha256: corpusSha,
    components: state.components.map((c) => c.id).sort(),
    surfaces_referenced: [...new Set(state.edges.filter((e) => e.kind === 'external').map((e) => e.counterpart))].sort(),
    edges: state.edges.map(edgeId).sort(),
    debt: Object.fromEntries(Object.keys(state.debt).sort().map((k) => [k, state.debt[k]])),
  };
}

export const EDGE_ID_RE = /^(.+):(consumes|produces):(?:debt:(\d+)|ext:(.+)|(.+))=(tight|loose|documented-only)$/;

/**
 * The lock's own consistency — the ONLY thing CI can check, and the direction that catches a hand
 * edit: shape, id grammar, every counterpart known, and reciprocity among the pairs it records.
 */
export function verifyLock(lock) {
  const findings = [];
  const fail = (code, msg) => findings.push({ level: 'FAIL', code, msg });
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return [{ level: 'INDETERMINATE', code: 'LOCK_UNPARSEABLE', msg: 'the lock is not a JSON object' }];
  const keys = Object.keys(lock).sort();
  if (keys.join(',') !== LOCK_KEYS.join(',')) return [{ level: 'INDETERMINATE', code: 'LOCK_UNPARSEABLE', msg: `the lock's keys are ${keys.join(',')}; expected ${LOCK_KEYS.join(',')}` }];
  if (lock.generated_by !== GENERATED_BY) fail('LOCK_INCONSISTENT', `generated_by is ${JSON.stringify(lock.generated_by)}`);
  if (!/^[0-9a-f]{64}$/.test(String(lock.extracted_from_corpus_sha256))) fail('LOCK_INCONSISTENT', 'extracted_from_corpus_sha256 is not a sha256');
  if (!Array.isArray(lock.components) || !Array.isArray(lock.edges) || !Array.isArray(lock.surfaces_referenced)) {
    return [{ level: 'INDETERMINATE', code: 'LOCK_UNPARSEABLE', msg: 'components / edges / surfaces_referenced must be arrays' }];
  }
  if (lock.components.length === 0) return [{ level: 'INDETERMINATE', code: 'LOCK_VACUOUS', msg: 'the lock records zero components' }];
  if (lock.edges.length === 0) return [{ level: 'INDETERMINATE', code: 'LOCK_VACUOUS', msg: 'the lock records zero edges' }];

  const ids = new Set(lock.components);
  const surfaces = new Set(lock.surfaces_referenced);
  const pairs = new Set();
  const parsed = [];
  for (const id of lock.edges) {
    const m = EDGE_ID_RE.exec(String(id));
    if (!m) { fail('LOCK_INCONSISTENT', `edge id is not identifier-shaped: ${id}`); continue; }
    const [, card, direction, debtIdx, ext, counterpart] = m;
    if (!ids.has(card)) fail('LOCK_INCONSISTENT', `edge id names a card outside components: ${id}`);
    if (ext !== undefined && !surfaces.has(ext)) fail('LOCK_INCONSISTENT', `edge id names an unrecorded surface: ${id}`);
    if (counterpart !== undefined && !ids.has(counterpart)) fail('LOCK_INCONSISTENT', `edge id names a component outside components: ${id}`);
    if (counterpart !== undefined) pairs.add(`${card}|${direction}|${counterpart}`);
    parsed.push({ card, direction, debtIdx, ext, counterpart });
  }
  const opposite = { produces: 'consumes', consumes: 'produces' };
  for (const e of parsed) {
    if (e.counterpart === undefined) continue;
    if (!pairs.has(`${e.counterpart}|${opposite[e.direction]}|${e.card}`)) {
      fail('LOCK_INCONSISTENT', `the lock records a ONE-SIDED edge: ${e.card} ${e.direction} ${e.counterpart}`);
    }
  }
  for (const [card, n] of Object.entries(lock.debt ?? {})) {
    if (!ids.has(card)) fail('LOCK_INCONSISTENT', `debt names a card outside components: ${card}`);
    if (!Number.isInteger(n) || n < 0) fail('LOCK_INCONSISTENT', `debt for ${card} is not a non-negative integer`);
  }
  return findings;
}

/** Corpus vs lock: debt GROWTH blocks; an id-set difference REPORTS. */
export function compareToLock(state, lock) {
  const findings = [];
  for (const [card, n] of Object.entries(state.debt)) {
    const was = Object.prototype.hasOwnProperty.call(lock.debt ?? {}, card) ? lock.debt[card] : null;
    if (was === null) {
      if (n > 0) findings.push({ level: 'FAIL', code: 'DEBT_GROWTH', msg: `\`${card}\` is new to the lock and carries ${n} unresolved edge(s) — a new edge must use the counterpart grammar` });
    } else if (n > was) {
      findings.push({ level: 'FAIL', code: 'DEBT_GROWTH', msg: `\`${card}\` debt ${was} → ${n}: the ratchet is shrink-only, so a new edge must use the counterpart grammar` });
    }
  }
  const now = new Set(state.edges.map(edgeId));
  const then = new Set(lock.edges);
  const added = [...now].filter((x) => !then.has(x));
  const removed = [...then].filter((x) => !now.has(x));
  if (added.length || removed.length) {
    findings.push({
      level: 'REPORT',
      code: 'STALE_LOCK',
      msg: `the lock is stale: ${added.length} id(s) added, ${removed.length} removed — run \`node scripts/check-map-edges.mjs --sync\` and commit the lock`,
    });
    for (const id of [...added.slice(0, 5)]) findings.push({ level: 'REPORT', code: 'STALE_LOCK', msg: `  + ${id}` });
    for (const id of [...removed.slice(0, 5)]) findings.push({ level: 'REPORT', code: 'STALE_LOCK', msg: `  - ${id}` });
  }
  return findings;
}

export const corpusSha = (state, io = { read: (p) => readFileSync(p, 'utf8') }, paths) =>
  createHash('sha256')
    .update(state.components.map((c) => `${c.id}\u0000${c.card}`).join('\n'))
    .update('\n\u0001\n')
    .update(state.edges.map((e) => `${edgeId(e)}\u0000${e.line}`).join('\n'))
    .digest('hex');

// ── verdict ───────────────────────────────────────────────────────────────────

/**
 * FAIL outranks INDETERMINATE, deliberately.
 *
 * INDETERMINATE means "could not verify". A run that DID verify a violation — a one-sided edge, an
 * unknown counterpart, a card the index promises and the directory does not hold — has verified
 * something, and reporting "could not verify" over it would hide an actionable defect behind an
 * unactionable one. Both block (exit 1 vs 3), so nothing is relaxed by this order: it only decides
 * WHICH true thing the terminal token says. A run with no FAIL and any INDETERMINATE still refuses.
 */
export function verdictOf(findings) {
  if (findings.some((f) => f.level === 'FAIL')) return 'FAIL';
  if (findings.some((f) => f.level === 'INDETERMINATE')) return 'INDETERMINATE';
  return 'PASS';
}
export const mapCode = (verdict) => (verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);

// ── runs ──────────────────────────────────────────────────────────────────────

function readLock(path) {
  if (!existsSync(path)) return { missing: true };
  try {
    return { lock: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { unparseable: `${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The whole decision, as data. `emit` is the only thing that writes to stdout. */
export function runCheck({ paths, lockPath, io }) {
  const lines = [];
  const findings = [];
  const state = buildState(paths, io);

  if (state.unreachable) {
    // LOCK MODE — the corpus is not on this machine (CI, by design). Verify the lock alone.
    lines.push(`[map-edges] lock mode: no corpus at ${paths.router} — verifying ${lockPath} alone`);
    const got = readLock(lockPath);
    if (got.missing) {
      findings.push({ level: 'INDETERMINATE', code: 'LOCK_MISSING', msg: `no lock at ${lockPath} — in lock mode there is nothing else to verify` });
      return { lines, findings, coverage: 'unknown' };
    }
    if (got.unparseable) {
      findings.push({ level: 'INDETERMINATE', code: 'LOCK_UNPARSEABLE', msg: `the lock at ${lockPath} would not parse: ${got.unparseable}` });
      return { lines, findings, coverage: 'unknown' };
    }
    findings.push(...verifyLock(got.lock));
    const total = Array.isArray(got.lock.edges) ? got.lock.edges.length : 0;
    const resolved = Array.isArray(got.lock.edges) ? got.lock.edges.filter((e) => !/:debt:\d+=/.test(e)).length : 0;
    lines.push(`[map-edges]   lock: ${got.lock.components?.length ?? 0} component(s) · ${total} edge id(s)`);
    return { lines, findings, coverage: total === 0 ? 'unknown' : `${resolved}/${total}` };
  }

  findings.push(...state.findings);
  const total = state.edges.length;
  const resolved = resolvedOf(state.edges);
  const coverage = total === 0 ? 'unknown' : `${resolved}/${total}`;
  lines.push(`[map-edges] corpus: ${paths.router}`);
  lines.push(`[map-edges]   ${state.components.length} component(s) in the §3 index · ${state.cards ?? 0} card(s) read · ${total} edge(s)`);
  if (total > 0) {
    const byFlag = {};
    for (const e of state.edges) byFlag[e.flag] = (byFlag[e.flag] ?? 0) + 1;
    const component = state.edges.filter((e) => e.kind === 'component').length;
    lines.push(`[map-edges]   flags: ${Object.entries(byFlag).map(([f, n]) => `${f}=${n}`).join(' ')}`);
    lines.push(`[map-edges]   reciprocity: ${component} component edge(s) checked · ${resolved - component} external · ${total - resolved} unresolved debt`);
    const edgeless = state.components.filter((c) => (state.debt[c.id] ?? 0) === 0 && !state.edges.some((e) => e.card === c.id)).map((c) => c.id);
    if (edgeless.length) lines.push(`[map-edges]   cards with ZERO edges (reported, never auto-populated): ${edgeless.join(', ')}`);
  }

  const got = readLock(lockPath);
  if (got.missing) {
    findings.push({ level: 'INDETERMINATE', code: 'LOCK_MISSING', msg: `no lock at ${lockPath} — the debt ratchet has nothing to compare against. Run: node scripts/check-map-edges.mjs --sync` });
  } else if (got.unparseable) {
    findings.push({ level: 'INDETERMINATE', code: 'LOCK_UNPARSEABLE', msg: `the lock at ${lockPath} would not parse: ${got.unparseable}` });
  } else {
    findings.push(...verifyLock(got.lock));
    findings.push(...compareToLock(state, got.lock));
  }
  return { lines, findings, coverage, state };
}

export function runSync({ paths, lockPath, io }) {
  const lines = [];
  const state = buildState(paths, io);
  if (state.unreachable) {
    return { lines, findings: [{ level: 'INDETERMINATE', code: 'NO_CORPUS', msg: `--sync needs the corpus; none at ${paths.router}` }], coverage: 'unknown' };
  }
  const blocking = state.findings.filter((f) => f.level !== 'REPORT');
  const got = readLock(lockPath);
  const growth = got.lock ? compareToLock(state, got.lock).filter((f) => f.code === 'DEBT_GROWTH') : [];
  if (blocking.length || growth.length) {
    lines.push('[map-edges] --sync REFUSES: a lock may never record a corpus that violates the invariant, and it may never launder debt growth.');
    return { lines, findings: [...blocking, ...growth], coverage: state.edges.length ? `${resolvedOf(state.edges)}/${state.edges.length}` : 'unknown' };
  }
  const next = buildLock(state, corpusSha(state));
  const same = got.lock && JSON.stringify({ ...got.lock, extracted_from_corpus_sha256: '' }) === JSON.stringify({ ...next, extracted_from_corpus_sha256: '' });
  if (same) {
    lines.push(`[map-edges] --sync: the lock is already current (${next.edges.length} edge id(s)) — not rewritten`);
  } else {
    const tmp = `${lockPath}.tmp-${process.pid}`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, lockPath);
    lines.push(`[map-edges] --sync: wrote ${lockPath} — ${next.components.length} component(s), ${next.edges.length} edge id(s), ${Object.values(next.debt).reduce((a, b) => a + b, 0)} unresolved`);
  }
  return { lines, findings: [], coverage: state.edges.length ? `${resolvedOf(state.edges)}/${state.edges.length}` : 'unknown' };
}

// ── self-test ─────────────────────────────────────────────────────────────────

/**
 * Two-directional and vacuity-guarded. Fixtures are built with the REAL parsers — a hand-written
 * shape the extractor never emits is how a guard passes while being structurally unable to fail.
 *
 * An assertion that RAISES is not an assertion: every check runs inside a try/catch so a broken
 * subject reports FAIL rather than killing the run before the verdict token prints.
 */
function selfTest() {
  const results = { pass: 0, fail: 0, scenarios: 0, classes: { PASS: 0, FAIL: 0, INDETERMINATE: 0 }, failures: [] };
  const check = (label, fn) => {
    try {
      const ok = fn();
      if (ok === true) results.pass++;
      else { results.fail++; results.failures.push(`${label} (returned ${JSON.stringify(ok)})`); }
    } catch (e) {
      results.fail++;
      results.failures.push(`${label} (threw ${e instanceof Error ? e.message : String(e)})`);
    }
  };

  const root = join(tmpdir(), `map-edges-selftest-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  let n = 0;
  /** Build a fixture corpus; returns { paths, lockPath }. */
  const fixture = (spec) => {
    const dir = join(root, `f${++n}`);
    mkdirSync(join(dir, 'system-map'), { recursive: true });
    const rows = (spec.components ?? []).map(([id, card]) => `| [\`${id}\`](system-map/${card}) | r | r |`);
    writeFileSync(join(dir, 'system-map.md'), [
      '## 3. Component reference', '', '| Component | Role | Repo |', '|---|---|---|', ...rows, '',
      '## 4. External integration reference', '', '| Surface | Role |', '|---|---|', ...(spec.surfaces ?? ['Telegram Bot']).map((s) => `| ${s} | r |`), '',
    ].join('\n'));
    for (const c of spec.cards ?? []) {
      const body = ['# x', '', '## Consumes   ← BACKWARD DEP', '', ...(c.consumes ?? []), ''];
      if (!c.omitProduces) body.push('## Produces   → FORWARD DEP', '', ...(c.produces ?? []), '');
      body.push('## Tree (verbatim from §2 — the lossless record)', '', '```text', '- [tight] `aoe` — a tree line, never an edge', '```', '');
      writeFileSync(join(dir, 'system-map', c.file), body.join('\n'));
    }
    for (const o of spec.orphans ?? []) writeFileSync(join(dir, 'system-map', o), '# o\n\n## Consumes   ← BACKWARD DEP\n\n## Produces   → FORWARD DEP\n');
    if (spec.noCardDir) rmSync(join(dir, 'system-map'), { recursive: true, force: true });
    return { paths: { router: join(dir, 'system-map.md'), dir: join(dir, 'system-map') }, lockPath: join(dir, 'lock.json') };
  };
  const CONSISTENT = {
    components: [['a', 'a.md'], ['b', 'b.md']],
    cards: [
      { file: 'a.md', consumes: ['- [tight] `b` — contract'], produces: ['- [tight] `Telegram Bot` — digest', '- [loose] prose only, no counterpart'] },
      { file: 'b.md', consumes: [], produces: ['- [tight] `a` — contract'] },
    ],
  };
  /**
   * A scenario asserts the VERDICT **and the finding code that produced it**.
   *
   * Asserting the verdict alone is not enough, and that is measured rather than assumed: with the
   * corpus-side reciprocity check made inert, the one-sided scenario still reported FAIL — because
   * the LOCK verifier caught the same defect through a different door — and the zero-edges
   * scenario still reported INDETERMINATE because the missing lock says so too. One check masking
   * another is how a guard keeps passing while the thing it guards is gone. The code pins WHICH
   * check fired, so breaking that check reds this self-test.
   */
  const scenario = (label, expected, code, build) => {
    results.scenarios++;
    check(`scenario ${label} ⇒ ${expected}${code ? ` via ${code}` : ''}`, () => {
      const { verdict, r } = build();
      results.classes[verdict] = (results.classes[verdict] ?? 0) + 1;
      if (verdict !== expected) return `got ${verdict}`;
      if (code && !r.findings.some((f) => f.code === code)) {
        return `verdict ${verdict} but no ${code} finding (got: ${r.findings.map((f) => f.code).join(',') || 'none'})`;
      }
      return true;
    });
  };
  const verdictFor = (f) => {
    const r = runCheck({ paths: f.paths, lockPath: f.lockPath });
    return { verdict: verdictOf(r.findings), r };
  };
  const lockModeFor = (f) => {
    const r = runCheck({ paths: { router: join(f.paths.dir, 'nope.md'), dir: f.paths.dir }, lockPath: f.lockPath });
    return { verdict: verdictOf(r.findings), r };
  };
  const synced = (spec) => {
    const f = fixture(spec);
    runSync({ paths: f.paths, lockPath: f.lockPath });
    return f;
  };

  scenario('consistent corpus + fresh lock', 'PASS', null, () => verdictFor(synced(CONSISTENT)));
  scenario('one-sided grammar edge', 'FAIL', 'ONE_SIDED', () => {
    const f = fixture({ components: [['a', 'a.md'], ['b', 'b.md']], cards: [{ file: 'a.md', produces: ['- [tight] `b` — x'] }, { file: 'b.md' }] });
    runSync({ paths: f.paths, lockPath: f.lockPath });
    return verdictFor(f);
  });
  scenario('unknown counterpart', 'FAIL', 'UNKNOWN_COUNTERPART', () => {
    const f = synced({ components: [['a', 'a.md']], cards: [{ file: 'a.md', produces: ['- [tight] `ghost` — x'] }] });
    return verdictFor(f);
  });
  scenario('edge without a flag', 'FAIL', 'MISSING_FLAG', () => {
    const f = synced({ components: [['a', 'a.md']], cards: [{ file: 'a.md', produces: ['- no flag here'] }] });
    return verdictFor(f);
  });
  scenario('debt growth vs the lock', 'FAIL', 'DEBT_GROWTH', () => {
    const f = synced(CONSISTENT);
    const card = join(f.paths.dir, 'a.md');
    writeFileSync(card, readFileSync(card, 'utf8').replace('## Produces   → FORWARD DEP\n', '## Produces   → FORWARD DEP\n\n- [tight] a second prose edge\n'));
    return verdictFor(f);
  });
  scenario('stale lock (ids moved, debt shrank)', 'PASS', 'STALE_LOCK', () => {
    // A normalisation wave's first card: one prose edge becomes a grammar edge, mirrored on the
    // other side. Rewording alone would NOT move an id — debt ids are positional by design — so
    // this is the change that actually makes a lock stale without growing debt.
    const f = synced(CONSISTENT);
    const a = join(f.paths.dir, 'a.md');
    writeFileSync(a, readFileSync(a, 'utf8').replace('- [loose] prose only, no counterpart', '- [loose] `b` — now in the grammar'));
    const b = join(f.paths.dir, 'b.md');
    writeFileSync(b, readFileSync(b, 'utf8').replace('## Consumes   ← BACKWARD DEP\n', '## Consumes   ← BACKWARD DEP\n\n- [loose] `a` — now in the grammar\n'));
    return verdictFor(f);
  });
  scenario('§3 row whose card is missing', 'FAIL', 'MISSING_CARD', () => {
    const f = synced({ components: [['a', 'a.md'], ['ghost', 'ghost.md']], cards: [{ file: 'a.md', produces: ['- [tight] `Telegram Bot` — x'] }] });
    return verdictFor(f);
  });
  scenario('card file no §3 row references', 'FAIL', 'ORPHAN_CARD', () => {
    const f = synced({ components: [['a', 'a.md']], cards: [{ file: 'a.md', produces: ['- [tight] `Telegram Bot` — x'] }], orphans: ['stray.md'] });
    return verdictFor(f);
  });
  scenario('card missing a required section', 'INDETERMINATE', 'CARD_UNPARSEABLE', () => {
    const f = synced({ components: [['a', 'a.md']], cards: [{ file: 'a.md', consumes: ['- [tight] `Telegram Bot` — x'], omitProduces: true }] });
    return verdictFor(f);
  });
  scenario('zero cards', 'INDETERMINATE', 'NO_CARDS', () => verdictFor(fixture({ components: [['a', 'a.md']], cards: [], noCardDir: true })));
  scenario('zero edges from a non-empty corpus', 'INDETERMINATE', 'NO_EDGES', () => verdictFor(fixture({ components: [['a', 'a.md']], cards: [{ file: 'a.md' }] })));
  scenario('missing lock in corpus mode', 'INDETERMINATE', 'LOCK_MISSING', () => verdictFor(fixture(CONSISTENT)));
  scenario('lock mode with a consistent lock', 'PASS', null, () => lockModeFor(synced(CONSISTENT)));
  scenario('lock mode with a one-sided lock', 'FAIL', 'LOCK_INCONSISTENT', () => {
    const f = synced(CONSISTENT);
    const lock = JSON.parse(readFileSync(f.lockPath, 'utf8'));
    lock.edges = lock.edges.filter((e) => !e.startsWith('b:produces:a'));
    writeFileSync(f.lockPath, JSON.stringify(lock, null, 2));
    return lockModeFor(f);
  });
  scenario('lock mode with an unparseable lock', 'INDETERMINATE', 'LOCK_UNPARSEABLE', () => {
    const f = synced(CONSISTENT);
    writeFileSync(f.lockPath, 'not json at all');
    return lockModeFor(f);
  });
  scenario('--sync refuses a violating corpus', 'FAIL', 'UNKNOWN_COUNTERPART', () => {
    const f = synced(CONSISTENT);
    const card = join(f.paths.dir, 'a.md');
    writeFileSync(card, readFileSync(card, 'utf8').replace('- [tight] `b` — contract', '- [tight] `ghost` — x'));
    const before = readFileSync(f.lockPath, 'utf8');
    const r = runSync({ paths: f.paths, lockPath: f.lockPath });
    // …and the refusal must leave the lock untouched: a --sync that rewrites over its own refusal
    // would launder the violation into the committed artifact, which is the one thing CI reads.
    check('--sync leaves the lock untouched when it refuses', () => readFileSync(f.lockPath, 'utf8') === before || 'the lock was rewritten over a refusal');
    return { verdict: verdictOf(r.findings), r };
  });

  // ── properties the scenarios above do not cover ──
  check('coverage counts grammar edges only', () => {
    const f = synced(CONSISTENT);
    return runCheck({ paths: f.paths, lockPath: f.lockPath }).coverage === '3/4' ? true : `coverage ${runCheck({ paths: f.paths, lockPath: f.lockPath }).coverage}`;
  });
  check('token → exit code mapping', () => mapCode('PASS') === 0 && mapCode('FAIL') === 1 && mapCode('INDETERMINATE') === 3);
  check('the Tree block is not read as edges', () => {
    const f = synced(CONSISTENT);
    const st = buildState(f.paths);
    return st.edges.every((e) => !e.line.includes('a tree line'));
  });
  check('an edge id encodes its flag', () => edgeId({ card: 'a', direction: 'produces', kind: 'component', counterpart: 'b', flag: 'tight' }) !== edgeId({ card: 'a', direction: 'produces', kind: 'component', counterpart: 'b', flag: 'loose' }));

  // ── SEAM assertions: the artifacts every fixture above BYPASSES ──
  check('SEAM the real path library resolves an absolute router + its card directory', () => {
    const p = resolveMapPaths();
    if (p.error) return p.error;
    return p.router.startsWith('/') && p.router.endsWith('.md') && p.dir === p.router.slice(0, -3);
  });
  check('SEAM the COMMITTED lock passes the same verifier', () => {
    if (!existsSync(DEFAULT_LOCK)) return 'the committed lock is missing';
    const findings = verifyLock(JSON.parse(readFileSync(DEFAULT_LOCK, 'utf8')));
    return findings.length === 0 ? true : findings.map((f) => f.msg).join('; ');
  });
  check('SEAM the installed pre-commit block, if any, is REPORT-ONLY', () => {
    let hooks = '';
    try { hooks = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return true; }
    const hook = join(hooks, 'pre-commit');
    if (!hooks || !existsSync(hook)) return true;
    const block = /# >>> algovault map-edges \([^)]*\) >>>[\s\S]*?# <<< algovault map-edges <<</.exec(readFileSync(hook, 'utf8'));
    if (!block) return true;
    return /\|\|\s*exit 1/.test(block[0]) ? 'the installed block can block a commit' : true;
  });

  rmSync(root, { recursive: true, force: true });

  // Vacuity: a self-test that built no scenarios, or that never exercised all three verdicts, is
  // the failure mode it exists to prevent. REFUSE rather than report a pass.
  const lines = [`[map-edges] self-test: ${results.scenarios} scenarios, ${results.pass + results.fail} checks (${results.fail} failed)`];
  const findings = [];
  if (results.scenarios < 12 || results.classes.PASS === 0 || results.classes.FAIL === 0 || results.classes.INDETERMINATE === 0) {
    findings.push({ level: 'INDETERMINATE', code: 'SELFTEST_VACUOUS', msg: `the self-test corpus is too small to prove anything: ${results.scenarios} scenarios, classes ${JSON.stringify(results.classes)}` });
  }
  for (const f of results.failures) findings.push({ level: 'FAIL', code: 'SELFTEST', msg: f });
  return { lines, findings, coverage: 'unknown' };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function emit({ lines, findings, coverage }) {
  for (const l of lines) console.log(l);
  const glyph = { FAIL: '✖', INDETERMINATE: '⚠', REPORT: '·' };
  for (const f of findings) console.log(`[map-edges] ${glyph[f.level] ?? '·'} ${f.code}: ${f.msg}`);
  const verdict = verdictOf(findings);
  console.log(`MAP_EDGES_RECIPROCITY_COVERAGE=${coverage}`);
  console.log(`MAP_EDGES_VERDICT=${verdict}`);
  return mapCode(verdict);
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  const argv = process.argv.slice(2);
  let lockPath = DEFAULT_LOCK;
  let mode = 'check';
  let bad = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') mode = 'self-test';
    else if (a === '--sync') mode = 'sync';
    else if (a === '--check') mode = 'check';
    else if (a === '--lock') { lockPath = argv[++i] ?? ''; if (!lockPath) bad = '--lock needs a path'; }
    else bad = `unknown argument: ${a}`;
  }
  if (bad) {
    process.exit(emit({ lines: [], findings: [{ level: 'INDETERMINATE', code: 'BAD_ARGS', msg: bad }], coverage: 'unknown' }));
  }
  if (mode === 'self-test') {
    process.exit(emit(selfTest()));
  }
  const paths = resolveMapPaths();
  if (paths.error) {
    process.exit(emit({ lines: [], findings: [{ level: 'INDETERMINATE', code: 'NO_PATHS', msg: paths.error }], coverage: 'unknown' }));
  }
  process.exit(emit(mode === 'sync' ? runSync({ paths, lockPath }) : runCheck({ paths, lockPath })));
}
