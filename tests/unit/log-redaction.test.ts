/**
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch1 — SEC-14 structural log redaction.
 *
 * The defect: `PgBackend.trackedWrite` logged `SQL=<sql> PARAMS=<every bound param>`
 * on a lost write, so a signup during a Postgres outage emitted a LIVE api key and
 * the subscriber's email into stdout — and because the row never persisted, nothing
 * ever rotated that key.
 *
 * These tests pin the CONTRACT, not the implementation: no credential material may
 * survive the formatter by ANY path (params, exception message, interpolated SQL),
 * while the statement shape — the whole diagnostic point of the line — must survive.
 *
 * The critical property is that redaction is STRUCTURAL: the "unknown future key
 * format" case below is what a prefix deny-list would miss, and is exactly the
 * failure mode CLAUDE.md's "never by known vendor prefix" law exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import {
  fingerprint,
  redactParams,
  redactErrorText,
  redactSqlShape,
  formatWriteLossLog,
} from '../../src/lib/log-redact.js';

// Realistic secret-bearing values from the actual leaking call sites
// (free-keys-store.ts:91 / :156, referral-store.ts:291).
const API_KEY = 'av_free_a1b2c3d4e5f6a7b8c9d0e1f2';
const EMAIL = 'customer@example.com';
const SIGNUP_SQL = 'INSERT INTO free_keys (api_key, email, ref_code) VALUES ($1,$2,$3)';

describe('fingerprint', () => {
  it('is non-reversible, length-bearing, and stable', () => {
    const f = fingerprint(API_KEY);
    expect(f).toBe(`len=${API_KEY.length} sha16=${fingerprint(API_KEY).split('sha16=')[1]}`);
    expect(f).not.toContain(API_KEY);
    expect(f).toMatch(/^len=\d+ sha16=[0-9a-f]{16}$/);
  });

  it('distinguishes different values (so a log stays correlatable)', () => {
    expect(fingerprint('a'.repeat(10))).not.toBe(fingerprint('b'.repeat(10)));
  });
});

describe('redactParams — total over strings', () => {
  it('never emits a bound string parameter', () => {
    const out = redactParams([API_KEY, EMAIL, null]);
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain('av_free_');
    expect(out).not.toContain('@example.com');
  });

  it('keeps non-credential primitives that carry the diagnostic value', () => {
    const out = redactParams([42, true, null, undefined, 7n]);
    expect(out).toBe('[42,true,null,null,7n]');
  });

  it('redacts a string of an UNKNOWN future key format just as well (structural, not prefix-based)', () => {
    // The exact case a deny-list of `av_`/`sk-`/`AIza` prefixes would miss.
    const futureKey = 'ZZq.9f83b1c4d5e6f708192a3b4c5d6e7f80';
    const out = redactParams([futureKey]);
    expect(out).not.toContain(futureKey);
    expect(out).toContain(`len=${futureKey.length}`);
  });

  it('does not leak a secret nested inside an object parameter', () => {
    const out = redactParams([{ metadata: { api_key: API_KEY } }]);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain('<json ');
  });

  it('truncates rather than growing without bound', () => {
    const out = redactParams(Array.from({ length: 200 }, () => 'x'.repeat(50)), 200);
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('redactErrorText — the SECOND leak path (exception message)', () => {
  it('masks the value Postgres embeds in a unique-violation detail', () => {
    // node-postgres surfaces exactly this shape; it carries the offending VALUE.
    const msg =
      `duplicate key value violates unique constraint "free_keys_pkey" ` +
      `DETAIL: Key (api_key)=(${API_KEY}) already exists.`;
    const out = redactErrorText(msg);
    expect(out).not.toContain(API_KEY);
    // Diagnostic prose + the identifier survive.
    expect(out).toContain('duplicate key value violates unique constraint');
    expect(out).toContain('"free_keys_pkey"');
    expect(out).toContain('Key (api_key)=');
  });

  it('masks an email appearing anywhere in the message', () => {
    const out = redactErrorText(`could not insert row for ${EMAIL} — retry exhausted`);
    expect(out).not.toContain(EMAIL);
    expect(out).toContain('retry exhausted');
  });

  it('masks single-quoted LITERALS but keeps double-quoted IDENTIFIERS', () => {
    // Postgres quoting is the structural signal: '…' is a value, "…" is a name.
    const out = redactErrorText(`invalid input for relation "free_keys": '${API_KEY}'`);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain('"free_keys"');
  });

  it('masks a LABEL=VALUE pair without destroying the label', () => {
    const out = redactErrorText(`connection failed password=${API_KEY} host=db`);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain('password=');
  });

  it('does NOT corrupt ordinary prose containing bare digits (placeholder-collision guard)', () => {
    // A space-delimited placeholder scheme would swap the " 3 " here for a redaction.
    const out = redactErrorText('write lost after 3 attempts, 2 retries, code 42');
    expect(out).toBe('write lost after 3 attempts, 2 retries, code 42');
  });

  it('never emits the literal "undefined" (placeholder restore is total)', () => {
    const out = redactErrorText(`Key (email)=(${EMAIL}) and password='${API_KEY}' at 5 o'clock`);
    expect(out).not.toContain('undefined');
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(EMAIL);
  });

  it('passes empty/short input through unchanged', () => {
    expect(redactErrorText('')).toBe('');
    expect(redactErrorText('ECONNRESET')).toBe('ECONNRESET');
  });
});

describe('redactSqlShape — shape survives, interpolated literals do not', () => {
  it('keeps a parameterized statement fully readable', () => {
    expect(redactSqlShape(SIGNUP_SQL)).toBe(SIGNUP_SQL);
  });

  it('masks a literal that a careless call site interpolated into the SQL', () => {
    const out = redactSqlShape(`INSERT INTO free_keys (api_key) VALUES ('${API_KEY}')`);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain('INSERT INTO free_keys (api_key) VALUES (');
  });
});

describe('formatWriteLossLog — the end-to-end contract', () => {
  const err = new Error(
    `duplicate key value violates unique constraint "free_keys_pkey" ` +
    `DETAIL: Key (api_key)=(${API_KEY}) already exists.`,
  );

  it('emits ZERO credential material across every path (params + message + sql)', () => {
    const line = formatWriteLossLog('run', 4, err, SIGNUP_SQL, [API_KEY, EMAIL, null]);
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain('av_free_');
    expect(line).not.toContain('@example.com');
  });

  it('preserves the diagnostic payload the operator actually needs', () => {
    const line = formatWriteLossLog('run', 4, err, SIGNUP_SQL, [API_KEY, EMAIL, null]);
    expect(line).toContain('[pg-write] WRITE LOST after 4 attempt(s) [run]');
    expect(line).toContain('duplicate key value violates unique constraint');
    expect(line).toContain(SIGNUP_SQL); // the SHAPE, intact
    expect(line).toContain(`len=${API_KEY.length}`); // correlatable without disclosure
  });

  it('handles a non-Error rejection (the String(err) / repr path)', () => {
    const line = formatWriteLossLog('run', 2, `boom for ${EMAIL}`, SIGNUP_SQL, [EMAIL]);
    expect(line).not.toContain(EMAIL);
    expect(line).toContain('boom for');
  });

  it('handles an error whose message is empty', () => {
    const line = formatWriteLossLog('exec', 1, new Error(''), 'CREATE TABLE t (a int)', []);
    expect(line).toContain('CREATE TABLE t (a int)');
    expect(line).toContain('PARAMS=[]');
  });
});
