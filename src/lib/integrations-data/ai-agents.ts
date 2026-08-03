/**
 * AI Agent framework integrations — 4 entries.
 *
 * Content sourced VERBATIM from the pre-refactor src/lib/mcp-usage-docs.ts
 * for the byte-equivalence test. Per-slug landing pages already shipped
 * 2026-05-18; all 4 entries have hasDedicatedPage:true.
 */

import type { SurfaceModule } from './types.js';

const AI_AGENTS: SurfaceModule = {
  meta: {
    anchorId: 'connect-ai-agent',
    title: 'Connect Your AI Agent',
    marginTopClass: 'mt-12',
    introHtml:
      "Building on a major agent framework? AlgoVault MCP plugs into 4 of them via the framework's canonical MCP-adapter library. Each pairing ships with a runnable Python demo.",
    firstColumnHeader: 'Framework',
    footerVerifiedDate: '2026-05-18',
    footerPreamble: 'Tutorials verified 2026-05-18 against:',
    footerDriftNote:
      'Snippets can drift &mdash; if one doesn\'t work, please refer to the upstream doc and report it at <a class="text-mint-400 hover:underline" href="https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/issues">GitHub issues</a>.',
    footerLinks: [
      { label: 'langchain-mcp-adapters', href: 'https://github.com/langchain-ai/langchain-mcp-adapters' },
      { label: 'llama-index-tools-mcp', href: 'https://pypi.org/project/llama-index-tools-mcp/' },
      { label: 'agent-framework', href: 'https://learn.microsoft.com/en-us/agent-framework/' },
      { label: 'crewAI-tools MCP', href: 'https://docs.crewai.com/en/mcp/overview' },
    ],
    ctaParagraphHtml:
      'Try a framework integration: <a class="text-mint-400 hover:underline" href="/integrations/langchain">algovault.com/integrations/langchain</a>',
  },
  entries: [
    {
      slug: 'langchain',
      displayName: 'LangChain',
      surfaceType: 'ai-agent',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">pip install langchain-mcp-adapters</code> &middot; <code class="text-xs">MultiServerMCPClient</code> with streamable HTTP',
      whatYouGet:
        'AlgoVault tools as LangChain <code class="text-xs">BaseTool</code> objects in any <code class="text-xs">create_react_agent</code> or LangGraph workflow.',
      walkthroughHtml: `      <p>Install the canonical bridge maintained by LangChain:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">pip install langchain-mcp-adapters</code></pre>
      </div>
      <p>Connect once, then call tools from any LangChain agent:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({"algovault": {
    "url": "https://api.algovault.com/mcp",
    "transport": "streamable_http"}})
tools = await client.get_tools()
verdict = await tools[0].ainvoke({"coin": "BTC", "timeframe": "4h"})</code></pre>
      </div>
      <p><a href="/integrations/langchain" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/langchain',
      hasDedicatedPage: true,
    },
    {
      slug: 'llamaindex',
      displayName: 'LlamaIndex',
      surfaceType: 'ai-agent',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">pip install llama-index-tools-mcp</code> &middot; <code class="text-xs">BasicMCPClient</code> + <code class="text-xs">McpToolSpec</code>',
      whatYouGet:
        'AlgoVault tools as LlamaIndex <code class="text-xs">FunctionTool</code> objects in any <code class="text-xs">FunctionAgent</code> or <code class="text-xs">ReActAgent</code>.',
      walkthroughHtml: `      <p>Install the canonical bridge maintained by LlamaIndex:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">pip install llama-index-tools-mcp</code></pre>
      </div>
      <p>Call directly via <code class="text-xs bg-navy-800 px-1 rounded">BasicMCPClient</code>, or adapt its tools to <code class="text-xs">FunctionTool</code> via <code class="text-xs">McpToolSpec</code>:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">from llama_index.tools.mcp import BasicMCPClient

client = BasicMCPClient("https://api.algovault.com/mcp")
result = await client.call_tool(
    "get_trade_call", {"coin": "BTC", "timeframe": "4h"})</code></pre>
      </div>
      <p><a href="/integrations/llamaindex" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/llamaindex',
      hasDedicatedPage: true,
    },
    {
      slug: 'maf',
      displayName: 'Microsoft Agent Framework',
      surfaceType: 'ai-agent',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">pip install agent-framework</code> &middot; <code class="text-xs">MCPStreamableHTTPTool(url=&hellip;)</code>',
      whatYouGet:
        'AlgoVault tools called directly or handed to any <code class="text-xs">ChatAgent</code> in the MAF ecosystem.',
      walkthroughHtml: `      <p>Install the framework (MCP support is built in):</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">pip install agent-framework</code></pre>
      </div>
      <p>Open an MCP session, call tools directly, or hand the tool to a <code class="text-xs bg-navy-800 px-1 rounded">ChatAgent</code>:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">from agent_framework import MCPStreamableHTTPTool

tool = MCPStreamableHTTPTool(
    name="algovault",
    url="https://api.algovault.com/mcp",
    load_prompts=False)
async with tool:
    contents = await tool.call_tool(
        "get_trade_call", coin="BTC", timeframe="4h")</code></pre>
      </div>
      <p>Note: <code class="text-xs bg-navy-800 px-1 rounded">load_prompts=False</code> matters because AlgoVault MCP is tools-only.</p>
      <p><a href="/integrations/maf" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/maf',
      hasDedicatedPage: true,
    },
    {
      slug: 'crewai',
      displayName: 'CrewAI',
      surfaceType: 'ai-agent',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">pip install crewai \'crewai-tools[mcp]\'</code> &middot; <code class="text-xs">MCPServerAdapter</code>',
      whatYouGet:
        'AlgoVault tools as CrewAI <code class="text-xs">BaseTool</code> objects in any <code class="text-xs">Crew</code> or single <code class="text-xs">Agent</code> workflow.',
      walkthroughHtml: `      <p>Install CrewAI with the MCP extras (the canonical adapter):</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">pip install crewai 'crewai-tools[mcp]'</code></pre>
      </div>
      <p>Open the adapter as a context manager; all 4 AlgoVault tools land as CrewAI <code class="text-xs bg-navy-800 px-1 rounded">BaseTool</code> objects:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">from crewai_tools import MCPServerAdapter

server_params = {"url": "https://api.algovault.com/mcp",
                 "transport": "streamable-http"}
with MCPServerAdapter(server_params) as tools:
    raw = tools[0].run(coin="BTC", timeframe="4h", exchange="BINANCE")</code></pre>
      </div>
      <p><a href="/integrations/crewai" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/crewai',
      hasDedicatedPage: true,
    },
  ],
};

export default AI_AGENTS;
