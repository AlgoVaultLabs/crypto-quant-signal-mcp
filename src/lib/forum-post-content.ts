/**
 * forum-post-content — helpers for shaping post bodies for forum platforms.
 *
 * Background: Hashnode's anti-spam moderation silently removes posts that
 * carry multiple external URLs in the body on low-follower publications
 * (per audit 2026-04-15). Moltbook auto-flags the same posts as
 * `is_spam: true` while the agent is unverified. The shared mitigation is
 * to strip external markdown links + bare URLs from the body before
 * sending to those platforms. Dev.to is healthy and can keep the full body
 * (and still gets `canonical_url` set separately).
 *
 * This module is pure — no network, no filesystem, no side effects. All
 * branches are covered by `tests/forum-post-content.test.ts`.
 */

export interface StripOptions {
  /**
   * Allowlisted canonical domain. Markdown links whose hostname matches
   * this domain (exact or `*.domain`) are kept intact. All other external
   * URLs (both markdown-linked and bare) are stripped from the body.
   *
   * Example: `{ keepCanonicalDomain: 'algovault.com' }` preserves
   * `[track record](https://algovault.com/track-record)` but strips
   * `[support](https://hashnode.com/support)`.
   */
  keepCanonicalDomain?: string;
  /**
   * FIX-CONVICTION-CALL-POSTS-W1: ADDITIONAL allowlisted hosts, matched by the
   * same exact-or-`*.host` rule as `keepCanonicalDomain`. Omitted ⇒ undefined ⇒
   * behaviour byte-identical to before this option existed.
   *
   * This is an allowlist EXTENSION, never a relaxation: everything not named
   * here is still stripped, and a bare URL is still deleted even for an
   * allowlisted host (rule 3 is unchanged — intent must be expressed as markup).
   *
   * It exists because our PRIMARY call-to-action is the Telegram bot, which by
   * definition cannot live on the canonical domain. Without an explicit entry a
   * `[…](https://t.me/algovaultofficialbot)` link is reduced to its link TEXT and
   * the handle disappears entirely — strictly worse than a bare URL, because the
   * reader is left with no way to reach the bot at all.
   *
   * Keep this list SHORT and first-party. Every entry is a host we control and
   * publish under; it is not a general escape hatch for outbound links.
   */
  keepHosts?: string[];
}

/**
 * Strip external markdown links and bare URLs from a post body, while
 * preserving anything inside fenced code blocks.
 *
 * Rules, in order:
 *   1. Code blocks (```…``` or ~~~…~~~) are treated as opaque — content
 *      inside them is passed through untouched regardless of URLs.
 *   2. Outside code blocks, markdown links `[text](url)` are replaced with
 *      just `text`, unless the URL's hostname matches `opts.keepCanonicalDomain`
 *      or any entry in `opts.keepHosts`, in which case the full link is kept.
 *   3. Outside code blocks, bare http(s):// URLs are deleted (replaced
 *      with an empty string). Canonical-domain bare URLs are also
 *      stripped — the back-link should be a markdown link (rule 2) so we
 *      can tell intent from markup.
 *   4. Empty text is a no-op.
 *
 * @param markdown The post body in markdown form.
 * @param opts Options (optional).
 * @returns The stripped markdown.
 */
export interface MarkdownSegment {
  kind: 'code' | 'prose';
  text: string;
}

/**
 * Split a body into fenced-code and prose segments, so URL handling never
 * touches code. Matches both ``` and ~~~ fences; the opening fence may carry an
 * info-string (e.g. ```ts). An unterminated fence is code-until-end-of-input
 * (what most renderers do).
 *
 * EXPORTED so the publish gate (`forum-post-gate.ts`) classifies code exactly the
 * way the strip does. A gate that re-implemented fence parsing could disagree with
 * the strip about what counts as code — and would then either pass a URL that gets
 * deleted, or fail one that was always safe.
 */
export function splitFencedSegments(markdown: string): MarkdownSegment[] {
  const fenceRegex = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[ \t]*(?=\n|$)|$)/g;
  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  for (const m of markdown.matchAll(fenceRegex)) {
    const start = m.index ?? 0;
    // The regex's leading `(^|\n)` captures either a newline or the start of the
    // string; the literal fence sits immediately after.
    const leadLen = m[1]?.length ?? 0;
    const codeStart = start + leadLen;
    if (codeStart > cursor) {
      segments.push({ kind: 'prose', text: markdown.slice(cursor, codeStart) });
    }
    const codeEnd = start + m[0].length;
    segments.push({ kind: 'code', text: markdown.slice(codeStart, codeEnd) });
    cursor = codeEnd;
  }
  if (cursor < markdown.length) {
    segments.push({ kind: 'prose', text: markdown.slice(cursor) });
  }
  return segments;
}

export function stripExternalUrlsForModeration(
  markdown: string,
  opts: StripOptions = {}
): string {
  if (!markdown) return markdown;

  const segments = splitFencedSegments(markdown);

  // One allowlist, built once: the canonical domain plus any explicit extras.
  // Empty ⇒ nothing is preserved, exactly as before either option existed.
  const keepHosts = [opts.keepCanonicalDomain, ...(opts.keepHosts ?? [])]
    .filter((h): h is string => typeof h === 'string' && h.length > 0)
    .map((h) => h.toLowerCase());

  const processed = segments.map((seg) => {
    if (seg.kind === 'code') return seg.text;
    return stripProse(seg.text, keepHosts);
  });

  return processed.join('');
}

function stripProse(text: string, keepHosts: string[]): string {
  // Pass 1: markdown links. `[text](url)` or `[text](url "title")`.
  // Use a conservative character class for the text (no newline, no `]`).
  // The URL can be any run of non-whitespace + optional title in quotes.
  let out = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g,
    (_match, linkText: string, url: string) => {
      if (keepHosts.some((h) => hostMatches(url, h))) {
        // Keep the full markdown link. Re-emit a clean form (drop the
        // optional title) so downstream regexes see a predictable shape.
        return `[${linkText}](${url})`;
      }
      return linkText;
    }
  );

  // Pass 2: bare http(s) URLs. Strip them — they're unanchored in the
  // prose and so they act as raw advertising in a way moderation flags
  // catch aggressively. Canonical-domain bare URLs are also stripped; the
  // canonical back-link should use markdown-link syntax.
  //
  // To keep preserved markdown links intact, we FIRST swap them for
  // opaque placeholders, run the bare-URL strip, then swap back.
  const preserved: string[] = [];
  out = out.replace(/\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/g, (m) => {
    preserved.push(m);
    return `\u0000KEEP_${preserved.length - 1}\u0000`;
  });
  out = out.replace(/https?:\/\/[^\s)>\]]+/g, '');
  out = out.replace(/\u0000KEEP_(\d+)\u0000/g, (_m, idx: string) => preserved[Number(idx)]);

  // Trim trailing whitespace on each line — but never collapse leading
  // whitespace, which carries meaning in markdown (list nesting, code).
  out = out.replace(/[ \t]+(\n|$)/g, '$1');

  return out;
}

function hostMatches(url: string, keepHost: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === keepHost) return true;
    if (host.endsWith(`.${keepHost}`)) return true;
    return false;
  } catch {
    return false;
  }
}
