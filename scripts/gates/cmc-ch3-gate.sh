#!/usr/bin/env bash
# cmc-ch3-gate.sh — LANDING-MCP-CLIENTS-CLAIMS-W1 CH3 (land, and prove the page clears).
#
# A copy fix is done when the live pages say it and the canary confirms it. Every leg is READ-ONLY
# with respect to production state:
#   AC1  LANDED   the wave's head commit is an ancestor of origin/main (it went through land.sh);
#        DEPLOY   the newest completed deploy.yml run on main that CONTAINS that commit succeeded;
#   AC2  LIVE     every page this wave changed, fetched with a cache-buster, carries the AFTER strings
#                 it owns and none of the BEFORE strings — /docs, /mcp, /integrations, five per-slug
#                 tutorials, /faq and / — and README.md at the landed SHA carries R14 + R17; R19 (CH3b,
#                 rev 4) on /docs, /mcp and /integrations/claude-desktop;
#   AC3  CANARY   on signal-1, the INSTALLED, UNCHANGED canary run as cron runs it (root, `env -i`, cron's
#                 PATH, ALGOVAULT_TG_TEST_INERT=1, state + log in mktemp paths removed after) prints
#                 CLIENT_CLAIM_FRESHNESS_VERDICT=PASS with every row confirmed, 0 contradicted,
#                 0 unreachable, 0 indeterminate — and every ANCHOR confirmed (rows AND anchors are
#                 counted from claim-evidence.json: 12 / 27 after CH3b).
#
# Verdict — exactly one terminal line: CH3_GREEN 0 · CH3_RED 1 · CH3_INDETERMINATE 3 (a host or page
# unreachable, a deploy still running, a leg with no verdict). --self-test drives the REAL decide() and
# the REAL judge_pass() over fixtures, plus a PATH-stripped run.
#
# Usage:  bash scripts/gates/cmc-ch3-gate.sh [--sha <landed-sha>]     bash scripts/gates/cmc-ch3-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(git curl node python3 ssh gh grep)
HOST='root@204.168.185.24'
SSH_KEY="${HOME}/.ssh/algovault_deploy"
HOST_CANARY='/opt/algovault-monitoring/client-claim-freshness.py'
REPO_SLUG='AlgoVaultLabs/crypto-quant-signal-mcp'

# decide <landed> <deploy> <live> <canary>   each: ok | bad:<why> | "" (could not verify)
decide() {
  local red="" ind="" name v i=0
  for v in "$@"; do
    i=$((i + 1)); case $i in 1) name=landed ;; 2) name=deploy ;; 3) name=live ;; 4) name=canary ;; esac
    case "$v" in ok) ;; bad:*) red="$red $name(${v#bad:})" ;; *) ind="$ind $name:${v:-none}" ;; esac
  done
  if [ -n "$red" ]; then printf '[cmc-ch3-gate] RED:%s%s\n' "$red" "${ind:+ (also unverified:$ind)}" >&2; echo CH3_RED; return 1; fi
  if [ -n "$ind" ]; then printf '[cmc-ch3-gate] cannot verify:%s\n' "$ind" >&2; echo CH3_INDETERMINATE; return 3; fi
  printf '[cmc-ch3-gate] landed + deploy green + live pages clean + canary PASS on every row\n' >&2
  echo CH3_GREEN; return 0
}

# judge_pass <canary-stdout-file> <expected-rows> [<expected-anchors>]  -> ok | bad:<why> | "" (no verdict: INDETERMINATE)
judge_pass() {
  local f="$1" rows="$2" anchors="${3:-}" toks evals summary
  toks="$(grep -cE '^CLIENT_CLAIM_FRESHNESS_VERDICT=(PASS|FAIL|INDETERMINATE)$' "$f" || true)"
  [ "$toks" = "1" ] || { [ "$toks" = "0" ] && echo "" || echo "bad:token-lines=$toks"; return; }
  if grep -qE '^CLIENT_CLAIM_FRESHNESS_VERDICT=INDETERMINATE$' "$f"; then echo ""; return; fi
  grep -qE '^CLIENT_CLAIM_FRESHNESS_VERDICT=PASS$' "$f" || { echo "bad:verdict=FAIL"; return; }
  evals="$(grep -cE '\] EVAL module=' "$f" || true)"
  [ "$evals" = "$rows" ] || { echo "bad:eval-lines=$evals-of-$rows"; return; }
  if grep -E '\] EVAL module=' "$f" | grep -vqE ' state=confirmed '; then echo "bad:a-row-is-not-confirmed"; return; fi
  summary="$(grep -E '\] SUMMARY: ' "$f" | tail -n 1)"
  printf '%s' "$summary" | grep -qE "rows: contradicted=0, stale=0, predicate indeterminate=0, source unreachable=0, confirmed=$rows " \
    || { echo "bad:summary-not-clean"; return; }
  if [ -n "$anchors" ]; then
    printf '%s' "$summary" | grep -qE "anchors: contradicted=0, indeterminate=0, unreachable=0, confirmed=$anchors " \
      || { echo "bad:anchors-not-$anchors-confirmed"; return; }
  fi
  echo ok
}

live_leg() { # <sha>
  python3 - "$1" <<'PY'
import sys, time, urllib.request
sha = sys.argv[1]
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 cmc-ch3-gate"}
cb = str(int(time.time()))
PAGES = {
 "https://algovault.com/docs": (
   ["Customize &rarr; Connectors &rarr; + &rarr; <em>Add custom connector</em>", "Easiest path (UI, free tier):",
    'codex mcp add algovault --url "https://api.algovault.com/mcp?src=docs"</code>',
    "npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client &lt;client&gt;",
    '"server":"crypto-quant-signal-mcp","version":"&lt;current release&gt;"', 'algovault "https://api.algovault.com/mcp?src=docs" \\',
    '"https://api.algovault.com/mcp?src=binance_agent_os"</code>', ">Claude custom connectors</a>", 'href="https://cursor.com/docs/mcp">Cursor MCP docs</a>',
    "Enable it per chat from <em>+</em> &rarr; <em>Connectors</em>. For a paid-tier key, use the JSON path below.</p>"],
   ["Settings &rarr; Connectors &rarr; <em>", "covers local stdio servers only", "@smithery/cli install", '"version":"1.10.3"', ">MCP quickstart</a>",
    "The connector form takes OAuth credentials, not custom headers"]),
 "https://algovault.com/mcp": (
   ["Customize &rarr; Connectors &rarr; + &rarr; <em>Add custom connector</em>", 'codex mcp add algovault --url "https://api.algovault.com/mcp?src=docs"</code>',
    "Smithery-gateway entry", 'algovault "https://api.algovault.com/mcp?src=docs" \\', ">Claude custom connectors</a>",
    "Enable it per chat from <em>+</em> &rarr; <em>Connectors</em>. For a paid-tier key, use the JSON path below.</p>"],
   ["Settings &rarr; Connectors &rarr; <em>", "covers local stdio servers only", "@smithery/cli install", '"version":"1.10.3"', ">MCP quickstart</a>",
    "The connector form takes OAuth credentials, not custom headers"]),
 "https://algovault.com/integrations": (
   ["Customize &rarr; Connectors &rarr; + &rarr; <em>Add custom connector</em>", "npx -y @smithery/cli mcp add algovault/crypto-quant-signal-mcp --client &lt;name&gt;"],
   ["Settings &rarr; Connectors &rarr; <em>", "@smithery/cli install"]),
 "https://algovault.com/integrations/claude-desktop": (
   ["Open Claude Desktop → Customize → Connectors → + → <em>Add custom connector</em>", "Enable it per chat from + → Connectors. For a paid-tier key, use the JSON path below.</p>",
    "&quot;Authorization:${AUTH_HEADER}&quot;"],
   ["Settings → Connectors", "as a custom header", "after saving the connector", "The connector form takes OAuth credentials, not custom headers"]),
 "https://algovault.com/integrations/codex": (
   ["codex mcp add algovault --url &quot;https://api.algovault.com/mcp?src=docs&quot;</code>"],
   ["local stdio servers only", "rejected the URL"]),
 "https://algovault.com/integrations/smithery": (
   ["@smithery/cli mcp add algovault/crypto-quant-signal-mcp --client &lt;name&gt;", "Smithery-gateway entry",
    "Claude Code and Codex, among others.", "asks you to authorize it in your browser", "successfully installed for claude"],
   ["@smithery/cli install", "config-path", "Continue.dev support is in beta", "Hit Enter at the API-key prompt", "smithery.ai/server/@AlgoVaultLabs"]),
 "https://algovault.com/integrations/claude-code": (
   ["&quot;https://api.algovault.com/mcp?src=docs&quot; \\"], ["\n  https://api.algovault.com/mcp?src=docs \\"]),
 "https://algovault.com/integrations/binance-agent-os": (
   ["&quot;https://api.algovault.com/mcp?src=binance_agent_os&quot; \\"], ["\n  https://api.algovault.com/mcp?src=binance_agent_os \\"]),
 "https://algovault.com/faq": (
   ["Claude Desktop: Customize → Connectors → + → Add custom connector → paste the URL.",
    "Claude Desktop: Customize &rarr; Connectors &rarr; + &rarr; Add custom connector &rarr; paste the URL."],
   ["Settings → Connectors", "Settings &rarr; Connectors"]),
 "https://algovault.com/": (
   [], ["Open Claude → Settings → Connectors", ">Add custom connector → paste the URL<"]),
 f"https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/{sha}/README.md": (
   ["**1. Add the connector.** In Claude → Customize → Connectors → + → Add custom connector:",
    "| **Claude Desktop** | Customize → Connectors → + → Add custom connector → `https://api.algovault.com/mcp` |",
    "| **Claude Code** (CLI) | `claude mcp add --transport http crypto-quant-signal https://api.algovault.com/mcp` |",
    "| **Cursor** | `~/.cursor/mcp.json` → `mcpServers` block → `url: \"https://api.algovault.com/mcp\"` |",
    "<!-- MCP_CLIENTS_README_TABLE:start -->"],
   ["Settings → Connectors", "~/.cursor/config.json"]),
}
COUNTS = {"https://algovault.com/": [("Open Claude → Customize → Connectors", 2), ("+ → Add custom connector → paste the URL", 2),
                                     ('href="/integrations/deepseek-harness"', 2)]}
bad, unreachable = [], []
for url, (present, absent) in PAGES.items():
    sep = "&" if "?" in url else "?"
    try:
        body = urllib.request.urlopen(urllib.request.Request(f"{url}{sep}cb={cb}", headers=UA), timeout=30).read().decode("utf-8", "replace")
    except Exception as e:
        unreachable.append(f"{url}: {e}"); continue
    for p in present:
        if p not in body: bad.append(f"{url}: AFTER missing {p[:70]!r}")
    for a in absent:
        if a in body: bad.append(f"{url}: BEFORE still served {a[:70]!r}")
    for p, k in COUNTS.get(url, []):
        if body.count(p) != k: bad.append(f"{url}: {p!r} served {body.count(p)}x, want {k}")
for u in unreachable: print("  ? " + u, file=sys.stderr)
for b in bad: print("  ✗ " + b, file=sys.stderr)
print(f"[live] {len(PAGES)} pages, {len(bad)} failure(s), {len(unreachable)} unreachable", file=sys.stderr)
print("LIVE=" + ("FAIL" if bad else ("INDETERMINATE" if unreachable else "PASS")))
PY
}

val() { grep -E "^$1=" | tail -n 1 | sed "s/^$1=//"; }

run_gate() {
  local t sha=""
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[cmc-ch3-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH3_INDETERMINATE; exit 3; }
  done
  [ "${1:-}" = "--sha" ] && sha="${2:-}"
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "[cmc-ch3-gate] not inside a git checkout" >&2; echo CH3_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH3_INDETERMINATE; exit 3; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cmc-ch3-gate.XXXXXX")" || { echo CH3_INDETERMINATE; exit 3; }
  [ -n "$sha" ] || sha="$(git rev-parse HEAD)"
  local landed="" deploy="" live="" canary=""

  # AC1 — landed: the wave head is on origin/main
  if git fetch origin --quiet >/dev/null 2>&1; then
    if git merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then landed=ok; else landed="bad:not-an-ancestor-of-origin/main"; fi
  fi
  # AC1 — deploy: the newest COMPLETED run on main that contains the wave head
  if [ "$landed" = "ok" ]; then
    gh run list -R "$REPO_SLUG" --workflow deploy.yml --branch main --limit 30 --json headSha,status,conclusion,databaseId >"$tmp/runs.json" 2>/dev/null || true
    deploy="$(node -e '
      const { execFileSync } = require("child_process");
      const runs = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "[]");
      const contains = (h) => { try { execFileSync("git", ["merge-base", "--is-ancestor", process.argv[2], h]); return true; } catch { return false; } };
      const mine = runs.filter((r) => contains(r.headSha));
      const done = mine.find((r) => r.status === "completed");
      if (!done) { console.log(mine.length ? "" : ""); process.exit(0); }
      console.log(done.conclusion === "success" ? "ok" : `bad:run-${done.databaseId}-${done.conclusion}`);
    ' "$tmp/runs.json" "$sha" 2>/dev/null)"
  fi
  # AC2 — live read
  live="$(live_leg "$sha" 2>"$tmp/live.err" | val LIVE)"
  case "$live" in PASS) live=ok ;; FAIL) live="bad:see-$tmp/live.err" ;; *) live="" ;; esac
  # AC3 — the installed canary, cron-shaped, production state untouched
  local rows anchors
  rows="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("src/lib/integrations-data/claim-evidence.json","utf8")).rows.length)' 2>/dev/null)"
  anchors="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("src/lib/integrations-data/claim-evidence.json","utf8")).rows.reduce((n, r) => n + r.evidence.length, 0))' 2>/dev/null)"
  ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=12 -o ServerAliveInterval=10 "$HOST" \
    "S=\$(mktemp -d); env -i HOME=/root LOGNAME=root SHELL=/bin/sh PATH=/usr/bin:/bin ALGOVAULT_TG_TEST_INERT=1 CLIENT_CLAIM_STATE=\$S/state.json CLIENT_CLAIM_LOG=\$S/run.log $HOST_CANARY; rc=\$?; rm -rf \$S; echo \"__RC__=\$rc\"" \
    >"$tmp/canary.txt" 2>&1 || true
  if [ -s "$tmp/canary.txt" ] && [ -n "$rows" ] && [ -n "$anchors" ]; then canary="$(judge_pass "$tmp/canary.txt" "$rows" "$anchors")"; fi
  grep -E '\] (SUMMARY|AGGREGATE): ' "$tmp/canary.txt" | sed 's/^/[cmc-ch3-gate] canary /' >&2 || true

  printf '[cmc-ch3-gate] sha=%s landed=%s deploy=%s live=%s canary=%s\n' "${sha:0:12}" "${landed:-none}" "${deploy:-none}" "${live:-none}" "${canary:-none}" >&2
  local rc
  decide "$landed" "$deploy" "$live" "$canary"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"; else printf '[cmc-ch3-gate] evidence kept: %s\n' "$tmp" >&2; fi
  exit "$rc"
}

self_test() {
  local pass=0 fail=0 cases=0
  check() { # <name> <want token> <want rc> <4 decide args>
    local name="$1" want="$2" want_rc="$3"; shift 3
    local out rc
    out="$(decide "$@" 2>/dev/null)"; rc=$?
    cases=$((cases + 1))
    if [ "$out" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$out' rc=$rc, want '$want' rc=$want_rc)"; fi
  }
  check all-ok CH3_GREEN 0 ok ok ok ok
  check not-landed-red CH3_RED 1 bad:not-an-ancestor ok ok ok
  check deploy-failed-red CH3_RED 1 ok bad:run-1-failure ok ok
  check live-red CH3_RED 1 ok ok bad:page ok
  check canary-red CH3_RED 1 ok ok ok bad:verdict=FAIL
  check landed-unverified CH3_INDETERMINATE 3 "" ok ok ok
  check deploy-running CH3_INDETERMINATE 3 ok "" ok ok
  check live-unreachable CH3_INDETERMINATE 3 ok ok "" ok
  check canary-host-down CH3_INDETERMINATE 3 ok ok ok ""
  check red-outranks-indeterminate CH3_RED 1 "" ok ok bad:verdict=FAIL
  # judge_pass over fixtures — the parser the canary leg depends on
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cmc-ch3-selftest.XXXXXX")" || { echo "CMC_CH3_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  local E1='[t] EVAL module=mcp-clients slug=a kind=native verifiedAt=2026-10-01 confirmed=2026-10-02 age=0d state=confirmed evidence=confirmed anchors=2/2 a1=confirmed a2=confirmed'
  local E2='[t] EVAL module=mcp-clients slug=b kind=native verifiedAt=2026-10-01 confirmed=2026-10-02 age=0d state=confirmed evidence=confirmed anchors=1/1 a1=confirmed'
  local SM='[t] SUMMARY: 2 row(s), 3 anchor(s) evaluated — rows: contradicted=0, stale=0, predicate indeterminate=0, source unreachable=0, confirmed=2 — anchors: contradicted=0, indeterminate=0, unreachable=0, confirmed=3 — moved=1'
  printf '%s\n%s\n%s\n[t] AGGREGATE: PASS\nCLIENT_CLAIM_FRESHNESS_VERDICT=PASS\n__RC__=0\n' "$E1" "$E2" "$SM" >"$tmp/good.txt"
  sed 's/^CLIENT_CLAIM_FRESHNESS_VERDICT=PASS$/CLIENT_CLAIM_FRESHNESS_VERDICT=FAIL/' "$tmp/good.txt" >"$tmp/fail.txt"
  sed 's/^CLIENT_CLAIM_FRESHNESS_VERDICT=PASS$/CLIENT_CLAIM_FRESHNESS_VERDICT=INDETERMINATE/' "$tmp/good.txt" >"$tmp/ind.txt"
  sed 's/slug=b kind=native verifiedAt=2026-10-01 confirmed=2026-10-02 age=0d state=confirmed/slug=b kind=native verifiedAt=2026-10-01 confirmed=never age=1d state=source unreachable/' "$tmp/good.txt" >"$tmp/unreach.txt"
  sed 's/source unreachable=0/source unreachable=1/' "$tmp/good.txt" >"$tmp/summary.txt"
  grep -v '^CLIENT_CLAIM' "$tmp/good.txt" >"$tmp/notoken.txt"
  jcheck() { cases=$((cases + 1)); if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $1"; else fail=$((fail + 1)); echo "SELF-TEST: FAIL $1 (got '$3', want '$2')"; fi; }
  jcheck judge-pass-good ok "$(judge_pass "$tmp/good.txt" 2)"
  jcheck judge-row-count bad:eval-lines=2-of-3 "$(judge_pass "$tmp/good.txt" 3)"
  jcheck judge-fail-verdict bad:verdict=FAIL "$(judge_pass "$tmp/fail.txt" 2)"
  jcheck judge-indeterminate-is-not-a-pass "" "$(judge_pass "$tmp/ind.txt" 2)"
  jcheck judge-unconfirmed-row bad:a-row-is-not-confirmed "$(judge_pass "$tmp/unreach.txt" 2)"
  jcheck judge-dirty-summary bad:summary-not-clean "$(judge_pass "$tmp/summary.txt" 2)"
  jcheck judge-no-token "" "$(judge_pass "$tmp/notoken.txt" 2)"
  jcheck judge-anchor-count-good ok "$(judge_pass "$tmp/good.txt" 2 3)"
  jcheck judge-anchor-count-wrong bad:anchors-not-4-confirmed "$(judge_pass "$tmp/good.txt" 2 4)"
  sed 's/anchors: contradicted=0, indeterminate=0, unreachable=0, confirmed=3/anchors: contradicted=1, indeterminate=0, unreachable=0, confirmed=2/' "$tmp/good.txt" >"$tmp/anchor.txt"
  jcheck judge-contradicted-anchor bad:anchors-not-3-confirmed "$(judge_pass "$tmp/anchor.txt" 2 3)"
  rm -rf "$tmp"
  # the missing-tool precondition, through the real entry point with a PATH that holds only bash
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/cmc-ch3-selftest.XXXXXX")" || { echo "CMC_CH3_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  rm -rf "$tmp"
  cases=$((cases + 1))
  if [ "$out" = "CH3_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'git'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  if [ "$cases" -lt 21 ]; then echo "CMC_CH3_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "CMC_CH3_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "CMC_CH3_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define decide() + judge_pass() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate "$@"
