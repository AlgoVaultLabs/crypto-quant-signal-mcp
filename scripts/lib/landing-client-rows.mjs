// scripts/lib/landing-client-rows.mjs — the homepage quickstart grid's projection of MCP_CLIENTS.
//
// LANDING-MCP-CLIENTS-CLAIMS-W1 CH2: MOVED VERBATIM out of scripts/render-jsx-static.mjs, which runs
// its main() the moment it is imported, so nothing else could reuse this projection. Two importers:
//   - scripts/render-jsx-static.mjs  bakes the grid into landing/index.html (rendered output unchanged)
//   - scripts/check-mcp-client-copy.mjs CHECK 10 (C-LANDING-GRID-PARITY) asserts the baked grid still
//     equals the projection, because landing/index.html is the one MCP_CLIENTS surface baked out of
//     band (vault JSX — CI cannot re-render it) and it sat one card behind the SoT for five weeks.
// Side-effect free: no I/O, no globals, nothing runs at import.

export /**
 * Project the MCP-client registry into the shape the quickstart grid renders.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not apply renderIndexGrid()'s `hasDedicatedPage` filter. That
 *    filter is right for /integrations, where a card is a link to a tutorial
 *    page; here a card is "this works today", and Z.ai's API and DeepSeek work
 *    today while having nothing to install. Filtering them out of the landing
 *    page would hide the exact clients this section exists to advertise.
 *
 *  - It does not pass `setupSummary` through as HTML. That string is authored
 *    for /integrations and carries Tailwind classes (bg-navy-800, text-xs) that
 *    do not exist on landing/index.html, which styles inline off CSS variables.
 *    Injected raw it renders as unstyled markup, so tags are stripped and the
 *    handful of entities we actually author are decoded to their characters.
 */
function landingClientRows(surface) {
  const stripToText = (html) =>
    html
      .replace(/<[^>]*>/g, '')
      .replace(/&rarr;/g, '→')
      .replace(/&hellip;/g, '…')
      .replace(/&mdash;/g, '—')
      .replace(/&middot;/g, '·')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&rsquo;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

  // LANDING-QUICKSTART-SRC-TAG-W1 — a LANDING-SCOPED substitution, deliberately NOT a SoT edit.
  // `mcp-clients.ts` is SHARED: the same setupSummary renders landing/integrations/<slug>.html,
  // whose connect URLs carry `?src=docs` and must NEVER carry `?src=landing`. This function is the
  // landing projection of that SoT and is called exactly once (the TryIn30 client grid), so
  // tagging here reaches the two landing artboards and nothing else. Only an UNTAGGED URL is
  // tagged — an existing `?src=`/`?`/`&` is left alone, so a SoT row that already declares its own
  // channel keeps it.
  const tagForLanding = (text) =>
    text.replace(/https:\/\/api\.algovault\.com\/mcp(?![?&\w])/g, 'https://api.algovault.com/mcp?src=landing');

  return surface.entries.map((e) => ({
    slug: e.slug,
    label: e.displayName,
    kind: e.kind || 'native',
    connect: tagForLanding(stripToText(e.setupSummary)),
    // Empty string → null so the JSX's truthiness test reads cleanly.
    tutorial: e.fullTutorialUrl || null,
  }));
}

/**
 * The order the grid PRESENTS the projected rows in — the vault JSX's own grouping (TryIn30): every
 * row that is neither api-level nor byo-model first, then the api-level rows, then the byo-model
 * rows, each group in SoT order. Today that equals SoT order; CHECK 10 compares against THIS so a
 * future api-level row inserted mid-registry does not read as a defect. If the JSX ever regroups,
 * update this with it — CHECK 10 then fails until the two agree, which is the point.
 */
export function landingGridOrder(rows) {
  const rest = rows.filter((r) => r.kind !== 'api-level' && r.kind !== 'byo-model');
  return [...rest, ...rows.filter((r) => r.kind === 'api-level'), ...rows.filter((r) => r.kind === 'byo-model')];
}
