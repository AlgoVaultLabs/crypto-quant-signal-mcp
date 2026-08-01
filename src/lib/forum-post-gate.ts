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
 * Minimum words in the SHIPPED body. Calibrated against the real corpus rather than
 * guessed: the defective post was 61 words, and the shortest legitimate post this
 * pipeline produces is the quiet-week market scan (~130 words incl. its CTAs). 120
 * sits between them with margin on both sides. It is deliberately NOT the editorial
 * pipeline's 1200 — that is a different product (long-form GEO posts); these are short
 * data notes and holding them to a long-form floor would block every one of them.
 */
export const MIN_BODY_WORDS = 120;

export interface ForumPostGateInput {
  title: string;
  /** The body as authored, before moderation stripping. */
  rawContent: string;
  /** The body as it will actually be published. */
  strippedContent: string;
}

export interface ForumPostGateResult {
  ok: boolean;
  /** Positive evaluation output — one line per check that RAN, with its measured value. */
  checks: string[];
  failures: string[];
}

/** Markdown links `[text](url)`, prose only. */
const MD_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
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

  // ── 3. Every authored link SURVIVES the strip ──
  // A link to a non-allowlisted host is reduced to its text, dropping the URL. That is
  // the silent-blanking shape, one level up.
  const authored = [...rawProse.matchAll(MD_LINK_RE)].map((m) => m[2]);
  const dropped = authored.filter((url) => !input.strippedContent.includes(url));
  if (dropped.length > 0) {
    failures.push(
      `G3 cta-survival: ${dropped.length} authored link(s) did NOT survive stripping ` +
        `(${dropped.slice(0, 3).join(', ')}) — the host must be allowlisted via StripOptions.keepHosts`,
    );
  } else {
    checks.push(`G3 cta-survival: OK (${authored.length}/${authored.length} authored links survive)`);
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
