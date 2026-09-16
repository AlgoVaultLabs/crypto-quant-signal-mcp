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
 * ─── THE COUNTERPART SLOT: ONE GRAMMAR, FOUR FORMS ──────────────────────────────────────────
 * OPS-SYSTEM-MAP-EDGE-TAXONOMY-W1 CH2. The slot immediately after the coupling flag carries the
 * line's CLASS, explicitly — the card lines were a tree of annotations, not a set of binary edges,
 * so "debt" has to mean UNCLASSIFIED, never "not yet an edge":
 *
 *     - [tight] `aoe` — …                      EDGE      a backticked §3 id; reciprocity ENFORCED
 *     - [tight] @surface `Telegram Bot` — …    SURFACE   existence-checked against §4; no reciprocity
 *     - [tight] @infra …                       INFRA     no counterpart exists
 *     - [tight] @internal …                    INTERNAL  same component, plumbing
 *
 * A §4 name that itself contains backticks is written as a double-backtick span
 * (``@surface ``ElizaOS (`plugin-algovault`)`` — …``). Refused, each with its own finding code:
 * a BARE backticked §4 name (retired — one spelling per class: BARE_SURFACE), a non-§4 @surface
 * (UNKNOWN_SURFACE), a sigil word we do not know (UNKNOWN_SIGIL — a typo is never silently debt),
 * a sigil glued to punctuation or an @surface with no name (MALFORMED_SIGIL), an @infra/@internal
 * with nothing after it (EMPTY_BODY) or whose body opens with a backticked §3/§4 name
 * (SIGIL_NAMES_COUNTERPART — a component edge must not hide behind a sigil). A line starting with
 * an npm scope (`@scope/pkg …`) is prose, not a sigil attempt.
 *
 * ANY OTHER LINE IS UNCLASSIFIED DEBT — counted per card in the lock and SHRINK-ONLY, so a card
 * that GAINS debt FAILs and a new line must therefore take one of the four forms. Classified
 * lines are content, not debt: a gained @infra line REPORTS (CLASS_DRIFT) and never blocks.
 * MAP_EDGES_RECIPROCITY_COVERAGE is a reciprocity measure, so its denominator is EDGE lines only.
 *
 * ALIAS INFERENCE IS REJECTED AND MUST NOT BE REINTRODUCED. The cards carry the §2 prose verbatim,
 * where counterparts appear as free-text aliases (`signal-MCP`, `AOE`, `blog-assets`). Two
 * reasonable alias tables gave 53 vs 59 unnamed edges on the same corpus: a number that moves with
 * the table is not an edge. Debt is burned down by classifying each line against LIVE SOURCE and
 * writing its class into the slot (the census of OPS-SYSTEM-MAP-EDGE-TAXONOMY-W1) — never by
 * guessing here. A line nobody could verify stays debt; that is a legitimate outcome.
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
 *   exactly one `MAP_EDGES_RECIPROCITY_COVERAGE=<mirrored EDGE lines>/<EDGE lines>` beside it
 *     (`0/0` when there is nothing to reciprocate; `unknown` only when nothing could be read)
 *   exactly one `MAP_EDGES_CLASSES=edge=<n> surface=<n> infra=<n> internal=<n> debt=<n>` (or
 *     `unknown`) — derived by ONE function from corpus lines and from lock ids alike
 *   exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a NEW gate)
 *   a crash is INDETERMINATE with all three lines printed, never a missing token
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
/**
 * What `--sync` writes. The grammar-2 marker makes a lock that carries class ids SELF-DESCRIBING:
 * a pre-taxonomy gate reading it fails closed on one clear `generated_by` finding instead of one
 * confusing finding per class id. The grammar-1 label stays legal only on a lock with no class
 * ids — the exact lock this gate first lands against.
 */
export const GENERATED_BY = 'scripts/check-map-edges.mjs --sync (edge-class grammar 2)';
export const GENERATED_BY_V1 = 'scripts/check-map-edges.mjs --sync';
export const FLAGS = new Set(['tight', 'loose', 'documented-only']);
/** The sigils the slot may carry, and the token keys, in their printed order. */
export const SIGILS = new Set(['surface', 'infra', 'internal']);
export const CLASS_KEYS = ['edge', 'surface', 'infra', 'internal', 'debt'];
/** Internal edge kind → the class it reports as. `external` is the historical name for SURFACE. */
export const KIND_CLASS = { component: 'edge', external: 'surface', infra: 'infra', internal: 'internal', debt: 'debt' };
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

/**
 * The code span that OPENS `text`, CommonMark-style: a run of N backticks opens it and the next run
 * of exactly N closes it — so a double-backtick span can carry a name that itself contains
 * backticks (two §4 rows do). Returns `{ name, rest }`, or null when `text` does not open with a
 * closed span. A single-backtick span behaves exactly as the pre-taxonomy `^`([^`]+)`` did.
 */
export function leadingCodeSpan(text) {
  const open = /^`+/.exec(text);
  if (!open) return null;
  const width = open[0].length;
  let i = width;
  while (i < text.length) {
    const j = text.indexOf('`', i);
    if (j < 0) return null;
    let k = j;
    while (k < text.length && text[k] === '`') k++;
    if (k - j === width) return j > width ? { name: text.slice(width, j), rest: text.slice(k) } : null;
    i = k;
  }
  return null;
}

/**
 * One edge line → flag + kind (+ counterpart). `ids`/`surfaces` are Sets from the router.
 *
 * Kinds: `component` (EDGE) · `external` (SURFACE) · `infra` · `internal` · `debt` — or `unknown`
 * with an `error` code, which the caller turns into a FAIL finding. Every refusal carries its own
 * code on purpose: a scenario that pins the code proves WHICH check fired.
 */
export function parseEdge(line, ids, surfaces) {
  const m = /^- \[([^\]]*)\]\s*(.*)$/.exec(line);
  if (!m || !FLAGS.has(m[1])) return { error: 'MISSING_FLAG' };
  const flag = m[1];
  const slot = m[2];

  // A sigil ATTEMPT is `@word` not followed by `/` — so `@scope/pkg …` prose stays prose. The
  // regex ends at the word on purpose: a lookahead would backtrack `@scope/` into `@scop`.
  const sig = /^@([A-Za-z][\w-]*)/.exec(slot);
  if (sig && slot[sig[0].length] !== '/') {
    const word = sig[1];
    const after = slot.slice(sig[0].length);
    if (!SIGILS.has(word)) return { flag, kind: 'unknown', counterpart: `@${word}`, error: 'UNKNOWN_SIGIL' };
    if (after !== '' && !/^\s/.test(after)) return { flag, kind: 'unknown', counterpart: `@${word}`, error: 'MALFORMED_SIGIL' };
    const body = after.trim();
    const span = leadingCodeSpan(body);
    if (word === 'surface') {
      if (!span) return { flag, kind: 'unknown', counterpart: '@surface', error: 'MALFORMED_SIGIL' };
      if (!surfaces.has(span.name)) return { flag, kind: 'unknown', counterpart: span.name, error: 'UNKNOWN_SURFACE' };
      return { flag, kind: 'external', counterpart: span.name };
    }
    if (body === '') return { flag, kind: 'unknown', counterpart: `@${word}`, error: 'EMPTY_BODY', sigil: word };
    if (span && (ids.has(span.name) || surfaces.has(span.name))) {
      return { flag, kind: 'unknown', counterpart: span.name, error: 'SIGIL_NAMES_COUNTERPART', sigil: word };
    }
    return { flag, kind: word };
  }

  const span = leadingCodeSpan(slot);
  if (!span) return { flag, kind: 'debt' };
  const name = span.name;
  if (ids.has(name)) return { flag, kind: 'component', counterpart: name };
  if (surfaces.has(name)) return { flag, kind: 'unknown', counterpart: name, error: 'BARE_SURFACE' };
  return { flag, kind: 'unknown', counterpart: name, error: 'UNKNOWN_COUNTERPART' };
}

/** The remediation a refused slot prints — every FAIL says what to write instead. */
function slotFinding(e, card, direction, line) {
  const at = `system-map/${card} ${direction}`;
  const quoted = (n) => (n.includes('`') ? `\`\`${n}\`\`` : `\`${n}\``);
  switch (e.error) {
    case 'BARE_SURFACE':
      return `${at}: ${quoted(e.counterpart)} is a §4 surface written bare — the bare form is retired; write @surface ${quoted(e.counterpart)} — …`;
    case 'UNKNOWN_SURFACE':
      return `${at}: @surface names ${quoted(e.counterpart)}, which is not a §4 row — use the exact §4 name, or classify the line @infra`;
    case 'UNKNOWN_SIGIL':
      return `${at}: ${e.counterpart} is not a sigil — the slot takes @surface, @infra or @internal (a typo must never become silent debt)`;
    case 'MALFORMED_SIGIL':
      return `${at}: malformed ${e.counterpart} — write "@surface \`<§4 name>\` — …", "@infra …" or "@internal …" (${line.slice(0, 60)}…)`;
    case 'EMPTY_BODY':
      return `${at}: @${e.sigil} with nothing after it — an annotation must say what it annotates`;
    case 'SIGIL_NAMES_COUNTERPART':
      return `${at}: @${e.sigil} opens with ${quoted(e.counterpart)}, a §3/§4 name — write it as a counterpart instead, so the map can check it`;
    case 'UNKNOWN_COUNTERPART':
      return `${at}: \`${e.counterpart}\` is in neither the §3 index nor the §4 table`;
    default:
      return `${at}: refused (${e.error}) — ${line.slice(0, 60)}…`;
  }
}

/**
 * The ONE canonical edge id: `<card>:<direction>:<target>=<flag>`, where target is the counterpart
 * id, `ext:<surface>`, or `debt:<n>`. The FLAG is part of identity — an id that encoded only its
 * subject would let an edge change what it asserts while the id set stayed byte-identical, which
 * is the defect this estate has already recorded in its claim verifier.
 */
export function edgeId(e) {
  const target =
    e.kind === 'debt' || e.kind === 'infra' || e.kind === 'internal' ? `${e.kind}:${e.index}`
      : e.kind === 'external' ? `ext:${e.counterpart}`
        : e.counterpart;
  return `${e.card}:${e.direction}:${target}=${e.flag}`;
}

/**
 * The ONE parser of an edge id — shared by the lock verifier, the lock-mode counts and the unit
 * test, so no second copy can drift. Named groups on purpose: positional destructuring silently
 * shifted when a class alternative was added. A card or component id never contains `:` (the
 * router refuses one, RESERVED_ID), which is what keeps `infra:x` from reading as a component.
 * Returns null for anything that is not a well-formed id.
 */
export const EDGE_ID_RE = /^(?<card>[^:]+):(?<direction>consumes|produces):(?:debt:(?<debt>[1-9]\d*)|ext:(?<surface>.+)|infra:(?<infra>[1-9]\d*)|internal:(?<internal>[1-9]\d*)|(?<counterpart>[^:]+))=(?<flag>tight|loose|documented-only)$/;
export function parseEdgeId(id) {
  const m = EDGE_ID_RE.exec(String(id));
  if (!m || !m.groups) return null;
  const g = m.groups;
  const base = { card: g.card, direction: g.direction, flag: g.flag };
  if (g.debt !== undefined) return { ...base, kind: 'debt', index: Number(g.debt) };
  if (g.infra !== undefined) return { ...base, kind: 'infra', index: Number(g.infra) };
  if (g.internal !== undefined) return { ...base, kind: 'internal', index: Number(g.internal) };
  if (g.surface !== undefined) return { ...base, kind: 'external', counterpart: g.surface };
  return { ...base, kind: 'component', counterpart: g.counterpart };
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

  // `:` separates the fields of an edge id, so a §3 id carrying one would make the lock ambiguous.
  for (const { id } of components) {
    if (id.includes(':')) findings.push({ level: 'FAIL', code: 'RESERVED_ID', msg: `§3 id \`${id}\` carries ":", the edge-id separator — rename the component` });
  }

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
      // Positional ids, 1..n per card + direction + class (debt / infra / internal).
      const position = { debt: 0, infra: 0, internal: 0 };
      for (const line of parsed[direction]) {
        const e = parseEdge(line, ids, surfaceSet);
        if (e.error === 'MISSING_FLAG') {
          findings.push({ level: 'FAIL', code: 'MISSING_FLAG', msg: `system-map/${card} ${direction}: an edge carries no coupling flag — ${line.slice(0, 60)}…` });
          continue;
        }
        // EVERY other refusal lands here by construction. An error code this loop did not know
        // about must never fall through as a well-formed edge (it would lock as `…:undefined=` and pass).
        if (e.error || !Object.prototype.hasOwnProperty.call(KIND_CLASS, e.kind)) {
          findings.push({ level: 'FAIL', code: e.error ?? 'UNKNOWN_KIND', msg: slotFinding(e, card, direction, line) });
          continue;
        }
        const index = Object.prototype.hasOwnProperty.call(position, e.kind) ? ++position[e.kind] : undefined;
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

const OPPOSITE = { produces: 'consumes', consumes: 'produces' };

/**
 * Per-class counts — the ONE derivation behind `MAP_EDGES_CLASSES`. It takes KINDS, so corpus
 * lines and parsed lock ids go through the same code and the two modes cannot disagree.
 */
export function classesOf(kinds) {
  const out = Object.fromEntries(CLASS_KEYS.map((k) => [k, 0]));
  for (const kind of kinds) out[KIND_CLASS[kind]] += 1;
  return out;
}
export const formatClasses = (c) => (c ? CLASS_KEYS.map((k) => `${k}=${c[k]}`).join(' ') : 'unknown');

/**
 * Reciprocity coverage: `<EDGE lines whose mirror exists>/<EDGE lines>`. Surface, infra, internal
 * and debt lines are not in the denominator — counting them is what once made "82 debt" read as 82
 * owed edges. Takes corpus edges or parsed lock ids alike (both carry card/direction/kind/counterpart).
 */
export function reciprocityOf(items) {
  const comp = items.filter((e) => e.kind === 'component');
  const pairs = new Set(comp.map((e) => `${e.card}|${e.direction}|${e.counterpart}`));
  const mirrored = comp.filter((e) => pairs.has(`${e.counterpart}|${OPPOSITE[e.direction]}|${e.card}`)).length;
  return `${mirrored}/${comp.length}`;
}

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

/**
 * The lock's own consistency — the ONLY thing CI can check, and the direction that catches a hand
 * edit: shape, id grammar, every counterpart known, reciprocity among the pairs it records, and
 * that the debt map IS the debt ids (the printed `debt=` and the ratchet must be one number).
 * Anything we could not read is INDETERMINATE and returns early, so no later check can throw on it.
 */
export function verifyLock(lock) {
  const findings = [];
  const fail = (code, msg) => findings.push({ level: 'FAIL', code, msg });
  const unreadable = (code, msg) => [{ level: 'INDETERMINATE', code, msg }];
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return unreadable('LOCK_UNPARSEABLE', 'the lock is not a JSON object');
  const keys = Object.keys(lock).sort();
  if (keys.join(',') !== LOCK_KEYS.join(',')) return unreadable('LOCK_UNPARSEABLE', `the lock's keys are ${keys.join(',') || '(none)'}; expected ${LOCK_KEYS.join(',')}`);
  if (!Array.isArray(lock.components) || !Array.isArray(lock.edges) || !Array.isArray(lock.surfaces_referenced)) {
    return unreadable('LOCK_UNPARSEABLE', 'components / edges / surfaces_referenced must be arrays');
  }
  if (!lock.debt || typeof lock.debt !== 'object' || Array.isArray(lock.debt)) return unreadable('LOCK_UNPARSEABLE', 'debt must be an object keyed by component');
  if (lock.components.length === 0) return unreadable('LOCK_VACUOUS', 'the lock records zero components');
  if (lock.edges.length === 0) return unreadable('LOCK_VACUOUS', 'the lock records zero edges');
  if (!/^[0-9a-f]{64}$/.test(String(lock.extracted_from_corpus_sha256))) fail('LOCK_INCONSISTENT', 'extracted_from_corpus_sha256 is not a sha256');

  const ids = new Set(lock.components);
  for (const c of lock.components) {
    if (String(c).includes(':')) fail('RESERVED_ID', `component id ${JSON.stringify(c)} carries ":", the edge-id separator`);
  }
  const surfaces = new Set(lock.surfaces_referenced);
  const parsed = [];
  for (const id of lock.edges) {
    const p = parseEdgeId(id);
    if (!p) { fail('LOCK_INCONSISTENT', `edge id is not identifier-shaped: ${id}`); continue; }
    if (!ids.has(p.card)) fail('LOCK_INCONSISTENT', `edge id names a card outside components: ${id}`);
    if (p.kind === 'external' && !surfaces.has(p.counterpart)) fail('LOCK_INCONSISTENT', `edge id names an unrecorded surface: ${id}`);
    if (p.kind === 'component' && !ids.has(p.counterpart)) fail('LOCK_INCONSISTENT', `edge id names a component outside components: ${id}`);
    parsed.push(p);
  }

  // generated_by names the id grammar. Grammar 1 cannot express a class id, so it may not carry one.
  const classIds = parsed.filter((p) => p.kind === 'infra' || p.kind === 'internal').length;
  if (lock.generated_by === GENERATED_BY_V1) {
    if (classIds > 0) fail('LOCK_INCONSISTENT', `generated_by is the grammar-1 label, but the lock carries ${classIds} infra/internal id(s) — only ${JSON.stringify(GENERATED_BY)} may`);
  } else if (lock.generated_by !== GENERATED_BY) {
    fail('LOCK_INCONSISTENT', `generated_by is ${JSON.stringify(lock.generated_by)}`);
  }

  // Positional ids run 1..n per card + direction + class; a gap or a repeat is a hand edit.
  const positions = new Map();
  for (const p of parsed) {
    if (p.index === undefined) continue;
    const k = `${p.card} ${p.direction} ${p.kind}`;
    positions.set(k, [...(positions.get(k) ?? []), p.index]);
  }
  for (const [k, list] of positions) {
    const sorted = [...list].sort((a, b) => a - b);
    if (sorted.some((n, i) => n !== i + 1)) fail('LOCK_INCONSISTENT', `positional ids for ${k} are ${sorted.join(',')}, not 1..${sorted.length}`);
  }

  // The debt map is the ratchet's memory. It must be keyed by exactly the components, and each
  // value must equal the debt ids the lock carries for that card.
  const debtKeys = Object.keys(lock.debt).sort();
  const componentKeys = [...ids].map(String).sort();
  if (JSON.stringify(debtKeys) !== JSON.stringify(componentKeys)) {
    fail('LOCK_INCONSISTENT', `debt is keyed by ${debtKeys.length} card(s) but components lists ${componentKeys.length} — they must be the same set`);
  }
  const debtIds = {};
  for (const p of parsed) if (p.kind === 'debt') debtIds[p.card] = (debtIds[p.card] ?? 0) + 1;
  for (const [card, n] of Object.entries(lock.debt)) {
    if (!Number.isInteger(n) || n < 0) { fail('LOCK_INCONSISTENT', `debt for ${card} is not a non-negative integer`); continue; }
    if (n !== (debtIds[card] ?? 0)) fail('LOCK_INCONSISTENT', `debt for ${card} is ${n}, but the lock carries ${debtIds[card] ?? 0} debt id(s) for it`);
  }

  const pairs = new Set(parsed.filter((p) => p.kind === 'component').map((p) => `${p.card}|${p.direction}|${p.counterpart}`));
  for (const p of parsed) {
    if (p.kind !== 'component') continue;
    if (!pairs.has(`${p.counterpart}|${OPPOSITE[p.direction]}|${p.card}`)) {
      fail('LOCK_INCONSISTENT', `the lock records a ONE-SIDED edge: ${p.card} ${p.direction} ${p.counterpart}`);
    }
  }
  return findings;
}

/**
 * Corpus vs lock: debt GROWTH blocks; an id difference and a class-count move REPORT.
 * Callers pass only a lock `verifyLock` could read — an unreadable lock carries no ratchet memory.
 */
export function compareToLock(state, lock) {
  const findings = [];
  const FORMS = 'a new line must take a slot form (`id`, @surface, @infra or @internal)';
  for (const [card, n] of Object.entries(state.debt)) {
    const was = Object.prototype.hasOwnProperty.call(lock.debt, card) ? lock.debt[card] : null;
    if (was === null) {
      if (n > 0) findings.push({ level: 'FAIL', code: 'DEBT_GROWTH', msg: `\`${card}\` is new to the lock and carries ${n} unclassified line(s) — ${FORMS}` });
    } else if (n > was) {
      findings.push({ level: 'FAIL', code: 'DEBT_GROWTH', msg: `\`${card}\` debt ${was} → ${n}: the ratchet is shrink-only, so ${FORMS}` });
    }
  }
  // A MULTISET, not a Set: EDGE and SURFACE ids legitimately repeat (N lines, one counterpart), and
  // dropping one of two identical lines is a change the lock must report.
  const tally = (list) => {
    const m = new Map();
    for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const now = tally(state.edges.map(edgeId));
  const then = tally(lock.edges);
  const added = [];
  const removed = [];
  for (const [id, n] of now) for (let i = then.get(id) ?? 0; i < n; i++) added.push(id);
  for (const [id, n] of then) for (let i = now.get(id) ?? 0; i < n; i++) removed.push(id);
  if (added.length || removed.length) {
    findings.push({
      level: 'REPORT',
      code: 'STALE_LOCK',
      msg: `the lock is stale: ${added.length} id(s) added, ${removed.length} removed — run \`node scripts/check-map-edges.mjs --sync\` and commit the lock`,
    });
    for (const id of added.slice(0, 5)) findings.push({ level: 'REPORT', code: 'STALE_LOCK', msg: `  + ${id}` });
    for (const id of removed.slice(0, 5)) findings.push({ level: 'REPORT', code: 'STALE_LOCK', msg: `  - ${id}` });
  }
  // Reclassification volume is made VISIBLE, never blocking: a classified line is content, not debt.
  const wasClasses = formatClasses(classesOf(lock.edges.map(parseEdgeId).filter(Boolean).map((p) => p.kind)));
  const nowClasses = formatClasses(classesOf(state.edges.map((e) => e.kind)));
  if (wasClasses !== nowClasses) {
    findings.push({ level: 'REPORT', code: 'CLASS_DRIFT', msg: `class counts moved: lock ${wasClasses} → corpus ${nowClasses}` });
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
    const verified = verifyLock(got.lock);
    findings.push(...verified);
    if (verified.some((f) => f.level === 'INDETERMINATE')) return { lines, findings, coverage: 'unknown' };
    const parsed = got.lock.edges.map(parseEdgeId).filter(Boolean);
    lines.push(`[map-edges]   lock: ${got.lock.components.length} component(s) · ${got.lock.edges.length} edge id(s)`);
    return { lines, findings, coverage: reciprocityOf(parsed), classes: classesOf(parsed.map((p) => p.kind)) };
  }

  findings.push(...state.findings);
  // `readable` = at least one card parsed. Below that there is nothing to count, so the class and
  // coverage lines say `unknown` rather than a confident zero.
  const readable = (state.cards ?? 0) > 0;
  const total = state.edges.length;
  const classes = readable ? classesOf(state.edges.map((e) => e.kind)) : undefined;
  const coverage = readable ? reciprocityOf(state.edges) : 'unknown';
  lines.push(`[map-edges] corpus: ${paths.router}`);
  lines.push(`[map-edges]   ${state.components.length} component(s) in the §3 index · ${state.cards ?? 0} card(s) read · ${total} edge line(s)`);
  if (classes && total > 0) {
    const byFlag = {};
    for (const e of state.edges) byFlag[e.flag] = (byFlag[e.flag] ?? 0) + 1;
    lines.push(`[map-edges]   flags: ${Object.entries(byFlag).map(([f, n]) => `${f}=${n}`).join(' ')}`);
    lines.push(`[map-edges]   reciprocity: ${classes.edge} EDGE line(s) checked · ${classes.surface} surface · ${classes.infra} infra · ${classes.internal} internal · ${classes.debt} unclassified debt`);
  }
  if (readable) {
    // A card that could not be read is NOT edge-less; only a parsed card with no lines is.
    const edgeless = state.components.filter((c) => state.debt[c.id] !== undefined && !state.edges.some((e) => e.card === c.id)).map((c) => c.id);
    lines.push(`[map-edges]   cards with ZERO edges (reported, never auto-populated): ${edgeless.length ? edgeless.join(', ') : '(none)'}`);
  }

  const got = readLock(lockPath);
  if (got.missing) {
    findings.push({ level: 'INDETERMINATE', code: 'LOCK_MISSING', msg: `no lock at ${lockPath} — the debt ratchet has nothing to compare against. Run: node scripts/check-map-edges.mjs --sync` });
  } else if (got.unparseable) {
    findings.push({ level: 'INDETERMINATE', code: 'LOCK_UNPARSEABLE', msg: `the lock at ${lockPath} would not parse: ${got.unparseable}` });
  } else {
    const verified = verifyLock(got.lock);
    findings.push(...verified);
    // A lock we could not read carries no ratchet memory: comparing against it would invent
    // DEBT_GROWTH on every card (or throw on a null), so it stays INDETERMINATE on its own.
    if (readable && !verified.some((f) => f.level === 'INDETERMINATE')) findings.push(...compareToLock(state, got.lock));
  }
  return { lines, findings, coverage, classes, state };
}

export function runSync({ paths, lockPath, io }) {
  const lines = [];
  const state = buildState(paths, io);
  if (state.unreachable) {
    return { lines, findings: [{ level: 'INDETERMINATE', code: 'NO_CORPUS', msg: `--sync needs the corpus; none at ${paths.router}` }], coverage: 'unknown' };
  }
  const readable = (state.cards ?? 0) > 0;
  const classes = readable ? classesOf(state.edges.map((e) => e.kind)) : undefined;
  const coverage = readable ? reciprocityOf(state.edges) : 'unknown';
  const blocking = state.findings.filter((f) => f.level !== 'REPORT');
  const got = readLock(lockPath);
  const hadLock = !got.missing;
  const usable = hadLock && !got.unparseable && !verifyLock(got.lock).some((f) => f.level === 'INDETERMINATE');
  const growth = usable ? compareToLock(state, got.lock).filter((f) => f.code === 'DEBT_GROWTH') : [];
  if (blocking.length || growth.length) {
    lines.push('[map-edges] --sync REFUSES: a lock may never record a corpus that violates the invariant, and it may never launder debt growth.');
    return { lines, findings: [...blocking, ...growth], coverage, classes };
  }
  if (hadLock && !usable) lines.push('[map-edges] --sync: the existing lock could not be read, so it carried no ratchet memory — rebuilding it from the corpus');
  const next = buildLock(state, corpusSha(state));
  // The writer verifies what it writes: a lock this gate would refuse must never reach disk.
  const own = verifyLock(next);
  if (own.length) {
    lines.push('[map-edges] --sync REFUSES: the lock it built does not pass its own verifier.');
    return { lines, findings: own, coverage, classes };
  }
  const same = usable && JSON.stringify({ ...got.lock, extracted_from_corpus_sha256: '' }) === JSON.stringify({ ...next, extracted_from_corpus_sha256: '' });
  if (same) {
    lines.push(`[map-edges] --sync: the lock is already current (${next.edges.length} edge id(s)) — not rewritten`);
  } else {
    const tmp = `${lockPath}.tmp-${process.pid}`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, lockPath);
    lines.push(`[map-edges] --sync: wrote ${lockPath} — ${next.components.length} component(s), ${next.edges.length} edge id(s), ${Object.values(next.debt).reduce((a, b) => a + b, 0)} unclassified`);
  }
  return { lines, findings: [], coverage, classes };
}

// ── self-test ─────────────────────────────────────────────────────────────────

/** Class-specific refusal codes: only a FAIL carrying one of these proves a class's FAIL direction. */
const CLASS_FAIL_CODES = {
  edge: ['ONE_SIDED', 'UNKNOWN_COUNTERPART'],
  surface: ['BARE_SURFACE', 'UNKNOWN_SURFACE'],
  infra: ['EMPTY_BODY', 'SIGIL_NAMES_COUNTERPART'],
  internal: ['EMPTY_BODY', 'SIGIL_NAMES_COUNTERPART'],
};

/**
 * Two-directional and vacuity-guarded. Fixtures are built with the REAL parsers — a hand-written
 * shape the extractor never emits is how a guard passes while being structurally unable to fail.
 *
 * An assertion that RAISES is not an assertion: every check runs inside a try/catch so a broken
 * subject reports FAIL rather than killing the run before the verdict token prints.
 *
 * CLASS PROOF: a class counts as proven in a direction only when a scenario TAGGED with it passed —
 * a PASS scenario must also match its exact class counts (a verdict alone cannot tell "@infra was
 * recognised" from "@infra silently became synced debt"), and a FAIL scenario must fire one of that
 * class's own codes with the class's sigil in the message. The run REFUSES unless all four classes
 * are proven both ways.
 */
function selfTest() {
  const results = { pass: 0, fail: 0, scenarios: 0, classes: { PASS: 0, FAIL: 0, INDETERMINATE: 0 }, proof: {}, failures: [] };
  const check = (label, fn) => {
    try {
      const ok = fn();
      if (ok === true) { results.pass++; return true; }
      results.fail++;
      results.failures.push(`${label} (returned ${JSON.stringify(ok)})`);
    } catch (e) {
      results.fail++;
      results.failures.push(`${label} (threw ${e instanceof Error ? e.message : String(e)})`);
    }
    return false;
  };

  const root = join(tmpdir(), `map-edges-selftest-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  let n = 0;
  const DEFAULT_SURFACES = ['Telegram Bot', 'ElizaOS (`plugin-algovault`)'];
  /** Build a fixture corpus; returns { paths, lockPath }. */
  const fixture = (spec) => {
    const dir = join(root, `f${++n}`);
    mkdirSync(join(dir, 'system-map'), { recursive: true });
    const rows = (spec.components ?? []).map(([id, card]) => `| [\`${id}\`](system-map/${card}) | r | r |`);
    writeFileSync(join(dir, 'system-map.md'), [
      '## 3. Component reference', '', '| Component | Role | Repo |', '|---|---|---|', ...rows, '',
      '## 4. External integration reference', '', '| Surface | Role |', '|---|---|', ...(spec.surfaces ?? DEFAULT_SURFACES).map((s) => `| ${s} | r |`), '',
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
  /** One card, one direction: the smallest corpus a slot scenario needs. */
  const single = (produces) => ({ components: [['a', 'a.md']], cards: [{ file: 'a.md', produces }] });
  const CONSISTENT = {
    components: [['a', 'a.md'], ['b', 'b.md']],
    cards: [
      {
        file: 'a.md',
        consumes: ['- [tight] `b` — contract'],
        produces: [
          '- [tight] @surface `Telegram Bot` — digest',
          '- [loose] prose only, no counterpart',
          '- [tight] @infra a datastore, nothing component-shaped on the other end',
          '- [tight] @internal a route feeds a table the same component owns',
        ],
      },
      { file: 'b.md', consumes: [], produces: ['- [tight] `a` — contract'] },
    ],
  };
  const CONSISTENT_CLASSES = 'edge=2 surface=1 infra=1 internal=1 debt=1';

  /**
   * A scenario asserts the VERDICT **and the finding code that produced it** — and, for a PASS, the
   * exact class counts.
   *
   * Asserting the verdict alone is not enough, and that is measured rather than assumed: with the
   * corpus-side reciprocity check made inert, the one-sided scenario still reported FAIL — because
   * the LOCK verifier caught the same defect through a different door — and the zero-edges
   * scenario still reported INDETERMINATE because the missing lock says so too. One check masking
   * another is how a guard keeps passing while the thing it guards is gone. The code pins WHICH
   * check fired, so breaking that check reds this self-test.
   *
   * opts.classes  — exact MAP_EDGES_CLASSES value the run must report
   * opts.proves   — [[class, 'PASS'|'FAIL'], …] credited only when this scenario passes
   * opts.mentions — a substring the pinned finding's message must carry (which sigil fired)
   */
  const scenario = (label, expected, code, build, opts = {}) => {
    results.scenarios++;
    const ok = check(`scenario ${label} ⇒ ${expected}${code ? ` via ${code}` : ''}`, () => {
      const { verdict, r } = build();
      results.classes[verdict] = (results.classes[verdict] ?? 0) + 1;
      if (verdict !== expected) return `got ${verdict} (${r.findings.map((f) => f.code).join(',') || 'no findings'})`;
      const hit = code ? r.findings.filter((f) => f.code === code) : [];
      if (code && hit.length === 0) {
        return `verdict ${verdict} but no ${code} finding (got: ${r.findings.map((f) => f.code).join(',') || 'none'})`;
      }
      if (opts.mentions && !hit.some((f) => f.msg.includes(opts.mentions))) return `no ${code} finding mentions ${opts.mentions}`;
      if (opts.classes !== undefined && formatClasses(r.classes) !== opts.classes) return `classes ${formatClasses(r.classes)}, expected ${opts.classes}`;
      return true;
    });
    if (!ok) return;
    for (const [cls, dir] of opts.proves ?? []) {
      if (dir === 'FAIL' && !(code && CLASS_FAIL_CODES[cls].includes(code))) continue;
      (results.proof[cls] ??= new Set()).add(dir);
    }
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
  const appendTo = (f, card, marker, line) => {
    const p = join(f.paths.dir, card);
    writeFileSync(p, readFileSync(p, 'utf8').replace(marker, `${marker}\n${line}\n`));
  };
  const editLock = (f, fn) => {
    const lock = JSON.parse(readFileSync(f.lockPath, 'utf8'));
    fn(lock);
    writeFileSync(f.lockPath, JSON.stringify(lock, null, 2));
  };
  const PRODUCES = '## Produces   → FORWARD DEP\n';

  // ── the four forms, both directions each ──
  scenario('consistent four-form corpus + fresh lock', 'PASS', null, () => verdictFor(synced(CONSISTENT)), {
    classes: CONSISTENT_CLASSES,
    proves: [['edge', 'PASS'], ['surface', 'PASS'], ['infra', 'PASS'], ['internal', 'PASS']],
  });
  scenario('one-sided grammar edge', 'FAIL', 'ONE_SIDED', () => {
    const f = fixture({ components: [['a', 'a.md'], ['b', 'b.md']], cards: [{ file: 'a.md', produces: ['- [tight] `b` — x'] }, { file: 'b.md' }] });
    runSync({ paths: f.paths, lockPath: f.lockPath });
    return verdictFor(f);
  }, { proves: [['edge', 'FAIL']] });
  scenario('unknown counterpart', 'FAIL', 'UNKNOWN_COUNTERPART', () => verdictFor(synced(single(['- [tight] `ghost` — x']))), { proves: [['edge', 'FAIL']] });
  scenario('bare backticked §4 name (retired form)', 'FAIL', 'BARE_SURFACE', () => verdictFor(fixture(single(['- [tight] `Telegram Bot` — x']))), {
    mentions: '@surface `Telegram Bot`',
    proves: [['surface', 'FAIL']],
  });
  scenario('@surface naming a non-§4 entry', 'FAIL', 'UNKNOWN_SURFACE', () => verdictFor(fixture(single(['- [tight] @surface `Nowhere` — x']))), { proves: [['surface', 'FAIL']] });
  scenario('@surface with a double-backtick §4 name', 'PASS', null, () => verdictFor(synced(single(['- [tight] @surface ``ElizaOS (`plugin-algovault`)`` — x']))), {
    classes: 'edge=0 surface=1 infra=0 internal=0 debt=0',
    proves: [['surface', 'PASS']],
  });
  scenario('@infra with an empty body', 'FAIL', 'EMPTY_BODY', () => verdictFor(fixture(single(['- [tight] @infra']))), { mentions: '@infra', proves: [['infra', 'FAIL']] });
  scenario('@internal with an empty body', 'FAIL', 'EMPTY_BODY', () => verdictFor(fixture(single(['- [tight] @internal   ']))), { mentions: '@internal', proves: [['internal', 'FAIL']] });
  scenario('@infra hiding a §3 id in the slot', 'FAIL', 'SIGIL_NAMES_COUNTERPART', () => verdictFor(fixture(single(['- [tight] @infra `a` — an edge in disguise']))), {
    mentions: '@infra',
    proves: [['infra', 'FAIL']],
  });
  scenario('@internal hiding a §4 name in the slot', 'FAIL', 'SIGIL_NAMES_COUNTERPART', () => verdictFor(fixture(single(['- [tight] @internal `Telegram Bot` — a surface in disguise']))), {
    mentions: '@internal',
    proves: [['internal', 'FAIL']],
  });
  scenario('a gained @infra line is not debt growth', 'PASS', 'CLASS_DRIFT', () => {
    const f = synced(CONSISTENT);
    appendTo(f, 'a.md', PRODUCES, '- [tight] @infra a second datastore');
    return verdictFor(f);
  }, { classes: 'edge=2 surface=1 infra=2 internal=1 debt=1', proves: [['infra', 'PASS']] });
  scenario('a gained @internal line is not debt growth', 'PASS', 'CLASS_DRIFT', () => {
    const f = synced(CONSISTENT);
    appendTo(f, 'a.md', PRODUCES, '- [loose] @internal a second route');
    return verdictFor(f);
  }, { classes: 'edge=2 surface=1 infra=1 internal=2 debt=1', proves: [['internal', 'PASS']] });

  // ── the grammar's other refusals ──
  scenario('an unknown sigil', 'FAIL', 'UNKNOWN_SIGIL', () => verdictFor(fixture(single(['- [tight] @infrx a typo']))));
  scenario('a sigil in the wrong case', 'FAIL', 'UNKNOWN_SIGIL', () => verdictFor(fixture(single(['- [tight] @Surface `Telegram Bot` — x']))));
  scenario('a sigil glued to punctuation', 'FAIL', 'MALFORMED_SIGIL', () => verdictFor(fixture(single(['- [tight] @infra: x']))));
  scenario('@surface with no name', 'FAIL', 'MALFORMED_SIGIL', () => verdictFor(fixture(single(['- [tight] @surface Telegram Bot']))));
  scenario('npm-scope prose is debt, not a sigil', 'PASS', null, () => verdictFor(synced(single(['- [tight] @algovaultlabs/skills ships the plugin']))), {
    classes: 'edge=0 surface=0 infra=0 internal=0 debt=1',
  });
  scenario('edge without a flag', 'FAIL', 'MISSING_FLAG', () => verdictFor(synced(single(['- no flag here']))));
  scenario('a §3 id carrying the id separator', 'FAIL', 'RESERVED_ID', () => verdictFor(fixture({ components: [['a:b', 'a.md']], cards: [{ file: 'a.md', produces: ['- [tight] @infra x'] }] })));

  // ── the ratchet ──
  scenario('debt growth vs the lock', 'FAIL', 'DEBT_GROWTH', () => {
    const f = synced(CONSISTENT);
    appendTo(f, 'a.md', PRODUCES, '- [tight] a second prose edge');
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
  scenario('multiset: dropping one of two identical EDGE lines', 'PASS', 'STALE_LOCK', () => {
    const f = synced({
      components: [['a', 'a.md'], ['b', 'b.md']],
      cards: [{ file: 'a.md', produces: ['- [tight] `b` — one', '- [tight] `b` — two'] }, { file: 'b.md', consumes: ['- [tight] `a` — both'] }],
    });
    const a = join(f.paths.dir, 'a.md');
    writeFileSync(a, readFileSync(a, 'utf8').replace('- [tight] `b` — two\n', ''));
    return verdictFor(f);
  });

  // ── the index and the corpus ──
  scenario('§3 row whose card is missing', 'FAIL', 'MISSING_CARD', () => verdictFor(synced({ components: [['a', 'a.md'], ['ghost', 'ghost.md']], cards: [{ file: 'a.md', produces: ['- [tight] @surface `Telegram Bot` — x'] }] })));
  scenario('card file no §3 row references', 'FAIL', 'ORPHAN_CARD', () => verdictFor(synced({ components: [['a', 'a.md']], cards: [{ file: 'a.md', produces: ['- [tight] @surface `Telegram Bot` — x'] }], orphans: ['stray.md'] })));
  scenario('card missing a required section', 'INDETERMINATE', 'CARD_UNPARSEABLE', () => verdictFor(synced({ components: [['a', 'a.md']], cards: [{ file: 'a.md', consumes: ['- [tight] @surface `Telegram Bot` — x'], omitProduces: true }] })));
  scenario('zero cards', 'INDETERMINATE', 'NO_CARDS', () => verdictFor(fixture({ components: [['a', 'a.md']], cards: [], noCardDir: true })));
  scenario('zero edges from a non-empty corpus', 'INDETERMINATE', 'NO_EDGES', () => verdictFor(fixture({ components: [['a', 'a.md']], cards: [{ file: 'a.md' }] })));
  scenario('missing lock in corpus mode', 'INDETERMINATE', 'LOCK_MISSING', () => verdictFor(fixture(CONSISTENT)));
  scenario('a null lock in corpus mode is unreadable, not debt growth', 'INDETERMINATE', 'LOCK_UNPARSEABLE', () => {
    const f = synced(CONSISTENT);
    writeFileSync(f.lockPath, 'null');
    return verdictFor(f);
  });

  // ── lock mode (CI) ──
  scenario('lock mode with a consistent grammar-2 lock', 'PASS', null, () => lockModeFor(synced(CONSISTENT)), { classes: CONSISTENT_CLASSES });
  scenario('lock mode with a one-sided lock', 'FAIL', 'LOCK_INCONSISTENT', () => {
    const f = synced(CONSISTENT);
    editLock(f, (lock) => { lock.edges = lock.edges.filter((e) => !e.startsWith('b:produces:a')); });
    return lockModeFor(f);
  });
  scenario('lock mode with a malformed class id', 'FAIL', 'LOCK_INCONSISTENT', () => {
    const f = synced(CONSISTENT);
    editLock(f, (lock) => { lock.edges = lock.edges.map((e) => (e === 'a:produces:infra:1=tight' ? 'a:produces:infra:x=tight' : e)); });
    return lockModeFor(f);
  });
  scenario('lock mode with a non-contiguous class id', 'FAIL', 'LOCK_INCONSISTENT', () => {
    const f = synced(CONSISTENT);
    editLock(f, (lock) => { lock.edges = lock.edges.map((e) => (e === 'a:produces:internal:1=tight' ? 'a:produces:internal:2=tight' : e)); });
    return lockModeFor(f);
  });
  scenario('lock mode with a debt map that disagrees with the debt ids', 'FAIL', 'LOCK_INCONSISTENT', () => {
    const f = synced(CONSISTENT);
    editLock(f, (lock) => { lock.debt.a = 0; });
    return lockModeFor(f);
  });
  scenario('lock mode with a grammar-1 label on class ids', 'FAIL', 'LOCK_INCONSISTENT', () => {
    const f = synced(CONSISTENT);
    editLock(f, (lock) => { lock.generated_by = GENERATED_BY_V1; });
    return lockModeFor(f);
  });
  scenario('lock mode with a grammar-1 label and no class ids', 'PASS', null, () => {
    const f = synced({
      components: [['a', 'a.md'], ['b', 'b.md']],
      cards: [{ file: 'a.md', produces: ['- [tight] `b` — x', '- [tight] prose'] }, { file: 'b.md', consumes: ['- [tight] `a` — x'] }],
    });
    editLock(f, (lock) => { lock.generated_by = GENERATED_BY_V1; });
    return lockModeFor(f);
  });
  scenario('lock mode with an unparseable lock', 'INDETERMINATE', 'LOCK_UNPARSEABLE', () => {
    const f = synced(CONSISTENT);
    writeFileSync(f.lockPath, 'not json at all');
    return lockModeFor(f);
  });
  scenario('lock mode with a null lock', 'INDETERMINATE', 'LOCK_UNPARSEABLE', () => {
    const f = synced(CONSISTENT);
    writeFileSync(f.lockPath, 'null');
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
  check('coverage counts EDGE lines only', () => {
    const f = synced(CONSISTENT);
    const c = runCheck({ paths: f.paths, lockPath: f.lockPath }).coverage;
    return c === '2/2' ? true : `coverage ${c}`;
  });
  check('coverage is 0/0 with nothing to reciprocate, and a one-sided EDGE stays in the denominator', () => {
    const g = synced(single(['- [tight] @infra x']));
    const none = runCheck({ paths: g.paths, lockPath: g.lockPath }).coverage;
    const f = fixture({ components: [['a', 'a.md'], ['b', 'b.md']], cards: [{ file: 'a.md', produces: ['- [tight] `b` — x'] }, { file: 'b.md' }] });
    const oneSided = runCheck({ paths: f.paths, lockPath: f.lockPath }).coverage;
    return none === '0/0' && oneSided === '0/1' ? true : `none=${none} oneSided=${oneSided}`;
  });
  check('class counts are ONE derivation: corpus mode == lock mode', () => {
    const f = synced(CONSISTENT);
    const corpus = formatClasses(runCheck({ paths: f.paths, lockPath: f.lockPath }).classes);
    const lock = formatClasses(lockModeFor(f).r.classes);
    return corpus === lock && corpus === CONSISTENT_CLASSES ? true : `corpus ${corpus} vs lock ${lock}`;
  });
  check('token → exit code mapping', () => mapCode('PASS') === 0 && mapCode('FAIL') === 1 && mapCode('INDETERMINATE') === 3);
  check('the Tree block is not read as edges', () => {
    const f = synced(CONSISTENT);
    const st = buildState(f.paths);
    return st.edges.every((e) => !e.line.includes('a tree line'));
  });
  check('an edge id encodes its flag', () => edgeId({ card: 'a', direction: 'produces', kind: 'component', counterpart: 'b', flag: 'tight' }) !== edgeId({ card: 'a', direction: 'produces', kind: 'component', counterpart: 'b', flag: 'loose' }));
  check('parseEdgeId round-trips every kind edgeId emits', () => {
    const cases = [
      { card: 'a', direction: 'produces', kind: 'component', counterpart: 'landing/', flag: 'tight' },
      { card: 'Plausible CE', direction: 'consumes', kind: 'external', counterpart: 'ElizaOS (`plugin-algovault`)', flag: 'loose' },
      { card: 'a', direction: 'produces', kind: 'infra', index: 3, flag: 'documented-only' },
      { card: 'a', direction: 'consumes', kind: 'internal', index: 1, flag: 'tight' },
      { card: 'a', direction: 'consumes', kind: 'debt', index: 12, flag: 'tight' },
    ];
    for (const e of cases) {
      const p = parseEdgeId(edgeId(e));
      if (!p || p.kind !== e.kind || p.card !== e.card || p.direction !== e.direction || p.flag !== e.flag || p.counterpart !== e.counterpart || p.index !== e.index) {
        return `${edgeId(e)} → ${JSON.stringify(p)}`;
      }
    }
    return true;
  });
  check('parseEdgeId refuses malformed ids', () => {
    const bad = ['a:produces:infra:0=tight', 'a:produces:internal:01=tight', 'a:produces:infra:x=tight', 'a:produces:debt:=tight', 'a:sideways:b=tight', 'a:produces:b=firm', 'nothing'];
    const accepted = bad.filter((id) => parseEdgeId(id) !== null);
    return accepted.length === 0 ? true : `accepted ${accepted.join(' ')}`;
  });
  check('leadingCodeSpan reads single and double spans and refuses unclosed ones', () => {
    const one = leadingCodeSpan('`aoe` — x');
    const two = leadingCodeSpan('``ElizaOS (`plugin-algovault`)`` — x');
    return one?.name === 'aoe' && two?.name === 'ElizaOS (`plugin-algovault`)' && leadingCodeSpan('`open') === null && leadingCodeSpan('plain') === null
      ? true
      : `one=${JSON.stringify(one)} two=${JSON.stringify(two)}`;
  });
  check('emit prints exactly one of each token, VERDICT last', () => {
    const printed = [];
    const log = console.log;
    console.log = (s) => printed.push(String(s));
    try {
      emit({ lines: [], findings: [], coverage: '2/2', classes: classesOf(['component', 'component', 'infra']) });
      emit({ lines: [], findings: [{ level: 'INDETERMINATE', code: 'X', msg: 'y' }], coverage: 'unknown' });
    } finally {
      console.log = log;
    }
    const first = printed.slice(0, 3);
    const second = printed.slice(3);
    const shape = (out, classes) => out.length === 3 && out[0] === `MAP_EDGES_CLASSES=${classes}` && out[1].startsWith('MAP_EDGES_RECIPROCITY_COVERAGE=') && out[2].startsWith('MAP_EDGES_VERDICT=');
    return shape(first, 'edge=2 surface=0 infra=1 internal=0 debt=0') && second.length === 4 && shape(second.slice(1), 'unknown') ? true : JSON.stringify(printed);
  });

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

  // Vacuity: a self-test that built too few scenarios, never exercised all three verdicts, or never
  // watched every class both PASS and FAIL is the failure mode it exists to prevent. REFUSE.
  const need = Object.keys(CLASS_FAIL_CODES);
  const proofOf = (c) => ['PASS', 'FAIL'].filter((d) => results.proof[c]?.has(d)).join('+') || 'none';
  const unproven = need.filter((c) => proofOf(c) !== 'PASS+FAIL');
  const lines = [
    `[map-edges] self-test: ${results.scenarios} scenarios, ${results.pass + results.fail} checks (${results.fail} failed)`,
    `[map-edges] self-test class proof: ${need.map((c) => `${c}=${proofOf(c)}`).join(' ')}`,
  ];
  const findings = [];
  if (results.scenarios < 30 || results.classes.PASS === 0 || results.classes.FAIL === 0 || results.classes.INDETERMINATE === 0 || unproven.length) {
    findings.push({
      level: 'INDETERMINATE',
      code: 'SELFTEST_VACUOUS',
      msg: `the self-test corpus cannot prove what it guards: ${results.scenarios} scenarios, verdicts ${JSON.stringify(results.classes)}, classes not proven both ways: ${unproven.join(', ') || 'none'}`,
    });
  }
  for (const f of results.failures) findings.push({ level: 'FAIL', code: 'SELFTEST', msg: f });
  return { lines, findings, coverage: 'unknown' };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/**
 * The ONLY writer to stdout. Prints the findings, then exactly one CLASSES line, one COVERAGE line
 * and the terminal VERDICT line — in that order, in every mode.
 */
function emit({ lines, findings, coverage, classes }) {
  for (const l of lines) console.log(l);
  const glyph = { FAIL: '✖', INDETERMINATE: '⚠', REPORT: '·' };
  for (const f of findings) console.log(`[map-edges] ${glyph[f.level] ?? '·'} ${f.code}: ${f.msg}`);
  const verdict = verdictOf(findings);
  console.log(`MAP_EDGES_CLASSES=${formatClasses(classes)}`);
  console.log(`MAP_EDGES_RECIPROCITY_COVERAGE=${coverage}`);
  console.log(`MAP_EDGES_VERDICT=${verdict}`);
  return mapCode(verdict);
}

function main(argv) {
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
  if (bad) return emit({ lines: [], findings: [{ level: 'INDETERMINATE', code: 'BAD_ARGS', msg: bad }], coverage: 'unknown' });
  if (mode === 'self-test') return emit(selfTest());
  const paths = resolveMapPaths();
  if (paths.error) return emit({ lines: [], findings: [{ level: 'INDETERMINATE', code: 'NO_PATHS', msg: paths.error }], coverage: 'unknown' });
  return emit(mode === 'sync' ? runSync({ paths, lockPath }) : runCheck({ paths, lockPath }));
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (e) {
    // A crash is a verdict too: INDETERMINATE, with every token printed — never a missing line.
    code = emit({ lines: [], findings: [{ level: 'INDETERMINATE', code: 'CRASH', msg: `the gate threw: ${e instanceof Error ? e.message : String(e)}` }], coverage: 'unknown' });
  }
  process.exit(code);
}
