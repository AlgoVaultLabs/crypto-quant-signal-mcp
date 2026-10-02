/**
 * README.md's "MCP clients" table — each row's cells, the table order, and the README-only rows
 * (R14, LANDING-MCP-CLIENTS-CLAIMS-W1). Rendered by renderReadmeMcpClientsTable() into the
 * <!-- MCP_CLIENTS_README_TABLE:start/end --> region by scripts/build_readme_mcp_clients.mjs.
 *
 * WHY THIS IS NOT IN mcp-clients.ts: the two surfaces carry OPPOSITE rules for the same URL.
 * README URLs stay BARE by ruling — a `?src` tag outranks Referer in classifySource, so tagging the
 * README would launder registry traffic into our own channel — while
 * scripts/check-attribution-src-coverage.mjs requires every connect URL in mcp-clients.ts (the source
 * of the /docs and /integrations snippets) to carry one. So the README's cells live here, and
 * mcp-clients.ts attaches each row's cells by slug (`readme: README_CELLS[slug]`): rules R2 and R9
 * still bind every cell to its row's evidence.
 */

/** Row cells, keyed by MCP_CLIENTS slug. Markdown; URLs bare. */
export const README_CELLS: Readonly<Record<string, { client: string; cell: string }>> = Object.freeze({
  'claude-desktop': {
    client: '**Claude Desktop**',
    cell: 'Customize → Connectors → + → Add custom connector → `https://api.algovault.com/mcp`',
  },
  'cursor': {
    client: '**Cursor**',
    cell: '`~/.cursor/mcp.json` → `mcpServers` block → `url: "https://api.algovault.com/mcp"`',
  },
  'cline': {
    client: '**Cline**',
    cell: 'VS Code Cline extension → MCP server settings → add Streamable HTTP server',
  },
  'claude-code': {
    client: '**Claude Code** (CLI)',
    cell: '`claude mcp add --transport http crypto-quant-signal https://api.algovault.com/mcp`',
  },
  'codex': {
    client: '**Codex** (OpenAI CLI)',
    cell: '`~/.codex/config.toml` → `[mcp_servers.algovault]` table + `url = "https://api.algovault.com/mcp"` (or `codex mcp` CLI)',
  },
});

/**
 * The table's row order — the order it has always had. A key is a row slug (whose `readme` cells
 * render) or a key of README_ONLY_MCP_CLIENT_ROWS.
 */
export const README_MCP_CLIENT_ORDER: readonly string[] = Object.freeze([
  'claude-desktop', 'claude-code', 'cursor', 'cline', 'codex', 'windsurf', 'continue', 'any-other',
]);

/**
 * Rows the README carries that are not MCP_CLIENTS rows — kept VERBATIM, each with the reason it
 * is not (yet) a row. A README-only row is a claim nothing binds to evidence, so the reason is
 * mandatory: it is what tells the next editor whether the row is safe to keep.
 */
export const README_ONLY_MCP_CLIENT_ROWS: ReadonlyArray<{ key: string; client: string; cell: string; reason: string }> = Object.freeze([
  {
    key: 'windsurf',
    client: '**Windsurf**',
    cell: '`~/.codeium/windsurf/mcp_config.json` → `mcpServers.algovault.serverUrl = "https://api.algovault.com/mcp"`',
    reason: 'unevidenced — vendor docs moved to docs.devin.ai and scope mcp_config.json to the legacy Cascade agent; re-verification pending a copy sign-off',
  },
  {
    key: 'continue',
    client: '**Continue.dev**',
    cell: '`config.yaml` → `mcpServers: [{ name: algovault, type: streamable-http, url: "https://api.algovault.com/mcp" }]`',
    reason: 'not an MCP_CLIENTS row (no tutorial page, no landing card); its cell is evidenced on docs.continue.dev/customize/deep-dives/mcp (streamable-http, mcpServers, config.yaml — measured 2026-10-01) but bound by nothing',
  },
  {
    key: 'any-other',
    client: 'Any other MCP-spec-compliant client',
    cell: 'Configure the Streamable HTTP transport with URL `https://api.algovault.com/mcp`',
    reason: 'a catch-all, not a client: it names no vendor and no vendor config, so there is no vendor page to bind; the one fact it states is our own Streamable HTTP endpoint',
  },
]);
