# MONITORING_INVENTORY_DRIFT + DEPLOY_DRIFT — 2026-09-14

Wave `OPS-DRIFT-ALERT-GENERATORS-W1` · alert-driven (`/b`) · Plan-Mode HALT answered Q1–Q5 = A · repo `crypto-quant-signal-mcp`.

Three Telegram pages carried seven defects between them. Each is traced to one root cause and a bug class, and fixed where the class is produced rather than at the instance that paged.

## 1. The pages, transcribed

| # | Host · time (UTC) | Alert | Body fields |
|---|---|---|---|
| A | signal-1 · 2026-09-14T06:57:38Z | `MONITORING_INVENTORY_DRIFT`, breach streak 8 | `ORPHAN: backfill-drain-gate.py` · `ALERT_EPISODE_STALE: {'host': '204.168.185.24', 'alert_id': 'OUTCOME_BACKFILL_STALLED', 'verdict': 'FIRING_STALE', 'detail': 'episode open 8.6d, past the 7d bound — either the condition never cleared or nothing is calling --clear for it', 'a` (cut) · `Action: dispatch OPS-MONITORING-INVENTORY-RESTORE-W{NEXT}` |
| B | aoe-1 · 2026-09-14T07:17:44Z | `MONITORING_INVENTORY_DRIFT`, breach streak 6 | `HASH_DRIFT` + `REGISTRY_PARITY` on `cron-interlock-registry-aoe1`: repo `b210c505ae7c`, host `24b533f18273` · the same raw `W{NEXT}` |
| C | signal-1 · 2026-09-13T12:43:04Z | `DEPLOY_DRIFT` | `algovault-bot` · `DRIFT_INDETERMINATE` · prod `65affdb` · main `c777e73` · behind 4350m · `reason: deploy lane health unreadable; could not determine whether the delta deploys` · `next:` the crypto-quant-signal-mcp deploy badge · every newline delivered as a literal `\n` |

## 2. What each finding actually was

| Finding | Hypotheses falsified (probe) | Root cause (probe) |
|---|---|---|
| A · ORPHAN | stale host inventory (the host held the row; 112 rows = origin/main) · label scope (cron `labels=['204.168.185.24','signal-1'] owned=96/112`) · a hand-run (the block is the cron run) | A repo-resident tool copied to the host outside its declared design. Row `backfill-drain-gate` declares `host: n-a`, "NO host install BY DESIGN"; the host file was placed 2026-09-07T07:06:44Z with sha `9c2e5224…`, the row's own sha. First breach 2026-09-08T06:57:37Z. |
| A · FIRING_STALE | the condition never cleared (canary `consecutive_pass: 169`, `last_verdict: PASS`) · a measurement artifact (marker `1788628381` read on the host) | The owner's clear path never fired. `outcome-backfill-freshness.py` cleared only when a private `paged` flag was true; the flag arrived with A3 (`b742b139`, installed 2026-09-07) after the 2026-09-05T17:13:01Z page, so it read `false` for the entire episode — zero `--clear` calls in every retained wrapper log. |
| A · cut body | — | `build_body()` rendered non-SCHEDULE_DRIFT lists as `', '.join(str(x))[:220]`: a Python repr cut at character 220, dropping `age_days`, `bound_days`, `opened_at`. |
| A + B · raw `W{NEXT}` | — | The resolver greps the host `status.md`, which trim policy v3 keeps to OPEN waves (host copy: 28 headings). Nine retained wrapper logs: 54 `RESOLVER_MISS`, 2 resolutions (both ≤ 2026-08-01), 0 since. Out of this wave by ruling (Q5). |
| B · HASH_DRIFT | declaration-sync dead (`SYNC_LIVENESS aoe-1 LIVE`; sync `UNCHANGED` 07:27Z) · a propagation window (breaching daily since 2026-09-09) · a measurement artifact (host `24b533f1…` vs `git show origin/main:` `b210c505…`) | A host-consumed declaration no sync path reached, refreshed by prose. The row carried a `sync_exempt_reason` (declaration-sync could only fetch `ops/monitoring/`) and its refresh instruction lived in `notes`; `IDENTITY-LIFECYCLE-W3` edited the registry three times on 2026-09-08 (`cf8b0221` `87e1e5d9` `9c9d9dc9`), re-stamped the row and never re-installed. The named follow-up `OPS-CRON-REGISTRY-SYNC-W1` never shipped. The three new rows were all `host: signal-1`, so nothing aoe-1 decides on had changed — but the page was true. |
| C · reason / next | the bot's lane is red (its repo carries only `test.yml`) · the delta does not deploy (`c777e73` touches `scripts/`, inside the manifest's `deploy scripts`) · a measurement artifact (`DEPLOYED_SHA` `65affdb` via host-deploy 2026-09-09T07:01:08Z vs `ls-remote` `c777e73`) | The canary had no deploy model for a manual-deploy repo. The bot's row carried no lane, so `laneHealth` stayed null and the classifier took its "lane unreadable" branch, whose `next:` was a hardcoded crypto-quant-signal-mcp URL. A deploy was genuinely owed. |
| C · literal `\n` | — | The body reached the wrapper through `sh -c "printf '%s' <JSON-stringified body> \| wrapper"`: JSON escapes each newline, `%s` prints it verbatim. The self-test asserted `renderAlertBody()`'s return value — the string before the transport. All four pages 2026-09-10..13 were affected. |
| C · adjacent | — | `readme-snapshot-writeback.yml` pushes `README.md` with `GITHUB_TOKEN` by design, so GitHub creates no Deploy run. Six writebacks 2026-09-10..14, zero Deploy runs; the 2026-09-11 MCP page was one of these. Same class as the bot finding. |

## 3. Bug classes, priors, and the fix each earned

| # | Class | Priors (by root cause) | Fix |
|---|---|---|---|
| 1 | Any push that cannot create a deploy run — a paths-ignored file, a manual-deploy repo, a `GITHUB_TOKEN` writeback — makes DEPLOY_DRIFT page with an INDETERMINATE describing a lane that was never going to run | `aad0e26` 2026-08-21 · bot from 2026-09-10 · writeback 2026-09-11 | **Unrepresentable.** Every `REPOS` row declares a deploy model from a closed kind set (`gha-push`, `manual-manifest`); `classifyDrift` requires it and refuses (`no-deploy-model`) without one. Declared `GITHUB_TOKEN` writers are judged per commit, on identity AND declared paths. A manual-manifest delta is judged against the manifest, parsed exactly as `host-deploy.sh` does; a touched deploy set is the new verdict `DRIFT_MANUAL_DEPLOY_OWED`, paging with the `--dry-run` command. Every `next:` projects from the row's own model. |
| 2 | Any adopter whose `--clear` never reaches the wrapper while its owner is healthy pins the episode open until FIRING_STALE | DECLARATION_SYNC no clear path 2026-08-17 · PAYMENT_DECLINE argv reversed 2026-09-07 · this | **Single derivation.** The resolution gate projects from `send_telegram.sh`'s own marker — the record its cooldown gate, its `--clear` path and FIRING_STALE already read. The private flag is gone; a clear no longer resets the recovery streak, so an undelivered resolution retries on the next healthy run. |
| 3 | Any host-consumed declaration no sync path reaches goes stale on its first repo edit | inventory 52/50 rows 2026-08-05 · website-drift manifest 2026-08-10 · detector-envelope schema · this | **One sync path.** `declaration-sync.sh` rows take an optional 5th field naming a repo-relative source; one row parser (`row_fields`) and one shape check (`row_shape_error`) serve every read site, and each refusal is proven on synthetic rows. The `sync_exempt_reason` hatch is retired for rows with a committed artifact. The coverage gate counts a sourced declaration only when its file exists. |
| 4 | Any alert body interpolated into a shell string corrupts its newlines in transport | xrepo-ci `%0A` 2026-08-21 · this | **Unrepresentable for this canary.** `execFileSync` with the body on stdin; the self-test and vitest drive the dispatch against a fake wrapper and read what arrived. |
| 5 | Any list finding rendered through `str()` with a character cap drops trailing fields | this | **Renderer.** One `key=value` line per finding; bounds on whole units only (items per check, characters per value with the key kept, whole lines per message). |
| 6 | Any repo-resident tool hand-copied to a host pages ORPHAN daily | aoe-1 litter 2026-08-13 · this | **Detection, named.** The page states what the ORPHAN already is (a committed row, by name or bytes) and both remedies. A hand `scp` cannot be blocked from a laptop; the reconciler makes it legible on day one. |
| 7 | Any `W{NEXT}` resolved against a corpus that excludes completed waves ships raw | RECRESOLVER 2026-08-07 · `✅ SHIPPED` headings 2026-08-27 · this | Out of this wave (Q5 = A). |

## 4. Dependency envelope

**Backward — met.** The wrapper marker is the "fire delivered" SoT (`do_clear` gates on it; the reconciler reads it). The bot manifest is the deploy-set SoT (`host-deploy.sh`, `bot-deploy-parity.sh`). `GITHUB_TOKEN` pushes creating no run is measured (6 writebacks, 0 runs). `install-monitoring-artifact.sh` is the sanctioned installer.

**Forward — enumerated.** `tests/unit/deploy-drift-canary.test.ts` · `tests/unit/declaration-sync.test.ts` · `tests/unit/declaration-coverage.test.mjs` · `scripts/check-declaration-coverage.mjs` · the reconciler's `--self-test` · inventory rows `deploy-drift-canary`, `outcome-backfill-freshness`, `declaration-sync`, `monitoring-inventory-reconcile`, `cron-interlock-registry-aoe1`, `backfill-drain-gate` · the vault `system-map.md` rows. `declaration-coverage.test.mjs` was first MISSED — the consumer grep was piped through `head` — and was caught by running the node:test suite the push gate runs, before landing. `tests/unit/monitoring-primitive-parity.test.mjs` consumes the installer's `first_install` stamps: the last two stamps took the unstamped load-bearing count from 40 (origin/main) to 38, which left its ratchet ceiling of 44 six above the real count and turned the honesty check red. The ceiling was lowered to 38 in the same landing.

## 5. Proof

| Check | Result |
|---|---|
| deploy-drift self-test | 102 of 102, also on signal-1 (including 6 transport checks) |
| deploy-drift vitest | 57 of 57 |
| outcome-backfill-freshness self-test | 103 checks, floor 103, incident replay included; also on signal-1 |
| declaration-sync self-test | 93 checks |
| declaration-coverage self-test · node:test | 22 checks · 9 of 9 |
| reconciler self-test | 268 → 279 checks, 0 failures |
| inventory parity node:test | 12 of 12 |
| mutations | canary 6 · freshness 2 · declaration-sync + coverage + inventory 7 · reconciler 2 — each turned a named check red; every file restored byte-identical |
| every suite that reads the inventory | vitest 12 files, 355 of 355 · node:test 3 files, 30 of 30 (29 of 30 before the ceiling fix) |
| `first_install` ratchet, both directions | ceiling 44: honesty check red (6 above 38) · 38: green · 37: ratchet red (`38 load-bearing rows lack a first_install stamp; the ceiling is 37`) |
| push gate | `TEST_GATE_VERDICT=PASS`, `LAND_VERDICT=LANDED` on both landings (`7701b3a5`, `a23743f0`) |

## 6. Instance remediation, measured

| Item | Action | Evidence |
|---|---|---|
| `deploy-drift-canary.mjs` · signal-1 | `8da48577` → `4a1f5ad7` · backup `.bak.OPS-DRIFT-ALERT-GENERATORS-W1-20260914T084745Z` | cron-shaped run (`ALGOVAULT_TG_TEST_INERT=1`): bot `DRIFT_MANUAL_DEPLOY_OWED` (`scripts/tg-conversion-baseline.sh`); the wrapper logged `SUPPRESSED_TEST_CONTEXT` |
| `outcome-backfill-freshness.py` · signal-1 | `a187835b` → `d3c3d27b` · backup `…084756Z` | the 09:13:03Z scheduled run: `CLEAR_FIRED: HTTP 200 — resolved after 8d 16h; marker removed` |
| `algovault-bot` | `host-deploy.sh` `c777e73` at 2026-09-14T08:49:59Z · both units active · 140-file lockfile | canary: `algovault-bot … DRIFT_NONE (in sync)` |
| `backfill-drain-gate.py` · signal-1 | renamed to `.bak.OPS-DRIFT-ALERT-GENERATORS-W1-RETIRED-20260914T090821Z`, byte-identical; no scheduler reference, no state file | ORPHAN empty |
| `declaration-sync.sh` · signal-1 + aoe-1 | `df876a7d` → `8227b742` · backups `…091200Z` | aoe-1: `SYNCED cron-interlock-registry.json — 24b533f18273826d -> b210c505ae7c9356`; signal-1: that row `SKIPPED` (scoped aoe-1) |
| `monitoring-inventory-reconcile.py` · signal-1 + aoe-1 | `1384ebcc` → `fea2cdf8` · backups `…091222Z` | the committed reconciler rendered the live signal-1 findings: the ORPHAN line named row `backfill-drain-gate` and both remedies; the episode line carried `opened_at=2026-09-05T17:13:01Z` |
| both hosts | reconciler `--check`, state-free, cron env | exit 0 on aoe-1 and on signal-1 after the syncs |
| `DEPLOY_DRIFT` episode (opened 2026-09-13T12:43:04Z) | resolved by the first scheduled canary run after both deploys | 09:43:02Z: `crypto-quant-signal-mcp … DRIFT_NONE (in sync)` and `algovault-bot … DRIFT_NONE (in sync)` → `healthy — clear dispatched (ok=true)`; wrapper 09:43:03Z `CLEAR_FIRED: HTTP 200 — resolved after 20h; marker removed` |

## 7. What this does not cover

- The `W{NEXT}` resolver still ships raw placeholders (class 7) — a separate follow-up by ruling.
- `DEPLOY_DRIFT` is one alert id across repos: a page for one repo cooldown-suppresses the other's for 24h.
- A hand-copied tool is detected and named, not prevented.
