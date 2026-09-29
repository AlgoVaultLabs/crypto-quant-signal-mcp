/**
 * claim-evidence.ts — the pure half of the live-claim evidence contract (OPS-CLIENT-CLAIM-EVIDENCE-W1).
 *
 * Every load-bearing sentence an mcp-clients row RENDERS carries a `LiveClaimEvidence` entry naming
 * the live page that makes it true (see ./types.ts). This module holds what can be decided without a
 * network: the anchor rules, the shape of the document the host canary reads, and which
 * claim-bearing modules are covered. No I/O — scripts/emit-claim-evidence.mjs writes the document,
 * tests/unit/claim-evidence.test.ts binds the rules, ops/monitoring/client-claim-freshness.py
 * confirms the anchors live, daily.
 *
 * WHY THE HOST READS A GENERATED JSON, NOT THE TS: the host has no checkout and no TypeScript
 * toolchain, and v1 parsed the TS row literals with a regex — a parser that can only ever see what
 * its regex anticipated. The JSON is the SoT projected once, here, and diffed in CI (R5).
 *
 * WHY THE JSON LIVES HERE AND NOT UNDER ops/monitoring/: scripts/check-declaration-coverage.mjs
 * derives "declaration" from who reads a data file in ops/monitoring/, so a host-read JSON there
 * would demand a declaration-sync path it does not need. This directory is already the canary's
 * raw-HTTPS edge.
 */
import type { EvidencedEntry, LiveClaimEvidence, SurfaceModule } from './types.js';

export const CLAIM_EVIDENCE_SCHEMA_VERSION = 1 as const;
/** The one corpus covered today. The canary's CORPUS line names the same corpus and path. */
export const CLAIM_EVIDENCE_CORPUS = 'mcp-clients' as const;
/** Repo-relative path of the generated document the host canary fetches over raw HTTPS. */
export const CLAIM_EVIDENCE_JSON = 'src/lib/integrations-data/claim-evidence.json';
export const CLAIM_EVIDENCE_GENERATED_BY =
  'scripts/emit-claim-evidence.mjs from src/lib/integrations-data/mcp-clients.ts — never hand-edit; regenerate with `npm run claims:evidence`';

/**
 * R4. An anchor token must be DISTINCTIVE. The v1 canary's SOURCE arm counted the token `mcp` on a
 * 200 page — every MCP vendor page contains it, so it could not tell a true claim from a false one
 * (measured 2026-09-29: it scored all five paged rows `ok`, and two contradicted rows `ok`). A
 * generic word as an anchor is that proxy back under a new name, so these are barred outright,
 * compared case-insensitively.
 */
export const MIN_ANCHOR_TOKEN_LENGTH = 4;
export const EXPECT_STOPLIST: readonly string[] = Object.freeze([
  'mcp', 'MCP', 'server', 'servers', 'http', 'https', 'json',
  'config', 'client', 'clients', 'tool', 'tools', 'docs',
]);

/**
 * R7. Every src/lib/integrations-data module exporting a SurfaceModule is either covered by claim
 * evidence or declared here with a reason — a new claim-bearing module cannot appear silently.
 * ai-agents (4 rows) and exchange-kits (13 rows) render hand-typed provenance lines, yet carry NO
 * source/verifiedAt at all (measured 0 of 17), so v1's promised "one CORPUS line" extension was
 * false for them. Under this contract the extension is: declare evidence (the type forces it),
 * move the module from UNCOVERED to COVERED, and give it its own row floor on its CORPUS line.
 */
export const COVERED_CLAIM_MODULES: readonly string[] = Object.freeze([CLAIM_EVIDENCE_CORPUS]);
export const UNCOVERED_CLAIM_MODULES: Readonly<Record<string, string>> = Object.freeze({
  'ai-agents': 'not yet evidenced; owner OPS-CLIENT-CLAIM-CORPUS-EXTEND-W{NEXT}',
  'exchange-kits': 'not yet evidenced; owner OPS-CLIENT-CLAIM-CORPUS-EXTEND-W{NEXT}',
});

/**
 * R6. A tutorial line that hand-types the row's provenance ("Config verified 2026-08-05 against
 * <url>"). It is a second copy of `verifiedAt` + `source`, so it must agree with them.
 */
export const VERIFIED_TWIN_RE = /(Config )?[Vv]erified (\d{4}-\d{2}-\d{2}) against/;

const NPM_SCOPE_RE = /^@[a-z0-9][a-z0-9._-]*$/;

/** The one normaliser both sides of R2 use — and the one the canary applies to every page body. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** R3. */
export function isAbsoluteHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** R4 for one expect/reject token: why it cannot serve as an anchor, or null. */
export function anchorTokenProblem(token: string): string | null {
  const t = token.trim();
  if (t.length < MIN_ANCHOR_TOKEN_LENGTH) {
    return `"${token}" is shorter than ${MIN_ANCHOR_TOKEN_LENGTH} characters after trim`;
  }
  if (EXPECT_STOPLIST.some((w) => w.toLowerCase() === t.toLowerCase())) {
    return `"${token}" is on EXPECT_STOPLIST — a generic token proves nothing about the claim`;
  }
  if (token !== collapseWhitespace(token)) {
    return `"${token}" is not whitespace-collapsed, so it can never match the canary's collapsed page text`;
  }
  return null;
}

export interface EvidenceProblem {
  slug: string;
  rule: 'R1' | 'R2' | 'R3' | 'R4';
  detail: string;
}

/**
 * R1–R4 over a set of rows. `renderText` is injected because the ONE derivation of reader-visible
 * row text is `renderedRowText()` in scripts/check-mcp-client-copy.mjs — a second copy here would
 * be a second thing that can disagree with what the copy gate sees.
 */
export function evidenceProblems(
  entries: readonly EvidencedEntry[],
  renderText: (e: EvidencedEntry) => string,
): EvidenceProblem[] {
  const out: EvidenceProblem[] = [];
  for (const e of entries) {
    const evidence = (e as { evidence?: readonly LiveClaimEvidence[] }).evidence;
    if (!Array.isArray(evidence) || evidence.length === 0) {
      out.push({ slug: e.slug, rule: 'R1', detail: 'row carries no evidence entry' });
      continue;
    }
    const text = collapseWhitespace(renderText(e));
    evidence.forEach((a: LiveClaimEvidence, i: number) => {
      const at = `evidence[${i}]`;
      if (typeof a.claim !== 'string' || a.claim.trim() === '' || !text.includes(a.claim)) {
        out.push({ slug: e.slug, rule: 'R2', detail: `${at} claim "${a.claim}" is not a verbatim substring of the rendered row text` });
      }
      if (!isAbsoluteHttpsUrl(a.source)) {
        out.push({ slug: e.slug, rule: 'R3', detail: `${at} source "${a.source}" is not an absolute https URL` });
      }
      if (!Array.isArray(a.expect) || a.expect.length === 0) {
        out.push({ slug: e.slug, rule: 'R4', detail: `${at} expect is empty — an anchor that expects nothing confirms anything` });
      }
      for (const t of [...(a.expect ?? []), ...(a.reject ?? [])]) {
        const p = anchorTokenProblem(t);
        if (p) out.push({ slug: e.slug, rule: 'R4', detail: `${at} ${p}` });
      }
      if (a.npmScopeAbsence !== undefined && !NPM_SCOPE_RE.test(a.npmScopeAbsence)) {
        out.push({ slug: e.slug, rule: 'R4', detail: `${at} npmScopeAbsence "${a.npmScopeAbsence}" is not an npm scope (@name)` });
      }
    });
  }
  return out;
}

/** R6 for one tutorial: every twin line carries the SoT row's verifiedAt AND its source URL. */
export function verifiedTwinProblems(
  slug: string,
  markdown: string,
  row: Pick<EvidencedEntry, 'verifiedAt' | 'source'> | undefined,
): string[] {
  const out: string[] = [];
  markdown.split('\n').forEach((line, i) => {
    const m = VERIFIED_TWIN_RE.exec(line);
    if (!m) return;
    const where = `docs/integrations/mcp-clients/${slug}.md:${i + 1}`;
    if (!row) {
      out.push(`${where}: a "verified … against" line with no mcp-clients row named ${slug}`);
      return;
    }
    if (m[2] !== row.verifiedAt) out.push(`${where}: says ${m[2]}, the SoT row says verifiedAt ${row.verifiedAt}`);
    if (!line.includes(row.source)) out.push(`${where}: does not cite the SoT row's source ${row.source}`);
  });
  return out;
}

/** R7: `surfaceModules` = basenames of every module that exports a SurfaceModule. */
export function moduleCoverageProblems(surfaceModules: readonly string[]): string[] {
  const out: string[] = [];
  const covered = new Set(COVERED_CLAIM_MODULES);
  const uncovered = new Set(Object.keys(UNCOVERED_CLAIM_MODULES));
  const present = new Set(surfaceModules);
  for (const m of surfaceModules) {
    if (!covered.has(m) && !uncovered.has(m)) {
      out.push(`${m} exports a SurfaceModule but is neither covered by claim evidence nor declared in UNCOVERED_CLAIM_MODULES`);
    }
  }
  for (const m of [...covered, ...uncovered]) {
    if (!present.has(m)) out.push(`${m} is declared but exports no SurfaceModule — a stale declaration`);
    if (covered.has(m) && uncovered.has(m)) out.push(`${m} is declared both covered and uncovered`);
  }
  for (const [m, why] of Object.entries(UNCOVERED_CLAIM_MODULES)) {
    if (!why.trim()) out.push(`${m} is declared uncovered with an empty reason`);
  }
  return out;
}

export interface ClaimEvidenceAnchor {
  claim: string;
  source: string;
  expect: string[];
  reject?: string[];
  npmScopeAbsence?: string;
}

export interface ClaimEvidenceRow {
  slug: string;
  kind: string;
  verifiedAt: string;
  source: string;
  evidence: ClaimEvidenceAnchor[];
}

export interface ClaimEvidenceDoc {
  _generated_by: string;
  schema_version: typeof CLAIM_EVIDENCE_SCHEMA_VERSION;
  corpus: typeof CLAIM_EVIDENCE_CORPUS;
  rows: ClaimEvidenceRow[];
}

function anchorOf(a: LiveClaimEvidence): ClaimEvidenceAnchor {
  // Key order is fixed by construction, and an optional key is emitted only when it carries
  // something — the document is diffed byte-for-byte in CI, so its shape must not depend on how
  // a row happened to be written.
  const out: ClaimEvidenceAnchor = { claim: a.claim, source: a.source, expect: [...a.expect] };
  if (a.reject && a.reject.length > 0) out.reject = [...a.reject];
  if (a.npmScopeAbsence) out.npmScopeAbsence = a.npmScopeAbsence;
  return out;
}

/** The SoT projected ONCE into what the host canary reads. */
export function buildClaimEvidenceDoc(surface: SurfaceModule<EvidencedEntry>): ClaimEvidenceDoc {
  return {
    _generated_by: CLAIM_EVIDENCE_GENERATED_BY,
    schema_version: CLAIM_EVIDENCE_SCHEMA_VERSION,
    corpus: CLAIM_EVIDENCE_CORPUS,
    rows: surface.entries.map((e) => ({
      slug: e.slug,
      kind: e.kind,
      verifiedAt: e.verifiedAt,
      source: e.source,
      evidence: e.evidence.map(anchorOf),
    })),
  };
}

export function serializeClaimEvidenceDoc(doc: ClaimEvidenceDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
