/**
 * OPS-EDITORIAL-PRIMITIVE-RESOLUTION-GATE-W1 CH3 — the projection, and the two things about it
 * that would otherwise ship dark.
 *
 * (1) THE ALLOW-LIST. A deny-list would make "publish it" the default, so a row added without
 *     thought leaks by omission. Both directions are asserted: a live+nameable package projects,
 *     and every other combination does not.
 *
 * (2) THE IMAGE MUST SHIP THE CORPUS. `compatibleWith()` deliberately does NOT throw — a guard on
 *     a serving path refuses rather than taking down a tool call — so a registry missing from the
 *     runtime image yields `[]`. That is ALSO the correct value today, because no companion
 *     package is live. It would be right by accident and wrong the moment one goes live, with
 *     nothing failing anywhere. Measured 2026-09-19: the Dockerfile's runtime stage shipped no
 *     `ops/` at all, so this was the live state until CH3 added the COPY. The assertion below is
 *     what keeps it shipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compatibleWith,
  projectCompatibleWith,
  isPubliclyNameablePackage,
  type PrimitiveRow,
} from '../../src/lib/primitive-projection.js';

const row = (over: Partial<PrimitiveRow> = {}): PrimitiveRow => ({
  id: 'x', kind: 'npm_package', name: 'x', invocation: 'cli',
  status: 'live', public_nameable: true, ...over,
});

describe('primitive projection — allow-list, both directions', () => {
  it('projects a live, publicly-nameable npm package', () => {
    expect(projectCompatibleWith([row({ name: 'a' })])).toEqual(['a']);
  });

  it.each([
    ['planned', row({ status: 'planned' })],
    ['retired', row({ status: 'retired' })],
    ['not public_nameable', row({ public_nameable: false })],
    ['an mcp_tool, not a package', row({ kind: 'mcp_tool', invocation: 'n_a' })],
    ['an http_endpoint', row({ kind: 'http_endpoint', invocation: 'n_a' })],
    ['this package itself — compatible_with is a COMPANION list', row({ name: 'crypto-quant-signal-mcp' })],
  ])('does NOT project %s', (_label, r) => {
    expect(isPubliclyNameablePackage(r)).toBe(false);
    expect(projectCompatibleWith([r])).toEqual([]);
  });

  it('is sorted, so the response is stable across registry row order', () => {
    expect(projectCompatibleWith([row({ id: 'b', name: 'b' }), row({ id: 'a', name: 'a' })]))
      .toEqual(['a', 'b']);
  });
});

describe('primitive projection — reads the shipped registry', () => {
  it('excludes this package by NAME, not by flipping its public_nameable', () => {
    // public_nameable stays TRUE for this package — the install line names it, and CH5's
    // publish-path gate reads the same field to decide whether a post may say it. Using that
    // flag to keep the server out of its own companion array would silently forbid the install
    // line. Two questions, two predicates, one registry.
    const doc = JSON.parse(readFileSync(join(process.cwd(), 'ops', 'primitive-registry.json'), 'utf8'));
    const self = doc.primitives.find((r: PrimitiveRow) => r.name === 'crypto-quant-signal-mcp');
    expect(self.status).toBe('live');
    expect(self.public_nameable).toBe(true);
    expect(compatibleWith()).not.toContain('crypto-quant-signal-mcp');
  });

  it('yields [] today, which is the truthful value and not a bug to route around', () => {
    // No companion package is live: the three stubs are planned + public_nameable:false.
    // If this ever becomes non-empty, a package went live and that is a deliberate registry edit.
    expect(compatibleWith()).toEqual([]);
  });

  it('an explicit path is never served from the default path\'s cache', () => {
    // The bug this replaced: one shared cache returned the first path's answer for every later
    // one. compatibleWith() is called first (memoizing []), then an explicit path must still be
    // read fresh rather than echoing it.
    expect(compatibleWith()).toEqual([]);
    const tmp = join(process.cwd(), 'ops', 'primitive-registry.json');
    expect(compatibleWith(tmp)).toEqual([]);   // same data, but READ, not echoed
    expect(compatibleWith('/nonexistent/x.json')).toEqual([]);
    expect(compatibleWith()).toEqual([]);      // the default cache survives the detour
  });

  it('a missing registry refuses by returning [], never by throwing on a serving path', () => {
    expect(() => compatibleWith('/nonexistent/primitive-registry.json')).not.toThrow();
    expect(compatibleWith('/nonexistent/primitive-registry.json')).toEqual([]);
  });

  it('the registry it reads governs the stub packages', () => {
    const doc = JSON.parse(readFileSync(join(process.cwd(), 'ops', 'primitive-registry.json'), 'utf8'));
    const names = doc.primitives.map((r: PrimitiveRow) => r.name);
    for (const n of ['crypto-quant-risk-mcp', 'crypto-quant-backtest-mcp', 'crypto-quant-execution-mcp']) {
      expect(names).toContain(n);
    }
  });
});

describe('primitive projection — the runtime image must ship the corpus', () => {
  it('the Dockerfile runtime stage COPYs ops/primitive-registry.json', () => {
    // Without this the projection is dark in prod: compatibleWith() refuses rather than throws,
    // so a missing registry yields [] — the correct value TODAY, and silently wrong the moment a
    // companion package goes live. Measured 2026-09-19: the runtime stage shipped no ops/ at all.
    // The complementary assertion lives in tests/unit/detector-envelope.test.ts, which now
    // enforces that EVERY `COPY ops/…` line is allow-listed with an owner wave and a reason.
    const df = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    const stages = df.split(/^FROM /m);
    expect(stages[stages.length - 1]).toMatch(/COPY\s+ops\/primitive-registry\.json/);
  });
});
