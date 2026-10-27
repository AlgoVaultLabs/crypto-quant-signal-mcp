/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH1 — the ONE setup derivation every key-bearing surface renders.
 *
 * Before this module the Claude Desktop snippet a person saw after sign-in came from three
 * places — `lifecycle-copy.ts` `mcpConfigSnippet` (/welcome + lifecycle emails), `email.ts` (paid
 * welcome + key recovery, `chan-email` hard-coded twice) and the docs registry — and the two a
 * person actually received were the `url` + `headers` form Claude Desktop's config file ignores.
 * Now the registry row owns the snippet (`mcp-clients.ts` `SETUP_CONFIG_SNIPPETS`) and every
 * surface projects from it: the docs with their placeholders, everything here with a real key.
 *
 * Parity with the docs is modulo the key, the track token and the URL's `?src=docs` query
 * (ruling Q2): `/welcome` and the emails keep the bare `/mcp` URL and carry their channel on the
 * track-token header (`chan-welcome` / `chan-email`), because `?src=docs` would count them as
 * docs traffic. The query is SUBSTITUTED from the registry's literal, never rebuilt.
 */
import { SETUP_CONFIG_SNIPPETS, type SetupSlug } from './integrations-data/mcp-clients.js';

export type { SetupSlug };

/** The clients `/welcome` shows, in order. Emails show Claude Desktop only (§Copy W). */
export const SETUP_SLUGS: readonly SetupSlug[] = ['claude-desktop', 'claude-code', 'cursor'];

// §Copy W — verbatim.
export const SETUP_HEADING = 'Use your key in your client';
export const SETUP_LABELS: Readonly<Record<SetupSlug, string>> = {
  'claude-desktop': 'Claude Desktop (config file)',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
};
export const SETUP_DESKTOP_NOTE = 'Save the file, then quit and reopen Claude Desktop. It needs Node.js installed.';
export const SETUP_OTHER_CLIENTS_URL = 'https://algovault.com/integrations';
export const SETUP_OTHER_CLIENTS_LINE = `Other clients: ${SETUP_OTHER_CLIENTS_URL}`;

const DOCS_MCP_URL = 'https://api.algovault.com/mcp?src=docs';
const BARE_MCP_URL = 'https://api.algovault.com/mcp';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&hellip;': '…', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&',
};

/** Decodes the entities the registry and `escapeHtml` emit, in ONE pass (`&amp;hellip;` → `&hellip;`, never `…`). */
function decodeEntities(value: string): string {
  return value.replace(/&(hellip|quot|#39|lt|gt|amp);/g, (m) => ENTITIES[m]);
}

/**
 * The setup snippet for `slug`, carrying `apiKey` and `trackToken`.
 * `html`: the key is escaped ONCE and the result drops into a `<pre>` as is.
 * `text`: the same bytes with the registry's entities decoded (`&hellip;` → `…`), for a plain-text
 * body or a renderer that escapes for itself.
 */
export function setupSnippet(
  slug: SetupSlug,
  opts: { apiKey: string; trackToken: string; format: 'html' | 'text' },
): string {
  // String(): a renderer refuses, never throws — a caller handing a non-string still gets a page.
  const html = SETUP_CONFIG_SNIPPETS[slug]({ apiKey: escapeHtml(String(opts.apiKey)), trackToken: escapeHtml(String(opts.trackToken)) })
    .split(DOCS_MCP_URL).join(BARE_MCP_URL);
  return opts.format === 'html' ? html : decodeEntities(html);
}
