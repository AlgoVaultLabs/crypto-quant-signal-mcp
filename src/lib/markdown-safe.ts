/**
 * PURE Markdown/length primitives shared by every Telegram producer.
 *
 * Lives apart from `telegram.ts` on purpose: `geo-digest.ts` and friends declare
 * themselves PURE leaves (no DB, no Telegram, no Date), so they must be able to
 * neutralise an interpolated value without importing the transport — which reads
 * credentials at module load. `telegram.ts` re-exports everything here, so every
 * existing importer is unchanged.
 */

/**
 * Render a dynamic value so Markdown cannot mis-parse it (SEC-17).
 *
 * Telegram's LEGACY `Markdown` parse mode has no escape syntax — that is precisely why
 * MarkdownV2 exists — so a backslash does not help. A code span does: content inside
 * backticks is literal, so `_`, `*` and `[` in an interpolated value stop being entity
 * starters. Backticks in the value itself are stripped, since they would close the span.
 *
 * The concrete incident: the weekly knowledge-page digest interpolated the source name
 * `github_discussion`, whose single `_` opened an italic entity that never closed. Every
 * POST returned HTTP 400 `can't parse entities … at byte offset 168` (byte-exact) for
 * three consecutive weeks while the producer logged "digest sent".
 */
export function mdValue(value: unknown): string {
  return `\`${String(value).replace(/`/g, '')}\``;
}

/**
 * Telegram `sendMessage` hard limit, in UTF-16 code units — exactly what JS
 * `.length` counts and what the Bot API measures.
 *
 * MEASURED, never assumed. The GEO weekly digest crossed this limit as its
 * section count grew 39 → 67 → 69, and from 2026-07-20 the operator received
 * NOTHING for six consecutive Mondays: the Markdown POST returned
 * `400 message is too long`, and the plain-text fallback below — the one safety
 * net — returned the SAME error, because dropping `parse_mode` does not make a
 * message shorter. Dry-run measurement on 2026-08-26: 5,583 UTF-16 units,
 * 1,487 over. `sendDigest` joined its sections and posted them as ONE message
 * with no chunker, so every producer sharing it inherited a silent size cliff.
 */
export const TELEGRAM_MAX_MESSAGE = 4096;

/** Room reserved for the `— part i/n` marker when a digest spans >1 message. */
const PART_MARKER_RESERVE = 24;

/**
 * Split one over-long section at LINE boundaries; a single over-long line is
 * cut at the limit. Nothing is ever dropped — an operator digest that silently
 * loses its tail is the failure this whole module exists to prevent.
 */
function hardSplit(text: string, limit: number): string[] {
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > limit) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      out.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    const candidate = buf ? `${buf}\n${rest}` : rest;
    if (candidate.length > limit) {
      if (buf) out.push(buf);
      buf = rest;
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Greedily pack sections into `\n\n`-joined messages of at most `limit` units. */
function pack(sections: string[], limit: number): string[] {
  const out: string[] = [];
  let buf = '';
  for (const section of sections) {
    const pieces = section.length > limit ? hardSplit(section, limit) : [section];
    for (const piece of pieces) {
      const candidate = buf ? `${buf}\n\n${piece}` : piece;
      if (candidate.length > limit) {
        if (buf) out.push(buf);
        buf = piece;
      } else {
        buf = candidate;
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Sections → one or more messages, each within `limit`. Splits on SECTION
 * boundaries first so a chunk stays readable; only a section that is itself
 * over-long gets cut mid-body.
 *
 * When the result spans several messages every one carries `— part i/n`, so a
 * truncated delivery is visible to the operator instead of looking complete.
 * The marker is budgeted by re-packing against a reduced limit — appending it
 * afterwards could otherwise push a chunk back over the very limit we are
 * enforcing.
 */
export function chunkSections(sections: string[], limit = TELEGRAM_MAX_MESSAGE): string[] {
  const clean = sections.filter((s) => typeof s === 'string');
  if (clean.length === 0) return [];
  const single = pack(clean, limit);
  if (single.length <= 1) return single;
  const parts = pack(clean, Math.max(1, limit - PART_MARKER_RESERVE));
  return parts.map((p, i) => `${p}\n\n— part ${i + 1}/${parts.length}`);
}

/**
 * Does `text` carry an UNCLOSED legacy-Markdown entity, i.e. will Telegram
 * reject it with `can't parse entities`?
 *
 * This is the STRUCTURAL half of the `mdValue()` lesson. `mdValue` fixes one
 * call site; this fixes the class, for every producer, whatever data flows
 * through — because legacy `Markdown` has no escape syntax, an odd `*`/`_`/`` ` ``
 * is unconditionally fatal, and the same defect has now cost two different
 * digests (`github_discussion` in the knowledge-page digest, `pursue_placement`
 * in the GEO digest) three-plus weeks each while the producer looked healthy.
 *
 * Deliberately conservative: it decides only "send as plain text or not", so a
 * false positive costs formatting, never delivery. The reactive fallback in
 * `post()` still covers what this does not model (an unclosed `[`).
 */
export function hasUnbalancedMarkdown(text: string): boolean {
  // An odd backtick count leaves a code span open — check before stripping,
  // since the strip below would swallow the evidence.
  if ((text.match(/`/g) ?? []).length % 2 === 1) return true;
  // Code spans and fences are LITERAL: a `_` inside one is not an entity start.
  const bare = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return (bare.match(/\*/g) ?? []).length % 2 === 1 || (bare.match(/_/g) ?? []).length % 2 === 1;
}
