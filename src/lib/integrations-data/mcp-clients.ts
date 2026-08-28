/**
 * MCP Client integrations — 12 entries (9 dedicated + 3 inline-only).
 *
 * THE single MCP-client SoT. Consumers are listed in ./types.ts. Do not add a
 * second module exporting a client list — every surface projects from here.
 *
 * The original six entries' content came VERBATIM from the pre-refactor
 * src/lib/mcp-usage-docs.ts inline HTML (DOCS-INTEGRATION-H2-W1 ship
 * 2026-05-18) so the byte-equivalence test matched the pre-refactor fixture.
 * That fixture was re-baselined 2026-08-05 when this surface gained rows —
 * renderSurfaceSection() renders EVERY entry, so a permanently frozen fixture
 * would have blocked every future client. The original six render unchanged;
 * the fixture simply now also contains the newer rows.
 *
 * hasDedicatedPage:false means "no /integrations/<slug> page", NOT "lesser":
 *   plain-http  — a transport, not a client.
 *   zai-api     — server-side MCP on the provider's own API; nothing to install.
 *   deepseek    — the bring-your-own-model path; the native client is deepseek-harness.
 * All three still render on the landing quickstart grid, which deliberately
 * does NOT apply renderIndexGrid()'s hasDedicatedPage filter.
 *
 * Every row carries `source` + `verifiedAt`. A connect string with no primary
 * source does not ship.
 */

import type { SurfaceModule } from './types.js';

const MCP_CLIENTS: SurfaceModule = {
  meta: {
    anchorId: 'connect-mcp',
    title: 'Connect Your MCP Client',
    marginTopClass: 'mt-8',
    introHtml:
      'Your <code class="text-xs bg-navy-700 px-1.5 py-0.5 rounded">av_live_&hellip;</code> API key works across every MCP-compatible client. Pick yours below. Free tier (no key) also works for <strong>every coin + every timeframe</strong>, capped at 200 calls/month, and at 100 calls per UTC day.',
    firstColumnHeader: 'Surface',
    // NOTE: footerVerifiedDate is not rendered — the date used to live inside
    // footerPreamble. Since each row now carries its own `verifiedAt`, a single
    // surface-wide date would be a false claim the moment one row is re-checked,
    // so the preamble no longer states one. This field is kept as the oldest
    // row's date for provenance only.
    footerVerifiedDate: '2026-04-30',
    footerPreamble: 'Config formats verified per client against:',
    footerDriftNote:
      'Config formats can drift &mdash; if a snippet here doesn\'t work, please refer to the upstream doc and report it at <a class="text-mint-400 hover:underline" href="https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/issues">GitHub issues</a>.',
    footerLinks: [
      { label: 'MCP quickstart', href: 'https://modelcontextprotocol.io/quickstart/user' },
      { label: 'Cursor MCP docs', href: 'https://cursor.com/docs/context/mcp' },
      { label: 'Cline remote-server docs', href: 'https://docs.cline.bot/mcp/connecting-to-a-remote-server' },
      { label: 'Claude Code MCP docs', href: 'https://code.claude.com/docs/en/mcp' },
      { label: '@smithery/cli on npm', href: 'https://www.npmjs.com/package/@smithery/cli' },
      { label: 'Codex MCP docs', href: 'https://learn.chatgpt.com/docs/extend/mcp' },
      { label: 'Kimi Code MCP docs', href: 'https://moonshotai.github.io/kimi-code/en/customization/mcp.html' },
      { label: 'ZCode MCP docs', href: 'https://zcode.z.ai/en/docs/mcp-services' },
      { label: 'Z.ai MCP-call docs', href: 'https://docs.z.ai/guides/capabilities/mcp-call' },
      { label: 'DeepSeek Anthropic API', href: 'https://api-docs.deepseek.com/guides/anthropic_api' },
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
      kind: 'native',
      source: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
      verifiedAt: '2026-08-05',
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
      kind: 'native',
      source: 'https://cursor.com/docs/context/mcp',
      verifiedAt: '2026-04-30',
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
      kind: 'native',
      source: 'https://docs.cline.bot/mcp/connecting-to-a-remote-server',
      verifiedAt: '2026-04-30',
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
      kind: 'native',
      source: 'https://code.claude.com/docs/en/mcp',
      verifiedAt: '2026-04-30',
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
      kind: 'native',
      source: 'https://www.npmjs.com/package/@smithery/cli',
      verifiedAt: '2026-04-30',
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
      walkthroughHtml: `      <p>For non-MCP integrations (bots, scripts, services), call the JSON-RPC endpoint directly. The transport is stateless, so a single POST of <em>tools/call</em> works: no <em>initialize</em>, no session id. See <a href="#testing-with-curl" class="text-mint-400 hover:underline">Testing with raw HTTP / curl</a> for the one-shot call, the two <code class="text-xs bg-navy-800 px-1 rounded">Accept</code> types you must send, and the optional session handshake.</p>
      <p><strong>One-shot smoke (free tier, no auth):</strong></p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">curl -sS https://api.algovault.com/health</code></pre>
      </div>
      <p>Returns <code class="text-xs bg-navy-800 px-1 rounded">{"status":"ok","version":"1.10.3","stripe":true}</code>.</p>`,
      fullTutorialUrl: '',
      hasDedicatedPage: false,
      kind: 'native',
      source: 'https://modelcontextprotocol.io/quickstart/user',
      verifiedAt: '2026-04-30',
    },
    // ── Rows added LANDING-MCP-CLIENT-REGISTRY-W1, each verified 2026-08-05
    // against the vendor's own documentation. APPENDED, never interleaved: the
    // docs byte-equivalence fixture then diffs purely additively, which is what
    // lets its re-baseline be reviewed rather than rubber-stamped. Presentation
    // order (native → api-level → byo-model) is applied by the landing grid, so
    // registry order stays append-only.
    {
      slug: 'codex',
      displayName: 'Codex',
      surfaceType: 'mcp-client',
      setupSummary:
        'Add <code class="text-xs bg-navy-800 px-1 rounded">[mcp_servers.algovault]</code> to <code class="text-xs bg-navy-800 px-1 rounded">~/.codex/config.toml</code>',
      whatYouGet:
        'Coding agent for terminal and IDE. AlgoVault tools available in every Codex session.',
      walkthroughHtml: `      <p>Codex reads MCP servers from <code class="text-xs bg-navy-800 px-1 rounded">~/.codex/config.toml</code>. Add a table for AlgoVault:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">[mcp_servers.algovault]
url = "https://api.algovault.com/mcp?src=docs"
bearer_token_env_var = "AV_API_KEY"

[mcp_servers.algovault.http_headers]
"X-AlgoVault-Track-Token" = "chan-docs"</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">AV_API_KEY</code> in your shell for paid tier; drop <code class="text-xs">bearer_token_env_var</code> for free tier. Note that <code class="text-xs bg-navy-800 px-1 rounded">codex mcp add</code> covers local stdio servers only, so remote HTTP servers are configured in the file.</p>
      <p><strong>IDE extension:</strong> open settings, choose <em>MCP servers</em>, add a server, pick <em>Streamable HTTP</em> and paste the same URL.</p>
      <p><strong>Verify:</strong> ask Codex <em>"Get me a trade call for BTC on the 1h timeframe"</em>.</p>`,
      fullTutorialUrl: '/integrations/codex',
      hasDedicatedPage: true,
      kind: 'native',
      source: 'https://learn.chatgpt.com/docs/extend/mcp',
      verifiedAt: '2026-08-05',
    },
    {
      slug: 'kimi',
      displayName: 'Kimi Code',
      surfaceType: 'mcp-client',
      setupSummary:
        'Add a <code class="text-xs bg-navy-800 px-1 rounded">url</code> entry to <code class="text-xs bg-navy-800 px-1 rounded">~/.kimi-code/mcp.json</code>, or run <code class="text-xs">/mcp-config</code>',
      whatYouGet:
        'Moonshot’s coding agent. Pulls AlgoVault verdicts while you edit strategy code.',
      walkthroughHtml: `      <p>Edit <code class="text-xs bg-navy-800 px-1 rounded">~/.kimi-code/mcp.json</code> (user level) or <code class="text-xs bg-navy-800 px-1 rounded">.kimi-code/mcp.json</code> (project level). An entry carrying a <code class="text-xs">url</code> and no <code class="text-xs">transport</code> is an HTTP server:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {
      "url": "https://api.algovault.com/mcp?src=docs",
      "bearerTokenEnvVar": "AV_API_KEY",
      "headers": {
        "X-AlgoVault-Track-Token": "chan-docs"
      }
    }
  }
}</code></pre>
      </div>
      <p>Prefer the guided path? Run <code class="text-xs bg-navy-800 px-1 rounded">/mcp-config</code> in the TUI to add, edit or delete servers without touching the JSON.</p>
      <p><strong>Verify:</strong> ask Kimi <em>"Get me a trade call for BTC on the 1h timeframe"</em>.</p>`,
      fullTutorialUrl: '/integrations/kimi',
      hasDedicatedPage: true,
      kind: 'native',
      source: 'https://moonshotai.github.io/kimi-code/en/customization/mcp.html',
      verifiedAt: '2026-08-05',
    },
    {
      slug: 'glm-zcode',
      displayName: 'ZCode (GLM)',
      surfaceType: 'mcp-client',
      setupSummary:
        'Settings &rarr; MCP Servers &rarr; <em>New MCP Server</em> &rarr; <code class="text-xs bg-navy-800 px-1 rounded">HTTP</code>, then paste the URL',
      whatYouGet:
        'Z.ai’s GLM harness. AlgoVault verdicts alongside the GLM model family.',
      walkthroughHtml: `      <p>Open <em>Settings</em> &rarr; <em>MCP Servers</em>, then click <em>New MCP Server</em> at the top right. Choose <code class="text-xs bg-navy-800 px-1 rounded">HTTP</code> as the type and enter:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">https://api.algovault.com/mcp?src=docs</code></pre>
      </div>
      <p>For paid tier, expand <em>Headers (optional)</em> and add <code class="text-xs bg-navy-800 px-1 rounded">Authorization: Bearer av_live_&hellip;</code>. Free tier needs no header.</p>
      <p>ZCode also accepts a pasted config block under <em>Full configuration</em>, in either the <code class="text-xs">{"mcpServers": {&hellip;}}</code> or the bare <code class="text-xs">{"server-name": {&hellip;}}</code> shape.</p>
      <p><strong>Verify:</strong> ask ZCode <em>"Get me a trade call for BTC on the 1h timeframe"</em>.</p>`,
      fullTutorialUrl: '/integrations/glm-zcode',
      hasDedicatedPage: true,
      kind: 'native',
      source: 'https://zcode.z.ai/en/docs/mcp-services',
      verifiedAt: '2026-08-05',
    },
    {
      slug: 'deepseek-harness',
      displayName: 'DeepSeek Harness',
      surfaceType: 'mcp-client',
      setupSummary:
        'Add <code class="text-xs bg-navy-800 px-1 rounded">@deepseek-ai/dsh-mcp-client</code>, then insert one entry in <code class="text-xs">cordis.patch.yml</code>',
      whatYouGet:
        'DeepSeek’s own agent runtime. AlgoVault tools arrive as <code class="text-xs">mcp__algovault__*</code>; the free tier needs no key.',
      walkthroughHtml: `      <p>Two steps: add the plugin, then patch the profile. <code class="text-xs bg-navy-800 px-1 rounded">pnpm</code> must be on PATH &mdash; the CLI forwards to it.</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">dsh plugin --profile &lt;name&gt; add @deepseek-ai/dsh-mcp-client@0.1.1-rc.2</code></pre>
      </div>
      <p>The version is pinned on purpose. npm’s <code class="text-xs">latest</code> tag still points at <code class="text-xs">0.0.1-rc.1</code>, which is BSD-3-Clause; MIT starts at <code class="text-xs">0.1.0-rc.2</code>.</p>
      <p>Then edit <code class="text-xs bg-navy-800 px-1 rounded">~/.dsh/profiles/&lt;name&gt;/cordis.patch.yml</code>, or <code class="text-xs">~/.dsh/cordis.patch.yml</code> for every profile:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">- insert:
    - id: mcp-algovault
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: algovault
        transport: streamable-http
        url: https://api.algovault.com/mcp?src=docs
        headers:
          X-AlgoVault-Track-Token: chan-docs</code></pre>
      </div>
      <p>The <code class="text-xs">- insert:</code> wrapper is required. Without it the entry is an id-targeted override, and it is skipped with a warning.</p>
      <p>Paid tier adds one more line to that <code class="text-xs">headers</code> block: <code class="text-xs bg-navy-800 px-1 rounded">Authorization: Bearer av_live_&hellip;</code>. The free tier needs no key.</p>
      <p>The tools arrive server-qualified &mdash; <code class="text-xs">mcp__algovault__get_trade_call</code>, <code class="text-xs">mcp__algovault__scan_trade_calls</code>, and the rest.</p>
      <p>DSH bridges tools only. MCP resources and prompts are deferred upstream, so read the track record at <a class="text-mint-400 hover:underline" href="https://algovault.com/track-record">algovault.com/track-record</a> instead.</p>
      <p><strong>Verify:</strong> ask <code class="text-xs">dsh</code> <em>"Get me a trade call for BTC on the 1h timeframe"</em>.</p>
      <p class="text-xs text-gray-500">Verified against <code class="text-xs">@deepseek-ai/dsh-mcp-client</code> 0.1.1-rc.2 on 2026-08-28. DSH ships prereleases only; expect compatibility-breaking changes.</p>`,
      fullTutorialUrl: '/integrations/deepseek-harness',
      hasDedicatedPage: true,
      kind: 'native',
      source: 'https://github.com/deepseek-ai/deepseek-harness',
      verifiedAt: '2026-08-28',
    },
    {
      slug: 'zai-api',
      displayName: 'Z.ai API',
      surfaceType: 'mcp-client',
      setupSummary:
        'Pass <code class="text-xs bg-navy-800 px-1 rounded">type: "mcp"</code> in the <code class="text-xs">tools</code> array on <code class="text-xs">chat/completions</code>',
      whatYouGet:
        'No app to install. Z.ai reaches AlgoVault server-side while it answers.',
      walkthroughSummary: 'Z.ai API &mdash; server-side, no client needed',
      walkthroughHtml: `      <p>Z.ai dials the MCP server itself, so there is nothing to install locally. Declare AlgoVault as a tool on the request:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "model": "glm-4.6",
  "messages": [{"role": "user", "content": "Trade call for BTC on the 1h timeframe"}],
  "tools": [{
    "type": "mcp",
    "mcp": {
      "server_label": "algovault",
      "server_url": "https://api.algovault.com/mcp?src=docs",
      "headers": {"X-AlgoVault-Track-Token": "chan-docs"}
    }
  }]
}</code></pre>
      </div>
      <p><code class="text-xs bg-navy-800 px-1 rounded">server_label</code> is required. <code class="text-xs">transport_type</code> is optional and already defaults to <code class="text-xs">streamable-http</code>, so it is omitted above. Add <code class="text-xs">allowed_tools</code> to narrow the tool set.</p>`,
      fullTutorialUrl: '',
      hasDedicatedPage: false,
      kind: 'api-level',
      source: 'https://docs.z.ai/guides/capabilities/mcp-call',
      verifiedAt: '2026-08-05',
    },
    {
      slug: 'deepseek',
      displayName: 'DeepSeek',
      surfaceType: 'mcp-client',
      setupSummary:
        'Point Claude Code at <code class="text-xs bg-navy-800 px-1 rounded">https://api.deepseek.com/anthropic</code>, then add AlgoVault as usual',
      whatYouGet:
        'Bring your own model. DeepSeek does the thinking; your existing harness carries the AlgoVault tools.',
      walkthroughSummary: 'DeepSeek &mdash; bring your own model',
      walkthroughHtml: `      <p>DeepSeek’s own harness connects to AlgoVault directly &mdash; see the <a class="text-mint-400 hover:underline" href="/integrations/deepseek-harness">DeepSeek Harness tutorial</a>. This row is the other path: keep the harness you already run and swap the model behind it. The DeepSeek API itself still exposes no MCP parameter, so the harness carries the tools.</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"

claude mcp add --transport http --scope project algovault \\
  https://api.algovault.com/mcp?src=docs \\
  --header "X-AlgoVault-Track-Token:chan-docs"</code></pre>
      </div>
      <p>Claude Code then runs against DeepSeek while AlgoVault stays connected exactly as it would otherwise. Verdicts are unchanged: they are computed on our side and handed back as JSON.</p>
      <p>Harnesses that speak the OpenAI protocol instead use the plain <code class="text-xs bg-navy-800 px-1 rounded">https://api.deepseek.com</code> base, not the <code class="text-xs">/anthropic</code> one shown here.</p>`,
      fullTutorialUrl: '',
      hasDedicatedPage: false,
      kind: 'byo-model',
      source: 'https://api-docs.deepseek.com/guides/anthropic_api',
      verifiedAt: '2026-08-28',
    },
  ],
};

export default MCP_CLIENTS;
