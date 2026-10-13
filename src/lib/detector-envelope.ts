/**
 * detector-envelope.ts — OPS-MONITORING-SIGNAL-CONTRACT-W1 CH2, PRODUCER side.
 *
 * A MONITORING DETECTOR IS A VERIFICATION GATE THAT NOBODY CALLED A GATE. It reads state, emits a
 * verdict, and a human acts on it — so every law written for `scripts/check-*` applies to it, and
 * the one that mattered is that "measured and short" must never share an output with "never
 * finished measuring."
 *
 * `detectCapacityShortfall` published a structural capacity verdict from a run SIGTERM'd at 46.6
 * of 210 minutes because it had no way to say INDETERMINATE. This module makes that emission
 * IMPOSSIBLE rather than discouraged: `buildEnvelope` FORCES the verdict to INDETERMINATE when the
 * run outcome is not one the schema calls conclusive, so a producer cannot state a conclusion its
 * own run did not reach — no matter what the caller passes.
 *
 * THE SCHEMA IS THE SoT AND IT IS DATA, NOT CODE. `ops/monitoring/detector-envelope.schema.json`
 * is read here AND by `ops/monitoring/detector_envelope.py`. A shared TypeScript helper would
 * leave the Python consumer unconstrained, which is precisely where D2 and D3 lived.
 *
 * ── WHY THERE IS AN EMBEDDED MIRROR (OPS-DETECTOR-ENVELOPE-RUNTIME-W1) ──
 *
 * That SoT file is STRUCTURALLY ABSENT from the runtime image. The Dockerfile COPYs no `ops/`
 * path, so `/app/ops` does not exist, and every in-container `buildEnvelope` call threw ENOENT
 * instead of emitting a verdict. Measured 2026-08-26: 18 throws in /var/log/carry-labeler.log,
 * each one killing the nightly labeler AFTER it had written its rows, and the consumer
 * (`directional-label-freshness.py`) reporting `CAPACITY_SIGNAL INDETERMINATE` every morning
 * since 2026-08-23 because the producer had gone silent.
 *
 * SHIPPING THE FILE INTO THE IMAGE WAS PROBED AND REJECTED, and the reason is a measured platform
 * limit rather than a preference. A COPYed path must leave `deploy.yml`'s `paths-ignore` or a
 * schema edit ships a stale image — and GitHub Actions cannot express "ignore `ops/monitoring/**`
 * except this one file": `!` negation works only in `paths`, and `paths` and `paths-ignore`
 * cannot be combined for one event. The reachable alternatives were dropping `ops/monitoring/**`
 * wholesale (every canary edit then rebuilds and restarts prod — the exact thing that entry
 * exists to prevent) or inverting the trigger to a `paths` allow-list, whose failure mode is
 * worse than this defect: a future wave adding a runtime path would silently never deploy.
 *
 * SO THE MIRROR IS NOT A SECOND SoT AND IT IS NOT A PERMISSIVE DEFAULT. It is a projection of the
 * same file, pinned FIELD-FOR-FIELD by `tests/unit/detector-envelope.test.ts`, which also asserts
 * the JSON declares no contract key the mirror lacks. A schema edit that is not mirrored fails the
 * pre-push gate and CI — strictly stronger than a rebuild trigger, which only fires if a deploy
 * happens to run. This is the same shape the Python consumer already uses: mirror the rule, pin
 * the pair with one shared-corpus test.
 *
 * `ops/monitoring/detector_envelope.py::load_schema` deliberately does NOT do this, and the
 * asymmetry is the point. It is the CONSUMER — a validator that invented its own contract would
 * accept envelopes nobody could have emitted, which is the dark-guard class. This is the
 * PRODUCER: it emits `schema_version`, so a mirror that ever did drift is rejected downstream by
 * the consumer's own version check rather than laundered into a pass.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';

export interface DetectorEnvelope {
  schema_version: number;
  detector: string;
  verdict: Verdict;
  run_id: string;
  run_started_at: string;
  run_outcome: string;
  produced_at: string;
  observation_window: { from: string; to: string };
  evidence: Record<string, unknown>;
  /** OPTIONAL (OPS-STEPUP-ACTIVATION-W1): the change a verdict is ABOUT. When present the contract
   *  refuses an observation_window that starts before `at` and requires `evidence.daily`. */
  change_point?: { at: string; source: string };
}

export interface ChangePointRules {
  window_from_not_before_at: boolean;
  evidence_daily_key: string;
}

export interface EnvelopeSchema {
  schema_version: number;
  required_fields: string[];
  verdict_values: Verdict[];
  verdict_default: Verdict;
  run_outcome_values: string[];
  run_outcome_conclusive: string[];
  max_age_seconds: number;
  evidence_rules: { must_be_object: boolean; min_keys: number; max_prose_words: number };
  observation_window_fields: string[];
  /** Optional in the TYPE because a schema copy that predates the rule must still load; a
   *  consumer reading such a copy refuses ONLY envelopes that declare a change_point. */
  change_point_fields?: string[];
  change_point_rules?: ChangePointRules;
}

/**
 * Resolved from THIS file's location. Correct in the repo and on any host that has the SoT beside
 * it; in the runtime image it resolves to `/app/ops/monitoring/...`, which does not exist — see
 * the module header for why that is answered by the mirror below and not by a Dockerfile COPY.
 */
export function schemaPath(): string {
  return path.resolve(__dirname, '../../ops/monitoring/detector-envelope.schema.json');
}

/**
 * The contract, mirrored. EVERY key of `EnvelopeSchema` and nothing else — the `_comment`,
 * `_generator` and `_*_doc` keys of the JSON are documentation and are deliberately not carried.
 * `tests/unit/detector-envelope.test.ts` asserts this equals the SoT field for field AND that the
 * SoT declares no non-underscore key missing here, so a contract change cannot be pushed
 * half-applied.
 */
export const EMBEDDED_SCHEMA: EnvelopeSchema = Object.freeze({
  schema_version: 1,
  required_fields: Object.freeze([
    'schema_version',
    'detector',
    'verdict',
    'run_id',
    'run_started_at',
    'run_outcome',
    'produced_at',
    'observation_window',
    'evidence',
  ]) as unknown as string[],
  verdict_values: Object.freeze(['PASS', 'FAIL', 'INDETERMINATE']) as unknown as Verdict[],
  verdict_default: 'INDETERMINATE',
  run_outcome_values: Object.freeze([
    'complete',
    'venue-budget',
    'global-budget',
    'venue-error',
    'venue-circuit-break',
    'stopped',
    'unknown',
  ]) as unknown as string[],
  run_outcome_conclusive: Object.freeze(['complete', 'venue-budget', 'global-budget']) as unknown as string[],
  max_age_seconds: 21600,
  evidence_rules: Object.freeze({ must_be_object: true, min_keys: 1, max_prose_words: 7 }),
  observation_window_fields: Object.freeze(['from', 'to']) as unknown as string[],
  change_point_fields: Object.freeze(['at', 'source']) as unknown as string[],
  change_point_rules: Object.freeze({ window_from_not_before_at: true, evidence_daily_key: 'daily' }),
}) as EnvelopeSchema;

let cached: EnvelopeSchema | null = null;
let announcedMirror = false;

/**
 * THE SUBSTITUTION IS NEVER SILENT, AND IT IS NEVER A WIDENING.
 *
 *   - default path, file present     → the file wins. It is the SoT.
 *   - default path, file ABSENT      → the pinned mirror, plus ONE stderr line per process.
 *   - default path, file UNREADABLE  → THROWS. Input we were handed and could not parse is the
 *                                      indeterminate case; a corrupt SoT must never be papered
 *                                      over by a copy that happens to still parse.
 *   - EXPLICIT path, missing         → THROWS. A caller naming a file is asserting something about
 *                                      THAT file, and answering with different bytes would make
 *                                      the assertion unfalsifiable.
 */
export function loadSchema(p: string = schemaPath()): EnvelopeSchema {
  const isDefault = p === schemaPath();
  if (cached && isDefault) return cached;

  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!isDefault || (code !== 'ENOENT' && code !== 'ENOTDIR')) throw err;
    if (!announcedMirror) {
      announcedMirror = true;
      console.error(
        `[detector-envelope] schema SoT absent at ${p}; using the embedded mirror `
        + '(pinned field-for-field by tests/unit/detector-envelope.test.ts). '
        + 'Expected inside the runtime image, which COPYs no ops/ path.',
      );
    }
    if (isDefault) cached = EMBEDDED_SCHEMA;
    return EMBEDDED_SCHEMA;
  }

  const s = JSON.parse(raw) as EnvelopeSchema;
  if (isDefault) cached = s;
  return s;
}
/** Test seam — the module-level cache would otherwise pin the first schema a suite loaded. */
export function _resetSchemaCacheForTest(): void { cached = null; announcedMirror = false; }

export interface BuildInput {
  detector: string;
  verdict?: Verdict;
  runId: string;
  runStartedAt: string;
  runOutcome: string;
  producedAt: string;
  observationWindow: { from: string; to: string };
  evidence: Record<string, unknown>;
}

/**
 * Build a conforming envelope. THE FORCING RULE IS THE WHOLE POINT:
 *
 *   - an omitted verdict becomes INDETERMINATE (the schema's declared default), never PASS;
 *   - a run whose `run_outcome` is NOT in `run_outcome_conclusive` has its verdict DOWNGRADED to
 *     INDETERMINATE even when the caller passed PASS or FAIL.
 *
 * So the 2026-08-22 run — `outcome=stopped`, 46.6 of 210 minutes — cannot produce a FAIL saying
 * the budget is structurally short. The truncation stays fully visible in `evidence` and
 * `run_outcome`; only the conclusion the run did not earn is removed.
 */
export function buildEnvelope(input: BuildInput, schema: EnvelopeSchema = loadSchema()): DetectorEnvelope {
  const asked: Verdict = input.verdict ?? schema.verdict_default;
  const conclusive = schema.run_outcome_conclusive.includes(input.runOutcome);
  const verdict: Verdict = conclusive ? asked : 'INDETERMINATE';
  return {
    schema_version: schema.schema_version,
    detector: input.detector,
    verdict,
    run_id: input.runId,
    run_started_at: input.runStartedAt,
    run_outcome: input.runOutcome,
    produced_at: input.producedAt,
    observation_window: input.observationWindow,
    evidence: input.evidence,
  };
}

/** Every reason an envelope is non-conforming. Empty array = conforming. */
export function validateEnvelope(env: unknown, schema: EnvelopeSchema = loadSchema()): string[] {
  const errs: string[] = [];
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return ['envelope is not an object'];
  const e = env as Record<string, unknown>;
  for (const f of schema.required_fields) if (!(f in e)) errs.push(`missing required field '${f}'`);
  if ('schema_version' in e && e.schema_version !== schema.schema_version) {
    errs.push(`schema_version ${String(e.schema_version)} != ${schema.schema_version}`);
  }
  if ('verdict' in e && !schema.verdict_values.includes(e.verdict as Verdict)) {
    errs.push(`verdict '${String(e.verdict)}' is not one of ${schema.verdict_values.join('|')}`);
  }
  if ('run_outcome' in e && !schema.run_outcome_values.includes(String(e.run_outcome))) {
    errs.push(`run_outcome '${String(e.run_outcome)}' is not a declared outcome`);
  }
  // The forcing rule, asserted on the WIRE as well as at build time. A producer that hand-rolls an
  // envelope instead of calling buildEnvelope must not be able to smuggle the conclusion past us.
  if ('run_outcome' in e && 'verdict' in e
      && !schema.run_outcome_conclusive.includes(String(e.run_outcome))
      && e.verdict !== 'INDETERMINATE') {
    errs.push(`run_outcome '${String(e.run_outcome)}' is not conclusive, so verdict MUST be INDETERMINATE, not '${String(e.verdict)}'`);
  }
  const w = e.observation_window as Record<string, unknown> | undefined;
  if ('observation_window' in e) {
    if (w === null || typeof w !== 'object') errs.push('observation_window is not an object');
    else for (const f of schema.observation_window_fields) if (!(f in w)) errs.push(`observation_window missing '${f}'`);
  }
  if ('evidence' in e) {
    const ev = e.evidence as Record<string, unknown>;
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) errs.push('evidence is not an object');
    else {
      if (Object.keys(ev).length < schema.evidence_rules.min_keys) {
        errs.push(`evidence has ${Object.keys(ev).length} key(s), fewer than the required ${schema.evidence_rules.min_keys}`);
      }
      // D2's defect, caught in the field that exists to prevent it: a sentence about mechanism is
      // not a measurement, and it keeps rendering long after the code beneath it changes.
      for (const [k, v] of Object.entries(ev)) {
        if (typeof v !== 'string') continue;
        const words = v.trim().split(/\s+/).filter(Boolean).length;
        if (words > schema.evidence_rules.max_prose_words) {
          errs.push(`evidence.${k} is ${words} words — prose about mechanism, not a measured value (max ${schema.evidence_rules.max_prose_words})`);
        }
      }
    }
  }
  // OPTIONAL, ADDITIVE: only an envelope that declares a change point is held to the rule.
  if ('change_point' in e) errs.push(...changePointErrors(e, schema));
  return errs;
}

// ── change_point (OPS-STEPUP-ACTIVATION-W1 CH2) ─────────────────────────────────────────────
// ONE strict grammar, shared character for character with detector_envelope.py. Never Date.parse:
// it accepts strings that are not ISO-8601 at all ("Oct 12 2026"), and Python's fromisoformat
// accepts different strings on 3.9 than on 3.12 — either would let the two validators disagree
// about the same bytes. Both sides compare at MILLISECONDS.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const DAILY_RE = /^\d+(,\d+)*$/;

/** Epoch milliseconds of a strict ISO-8601 instant with an explicit offset, else null. */
export function isoMs(ts: unknown): number | null {
  const m = typeof ts === 'string' ? ISO_RE.exec(ts) : null;
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, , sign, oh, om] = m;
  if (Number(oh ?? 0) > 23 || Number(om ?? 0) > 59) return null;
  const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  // Date.UTC ROLLS OVER (month 13, Feb 30, second 60); Python's datetime() refuses. Refuse here too.
  if (at.getUTCFullYear() !== Number(y) || at.getUTCMonth() !== Number(mo) - 1 || at.getUTCDate() !== Number(d)
      || at.getUTCHours() !== Number(h) || at.getUTCMinutes() !== Number(mi) || at.getUTCSeconds() !== Number(s)) {
    return null;
  }
  const ms = at.getTime() + Number((frac ?? '0').slice(0, 3).padEnd(3, '0'));
  const off = sign ? (Number(oh) * 60 + Number(om)) * 60000 : 0;
  return sign === '+' ? ms - off : ms + off;
}

/** Render a value the way Python's json.dumps(ensure_ascii=False) does, so both sides print identical reasons. */
function jsonish(v: unknown): string {
  const out = JSON.stringify(v);
  return out === undefined ? JSON.stringify(String(v)) : out;
}

/**
 * The `change_point` rule. Called only when the envelope DECLARES one — every other envelope is
 * validated exactly as before this rule existed. Mirrors `_change_point_errors` rule for rule.
 */
function changePointErrors(e: Record<string, unknown>, schema: EnvelopeSchema): string[] {
  const fields = schema.change_point_fields;
  const rules = schema.change_point_rules;
  if (!Array.isArray(fields) || rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
    return ['change_point is declared but this schema has no change_point contract — '
      + 'a verdict about a change cannot be validated against it'];
  }
  const cp = e.change_point as Record<string, unknown> | null;
  if (cp === null || typeof cp !== 'object' || Array.isArray(cp)) return ['change_point is not an object'];
  const missing = fields.filter((f) => !(f in cp)).map((f) => `change_point missing '${f}'`);
  if (missing.length) return missing;
  const errs: string[] = [];
  const atMs = isoMs(cp.at);
  if (atMs === null) errs.push(`change_point.at ${jsonish(cp.at)} is not an ISO-8601 instant`);
  const w = e.observation_window as Record<string, unknown> | null | undefined;
  if (rules.window_from_not_before_at && w !== null && typeof w === 'object' && !Array.isArray(w) && 'from' in w) {
    const fromMs = isoMs(w.from);
    if (fromMs === null) errs.push(`observation_window.from ${jsonish(w.from)} is not an ISO-8601 instant`);
    else if (atMs !== null && fromMs < atMs) {
      errs.push(`observation_window.from ${String(w.from)} is before change_point.at ${String(cp.at)} — a verdict about a `
        + 'change may observe only post-change time');
    }
  }
  const key = rules.evidence_daily_key;
  const ev = e.evidence as Record<string, unknown> | null | undefined;
  if (key && ev !== null && typeof ev === 'object' && !Array.isArray(ev)) {
    if (!(key in ev)) errs.push(`evidence.${key} missing — a verdict about a change carries its per-day series`);
    else if (typeof ev[key] !== 'string' || !DAILY_RE.test(ev[key] as string)) {
      errs.push(`evidence.${key} ${jsonish(ev[key])} is not a per-day series (comma-joined non-negative integers)`);
    }
  }
  return errs;
}

export function isConforming(env: unknown, schema: EnvelopeSchema = loadSchema()): boolean {
  return validateEnvelope(env, schema).length === 0;
}
