/**
 * OPS-CLIENT-CLAIM-EVIDENCE-W1 CH1 — the binding test: every load-bearing sentence an mcp-clients
 * row RENDERS is bound, by type and by this test, to the live page that makes it true.
 *
 * THE BUG CLASS. A public integration claim whose truth was recorded as a hand-typed date pages
 * on a calendar when nothing changed, and stays silent when the vendor changes the thing we tell
 * readers to type. Measured 2026-09-29: the daily canary paged five rows on age alone — three of
 * them fully true — while two rows whose own sources now CONTRADICT them sat at `ok`. The date
 * measured a human; nothing measured the claim.
 *
 * WHAT THIS PINS (no network — the live half is ops/monitoring/client-claim-freshness.py):
 *   R1  every row carries ≥ 1 evidence entry, in the SoT and in the emitted JSON
 *   R2  every `claim` is a verbatim substring of the whitespace-collapsed rendered row text, so a
 *       copy edit that removes a claimed sentence fails CI until its evidence follows it
 *   R3  every `source` is an absolute https URL
 *   R4  every expect/reject token is distinctive — the retired `mcp`-count proxy cannot come back
 *   R5  the committed claim-evidence.json is byte-for-byte the emitter's output (lockstep)
 *   R6  hand-typed "verified <date> against <url>" twins in the tutorials agree with the SoT row
 *   R7  every claim-bearing integrations-data module is covered, or declared uncovered with a
 *       reason — a new module cannot appear silently
 *
 * Every rule is asserted TWO-WAY: once over the real SoT (must be clean) and once over a
 * synthetic broken fixture (must fire). A rule proven only on the clean side is a rule nobody
 * has seen fail.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import MCP_CLIENTS from '../../src/lib/integrations-data/mcp-clients.js';
import type { EvidencedEntry, SurfaceModule } from '../../src/lib/integrations-data/types.js';
import {
  CLAIM_EVIDENCE_CORPUS,
  CLAIM_EVIDENCE_JSON,
  CLAIM_EVIDENCE_SCHEMA_VERSION,
  COVERED_CLAIM_MODULES,
  EXPECT_STOPLIST,
  MIN_ANCHOR_TOKEN_LENGTH,
  UNCOVERED_CLAIM_MODULES,
  VERIFIED_TWIN_RE,
  anchorTokenProblem,
  buildClaimEvidenceDoc,
  collapseWhitespace,
  evidenceProblems,
  isAbsoluteHttpsUrl,
  moduleCoverageProblems,
  serializeClaimEvidenceDoc,
  verifiedTwinProblems,
} from '../../src/lib/integrations-data/claim-evidence.js';
// The ONE derivation of reader-visible row text. Imported, never re-implemented: a second copy
// here would be a second thing that can disagree with what the copy gate sees.
import { renderedRowText } from '../../scripts/check-mcp-client-copy.mjs';

const REPO = join(__dirname, '..', '..');
const DATA_DIR = join(REPO, 'src', 'lib', 'integrations-data');
const TUTORIAL_DIR = join(REPO, 'docs', 'integrations', 'mcp-clients');

const ENTRIES = MCP_CLIENTS.entries as EvidencedEntry[];
const render = (e: EvidencedEntry) => renderedRowText(e) as string;

/** A minimal, valid row the broken fixtures below each damage in exactly one way. */
function fixtureRow(over: Partial<EvidencedEntry> = {}): EvidencedEntry {
  return {
    slug: 'fixture',
    displayName: 'Fixture',
    surfaceType: 'mcp-client',
    setupSummary: 'Run <code>fixture add --flag</code>',
    whatYouGet: 'Things.',
    walkthroughHtml: '<p>Edit <code>~/.fixture/config.toml</code> &rarr; save.</p>',
    fullTutorialUrl: '',
    hasDedicatedPage: false,
    kind: 'native',
    source: 'https://vendor.example/docs',
    verifiedAt: '2026-09-01',
    evidence: [{ claim: 'fixture add --flag', source: 'https://vendor.example/docs', expect: ['fixture add'] }],
    ...over,
  } as EvidencedEntry;
}

const rules = (entries: EvidencedEntry[]) => evidenceProblems(entries, render).map((p) => p.rule);

describe('vacuity — the corpus this test binds is not empty', () => {
  it('mcp-clients has rows and anchors', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(8);
    expect(ENTRIES.reduce((n, e) => n + e.evidence.length, 0)).toBeGreaterThanOrEqual(ENTRIES.length);
  });
});

describe('the real SoT satisfies R1–R4', () => {
  it('evidenceProblems() reports nothing for any mcp-clients row', () => {
    const problems = evidenceProblems(ENTRIES, render);
    expect(problems, problems.map((p) => `${p.rule} ${p.slug}: ${p.detail}`).join('\n')).toEqual([]);
  });
});

describe('R1 — every row carries evidence', () => {
  it('fires on a row whose evidence list is empty', () => {
    const broken = fixtureRow({ evidence: [] as unknown as EvidencedEntry['evidence'] });
    expect(rules([broken])).toContain('R1');
  });

  it('fires on a row with no evidence property at all', () => {
    const broken = fixtureRow();
    delete (broken as { evidence?: unknown }).evidence;
    expect(rules([broken])).toContain('R1');
  });
});

describe('R2 — a claim is a verbatim substring of what the row renders', () => {
  it('fires when the claim is not in the rendered text (copy moved, evidence did not follow)', () => {
    const broken = fixtureRow({
      evidence: [{ claim: 'fixture remove --flag', source: 'https://vendor.example/docs', expect: ['fixture add'] }],
    });
    expect(rules([broken])).toContain('R2');
  });

  it('matches against the whitespace-collapsed, entity-decoded text a reader sees', () => {
    // `&rarr;` decodes to → and the tag boundaries collapse to single spaces.
    const ok = fixtureRow({
      evidence: [{ claim: '~/.fixture/config.toml → save.', source: 'https://vendor.example/docs', expect: ['config.toml'] }],
    });
    expect(rules([ok])).not.toContain('R2');
  });
});

describe('R3 — every source is an absolute https URL', () => {
  it.each(['http://vendor.example/docs', 'vendor.example/docs', '/docs/mcp', ''])(
    'fires on %j', (src) => {
      const broken = fixtureRow({ evidence: [{ claim: 'fixture add --flag', source: src, expect: ['fixture add'] }] });
      expect(rules([broken])).toContain('R3');
    },
  );

  it('the predicate accepts https and rejects everything else', () => {
    expect(isAbsoluteHttpsUrl('https://cursor.com/docs/mcp')).toBe(true);
    expect(isAbsoluteHttpsUrl('http://cursor.com/docs/mcp')).toBe(false);
    expect(isAbsoluteHttpsUrl('https://')).toBe(false);
  });
});

describe('R4 — expect/reject tokens are distinctive', () => {
  it('the stoplist is the declared one and the floor is 4', () => {
    expect([...EXPECT_STOPLIST].sort()).toEqual(
      ['MCP', 'client', 'clients', 'config', 'docs', 'http', 'https', 'json', 'mcp', 'server', 'servers', 'tool', 'tools'],
    );
    expect(MIN_ANCHOR_TOKEN_LENGTH).toBe(4);
  });

  it.each([
    ['mcp', 'shorter'],
    ['MCP ', 'shorter'],
    ['servers', 'stoplist'],
    ['Tools', 'stoplist'],
    ['https', 'stoplist'],
    ['fixture  add', 'whitespace'],
    [' fixture add', 'whitespace'],
  ])('rejects %j (%s)', (token, why) => {
    const problem = anchorTokenProblem(token);
    expect(problem).not.toBeNull();
    expect(problem!.toLowerCase()).toContain(why === 'shorter' ? 'shorter' : why === 'stoplist' ? 'stoplist' : 'whitespace');
  });

  it.each(['--url', '.mcp.json', '"status":"ok"', 'mcp_servers Ignored', 'claude mcp add --transport http'])(
    'accepts %j', (token) => {
      expect(anchorTokenProblem(token)).toBeNull();
    },
  );

  it('fires on a weak expect AND on a weak reject', () => {
    const weakExpect = fixtureRow({ evidence: [{ claim: 'fixture add --flag', source: 'https://vendor.example/docs', expect: ['mcp'] }] });
    const weakReject = fixtureRow({
      evidence: [{ claim: 'fixture add --flag', source: 'https://vendor.example/docs', expect: ['fixture add'], reject: ['tool'] }],
    });
    expect(rules([weakExpect])).toContain('R4');
    expect(rules([weakReject])).toContain('R4');
  });

  it('fires on an empty expect list and on an npmScopeAbsence that is not an npm scope', () => {
    const noExpect = fixtureRow({
      evidence: [{ claim: 'fixture add --flag', source: 'https://vendor.example/docs', expect: [] as unknown as [string] }],
    });
    const badScope = fixtureRow({
      evidence: [{ claim: 'fixture add --flag', source: 'https://vendor.example/docs', expect: ['fixture add'], npmScopeAbsence: 'vendor' }],
    });
    const goodScope = fixtureRow({
      evidence: [{ claim: 'fixture add --flag', source: 'https://vendor.example/docs', expect: ['fixture add'], npmScopeAbsence: '@vendor-ai' }],
    });
    expect(rules([noExpect])).toContain('R4');
    expect(rules([badScope])).toContain('R4');
    expect(rules([goodScope])).toEqual([]);
  });
});

describe('R5 — the committed JSON is the emitter output of the SoT (lockstep)', () => {
  const jsonPath = join(REPO, CLAIM_EVIDENCE_JSON);

  it('claim-evidence.json exists at the declared path', () => {
    expect(existsSync(jsonPath), `${CLAIM_EVIDENCE_JSON} missing — run npm run claims:evidence`).toBe(true);
  });

  it('is byte-identical to serializeClaimEvidenceDoc(buildClaimEvidenceDoc(MCP_CLIENTS))', () => {
    const committed = readFileSync(jsonPath, 'utf8');
    const expected = serializeClaimEvidenceDoc(buildClaimEvidenceDoc(MCP_CLIENTS as SurfaceModule<EvidencedEntry>));
    expect(committed, 'claim-evidence.json is stale — run npm run claims:evidence and commit it').toBe(expected);
    expect(JSON.parse(committed)).toEqual(buildClaimEvidenceDoc(MCP_CLIENTS as SurfaceModule<EvidencedEntry>));
  });

  it('R1 on the emitted artifact: same rows, same order, each with ≥ 1 anchor', () => {
    const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(doc.schema_version).toBe(CLAIM_EVIDENCE_SCHEMA_VERSION);
    expect(doc.corpus).toBe(CLAIM_EVIDENCE_CORPUS);
    expect(doc.rows.map((r: { slug: string }) => r.slug)).toEqual(ENTRIES.map((e) => e.slug));
    for (const r of doc.rows) expect(r.evidence.length, `${r.slug} emitted with zero evidence`).toBeGreaterThan(0);
  });

  it('the doc shape is stable: key order fixed, optional keys only when present', () => {
    const doc = buildClaimEvidenceDoc({
      meta: MCP_CLIENTS.meta,
      entries: [
        fixtureRow({
          evidence: [
            { claim: 'fixture add --flag', source: 'https://a.example/x', expect: ['fixture add'], reject: [] },
            { claim: 'fixture add --flag', source: 'https://b.example/y', expect: ['fixture add'], reject: ['--url'], npmScopeAbsence: '@vendor' },
          ],
        }),
      ],
    });
    expect(Object.keys(doc)).toEqual(['_generated_by', 'schema_version', 'corpus', 'rows']);
    expect(Object.keys(doc.rows[0])).toEqual(['slug', 'kind', 'verifiedAt', 'source', 'evidence']);
    expect(Object.keys(doc.rows[0].evidence[0])).toEqual(['claim', 'source', 'expect']);
    expect(Object.keys(doc.rows[0].evidence[1])).toEqual(['claim', 'source', 'expect', 'reject', 'npmScopeAbsence']);
    expect(serializeClaimEvidenceDoc(doc).endsWith('}\n')).toBe(true);
  });
});

describe('R6 — hand-typed "verified … against" twins agree with the SoT row', () => {
  const bySlug = new Map(ENTRIES.map((e) => [e.slug, e]));

  it('every twin line in docs/integrations/mcp-clients carries the row\'s verifiedAt and source', () => {
    const problems: string[] = [];
    for (const f of readdirSync(TUTORIAL_DIR).filter((n) => n.endsWith('.md'))) {
      const slug = basename(f, '.md');
      problems.push(...verifiedTwinProblems(slug, readFileSync(join(TUTORIAL_DIR, f), 'utf8'), bySlug.get(slug)));
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('the matcher reads both live spellings', () => {
    expect(VERIFIED_TWIN_RE.test('> *Config verified 2026-08-05 against <https://x.example>.*')).toBe(true);
    expect(VERIFIED_TWIN_RE.test('> *Verified 2026-08-29 against `dsh` 0.1.1-rc.2 and <https://x.example>.*')).toBe(true);
    expect(VERIFIED_TWIN_RE.test('> *Snapshot 2026-05-19 — nothing here.*')).toBe(false);
  });

  it('fires on a wrong date, on a missing source, and on a twin with no SoT row', () => {
    const row = fixtureRow({ verifiedAt: '2026-09-01', source: 'https://vendor.example/docs' });
    const good = '> *Config verified 2026-09-01 against <https://vendor.example/docs>.*\n';
    expect(verifiedTwinProblems('fixture', good, row)).toEqual([]);
    expect(verifiedTwinProblems('fixture', good.replace('2026-09-01', '2026-04-30'), row).length).toBe(1);
    expect(verifiedTwinProblems('fixture', good.replace('vendor.example/docs', 'other.example'), row).length).toBe(1);
    expect(verifiedTwinProblems('fixture', good, undefined).length).toBe(1);
  });
});

describe('R7 — every claim-bearing module is covered or declared uncovered', () => {
  it('covered and uncovered are disjoint, and every uncovered module states a reason', () => {
    for (const m of COVERED_CLAIM_MODULES) expect(Object.keys(UNCOVERED_CLAIM_MODULES)).not.toContain(m);
    for (const [m, why] of Object.entries(UNCOVERED_CLAIM_MODULES)) expect(why.trim(), `${m} has no reason`).not.toBe('');
    expect(COVERED_CLAIM_MODULES).toContain(CLAIM_EVIDENCE_CORPUS);
  });

  it('every src/lib/integrations-data module exporting a SurfaceModule is accounted for', async () => {
    const surfaceModules: string[] = [];
    for (const f of readdirSync(DATA_DIR).filter((n) => n.endsWith('.ts'))) {
      const mod = await import(pathToFileURL(join(DATA_DIR, f)).href);
      const exportsSurface = Object.values(mod).some(
        (v) => !!v && typeof v === 'object' && 'meta' in (v as object) && Array.isArray((v as { entries?: unknown }).entries),
      );
      if (exportsSurface) surfaceModules.push(basename(f, '.ts'));
    }
    // Vacuity: the detector must see today's three surfaces, or it is measuring itself.
    expect(surfaceModules.sort()).toEqual(expect.arrayContaining(['ai-agents', 'exchange-kits', 'mcp-clients']));
    expect(moduleCoverageProblems(surfaceModules)).toEqual([]);
  });

  it('fires on a new surface module nobody declared, and on a stale uncovered entry', () => {
    expect(moduleCoverageProblems(['mcp-clients', 'ai-agents', 'exchange-kits', 'brand-new-surface']).join('\n'))
      .toContain('brand-new-surface');
    expect(moduleCoverageProblems(['mcp-clients', 'ai-agents']).join('\n')).toContain('exchange-kits');
  });
});

describe('collapseWhitespace — the one normaliser both sides of R2 use', () => {
  it('collapses runs and trims', () => {
    expect(collapseWhitespace('  a \n\t b  ')).toBe('a b');
  });
});
