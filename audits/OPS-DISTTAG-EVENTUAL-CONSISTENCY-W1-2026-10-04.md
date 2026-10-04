# OPS-DISTTAG-EVENTUAL-CONSISTENCY-W1 — the publish lane waited for the cache, but the version did not exist yet

**Date:** 2026-10-04 · **Shape:** `/b` Step 6 · **Target ICP tier(s):** META · **Verdict:** ✅ ROOT CAUSE CORRECTED + FIXED AT THE GENERATOR (live proof: verify-only dispatch ``37182060859``; the close condition is the first real release run)

> Public repo: this file carries registry timestamps, cache headers and run IDs only. No figure under a public-copy HOLD.

## 1. Symptom

`publish-npm.yml`'s `Verify dist-tag` step went red on **every publishing run from 2026-08-22 to 2026-09-23** (6 runs), each time **after** npm had accepted the upload. The Smithery re-scan step that follows it therefore never ran in a release.

## 2. The corrected diagnosis — the most valuable row in this file

**V1 of this wave diagnosed a Cloudflare cache artifact and FORBADE a longer wait. That was wrong.** The Plan-Mode probe falsified it by reading the registry's own `time[v]` stamp (through a cache-buster, so from origin) against the publish step's return time:

| Run | Version | Publish returned | Origin `time[v]` | Δ | Registry `npm-notice` "being processed" |
|---|---|---|---|---|---|
| 31080580513 | 1.26.0 | 07:22:26.610 | 07:22:25.892 | **−0.7 s** | no |
| 31361832420 | 1.27.0 | 06:25:22.593 | 06:25:22.032 | **−0.6 s** | no |
| 32548613119 (dispatch) | 1.28.0 | 03:19:46.018 | 03:24:53.664 | **+307.6 s** | yes |
| 32698933909 | 1.28.1 | 06:51:20.745 | 06:56:27.322 | **+306.6 s** | yes |
| 32990545311 (dispatch) | 1.28.2 | 16:50:26.455 | 16:55:33.396 | **+306.9 s** | yes |
| 33882375620 | 1.29.0 | 14:13:33.188 | 14:17:42.215 | **+249.0 s** | yes |
| 34451023162 | 1.30.0 | 07:40:17.524 | 07:44:26.591 | **+249.1 s** | yes |
| 35852161288 | 1.31.0 | 11:02:45.948 | 11:06:55.085 | **+249.1 s** | yes |

- **Two clusters, each about 1 s wide.** A CDN age would be spread uniformly over 0–300 s. 307 s is longer than the whole TTL. A cache cannot move a timestamp that is stored inside the document. The regime changed between **2026-08-10** (1.27.0, Δ ≈ 0) and **2026-08-22** (1.28.0). That matches npm's publish-time malware scanning (GitHub Changelog 2026-07-28: availability "typically around five minutes … up to 15 minutes or more"; a version may be held for review or blocked).
- **Join artifacts, excluded:** the TAG runs for v1.28.0 (`32486745156`) and v1.28.2 (`32980710335`) failed inside the publish step (prepublishOnly) and published nothing. Their versions landed on the dispatch reruns above, so a tag-run-to-`time[v]` join for them compares the wrong run (50,312 s / 8,640 s). The clean population is the 6 publishing runs; the max is **307.6 s**.
- **Adversarial check:** 3 lens-diverse refuters (what `time[v]` records · cache vs origin · the vendor's statement) each tried to refute the propagation diagnosis with their own probes. **0/3 refuted.**

**The two defects are complementary, not alternatives.** The packument is also Cloudflare-cached (`public, max-age=300`), so after propagation it adds a ≈300 s floor (worst case ≈550 s cached vs ≈307 s uncached). That is why 1.26.0, before the regime change, needed a second 20 s attempt.

## 3. Cache headers (re-measured 2026-10-04T05:24Z, three consecutive reads)

| Endpoint | `cf-cache-status` | `cache-control` | Bytes |
|---|---|---|---|
| `/<pkg>` packument | HIT · HIT · HIT (age 165) | `public, max-age=300` | 254,819 |
| `/-/package/<pkg>/dist-tags` | DYNAMIC × 3 | absent | 19 |
| `/<pkg>/<v>` bare | DYNAMIC · HIT · HIT | `public, max-age=300` | 11,201 |
| `/<pkg>/<v>?cb=<fresh>` | DYNAMIC × 3 | `max-age=300` | 11,201 |
| `/<pkg>/9.9.9` (absent) | header ABSENT, 404 × 3 | absent | 26 |

## 4. Hypotheses

| H | Hypothesis | Verdict |
|---|---|---|
| H1 | The cached packument makes a fresh write invisible (V1's cause) | ⚠️ real but **secondary**: explains a ≤300 s floor, not two ~1 s-wide clusters with `time[v]` inside the document |
| H2 | Origin is asynchronous: npm's publish-time scan holds the version | ✅ **confirmed** by the vendor changelog, the `npm-notice` header and `time[v]`, 6/6 plus 2 controls |
| H3 | Our own lane regressed around 2026-08-21 | ❌ the delay is vendor-side; the regime matches the vendor's rollout |
| H4 | Origin replica lag | ❌ subsumed: the document itself was written late |
| H5 | Measurement artifact | ✅ **of the V1 diagnosis itself**: it measured cache headers (real) and attributed the failures to them without reading `time[v]` or the `npm-notice` line. A correct number for the wrong quantity |

## 5. Probes — claim / reality / resolution (V1 → V2)

| Claim | Reality | Resolution |
|---|---|---|
| Root cause = CDN cache; "poll longer is the wrong fix" | version absent at origin 249–307 s | V2 Build Rule 4: a bounded wait on an UNCACHED read is the fix; waiting on a cached read stays forbidden |
| `/<pkg>/<v>` is uncached | DYNAMIC once, then HIT | fresh `?cb=` on every read |
| A 200 on the version doc "proves it landed immediately" | 404 for ~4–5 min | the wait polls to a deadline |
| "8/8 runs failed after publish" | 6/8 | two tag runs failed pre-publish |
| Smithery leg runs in verify-only | `TARGET_VERSION="${GITHUB_REF_NAME#v}"` = `main` on a dispatch | the target version is taken from package.json, with a tag cross-check |
| `release:readiness`'s no-param badge reads the last release | it reads the DEFAULT BRANCH | filed to its owner (§9) |
| "Exactly two registry hits" | ≥4 third-party packument-shape URLs elsewhere | ratchet scoped to OUR package name |
| CH1 gate: ratchet PASS with an empty baseline | the live defect `publish-npm.yml:231` was still in the CH1 tree | CH1 asserted FAIL on exactly that one read; CH2 flipped it to PASS in the commit that deleted the read |

## 6. Bug class

> **Any gate that asserts, inside the write path, a value the write makes available only after an unbounded propagation delay will fail on the delay. Reading an uncached endpoint is necessary but not sufficient; the wait is.**

## 7. Fix — rank and why nothing higher

| What | Rank | File |
|---|---|---|
| ONE registry reader: dist-tags unbusted, version doc with a fresh `?cb=`; never throws, never classifies | 2 (single derivation) | `scripts/lib/npm-registry-read.mjs` |
| Shrink-only ratchet on read-backs of OUR package's cached documents; every registry occurrence classified and printed | 5 | `scripts/check-packument-read.mjs` + `ops/packument-read-baseline.json` (`baseline: []`, `allow: [reader]`) |
| Live cache canary in the suite: a cache hit is red, unreachable is skip / INDETERMINATE | 5 (detector for a premise we cannot prevent) | `tests/unit/npm-registry-read.test.ts` |
| Bounded propagation wait: 15 s polls, 1200 s deadline declared once in the lane beside its basis; `NPM_PROPAGATION_SECONDS` emitted per run | the recovery | `scripts/verify-npm-propagation.mjs` + `publish-npm.yml` `Verify dist-tag` |
| `mode: verify-only` (dispatch-only; publish skipped by exactly `inputs.mode != 'verify-only'`; ancestor guard unconditional) | — | `publish-npm.yml` + INVARIANT 5–7 |
| Smithery target version from package.json | — | `publish-npm.yml` |

**Why not Rank 1:** npm owns both the propagation pipeline and the cache semantics, so neither property can be made unrepresentable from this repo. It can only be asserted, waited for, and measured.

## 8. Dependencies and inheritors

- **Backward:** registry endpoints (§3), re-measured in-session. npm `11.18.0` `publish --help` has no `--json`, so acceptance evidence is `steps.publish.outcome`.
- **Forward:** the pinned INVARIANT 1–4 (unchanged, byte-identical assertions); `smithery-sync-lane.test.ts` ASSERTION 6 still sees `GITHUB_REF_NAME` through the tag cross-check.
- **Inheritors of the class:** `scripts/check-smithery-sync.mjs` (`s-maxage=14400`, says so in its own header); the MCP Registry `isLatest` read in the release ritual; `ops/monitoring/deploy-drift-canary.mjs`'s badge read (badge.svg is CDN-fronted); every future gate that reads back a third-party write.

## 9. The limits, stated

1. **The green comes from a verify-only dispatch, not a release.** It is weaker in two independent ways: `npm publish` never ran, and so `prepublishOnly`'s 38 segments never ran. This wave closes only on the first REAL tag-triggered release run that goes green.
2. **`release:readiness` cannot see releases.** The `publish-npm.yml` badge with no `?branch=` shows the DEFAULT BRANCH, and a tag push carries the tag as `head_branch`. So the badge reflects the last `main` run and no release run ever moves it. A green badge means "the last default-branch run passed", not "the last release passed". Owner: `OPS-PREVERIFY-RED-UNREAD-W1` (`scripts/check-release-readiness.mjs`). Replacement reader, measured HTTP 200 unauthenticated: `/repos/AlgoVaultLabs/crypto-quant-signal-mcp/actions/workflows/publish-npm.yml/runs?per_page=1`, which returns the newest run on any ref.


## 9a. Pre-landing adversarial review of CH2 (25 agents: 3 lenses, each finding attacked by 2 refuters)

9 confirmed findings, which collapse to 5 distinct defects. All were fixed before landing, in `1c7d115a`:

| Finding | Fix |
|---|---|
| The verdict came from the LAST read only, so one blip on the final poll turned 80 definitive "still 404" reads of a held version into INDETERMINATE / exit 0 | the verdict uses the last DEFINITIVE read of each endpoint. A full match ends the wait on the poll that observed it, so a stale definitive read can only hold a verdict at FAIL |
| Remediation said "re-run with mode: verify-only", but a GitHub Re-run replays the tag push with empty `inputs` and would attempt the upload again | the text names a NEW dispatch: `gh workflow run publish-npm.yml --ref main -f mode=verify-only` |
| In verify-only, the Smithery step's failure branches still said "The npm publish SUCCEEDED" | its wording is derived from `steps.publish.outcome` |
| R6 (target version from package.json) was pinned by no persistent test | a suite test with a deliberate-break mutation |
| No test ran the CLI path (`main()`, entry guard, `process.exitCode`) | the real script now runs in a copied tree. **This caught a live defect:** the `import.meta.url === pathToFileURL(argv[1])` entry guard is false behind a symlink, so `main()` never ran and the step exited 0 with no token. The guard now compares realpaths |

`scripts/check-packument-read.mjs` (CH1) carries the same symlink-blind guard form. Its failure mode is a MISSING token, which every token-gating caller already treats as not-PASS, and neither the checkout nor CI runs it through a symlink. It is recorded here, not changed: CH2 could not write that file.

## 10. Verdict tokens

Live proof: `publish-npm.yml` dispatched with `mode: verify-only` on `main` at `1c7d115a`, run **`37182060859`** (2026-10-04T06:11Z), conclusion `success`:

| Token | Value |
|---|---|
| `PUBLISH_ANCESTRY_VERDICT` | `PASS` |
| `PUBLISH_LANE_MODE` | `verify-only` |
| `NPM_PUBLISH_PERFORMED` | `false` (publish step `skipped`) |
| `NPM_PROPAGATION_SECONDS` | `0` |
| `NPM_VERSION_PUBLISHED` | `PASS` |
| `DIST_TAG_VERDICT` | `PASS` |
| `SMITHERY_RESCAN` | `OK` (deployment `9f13d601-…` → `SUCCESS`): **the first time this step has executed in this lane** |
| `SMITHERY_SYNC_VERDICT` | `PASS` |
| `RELEASE_READINESS_VERDICT` | `PASS` (exit 0; `RELEASE_READINESS_RED=none`) |
| `PACKUMENT_READ_VERDICT` | `FAIL` on the CH1 tree (exactly `publish-npm.yml:231`, by design) → `PASS` on the CH2 tree |
| Nothing published | npm `latest` `1.31.0` and packument `time.modified` `2026-09-23T11:06:55.465Z`, identical before and after the dispatch |
| Commits | CH1 `167d41d5`, CH2 `1c7d115a`, both landed via `scripts/land.sh` (`LAND_VERDICT=LANDED`, `TEST_GATE_VERDICT=PASS`) |

