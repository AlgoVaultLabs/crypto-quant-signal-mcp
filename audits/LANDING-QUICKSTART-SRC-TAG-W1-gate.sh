#!/usr/bin/env bash
# LANDING-QUICKSTART-SRC-TAG-W1 — the wave gate, run against LIVE after deploy.
#
# TWO DEVIATIONS FROM THE SPEC'S AC6 TEXT, both measured at Step 0 and both because the committed
# text could not express the assertion it names:
#
#   EXPECT_TAG  The spec's template carries `EXPECT_TAG=6   # Code replaces with the Step-0 count`.
#               Measured: `/` renders 6 connect URLs, but only FOUR sit inside #quickstart — 2 per
#               artboard (the copyable "paste the URL" node and the Plain HTTP / curl card). The
#               other two are the #developers config sample (`// Remote — Streamable HTTP`), one
#               per artboard, and stay bare on purpose. EXPECT_TAG=4.
#
#   copy        The spec's leg is `grep -o 'data-av-copy-src="[^"]*"' | grep -c 'src=landing'`,
#               which greps the ATTRIBUTE VALUE. That value is EMPTY by construction and must stay
#               empty: the JSX emits `data-av-copy-src={s.copyable ? '' : undefined}`, the served
#               handler's `displayedUrl()` reads `src.textContent` (never the attribute), and
#               tests/unit/landing-cta-events.test.ts:78 pins `data-av-copy-src=""` at exactly 2.
#               So the leg as written can NEVER be satisfied — it is unsatisfiable, not merely
#               strict, and a gate that cannot go green is worse than no gate. Repaired to assert
#               the property the leg NAMES: the element the handler actually copies has the tagged
#               URL as its text. Expect 2 (desktop + mobile twin).
#
# Verdict token: W1_GREEN | W1_RED <detail> | W1_INDETERMINATE. Callers gate on the TOKEN.
# exit 0 GREEN · 1 RED · 3 INDETERMINATE (the token-law default for a new gate — nothing here
# already deploys another code for "could not verify").
set -u
EXPECT_TAG=4   # Step-0 measured: 2 in-#quickstart occurrences × 2 artboards

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/src/lib/attribution-sources.ts" ]; then
  echo "W1_INDETERMINATE not_in_the_repo — run this from a crypto-quant-signal-mcp checkout"; exit 3
fi

h=$(curl -s --max-time 15 https://algovault.com/) || { echo "W1_INDETERMINATE live_fetch_failed"; exit 3; }
[ -z "$h" ] && { echo "W1_INDETERMINATE empty_body"; exit 3; }

tag=$(printf '%s' "$h" | grep -o 'api\.algovault\.com/mcp?src=landing' | wc -l | tr -d ' ')
# The DISPLAYED node the copy handler reads: the attribute is a bare marker, the text is the URL.
copy=$(printf '%s' "$h" | grep -o 'data-av-copy-src="[^"]*"[^>]*>[^<]*' | grep -c 'mcp?src=landing' | tr -d ' ')
# Repo-side must stay bare — read origin/main, never the working tree (a local edit is not shipped).
readme=$(git -C "$ROOT" show origin/main:README.md 2>/dev/null | grep -c 'mcp?src=' | tr -d ' ') || readme=-1
[ "$readme" = "-1" ] && { echo "W1_INDETERMINATE cannot_read_origin_main_readme"; exit 3; }
# `landing` must be a declared slug, or every tagged arrival silently resolves `unknown`.
slug=$(grep -c "^  'landing'," "$ROOT/src/lib/attribution-sources.ts" | tr -d ' ')

if [ "$tag" = "$EXPECT_TAG" ] && [ "$copy" = "2" ] && [ "$readme" = "0" ] && [ "$slug" = "1" ]; then
  echo W1_GREEN; exit 0
fi
echo "W1_RED tagged=$tag expected=$EXPECT_TAG copy_src_text=$copy readme_tagged=$readme slug_declared=$slug"
exit 1
