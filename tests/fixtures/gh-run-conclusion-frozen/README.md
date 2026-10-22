# gh-run-conclusion — frozen reference (OPS-XREPO-CI-CANARY-DARK-W2)

`gh-run-conclusion-963d15ac.mjs` is `git show 963d15ac:ops/monitoring/gh-run-conclusion.mjs`, byte for byte
(sha256 `87cc57480f67790a810d3cf65349d48236f6e81183167029edfeeec81d9a1303` — the module's last pre-React
revision, identical to the inventory row and to the copy installed on signal-1 on 2026-10-22).

`tests/unit/gh-run-conclusion.test.ts` diffs every LEGACY-shape read (`id="check_suite_…"` rows) of the live
module against it — the record, the `GHRC_*` lines, the token, the sleeps and every fetch call — so routing
pages through `PAGE_SHAPES` can never change what a legacy page reads.

Never edit it. It lives OUTSIDE `tests/fixtures/gh-run-conclusion/` on purpose: that directory's
public-repo scrub test reads every file in it, and module source is not a captured page. A deliberate change
to legacy behaviour re-freezes this file from the commit that makes it, and says so in that commit.
