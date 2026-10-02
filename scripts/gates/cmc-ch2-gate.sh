#!/usr/bin/env bash
# cmc-ch2-gate.sh — LANDING-MCP-CLIENTS-CLAIMS-W1 CH2 (no hand-typed twin left).
#
# Legs, from the repo root, mapped to the chapter's acceptance criteria:
#   AC1  FOOTER     the surface footer is DERIVED: MCP_CLIENTS.meta.footerLinks equals the ratified R13
#                   list (labels + hrefs, in order) AND the rendered footer in docs.html / mcp.html shows
#                   it; R8 holds (every footer link is one of its row's evidence sources, or a reasoned
#                   SOURCE_EVIDENCE_EXEMPT entry).
#   AC2  README     build_readme_mcp_clients.mjs --check → README_MCP_CLIENTS_VERDICT=IN_SYNC; R9 holds; the
#                   three R14 cells are present; the README-only rows (Windsurf, Continue.dev, the catch-all)
#                   are byte-identical to what the README already said.
#   AC3  ANCHORS    claim-evidence.json carries the three README-binding anchors (R9) and is IN_SYNC
#                   (`emit-claim-evidence.mjs --check`); R1–R7 are tests/unit/claim-evidence.test.ts
#                   (named, read from the suite report).
#   AC4  RENDERED   cmc-rendered-diff.mjs --check over EVERY row R1–R18 + R10b → MATCH (after the CH1 + CH2
#                   landing: CH3b's own diff, R19 only — rev 4).
#   AC5  suite      the full vitest suite → classify-suite-verdict.mjs, as deploy.yml runs it;
#        NODETEST   every node:test canary (tests/**/*.test.mjs that is not a vitest file), run exactly as
#                   the pre-push test gate runs them — vitest green is not push green (measured: an
#                   attribution canary blocked this wave's first landing that vitest never ran);
#        landing    build_landing --check rc 0;
#        PARTNER    check-partner-install-coords.mjs → PARTNER_INSTALL_VERDICT=CLEAN (the derived footer
#                   leaves its `href: '…'` corpus; its vacuity guard must still find coordinates).
#   AC6  COPY       check-mcp-client-copy.mjs → MCP_CLIENT_COPY_VERDICT=PASS (CHECK 10 included, and its
#                   self-test is RED on the pre-wave page + three mutations, GREEN on the re-baked one);
#        GRID       CHECK 10 red-proved on the REAL page here too (a dropped card must fire);
#        HOMEPAGE   a fresh render-jsx-static.mjs render is still byte-equal after landingClientRows moved
#                   (the CH1 gate's homepage leg, sourced).
#
# Verdict — exactly one terminal line: CH2_GREEN 0 · CH2_RED 1 · CH2_INDETERMINATE 3.
# Bash on purpose (zsh's ${PIPESTATUS[0]} is empty, and [ "" -eq 0 ] reads TRUE). --self-test drives the
# REAL decide() over synthetic legs plus a PATH-stripped run. No env seam can fake a leg.
#
# Usage:  bash scripts/gates/cmc-ch2-gate.sh            bash scripts/gates/cmc-ch2-gate.sh --self-test
set -uo pipefail

# builtins only: this must resolve before the missing-tool precondition can be reported
case "${BASH_SOURCE[0]}" in */*) CH2_DIR="${BASH_SOURCE[0]%/*}" ;; *) CH2_DIR=. ;; esac
# shellcheck source=cmc-ch1-gate.sh
source "$CH2_DIR/cmc-ch1-gate.sh"   # sourceable: brings homepage_leg + leg + val; its decide() is redefined below

REQUIRED_TOOLS=(node npm npx python3 git grep)
NAMED_TESTS='tests/unit/claim-evidence.test.ts tests/unit/readme-mcp-clients.test.ts tests/unit/mcp-usage-docs.test.ts tests/unit/mcp-usage-docs-byte-equivalence.test.ts tests/unit/integrations-data.test.ts'
ALL_ROWS='R1,R2,R3,R4,R5,R6,R7,R8,R9,R10,R10b,R11,R12,R13,R14,R15,R16,R17,R18'

# decide <build_rc> <suite> <named> <footer> <readme> <anchors> <evidence> <rendered> <landing_rc>
#        <partner> <copy> <grid> <homepage> <nodetest>
decide() {
  local build_rc="$1" suite="$2" named="$3" footer="$4" readme="$5" anchors="$6" ev="$7" rendered="$8"
  local landing="$9" partner="${10}" copy="${11}" grid="${12}" homepage="${13}" nodetest="${14}"
  red="" ind=""
  [ "$build_rc" = "0" ] || red="$red build"
  case "$suite" in PASS|PASS_AFTER_ISOLATION) ;; FAIL) red="$red suite" ;; *) ind="$ind suite:${suite:-none}" ;; esac
  case "$named" in passed) ;; failed) red="$red named-tests" ;; *) ind="$ind named-tests:${named:-none}" ;; esac
  leg footer "$footer" PASS FAIL
  leg readme "$readme" PASS FAIL
  leg anchors "$anchors" PASS FAIL
  leg claim-evidence "$ev" IN_SYNC DRIFT
  leg rendered-diff "$rendered" MATCH MISMATCH
  case "$landing" in 0) ;; 1) red="$red build_landing" ;; *) ind="$ind build_landing:rc=${landing:-none}" ;; esac
  case "$partner" in CLEAN) ;; DRIFT) red="$red partner-install" ;; *) ind="$ind partner-install:${partner:-none}" ;; esac
  leg mcp-client-copy "$copy" PASS FAIL
  leg grid "$grid" PASS FAIL
  leg homepage "$homepage" PASS FAIL
  leg node-test "$nodetest" PASS FAIL
  if [ -n "$red" ]; then printf '[cmc-ch2-gate] RED:%s%s\n' "$red" "${ind:+ (also unverified:$ind)}" >&2; echo CH2_RED; return 1; fi
  if [ -n "$ind" ]; then printf '[cmc-ch2-gate] cannot verify:%s\n' "$ind" >&2; echo CH2_INDETERMINATE; return 3; fi
  printf '[cmc-ch2-gate] AC1-AC6: derived footer + R8, generated README + R9, anchors, rendered diff, suite, node:test canaries, landing, partner coords, CHECK 10 + red-proof, byte-equal render — all passed\n' >&2
  echo CH2_GREEN; return 0
}

# ── AC1 + AC2 + AC3 + AC6 (grid): one node pass over the compiled SoT and the pages ───────────────
sot_legs() {
  node --input-type=module - <<'JS' 2>&1
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const mod = require(process.cwd() + '/dist/lib/integrations-data/mcp-clients.js');
const ce = require(process.cwd() + '/dist/lib/integrations-data/claim-evidence.js');
const MC = mod.default;
const out = (k, bad) => { for (const b of bad) console.error('  ✗ ' + b); console.log(`${k}=${bad.length ? 'FAIL' : 'PASS'}`); };
/* AC1 — the derived footer equals R13, and the pages render it */
const R13 = [
  ['Claude custom connectors', 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp'],
  ['Cursor MCP docs', 'https://cursor.com/docs/mcp'],
  ['Cline MCP docs', 'https://docs.cline.bot/mcp/mcp-overview'],
  ['Claude Code MCP docs', 'https://code.claude.com/docs/en/mcp'],
  ['@smithery/cli on npm', 'https://www.npmjs.com/package/@smithery/cli'],
  ['Codex MCP docs', 'https://learn.chatgpt.com/docs/extend/mcp'],
  ['Kimi Code MCP docs', 'https://moonshotai.github.io/kimi-code/en/customization/mcp.html'],
  ['ZCode MCP docs', 'https://zcode.z.ai/en/docs/mcp-services'],
  ['DeepSeek Harness', 'https://github.com/deepseek-ai/deepseek-harness'],
  ['Z.ai MCP-call docs', 'https://docs.z.ai/guides/capabilities/mcp-call'],
  ['DeepSeek Anthropic API', 'https://api-docs.deepseek.com/guides/anthropic_api'],
];
const fb = [];
const got = MC.meta.footerLinks.map((l) => [l.label, l.href]);
if (JSON.stringify(got) !== JSON.stringify(R13)) fb.push(`meta.footerLinks ≠ R13: ${JSON.stringify(got)}`);
const rendered = R13.map(([l, h]) => `    <a class="text-mint-400 hover:underline" href="${h}">${l}</a>`).join(' &middot;\n');
for (const page of ['landing/docs.html', 'landing/mcp.html']) {
  if (!readFileSync(page, 'utf8').includes(rendered)) fb.push(`${page} does not render the derived footer`);
}
const r8 = ce.sourceEvidenceProblems(MC.entries);
for (const p of r8) fb.push(`R8 ${p.slug}: ${p.detail}`);
for (const [slug, why] of Object.entries(ce.SOURCE_EVIDENCE_EXEMPT)) if (!String(why).trim()) fb.push(`R8 exemption ${slug} carries no reason`);
out('FOOTER', fb);
/* AC2 — README cells: R9, R14 present, README-only rows untouched */
const rb = [];
for (const p of ce.readmeEvidenceProblems(MC.entries)) rb.push(`R9 ${p.slug}: ${p.detail}`);
const readme = readFileSync('README.md', 'utf8');
for (const want of [
  '| **Claude Desktop** | Customize → Connectors → + → Add custom connector → `https://api.algovault.com/mcp` |',
  '| **Claude Code** (CLI) | `claude mcp add --transport http crypto-quant-signal https://api.algovault.com/mcp` |',
  '| **Cursor** | `~/.cursor/mcp.json` → `mcpServers` block → `url: "https://api.algovault.com/mcp"` |',
  '| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` → `mcpServers.algovault.serverUrl = "https://api.algovault.com/mcp"` |',
  '| **Continue.dev** | `config.yaml` → `mcpServers: [{ name: algovault, type: streamable-http, url: "https://api.algovault.com/mcp" }]` |',
  '| Any other MCP-spec-compliant client | Configure the Streamable HTTP transport with URL `https://api.algovault.com/mcp` |',
]) if (!readme.includes(want)) rb.push(`README.md lacks: ${want.slice(0, 80)}`);
const rmod = require(process.cwd() + '/dist/lib/integrations-data/readme-mcp-clients.js');
for (const r of rmod.README_ONLY_MCP_CLIENT_ROWS) if (!r.reason.trim()) rb.push(`README-only row ${r.key} carries no reason`);
out('README_CELLS', rb);
/* AC3 — the three README-binding anchors are in the emitted corpus */
const doc = JSON.parse(readFileSync('src/lib/integrations-data/claim-evidence.json', 'utf8'));
const has = (slug, claim) => doc.rows.find((r) => r.slug === slug)?.evidence.some((a) => a.claim === claim);
const ab = [];
for (const [slug, claim] of [['codex', '[mcp_servers.algovault]'], ['claude-code', 'claude mcp add --transport http'], ['cline', 'Streamable HTTP']]) {
  if (!has(slug, claim)) ab.push(`${slug} lacks the README-binding anchor "${claim}"`);
}
out('ANCHORS2', ab);
/* AC6 — CHECK 10 on the REAL page: GREEN as is, RED with a card dropped */
const cc = await import(process.cwd() + '/scripts/check-mcp-client-copy.mjs');
const lr = await import(process.cwd() + '/scripts/lib/landing-client-rows.mjs');
const proj = lr.landingGridOrder(lr.landingClientRows(MC));
const page = readFileSync('landing/index.html', 'utf8');
const gb = [];
const live = cc.checkLandingGrid(page, proj);
if (live.indeterminate || live.problems.length) gb.push(`CHECK 10 is not GREEN on the real page: ${live.indeterminate || live.problems[0]}`);
const sec = cc.quickstartSections(page).desktop || '';
const cards = cc.gridCards(sec);
if (cards.length < 3) gb.push('fewer than 3 cards on the real page');
else {
  const at = page.indexOf(sec);
  const dropped = page.slice(0, at) + sec.slice(0, cards[1].start) + sec.slice(cards[2].start) + page.slice(at + sec.length);
  const r = cc.checkLandingGrid(dropped, proj);
  if (r.indeterminate || r.problems.length === 0) gb.push('CHECK 10 did not fire on the real page with a card dropped');
}
if (proj.length !== MC.entries.length) gb.push(`the projection has ${proj.length} rows, MCP_CLIENTS ${MC.entries.length}`);
out('GRID', gb);
JS
}

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[cmc-ch2-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH2_INDETERMINATE; exit 3; }
  done
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_QUARANTINE_PATH
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "[cmc-ch2-gate] not inside a git checkout" >&2; echo CH2_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH2_INDETERMINATE; exit 3; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cmc-ch2-gate.XXXXXX")" || { echo CH2_INDETERMINATE; exit 3; }

  rm -rf dist
  { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1
  local build_rc=$?
  local suite="" named="missing" footer="" readme="" anchors="" ev="" rendered="" landing="" partner="" copy="" grid="" homepage="" nodetest=""
  if [ "$build_rc" -eq 0 ]; then
    local sl; sl="$(sot_legs 2>"$tmp/sot.err")"
    footer="$(printf '%s\n' "$sl" | val FOOTER)"; grid="$(printf '%s\n' "$sl" | val GRID)"
    local cells a2 rv
    cells="$(printf '%s\n' "$sl" | val README_CELLS)"; a2="$(printf '%s\n' "$sl" | val ANCHORS2)"
    rv="$(node scripts/build_readme_mcp_clients.mjs --check 2>/dev/null | val README_MCP_CLIENTS_VERDICT)"
    # README leg = the writer's verdict AND the cell checks
    if [ "$rv" = "IN_SYNC" ] && [ "$cells" = "PASS" ]; then readme=PASS
    elif [ "$rv" = "DRIFT" ] || [ "$cells" = "FAIL" ]; then readme=FAIL
    else readme="${rv:-none}/${cells:-none}"; fi
    ev="$(node scripts/emit-claim-evidence.mjs --check 2>/dev/null | val CLAIM_EVIDENCE_VERDICT)"
    anchors="$a2"
    copy="$(node scripts/check-mcp-client-copy.mjs 2>"$tmp/copy.err" | val MCP_CLIENT_COPY_VERDICT)"
    git fetch origin --quiet >/dev/null 2>&1 || true
    local base; base="$(git merge-base HEAD origin/main 2>/dev/null)"
    if [ -n "$base" ]; then
      # CH3b (rev 4): once CH1 + CH2 are on origin/main, the diff is CH3b's own (R19 only, its own map);
      # CH12_LANDED / CH3B_MAP / CH3B_ROWS come from the sourced CH1 gate — one definition.
      if git merge-base --is-ancestor "$CH12_LANDED" "$base" 2>/dev/null; then
        rendered="$(node scripts/gates/cmc-rendered-diff.mjs --check --base "$base" --map "$CH3B_MAP" --rows "$CH3B_ROWS" --no-vault 2>"$tmp/rendered.err" | val RENDERED_DIFF_VERDICT)"
      else
        rendered="$(node scripts/gates/cmc-rendered-diff.mjs --check --base "$base" --rows "$ALL_ROWS" 2>"$tmp/rendered.err" | val RENDERED_DIFF_VERDICT)"
      fi
    fi
    node scripts/build_landing.mjs --check >"$tmp/build_landing.log" 2>&1; landing=$?
    partner="$(node scripts/check-partner-install-coords.mjs --check 2>"$tmp/partner.err" | tee "$tmp/partner.log" | val PARTNER_INSTALL_VERDICT)"
    homepage="$(homepage_leg "$tmp" 2>"$tmp/homepage.err" | val HOMEPAGE)"
    npx vitest run tests/agent-session-source-stamp.test.ts </dev/null >/dev/null 2>&1 || true
    npx vitest run --reporter=default --reporter=json --outputFile="$tmp/report.json" \
      --reporter=./scripts/vitest-error-shape-reporter.mjs </dev/null >"$tmp/vitest.log" 2>&1 || true
    mv -f .vitest-error-shapes.json "$tmp/shapes.json" 2>/dev/null || true
    suite="$(node scripts/classify-suite-verdict.mjs "$tmp/report.json" --sidecar="$tmp/shapes.json" 2>/dev/null | val SUITE_VERDICT)"
    # node:test canaries — the file set and the worker cap scripts/check_test_baseline.sh uses (content-detected)
    local -a nt=()
    while IFS= read -r f; do grep -q "from 'vitest'" "$f" 2>/dev/null && continue; nt+=("$f"); done < <(find tests -name '*.test.mjs' 2>/dev/null | sort)
    if [ "${#nt[@]}" -gt 0 ]; then
      if node --test --test-concurrency="${ALGOVAULT_GATE_MAX_WORKERS:-6}" "${nt[@]}" </dev/null >"$tmp/nodetest.log" 2>&1; then nodetest=PASS; else nodetest=FAIL; fi
    fi
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
  printf '[cmc-ch2-gate] build_rc=%s suite=%s named=%s footer=%s readme=%s anchors=%s evidence=%s rendered=%s landing_rc=%s partner=%s copy=%s grid=%s homepage=%s nodetest=%s\n' \
    "$build_rc" "${suite:-none}" "$named" "${footer:-none}" "${readme:-none}" "${anchors:-none}" "${ev:-none}" "${rendered:-none}" \
    "${landing:-none}" "${partner:-none}" "${copy:-none}" "${grid:-none}" "${homepage:-none}" "${nodetest:-none}" >&2
  local rc
  decide "$build_rc" "$suite" "$named" "$footer" "$readme" "$anchors" "$ev" "$rendered" "$landing" "$partner" "$copy" "$grid" "$homepage" "$nodetest"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"; else printf '[cmc-ch2-gate] evidence kept: %s\n' "$tmp" >&2; fi
  exit "$rc"
}

self_test() {
  local pass=0 fail=0 cases=0
  check() { # <name> <want token> <want rc> <14 decide args>
    local name="$1" want="$2" want_rc="$3"; shift 3
    local out rc
    out="$(decide "$@" 2>/dev/null)"; rc=$?
    cases=$((cases + 1))
    if [ "$out" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$out' rc=$rc, want '$want' rc=$want_rc)"; fi
  }
  local G=(0 PASS passed PASS PASS PASS IN_SYNC MATCH 0 CLEAN PASS PASS PASS PASS)
  check all-green CH2_GREEN 0 "${G[@]}"
  local -a args
  local spec
  for spec in "1:PASS_AFTER_ISOLATION:green" "0:2:red" "1:FAIL:red" "2:failed:red" "3:FAIL:red" "4:FAIL:red" "5:FAIL:red" \
              "6:DRIFT:red" "7:MISMATCH:red" "8:1:red" "9:DRIFT:red" "10:FAIL:red" "11:FAIL:red" "12:FAIL:red" "13:FAIL:red" \
              "1::ind" "2:missing:ind" "3::ind" "4:none/PASS:ind" "5::ind" "6:INDETERMINATE:ind" "7:INDETERMINATE:ind" \
              "8:2:ind" "9:INDETERMINATE:ind" "10::ind" "11::ind" "12:INDETERMINATE:ind" "13::ind"; do
    local i="${spec%%:*}" rest="${spec#*:}"; local v="${rest%%:*}" kind="${rest##*:}"
    args=("${G[@]}"); args[$i]="$v"
    case "$kind" in
      green) check "leg$i=$v-green" CH2_GREEN 0 "${args[@]}" ;;
      red) check "leg$i=$v-red" CH2_RED 1 "${args[@]}" ;;
      ind) check "leg$i=${v:-empty}-indeterminate" CH2_INDETERMINATE 3 "${args[@]}" ;;
    esac
  done
  args=("${G[@]}"); args[1]=FAIL; args[5]=""
  check red-outranks-indeterminate CH2_RED 1 "${args[@]}"
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cmc-ch2-selftest.XXXXXX")" || { echo "CMC_CH2_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  rm -rf "$tmp"
  cases=$((cases + 1))
  if [ "$out" = "CH2_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  if [ "$cases" -lt 30 ]; then echo "CMC_CH2_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "CMC_CH2_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "CMC_CH2_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define decide() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate
