/**
 * OPS-NODE-SECURITY-FLOOR-W1 CH2 R3 — the api.algovault.com encoded-requests log, as committed.
 *
 *   1. It writes ONLY requests that carry a Content-Encoding header: the named matcher
 *      `@unencoded header !Content-Encoding` feeds `skip_log`, and nothing else uses it.
 *   2. Its privacy filter is never weaker than the apex access log's: every field the apex
 *      filter masks or deletes, this one masks or deletes the same way.
 *   3. Every credential the app accepts is deleted before a line is written: the query
 *      parameters (each one read by src/ — so the list is grounded, not invented) and the
 *      credential headers. `log_credentials` appears nowhere in the file.
 *   4. The roll settings the owed read `inbound-encoding-14d` was sized against.
 *
 * The parser is deliberately small: it reads the brace structure of this one file, and its own
 * test below proves it can fail.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CADDYFILE = fs.readFileSync(path.join(ROOT, 'Caddyfile'), 'utf8');

/** Lines of the file with comments and blank lines removed, each trimmed. */
const codeLines = (text: string): string[] =>
  text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').trim()).filter((l) => l !== '');

/** The lines strictly inside the block opened by the first line equal to `opener`, or null. */
function blockAfter(lines: string[], opener: string): string[] | null {
  const at = lines.indexOf(opener);
  if (at === -1) return null;
  let depth = 0;
  for (let i = at; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    if (depth === 0) return lines.slice(at + 1, i);
  }
  return null;
}

/**
 * Top-level lines of a block (depth 0 inside it), each with the lines of the block it opens, if
 * any — that block's own closing brace excluded.
 */
function children(block: string[]): { line: string; body: string[] }[] {
  const out: { line: string; body: string[] }[] = [];
  let depth = 0;
  let current: { line: string; body: string[] } | null = null;
  for (const line of block) {
    const next = depth + (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0) {
      current = { line, body: [] };
      out.push(current);
    } else if (current && !(next === 0 && line === '}')) {
      current.body.push(line);
    }
    depth = next;
  }
  return out;
}

/** `field -> filter text` for a `format filter { fields { … } }` block, nested lines joined. */
function filterFields(logBlock: string[]): Map<string, string> {
  const format = children(logBlock).find((c) => c.line === 'format filter {');
  const fields = format ? children(format.body).find((c) => c.line === 'fields {') : undefined;
  const out = new Map<string, string>();
  for (const f of fields ? children(fields.body) : []) {
    const [name, ...rest] = f.line.replace(/\s*\{$/, '').split(/\s+/);
    out.set(name, [rest.join(' '), ...f.body].join(' ').trim());
  }
  return out;
}

const lines = codeLines(CADDYFILE);
const api = blockAfter(lines, 'api.algovault.com {');
const apex = blockAfter(lines, 'algovault.com {');
const apiChildren = children(api ?? []);
const apiLog = apiChildren.find((c) => c.line === 'log {');
const apexLog = children(apex ?? []).find((c) => c.line === 'log {');

describe('the parser can fail', () => {
  it('finds a block, its children and its filter fields — and reports a missing one as missing', () => {
    const sample = codeLines([
      'site {',
      '  log {',
      '    format filter {',
      '      fields {',
      '        request>remote_ip ip_mask {',
      '          ipv4 24',
      '        }',
      '        request>headers>Cookie delete',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n'));
    const site = blockAfter(sample, 'site {');
    const log = children(site ?? []).find((c) => c.line === 'log {');
    expect(log).toBeDefined();
    expect(Object.fromEntries(filterFields(log!.body))).toEqual({
      'request>remote_ip': 'ip_mask ipv4 24',
      'request>headers>Cookie': 'delete',
    });
    expect(blockAfter(sample, 'other {')).toBeNull();
  });
});

describe('api.algovault.com encoded-requests log', () => {
  it('the api block and both log blocks are found', () => {
    expect(api).not.toBeNull();
    expect(apiLog).toBeDefined();
    expect(apexLog).toBeDefined();
  });

  it('writes only requests that carry a Content-Encoding header', () => {
    const top = apiChildren.map((c) => c.line);
    expect(top).toContain('@unencoded header !Content-Encoding');
    expect(top).toContain('skip_log @unencoded');
    // The matcher feeds skip_log alone: no other line in the whole file names it.
    expect(lines.filter((l) => l.includes('@unencoded'))).toEqual(['@unencoded header !Content-Encoding', 'skip_log @unencoded']);
  });

  it('writes to its own file, with the roll the 14-day owed read was sized against', () => {
    const output = children(apiLog!.body).find((c) => c.line.startsWith('output file '));
    expect(output?.line).toBe('output file /var/log/caddy/api-encoded-requests.log {');
    expect(output?.body.filter((l) => l !== '}')).toEqual(['roll_size 10MiB', 'roll_keep 10', 'roll_keep_for 720h']);
  });

  it('is never less private than the apex access log', () => {
    const apexFields = filterFields(apexLog!.body);
    const apiFields = filterFields(apiLog!.body);
    expect(apexFields.size).toBeGreaterThanOrEqual(9); // vacuity: the apex filter was read
    for (const [field, filter] of apexFields) expect(apiFields.get(field), field).toBe(filter);
    expect(children(children(apiLog!.body).find((c) => c.line === 'format filter {')!.body)[0].line).toBe('wrap json');
  });

  it('deletes every credential query parameter, each one a parameter src/ reads', () => {
    const QUERY_CREDENTIALS = ['key', 'api_key', 't', 'code', 'state', 'session_id'];
    const uri = filterFields(apiLog!.body).get('request>uri') ?? '';
    expect(uri.startsWith('query ')).toBe(true);
    const deleted = [...uri.matchAll(/\bdelete (\S+)/g)].map((m) => m[1]);
    expect(deleted).toEqual(QUERY_CREDENTIALS);
    const src = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'))
      .join('\n');
    for (const p of QUERY_CREDENTIALS) expect(src, `req.query.${p}`).toMatch(new RegExp(`req\\.query\\.${p}\\b`));
  });

  it('deletes every credential header and the Referer that can carry one', () => {
    const fields = filterFields(apiLog!.body);
    for (const h of ['Authorization', 'Cookie', 'X-Algovault-Internal-Key', 'X-Payment', 'Payment-Signature', 'Stripe-Signature', 'Referer']) {
      expect(fields.get(`request>headers>${h}`), h).toBe('delete');
    }
  });

  it('log_credentials appears nowhere in the file', () => {
    expect(lines.some((l) => l.includes('log_credentials'))).toBe(false);
  });
});
