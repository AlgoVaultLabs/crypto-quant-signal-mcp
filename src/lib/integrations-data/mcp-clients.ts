/**
 * MCP Client integrations — 6 entries (5 dedicated + 1 inline-only).
 *
 * Content sourced VERBATIM from the pre-refactor src/lib/mcp-usage-docs.ts
 * inline HTML (DOCS-INTEGRATION-H2-W1 ship 2026-05-18) so the C1
 * byte-equivalence test passes (refactored renderer output matches existing
 * docs.html#connect-mcp content modulo whitespace normalization).
 *
 * Plain HTTP / curl is hasDedicatedPage:false (it's a transport, not a
 * client) — table row + inline walkthrough only; no /integrations/plain-http
 * landing page.
 */

import type { SurfaceModule } from './types.js';

const MCP_CLIENTS: SurfaceModule = {
  meta: {
    anchorId: 'connect-mcp',
    title: 'Connect Your MCP Client',
    marginTopClass: 'mt-8',
    introHtml:
      'Your <code class="text-xs bg-navy-700 px-1.5 py-0.5 rounded">av_live_&hellip;</code> API key works across every MCP-compatible client. Pick yours below. Free tier (no key) also works for <strong>every coin + every timeframe</strong>, capped at 100 calls/month.',
    firstColumnHeader: 'Surface',
    footerVerifiedDate: '2026-04-30',
    footerPreamble: 'Config formats verified 2026-04-30 against:',
    footerDriftNote:
      'Config formats can drift &mdash; if a snippet here doesn\'t work, please refer to the upstream doc and report it at <a class="text-mint-400 hover:underline" href="https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/issues">GitHub issues</a>.',
    footerLinks: [
      { label: 'MCP quickstart', href: 'https://modelcontextprotocol.io/quickstart/user' },
      { label: 'Cursor MCP docs', href: 'https://cursor.com/docs/context/mcp' },
      { label: 'Cline remote-server docs', href: 'https://docs.cline.bot/mcp/connecting-to-a-remote-server' },
      { label: 'Claude Code MCP docs', href: 'https://code.claude.com/docs/en/mcp' },
      { label: '@smithery/cli on npm', href: 'https://www.npmjs.com/package/@smithery/cli' },
    ],
  },
  entries: [
    {
      slug: 'claude-desktop',
      displayName: 'Claude Desktop',
      surfaceType: 'mcp-client',
      setupSummary:
        'Settings &rarr; Connectors &rarr; <em>Add custom connector</em>, or edit <code class="text-xs bg-navy-800 px-1 rounded">claude_desktop_config.json</code>',
      whatYouGet:
        'Native Streamable-HTTP MCP. AlgoVault tools (<code class="text-xs">get_trade_call</code>, <code class="text-xs">scan_funding_arb</code>, <code class="text-xs">get_market_regime</code>) callable in any chat.',
      walkthroughHtml: `      <p><strong>Easiest path (UI):</strong> Open Claude Desktop &rarr; <em>Settings</em> &rarr; <em>Connectors</em> &rarr; <em>Add custom connector</em>. Name it <code class="text-xs bg-navy-800 px-1 rounded">AlgoVault</code>. URL: <code class="text-xs bg-navy-800 px-1 rounded">https://api.algovault.com/mcp?src=docs</code>. Add <code class="text-xs bg-navy-800 px-1 rounded">Authorization: Bearer av_live_&hellip;</code> as a custom header (paid tier). Save and restart Claude Desktop.</p>
      <p><strong>JSON path:</strong> Edit <code class="text-xs bg-navy-800 px-1 rounded">~/Library/Application Support/Claude/claude_desktop_config.json</code> (macOS) or <code class="text-xs bg-navy-800 px-1 rounded">%APPDATA%\\Claude\\claude_desktop_config.json</code> (Windows):</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.algovault.com/mcp?src=docs",
               "--header", "Authorization: Bearer \${AV_API_KEY}",
               "--header", "X-AlgoVault-Track-Token:chan-docs"]
    }
  }
}</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">AV_API_KEY</code> in the env block or your shell. Free tier: drop the <code class="text-xs">Authorization</code> header, but keep the <code class="text-xs">X-AlgoVault-Track-Token</code> header.</p>
      <p><strong>Verify:</strong> ask Claude <em>"Get me a trade call for BTC on the 1h timeframe"</em>. Tool indicator appears bottom-right of the input box.</p>`,
      fullTutorialUrl: '/integrations/claude-desktop',
      hasDedicatedPage: true,
    },
    {
      slug: 'cursor',
      displayName: 'Cursor',
      surfaceType: 'mcp-client',
      setupSummary:
        'Edit <code class="text-xs bg-navy-800 px-1 rounded">~/.cursor/mcp.json</code> (global) or <code class="text-xs bg-navy-800 px-1 rounded">.cursor/mcp.json</code> (project)',
      whatYouGet:
        "IDE-native MCP. Cursor's coding agent pulls live signals while editing strategy code.",
      walkthroughHtml: `      <p>Edit <code class="text-xs bg-navy-800 px-1 rounded">~/.cursor/mcp.json</code> (global, all projects) or <code class="text-xs bg-navy-800 px-1 rounded">.cursor/mcp.json</code> in the project root (per-project, commit-friendly):</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp?src=docs",
      "headers": {
        "Authorization": "Bearer \${env:AV_API_KEY}",
        "X-AlgoVault-Track-Token": "chan-docs"
      }
    }
  }
}</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">AV_API_KEY</code> in your shell. Restart Cursor. The Cursor agent now has AlgoVault tools available while editing strategy code.</p>`,
      fullTutorialUrl: '/integrations/cursor',
      hasDedicatedPage: true,
    },
    {
      slug: 'cline',
      displayName: 'Cline (VSCode)',
      surfaceType: 'mcp-client',
      setupSummary:
        'Cline panel &rarr; MCP Servers &rarr; Remote Servers tab, or edit <code class="text-xs bg-navy-800 px-1 rounded">cline_mcp_settings.json</code>',
      whatYouGet: 'VSCode-side coding agent with AlgoVault tools available.',
      walkthroughHtml: `      <p>Open the Cline panel in VSCode &rarr; <em>MCP Servers</em> &rarr; <em>Remote Servers</em> tab &rarr; <em>Add server</em>. Or edit <code class="text-xs bg-navy-800 px-1 rounded">cline_mcp_settings.json</code> (path varies by OS; access via <em>Configure MCP Servers</em>):</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {
      "type": "streamableHttp",
      "url": "https://api.algovault.com/mcp?src=docs",
      "headers": {
        "Authorization": "Bearer \${env:AV_API_KEY}",
        "X-AlgoVault-Track-Token": "chan-docs"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}</code></pre>
      </div>
      <p><code class="text-xs bg-navy-800 px-1 rounded">type: "streamableHttp"</code> is the modern transport (recommended). The legacy <code class="text-xs">"sse"</code> type still works but is being deprecated upstream.</p>`,
      fullTutorialUrl: '/integrations/cline',
      hasDedicatedPage: true,
    },
    {
      slug: 'claude-code',
      displayName: 'Claude Code',
      surfaceType: 'mcp-client',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">claude mcp add --transport http &hellip; --header &hellip;</code> &mdash; or commit <code class="text-xs bg-navy-800 px-1 rounded">.mcp.json</code> to repo root',
      whatYouGet:
        'Per-project MCP. Useful for backtest / strategy-dev repos. Team-shared via <code class="text-xs">.mcp.json</code>.',
      walkthroughHtml: `      <p><strong>One-liner (recommended):</strong></p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">claude mcp add --transport http --scope project algovault https://api.algovault.com/mcp?src=docs \\
  --header "Authorization: Bearer \$AV_API_KEY" \\
  --header "X-AlgoVault-Track-Token:chan-docs"</code></pre>
      </div>
      <p>This writes a <code class="text-xs bg-navy-800 px-1 rounded">.mcp.json</code> in your repo root which you can commit so every teammate gets the same MCP config:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {
      "type": "http",
      "url": "https://api.algovault.com/mcp?src=docs",
      "headers": {
        "Authorization": "Bearer \${AV_API_KEY}",
        "X-AlgoVault-Track-Token": "chan-docs"
      }
    }
  }
}</code></pre>
      </div>
      <p><strong>Verify:</strong> in Claude Code, run <code class="text-xs bg-navy-800 px-1 rounded">/mcp</code> to list connected servers; AlgoVault should appear with its tools.</p>`,
      fullTutorialUrl: '/integrations/claude-code',
      hasDedicatedPage: true,
    },
    {
      slug: 'smithery',
      displayName: 'Smithery',
      surfaceType: 'mcp-client',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">npx -y @smithery/cli install crypto-quant-signal-mcp --client &lt;name&gt;</code>',
      whatYouGet:
        'Auto-managed connection via Smithery registry. Easiest install across clients.',
      walkthroughHtml: `      <p>The Smithery CLI installs and configures the MCP server in your client of choice automatically:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300"># Pick one — replace &lt;client&gt; with: claude, cursor, cline, claude-code
npx -y @smithery/cli install crypto-quant-signal-mcp --client &lt;client&gt;</code></pre>
      </div>
      <p>The CLI writes the right config file for your client and prompts for any required env vars (like <code class="text-xs bg-navy-800 px-1 rounded">AV_API_KEY</code> for paid-tier access). Easiest path if you're new to MCP. Browse the AlgoVault listing at <a href="https://smithery.ai/server/@AlgoVaultLabs/crypto-quant-signal-mcp" class="text-mint-400 hover:underline">smithery.ai</a>.</p>`,
      fullTutorialUrl: '/integrations/smithery',
      hasDedicatedPage: true,
    },
    {
      slug: 'plain-http',
      displayName: 'Plain HTTP / curl',
      surfaceType: 'mcp-client',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">curl -X POST https://api.algovault.com/mcp &hellip;</code>',
      whatYouGet:
        'Raw JSON-RPC. For developers integrating into bots, scripts, or non-MCP services.',
      walkthroughSummary: 'Plain HTTP / curl &mdash; advanced testing',
      walkthroughHtml: `      <p>For non-MCP integrations (bots, scripts, services), call the JSON-RPC endpoint directly. Streamable-HTTP MCP requires a 3-step handshake: <em>initialize</em> &rarr; <em>notifications/initialized</em> &rarr; <em>tools/call</em>. See <a href="#testing-with-curl" class="text-mint-400 hover:underline">Testing with raw HTTP / curl</a> for the full sequence.</p>
      <p><strong>One-shot smoke (free tier, no auth):</strong></p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">curl -sS https://api.algovault.com/health</code></pre>
      </div>
      <p>Returns <code class="text-xs bg-navy-800 px-1 rounded">{"status":"ok","version":"1.10.3","stripe":true}</code>.</p>`,
      fullTutorialUrl: '',
      hasDedicatedPage: false,
    },
  ],
};

export default MCP_CLIENTS;
