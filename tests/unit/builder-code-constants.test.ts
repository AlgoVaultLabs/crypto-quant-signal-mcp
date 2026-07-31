/**
 * builder-code-constants.test.ts — OPS-BASE-BUILDER-CODE-W1 C2.
 *
 * Pins the SAFETY CONTRACT: attribution is additive telemetry that must never
 * throw and must degrade to `undefined` (⇒ unattributed publish) on every
 * failure mode. Also pins the SCHEMA-2 encoding choice (architect Q2) so a
 * future edit cannot silently regress to the dashboard's schema-0 form.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseBuilderCodeSuffixFromCalldata } from '@x402/extensions/builder-code';
import {
  BASE_BUILDER_CODE_DEFAULT,
  getBuilderCode,
  isBuilderCodeEnabled,
  getBuilderCodeDataSuffix,
} from '../../src/lib/builder-code-constants.js';

const ENV_KEYS = ['BASE_BUILDER_CODE_ENABLED', 'BASE_BUILDER_CODE', 'BASE_BUILDER_CODE_SUFFIX'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  vi.restoreAllMocks();
});

describe('flag gating (default OFF = instant rollback)', () => {
  it('is OFF when the flag is unset', () => {
    expect(isBuilderCodeEnabled()).toBe(false);
    expect(getBuilderCodeDataSuffix()).toBeUndefined();
  });

  it('accepts 1/true and rejects anything else', () => {
    for (const on of ['1', 'true', 'TRUE']) {
      process.env.BASE_BUILDER_CODE_ENABLED = on;
      expect(isBuilderCodeEnabled()).toBe(true);
    }
    for (const off of ['0', 'false', 'yes', '']) {
      process.env.BASE_BUILDER_CODE_ENABLED = off;
      expect(isBuilderCodeEnabled()).toBe(false);
      expect(getBuilderCodeDataSuffix()).toBeUndefined();
    }
  });
});

describe('suffix encoding (SCHEMA 2 — architect Q2)', () => {
  beforeEach(() => {
    process.env.BASE_BUILDER_CODE_ENABLED = '1';
  });

  it('emits a suffix that round-trips back to our builder code', () => {
    const suffix = getBuilderCodeDataSuffix();
    expect(suffix).toBeDefined();
    const parsed = parseBuilderCodeSuffixFromCalldata(`0x00000000${suffix!.slice(2)}`);
    expect(parsed?.a).toBe(BASE_BUILDER_CODE_DEFAULT);
  });

  it('is SCHEMA 2 with the ERC-8021 marker — NOT the dashboard schema-0 form', () => {
    const b = Buffer.from(getBuilderCodeDataSuffix()!.slice(2), 'hex');
    expect(b.subarray(-16).toString('hex')).toBe('80218021802180218021802180218021');
    // byte immediately before the 16-byte marker is the schema id
    expect(b[b.length - 17]).toBe(2);
  });

  it('honours a BASE_BUILDER_CODE override', () => {
    process.env.BASE_BUILDER_CODE = 'bc_test_code';
    expect(getBuilderCode()).toBe('bc_test_code');
    const parsed = parseBuilderCodeSuffixFromCalldata(
      `0x00000000${getBuilderCodeDataSuffix()!.slice(2)}`
    );
    expect(parsed?.a).toBe('bc_test_code');
  });
});

describe('fail-open contract (never throws, degrades to undefined)', () => {
  beforeEach(() => {
    process.env.BASE_BUILDER_CODE_ENABLED = '1';
  });

  it('returns undefined for a code violating BUILDER_CODE_PATTERN', () => {
    for (const bad of ['BC_UPPER', 'has spaces', 'a'.repeat(33), 'bad-dash']) {
      process.env.BASE_BUILDER_CODE = bad;
      expect(() => getBuilderCodeDataSuffix()).not.toThrow();
      expect(getBuilderCodeDataSuffix()).toBeUndefined();
    }
  });

  it('rejects a BASE_BUILDER_CODE_SUFFIX override that does not round-trip', () => {
    process.env.BASE_BUILDER_CODE_SUFFIX = '0xdeadbeef';
    expect(getBuilderCodeDataSuffix()).toBeUndefined();
  });

  it('rejects an override encoding a DIFFERENT code than configured', () => {
    process.env.BASE_BUILDER_CODE = 'bc_aaaa';
    const other = getBuilderCodeDataSuffix()!; // suffix for bc_aaaa
    process.env.BASE_BUILDER_CODE = 'bc_bbbb'; // now expect bc_bbbb
    process.env.BASE_BUILDER_CODE_SUFFIX = other;
    expect(getBuilderCodeDataSuffix()).toBeUndefined();
  });

  it('accepts a well-formed override for the configured code', () => {
    const good = getBuilderCodeDataSuffix()!;
    process.env.BASE_BUILDER_CODE_SUFFIX = good;
    expect(getBuilderCodeDataSuffix()).toBe(good);
  });
});
