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
}

/**
 * Strip external markdown links and bare URLs from a post body, while
 * preserving anything inside fenced code blocks.
 *
 * Rules, in order:
 *   1. Code blocks (```…``` or ~~~…~~~) are treated as opaque — content
 *      inside them is passed through untouched regardless of URLs.
 *   2. Outside code blocks, markdown links `[text](url)` are replaced with
 *      just `text`, unless the URL's hostname matches
 *      `opts.keepCanonicalDomain` in which case the full link is kept.
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
export function stripExternalUrlsForModeration(
  markdown: string,
  opts: StripOptions = {}
): string {
  if (!markdown) return markdown;

  // Split the body into fenced-code segments and prose segments so the
  // URL-stripping passes never touch code. We match both ``` and ~~~
  // fences; the opening fence can carry an info-string (e.g. ```ts) that
  // we must not chew on. Unterminated fences are treated as code-until-
  // end-of-input (same as most renderers).
  const fenceRegex = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[ \t]*(?=\n|$)|$)/g;
  const segments: Array<{ kind: 'code' | 'prose'; text: string }> = [];
  let cursor = 0;
  for (const m of markdown.matchAll(fenceRegex)) {
    const start = m.index ?? 0;
    // The regex's leading `(^|\n)` captures either a newline or the start
    // of the string; the literal text sits immediately after.
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

  const keepHost = opts.keepCanonicalDomain?.toLowerCase() ?? null;

  const processed = segments.map((seg) => {
    if (seg.kind === 'code') return seg.text;
    return stripProse(seg.text, keepHost);
  });

  return processed.join('');
}

function stripProse(text: string, keepHost: string | null): string {
  // Pass 1: markdown links. `[text](url)` or `[text](url "title")`.
  // Use a conservative character class for the text (no newline, no `]`).
  // The URL can be any run of non-whitespace + optional title in quotes.
  let out = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g,
    (_match, linkText: string, url: string) => {
      if (keepHost && hostMatches(url, keepHost)) {
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
