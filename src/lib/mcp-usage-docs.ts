/**
 * Single-source "Connect Your MCP Client" docs section for `landing/docs.html`.
 *
 * v1.10.3 FREE-UNLOCK-W1 deliverable. Exports `MCP_USAGE_HTML` constant
 * mirroring the `signup-flow.ts` pattern. Rendered into `landing/docs.html`
 * between `<!-- BUILD:mcp-usage:start -->` / `<!-- BUILD:mcp-usage:end -->`
 * markers by `scripts/build_landing.mjs`.
 *
 * Every config snippet was web-verified during the wave's Phase 0 probe:
 *   - Claude Desktop  : modelcontextprotocol.io/quickstart/user (fetched 2026-04-30)
 *                     + remote-MCP guidance via support.claude.com custom connectors
 *   - Cursor          : cursor.com/docs/context/mcp (fetched 2026-04-30)
 *   - Cline           : docs.cline.bot/mcp/connecting-to-a-remote-server
 *   - Claude Code     : code.claude.com/docs/en/mcp (fetched 2026-04-30)
 *   - Smithery        : @smithery/cli on npm (v4.11.0, fetched 2026-04-30)
 *   - Plain HTTP      : the live /mcp endpoint contract (verified by probe)
 */

export const MCP_USAGE_HTML: string = `<section id="connect-mcp" class="mb-16">
  <h2 class="text-xl font-bold text-white mb-4 flex items-center gap-2">
    <span class="text-gold-400">&#9670;</span> Connect Your MCP Client
  </h2>
  <p class="text-gray-400 text-sm mb-6">Your <code class="text-xs bg-navy-700 px-1.5 py-0.5 rounded">av_live_&hellip;</code> API key works across every MCP-compatible client. Pick yours below. Free tier (no key) also works for <strong>every coin + every timeframe</strong>, capped at 100 calls/month.</p>

  <div class="overflow-x-auto mb-6">
    <table class="w-full bg-navy-700 border border-white/5 rounded-xl overflow-hidden text-sm">
      <thead><tr class="border-b border-white/5">
        <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">Surface</th>
        <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">Setup</th>
        <th class="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">What you get</th>
      </tr></thead>
      <tbody>
        <tr class="border-b border-white/10">
          <td class="text-white text-sm px-4 py-3 font-medium">Claude Desktop</td>
          <td class="text-gray-300 text-sm px-4 py-3">Settings &rarr; Connectors &rarr; <em>Add custom connector</em>, or edit <code class="text-xs bg-navy-800 px-1 rounded">claude_desktop_config.json</code></td>
          <td class="text-gray-400 text-sm px-4 py-3">Native Streamable-HTTP MCP. AlgoVault tools (<code class="text-xs">get_trade_call</code>, <code class="text-xs">scan_funding_arb</code>, <code class="text-xs">get_market_regime</code>) callable in any chat.</td>
        </tr>
        <tr class="border-b border-white/10">
          <td class="text-white text-sm px-4 py-3 font-medium">Cursor</td>
          <td class="text-gray-300 text-sm px-4 py-3">Edit <code class="text-xs bg-navy-800 px-1 rounded">~/.cursor/mcp.json</code> (global) or <code class="text-xs bg-navy-800 px-1 rounded">.cursor/mcp.json</code> (project)</td>
          <td class="text-gray-400 text-sm px-4 py-3">IDE-native MCP. Cursor's coding agent pulls live signals while editing strategy code.</td>
        </tr>
        <tr class="border-b border-white/10">
          <td class="text-white text-sm px-4 py-3 font-medium">Cline (VSCode)</td>
          <td class="text-gray-300 text-sm px-4 py-3">Cline panel &rarr; MCP Servers &rarr; Remote Servers tab, or edit <code class="text-xs bg-navy-800 px-1 rounded">cline_mcp_settings.json</code></td>
          <td class="text-gray-400 text-sm px-4 py-3">VSCode-side coding agent with AlgoVault tools available.</td>
        </tr>
        <tr class="border-b border-white/10">
          <td class="text-white text-sm px-4 py-3 font-medium">Claude Code</td>
          <td class="text-gray-300 text-sm px-4 py-3"><code class="text-xs bg-navy-800 px-1 rounded">claude mcp add --transport http &hellip; --header &hellip;</code> &mdash; or commit <code class="text-xs bg-navy-800 px-1 rounded">.mcp.json</code> to repo root</td>
          <td class="text-gray-400 text-sm px-4 py-3">Per-project MCP. Useful for backtest / strategy-dev repos. Team-shared via <code class="text-xs">.mcp.json</code>.</td>
        </tr>
        <tr class="border-b border-white/10">
          <td class="text-white text-sm px-4 py-3 font-medium">Smithery</td>
          <td class="text-gray-300 text-sm px-4 py-3"><code class="text-xs bg-navy-800 px-1 rounded">npx -y @smithery/cli install crypto-quant-signal-mcp --client &lt;name&gt;</code></td>
          <td class="text-gray-400 text-sm px-4 py-3">Auto-managed connection via Smithery registry. Easiest install across clients.</td>
        </tr>
        <tr>
          <td class="text-white text-sm px-4 py-3 font-medium">Plain HTTP / curl</td>
          <td class="text-gray-300 text-sm px-4 py-3"><code class="text-xs bg-navy-800 px-1 rounded">curl -X POST https://api.algovault.com/mcp &hellip;</code></td>
          <td class="text-gray-400 text-sm px-4 py-3">Raw JSON-RPC. For developers integrating into bots, scripts, or non-MCP services.</td>
        </tr>
      </tbody>
    </table>
  </div>

  <details class="bg-navy-700 border border-white/5 rounded-xl mb-3">
    <summary class="px-5 py-3 text-white text-sm font-medium cursor-pointer">Claude Desktop &mdash; setup walkthrough</summary>
    <div class="px-5 pb-5 pt-2 text-sm text-gray-300 space-y-3">
      <p><strong>Easiest path (UI):</strong> Open Claude Desktop &rarr; <em>Settings</em> &rarr; <em>Connectors</em> &rarr; <em>Add custom connector</em>. Name it <code class="text-xs bg-navy-800 px-1 rounded">AlgoVault</code>. URL: <code class="text-xs bg-navy-800 px-1 rounded">https://api.algovault.com/mcp</code>. Add <code class="text-xs bg-navy-800 px-1 rounded">Authorization: Bearer av_live_&hellip;</code> as a custom header (paid tier). Save and restart Claude Desktop.</p>
      <p><strong>JSON path:</strong> Edit <code class="text-xs bg-navy-800 px-1 rounded">~/Library/Application Support/Claude/claude_desktop_config.json</code> (macOS) or <code class="text-xs bg-navy-800 px-1 rounded">%APPDATA%\\Claude\\claude_desktop_config.json</code> (Windows):</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.algovault.com/mcp",
               "--header", "Authorization: Bearer \${AV_API_KEY}"]
    }
  }
}</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">AV_API_KEY</code> in the env block or your shell. Free tier: drop the <code class="text-xs">--header</code> args entirely.</p>
      <p><strong>Verify:</strong> ask Claude <em>"Get me a trade call for BTC on the 1h timeframe"</em>. Tool indicator appears bottom-right of the input box.</p>
    </div>
  </details>

  <details class="bg-navy-700 border border-white/5 rounded-xl mb-3">
    <summary class="px-5 py-3 text-white text-sm font-medium cursor-pointer">Cursor &mdash; setup walkthrough</summary>
    <div class="px-5 pb-5 pt-2 text-sm text-gray-300 space-y-3">
      <p>Edit <code class="text-xs bg-navy-800 px-1 rounded">~/.cursor/mcp.json</code> (global, all projects) or <code class="text-xs bg-navy-800 px-1 rounded">.cursor/mcp.json</code> in the project root (per-project, commit-friendly):</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp",
      "headers": {
        "Authorization": "Bearer \${env:AV_API_KEY}"
      }
    }
  }
}</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">AV_API_KEY</code> in your shell. Restart Cursor. The Cursor agent now has AlgoVault tools available while editing strategy code.</p>
    </div>
  </details>

  <details class="bg-navy-700 border border-white/5 rounded-xl mb-3">
    <summary class="px-5 py-3 text-white text-sm font-medium cursor-pointer">Cline (VSCode) &mdash; setup walkthrough</summary>
    <div class="px-5 pb-5 pt-2 text-sm text-gray-300 space-y-3">
      <p>Open the Cline panel in VSCode &rarr; <em>MCP Servers</em> &rarr; <em>Remote Servers</em> tab &rarr; <em>Add server</em>. Or edit <code class="text-xs bg-navy-800 px-1 rounded">cline_mcp_settings.json</code> (path varies by OS; access via <em>Configure MCP Servers</em>):</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {
      "type": "streamableHttp",
      "url": "https://api.algovault.com/mcp",
      "headers": {
        "Authorization": "Bearer \${env:AV_API_KEY}"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}</code></pre>
      </div>
      <p><code class="text-xs bg-navy-800 px-1 rounded">type: "streamableHttp"</code> is the modern transport (recommended). The legacy <code class="text-xs">"sse"</code> type still works but is being deprecated upstream.</p>
    </div>
  </details>

  <details class="bg-navy-700 border border-white/5 rounded-xl mb-3">
    <summary class="px-5 py-3 text-white text-sm font-medium cursor-pointer">Claude Code &mdash; setup walkthrough</summary>
    <div class="px-5 pb-5 pt-2 text-sm text-gray-300 space-y-3">
      <p><strong>One-liner (recommended):</strong></p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">claude mcp add --transport http --scope project algovault https://api.algovault.com/mcp \\
  --header "Authorization: Bearer \$AV_API_KEY"</code></pre>
      </div>
      <p>This writes a <code class="text-xs bg-navy-800 px-1 rounded">.mcp.json</code> in your repo root which you can commit so every teammate gets the same MCP config:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {
      "type": "http",
      "url": "https://api.algovault.com/mcp",
      "headers": {
        "Authorization": "Bearer \${AV_API_KEY}"
      }
    }
  }
}</code></pre>
      </div>
      <p><strong>Verify:</strong> in Claude Code, run <code class="text-xs bg-navy-800 px-1 rounded">/mcp</code> to list connected servers; AlgoVault should appear with its 3 tools.</p>
    </div>
  </details>

  <details class="bg-navy-700 border border-white/5 rounded-xl mb-3">
    <summary class="px-5 py-3 text-white text-sm font-medium cursor-pointer">Smithery &mdash; setup walkthrough</summary>
    <div class="px-5 pb-5 pt-2 text-sm text-gray-300 space-y-3">
      <p>The Smithery CLI installs and configures the MCP server in your client of choice automatically:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300"># Pick one — replace &lt;client&gt; with: claude, cursor, cline, claude-code
npx -y @smithery/cli install crypto-quant-signal-mcp --client &lt;client&gt;</code></pre>
      </div>
      <p>The CLI writes the right config file for your client and prompts for any required env vars (like <code class="text-xs bg-navy-800 px-1 rounded">AV_API_KEY</code> for paid-tier access). Easiest path if you're new to MCP. Browse the AlgoVault listing at <a href="https://smithery.ai/server/@AlgoVaultLabs/crypto-quant-signal-mcp" class="text-gold-400 hover:underline">smithery.ai</a>.</p>
    </div>
  </details>

  <details class="bg-navy-700 border border-white/5 rounded-xl mb-3">
    <summary class="px-5 py-3 text-white text-sm font-medium cursor-pointer">Plain HTTP / curl &mdash; advanced testing</summary>
    <div class="px-5 pb-5 pt-2 text-sm text-gray-300 space-y-3">
      <p>For non-MCP integrations (bots, scripts, services), call the JSON-RPC endpoint directly. Streamable-HTTP MCP requires a 3-step handshake: <em>initialize</em> &rarr; <em>notifications/initialized</em> &rarr; <em>tools/call</em>. See <a href="#testing-with-curl" class="text-gold-400 hover:underline">Testing with raw HTTP / curl</a> for the full sequence.</p>
      <p><strong>One-shot smoke (free tier, no auth):</strong></p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">curl -sS https://api.algovault.com/health</code></pre>
      </div>
      <p>Returns <code class="text-xs bg-navy-800 px-1 rounded">{"status":"ok","version":"1.10.3","stripe":true}</code>.</p>
    </div>
  </details>

  <p class="text-gray-500 text-xs mt-6">
    <strong>Config formats verified 2026-04-30 against:</strong>
    <a class="text-gold-400 hover:underline" href="https://modelcontextprotocol.io/quickstart/user">MCP quickstart</a> &middot;
    <a class="text-gold-400 hover:underline" href="https://cursor.com/docs/context/mcp">Cursor MCP docs</a> &middot;
    <a class="text-gold-400 hover:underline" href="https://docs.cline.bot/mcp/connecting-to-a-remote-server">Cline remote-server docs</a> &middot;
    <a class="text-gold-400 hover:underline" href="https://code.claude.com/docs/en/mcp">Claude Code MCP docs</a> &middot;
    <a class="text-gold-400 hover:underline" href="https://www.npmjs.com/package/@smithery/cli">@smithery/cli on npm</a>.
    Config formats can drift &mdash; if a snippet here doesn't work, please refer to the upstream doc and report it at <a class="text-gold-400 hover:underline" href="https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/issues">GitHub issues</a>.
  </p>
</section>
`;
