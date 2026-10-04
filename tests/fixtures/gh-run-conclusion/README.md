# gh-run-conclusion fixtures — real GitHub markup, captured 2026-10-03

Consumed by `tests/unit/gh-run-conclusion.test.ts` (OPS-XREPO-CI-RED-W1 CH2). The module's own
`--self-test` does not read these files: it must run on signal-1, where only the module is installed.

| File | What it is | Source |
|---|---|---|
| `page-marketplace-check-main-20261003.html` | FULL live Actions page; newest row #144 `37017230705` success; carries every pre-row chrome icon R0 measured (alert+danger ×4, alert ×1, stop ×4, check-circle-fill ×4, alert-fill ×4, anim-rotate ×10) | `AlgoVaultLabs/algovault-skills` `marketplace-check.yml?query=branch%3Amain`, unauthenticated curl |
| `page-publish-lane-preverify-main-20261003.html` | FULL live Actions page; newest row #71 `37116129802` success | `AlgoVaultLabs/crypto-quant-signal-mcp` `publish-lane-preverify.yml?query=branch%3Amain` |
| `row-success-37017230705.html` · `row-failure-35616111211.html` · `row-cancelled-32396625268.html` · `row-in_progress-37118831402.html` | real estate run rows (the in-progress row carries the `octicon-calendar` decoy) | the pages above / R0.4 |
| `row-{skipped,action_required,queued,waiting,startup_failure}-synth.html` | **SYNTHESIZED**: the estate row shell of #144 with the status `<svg>` start tag copied VERBATIM from a third-party public run (named in each file's header). No third-party user data is carried. | R0.4 |
| `badge-passing-*.svg` · `badge-failing-publish-npm-anyref.svg` · `badge-failing-cancelled-postgres-lane.svg` · `badge-nostatus-marketplace-check.svg` | real badge bodies per measured state | R0.4 |
| `badge-WRONG-failing-publish-lane-preverify-episode{1,2}-*.svg` | the WRONG bodies GitHub served during the measured badge episodes (11:01:29Z and 12:02:15Z), while the run they described had succeeded | R0.2 / R0.7 |
| `row-failure-37011492987.html` | real Deploy to Hetzner run row #1065 `37011492987` **failure** (started 2026-10-02T13:12:46Z), balanced `check_suite_100250388046` region; data-channel HMAC tail scrubbed. Replays prior N1 (the deploy badge read passing while this run had failed): with the passing badge it binds BIND_TABLE row 4. Consumed by `tests/unit/deploy-drift-canary.test.ts` (CH4) | `AlgoVaultLabs/crypto-quant-signal-mcp` `deploy.yml?query=branch%3Amain&page=1`, unauthenticated curl, fetched 2026-10-04T12:54:39Z (provenance in the file header) |
| `badge-passing-deploy-main.svg` | real deploy badge body, `Deploy to Hetzner - passing`, byte-for-byte as served (HTTP 200, response `Date` 12:55:09 GMT) below a two-line provenance comment; the N1 replay's badge half. Consumed by `tests/unit/deploy-drift-canary.test.ts` (CH4) | `AlgoVaultLabs/crypto-quant-signal-mcp` `deploy.yml/badge.svg?branch=main` + per-read `ghrc_cb` buster, unauthenticated curl, fetched 2026-10-04T12:55:08Z |
| `row-success-37201506699-anyref.html` · `row-success-37182060859-anyref.html` | real run rows from the ANY-REF page (`publish-npm.yml`, no query), each carrying its two `branch-name` anchors: #29 `37201506699` (`title="v1.31.1"`, the v1.31.1 tag run, success) and #28 `37182060859` (`title="main"`, verify-only dispatch, success). The ref ruling Q9 resolves from; fetched 2026-10-04 (cache-busted) | `AlgoVaultLabs/crypto-quant-signal-mcp` `publish-npm.yml` (OPS-XREPO-CI-RED-W1 CH4) |
| `badge-passing-publish-npm-v1.31.1.svg` | real badge body for `?branch=v1.31.1` (`Publish to npm - passing`) — the ref-resolved badge Q9 reads instead of the no-param one (which shows the DEFAULT branch). A read at ~12:53Z the same day served `no status` once, then 6/6 `passing` | same |

**Scrubbed before commit (the repo is public):** `authenticity_token`, `html-safe-nonce` / `fetch-nonce`,
`csrf`, `visitor-payload` / `visitor-hmac`, `request-id`, the HMAC tail of every `data-channel`, every
`data-hydro-*-hmac`, and response cookies — each replaced with `SCRUBBED`. The test file re-asserts it.
Provenance and the measurement record: vault `audits/OPS-XREPO-CI-RED-W1-endpoint-truth.md`.
