#!/usr/bin/env bash
# cmc-ch1-gate.sh — LANDING-MCP-CLIENTS-CLAIMS-W1 CH1 (the ratified copy at every producer).
#
# Legs, from the repo root, each mapped to the chapter's acceptance criteria:
#   AC1  STRINGS     every R1–R12, R10b, R14–R18 BEFORE string is gone from its producers AND rendered pages,
#                    every AFTER string is present (the exact-string table below; index.html's R15 in
#                    both artboards).
#   AC2  ANCHORS     the changed rows carry exactly the spec's anchors, no anchor survives on a removed
#                    claim; `emit-claim-evidence.mjs --check` → CLAIM_EVIDENCE_VERDICT=IN_SYNC; R1–R7 are
#                    tests/unit/claim-evidence.test.ts, read from the suite report (named tests).
#   AC3  COPY        check-mcp-client-copy.mjs → MCP_CLIENT_COPY_VERDICT=PASS (CHECK 1 + CHECK 9 included),
#        REDPROOF    and both checks proven able to fail ON THE REAL CORPUS: un-quoting a real producer
#                    line must fire CHECK 9, restoring a retired path in a real page must fire CHECK 1, and
#                    the gate source carries no CHECK 9 exemption list.
#   AC4  RENDERED    scripts/gates/cmc-rendered-diff.mjs --check → RENDERED_DIFF_VERDICT=MATCH for the
#                    chapter's rows (R1–R12, R10b, R14–R18).
#   AC5  DATES       verifiedAt = the CH1 date on every edited row; codex.md's verified twin matches.
#   AC6  HOMEPAGE    the vault JSX backup exists, and a fresh render-jsx-static of landing-rest equals
#                    landing/index.html's #quickstart section (re-baked whole: R15 + R18) byte for byte in BOTH artboards (the mobile
#                    artboard carries no id attributes — the same rule its assembly applies).
#   AC7  suite       the full vitest suite → classify-suite-verdict.mjs, as deploy.yml runs it;
#        docs/landing  build_docs --check + build_landing --check rc 0;
#        RENDERSYNC  render-integrations has no --check (R0 D1), so it is re-run from a clean
#                    algovault-skills clone and the 5 pages this wave changed must equal the committed
#                    ones once the live fallbacks and the render date are masked; every page is restored;
#        FIXTURE     the byte-equivalence fixture's re-baseline diff maps to R-rows only.
#
# Verdict — exactly one terminal line, the token is the contract:
#   CH1_GREEN 0 · CH1_RED 1 · CH1_INDETERMINATE 3 (a tool is missing, or a leg produced no verdict).
#
# Bash on purpose (the tool shell is zsh, where ${PIPESTATUS[0]} is empty and [ "" -eq 0 ] is TRUE).
# --self-test drives the REAL decide() (the script is sourceable) over synthetic legs, plus a
# PATH-stripped run for the missing-tool precondition. No env seam can fake a leg.
#
# Usage:  bash scripts/gates/cmc-ch1-gate.sh            bash scripts/gates/cmc-ch1-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(node npm npx python3 git grep)
NAMED_TESTS='tests/unit/claim-evidence.test.ts tests/unit/integrations-data.test.ts tests/unit/mcp-usage-docs-byte-equivalence.test.ts tests/unit/mcp-usage-docs.test.ts'
CH1_DATE='2026-10-01'   # the CH1 date (date -u +%F when CH1 ran) — verifiedAt on every edited row
CH1_ROWS='R1,R2,R3,R4,R5,R6,R7,R8,R9,R10,R10b,R11,R12,R14,R15,R16,R17,R18'   # rev 3 adds R10b + R18
TARGET_PAGES='claude-desktop codex smithery claude-code binance-agent-os'
SKILLS_REPO='https://github.com/AlgoVaultLabs/algovault-skills.git'

# verdict helpers: "PASS"/"MATCH"/"IN_SYNC" ok · "FAIL"/"MISMATCH"/"DRIFT" red · anything else unverified
leg() { # <name> <value> <ok-token> <red-token>
  case "$2" in "$3") ;; "$4") red="$red $1" ;; *) ind="$ind $1:${2:-none}" ;; esac
}

# decide <build_rc> <suite> <named> <strings> <anchors> <evidence> <copy> <redproof> <rendered>
#        <dates> <homepage> <docs_rc> <landing_rc> <rendersync> <fixture>
decide() {
  local build_rc="$1" suite="$2" named="$3" strings="$4" anchors="$5" ev="$6" copy="$7" redproof="$8"
  local rendered="$9" dates="${10}" homepage="${11}" docs="${12}" landing="${13}" rsync="${14}" fixture="${15}"
  red="" ind=""
  [ "$build_rc" = "0" ] || red="$red build"
  case "$suite" in PASS|PASS_AFTER_ISOLATION) ;; FAIL) red="$red suite" ;; *) ind="$ind suite:${suite:-none}" ;; esac
  case "$named" in passed) ;; failed) red="$red named-tests" ;; *) ind="$ind named-tests:${named:-none}" ;; esac
  leg strings "$strings" PASS FAIL
  leg anchors "$anchors" PASS FAIL
  leg claim-evidence "$ev" IN_SYNC DRIFT
  leg mcp-client-copy "$copy" PASS FAIL
  leg red-proof "$redproof" PASS FAIL
  leg rendered-diff "$rendered" MATCH MISMATCH
  leg dates "$dates" PASS FAIL
  leg homepage "$homepage" PASS FAIL
  case "$docs" in 0) ;; 1) red="$red build_docs" ;; *) ind="$ind build_docs:rc=${docs:-none}" ;; esac
  case "$landing" in 0) ;; 1) red="$red build_landing" ;; *) ind="$ind build_landing:rc=${landing:-none}" ;; esac
  leg render-sync "$rsync" PASS FAIL
  leg fixture "$fixture" PASS FAIL
  if [ -n "$red" ]; then printf '[cmc-ch1-gate] RED:%s%s\n' "$red" "${ind:+ (also unverified:$ind)}" >&2; echo CH1_RED; return 1; fi
  if [ -n "$ind" ]; then printf '[cmc-ch1-gate] cannot verify:%s\n' "$ind" >&2; echo CH1_INDETERMINATE; return 3; fi
  printf '[cmc-ch1-gate] AC1-AC7: strings, anchors, copy + red-proof, rendered diff, dates, homepage, suite, checks, render sync, fixture — all passed\n' >&2
  echo CH1_GREEN; return 0
}

# ── AC1 + AC2 + AC5: the exact-string table, the anchor table, the dates ─────────────────────────
static_legs() { # <vault_jsx> → STRINGS= ANCHORS= DATES= lines
  python3 - "$1" "$CH1_DATE" <<'PY'
import json, sys
jsx, ch1 = sys.argv[1], sys.argv[2]
BS = "\\"
T = {
 "src/lib/integrations-data/mcp-clients.ts": (
   ["Settings &rarr; Connectors &rarr; <em>Add custom connector</em>", "<em>Settings</em> &rarr; <em>Connectors</em>",
    "as a custom header (paid tier)", "Name it <code", "Authorization: Bearer " + BS + "${AV_API_KEY}",
    "in the env block or your shell", "covers local stdio servers only", "@smithery/cli install",
    "prompts for any required env vars", "smithery.ai/server/@AlgoVaultLabs", '"version":"1.10.3"',
    "algovault https://api.algovault.com/mcp?src=docs", "\n  https://api.algovault.com/mcp?src=docs " + BS + BS,
    "source: 'https://modelcontextprotocol.io/quickstart/user'", "source: 'https://cursor.com/docs/context/mcp'",
    "source: 'https://docs.cline.bot/mcp/connecting-to-a-remote-server'"],
   ["Customize &rarr; Connectors &rarr; + &rarr; <em>Add custom connector</em>, or edit",
    "<strong>Easiest path (UI, free tier):</strong> Open Claude Desktop &rarr; <em>Customize</em> &rarr; <em>Connectors</em> &rarr; <em>+</em> &rarr; <em>Add custom connector</em>. Paste <code class=\"text-xs bg-navy-800 px-1 rounded\">https://api.algovault.com/mcp?src=docs</code>, then click <em>Add</em>. Enable it per chat from <em>+</em> &rarr; <em>Connectors</em>. The connector form takes OAuth credentials, not custom headers &mdash; for a paid-tier key, use the JSON path below.</p>",
    '"--header", "Authorization:' + BS + '${AUTH_HEADER}",', '"env": { "AUTH_HEADER": "Bearer av_live_&hellip;" }',
    "Set your key in the env block. Free tier: drop the <code class=\"text-xs\">Authorization</code> header and the env block, but keep the <code class=\"text-xs\">X-AlgoVault-Track-Token</code> header.",
    "codex mcp add algovault --url \"https://api.algovault.com/mcp?src=docs\"</code> adds the free tier from the CLI; the paid tier's <code class=\"text-xs\">bearer_token_env_var</code> is set in <code class=\"text-xs\">config.toml</code>, as above.",
    "npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client &lt;name&gt;</code>",
    "npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client &lt;client&gt;</code>",
    "The CLI writes a Smithery-gateway entry into your client's config. It carries no API key, so this path is the free tier.",
    'href="https://smithery.ai/servers/algovault/crypto-quant-signal-mcp"',
    'Returns <code class="text-xs bg-navy-800 px-1 rounded">{"status":"ok","server":"crypto-quant-signal-mcp","version":"&lt;current release&gt;","stripe":true}</code>.',
    'algovault "https://api.algovault.com/mcp?src=docs" ' + BS + BS, '\n  "https://api.algovault.com/mcp?src=docs" ' + BS + BS,
    "source: 'https://cursor.com/docs/mcp'", "source: 'https://docs.cline.bot/mcp/mcp-overview'", "source: 'https://api.algovault.com/health'"]),
 "src/lib/integrations-data/exchange-kits.ts": (
   ["\n  https://api.algovault.com/mcp?src=binance_agent_os</code>"], ['\n  "https://api.algovault.com/mcp?src=binance_agent_os"</code>']),
 "docs/integrations/mcp-clients/claude-desktop.md": (
   ["Settings &rarr; Connectors", "Name: `AlgoVault`", "as a custom header", "Authorization: Bearer ${AV_API_KEY}",
    "in the env block or your shell", "restart Claude Desktop after saving the connector", "is set in the JSON env block, not just your shell"],
   ["**Path 1 — UI (recommended).** Open Claude Desktop &rarr; Customize &rarr; Connectors &rarr; + &rarr; *Add custom connector*. Paste `https://api.algovault.com/mcp?src=docs`, then click *Add*. Enable it per chat from + &rarr; Connectors. The connector form takes OAuth credentials, not custom headers — for a paid-tier key, use the JSON path below.",
    '"--header", "Authorization:${AUTH_HEADER}",', '"env": { "AUTH_HEADER": "Bearer av_live_…" }',
    "Set your key in the env block. Free tier: drop the `Authorization` header and the env block, but keep the `X-AlgoVault-Track-Token` header.",
    "— enable it for the chat from + → Connectors.", "— confirm `AUTH_HEADER` is set in the JSON env block as `Bearer av_live_…`."]),
 "docs/integrations/mcp-clients/codex.md": (
   ["local stdio servers only", "rejected the URL", "Config verified 2026-08-05"],
   ["`codex mcp add algovault --url \"https://api.algovault.com/mcp?src=docs\"` adds the free tier from the CLI; the paid tier's `bearer_token_env_var` is set in `config.toml`, as above.",
    "Config verified " + ch1 + " against <https://learn.chatgpt.com/docs/extend/mcp>"]),
 "docs/integrations/mcp-clients/smithery.md": (
   ["@smithery/cli install", "prompts for `AV_API_KEY`", "config-path", "smithery.ai/server/@AlgoVaultLabs", "AlgoVault MCP installed for Claude Desktop",
    "Continue.dev support is in beta", "Hit Enter at the API-key prompt", "Same result as hand-editing the JSON"],
   ["npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client <name>",
    "The CLI writes a Smithery-gateway entry into your client's config. It carries no API key, so this path is the free tier.",
    "$ npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client claude\n? Would you like to help improve Smithery by sending anonymized usage data? No\n✔ Successfully resolved algovault/crypto-quant-signal-mcp\n* Installing remote server. Please ensure you trust the server author, especially when sharing sensitive data.\n\n✓ algovault/crypto-quant-signal-mcp successfully installed for claude",
    "[smithery.ai/servers/algovault/crypto-quant-signal-mcp](https://smithery.ai/servers/algovault/crypto-quant-signal-mcp)",
    "**Existing AlgoVault entry overwritten**",
    "**Which clients does Smithery support?** Claude Desktop, Cursor, Cline, Claude Code and Codex, among others.",
    "**Free tier setup?** Yes. Smithery's entry carries no API key, so this path is the free tier. The first time your client connects, Smithery asks you to authorize it in your browser.",
    "**What does Smithery actually do?** It adds an entry for Smithery's gateway (`server.smithery.ai/algovault/crypto-quant-signal-mcp/mcp`) to your client's config, and your calls reach AlgoVault through that gateway. For a paid-tier key, add AlgoVault by hand instead; that connects to `api.algovault.com` directly."]),
 "docs/integrations/mcp-clients/claude-code.md": (
   ["\n  https://api.algovault.com/mcp?src=docs " + BS], ['\n  "https://api.algovault.com/mcp?src=docs" ' + BS]),
 "docs/integrations/exchange-kits/binance-agent-os.md": (
   ["\n  https://api.algovault.com/mcp?src=binance_agent_os " + BS], ['\n  "https://api.algovault.com/mcp?src=binance_agent_os" ' + BS]),
 "landing/llms-full.txt": (
   ["\n  https://api.algovault.com/mcp?src=binance_agent_os " + BS], ['\n  "https://api.algovault.com/mcp?src=binance_agent_os" ' + BS]),
 "README.md": (
   ["Settings → Connectors", "claude mcp add crypto-quant-signal https", "~/.cursor/config.json"],
   ["**1. Add the connector.** In Claude → Customize → Connectors → + → Add custom connector:",
    "| **Claude Desktop** | Customize → Connectors → + → Add custom connector → `https://api.algovault.com/mcp` |",
    "| **Claude Code** (CLI) | `claude mcp add --transport http crypto-quant-signal https://api.algovault.com/mcp` |",
    "| **Cursor** | `~/.cursor/mcp.json` → `mcpServers` block → `url: \"https://api.algovault.com/mcp\"` |"]),
 "landing/faq.html": (
   ["Settings → Connectors", "Settings &rarr; Connectors"],
   ["Claude Desktop: Customize → Connectors → + → Add custom connector → paste the URL.",
    "Claude Desktop: Customize &rarr; Connectors &rarr; + &rarr; Add custom connector &rarr; paste the URL."]),
 "landing/docs.html": (
   ["Settings &rarr; Connectors &rarr; <em>", "<em>Settings</em> &rarr; <em>Connectors</em>", "covers local stdio servers only",
    "@smithery/cli install", '"version":"1.10.3"', "prompts for any required env vars", "smithery.ai/server/@AlgoVaultLabs",
    "algovault https://api.algovault.com/mcp?src=docs", "\n  https://api.algovault.com/mcp?src=docs " + BS,
    "\n  https://api.algovault.com/mcp?src=binance_agent_os</code>"],
   ["Customize &rarr; Connectors &rarr; + &rarr; <em>Add custom connector</em>", "Easiest path (UI, free tier):",
    "The connector form takes OAuth credentials, not custom headers &mdash; for a paid-tier key, use the JSON path below.",
    '"--header", "Authorization:${AUTH_HEADER}",', '"env": { "AUTH_HEADER": "Bearer av_live_&hellip;" }',
    'codex mcp add algovault --url "https://api.algovault.com/mcp?src=docs"</code>',
    "npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client &lt;client&gt;", "Smithery-gateway entry",
    '"server":"crypto-quant-signal-mcp","version":"&lt;current release&gt;"', 'algovault "https://api.algovault.com/mcp?src=docs" ' + BS,
    '\n  "https://api.algovault.com/mcp?src=binance_agent_os"</code>']),
 "landing/mcp.html": (
   ["Settings &rarr; Connectors &rarr; <em>", "<em>Settings</em> &rarr; <em>Connectors</em>", "covers local stdio servers only",
    "@smithery/cli install", '"version":"1.10.3"', "algovault https://api.algovault.com/mcp?src=docs", "\n  https://api.algovault.com/mcp?src=docs " + BS],
   ["Customize &rarr; Connectors &rarr; + &rarr; <em>Add custom connector</em>", "Easiest path (UI, free tier):",
    '"--header", "Authorization:${AUTH_HEADER}",', 'codex mcp add algovault --url "https://api.algovault.com/mcp?src=docs"</code>',
    "Smithery-gateway entry", '"server":"crypto-quant-signal-mcp","version":"&lt;current release&gt;"', 'algovault "https://api.algovault.com/mcp?src=docs" ' + BS]),
 "landing/integrations.html": (
   ["Settings &rarr; Connectors &rarr; <em>", "@smithery/cli install"],
   ["Customize &rarr; Connectors &rarr; + &rarr; <em>Add custom connector</em>", "npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client &lt;name&gt;"]),
 "landing/integrations/claude-desktop.html": (
   ["Settings → Connectors", "as a custom header", "Authorization: Bearer ${AV_API_KEY}", "in the env block or your shell", "after saving the connector"],
   ["Open Claude Desktop → Customize → Connectors → + → <em>Add custom connector</em>",
    "The connector form takes OAuth credentials, not custom headers — for a paid-tier key, use the JSON path below.",
    "&quot;Authorization:${AUTH_HEADER}&quot;", "Set your key in the env block.", "enable it for the chat from + → Connectors."]),
 "landing/integrations/codex.html": (
   ["local stdio servers only", "rejected the URL", "Config verified 2026-08-05"],
   ["codex mcp add algovault --url &quot;https://api.algovault.com/mcp?src=docs&quot;</code>", "Config verified " + ch1 + " against"]),
 "landing/integrations/smithery.html": (
   ["@smithery/cli install", "config-path", "smithery.ai/server/@AlgoVaultLabs", "Continue.dev support is in beta", "Hit Enter at the API-key prompt"],
   ["@smithery/cli mcp add algovault/crypto-quant-signal-mcp --client &lt;name&gt;", "Smithery-gateway entry",
    "successfully installed for claude", "smithery.ai/servers/algovault/crypto-quant-signal-mcp",
    "Claude Code and Codex, among others.", "entry carries no API key, so this path is the free tier. The first time your client connects, Smithery asks you to authorize it in your browser.",
    "<code>server.smithery.ai/algovault/crypto-quant-signal-mcp/mcp</code>", "add AlgoVault by hand instead; that connects to <code>api.algovault.com</code> directly."]),
 "landing/integrations/claude-code.html": (
   ["\n  https://api.algovault.com/mcp?src=docs " + BS], ["\n  &quot;https://api.algovault.com/mcp?src=docs&quot; " + BS]),
 "landing/integrations/binance-agent-os.html": (
   ["\n  https://api.algovault.com/mcp?src=binance_agent_os " + BS], ["\n  &quot;https://api.algovault.com/mcp?src=binance_agent_os&quot; " + BS]),
 "landing/index.html": (
   ["Open Claude → Settings → Connectors", ">Add custom connector → paste the URL<"], []),
 jsx: (
   ["title: 'Open Claude → Settings → Connectors'", "title: 'Add custom connector → paste the URL'"],
   ["title: 'Open Claude → Customize → Connectors'", "title: '+ → Add custom connector → paste the URL'"]),
}
COUNTS = {"landing/index.html": [("Open Claude → Customize → Connectors", 2), ("+ → Add custom connector → paste the URL", 2),
                                  ('href="/integrations/deepseek-harness"', 2), (">DeepSeek Harness</div>", 2)]}
bad, n = [], 0
for path, (absent, present) in T.items():
    try:
        s = open(path, encoding="utf-8").read()
    except OSError as e:
        print("STRINGS=INDETERMINATE"); print(f"cannot read {path}: {e}", file=sys.stderr); sys.exit(0)
    for a in absent:
        n += 1
        if a in s: bad.append(f"{path}: BEFORE still present: {a[:90]!r}")
    for p in present:
        n += 1
        if p not in s: bad.append(f"{path}: AFTER missing: {p[:90]!r}")
    for p, k in COUNTS.get(path, []):
        n += 1
        if s.count(p) != k: bad.append(f"{path}: {p!r} appears {s.count(p)}×, want {k} (both artboards)")
for b in bad: print("  ✗ " + b, file=sys.stderr)
print(f"STRINGS={'FAIL' if bad else 'PASS'}"); print(f"[strings] {n} checks, {len(bad)} failed", file=sys.stderr)

# AC2 — the changed rows' anchors are exactly the spec's; removed claims are gone everywhere
ART = "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp"
CODEX = "https://learn.chatgpt.com/docs/extend/mcp"
WANT = {
 "claude-desktop": [
   {"claim": "Customize → Connectors → + → Add custom connector", "source": ART, "expect": ["Customize > Connectors", "Add custom connector"]},
   {"claim": "The connector form takes OAuth credentials, not custom headers", "source": ART, "expect": ["OAuth Client ID", "OAuth Client Secret"], "reject": ["custom header"]},
   {"claim": "claude_desktop_config.json", "source": ART, "expect": ["claude_desktop_config.json"]},
   {"claim": '"mcp-remote"', "source": "https://registry.npmjs.org/mcp-remote", "expect": ["--header"]},
   {"claim": "Authorization:${AUTH_HEADER}", "source": "https://registry.npmjs.org/mcp-remote", "expect": ["Authorization:${AUTH_HEADER}"]}],
 "codex": [
   {"claim": "bearer_token_env_var", "source": CODEX, "expect": ["bearer_token_env_var", "http_headers", "config.toml"]},
   {"claim": "codex mcp add algovault --url", "source": CODEX, "expect": ["codex mcp add", "--url"]}],
 "smithery": [
   {"claim": "npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp", "source": "https://www.npmjs.com/package/@smithery/cli", "expect": ["smithery mcp add"]},
   {"claim": "algovault/crypto-quant-signal-mcp", "source": "https://registry.smithery.ai/servers/algovault/crypto-quant-signal-mcp", "expect": ['"qualifiedName":"algovault/crypto-quant-signal-mcp"']},
   {"claim": "--client <client>", "source": "https://unpkg.com/@smithery/cli/dist/index.js", "expect": ["Install directly to an AI client"]}],
 "plain-http": [
   {"claim": '"status":"ok"', "source": "https://api.algovault.com/health", "expect": ['"status":"ok"']},
   {"claim": '"server":"crypto-quant-signal-mcp"', "source": "https://api.algovault.com/health", "expect": ['"server":"crypto-quant-signal-mcp"']}],
}
REMOVED = ["Settings → Connectors → Add custom connector", "as a custom header (paid tier)", "codex mcp add covers local stdio servers only",
           "npx -y @smithery/cli install crypto-quant-signal-mcp --client", '"version":"1.10.3"']
try:
    doc = json.load(open("src/lib/integrations-data/claim-evidence.json", encoding="utf-8"))
    rows = {r["slug"]: r for r in doc["rows"]}
except Exception as e:
    print("ANCHORS=INDETERMINATE"); print("DATES=INDETERMINATE"); print(f"claim-evidence.json unreadable: {e}", file=sys.stderr); sys.exit(0)
abad = []
for slug, want in WANT.items():
    got = rows.get(slug, {}).get("evidence")
    # CH2 may APPEND anchors (the README-cell bindings); the spec's anchors must lead, unchanged.
    if got is None or got[:len(want)] != want: abad.append(f"{slug}: anchors differ from the spec table")
for c in REMOVED:
    if any(a["claim"] == c for r in rows.values() for a in r["evidence"]): abad.append(f"an anchor survives on removed claim {c!r}")
for b in abad: print("  ✗ " + b, file=sys.stderr)
print(f"ANCHORS={'FAIL' if abad else 'PASS'}")
# AC5
EDITED = ["claude-desktop", "cursor", "cline", "claude-code", "smithery", "plain-http", "codex", "deepseek"]
dbad = [f"{s}: verifiedAt {rows.get(s, {}).get('verifiedAt')} != {ch1}" for s in EDITED if rows.get(s, {}).get("verifiedAt") != ch1]
twin = open("docs/integrations/mcp-clients/codex.md", encoding="utf-8").read()
if f"Config verified {ch1} against <{rows['codex']['source']}>" not in twin: dbad.append("codex.md verified twin does not match the row")
for b in dbad: print("  ✗ " + b, file=sys.stderr)
print(f"DATES={'FAIL' if dbad else 'PASS'}")
PY
}

# ── AC3: both copy checks proven able to fail on the REAL corpus ──────────────────────────────────
redproof_leg() {
  node --input-type=module - <<'JS' 2>&1
import { readFileSync } from 'node:fs';
const m = await import(process.cwd() + '/scripts/check-mcp-client-copy.mjs');
const fails = [];
const real = (p) => readFileSync(p, 'utf8');
// CHECK 9: the real claude-code tutorial passes; with its URL un-quoted it must fire, at that line.
const cc = 'docs/integrations/mcp-clients/claude-code.md';
if (m.checkShellGlobs([cc], real).hits.length !== 0) fails.push('CHECK 9 fires on the corrected claude-code.md');
const unq = (p) => real(p).replace('"https://api.algovault.com/mcp?src=docs"', 'https://api.algovault.com/mcp?src=docs');
const h9 = m.checkShellGlobs([cc], unq).hits;
if (h9.length !== 1 || !/mcp\?src=docs/.test(h9[0].token)) fails.push(`CHECK 9 did not fire on an un-quoted real producer (hits=${h9.length})`);
// ...and on a real GENERATED page (docs.html), where the same producer renders.
const dh = 'landing/docs.html';
const unqd = (p) => real(p).replace('algovault "https://api.algovault.com/mcp?src=docs" ', 'algovault https://api.algovault.com/mcp?src=docs ');
if (m.checkShellGlobs([dh], unqd).hits.length < 1) fails.push('CHECK 9 did not fire on an un-quoted real generated page');
// CHECK 1: the real /faq passes; with the retired path restored it must fire.
const fq = 'landing/faq.html';
if (m.checkRetiredPaths([fq], real).length !== 0) fails.push('CHECK 1 fires on the corrected faq.html');
const stale = (p) => real(p).replace('Customize &rarr; Connectors &rarr; + &rarr;', 'Settings &rarr; Connectors &rarr;');
if (m.checkRetiredPaths([fq], stale).length !== 1) fails.push('CHECK 1 did not fire on a restored retired path');
// zero exemptions: CHECK 9 takes no allow-list, and the source declares none
const src = readFileSync('scripts/check-mcp-client-copy.mjs', 'utf8');
if (/SHELL[_A-Z]*EXEMPT|EXEMPT[_A-Z]*SHELL|GLOB[_A-Z]*ALLOW/i.test(src)) fails.push('a CHECK 9 exemption/allow-list exists');
if (m.checkShellGlobs.length !== 2) fails.push('checkShellGlobs grew a parameter (an exemption seam?)');
for (const f of fails) console.error('  ✗ ' + f);
console.log(`REDPROOF=${fails.length ? 'FAIL' : 'PASS'}`);
JS
}

# ── AC6: the homepage quickstart is the renderer's output, byte for byte, in both artboards ──────
homepage_leg() { # <tmp>
  local tmp="$1" jsxdir='/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/Design/AlgoVault Landing Hero v1'
  local n; n="$(ls "$jsxdir" 2>/dev/null | grep -c '^v1-landing-rest\.jsx\.bak\.PRE-LANDING-MCP-CLIENTS-CLAIMS-W1-')"
  if [ "$n" != "1" ]; then echo "  ✗ vault JSX backup count=$n (want 1)" >&2; echo "HOMEPAGE=FAIL"; return; fi
  node scripts/render-jsx-static.mjs --target=landing-rest --mobile=false --out="$tmp/lr-d.html" >/dev/null 2>&1 || { echo "HOMEPAGE=INDETERMINATE"; return; }
  node scripts/render-jsx-static.mjs --target=landing-rest --mobile=true --out="$tmp/lr-m.html" >/dev/null 2>&1 || { echo "HOMEPAGE=INDETERMINATE"; return; }
  python3 - "$tmp/lr-d.html" "$tmp/lr-m.html" <<'PY'
import re, sys
def section(html, opener, start=0):
    i = html.find(opener, start)
    if i < 0: return None
    depth = 0
    for m in re.compile(r"<(/?)section\b[^>]*>").finditer(html, i):
        depth += -1 if m.group(1) else 1
        if depth == 0: return html[i:m.end()]
    return None
idx = open("landing/index.html", encoding="utf-8").read()
d_new = section(open(sys.argv[1], encoding="utf-8").read(), '<section id="quickstart"')
m_new = section(open(sys.argv[2], encoding="utf-8").read(), '<section id="quickstart"')
d_old = section(idx, '<section id="quickstart"', idx.find('<div class="lp-rest-desktop">'))
m_old = section(idx, '<section data-anchor="quickstart"', idx.find('<div class="lp-rest-mobile">'))
if None in (d_new, m_new, d_old, m_old):
    print("HOMEPAGE=INDETERMINATE"); print("a #quickstart section was not found", file=sys.stderr); sys.exit(0)
m_new = re.sub(r' id="[^"]*"', "", m_new)   # the mobile artboard carries no id (HTML id uniqueness)
bad = []
if d_new != d_old: bad.append("desktop #quickstart differs from a fresh render")
if m_new != m_old: bad.append("mobile #quickstart differs from a fresh render")
for b in bad: print("  ✗ " + b, file=sys.stderr)
print(f"HOMEPAGE={'FAIL' if bad else 'PASS'}")
PY
}

# ── AC7: render-integrations re-run equals the committed pages (live fallbacks + render date masked)
rendersync_leg() { # <tmp> — every page is restored on every path, so the tree is left as found
  local tmp="$1" out
  git clone --quiet "$SKILLS_REPO" "$tmp/skills" >/dev/null 2>&1 || { echo "  ✗ cannot clone algovault-skills" >&2; echo "RENDERSYNC=INDETERMINATE"; return; }
  mkdir -p "$tmp/before" && cp landing/integrations/*.html "$tmp/before/" || { echo "RENDERSYNC=INDETERMINATE"; return; }
  out="$(rendersync_inner "$tmp")"
  cp "$tmp/before/"*.html landing/integrations/
  printf '%s\n' "$out"
}
rendersync_inner() { # <tmp>
  local tmp="$1" p
  if ! node scripts/render-integrations.mjs --source "$tmp/skills" >"$tmp/render.log" 2>&1; then echo "  ✗ render-integrations failed (see $tmp/render.log)" >&2; echo "RENDERSYNC=INDETERMINATE"; return; fi
  for p in build_nav build_theme inject-footer build_analytics build_asset_versions; do
    node "scripts/$p.mjs" >>"$tmp/render.log" 2>&1 || { echo "  ✗ $p failed" >&2; echo "RENDERSYNC=INDETERMINATE"; return; }
  done
  python3 - "$tmp/before" $TARGET_PAGES <<'PY'
import re, sys
before, pages = sys.argv[1], sys.argv[2:]
mask = lambda s: re.sub(r'(data-tr-field="[a-z_]+">)[^<]*', r'\1#', re.sub(r'<meta name="last-updated" content="[^"]*">', '<meta name="last-updated" content="#">', s))
bad = [p for p in pages if mask(open(f"{before}/{p}.html", encoding="utf-8").read()) != mask(open(f"landing/integrations/{p}.html", encoding="utf-8").read())]
for p in bad: print(f"  ✗ landing/integrations/{p}.html is not what render-integrations produces from its source", file=sys.stderr)
print(f"RENDERSYNC={'FAIL' if bad else 'PASS'}")
PY
}

# ── AC7: the fixture re-baseline maps to R-rows only ─────────────────────────────────────────────
fixture_leg() { # <base>
  node --input-type=module - "$1" <<'JS' 2>&1
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const rd = await import(process.cwd() + '/scripts/gates/cmc-rendered-diff.mjs');
const base = process.argv[2];
const f = 'tests/fixtures/mcp-usage-html-pre-refactor.txt';
const old = execFileSync('git', ['show', `${base}:${f}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
const cur = readFileSync(f, 'utf8');
// The fixture is HTML: classify it in HTML units, as a page that renders the mcp-clients surface.
const entries = rd.classifyFile('landing/docs.html', rd.diffUnits('fixture.html', old, cur), old, cur);
const bad = entries.filter((e) => e.kind !== 'copy');
for (const e of bad) console.error(`  ✗ fixture unit maps to no R-row: ${e.op} ${e.unit.slice(0, 120)}`);
console.log(entries.length === 0 ? 'FIXTURE=INDETERMINATE' : `FIXTURE=${bad.length ? 'FAIL' : 'PASS'}`);
JS
}

val() { grep -E "^$1=" | tail -n 1 | sed "s/^$1=//"; }

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[cmc-ch1-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH1_INDETERMINATE; exit 3; }
  done
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_QUARANTINE_PATH
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "[cmc-ch1-gate] not inside a git checkout" >&2; echo CH1_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH1_INDETERMINATE; exit 3; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cmc-ch1-gate.XXXXXX")" || { echo CH1_INDETERMINATE; exit 3; }
  local jsx='/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/Design/AlgoVault Landing Hero v1/v1-landing-rest.jsx'

  rm -rf dist
  { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1
  local build_rc=$?
  local suite="" named="missing" strings="" anchors="" ev="" copy="" redproof="" rendered="" dates="" homepage="" docs="" landing="" rsync="" fixture=""
  if [ "$build_rc" -eq 0 ]; then
    local st; st="$(static_legs "$jsx" 2>"$tmp/static.err")"
    strings="$(printf '%s\n' "$st" | val STRINGS)"; anchors="$(printf '%s\n' "$st" | val ANCHORS)"; dates="$(printf '%s\n' "$st" | val DATES)"
    ev="$(node scripts/emit-claim-evidence.mjs --check 2>/dev/null | val CLAIM_EVIDENCE_VERDICT)"
    copy="$(node scripts/check-mcp-client-copy.mjs 2>"$tmp/copy.err" | val MCP_CLIENT_COPY_VERDICT)"
    redproof="$(redproof_leg | tee "$tmp/redproof.log" | val REDPROOF)"
    git fetch origin --quiet >/dev/null 2>&1 || true
    local base; base="$(git merge-base HEAD origin/main 2>/dev/null)"
    if [ -n "$base" ]; then
      rendered="$(node scripts/gates/cmc-rendered-diff.mjs --check --base "$base" --rows "$CH1_ROWS" 2>"$tmp/rendered.err" | val RENDERED_DIFF_VERDICT)"
      fixture="$(fixture_leg "$base" | tee "$tmp/fixture.log" | val FIXTURE)"
    fi
    homepage="$(homepage_leg "$tmp" 2>"$tmp/homepage.err" | val HOMEPAGE)"
    node scripts/build_docs.mjs --check >"$tmp/build_docs.log" 2>&1; docs=$?
    node scripts/build_landing.mjs --check >"$tmp/build_landing.log" 2>&1; landing=$?
    rsync="$(rendersync_leg "$tmp" 2>"$tmp/rendersync.err" | val RENDERSYNC)"
    # deploy.yml's cold-DB pre-warm (best effort), then the suite exactly as deploy.yml runs it.
    npx vitest run tests/agent-session-source-stamp.test.ts </dev/null >/dev/null 2>&1 || true
    npx vitest run --reporter=default --reporter=json --outputFile="$tmp/report.json" \
      --reporter=./scripts/vitest-error-shape-reporter.mjs </dev/null >"$tmp/vitest.log" 2>&1 || true
    mv -f .vitest-error-shapes.json "$tmp/shapes.json" 2>/dev/null || true
    suite="$(node scripts/classify-suite-verdict.mjs "$tmp/report.json" --sidecar="$tmp/shapes.json" 2>/dev/null | val SUITE_VERDICT)"
    named="$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      let out = "passed";
      for (const want of process.argv[2].split(" ")) {
        const f = (r.testResults || []).find((t) => String(t.name).endsWith(want));
        if (!f) { out = "missing"; break; }
        const a = f.assertionResults || [];
        if (!(a.length > 0 && a.every((x) => x.status === "passed"))) out = "failed";
      }
      console.log(out);
    ' "$tmp/report.json" "$NAMED_TESTS" 2>/dev/null || echo missing)"
  fi
  printf '[cmc-ch1-gate] build_rc=%s suite=%s named=%s strings=%s anchors=%s evidence=%s copy=%s redproof=%s rendered=%s dates=%s homepage=%s docs_rc=%s landing_rc=%s rendersync=%s fixture=%s\n' \
    "$build_rc" "${suite:-none}" "$named" "${strings:-none}" "${anchors:-none}" "${ev:-none}" "${copy:-none}" "${redproof:-none}" \
    "${rendered:-none}" "${dates:-none}" "${homepage:-none}" "${docs:-none}" "${landing:-none}" "${rsync:-none}" "${fixture:-none}" >&2
  local rc
  decide "$build_rc" "$suite" "$named" "$strings" "$anchors" "$ev" "$copy" "$redproof" "$rendered" "$dates" "$homepage" "$docs" "$landing" "$rsync" "$fixture"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"; else printf '[cmc-ch1-gate] evidence kept: %s\n' "$tmp" >&2; fi
  exit "$rc"
}

self_test() {
  local pass=0 fail=0 cases=0
  check() { # <name> <want token> <want rc> <15 decide args>
    local name="$1" want="$2" want_rc="$3"; shift 3
    local out rc
    out="$(decide "$@" 2>/dev/null)"; rc=$?
    cases=$((cases + 1))
    if [ "$out" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$out' rc=$rc, want '$want' rc=$want_rc)"; fi
  }
  local G=(0 PASS passed PASS PASS IN_SYNC PASS PASS MATCH PASS PASS 0 0 PASS PASS)
  check all-green CH1_GREEN 0 "${G[@]}"
  local -a args
  local spec
  for spec in "1:PASS_AFTER_ISOLATION:green" "0:2:red" "1:FAIL:red" "2:failed:red" "3:FAIL:red" "4:FAIL:red" "5:DRIFT:red" \
              "6:FAIL:red" "7:FAIL:red" "8:MISMATCH:red" "9:FAIL:red" "10:FAIL:red" "11:1:red" "12:1:red" "13:FAIL:red" "14:FAIL:red" \
              "1::ind" "2:missing:ind" "3:INDETERMINATE:ind" "4::ind" "5:INDETERMINATE:ind" "6::ind" "7::ind" "8:INDETERMINATE:ind" \
              "9::ind" "10:INDETERMINATE:ind" "11:2:ind" "12::ind" "13:INDETERMINATE:ind" "14:INDETERMINATE:ind"; do
    local i="${spec%%:*}" rest="${spec#*:}"; local v="${rest%%:*}" kind="${rest##*:}"
    args=("${G[@]}"); args[$i]="$v"
    case "$kind" in
      green) check "leg$i=$v-green" CH1_GREEN 0 "${args[@]}" ;;
      red) check "leg$i=$v-red" CH1_RED 1 "${args[@]}" ;;
      ind) check "leg$i=${v:-empty}-indeterminate" CH1_INDETERMINATE 3 "${args[@]}" ;;
    esac
  done
  args=("${G[@]}"); args[1]=FAIL; args[4]=""
  check red-outranks-indeterminate CH1_RED 1 "${args[@]}"
  # the missing-tool precondition, through the real entry point with a PATH that holds only bash
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cmc-ch1-selftest.XXXXXX")" || { echo "CMC_CH1_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  rm -rf "$tmp"
  cases=$((cases + 1))
  if [ "$out" = "CH1_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  if [ "$cases" -lt 30 ]; then echo "CMC_CH1_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "CMC_CH1_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "CMC_CH1_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define decide() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate
