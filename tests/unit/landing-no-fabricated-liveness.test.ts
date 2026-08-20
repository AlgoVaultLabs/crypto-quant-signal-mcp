/**
 * landing-no-fabricated-liveness — PUBLIC-VERIFY-FAKE-FEED-REMOVAL-W1 (2026-08-20)
 *
 * ## The defect class this makes un-shippable
 *
 * "Static mock markup shipped behind a liveness label."
 *
 * A design wave builds a section that LOOKS live — a pulsing dot, a `LIVE` badge, a "last 10"
 * counter — and fills it with hand-written sample rows so the layout can be reviewed. The
 * live-binding never lands. The mock ships, and from then on the page tells every reader and
 * every crawler that fabricated data is a real-time feed.
 *
 * This has now happened twice on brand-canonical surfaces:
 *
 *   1. `landing/index.html` CALL STREAM — fixed BY HAND (DESIGN-W7 / Mr.1 fix-forward
 *      2026-05-10: "rows live-bound via fetchCallStream poller; FEED_BASE placeholders
 *      stripped"). A lane fix: it repaired the instance and left the class alive.
 *   2. `landing/verify.html` "Recent verifications" — a `LIVE · last 10` badge over TEN
 *      fabricated rows (`anonymous` / `VERIFIED` / `#29` / `0x4a2…` / `12s ago`), static
 *      markup with no fetch and no data-binding. It sat on the one page whose entire
 *      argument is "don't trust — verify", and every fabricated row cited Merkle batch #29
 *      while the page's own live header read #132. Removed by this wave.
 *
 * Per CLAUDE.md's generator rule, the second occurrence is where the lane fix stops being
 * acceptable: this file is the gate. Cases that inherit protection for free — any future
 * `/verify` redesign, any new integrations page with a mock activity feed, any AOE or
 * dashboard surface prototyped with sample rows, and any landing page re-baked by
 * `ops/cron/snapshot-landing-daily.sh` where a literal is replaced but a mock block survives.
 *
 * ## The predicate
 *
 * A fragment REDS when all three hold:
 *
 *   (a) it carries a LIVENESS marker — the `live-pulse` class, or `LIVE` standing alone as a
 *       status label; AND
 *   (b) it carries >= 3 FABRICATED-ROW markers — the literal `anonymous`, a relative
 *       timestamp (`12s ago`), or the placeholder hash prefix `0x4a2`; AND
 *   (c) it carries NO data-binding attribute (`data-tr-field=` / `data-w7-`).
 *
 * (c) is what separates a mock from a skeleton: a live-bound feed's placeholder rows are
 * legitimate, because a poller replaces them. The known-good CALL STREAM block passes on
 * BOTH legs — it binds `data-w7-call-stream-rows` 306 chars from its liveness label, and it
 * carries zero fabricated rows.
 *
 * ## Why the window is what it is
 *
 * `landing/*.html` is minified: one artboard is a single ~35 KB line holding several
 * unrelated sections, so line-based fragmentation is meaningless here and section-tag
 * fragmentation would lump a mock `<div>` in with a legitimate binding elsewhere in the same
 * `<section>`. The fragment is therefore a +/- WINDOW character span anchored on each
 * liveness marker.
 *
 * WINDOW was swept 1500 / 2000 / 3000 / 4000 / 6000 against the whole corpus on 2026-08-20.
 * Every value in that band gave the same answer in both directions — 0 violations on the
 * post-deletion tree, 2 on the pre-deletion `verify.html` (one per render path) — so 3000 is
 * the middle of a flat band, not a fitted constant.
 *
 * ## Comments are blanked before the scan
 *
 * CLAUDE.md build rules: "Strip comments before grepping source for a banned construct — a
 * gate asserting a ban false-positives on the script's own docblock quoting the historical
 * buggy form, and the explanatory prose is the most valuable line in the file."
 *
 * Live example, and the reason this is not theoretical: the CALL STREAM poller's own comment
 * explains the bug it fixed and quotes `"57s ago" -> "1m ago"`. Un-blanked, that prose is the
 * ONLY fabricated-marker hit anywhere in the clean corpus. Blanked, the clean tree scores
 * ZERO in every liveness window — so a future wave documenting this very defect cannot be
 * made to red by describing it.
 *
 * Blanking replaces comment bytes with spaces of equal length, so every offset in a
 * diagnostic still points at the real file. Only HTML comments, `/* *\/` blocks, and
 * LINE-LEADING `//` comments are blanked — a `//` mid-line is left alone, because blanking to
 * end-of-line there would eat real markup after a URL and turn a false positive into a silent
 * false negative.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANDING = join(REPO_ROOT, 'landing');

/** +/- span around a liveness marker that counts as one fragment. See the docblock's sweep. */
const WINDOW = 3000;

/** How many fabricated-row markers make a fragment a mock feed rather than a stray literal. */
const MIN_FABRICATED_MARKERS = 3;

/**
 * `live-pulse` is the pulsing-dot class. Bare `LIVE` is matched only when it stands alone —
 * `>LIVE<`, `LIVE · last 10`, `CALL STREAM · LIVE` — never inside a longer token, so
 * `LIVENESS` and `DELIVERED` cannot trip it.
 */
const LIVENESS_MARKER = /live-pulse|(?<![A-Za-z0-9_-])LIVE(?![A-Za-z0-9_-])/g;

/** The three shapes a hand-written sample row uses. Labelled so a red says WHICH fired. */
const FABRICATED_ROW_MARKERS: Array<[string, RegExp]> = [
  ['anonymous attribution', /anonymous/gi],
  ['relative timestamp', /\b\d+[smh] ago\b/g],
  ['placeholder hash (0x4a2…)', /0x4a2/g],
];

/** Presence of either attribute means a poller owns these rows — a skeleton, not a mock. */
const DATA_BINDING = /data-tr-field=|data-w7-/;

const blankOut = (s: string) => s.replace(/[^\n]/g, ' ');

/** Blank comments IN PLACE (equal length), so offsets in diagnostics stay true to the file. */
export function blankComments(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, blankOut);
  out = out.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open: string, body: string, close: string) =>
      open +
      body.replace(/\/\*[\s\S]*?\*\//g, blankOut).replace(/^[ \t]*\/\/[^\n]*/gm, blankOut) +
      close,
  );
  return out;
}

export type FabricatedFeed = {
  offset: number;
  liveness: string;
  markers: Record<string, number>;
  total: number;
  excerpt: string;
};

/** The detector. Pure over one page's HTML so both directions are testable without fixtures on disk. */
export function findFabricatedFeeds(rawHtml: string): FabricatedFeed[] {
  const html = blankComments(rawHtml);
  const found: FabricatedFeed[] = [];
  for (const m of html.matchAll(LIVENESS_MARKER)) {
    const at = m.index ?? 0;
    const fragment = html.slice(Math.max(0, at - WINDOW), at + WINDOW);
    const markers: Record<string, number> = {};
    let total = 0;
    for (const [label, re] of FABRICATED_ROW_MARKERS) {
      const n = fragment.match(re)?.length ?? 0;
      if (n > 0) markers[label] = n;
      total += n;
    }
    if (total >= MIN_FABRICATED_MARKERS && !DATA_BINDING.test(fragment)) {
      found.push({
        offset: at,
        liveness: m[0],
        markers,
        total,
        excerpt: rawHtml.slice(at, at + 160).replace(/\s+/g, ' '),
      });
    }
  }
  return found;
}

/** Every landing page, RECURSIVELY — `landing/integrations/*.html` is a surface too. */
function landingPages(): { name: string; html: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : [],
    );
  return walk(LANDING)
    .sort()
    .map((p) => ({ name: relative(REPO_ROOT, p), html: readFileSync(p, 'utf-8') }));
}

/**
 * A synthetic reconstruction of the block this wave deleted — same shape, same markers, no
 * binding. It is a FIXTURE, deliberately not a copy of the removed markup: the point is that
 * the SHAPE reds, so a future mock feed with different sample values reds too.
 */
const FABRICATED_FIXTURE = `<section style="padding:0 80px 80px"><div><span class="live-pulse"></span>· Agent Verification Records</div>
<h2>Recent verifications</h2><span>LIVE · last 10</span>
<div><span>anonymous</span><span>VERIFIED</span><span>#29</span><span>0x4a2…f91</span><span>12s ago</span></div>
<div><span>anonymous</span><span>VERIFIED</span><span>#29</span><span>0x4a2…c30</span><span>48s ago</span></div>
<div><span>anonymous</span><span>VERIFIED</span><span>#29</span><span>0x4a2…7b1</span><span>14m ago</span></div></section>`;

/** The same feed once a poller owns it — the CALL STREAM shape. Must NOT red. */
const LIVE_BOUND_FIXTURE = FABRICATED_FIXTURE.replace(
  '<h2>Recent verifications</h2>',
  '<h2>Recent verifications</h2><div data-w7-call-stream-rows></div>',
);

/** The CALL STREAM docblock shape — prose ABOUT the defect, inside a script comment. */
const COMMENTED_PROSE_FIXTURE = `<div><span class="live-pulse"></span>LIVE</div><script>
  // panel re-renders the identical row with only "57s ago" → "1m ago" updating, and the
  // pre-fix build showed "anonymous" for every leaf plus a "0x4a2…" placeholder hash.
  var x = 1;
</script>`;

describe('landing pages carry no fabricated liveness feed', () => {
  it('the detector fires on a mock feed behind a liveness label', () => {
    const hits = findFabricatedFeeds(FABRICATED_FIXTURE);
    expect(hits.length, 'the shape this wave removed MUST red').toBeGreaterThan(0);
    expect(hits[0].total).toBeGreaterThanOrEqual(MIN_FABRICATED_MARKERS);
    expect(Object.keys(hits[0].markers).sort()).toEqual([
      'anonymous attribution',
      'placeholder hash (0x4a2…)',
      'relative timestamp',
    ]);
  });

  it('the detector does NOT fire once a poller binds the rows', () => {
    // Same markers, same liveness label — only the binding differs. If this ever reds, the
    // guard has stopped distinguishing a mock from a skeleton and will force live feeds out.
    expect(findFabricatedFeeds(LIVE_BOUND_FIXTURE)).toEqual([]);
  });

  it('the detector does NOT fire on prose describing the defect in a comment', () => {
    // Un-blanked this fixture scores 4 markers with no binding — i.e. it would red. The
    // comment-stripping is what makes documenting this bug class safe.
    expect(findFabricatedFeeds(COMMENTED_PROSE_FIXTURE)).toEqual([]);
    expect(blankComments(COMMENTED_PROSE_FIXTURE)).toHaveLength(COMMENTED_PROSE_FIXTURE.length);
  });

  it('the detector does NOT fire on fewer than three markers', () => {
    // A stray literal near a liveness badge is not a feed. Two must pass, three must red —
    // asserted on the boundary so the threshold cannot drift silently.
    const twoMarkers = `<span class="live-pulse"></span>LIVE<div>anonymous · 12s ago</div>`;
    expect(findFabricatedFeeds(twoMarkers)).toEqual([]);
    // One hit PER liveness marker, and this fixture carries two (`live-pulse` and `LIVE`).
    // Reported per-marker on purpose: a red should name every label it fired under.
    expect(findFabricatedFeeds(`${twoMarkers}<div>0x4a2…f91</div>`).map((h) => h.liveness)).toEqual([
      'live-pulse',
      'LIVE',
    ]);
  });

  it('the corpus is non-empty and the guard actually scans liveness markers', () => {
    // Vacuity guard where the corpus is CONSTRUCTED: an empty walk, a renamed directory or a
    // liveness class that no longer matches would all make the sweep below pass having
    // verified nothing.
    const pages = landingPages();
    expect(pages.length, 'landing/**/*.html walked to zero pages').toBeGreaterThan(20);
    expect(pages.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        join('landing', 'verify.html'),
        join('landing', 'index.html'),
        join('landing', 'integrations', 'binance.html'),
      ]),
    );

    const livenessWindows = pages.reduce(
      (n, p) => n + (blankComments(p.html).match(LIVENESS_MARKER)?.length ?? 0),
      0,
    );
    expect(livenessWindows, 'no liveness marker matched anywhere — the guard is dark').toBeGreaterThan(0);
  });

  it('the known-good CALL STREAM block is present, so the guard stays calibrated', () => {
    // The one live-bound feed in the corpus. If it is renamed or removed, the "does not fire
    // on a bound feed" leg above stops describing anything real and this should be re-tuned.
    const index = readFileSync(join(LANDING, 'index.html'), 'utf-8');
    expect(index).toContain('data-w7-call-stream-rows');
    expect(index).toContain('CALL STREAM · LIVE');
    expect(findFabricatedFeeds(index)).toEqual([]);
  });

  it('no landing page pairs a liveness label with fabricated rows', () => {
    const pages = landingPages();
    const offenders: string[] = [];
    for (const { name, html } of pages) {
      for (const hit of findFabricatedFeeds(html)) {
        const which = Object.entries(hit.markers)
          .map(([label, n]) => `${label} x${n}`)
          .join(', ');
        offenders.push(
          `${name} @${hit.offset} — liveness ${JSON.stringify(hit.liveness)} + ${hit.total} ` +
            `fabricated-row markers (${which}) with NO data-binding\n      ${hit.excerpt}`,
        );
      }
    }
    expect(
      offenders,
      `Fabricated liveness feed(s) found across ${pages.length} landing pages.\n` +
        `A block may show a liveness label ONLY if a poller binds its rows ` +
        `(data-tr-field= / data-w7-). Bind it or delete it — do not relabel it.\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
