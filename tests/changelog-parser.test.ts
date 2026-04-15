import { describe, it, expect } from 'vitest';
import { parseChangelog } from '../src/lib/changelog-parser.js';

describe('parseChangelog', () => {
  it('parses standard keepachangelog format with Added/Changed/Fixed', () => {
    const md = `# Changelog

## [1.8.1] - 2026-04-13

### Added
- New exchange adapter
- Dashboard tier cards

### Changed
- README rewrite

### Fixed
- Unicode bug
- Backfill throttle

## [1.8.0] - 2026-04-11

### Added
- Exchange tabs
`;
    const entry = parseChangelog(md, '1.8.1');
    expect(entry).not.toBeNull();
    expect(entry!.version).toBe('1.8.1');
    expect(entry!.date).toBe('2026-04-13');
    expect(entry!.sections).toHaveLength(3);
    expect(entry!.sections[0]).toEqual({
      heading: 'Added',
      items: ['New exchange adapter', 'Dashboard tier cards'],
    });
    expect(entry!.sections[1]).toEqual({
      heading: 'Changed',
      items: ['README rewrite'],
    });
    expect(entry!.sections[2]).toEqual({
      heading: 'Fixed',
      items: ['Unicode bug', 'Backfill throttle'],
    });
    // `raw` should not leak the next version's section.
    expect(entry!.raw).toContain('## [1.8.1]');
    expect(entry!.raw).not.toContain('## [1.8.0]');
  });

  it('parses a bare list with no subsection headers under a single "Notes" bucket', () => {
    const md = `## [1.7.0] - 2026-04-01
- First thing
- Second thing
- Third thing
`;
    const entry = parseChangelog(md, '1.7.0');
    expect(entry).not.toBeNull();
    expect(entry!.sections).toHaveLength(1);
    expect(entry!.sections[0].heading).toBe('Notes');
    expect(entry!.sections[0].items).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  it('returns null when the version is not present in the markdown', () => {
    const md = `## [1.8.1] - 2026-04-13
### Added
- Something
`;
    expect(parseChangelog(md, '2.0.0')).toBeNull();
  });

  it('handles malformed heading spacing and missing date gracefully', () => {
    const md = `##   [1.9.0]
### Added
- Alpha
`;
    const entry = parseChangelog(md, '1.9.0');
    expect(entry).not.toBeNull();
    expect(entry!.version).toBe('1.9.0');
    expect(entry!.date).toBeUndefined();
    expect(entry!.sections).toHaveLength(1);
    expect(entry!.sections[0].items).toEqual(['Alpha']);
  });

  it('parses dates in "## [X.Y.Z] - YYYY-MM-DD" form', () => {
    const md = `## [2.0.0] - 2027-01-15

### Added
- Shiny new thing
`;
    const entry = parseChangelog(md, '2.0.0');
    expect(entry).not.toBeNull();
    expect(entry!.date).toBe('2027-01-15');
  });

  it('preserves embedded code fences inside an entry without breaking parsing', () => {
    const md = `## [1.8.2] - 2026-05-01

### Added
- Helper snippet

\`\`\`ts
const foo = '## [9.9.9]'; // NOT a new version header
\`\`\`

### Fixed
- Regression from 1.8.1

## [1.8.1] - 2026-04-13

### Added
- Older thing
`;
    const entry = parseChangelog(md, '1.8.2');
    expect(entry).not.toBeNull();
    // The decoy `## [9.9.9]` inside the fence must NOT be treated as the next
    // version header — the entry should extend to `## [1.8.1]`.
    expect(entry!.raw).toContain('## [1.8.2]');
    expect(entry!.raw).toContain('const foo');
    expect(entry!.raw).not.toContain('## [1.8.1]');
    // We still see both real sections.
    const headings = entry!.sections.map(s => s.heading);
    expect(headings).toContain('Added');
    expect(headings).toContain('Fixed');
  });

  it('returns null for empty or blank input', () => {
    expect(parseChangelog('', '1.0.0')).toBeNull();
    expect(parseChangelog('# Changelog\n\nNothing yet.\n', '1.0.0')).toBeNull();
  });

  it('does not confuse a version substring (1.8.1) with a different version (1.8.10)', () => {
    const md = `## [1.8.10] - 2026-06-01

### Added
- Tenth patch

## [1.8.1] - 2026-04-13

### Added
- First patch
`;
    const oneEightOne = parseChangelog(md, '1.8.1');
    expect(oneEightOne).not.toBeNull();
    expect(oneEightOne!.sections[0].items).toEqual(['First patch']);

    const oneEightTen = parseChangelog(md, '1.8.10');
    expect(oneEightTen).not.toBeNull();
    expect(oneEightTen!.sections[0].items).toEqual(['Tenth patch']);
  });
});
