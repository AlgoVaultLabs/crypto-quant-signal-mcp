/**
 * forum-post-gate — the publish gate for auto-generated forum posts.
 *
 * WHY THIS EXISTS (FIX-CONVICTION-CALL-POSTS-W1)
 * ----------------------------------------------
 * `agent-forum-post.ts` had NO content gate. The only word-count reference in the
 * whole file was a `console.log`; nothing ever branched on it. So on 2026-07-31 it
 * published a 61-word post titled "High-conviction call: LINK HOLD at 35% confidence"
 * whose last two lines were, verbatim:
 *
 *     Real-time signals:
 *     Full track record:
 *
 * — two naked labels. The CTAs had been authored as BARE urls, and
 * `stripExternalUrlsForModeration` deletes every bare URL by design. Nothing noticed,
 * for at least two weeks, across FOUR post types.
 *
 * The lane fix was to author CTAs as markdown links. This is the GENERATOR fix: the
 * defect is now impossible to reintroduce silently, because authoring a bare URL FAILS
 * the gate loudly instead of blanking quietly at publish time.
 *
 * DESIGN NOTES, each load-bearing:
 *
 *  - It gates on the STRIPPED body — what actually ships — not the authored one. A
 *    gate that reads the pre-strip draft would have passed the very post that broke.
 *  - It catches the AUTHORING mistake (a bare URL in prose), not just the symptom.
 *    Checking only "did a link survive" would stay green on a post that simply has no
 *    CTA at all.
 *  - It reuses `splitFencedSegments` from the strip module rather than re-implementing
 *    fence parsing, so the gate cannot disagree with the strip about what is code.
 *    (The release post legitimately carries a bare URL inside a fence — that is a
 *    connection string, not a link, and both sides must classify it identically.)
 *  - It emits POSITIVE per-check output. A skipped check and a passing check must not
 *    look alike — that is how the 61-word post looked healthy.
 *  - It is PURE: no network, no filesystem, no env. Fully unit-testable, which the
 *    calling script is not (`main()` is invoked unconditionally at import).
 */

import { splitFencedSegments } from './forum-post-content.js';

/**
 * Minimum words in the SHIPPED body — a SMOKE FLOOR for catastrophically truncated
 * output, NOT the guard that catches the defect this module exists for.
 *
 * ⚠️ CALIBRATION IS MEASURED, AND AN EARLIER GUESS HERE WAS WRONG AND DANGEROUS.
 * The first version of this constant was 120, justified by a comment claiming "the
 * shortest legitimate post this pipeline produces is the quiet-week market scan (~130
 * words)". That was false, and a 120 floor would have PERMANENTLY blocked three of the
 * four post types — turning working weekly posts into hard failures forever. Measured,
 * through this module's own strip + gate, on the real templates:
 *
 *     usage-example (MCP-outage fallback)  42
 *     arb branch, 1 opportunity            74
 *     track-record (structurally fixed)    78   ← every Sunday, invariant
 *     quiet-week market scan              183
 *     scan digest, 3 setups               193
 *     the DEFECTIVE 2026-07-31 post        61   (blank CTAs)
 *
 * 30 is the floor: comfortably below every real template — the 42 above is a
 * RECONSTRUCTION of the outage fallback rather than a captured artifact, so the margin is
 * deliberately wider than the measurement is precise — while still catching an empty or
 * stub body, which is all a length check can honestly claim to catch.
 *
 * Note it does NOT separate the defective post from the legitimate ones: 61 sits ABOVE two
 * real templates. That is the whole point — LENGTH NEVER WAS THE SIGNAL. The 2026-07-31
 * post is rejected by G2 (its CTAs were bare URLs), and G2/G3/G4 are what actually make
 * the class impossible. Do not raise this number to "tighten" the gate; tighten G2-G4
 * instead, and re-measure the table above before touching it at all.
 */
export const MIN_BODY_WORDS = 30;

export interface ForumPostGateInput {
  title: string;
  /** The body as authored, before moderation stripping. */
  rawContent: string;
  /** The body as it will actually be published. */
  strippedContent: string;
  /**
   * Hosts the strip is configured to PRESERVE (canonical domain + any extras).
   *
   * G3 needs this to distinguish two outcomes that look identical in the output but mean
   * opposite things. A link to an allowlisted host that vanished is a DEFECT — we expected
   * it to reach the reader. A link to a non-allowlisted host that got flattened to plain
   * text is the strip WORKING AS DESIGNED (that is its whole job: outbound links become
   * prose). Without this list the gate flags the second case and rejects correct copy —
   * e.g. the release post's GitHub release-notes link.
   *
   * Omitted ⇒ every authored link is required to survive, which is the stricter reading
   * and the right default for a caller that has not told us what it preserves.
   */
  keepHosts?: string[];
}

export interface ForumPostGateResult {
  ok: boolean;
  /** Positive evaluation output — one line per check that RAN, with its measured value. */
  checks: string[];
  failures: string[];
}

/** Markdown links `[text](url)`, prose only.
 *  The optional `"title"` group is NOT decorative: the strip's Pass 1 accepts it
 *  (forum-post-content.ts), so without it here the gate blanks a titled link before the
 *  bare-URL scan and then reports a bare URL for a link the strip demonstrably preserves —
 *  a false G2 rejection of correct copy. The two regexes must accept the same shapes. */
const MD_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g;
/** Bare http(s) URLs. Mirrors the strip's Pass-2 pattern so the two agree exactly. */
const BARE_URL_RE = /https?:\/\/[^\s)>\]]+/g;

/** Concatenated PROSE (fenced code excluded), using the strip's own segmentation. */
function proseOf(markdown: string): string {
  return splitFencedSegments(markdown)
    .filter((s) => s.kind === 'prose')
    .map((s) => s.text)
    .join('');
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Same exact-or-`*.host` rule the strip applies, so the two cannot disagree about which
 *  links were supposed to survive. */
function hostIsAllowlisted(url: string, keepHosts: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return keepHosts.some((h) => {
      const k = h.toLowerCase();
      return host === k || host.endsWith(`.${k}`);
    });
  } catch {
    return false;
  }
}

/**
 * Decide whether a generated post may publish.
 *
 * Fail-CLOSED by construction: every check must pass for `ok` to be true, and a check
 * that cannot be evaluated is a failure, never a skip.
 */
export function checkForumPost(input: ForumPostGateInput): ForumPostGateResult {
  const checks: string[] = [];
  const failures: string[] = [];

  // ── 1. Length of what actually ships ──
  const words = wordCount(input.strippedContent);
  if (words < MIN_BODY_WORDS) {
    failures.push(`G1 length: shipped body is ${words} words, minimum is ${MIN_BODY_WORDS}`);
  } else {
    checks.push(`G1 length: OK (${words} words >= ${MIN_BODY_WORDS})`);
  }

  // ── 2. No bare URL in authored PROSE — it would be silently deleted ──
  // This is the check that makes the original defect impossible to reintroduce.
  const rawProse = proseOf(input.rawContent);
  const bareInProse = (rawProse.replace(MD_LINK_RE, '').match(BARE_URL_RE) ?? []).filter(Boolean);
  if (bareInProse.length > 0) {
    failures.push(
      `G2 bare-url: ${bareInProse.length} bare URL(s) in prose will be DELETED by moderation stripping ` +
        `(${bareInProse.slice(0, 3).join(', ')}) — author them as markdown links [text](url)`,
    );
  } else {
    checks.push('G2 bare-url: OK (no bare URLs in prose)');
  }

  // ── 3. Every link we EXPECTED to survive actually survived ──
  // A link to a non-allowlisted host is reduced to its text by design — that is the strip
  // doing its job. Only a link on a host we said we would PRESERVE is expected to reach
  // the reader, so only that one vanishing is a defect.
  const authored = [...rawProse.matchAll(MD_LINK_RE)].map((m) => m[2]);
  const expected = input.keepHosts
    ? authored.filter((url) => hostIsAllowlisted(url, input.keepHosts!))
    : authored;
  // Scoped to PROSE on both sides. Checking the whole stripped body would let a URL that
  // merely appears inside a code fence vouch for a prose link that was actually flattened —
  // a fence is documentation, not a call to action.
  const shippedProse = proseOf(input.strippedContent);
  const dropped = expected.filter((url) => !shippedProse.includes(url));
  if (dropped.length > 0) {
    failures.push(
      `G3 cta-survival: ${dropped.length} allowlisted link(s) did NOT survive stripping ` +
        `(${dropped.slice(0, 3).join(', ')}) — the host must be allowlisted via StripOptions.keepHosts`,
    );
  } else {
    checks.push(
      `G3 cta-survival: OK (${expected.length}/${expected.length} allowlisted links survive` +
        `${authored.length > expected.length ? `, ${authored.length - expected.length} outbound flattened by design` : ''})`,
    );
  }

  // ── 4. At least one CTA actually reaches the reader ──
  // Without this, a post with NO links passes 2 and 3 vacuously.
  const survivingLinks = [...proseOf(input.strippedContent).matchAll(MD_LINK_RE)].map((m) => m[2]);
  if (survivingLinks.length === 0) {
    failures.push('G4 cta-present: shipped body carries ZERO call-to-action links');
  } else {
    checks.push(`G4 cta-present: OK (${survivingLinks.length} CTA link(s))`);
  }

  // ── 5. A non-empty title ──
  if (!input.title || !input.title.trim()) {
    failures.push('G5 title: empty');
  } else {
    checks.push(`G5 title: OK (${wordCount(input.title)} words)`);
  }

  return { ok: failures.length === 0, checks, failures };
}
