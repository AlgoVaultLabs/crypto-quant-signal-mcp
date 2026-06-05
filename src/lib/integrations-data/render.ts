/**
 * Renderer for the Integration H2 section on docs.html + the per-surface
 * H3 blocks. Pure functions; no I/O.
 *
 * Consumed by src/lib/mcp-usage-docs.ts (composed MCP_USAGE_HTML constant
 * for the BUILD:mcp-usage block in landing/docs.html).
 *
 * Byte-equivalence contract: renderIntegrationH2({mcpClients, aiAgents,
 * exchangeKits: null}) emits HTML that — after whitespace normalization —
 * byte-matches the pre-refactor MCP_USAGE_HTML (tests/fixtures/
 * mcp-usage-html-pre-refactor.txt). Adding exchangeKits as non-null adds
 * a 3rd H3 section before the closing </section>.
 */

import type { IntegrationEntry, SurfaceModule } from './types.js';

const DEFAULT_H2_INTRO =
  'Drop AlgoVault into any MCP-compatible client, or any major agent framework. Pick your path below.';

function renderTableRow(entry: IntegrationEntry, isLast: boolean): string {
  const trClass = isLast ? '' : ' class="border-b border-white/10"';
  return `        <tr${trClass}>
          <td class="text-white text-sm px-4 py-3 font-medium">${entry.displayName}</td>
          <td class="text-gray-300 text-sm px-4 py-3">${entry.setupSummary}</td>
          <td class="text-gray-400 text-sm px-4 py-3">${entry.whatYouGet}</td>
        </tr>`;
}

function renderWalkthrough(entry: IntegrationEntry): string {
  const summary = entry.walkthroughSummary ?? `${entry.displayName} &mdash; setup walkthrough`;
  return `  <details class="bg-navy-700 border border-white/5 rounded-xl mb-3">
    <summary class="px-5 py-3 text-white text-sm font-medium cursor-pointer">${summary}</summary>
    <div class="px-5 pb-5 pt-2 text-sm text-gray-300 space-y-3">
${entry.walkthroughHtml}
    </div>
  </details>`;
}

function renderFooterLinks(links: Array<{ label: string; href: string }>): string {
  return links
    .map(
      (l) =>
        `    <a class="text-mint-400 hover:underline" href="${l.href}">${l.label}</a>`,
    )
    .join(' &middot;\n');
}

export function renderSurfaceSection(surface: SurfaceModule): string {
  const { meta, entries } = surface;
  const rows = entries
    .map((e, i) => renderTableRow(e, i === entries.length - 1))
    .join('\n');
  const walkthroughs = entries.map(renderWalkthrough).join('\n\n');
  const links = renderFooterLinks(meta.footerLinks);
  const cta = meta.ctaParagraphHtml
    ? `\n\n  <p class="text-gray-400 text-sm mt-8 text-center">\n    ${meta.ctaParagraphHtml}\n  </p>`
    : '';

  return `  <h3 id="${meta.anchorId}" class="text-lg font-semibold text-white mb-4 ${meta.marginTopClass} flex items-center gap-2">
    <span class="text-mint-400">&#9670;</span> ${meta.title}
  </h3>
  <p class="text-gray-400 text-sm mb-6">${meta.introHtml}</p>

  <div class="overflow-x-auto mb-6">
    <table class="w-full bg-navy-700 border border-white/5 rounded-xl overflow-hidden text-sm">
      <thead><tr class="border-b border-white/5">
        <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">${meta.firstColumnHeader}</th>
        <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">Setup</th>
        <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">What you get</th>
      </tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>

${walkthroughs}

  <p class="text-gray-500 text-xs mt-6">
    <strong>${meta.footerPreamble}</strong>
${links}.
    ${meta.footerDriftNote}
  </p>${cta}`;
}

export function renderIntegrationH2(args: {
  mcpClients: SurfaceModule;
  aiAgents: SurfaceModule;
  exchangeKits: SurfaceModule | null;
  h2IntroHtml?: string;
}): string {
  const intro = args.h2IntroHtml ?? DEFAULT_H2_INTRO;
  const sections: string[] = [
    renderSurfaceSection(args.mcpClients),
    renderSurfaceSection(args.aiAgents),
  ];
  if (args.exchangeKits) {
    sections.push(renderSurfaceSection(args.exchangeKits));
  }
  return `<section id="integration" class="mb-16">
  <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
    <span class="text-mint-400">&#9670;</span> Integration
  </h2>
  <p class="text-gray-400 text-sm mb-8">${intro}</p>

${sections.join('\n\n')}
</section>
`;
}

/**
 * Whitespace-normalize HTML for byte-equivalence comparisons. Collapses
 * any run of whitespace (spaces, tabs, newlines) to a single space; trims
 * leading/trailing whitespace. Order of attributes, text content, and
 * tag nesting are preserved.
 */
export function normalizeHtml(html: string): string {
  return html.replace(/\s+/g, ' ').trim();
}

// ── /integrations index-page renderer (C3) ────────────────────────────
//
// Separate renderer for the algovault.com/integrations index page. Same
// data files as the docs.html renderer above, but card-grid layout
// matching the existing exchange-tile aesthetic (vs docs.html's table +
// <details> walkthrough layout).
//
// Exchange-kit cards keep the existing tile shape (logo + Demo→ link).
// MCP-client + AI-agent cards use a simpler text-only shape (diamond
// accent + display name + whatYouGet + setupSummary + View tutorial→).

const EXCHANGE_LOGO_OVERRIDES: Record<string, { src: string; classes: string }> = {
  binance: { src: '/assets/logos/binance.svg', classes: 'w-10 h-10 object-contain' },
  okx: { src: '/assets/logos/okx.svg', classes: 'w-10 h-10 object-contain invert' },
  bybit: { src: '/assets/logos/bybit.png', classes: 'w-10 h-10 object-contain' },
  bitget: { src: '/assets/logos/bitget.png', classes: 'w-10 h-10 object-contain' },
  // BROKER-PAIRING-CRYPTO-W1 logo backfill (2026-06-05) — venue brand marks
  gemini: { src: '/assets/logos/gemini.png', classes: 'w-10 h-10 object-contain' },
  kraken: { src: '/assets/logos/kraken.png', classes: 'w-10 h-10 object-contain' },
  alpaca: { src: '/assets/logos/alpaca.png', classes: 'w-10 h-10 object-contain' },
};

const EXCHANGE_DEMO_URL: Record<string, string> = {
  binance: 'https://github.com/AlgoVaultLabs/algovault-skills/tree/main/examples/binance',
  okx: 'https://github.com/AlgoVaultLabs/algovault-skills/tree/main/examples/okx',
  bybit: 'https://github.com/AlgoVaultLabs/algovault-skills/tree/main/examples/bybit',
  bitget: 'https://github.com/AlgoVaultLabs/algovault-skills/tree/main/examples/bitget',
  // BROKER-PAIRING-CRYPTO-W1 (2026-06-05)
  gemini: 'https://github.com/AlgoVaultLabs/algovault-skills/tree/main/examples/gemini',
  kraken: 'https://github.com/AlgoVaultLabs/algovault-skills/tree/main/examples/kraken',
  alpaca: 'https://github.com/AlgoVaultLabs/algovault-skills/tree/main/examples/alpaca',
};

function renderIndexCard(entry: IntegrationEntry): string {
  const utmHref = `${entry.fullTutorialUrl}?utm_source=integrations_index&utm_medium=card&utm_campaign=integration-${entry.slug}`;
  const plausibleProps = `{props:{surface:'${entry.surfaceType}',slug:'${entry.slug}',source:'integrations_index'}}`;
  const logo = EXCHANGE_LOGO_OVERRIDES[entry.slug];
  const headIcon = logo
    ? `<img src="${logo.src}" alt="${entry.displayName} logo" class="${logo.classes}">`
    : `<span class="text-mint-400 text-2xl" aria-hidden="true">&#9670;</span>`;
  const heading =
    entry.surfaceType === 'exchange-kit'
      ? `${entry.displayName} &times; AlgoVault`
      : entry.displayName;
  const demoUrl = EXCHANGE_DEMO_URL[entry.slug];
  const demoLink = demoUrl
    ? `\n          <a href="${demoUrl}" class="text-steel-400 hover:text-mint-400" onclick="event.stopPropagation()">Demo &rarr;</a>`
    : '';
  return `      <a href="${utmHref}"
         onclick="if(window.plausible)plausible('Integration View',${plausibleProps})"
         class="card-hover bg-navy-700 border border-white/5 rounded-xl p-5 hover:border-mint-500/40 transition block">
        <div class="flex items-center gap-3 mb-3">
          ${headIcon}
          <h3 class="text-white font-semibold text-base">${heading}</h3>
        </div>
        <p class="text-gray-400 text-xs mb-3">${entry.whatYouGet}</p>
        <p class="text-gray-600 text-xs mb-3">${entry.setupSummary}</p>
        <div class="flex items-center gap-3 text-xs">
          <span class="text-mint-400">View tutorial &rarr;</span>${demoLink}
        </div>
      </a>`;
}

/**
 * Render the inner content of a BUILD block in landing/integrations.html
 * for one surface (mcp-clients / ai-agents / exchange-kits). Returns the
 * concatenated card HTML for all hasDedicatedPage:true entries.
 *
 * The outer <section> wrapper + H2 + intro + grid <div> live in the
 * landing/integrations.html source; this function only emits the cards
 * that go between the grid div's BUILD markers.
 */
export function renderIndexGrid(surface: SurfaceModule): string {
  return surface.entries
    .filter((e) => e.hasDedicatedPage)
    .map(renderIndexCard)
    .join('\n');
}
