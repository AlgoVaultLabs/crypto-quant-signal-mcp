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
}

/** Resolved from THIS file's location, so it is correct in the repo, in `dist/`, and in a container. */
export function schemaPath(): string {
  return path.resolve(__dirname, '../../ops/monitoring/detector-envelope.schema.json');
}

let cached: EnvelopeSchema | null = null;
export function loadSchema(p: string = schemaPath()): EnvelopeSchema {
  if (cached && p === schemaPath()) return cached;
  const s = JSON.parse(readFileSync(p, 'utf8')) as EnvelopeSchema;
  if (p === schemaPath()) cached = s;
  return s;
}
/** Test seam — the module-level cache would otherwise pin the first schema a suite loaded. */
export function _resetSchemaCacheForTest(): void { cached = null; }

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
  return errs;
}

export function isConforming(env: unknown, schema: EnvelopeSchema = loadSchema()): boolean {
  return validateEnvelope(env, schema).length === 0;
}
