#!/usr/bin/env node
/**
 * check-cron-interlock-coverage.mjs — OPS-DEPLOY-INTERLOCK-CRON-DEFER-W1.
 *
 * A CRON THAT A DEPLOY CAN DECAPITATE CANNOT EXIST UNREGISTERED, BECAUSE THE CORPUS THAT DECIDES
 * "CAN BE DECAPITATED" IS DERIVED FROM THE SCRIPT'S OWN TEXT — NOT FROM WHO REMEMBERED TO LIST IT.
 *
 * ── THE BUG CLASS THIS RETIRES ──────────────────────────────────────────────────────────────
 * `deploy.yml` runs `docker compose up -d --build --force-recreate`. Everything executing inside
 * one of those containers via `docker exec` dies at that moment. Until this wave exactly ONE job
 * was protected — the carry labeler — by a pattern hardcoded inside the interlock script. So
 * every new long `docker exec` cron was unprotected BY DEFAULT, and nothing anywhere went red.
 *
 * That default is what produced the "18:00–02:59 UTC deploy-free window" folklore: a real
 * measurement whose SCOPE was narrower than its APPLICATION, carried in an agent-side memory file
 * rather than in either of the estate's two declared rule sources. You do not delete a measured
 * finding — you make it unnecessary. `ops/scripts/cron-interlock-registry.json` is where the
 * finding now lives as data, and this gate is what keeps it complete.
 *
 * ── SECOND APPLICATION OF A PROVEN SHAPE, NOT A NEW CONVENTION ──────────────────────────────
 * `check-declaration-coverage.mjs` already asserts "every file with a reader is declared". This
 * asserts "every cron that `docker exec`s is registered". Same `evaluate()`/`emit()` split, same
 * vacuity-guard placement, same fixture-tree self-test with a block of assertions against the
 * REAL tree that the fixture seam bypasses. `stripComments` is imported rather than reimplemented
 * — a second copy of "what counts as a mention" is the duplicated-fact drift this repo forbids.
 *
 * ── A MENTION IS NOT AN INVOCATION ──────────────────────────────────────────────────────────
 * Two files in `ops/cron/` contain the literal string `docker exec` and invoke neither: one in a
 * `#` comment recording a RETIRED implementation, one inside an alert-body heredoc ("... host
 * dist/ unusable AND docker exec failed ..."). A bare substring match reports both as candidates
 * and the registry grows two rows for jobs that do not exist. So comments are stripped AND the
 * match requires COMMAND POSITION — start of line, after a `;`/`&`/`|`, inside `$( )`, or after
 * `exec`. That is the same lesson `check-canaries-wired.mjs` carries for comments and
 * `check-test-budget.mjs` carries for string literals, in a third substrate.
 *
 * ── HOST SCOPING (OPS-HOST-AUTO-REBOOT-W1) ──────────────────────────────────────────────────
 * Every registry row now declares its `host`, because the DISRUPTION EVENT differs per host and so
 * does the enumeration that finds it: signal-1's event is `docker compose --force-recreate` (a
 * `docker exec` question), aoe-1's is a REBOOT (strictly larger — every container, every host
 * process, every in-flight Prefect run). A row consulted for the wrong host is a guard reading a
 * green light for a road it is not on.
 *
 * So this gate checks EVERY declared host by default, and `--host <label>` narrows to one. Two
 * things are checked per host and they are deliberately different:
 *   · the REPO-SIDE CORPUS check (`ops/cron/*.sh` must each have a row) applies only to the host
 *     that owns that tree — signal-1. For a host whose rows are all `source: host-only` there is
 *     no repo corpus, and saying so with a positive line is the honest answer, NOT a vacuity
 *     INDETERMINATE. "Empty input is only vacuity when YOU were supposed to fill it."
 *   · the ROW-USABILITY check (known class, non-empty reason) applies to every row of every host.
 *
 * It also asserts `_residual_no_safe_kill[host]` MATCHES that host's actual rows. That block is
 * what OPS-HOST-AUTO-REBOOT-W1's reboot gate and the deploy-free-window ruling both read; if a
 * later wave reclassifies the last no-safe-kill row without updating it, a control would keep
 * being justified by a row that no longer says so.
 *
 * ── HOST-ONLY CRONS: THE INVENTORY CROSS-CHECK, AND WHAT IT STILL CANNOT SEE ───────────────
 * A build-time gate cannot read a live crontab, but it CAN read the monitoring inventory, which
 * declares every host install with its per-host schedule (`installed_at[]`). On every REBOOT-scope
 * evaluation each scheduled, installed `installed_at[]` entry is synthesized into the crontab line
 * it implies — `<schedule> <path>` — and run through the SAME `liveCoverage()` the live population
 * uses. One matcher, two corpora: an unmapped synthesized line FAILs exactly as an unmapped live
 * line does, so "a scheduled install with no reboot classification" is unbuildable rather than
 * discovered when a kernel is already 7 days stale. (OPS-HOST-KERNEL-REBOOT-W6 B7: two signal-1
 * installs — verdict-rule-gate, 10-04, and directional-labels-race-integrity, 10-14 — landed with
 * inventory rows and no REBOOT row, and deferred signal-1's first unattended kernel cycle for 14
 * consecutive in-window runs. This cross-check replaces the never-built host canary this header
 * used to promise for every inventory-tracked install.)
 *
 * The join is keyed on `installed_at[].host` LABELS, never the legacy top-level `host`, which mixes
 * IPs and labels. An entry's `schedule` / `install_state` override the row's (the inventory's own
 * `_installed_at_semantics`). A null schedule is "not scheduled" — a library or a data file, a
 * declared fact. A schedule that is present but not a 5-field cron line is INDETERMINATE: input we
 * were handed and could not parse is never skipped.
 *
 * Known unclassified installs are DATA, never an exemption in prose: `_inventory_reboot_debt[host]`
 * lists them (ids + reason + count), and the list ONLY SHRINKS — a listed id that is now classified,
 * or no longer installed, FAILs until it is removed. aoe-1's harness reads no live population
 * (`aoe-1:population_check` is empty), so an unclassified aoe-1 job fails toward silence; the
 * ratchet makes the NEXT one a build-time FAIL without reclassifying today's.
 *
 * RESIDUAL, STATED RATHER THAN HIDDEN: a crontab line with NO inventory row (itself a breach of the
 * inventory LAW) is still invisible at build time. Only the live check catches it — on signal-1,
 * when kernel-auto-reboot.sh runs this gate at BREACH.
 *
 * ── EVENT SCOPE (OPS-HOST-AUTO-REBOOT-SIGNAL1-PROMOTE-W1) ───────────────────────────────────
 * A row is classified per (host, DISRUPTION EVENT), because the events differ in size and the
 * population each one can kill differs with them. signal-1 now has TWO: `deploy` (the container
 * recreate above) and `reboot` (strictly larger — every container AND every host cron process AND
 * every host systemd unit). `_disruption_events[host]` declares which events a host has; every row
 * declares `events[]` (never a default); `_enumeration` and `_residual_no_safe_kill` are keyed
 * [host][event]. A host that declares `reboot` must classify EVERY one of its rows for it — a
 * reboot kills whatever a deploy kills — so a row on a reboot-eligible host whose `events` omits
 * `reboot` is INDETERMINATE: nobody has said what the reboot costs it, and "unsaid" must never read
 * as "safe".
 *
 * The REBOOT scope of a host is checked against that host's LIVE schedule, because there is no
 * repo-side corpus for most of it (bot, carry, editorial, monitoring and OS units are all host-only).
 * `--crontab <file|->` and `--units <file>` hand the gate the live population: every active crontab
 * line must map to a REBOOT-scope row or a REBOOT-scope exclusion through that entry's `cron_match`
 * substrings, and every running service / enabled timer through its `units` globs. An unmapped
 * line or unit is FAIL — a job a reboot would kill that nobody has classified. Without those flags
 * the live check is REPORTED as not supplied (a CI runner holds no host credential, and must not),
 * which is why kernel-auto-reboot.sh runs THIS gate, with the live population, on the host itself
 * before it is allowed to reboot.
 *
 * Verdict contract: exactly one terminal CRON_INTERLOCK_COVERAGE_VERDICT=PASS|FAIL|INDETERMINATE.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a new gate).
 * Callers gate on the TOKEN, never the code.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './check-alert-recommended-wave.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** Where the committed cron wrappers live. The only tree a build-time gate can see. */
export const CRON_DIR = 'ops/cron';
/** The declared protected set, beside its only consumer. */
export const REGISTRY_REL = 'ops/scripts/cron-interlock-registry.json';
/** The three classes a row may declare. Anything else is an unusable row. */
export const VALID_CLASSES = new Set(['safe-to-kill', 'preempt-and-catchup', 'no-safe-kill']);
/** The disruption events a row may be classified for. */
export const VALID_EVENTS = new Set(['deploy', 'reboot']);
export const REBOOT_EVENT = 'reboot';
/**
 * The ONE host whose scheduled work is committed as `ops/cron/*.sh`. Any other host's rows are
 * `source: host-only` and have no repo-side corpus for the candidate check to compare against.
 */
export const REPO_CRON_HOST = 'signal-1';

/**
 * `docker exec` in COMMAND POSITION — start of line, after a command separator, inside a `$( )`,
 * or after `exec`. Never mid-sentence, which is how the two prose mentions in ops/cron/ read.
 */
export const DOCKER_EXEC_RE = /(^|[;&|]|\$\(|\bexec\s)\s*(sudo\s+)?docker\s+exec\b/m;

/** Every committed cron wrapper, whether or not it execs. */
export function cronFiles(root) {
  const dir = path.join(root, CRON_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sh'))
    .sort()
    .map((n) => ({ name: n, rel: `${CRON_DIR}/${n}`, abs: path.join(dir, n) }));
}

/** Those that actually invoke `docker exec` — the set that needs a registry row. */
export function cronCandidates(root) {
  return cronFiles(root).filter((f) => {
    let text = '';
    try { text = readFileSync(f.abs, 'utf8'); } catch { return false; }
    return DOCKER_EXEC_RE.test(stripComments(text));
  });
}

/**
 * The registry, or null when it cannot be read or parsed. Null is INDETERMINATE at the caller —
 * never "nothing is registered", which would silently pass a tree with no protection at all.
 */
export function loadRegistry(root) {
  const p = path.join(root, REGISTRY_REL);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    if (!doc || !Array.isArray(doc.rows)) return null;
    return doc;
  } catch { return null; }
}

/** Every host the registry declares a row for, in declaration order. */
export function declaredHosts(doc) {
  const seen = [];
  for (const r of doc.rows || []) {
    const h = r && typeof r.host === 'string' ? r.host.trim() : '';
    if (h && !seen.includes(h)) seen.push(h);
  }
  return seen;
}

/** The events a host declares, or null when it declares none (INDETERMINATE at the caller). */
export function hostEvents(doc, host) {
  const d = doc && doc._disruption_events;
  const ev = d && Array.isArray(d[host]) ? d[host].filter((e) => typeof e === 'string') : null;
  return ev && ev.length ? ev : null;
}

/** A host's rows classified for one event. A row with no `events` array is in NO scope. */
export function scopedRows(doc, host, event) {
  return (doc.rows || []).filter((r) => r && r.host === host && Array.isArray(r.events) && r.events.includes(event));
}

/** A host's exclusions for one event, under the same rule. */
export function scopedExclusions(doc, host, event) {
  return (Array.isArray(doc.exclusions) ? doc.exclusions : [])
    .filter((e) => e && e.host === host && Array.isArray(e.events) && e.events.includes(event));
}

/** The active lines of a crontab text: not blank, not a comment, not an `ENV=value` line. */
export function activeCronLines(text) {
  return String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() && !/^\s*#/.test(l) && !/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l));
}

/** `units` globs: only `*` is special, matched against the whole unit name. */
export function globToRe(g) {
  return new RegExp(`^${String(g).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

const nonEmptyStrings = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s.trim()) : []);

/**
 * Map the LIVE population onto a (host, event) scope. Rows first, then exclusions, each by its
 * explicit `cron_match` substrings / `units` globs — never by an inferred field, because an
 * inferred match is a second derivation of "which job is this" that drifts silently.
 */
export function liveCoverage(doc, host, event, live) {
  const entries = [
    ...scopedRows(doc, host, event).map((r) => ({ kind: 'row', id: r.id, cron: nonEmptyStrings(r.cron_match), units: nonEmptyStrings(r.units), declaredLines: r.cron_lines })),
    ...scopedExclusions(doc, host, event).map((e) => ({ kind: 'exclusion', id: e.id, cron: nonEmptyStrings(e.cron_match), units: nonEmptyStrings(e.units) })),
  ];
  const lineHits = new Map(entries.map((e) => [e.id, 0]));
  const unitHits = new Map(entries.map((e) => [e.id, 0]));
  const unmappedLines = [];
  const unmappedUnits = [];
  const lines = live.crontab == null ? null : activeCronLines(live.crontab);
  for (const line of lines || []) {
    const hit = entries.find((e) => e.cron.some((m) => line.includes(m)));
    if (hit) lineHits.set(hit.id, lineHits.get(hit.id) + 1); else unmappedLines.push(line);
  }
  const units = live.units == null ? null : String(live.units).split('\n').map((u) => u.trim()).filter(Boolean);
  for (const u of units || []) {
    const hit = entries.find((e) => e.units.some((g) => globToRe(g).test(u)));
    if (hit) unitHits.set(hit.id, unitHits.get(hit.id) + 1); else unmappedUnits.push(u);
  }
  // Declared-but-not-live and fan-out drift are REPORTED, never failed: a row may legitimately
  // cover a job scheduled elsewhere (a weekly line on a quiet day still exists), and a fan-out
  // count is an instrument reading the gate prints so a stale one is seen and re-derived.
  const fanout = entries.filter((e) => e.kind === 'row' && lines && typeof e.declaredLines === 'number'
    && e.cron.length && lineHits.get(e.id) !== e.declaredLines)
    .map((e) => `${e.id}: cron_lines=${e.declaredLines}, live=${lineHits.get(e.id)}`);
  const unmatchedEntries = entries.filter((e) => (lines ? lineHits.get(e.id) : 0) + (units ? unitHits.get(e.id) : 0) === 0)
    .map((e) => e.id);
  return {
    supplied: { crontab: lines !== null, units: units !== null },
    lines: lines ? lines.length : 0,
    units: units ? units.length : 0,
    unmappedLines, unmappedUnits, fanout, unmatchedEntries,
    lineHits: Object.fromEntries(lineHits), unitHits: Object.fromEntries(unitHits),
  };
}

/** The monitoring inventory: every host install, with its per-host schedule. */
export const INVENTORY_REL = 'ops/monitoring/monitoring-inventory.json';
/** The registry block of knowingly-unclassified scheduled installs, per host. Shrink-only. */
export const INVENTORY_DEBT_KEY = '_inventory_reboot_debt';
/** A 5-field cron schedule: five whitespace-separated fields of digits, names, `*`, `,`, `/`, `-`. */
export const CRON_SCHEDULE_RE = /^\s*[0-9A-Za-z*,/-]+(\s+[0-9A-Za-z*,/-]+){4}\s*$/;

/** The inventory, or null when it cannot be read or parsed (INDETERMINATE at the caller). */
export function loadInventory(root) {
  const p = path.join(root, INVENTORY_REL);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    return doc && Array.isArray(doc.artifacts) ? doc : null;
  } catch { return null; }
}

/**
 * Every scheduled install the inventory declares on `host`, as the crontab line it implies. Keyed on
 * `installed_at[].host` — never the top-level `host`, which mixes IPs and labels. An entry's own
 * `schedule` / `install_state` override the row's. A null schedule is "not scheduled"; a schedule (or
 * path) that cannot be read as a cron install is returned in `unparseable`, never dropped.
 */
export function inventoryInstalls(inv, host) {
  const installs = [];
  const unparseable = [];
  for (const a of inv.artifacts) {
    if (!a || !Array.isArray(a.installed_at)) continue;
    for (const e of a.installed_at) {
      if (!e || e.host !== host) continue;
      const state = e.install_state ?? a.install_state;
      if (state !== 'installed') continue;
      const sched = Object.prototype.hasOwnProperty.call(e, 'schedule') ? e.schedule : a.schedule;
      if (sched == null) continue;
      const p = typeof e.path === 'string' ? e.path.trim() : '';
      if (typeof sched !== 'string' || !CRON_SCHEDULE_RE.test(sched) || !p) {
        unparseable.push(`${a.id}: schedule=${JSON.stringify(sched)} path=${JSON.stringify(e.path ?? null)}`);
        continue;
      }
      installs.push({ id: a.id, line: `${sched.trim()} ${p}` });
    }
  }
  return { installs, unparseable };
}

/**
 * The inventory cross-check for one REBOOT-scope host. The synthesized lines go through the SAME
 * `liveCoverage()` as the live crontab — never a second matcher — and only its unmapped lines count.
 * Returns `{ indeterminate }` for a corpus that cannot be judged, else the per-id findings.
 */
export function inventoryCoverage(doc, inv, host) {
  const { installs, unparseable } = inventoryInstalls(inv, host);
  if (unparseable.length) {
    return { indeterminate: `${INVENTORY_REL} declares install(s) on ${host} whose schedule or path is not a cron install: ${unparseable.join('; ')}` };
  }
  // We build this join; zero installs on a reboot host means the join broke (an IP where a label
  // belongs, a renamed field), not that the host runs nothing.
  if (installs.length === 0) {
    return { indeterminate: `${INVENTORY_REL} declares ZERO scheduled installs on reboot host "${host}" — the installed_at[].host join is broken, not empty` };
  }
  const debt = doc[INVENTORY_DEBT_KEY] && doc[INVENTORY_DEBT_KEY][host];
  if (!debt || typeof debt !== 'object' || !Array.isArray(debt.ids) || typeof debt.count !== 'number') {
    return { indeterminate: `${INVENTORY_DEBT_KEY} declares no { count, ids } block for reboot host "${host}" — an explicit empty list is required, never implied` };
  }
  const lineOf = new Map();
  for (const i of installs) lineOf.set(i.line, [...(lineOf.get(i.line) || []), i.id]);
  const cov = liveCoverage(doc, host, REBOOT_EVENT, { crontab: installs.map((i) => i.line).join('\n'), units: null });
  const unmapped = new Map();
  for (const l of cov.unmappedLines) for (const id of lineOf.get(l) || [`<unattributed: ${l}>`]) unmapped.set(id, l);
  const installedIds = new Set(installs.map((i) => i.id));
  const listed = debt.ids.filter((s) => typeof s === 'string');
  const unclassified = [...unmapped.keys()].filter((id) => !listed.includes(id)).sort()
    .map((id) => ({ id, line: unmapped.get(id) }));
  const nowClassified = listed.filter((id) => installedIds.has(id) && !unmapped.has(id)).sort();
  const notInstalled = listed.filter((id) => !installedIds.has(id)).sort();
  const debtDrift = [];
  if (debt.count !== listed.length || listed.length !== debt.ids.length) {
    debtDrift.push(`${INVENTORY_DEBT_KEY}["${host}"].count = ${debt.count} but ids lists ${debt.ids.length}`);
  }
  if (listed.length && !(typeof debt.reason === 'string' && debt.reason.trim())) {
    debtDrift.push(`${INVENTORY_DEBT_KEY}["${host}"] lists ${listed.length} id(s) with no reason — debt is declared, never silent`);
  }
  return {
    installs: installs.length,
    unmapped: unmapped.size,
    debt: listed.length,
    unclassified,
    nowClassified,
    notInstalled,
    debtDrift,
    fail: unclassified.length + nowClassified.length + notInstalled.length + debtDrift.length,
  };
}

/**
 * The whole decision, as data. Separated from I/O so the self-test can drive it against a fixture
 * tree — and so a caller can see WHY, not only WHAT.
 */
export function evaluate(root, host = REPO_CRON_HOST, event = null, live = null) {
  const files = cronFiles(root);
  const doc = loadRegistry(root);
  const ev = event || (host === REPO_CRON_HOST ? 'deploy' : REBOOT_EVENT);
  const out = (o) => ({ host, event: ev, ...o });

  // ── VACUITY GUARD 1 — the glob broke, which is not "the tree is clean". ────────────────────
  if (files.length === 0) {
    return out({ verdict: 'INDETERMINATE', reason: `no ${CRON_DIR}/*.sh found — the glob is broken, not the tree` });
  }
  // ── VACUITY GUARD 2 — no registry at all. ─────────────────────────────────────────────────
  if (doc === null) {
    return out({ verdict: 'INDETERMINATE', reason: `${REGISTRY_REL} is missing or unparseable — never "nothing is registered"` });
  }
  // A registry WE author is a CONSTRUCTED corpus, so an empty declaration is vacuity and refuses.
  if (doc.rows.length === 0) {
    return out({ verdict: 'INDETERMINATE', reason: `${REGISTRY_REL} declares zero rows — we build this corpus, so empty means it was not built` });
  }

  // ── VACUITY GUARD 4 — an unknown host, or a host with no rows. ─────────────────────────────
  // A consumer asking about a host the registry has never heard of must get INDETERMINATE, never
  // a PASS over an empty selection — that is precisely how a gate ends up certifying a host it
  // cannot see. Same reasoning as GUARD 2 one level down.
  const hostRows = doc.rows.filter((r) => r && r.host === host);
  if (hostRows.length === 0) {
    return out({
      verdict: 'INDETERMINATE',
      reason: `no registry row declares host "${host}" (declared: ${declaredHosts(doc).join(', ') || '— none —'}) `
        + '— an unknown host is never an empty PASS',
    });
  }
  // ── VACUITY GUARD 6 — the host's events, and this event among them. ───────────────────────
  const evs = hostEvents(doc, host);
  if (!evs) {
    return out({ verdict: 'INDETERMINATE', reason: `_disruption_events declares no events for host "${host}" — a row cannot be scoped to an event nobody declared` });
  }
  if (!evs.includes(ev)) {
    return out({ verdict: 'INDETERMINATE', reason: `host "${host}" declares events [${evs.join(', ')}], not "${ev}" — an undeclared event is never an empty PASS` });
  }
  // ── A row on a REBOOT-eligible host that is not classified for the reboot. ────────────────
  // A reboot kills everything a deploy kills, so "classified for deploy, silent about reboot" is
  // an unanswered question about a job the reboot WILL kill. Unanswered is INDETERMINATE.
  if (ev === REBOOT_EVENT) {
    const unclassified = hostRows.filter((r) => !Array.isArray(r.events) || !r.events.includes(REBOOT_EVENT))
      .map((r) => (r && r.id) || '<unnamed>');
    if (unclassified.length) {
      return out({ verdict: 'INDETERMINATE', reason: `row(s) on reboot-eligible host "${host}" carry NO reboot classification: ${unclassified.join(', ')} — nobody has said what a reboot costs them` });
    }
  }
  // ── VACUITY GUARD 5 — the per-(host, event) blocks the CONSUMERS read must exist. ──────────
  for (const block of ['_enumeration', '_residual_no_safe_kill']) {
    const b = doc[block] && doc[block][host];
    if (!b || typeof b !== 'object' || !b[ev] || typeof b[ev] !== 'object') {
      return out({ verdict: 'INDETERMINATE', reason: `${block} declares no block for host "${host}" event "${ev}" — the reboot gate and the deploy-free-window ruling both read it` });
    }
  }
  const scoped = scopedRows(doc, host, ev);
  if (scoped.length === 0) {
    return out({ verdict: 'INDETERMINATE', reason: `host "${host}" declares event "${ev}" but no row is scoped to it — an empty scope is never a PASS` });
  }

  // ── the repo-side corpus check — signal-1's DEPLOY scope only, and that is a FACT. ─────────
  // `ops/cron/*.sh` is signal-1's committed cron tree, and the question it answers is "does it
  // `docker exec`" — a DEPLOY question. The REBOOT scope is answered against the LIVE crontab.
  const ownsRepoCron = host === REPO_CRON_HOST && ev === 'deploy';
  const candidates = ownsRepoCron ? cronCandidates(root) : [];
  // ── VACUITY GUARD 3 — wrappers exist and NOT ONE execs, so the matcher stopped working. ────
  if (ownsRepoCron && candidates.length === 0) {
    return out({ verdict: 'INDETERMINATE', reason: `not one of ${files.length} ${CRON_DIR}/*.sh matched a command-position \`docker exec\` — the matcher is broken, not the tree` });
  }

  const byScript = new Map();
  for (const r of scoped) if (r && typeof r.script === 'string') byScript.set(r.script, r);
  const unregistered = candidates.filter((c) => !byScript.has(c.rel)).map((c) => c.rel);

  // A row with NO `host` is invisible to every per-host selection, so it is reported against
  // EVERY host — deleting the field would otherwise silently drop a job from every check.
  const hostless = doc.rows
    .map((r, i) => (r && typeof r.host === 'string' && r.host.trim() ? null
      : { id: (r && r.id) || `<row ${i}>`, why: 'declares no `host` — it would be invisible to every per-host consumer' }))
    .filter(Boolean);

  const unusable = hostless.concat(hostRows.map((r, i) => {
    const id = (r && typeof r.id === 'string' && r.id.trim()) || `<row ${i}>`;
    const events = r && r.events;
    if (!Array.isArray(events) || events.length === 0) return { id, why: 'declares no `events` — a row must say which disruption it is classified for, never inherit a default' };
    const bad = events.filter((e) => !VALID_EVENTS.has(e) || !evs.includes(e));
    if (bad.length) return { id, why: `events [${bad.join(', ')}] are unknown or not declared for host ${host}` };
    if (!events.includes(ev)) return null;
    const cls = (typeof r.class === 'string' && r.class.trim()) || '';
    const reason = (typeof r.reason === 'string' && r.reason.trim()) || '';
    if (!VALID_CLASSES.has(cls)) return { id, why: `class ${cls ? `"${cls}"` : '<missing>'} is not one of ${[...VALID_CLASSES].join(' | ')}` };
    if (!reason) return { id, why: 'reason is missing or empty — INDETERMINATE, never a silent safe-to-kill' };
    return null;
  }).filter(Boolean));

  // ── the ruling must match its evidence, per (host, event) ─────────────────────────────────
  const actualNsk = scoped.filter((r) => r.class === 'no-safe-kill').map((r) => r.id).sort();
  const declared = doc._residual_no_safe_kill[host][ev];
  const declaredIds = Array.isArray(declared.ids) ? [...declared.ids].sort() : null;
  const rulingDrift = [];
  if (declared.count !== actualNsk.length) {
    rulingDrift.push(`_residual_no_safe_kill["${host}"]["${ev}"].count = ${declared.count} but ${actualNsk.length} row(s) are class no-safe-kill`);
  }
  if (declaredIds === null || declaredIds.join('|') !== actualNsk.join('|')) {
    rulingDrift.push(`_residual_no_safe_kill["${host}"]["${ev}"].ids = [${declaredIds ? declaredIds.join(', ') : '<not an array>'}] but the rows say [${actualNsk.join(', ')}]`);
  }

  // ── the INVENTORY cross-check (REBOOT scope) — a declared corpus, through the same matcher ──
  let inventory = null;
  if (ev === REBOOT_EVENT) {
    const inv = loadInventory(root);
    if (inv === null) {
      return out({ verdict: 'INDETERMINATE', reason: `${INVENTORY_REL} is missing or unparseable — the REBOOT scope cannot be checked against the declared installs` });
    }
    inventory = inventoryCoverage(doc, inv, host);
    if (inventory.indeterminate) return out({ verdict: 'INDETERMINATE', reason: inventory.indeterminate });
  }

  // ── the LIVE population (REBOOT scope only) ───────────────────────────────────────────────
  let liveResult = null;
  if (live && (live.crontab != null || live.units != null)) {
    if (ev !== REBOOT_EVENT) {
      return out({ verdict: 'INDETERMINATE', reason: `--crontab/--units check the REBOOT scope; event "${ev}" is answered by the repo corpus` });
    }
    liveResult = liveCoverage(doc, host, ev, live);
    if (liveResult.supplied.crontab && liveResult.lines === 0) {
      return out({ verdict: 'INDETERMINATE', reason: 'the supplied crontab has ZERO active lines — a live host always has some, so the input is broken, not empty' });
    }
    if (liveResult.supplied.units && liveResult.units === 0) {
      return out({ verdict: 'INDETERMINATE', reason: 'the supplied unit list is EMPTY — a live host always runs some, so the input is broken, not empty' });
    }
  }
  const liveFail = liveResult ? liveResult.unmappedLines.length + liveResult.unmappedUnits.length : 0;

  return out({
    verdict: unregistered.length || unusable.length || rulingDrift.length || liveFail || (inventory && inventory.fail) ? 'FAIL' : 'PASS',
    ownsRepoCron,
    files: files.map((f) => f.rel),
    candidates: candidates.map((c) => c.rel),
    rows: scoped.length,
    classes: scoped.reduce((a, r) => ({ ...a, [r.class]: (a[r.class] || 0) + 1 }), {}),
    unregistered,
    unusable,
    rulingDrift,
    inventory,
    live: liveResult,
  });
}

function emit(r) {
  const tag = `${r.host} · ${r.event}`;
  if (r.verdict === 'INDETERMINATE') {
    console.log(`cron-interlock-coverage [${tag}]: INDETERMINATE — ${r.reason}`);
    return 3;
  }
  // POSITIVE PER-ITEM OUTPUT: a wrapper silently skipped must never read like one that passed.
  const cls = Object.entries(r.classes).map(([k, v]) => `${v} ${k}`).join(' · ');
  console.log(`cron-interlock-coverage [${tag}]: ${r.rows} registry row(s) — ${cls}`);
  if (r.ownsRepoCron) {
    console.log(`  repo cron corpus: ${r.files.length} ${CRON_DIR}/*.sh, ${r.candidates.length} with a command-position \`docker exec\``);
    for (const f of r.files) {
      const isCandidate = r.candidates.includes(f);
      const glyph = !isCandidate ? '·' : (r.unregistered.includes(f) ? '✗' : '✓');
      const state = !isCandidate ? 'no docker exec' : (r.unregistered.includes(f) ? 'UNREGISTERED' : 'registered');
      console.log(`    ${glyph} ${f.padEnd(46)} ${state}`);
    }
  } else if (r.event === REBOOT_EVENT) {
    console.log(`  repo cron corpus: not the question for a reboot — the ${r.host} REBOOT scope is checked against its LIVE crontab and units (--crontab / --units).`);
  } else {
    console.log(`  repo cron corpus: none — ${CRON_DIR}/*.sh belongs to ${REPO_CRON_HOST}; every ${r.host} row is source: host-only.`);
    console.log('    That is a FACT about this host, not an unchecked gap: see the declared limitation below.');
  }
  if (r.inventory) {
    const I = r.inventory;
    console.log(`  inventory cross-check: ${I.installs} scheduled install(s) on ${r.host} in ${INVENTORY_REL}, ${I.unmapped} unmapped`
      + ` — ${I.debt} declared in ${INVENTORY_DEBT_KEY}["${r.host}"], ${I.unclassified.length} unclassified`);
  }
  if (r.event === REBOOT_EVENT) {
    if (!r.live) {
      console.log('  live population: NOT SUPPLIED — run with --crontab <file|-> [--units <file>] on or from the host (kernel-auto-reboot.sh does so on every signal-1 run; aoe-1\'s harness declares no population check — its rows carry no cron_match/units)');
    } else {
      const L = r.live;
      console.log(`  live population: crontab ${L.supplied.crontab ? `${L.lines} active line(s), ${L.unmappedLines.length} unmapped` : 'not supplied'} · units ${L.supplied.units ? `${L.units}, ${L.unmappedUnits.length} unmapped` : 'not supplied'}`);
      for (const f of L.fanout) console.log(`    · fan-out differs (reported, re-derive it): ${f}`);
      if (L.unmatchedEntries.length) console.log(`    · declared but matching nothing live (reported): ${L.unmatchedEntries.join(', ')}`);
    }
  }
  console.log(`  residual no-safe-kill: ${r.rulingDrift.length ? 'DRIFTED' : 'matches the rows'}`);
  if (r.verdict === 'FAIL') {
    console.log('');
    for (const f of r.unregistered) {
      console.log(`  ✗ ${f} runs \`docker exec\` but has no row in ${REGISTRY_REL} for host ${r.host} —`);
      console.log('      add one with { id, host, events, script, container, process_pattern, cron_match, class, reason, max_runtime_s, runtime_instrument, source, verified_at }.');
      console.log('      MEASURE max_runtime_s; do not estimate it, and record the instrument beside the number.');
    }
    for (const u of r.unusable) console.log(`  ✗ registry row "${u.id}" is unusable: ${u.why}`);
    for (const d of r.rulingDrift) console.log(`  ✗ ${d}`);
    if (r.inventory) {
      for (const u of r.inventory.unclassified) {
        console.log(`  ✗ inventory install has no ${r.event} classification: ${u.id} (${u.line.slice(0, 140)}) —`);
        console.log('      add a REBOOT-scope row whose cron_match names its installed path, with a MEASURED max_runtime_s.');
      }
      for (const id of r.inventory.nowClassified) console.log(`  ✗ ${INVENTORY_DEBT_KEY}["${r.host}"] still lists ${id}, which is now classified — remove it (the list only shrinks)`);
      for (const id of r.inventory.notInstalled) console.log(`  ✗ ${INVENTORY_DEBT_KEY}["${r.host}"] lists ${id}, which is no longer a scheduled install on ${r.host} — remove it`);
      for (const d of r.inventory.debtDrift) console.log(`  ✗ ${d}`);
    }
    if (r.live) {
      for (const l of r.live.unmappedLines) console.log(`  ✗ live crontab line has no ${r.event} classification: ${l.slice(0, 160)}`);
      for (const u of r.live.unmappedUnits) console.log(`  ✗ live unit has no ${r.event} classification: ${u}`);
    }
    return 1;
  }
  return 0;
}

/** Check every declared (host, event) by default, or narrow. ONE terminal token over all of them. */
export function run(root, only = null, onlyEvent = null, live = null) {
  const doc = loadRegistry(root);
  const hosts = only ? [only] : (doc ? declaredHosts(doc) : [REPO_CRON_HOST]);
  const codes = [];
  for (const h of hosts.length ? hosts : [REPO_CRON_HOST]) {
    const evs = onlyEvent ? [onlyEvent] : ((doc && hostEvents(doc, h)) || [null]);
    for (const e of evs) codes.push(emit(evaluate(root, h, e, live)));
  }
  // Worst wins, and INDETERMINATE outranks FAIL: "we could not tell" must never be reported as
  // the weaker, more specific "we told, and it was wrong".
  const code = codes.includes(3) ? 3 : (codes.includes(1) ? 1 : 0);
  console.log('  (declared limitation: a build-time gate cannot see host-only crons directly — every scheduled'
    + ` install declared in ${INVENTORY_REL} is checked through the inventory cross-check above; a crontab line with`
    + ' NO inventory row stays invisible here and is caught only by the live check kernel-auto-reboot.sh runs on the host)');
  console.log(`CRON_INTERLOCK_COVERAGE_VERDICT=${code === 3 ? 'INDETERMINATE' : code === 1 ? 'FAIL' : 'PASS'}`);
  return code;
}


// ─────────────────────────────── self-test ───────────────────────────────

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function fixture(spec) {
  const root = mkdtempSync(path.join(tmpdir(), 'croncov-'));
  mkdirSync(path.join(root, CRON_DIR), { recursive: true });
  mkdirSync(path.join(root, 'ops/scripts'), { recursive: true });
  for (const [rel, body] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** The events a fixture host declares — signal-1 has both, every other host reboot only. */
const fixtureEvents = (h) => (h === REPO_CRON_HOST ? ['deploy', 'reboot'] : ['reboot']);

const row = (over = {}) => ({
  id: 'a', host: REPO_CRON_HOST, events: ['deploy', 'reboot'], script: `${CRON_DIR}/a.sh`, container: 'ctr',
  process_pattern: 'p', cron_match: ['dist/scripts/a'], class: 'safe-to-kill', reason: 'idempotent on next fire',
  max_runtime_s: 1, runtime_instrument: 'timed run', source: 'repo', verified_at: '2026-08-29', ...over,
});
/**
 * A fixture registry in the PER-(HOST, EVENT) shape the real one uses. `_enumeration` and
 * `_residual_no_safe_kill` are derived from the rows here rather than hand-written, so a fixture
 * can never accidentally encode the ruling-drift the gate exists to catch — the drift cases below
 * inject it deliberately instead.
 */
const registry = (rows, over = {}) => {
  const hosts = [...new Set(rows.map((r) => r.host).filter(Boolean))];
  const doc = { schema_version: 2, rows, exclusions: [], _disruption_events: {}, _enumeration: {}, _residual_no_safe_kill: {}, [INVENTORY_DEBT_KEY]: {} };
  for (const h of hosts) {
    doc._disruption_events[h] = fixtureEvents(h);
    doc._enumeration[h] = {};
    doc._residual_no_safe_kill[h] = {};
    if (fixtureEvents(h).includes(REBOOT_EVENT)) doc[INVENTORY_DEBT_KEY][h] = { count: 0, ids: [], reason: '' };
    for (const e of fixtureEvents(h)) {
      const nsk = rows.filter((r) => r.host === h && Array.isArray(r.events) && r.events.includes(e) && r.class === 'no-safe-kill').map((r) => r.id);
      doc._enumeration[h][e] = { host: h, command: 'fixture' };
      doc._residual_no_safe_kill[h][e] = { count: nsk.length, ids: nsk };
    }
  }
  return JSON.stringify({ ...doc, ...over });
};

function selfTest() {
  let checks = 0; let fails = 0;
  const roots = [];
  const ck = (label, actual, expected) => {
    checks += 1;
    if (actual !== expected) { fails += 1; console.log(`  ✗ ${label}: got ${actual}, want ${expected}`); }
    else console.log(`  ✓ ${label}`);
  };
  // Every fixture tree gets an inventory unless the case supplies its own: one scheduled install per
  // fixture host, at a path the default row's cron_match ('dist/scripts/a') maps.
  const inventory = (artifacts) => JSON.stringify({ schema_version: 1, artifacts });
  const install = (over = {}) => ({ id: 'a-job', install_state: 'installed', schedule: '5 * * * *',
    installed_at: [{ host: REPO_CRON_HOST, path: '/opt/fx/dist/scripts/a.js' }, { host: 'aoe-1', path: '/opt/fx/dist/scripts/a.js' }], ...over });
  const DEFAULT_INV = inventory([install()]);
  const v = (spec, host, event, live) => {
    const root = fixture({ [INVENTORY_REL]: DEFAULT_INV, ...spec }); roots.push(root); return evaluate(root, host, event, live).verdict;
  };
  const EXEC = { [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node x.js\n' };

  // ── the happy path, and the failure it exists to produce ────────────────────────────────
  ck('an exec\'ing wrapper WITH a row -> PASS', v({ ...EXEC, [REGISTRY_REL]: registry([row()]) }), 'PASS');

  ck('an exec\'ing wrapper with NO row -> FAIL', v({
    ...EXEC,
    [`${CRON_DIR}/b.sh`]: '#!/usr/bin/env bash\ndocker exec ctr node y.js\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'FAIL');

  ck('a wrapper that does NOT exec needs no row -> PASS', v({
    ...EXEC,
    [`${CRON_DIR}/plain.sh`]: '#!/usr/bin/env bash\ncurl -s https://example.test\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'PASS');

  // ── a mention is not an invocation, in BOTH of its real shapes ──────────────────────────
  ck('a `docker exec` in a # COMMENT is not an invocation', v({
    ...EXEC,
    [`${CRON_DIR}/prose.sh`]: '#!/usr/bin/env bash\n# this USED to run `docker exec ctr node old.js` and no longer does\ntrue\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'PASS');

  ck('a `docker exec` MID-SENTENCE in an alert body is not an invocation', v({
    ...EXEC,
    [`${CRON_DIR}/alert.sh`]: '#!/usr/bin/env bash\nBODY="Common causes: host dist/ unusable AND docker exec failed."\necho "$BODY"\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'PASS');

  // …and the COMMAND POSITIONS that must still be caught, or the exclusion above is a hole.
  for (const [label, line] of [
    ['start of line', 'docker exec ctr node x.js'],
    ['after `exec`', 'exec docker exec ctr node x.js'],
    ['inside $( )', 'OUT=$(docker exec ctr node x.js)'],
    ['after a pipe', 'true | docker exec ctr node x.js'],
    ['after a semicolon', 'true ; docker exec ctr node x.js'],
    ['via sudo', 'sudo docker exec ctr node x.js'],
  ]) {
    ck(`a REAL invocation ${label} still counts`, v({
      [`${CRON_DIR}/b.sh`]: `#!/usr/bin/env bash\n${line}\n`,
      [REGISTRY_REL]: registry([row()]),
    }), 'FAIL');
  }

  // ── the unusable-row rules ─────────────────────────────────────────────────────────────
  ck('an EMPTY reason -> FAIL (INDETERMINATE at the interlock, never a silent pass)', v({
    ...EXEC, [REGISTRY_REL]: registry([row({ reason: '   ' })]),
  }), 'FAIL');
  ck('a MISSING reason -> FAIL', v({
    ...EXEC, [REGISTRY_REL]: registry([{ id: 'a', host: REPO_CRON_HOST, events: ['deploy', 'reboot'], script: `${CRON_DIR}/a.sh`, class: 'safe-to-kill' }]),
  }), 'FAIL');
  ck('an UNKNOWN class -> FAIL', v({ ...EXEC, [REGISTRY_REL]: registry([row({ class: 'probably-fine' })]) }), 'FAIL');
  ck('a HOST-ONLY row is checked for a reason too', v({
    ...EXEC, [REGISTRY_REL]: registry([row(), row({ id: 'h', script: 'crontab inline', source: 'host-only', reason: '' })]),
  }), 'FAIL');
  ck('all three classes are accepted', v({
    ...EXEC,
    [REGISTRY_REL]: registry([
      row(),
      row({ id: 'b', script: 'x', class: 'preempt-and-catchup' }),
      row({ id: 'c', script: 'y', class: 'no-safe-kill' }),
    ]),
  }), 'PASS');

  // ── the vacuity guards, each demonstrated ──────────────────────────────────────────────
  ck('GUARD 1 — no ops/cron/*.sh at all -> INDETERMINATE', v({ [REGISTRY_REL]: registry([row()]) }), 'INDETERMINATE');
  ck('GUARD 2 — a MISSING registry -> INDETERMINATE, never "nothing is registered"', v({ ...EXEC }), 'INDETERMINATE');
  ck('GUARD 2b — an UNPARSEABLE registry -> INDETERMINATE', v({ ...EXEC, [REGISTRY_REL]: 'not json at all' }), 'INDETERMINATE');
  ck('GUARD 2c — an EMPTY rows[] is vacuity (we build this corpus) -> INDETERMINATE', v({ ...EXEC, [REGISTRY_REL]: registry([]) }), 'INDETERMINATE');
  ck('GUARD 3 — wrappers exist but NOT ONE execs -> INDETERMINATE (the matcher broke)', v({
    [`${CRON_DIR}/a.sh`]: '#!/usr/bin/env bash\ncurl -s https://example.test\n',
    [`${CRON_DIR}/b.sh`]: '#!/usr/bin/env bash\necho hi\n',
    [REGISTRY_REL]: registry([row()]),
  }), 'INDETERMINATE');

  // ── the token -> exit-code MAPPING, not just the token ────────────────────────────────
  const codeOf = (verdict) => {
    const orig = console.log; console.log = () => {};
    try {
      return emit(verdict === 'INDETERMINATE' ? { verdict, host: 'h', event: 'deploy', reason: 'x' }
        : { verdict, host: 'h', event: 'deploy', ownsRepoCron: true, files: ['f'], candidates: [], rows: 1, classes: {}, unregistered: verdict === 'FAIL' ? ['f'] : [], unusable: [], rulingDrift: [], live: null });
    } finally { console.log = orig; }
  };
  ck('PASS maps to exit 0', codeOf('PASS'), 0);
  ck('FAIL maps to exit 1', codeOf('FAIL'), 1);
  ck('INDETERMINATE maps to exit 3, the token-law default for a new gate', codeOf('INDETERMINATE'), 3);

  // ── HOST SCOPING (OPS-HOST-AUTO-REBOOT-W1) ────────────────────────────────────────────────
  ck('a row with NO host is REPORTED, never silently dropped from every selection', v({
    ...EXEC, [REGISTRY_REL]: registry([row(), { id: 'ghost', events: ['deploy'], script: 'x', class: 'safe-to-kill', reason: 'stated' }]),
  }), 'FAIL');
  ck('an UNKNOWN host is INDETERMINATE, never an empty PASS', v({ ...EXEC, [REGISTRY_REL]: registry([row()]) }, 'mars-1'), 'INDETERMINATE');
  ck('a host with rows but NO _residual_no_safe_kill block is INDETERMINATE', v({
    ...EXEC, [REGISTRY_REL]: registry([row()], { _residual_no_safe_kill: {} }),
  }), 'INDETERMINATE');
  ck('a NON-repo-cron host needs no repo corpus and still PASSES', v({
    ...EXEC, [REGISTRY_REL]: registry([row(), row({ id: 'h1', host: 'aoe-1', events: ['reboot'], script: 'host-only', source: 'host-only' })]),
  }, 'aoe-1', 'reboot'), 'PASS');
  ck("…and its rows are STILL checked for a reason (a host-only row is not exempt)", v({
    ...EXEC, [REGISTRY_REL]: registry([row(), row({ id: 'h1', host: 'aoe-1', events: ['reboot'], script: 'host-only', source: 'host-only', reason: '  ' })]),
  }, 'aoe-1', 'reboot'), 'FAIL');
  ck('a row on ANOTHER host cannot satisfy this host\'s repo corpus', v({
    ...EXEC, [REGISTRY_REL]: registry([row({ host: 'aoe-1', events: ['reboot'] }), row({ id: 'z', script: 'other' })]),
  }), 'FAIL');
  // THE RULING MUST MATCH ITS EVIDENCE — per (host, event).
  ck('a _residual_no_safe_kill COUNT that disagrees with the rows -> FAIL', v({
    ...EXEC, [REGISTRY_REL]: registry([row()], { _residual_no_safe_kill: { [REPO_CRON_HOST]: { deploy: { count: 1, ids: [] }, reboot: { count: 0, ids: [] } } } }),
  }), 'FAIL');
  ck('…and disagreeing IDS -> FAIL too', v({
    ...EXEC, [REGISTRY_REL]: registry([row({ class: 'no-safe-kill' })], { _residual_no_safe_kill: { [REPO_CRON_HOST]: { deploy: { count: 1, ids: ['something-else'] }, reboot: { count: 1, ids: ['a'] } } } }),
  }), 'FAIL');
  ck('…and the REBOOT residual is checked on its own, not borrowed from the deploy one', v({
    ...EXEC, [REGISTRY_REL]: registry([row({ class: 'no-safe-kill' })], { _residual_no_safe_kill: { [REPO_CRON_HOST]: { deploy: { count: 1, ids: ['a'] }, reboot: { count: 0, ids: [] } } } }),
  }, REPO_CRON_HOST, 'reboot'), 'FAIL');

  // ── EVENT SCOPE (OPS-HOST-AUTO-REBOOT-SIGNAL1-PROMOTE-W1) ─────────────────────────────────
  ck('AC1.2(b) — a row on a REBOOT-eligible host with no reboot classification -> INDETERMINATE', v({
    ...EXEC, [REGISTRY_REL]: registry([row(), row({ id: 'deploy-only', script: 'q', events: ['deploy'] })]),
  }, REPO_CRON_HOST, 'reboot'), 'INDETERMINATE');
  ck('…while the DEPLOY scope of the same registry still decides (the deploy question is answered)', v({
    ...EXEC, [REGISTRY_REL]: registry([row(), row({ id: 'deploy-only', script: 'q', events: ['deploy'] })]),
  }, REPO_CRON_HOST, 'deploy'), 'PASS');
  ck('a row with NO events array is unusable — never a default scope', v({
    ...EXEC, [REGISTRY_REL]: registry([row(), row({ id: 'noev', script: 'q', events: undefined })]),
  }, REPO_CRON_HOST, 'deploy'), 'FAIL');
  ck('a row naming an event its host does not declare is unusable', v({
    ...EXEC, [REGISTRY_REL]: registry([row(), row({ id: 'h2', host: 'aoe-1', events: ['reboot', 'deploy'], script: 'host-only', source: 'host-only' })]),
  }, 'aoe-1', 'reboot'), 'FAIL');
  ck('a host with NO _disruption_events is INDETERMINATE', v({
    ...EXEC, [REGISTRY_REL]: registry([row()], { _disruption_events: {} }),
  }), 'INDETERMINATE');
  ck('asking for an event the host does not declare is INDETERMINATE', v({
    ...EXEC, [REGISTRY_REL]: registry([row(), row({ id: 'h1', host: 'aoe-1', events: ['reboot'], script: 'host-only', source: 'host-only' })]),
  }, 'aoe-1', 'deploy'), 'INDETERMINATE');
  ck('a missing per-EVENT _enumeration block is INDETERMINATE', v({
    ...EXEC, [REGISTRY_REL]: registry([row()], { _enumeration: { [REPO_CRON_HOST]: { deploy: { command: 'x' } } } }),
  }, REPO_CRON_HOST, 'reboot'), 'INDETERMINATE');

  // ── the LIVE population (REBOOT scope) ─────────────────────────────────────────────────
  const LIVE_REG = registry([
    row(),
    row({ id: 'host-canary', script: '/opt/x/canary.py', source: 'host-only', events: ['reboot'], cron_match: ['/opt/x/canary.py'] }),
  ], { exclusions: [{ id: 'os-daemons', host: REPO_CRON_HOST, events: ['reboot'], units: ['systemd-*.service', 'cron.service'], reason: 'restarted by systemd at boot; no in-flight work', re_derivation_command: 'systemctl list-units' }] });
  const CRON_OK = '# m h dom mon dow\n*/5 * * * * docker exec ctr node dist/scripts/a.js\nMAILTO=""\n17 3 * * * /opt/x/canary.py >> /var/log/c.log 2>&1\n';
  ck('a live crontab whose every line maps -> PASS', v({ ...EXEC, [REGISTRY_REL]: LIVE_REG }, REPO_CRON_HOST, 'reboot', { crontab: CRON_OK }), 'PASS');
  ck('AC1.2(a) — an UNMAPPED live crontab line -> FAIL', v({ ...EXEC, [REGISTRY_REL]: LIVE_REG }, REPO_CRON_HOST, 'reboot',
    { crontab: `${CRON_OK}9 9 * * * /opt/new/unclassified-job.sh\n` }), 'FAIL');
  ck('a comment or an ENV line is not a job (never "unmapped")', v({ ...EXEC, [REGISTRY_REL]: LIVE_REG }, REPO_CRON_HOST, 'reboot',
    { crontab: `${CRON_OK}# 9 9 * * * /opt/new/commented-out.sh\nPATH=/usr/bin\n` }), 'PASS');
  ck('live units that map to an exclusion glob -> PASS', v({ ...EXEC, [REGISTRY_REL]: LIVE_REG }, REPO_CRON_HOST, 'reboot',
    { crontab: CRON_OK, units: 'systemd-journald.service\ncron.service\n' }), 'PASS');
  ck('an UNMAPPED live unit -> FAIL', v({ ...EXEC, [REGISTRY_REL]: LIVE_REG }, REPO_CRON_HOST, 'reboot',
    { crontab: CRON_OK, units: 'cron.service\nmystery-daemon.service\n' }), 'FAIL');
  ck('a DEPLOY-scope exclusion cannot excuse a REBOOT-scope line', v({ ...EXEC, [REGISTRY_REL]: registry([row()], {
    exclusions: [{ id: 'deploy-ex', host: REPO_CRON_HOST, events: ['deploy'], cron_match: ['/opt/new/job.sh'], reason: 'not a docker exec', re_derivation_command: 'grep' }],
  }) }, REPO_CRON_HOST, 'reboot', { crontab: '1 1 * * * docker exec ctr node dist/scripts/a.js\n2 2 * * * /opt/new/job.sh\n' }), 'FAIL');
  ck('a crontab with ZERO active lines is INDETERMINATE — the input broke, a live host has jobs', v({ ...EXEC, [REGISTRY_REL]: LIVE_REG }, REPO_CRON_HOST, 'reboot',
    { crontab: '# nothing\n\n' }), 'INDETERMINATE');
  ck('--crontab against the DEPLOY scope is INDETERMINATE (the deploy question is the repo corpus)', v({ ...EXEC, [REGISTRY_REL]: LIVE_REG }, REPO_CRON_HOST, 'deploy',
    { crontab: CRON_OK }), 'INDETERMINATE');
  ck('activeCronLines drops comments, blanks and ENV lines', activeCronLines('# c\n\nA=1\n* * * * * x\n').length, 1);
  ck('globToRe matches a whole unit name only', `${globToRe('getty@*.service').test('getty@tty1.service')}/${globToRe('cron.service').test('anacron.service')}`, 'true/false');

  // ── THE INVENTORY CROSS-CHECK (OPS-HOST-KERNEL-REBOOT-W6 B7) ─────────────────────────────
  const NEW_JOB = install({ id: 'new-job', schedule: '43 12 * * 1', installed_at: [{ host: REPO_CRON_HOST, path: '/opt/algovault-monitoring/new-job.py' }] });
  const INV_NEW = inventory([install(), NEW_JOB]);
  const debtFor = (ids, reason = 'declared fixture debt') => ({ [INVENTORY_DEBT_KEY]: { [REPO_CRON_HOST]: { count: ids.length, ids, reason } } });
  ck('B7 — a scheduled inventory install with NO reboot row -> FAIL (the W6 defect, at build time)', v({
    ...EXEC, [INVENTORY_REL]: INV_NEW, [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'reboot'), 'FAIL');
  ck('…and a row whose cron_match names its installed path -> PASS', v({
    ...EXEC, [INVENTORY_REL]: INV_NEW,
    [REGISTRY_REL]: registry([row(), row({ id: 'new-job', script: '/opt/algovault-monitoring/new-job.py', source: 'host-only', cron_match: ['/opt/algovault-monitoring/new-job.py'] })]),
  }, REPO_CRON_HOST, 'reboot'), 'PASS');
  ck('…the SAME install is FAIL even when the live crontab supplied alongside it maps fully', v({
    ...EXEC, [INVENTORY_REL]: INV_NEW, [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'reboot', { crontab: '1 1 * * * docker exec ctr node dist/scripts/a.js\n' }), 'FAIL');
  ck('…a DEPLOY-only exclusion cannot classify it — the cross-check uses liveCoverage\'s own scoping', v({
    ...EXEC, [INVENTORY_REL]: INV_NEW, [REGISTRY_REL]: registry([row()], {
      exclusions: [{ id: 'deploy-ex', host: REPO_CRON_HOST, events: ['deploy'], cron_match: ['/opt/algovault-monitoring/new-job.py'], reason: 'r', re_derivation_command: 'grep' }],
    }),
  }, REPO_CRON_HOST, 'reboot'), 'FAIL');
  ck('…the DEPLOY scope never runs the cross-check (a deploy is the repo-corpus question)', v({
    ...EXEC, [INVENTORY_REL]: INV_NEW, [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'deploy'), 'PASS');
  ck('RATCHET — the unclassified install LISTED as declared debt -> PASS', v({
    ...EXEC, [INVENTORY_REL]: INV_NEW, [REGISTRY_REL]: registry([row()], debtFor(['new-job'])),
  }, REPO_CRON_HOST, 'reboot'), 'PASS');
  ck('RATCHET — a listed id that is NOW classified -> FAIL (the list only shrinks)', v({
    ...EXEC, [INVENTORY_REL]: INV_NEW, [REGISTRY_REL]: registry([row(), row({ id: 'new-job', script: 'x', source: 'host-only', cron_match: ['/opt/algovault-monitoring/new-job.py'] })], debtFor(['new-job'])),
  }, REPO_CRON_HOST, 'reboot'), 'FAIL');
  ck('RATCHET — a listed id that is no longer installed -> FAIL', v({
    ...EXEC, [REGISTRY_REL]: registry([row()], debtFor(['gone-job'])),
  }, REPO_CRON_HOST, 'reboot'), 'FAIL');
  ck('RATCHET — a debt count that disagrees with its ids -> FAIL', v({
    ...EXEC, [INVENTORY_REL]: INV_NEW, [REGISTRY_REL]: registry([row()], { [INVENTORY_DEBT_KEY]: { [REPO_CRON_HOST]: { count: 2, ids: ['new-job'], reason: 'r' } } }),
  }, REPO_CRON_HOST, 'reboot'), 'FAIL');
  ck('RATCHET — a non-empty debt list with NO reason -> FAIL', v({
    ...EXEC, [INVENTORY_REL]: INV_NEW, [REGISTRY_REL]: registry([row()], debtFor(['new-job'], '  ')),
  }, REPO_CRON_HOST, 'reboot'), 'FAIL');
  ck('RATCHET — a REBOOT host with NO debt block -> INDETERMINATE (an empty list is explicit, never implied)', v({
    ...EXEC, [REGISTRY_REL]: registry([row()], { [INVENTORY_DEBT_KEY]: {} }),
  }, REPO_CRON_HOST, 'reboot'), 'INDETERMINATE');
  ck('an UNPARSEABLE inventory -> INDETERMINATE for the REBOOT scope', v({
    ...EXEC, [INVENTORY_REL]: 'not json', [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'reboot'), 'INDETERMINATE');
  ck('a schedule that is not a 5-field cron line -> INDETERMINATE, never skipped', v({
    ...EXEC, [INVENTORY_REL]: inventory([install(), install({ id: 'odd', schedule: 'hourly-ish', installed_at: [{ host: REPO_CRON_HOST, path: '/opt/x/odd.py' }] })]),
    [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'reboot'), 'INDETERMINATE');
  ck('a NULL schedule is "not scheduled" (a library) — no row is owed', v({
    ...EXEC, [INVENTORY_REL]: inventory([install(), install({ id: 'lib', schedule: null, installed_at: [{ host: REPO_CRON_HOST, path: '/opt/x/lib.py' }] })]),
    [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'reboot'), 'PASS');
  ck('an ENTRY schedule overrides the row\'s — an entry null un-schedules that host only', v({
    ...EXEC, [INVENTORY_REL]: inventory([install(), install({ id: 'lib2', installed_at: [{ host: REPO_CRON_HOST, path: '/opt/x/lib2.py', schedule: null }] })]),
    [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'reboot'), 'PASS');
  ck('an ENTRY install_state overrides the row\'s — a retired entry owes no row', v({
    ...EXEC, [INVENTORY_REL]: inventory([install(), install({ id: 'ret', installed_at: [{ host: REPO_CRON_HOST, path: '/opt/x/ret.py', install_state: 'retired' }] })]),
    [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'reboot'), 'PASS');
  ck('the join reads installed_at[].host LABELS — a top-level IP host still owes signal-1 a row', v({
    ...EXEC, [INVENTORY_REL]: inventory([install(), install({ id: 'ip-row', host: '204.168.185.24', installed_at: [{ host: REPO_CRON_HOST, path: '/opt/x/ip-row.sh' }] })]),
    [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'reboot'), 'FAIL');
  ck('ZERO scheduled installs on a REBOOT host -> INDETERMINATE (the join broke, not empty)', v({
    ...EXEC, [INVENTORY_REL]: inventory([install({ installed_at: [{ host: '204.168.185.24', path: '/opt/fx/dist/scripts/a.js' }] })]),
    [REGISTRY_REL]: registry([row()]),
  }, REPO_CRON_HOST, 'reboot'), 'INDETERMINATE');
  {
    const doc = JSON.parse(registry([row()]));
    const inv = JSON.parse(INV_NEW);
    const r = inventoryCoverage(doc, inv, REPO_CRON_HOST);
    ck('inventoryCoverage names the unclassified id AND its synthesized line',
      `${r.unclassified.map((u) => u.id).join(',')}|${r.unclassified[0] && r.unclassified[0].line}`,
      'new-job|43 12 * * 1 /opt/algovault-monitoring/new-job.py');
    ck('inventoryInstalls synthesizes "<schedule> <path>" per installed_at entry on the host',
      inventoryInstalls(inv, REPO_CRON_HOST).installs.map((i) => i.line).join(' ; '),
      '5 * * * * /opt/fx/dist/scripts/a.js ; 43 12 * * 1 /opt/algovault-monitoring/new-job.py');
  }

  // ── THE HERMETIC SEAM'S OWN BLIND SPOT ────────────────────────────────────────────────
  const realFiles = cronFiles(REPO);
  const realCandidates = cronCandidates(REPO);
  const realDoc = loadRegistry(REPO);
  ck('SEAM — the real ops/cron glob is non-empty', realFiles.length >= 10, true);
  ck('SEAM — the real tree has at least one command-position `docker exec`', realCandidates.length >= 1, true);
  ck('SEAM — the real registry loads with rows', Array.isArray(realDoc?.rows) && realDoc.rows.length >= 5, true);
  ck('SEAM — the real registry declares the carry-labeler row the interlock hardcodes',
    (realDoc?.rows || []).some((r) => r.id === 'carry-labeler' && r.class === 'preempt-and-catchup'), true);
  ck('the registry declares BOTH hosts', declaredHosts(realDoc || { rows: [] }).sort().join(','), 'aoe-1,signal-1');
  ck('SEAM — the real registry declares signal-1 deploy+reboot and aoe-1 reboot',
    `${(hostEvents(realDoc, 'signal-1') || []).join('+')}|${(hostEvents(realDoc, 'aoe-1') || []).join('+')}`, 'deploy+reboot|reboot');
  ck('SEAM — every REAL (host, event) evaluates to PASS',
    // NOT `(hostEvents(...) || []).every(...)`: [].every() is TRUE, so a registry declaring no
    // events would pass this vacuously — measured while writing it, against the pre-migration file.
    declaredHosts(realDoc).length > 0 && declaredHosts(realDoc).every((h) => {
      const evs = hostEvents(realDoc, h);
      return Array.isArray(evs) && evs.length > 0 && evs.every((e) => evaluate(REPO, h, e).verdict === 'PASS');
    }), true);
  // The cross-check's real corpus — the fixture inventory above bypasses the real file entirely.
  const realInv = loadInventory(REPO);
  const realS1 = realInv ? inventoryInstalls(realInv, REPO_CRON_HOST) : { installs: [], unparseable: ['<no inventory>'] };
  ck('SEAM — the real inventory loads and declares ≥20 scheduled signal-1 installs, none unparseable',
    `${realS1.installs.length >= 20}|${realS1.unparseable.length}`, 'true|0');
  ck('SEAM — the real registry classifies both W6 installs for REBOOT, by their installed path',
    ['verdict-rule-gate', 'directional-labels-race-integrity'].every((id) => scopedRows(realDoc, REPO_CRON_HOST, REBOOT_EVENT)
      .some((r) => r.id === id && r.class === 'safe-to-kill' && (r.cron_match || []).includes(`/opt/algovault-monitoring/${id}.py`))), true);
  {
    const s1 = realInv ? inventoryCoverage(realDoc, realInv, REPO_CRON_HOST) : { indeterminate: 'no inventory' };
    ck('SEAM — the real signal-1 cross-check maps EVERY install and carries no debt',
      s1.indeterminate || `${s1.unmapped}|${s1.debt}|${s1.fail}`, '0|0|0');
    const a1 = realInv ? inventoryCoverage(realDoc, realInv, 'aoe-1') : { indeterminate: 'no inventory' };
    ck('SEAM — the real aoe-1 debt is EXACTLY its unmapped installs (the ratchet holds)',
      a1.indeterminate || `${a1.unclassified.length}|${a1.nowClassified.length}|${a1.notInstalled.length}|${a1.debt === a1.unmapped}`, '0|0|0|true');
  }

  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }

  // Vacuity on the suite itself: the corpus of checks is CONSTRUCTED here.
  if (checks < 81) {
    console.log(`SELF-TEST: INDETERMINATE — only ${checks} checks ran (floor 81)`);
    console.log('CRON_INTERLOCK_COVERAGE_VERDICT=INDETERMINATE');
    return 3;
  }
  if (fails) {
    console.log(`SELF-TEST: FAIL — ${fails} of ${checks}`);
    console.log('CRON_INTERLOCK_COVERAGE_VERDICT=FAIL');
    return 1;
  }
  console.log(`SELF-TEST: PASS — ${checks} checks (happy path, both mention-vs-invocation shapes, six command positions, the unusable-row rules, every vacuity guard, the token→exit-code mapping, host scoping, per-(host, event) scope incl. the ruling-must-match-its-evidence check, the live REBOOT population, the inventory cross-check and its shrink-only debt ratchet, and the assertions against the REAL tree the fixture seam bypasses)`);
  console.log('CRON_INTERLOCK_COVERAGE_VERDICT=PASS');
  return 0;
}

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (IS_MAIN) {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  // `--host <label>` / `--event <e>` narrow; with neither, EVERY declared (host, event) is checked,
  // so the prepublishOnly wiring stays a bare invocation. `--crontab <file|->` and `--units <file>`
  // supply the LIVE population for the REBOOT scope.
  const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
  const readIn = (p) => (p === '-' ? readFileSync(0, 'utf8') : readFileSync(p, 'utf8'));
  let live = null;
  try {
    const c = arg('--crontab'); const u = arg('--units');
    if (c != null || u != null) live = { crontab: c != null ? readIn(c) : null, units: u != null ? readIn(u) : null };
  } catch (e) {
    console.log(`cron-interlock-coverage: INDETERMINATE — the live population could not be read: ${e.message}`);
    console.log('CRON_INTERLOCK_COVERAGE_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  if (live && (!arg('--host') || arg('--event') !== REBOOT_EVENT)) {
    console.log('cron-interlock-coverage: INDETERMINATE — --crontab/--units need --host <label> --event reboot');
    console.log('CRON_INTERLOCK_COVERAGE_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  process.exit(run(REPO, arg('--host'), arg('--event'), live));
}
