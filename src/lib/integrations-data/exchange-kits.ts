/**
 * Exchange Kit integrations — 4 entries (Binance · OKX · Bybit · Bitget).
 *
 * Used to add the "Connect Your Exchange Kit" H3 to
 * docs.html#integration. Per-slug landing pages already shipped (4
 * detailed tutorials at /integrations/{binance,okx,bybit,bitget}).
 *
 * Setup snippets reflect live npm/GH coords (probed 2026-05-19):
 * @okx_ai/okx-trade-mcp@1.3.3; bybit-official-trading-server@2.1.5;
 * bitget-mcp-server@1.1.0; binance/binance-skills-hub is a GH-coord,
 * not an npm package — install via `claude plugin install`.
 */

import type { SurfaceModule } from './types.js';

const EXCHANGE_KITS: SurfaceModule = {
  meta: {
    anchorId: 'connect-exchange-kit',
    title: 'Connect Your Exchange Kit',
    marginTopClass: 'mt-12',
    introHtml:
      "Already running an exchange's Agent Trade Kit? Pair AlgoVault's composite verdict with the kit's execution layer. AlgoVault returns analytics; the exchange kit places orders; your agent decides.",
    firstColumnHeader: 'Exchange',
    footerVerifiedDate: '2026-05-19',
    footerPreamble: 'Tutorials verified 2026-05-19 against:',
    footerDriftNote:
      'Snippets can drift &mdash; if one doesn\'t work, please refer to the upstream doc and report it at <a class="text-mint-400 hover:underline" href="https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/issues">GitHub issues</a>.',
    footerLinks: [
      { label: 'Binance Skills Hub', href: 'https://github.com/binance/binance-skills-hub' },
      { label: '@okx_ai/okx-trade-mcp', href: 'https://www.npmjs.com/package/@okx_ai/okx-trade-mcp' },
      { label: 'bybit-official-trading-server', href: 'https://www.npmjs.com/package/bybit-official-trading-server' },
      { label: 'bitget-mcp-server', href: 'https://www.npmjs.com/package/bitget-mcp-server' },
    ],
    ctaParagraphHtml:
      'Try an exchange integration: <a class="text-mint-400 hover:underline" href="/integrations/binance">algovault.com/integrations/binance</a>',
  },
  entries: [
    {
      slug: 'binance',
      displayName: 'Binance',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">claude plugin install binance/binance-skills-hub</code> &middot; Spot Testnet execution',
      whatYouGet:
        "Composite verdict + official Binance Skills Hub. Agent fetches signals, decides, executes against Binance's testnet.",
      walkthroughHtml: `      <p>Install the Skills Hub plugin alongside AlgoVault:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">claude plugin install AlgoVaultLabs/algovault-skills
claude plugin install binance/binance-skills-hub</code></pre>
      </div>
      <p>Your agent now has AlgoVault's analytics tools and Binance's execution tools side-by-side. Set <code class="text-xs bg-navy-800 px-1 rounded">BINANCE_TESTNET=true</code> for zero real-money risk during development.</p>
      <p><a href="/integrations/binance" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/binance',
      hasDedicatedPage: true,
    },
    {
      slug: 'okx',
      displayName: 'OKX',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">npx -y @okx_ai/okx-trade-mcp</code> &middot; 83 execution tools (spot, swap, futures, options, grid)',
      whatYouGet:
        "Composite verdict + OKX's full execution surface. Agent reads signals, places orders across spot or derivatives via one MCP server.",
      walkthroughHtml: `      <p>Install OKX's official trade MCP server in your client config:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {"url": "https://api.algovault.com/mcp"},
    "okx-trade": {"command": "npx", "args": ["-y", "@okx_ai/okx-trade-mcp"]}
  }
}</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">OKX_DEMO=true</code> (or pass <code class="text-xs">--demo</code>) for the demo trading environment. Real keys go in env vars; never commit them.</p>
      <p><a href="/integrations/okx" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/okx',
      hasDedicatedPage: true,
    },
    {
      slug: 'bybit',
      displayName: 'Bybit',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">npx -y bybit-official-trading-server</code> &middot; Linear Perpetual + conditional orders',
      whatYouGet:
        "Composite verdict + Bybit's official MCP server. Agent fetches AlgoVault signals, places perpetual + conditional orders via Bybit testnet.",
      walkthroughHtml: `      <p>Wire Bybit's official server next to AlgoVault:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {"url": "https://api.algovault.com/mcp"},
    "bybit-trade": {"command": "npx", "args": ["-y", "bybit-official-trading-server"]}
  }
}</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">BYBIT_TESTNET=true</code> + API keys in env. Conditional orders (stop-loss, take-profit, OCO) are first-class — your agent can attach risk policy at order time.</p>
      <p><a href="/integrations/bybit" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/bybit',
      hasDedicatedPage: true,
    },
    {
      slug: 'bitget',
      displayName: 'Bitget',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">npx -y bitget-mcp-server</code> &middot; GetClaw agent-native execution',
      whatYouGet:
        "Composite verdict + Bitget's MCP server inside a dedicated AI account. Agent-native execution; isolate from your main funds.",
      walkthroughHtml: `      <p>Bitget exposes a dedicated AI sub-account ("GetClaw") for agent execution:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {"url": "https://api.algovault.com/mcp"},
    "bitget-trade": {"command": "npx", "args": ["-y", "bitget-mcp-server"]}
  }
}</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">BITGET_DEMO=true</code> in the wrapper (the MCP server has no built-in demo flag — the env var gates order placement at the client level). Fund the GetClaw account separately from your main account.</p>
      <p><a href="/integrations/bitget" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/bitget',
      hasDedicatedPage: true,
    },
    {
      slug: 'gemini',
      displayName: 'Gemini',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">node packages/mcp-server/dist/index.js</code> &middot; Self-hosted Node MCP (Apache-2.0), sandbox-gated',
      whatYouGet:
        "Composite verdict + Gemini's Agentic Trading MCP. Agent reads signals, places sandbox orders via gemini_new_order; subaccounts isolate each agent.",
      walkthroughHtml: `      <p>Build Gemini's self-hosted MCP from source, alongside AlgoVault:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">git clone https://github.com/gemini/developer-platform
cd developer-platform/packages/mcp-server
npm install
npm run build</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">GEMINI_API_BASE_URL=https://api.sandbox.gemini.com/v1</code> for zero real-money risk during development. Public market-data tools need no keys.</p>
      <p><a href="/integrations/gemini" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/gemini',
      hasDedicatedPage: true,
    },
    {
      slug: 'kraken',
      displayName: 'Kraken',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">kraken mcp -s all</code> &middot; Single Rust binary (MIT), 151 commands, keyless paper engine',
      whatYouGet:
        "Composite verdict + the Kraken CLI's stdio MCP. Agent reads signals, simulates orders on the keyless paper engine before going live.",
      walkthroughHtml: `      <p>Install the Kraken CLI (one binary), then serve it over MCP next to AlgoVault:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">curl --proto '=https' --tlsv1.2 -LsSf https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh | sh
kraken mcp -s all</code></pre>
      </div>
      <p>The <code class="text-xs bg-navy-800 px-1 rounded">kraken paper</code> engine needs no keys and no account. Run <code class="text-xs">--validate</code> before any live order; arm <code class="text-xs">cancel-after</code> as a dead-man's switch.</p>
      <p><a href="/integrations/kraken" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/kraken',
      hasDedicatedPage: true,
    },
    {
      slug: 'alpaca',
      displayName: 'Alpaca',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">uvx alpaca-mcp-server</code> &middot; Crypto toolsets, paper venue default-on',
      whatYouGet:
        "Composite verdict + Alpaca's crypto MCP Server. Agent reads signals, places notional BTC/USD paper orders via place_crypto_order.",
      walkthroughHtml: `      <p>Run Alpaca's crypto MCP Server zero-install, scoped to crypto toolsets, alongside AlgoVault:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">{
  "mcpServers": {
    "algovault": {"url": "https://api.algovault.com/mcp"},
    "alpaca": {"command": "uvx", "args": ["alpaca-mcp-server"]}
  }
}</code></pre>
      </div>
      <p>Set <code class="text-xs bg-navy-800 px-1 rounded">ALPACA_TOOLSETS=trading,crypto-data</code> to scope crypto-only; <code class="text-xs">ALPACA_PAPER_TRADE</code> defaults to <code class="text-xs">true</code> for zero real-money risk.</p>
      <p><a href="/integrations/alpaca" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/alpaca',
      hasDedicatedPage: true,
    },
    // ── OPS-INTEGRATIONS-VENUE-PAGES-W1 (2026-07-21) ────────────────────────
    // Four AlgoVault SIGNAL venues that previously had no execution page.
    // Every primitive below was verified against a primary source and
    // re-probed live; see audits/OPS-INTEGRATIONS-VENUE-PAGES-W1-endpoint-truth.md.
    {
      slug: 'hyperliquid',
      displayName: 'Hyperliquid',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">pip install hyperliquid-python-sdk</code> &middot; official Python SDK (no official npm SDK)',
      whatYouGet:
        "Composite verdict + Hyperliquid's testnet perps API. Keyless demo builds the exact EIP-712 order action and prints it — nothing is signed or sent.",
      walkthroughHtml: `      <p>Hyperliquid signs orders with an EIP-712 wallet signature; the official Python SDK implements both signing schemes:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">pip install hyperliquid-python-sdk

from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants
exchange = Exchange(wallet, constants.TESTNET_API_URL, account_address=MASTER)</code></pre>
      </div>
      <p>Note the testnet faucet requires a prior mainnet deposit from the same address, and US/Ontario are Restricted Persons under Hyperliquid's Terms &sect;1.6.</p>
      <p><a href="/integrations/hyperliquid" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/hyperliquid',
      hasDedicatedPage: true,
    },
    {
      slug: 'aster',
      displayName: 'Aster',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">pip install git+https://github.com/asterdex/aster-connector-python.git</code> &middot; git-install only',
      whatYouGet:
        "Composite verdict + Aster's futures testnet on BNB Chain Testnet. V3 EIP-712 auth; V1 API-key creation closed 2026-03-25.",
      walkthroughHtml: `      <p>Aster publishes nothing to npm or PyPI &mdash; the official connector installs from git:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">pip install git+https://github.com/asterdex/aster-connector-python.git

# testnet base: https://fapi.asterdex-testnet.com
# EIP-712 chainId: 714 (testnet) / 1666 (mainnet)</code></pre>
      </div>
      <p>The V3 nonce is in microseconds and must sit within &plusmn;10s of server time.</p>
      <p><a href="/integrations/aster" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/aster',
      hasDedicatedPage: true,
    },
    {
      slug: 'bingx',
      displayName: 'BingX',
      surfaceType: 'exchange-kit',
      setupSummary:
        'No SDK to install &middot; plain <code class="text-xs bg-navy-800 px-1 rounded">fetch</code> + <code class="text-xs">node:crypto</code> against the VST demo host',
      whatYouGet:
        "Composite verdict + BingX's VST demo-trading environment. Dry-run order validation plus an API-callable demo-funds faucet.",
      walkthroughHtml: `      <p>BingX publishes no official client SDK, so the demo is dependency-free:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300"># demo host (paper trading, no real funds)
https://open-api-vst.bingx.com

POST /openApi/swap/v2/trade/order/test   # validates, places nothing
POST /openApi/swap/v2/trade/getVst       # top up demo balance</code></pre>
      </div>
      <p>Symbols on the VST host are normal (<code class="text-xs">BTC-USDT</code>), not <code class="text-xs">-VST</code>-suffixed.</p>
      <p><a href="/integrations/bingx" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/bingx',
      hasDedicatedPage: true,
    },
    {
      slug: 'kucoin',
      displayName: 'KuCoin',
      surfaceType: 'exchange-kit',
      setupSummary:
        '<code class="text-xs bg-navy-800 px-1 rounded">npm install kucoin-universal-sdk</code> &middot; the only non-archived official SDK',
      whatYouGet:
        'Composite verdict + KuCoin Futures order VALIDATION. KuCoin retired its sandbox in 2023, so this validates payloads rather than simulating fills.',
      walkthroughHtml: `      <p>KuCoin has no sandbox &mdash; it was delisted on 2023-07-10 and every sandbox host is NXDOMAIN. The demo uses the order-validation endpoint instead:</p>
      <div class="code-block bg-navy-800 border border-white/5 rounded-lg p-4">
        <pre><code class="text-xs text-gray-300">npm install kucoin-universal-sdk

POST https://api-futures.kucoin.com/api/v1/orders/test
# validates signature + params. Does NOT fill, no simulated balances.</code></pre>
      </div>
      <p>Every legacy per-language KuCoin SDK is archived &mdash; and several archived repos carry more stars than the live one.</p>
      <p><a href="/integrations/kucoin" class="text-mint-400 hover:underline">Full tutorial + runnable demo &rarr;</a></p>`,
      fullTutorialUrl: '/integrations/kucoin',
      hasDedicatedPage: true,
    },
  ],
};

export default EXCHANGE_KITS;
