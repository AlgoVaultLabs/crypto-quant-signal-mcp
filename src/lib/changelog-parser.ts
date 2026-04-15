/**
 * changelog-parser.ts — Pure parser for keepachangelog.com-style CHANGELOG.md files.
 *
 * Used by `agent-forum-post.ts::generateRelease()` to build release-post bodies
 * from `CHANGELOG.md` at runtime — zero `git`/`child_process` dependencies so
 * the script can run inside a minimal Docker image that does not ship `git`.
 *
 * Format expected (keepachangelog 1.1.0):
 *   ## [1.8.1] - 2026-04-13
 *
 *   ### Added
 *   - Thing 1
 *   - Thing 2
 *
 *   ### Fixed
 *   - Bug a
 *
 * This parser is defensive: it accepts missing dates, missing subsection
 * headers (a bare list directly under the version heading), embedded code
 * fences, and malformed heading spacing. It never throws — on irrecoverable
 * input it returns `null`.
 */

export interface ChangelogSection {
  heading: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date?: string;
  sections: ChangelogSection[];
  /** Full raw text of the entry (everything between this `## [X.Y.Z]` heading
   *  and the next `## [` or end of file), for fallback rendering. */
  raw: string;
}

/**
 * Find and parse the CHANGELOG entry for a specific version.
 *
 * @param markdown Full CHANGELOG.md content.
 * @param version Semver string without the leading `v` (e.g. `"1.8.1"`).
 * @returns Parsed entry, or `null` if the version is not present.
 */
export function parseChangelog(markdown: string, version: string): ChangelogEntry | null {
  if (!markdown || !version) return null;

  // Normalize line endings so we can work line-by-line regardless of source.
  const normalized = markdown.replace(/\r\n/g, '\n');

  // Build a regex that matches `## [X.Y.Z]` at the start of a line, optionally
  // followed by ` - DATE` on the same line. We escape dots in the version so
  // `1.8.1` matches literally.
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionHeaderRe = new RegExp(
    `^##\\s+\\[${escapedVersion}\\]\\s*(?:-\\s*([0-9]{4}-[0-9]{2}-[0-9]{2}))?\\s*$`,
    'm',
  );

  const startMatch = versionHeaderRe.exec(normalized);
  if (!startMatch) return null;

  const headerStart = startMatch.index;
  const headerEnd = headerStart + startMatch[0].length;
  const date = startMatch[1];

  // Find where this entry ends: the next top-level `## [` on its own line,
  // or end-of-file. Search from the position right after the matched header.
  const nextHeaderRe = /^##\s+\[/m;
  nextHeaderRe.lastIndex = 0;
  const tail = normalized.slice(headerEnd);
  const nextMatch = nextHeaderRe.exec(tail);
  const bodyEnd = nextMatch ? headerEnd + nextMatch.index : normalized.length;

  // `raw` includes the heading line so downstream callers can render the
  // whole block as-is if they want.
  const raw = normalized.slice(headerStart, bodyEnd).trim();
  const bodyOnly = normalized.slice(headerEnd, bodyEnd);

  const sections = parseSections(bodyOnly);

  return {
    version,
    date,
    sections,
    raw,
  };
}

/**
 * Parse the body of a version entry into `### Heading` subsections.
 *
 * If the body contains no `###` headings, all list items are collected under
 * a single synthetic "Notes" section so the caller always gets structured
 * output. Lines inside fenced code blocks (```...```) are preserved verbatim
 * and never confused with list markers.
 */
function parseSections(body: string): ChangelogSection[] {
  // We use a single-element holder so TypeScript's control-flow analysis
  // sees mutation through the closures below without losing the union type.
  // (A plain `let current: ChangelogSection | null = null` gets narrowed to
  //  `null` when the reassignment happens inside nested arrow functions.)
  const state: { current: ChangelogSection | null } = { current: null };
  const sections: ChangelogSection[] = [];
  const lines = body.split('\n');
  let inFence = false;

  const flush = (): void => {
    if (state.current && state.current.items.length > 0) sections.push(state.current);
    state.current = null;
  };

  const startSection = (heading: string): ChangelogSection => {
    flush();
    const next: ChangelogSection = { heading, items: [] };
    state.current = next;
    return next;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Track fenced code blocks so we do not interpret their contents as list
    // items or subheadings.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      // Code fences become list items under the current section so they are
      // preserved verbatim — but only if a section is open.
      if (state.current) state.current.items.push(line.trim());
      continue;
    }
    if (inFence) {
      if (state.current) state.current.items.push(line);
      continue;
    }

    // Subsection heading: `### Added`, `### Fixed`, etc.
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      startSection(h3[1]);
      continue;
    }

    // List item: `- foo` or `* foo`. Leading whitespace allowed (nested lists
    // are flattened to a single level — the caller usually renders them as
    // plain bullets anyway).
    const li = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (li) {
      const section = state.current ?? startSection('Notes');
      section.items.push(li[1]);
      continue;
    }

    // Ignore blank lines and any prose between headings — keepachangelog
    // entries should not contain prose, but we tolerate it.
  }

  flush();
  return sections;
}
