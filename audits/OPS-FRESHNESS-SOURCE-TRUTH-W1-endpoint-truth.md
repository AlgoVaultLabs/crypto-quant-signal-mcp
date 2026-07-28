# OPS-FRESHNESS-SOURCE-TRUTH-W1 — C0 endpoint-truth

**Chapter:** C0 (read-only probe). **Status:** 🛑 **HALT — 6 fictional primitives** (CLAUDE.md
§ Plan Mode rules: ≥3 → HALT). **C1 does not start until the architect rules on Q1–Q5.**

**Probed:** 2026-07-28 03:10Z, live, by Claude Code. **Base:** `origin/main` `7eff7bd`.
**Worktree:** `ops/freshness-source-truth-w1` (branched off `origin/main`; the primary checkout
lagged at `49e710f`).

**Clock discipline (CLAUDE.md `box-utc-first`).** Every staleness figure below is anchored to a
verified clock, not to session feel:

| Source | Reading |
|---|---|
| Hetzner 204 `date -u` | `Tue Jul 28 03:09:32 UTC 2026` |
| Mac `date -u` | `Tue Jul 28 03:09:57 UTC 2026` |
| `api.algovault.com` HTTP `Date:` | `Tue, 28 Jul 2026 03:09:57 GMT` |
| `cloudflare.com` HTTP `Date:` | `Tue, 28 Jul 2026 03:09:58 GMT` |

**No clock skew.** Canonical now = **2026-07-28 03:10Z**.

> ⚠️ Incidental observation, no action taken: vault `status.md` entries are labelled `UTC` but
> carry local (UTC+7) times — e.g. the top entry reads `2026-07-28 ~10:25 UTC`, ~7h ahead of real
> UTC. Not in scope; flagged so future waves do not cross-reference fire times against them.

---

## 1. Verdict on the wave's load-bearing claim — ✅ CONFIRMED

**Claim (spec §Root cause, defect 1):** *a `FRESH` row never consults `sot_endpoint`/`sot_jq`; it
compares the page-scraped literal against wall-clock `now`.*

**Reality** — `/opt/algovault-monitoring/website-drift-canary.py:346`:

```python
elif ttype == "FRESH":
    if not isinstance(page_value, (int, float)):
        fires = False
        drift = f"non-numeric days ({page_value}); skipping"
    else:
        fires = page_value > tval          # ← page literal vs threshold. sot_value never read.
        drift = f"days_since={page_value:.2f}d vs threshold {tval}d (...)"
```

`sot_value` **is** fetched (`:786` → `fetch_sot()` `:257-263`) and passed into `compute_drift()`,
then discarded by the `FRESH` branch. `sot_endpoint` / `sot_jq` on a FRESH row are **dead config**.

`VERIFY_LATEST_BATCH_FRESH` is the **only** `FRESH` row among the 28 (manifest `:277`).

**Resolution:** thesis holds. The wave's premise is sound; its supporting evidence is not (§3).

### 1.1 The fire reproduces exactly

| Step | Evidence |
|---|---|
| Last deploy | GHA `deploy.yml` run `30162396798`, started `2026-07-25T14:49:37Z`, 3m5s |
| Bake written | `/var/www/algovault/verify.html` mtime `Jul 25 14:51`; injector log `[2026-07-25T14:51:57.171Z] FILE_WRITTEN path=landing/verify.html replacements=13` |
| Value baked | `latest_batch_at = 2026-07-25 00:05 UTC` (batch **#106** — the latest at bake time) |
| Canary run | `0 12 * * 1` → `2026-07-27T12:00:04+00:00` |
| Computed | `(07-27 12:00:04) − (07-25 00:05)` = **2.50 d** → `DRIFT_FIRE … days_since=2.50d vs threshold 2d (STALE)` |

**Why no deploy in between — benign, verified.** The only commit after `6184d04` is
`7eff7bd chore(funnel): auto-snapshot 2026-07-27`, which touches only
`activation-funnel/snapshots/**` — the **first** entry in `deploy.yml` `paths-ignore`. It correctly
did not deploy. There is **no** broken-deploy incident hiding behind this alert.

**The producer is healthy.** `latest_batch_id 109`, `published_at 2026-07-28T00:05:04.390Z` —
**0.13 d ago**. The alarm sent the operator to a system with a perfect record, exactly as diagnosed.

---

## 2. Probe table — `claim | reality | resolution`

| # | Claim | Reality (live, 2026-07-28 03:10Z) | Resolution |
|---|---|---|---|
| P1 | Alert fired at `days_since=2.50d vs threshold 2d` | ✅ Verbatim: `[2026-07-27T12:00:04+00:00] DRIFT_FIRE: VERIFY_LATEST_BATCH_FRESH :: days_since=2.50d vs threshold 2d (STALE)`. Run END: `fires=1 set_extract_failures=0 suppressed_no_tg=3 total_rows=28`. Exactly one fire in the log — first occurrence | Confirmed |
| P2 | Live manifest row matches the spec's quoted YAML | ⚠️ Two mismatches: `sot_jq` is bare `.batches[0].published_at` (no jq pipeline); `recommended_wave` is `OPS-MERKLE-PUBLISH-INVESTIGATION-W{NEXT}` — **template form, not a hardcoded `W1`** | **F3** |
| P3 | **FRESH ignores the SoT** | ✅ **CONFIRMED** — `fires = page_value > tval` (`:346`); `sot_value` fetched and discarded | **Thesis holds** |
| P4 | Canary is weekly | ✅ `0 12 * * 1 /opt/algovault-monitoring/website-drift-canary.py` — Mondays 12:00Z. A genuine publish halt goes ≤7 d undetected, as stated | Confirmed |
| P5 | `/verify` render source is `landing/verify.html` | ✅ Target correct — **but** the file is **not** in the Docker image; Caddy serves `/var/www/algovault/verify.html`. Committed literal is `#45 / 2026-05-25 00:05 UTC`; the injector rewrites it host-side on every run. Repo hand-edits to these literals are therefore **not durable** | **F6**, → **Q3** |
| P6 | 26 manifest claims; `latest_batch*` rows may be missing | ⚠️ **27** claims (`jq '.claims\|length'` = 27; injector log `MANIFEST_LOADED claims=27`). All three `dtrf-latest-batch-at` / `-n` / `-hash-n` rows **already exist** | **F7**; R3.3 = **no-op** |
| P7 | Nothing reads `sot_endpoint` on a FRESH row | ✅ Read generically at `:257-263` for all rows, then discarded by the FRESH branch — dead config confirmed | Confirmed |
| P8 | `recommendation-drift-canary.py` failed to catch a hardcoded `W1` | ⚠️ Canary is installed (`0 12 * * 2`, 8599 B, May 25) and **skips rows already in `W{NEXT}` form** (`:65-66`). All **28** manifest rows are `W{NEXT}`. There was nothing to catch — it is working | **F3** — probe void |
| P9 | Unknown whether `ops/cron/**` triggers a deploy | ⚠️ **It does.** Live `paths-ignore` = `activation-funnel/snapshots/**`, `activation-funnel/README.md`, `ops/systemd/**`, `ops/monitoring/**`, `LICENSE`, `glama.json`, `Caddyfile`. `ops/cron/**` is **absent** ⇒ a C2 commit **rebuilds the image and restarts prod** | State in C2 commit body |
| P10 | Is `landing/` baked into the image, cp'd to Caddy, or both? | Dockerfile COPYs only `landing/integrations/`, `landing/skills.html`, `landing/integrations.html`, `landing/Prompt/`. `verify.html` ships **only** via `cp landing/*.html /var/www/algovault/` (deploy.yml `:199`) | C2 reuses that exact command |
| P11 | Logrotate "confirm whether it shipped" | ⚠️ **It shipped** — `/etc/logrotate.d/algovault-snapshot-landing` (May 25 06:35): `weekly / rotate 8 / missingok / notifempty / compress / delaycompress / copytruncate`; 8 rotations on disk. Injector log path `/var/log/algovault-snapshot-landing.log`, currently 0 B (rotated Jul 26 00:00; nothing written since — consistent with no deploy) | **F5**; R2.3 = **verify-only** |
| P12 | Test runner + layout | `npm test` = `vitest run`. `tests/unit/` = 215 files. Existing forward-stability siblings: `tests/unit/tool-description-forward-stability.test.ts`, `tests/unit/integrations-no-stale-numbers.test.ts`, `tests/x402-bazaar-forward-stability.test.ts` | Confirmed |
| P13 | `00:13` + `00:23` are unoccupied | 🛑 **Both occupied.** `:13` ×3 (`webhook-delivery-canary` `13,28,43,58`; funding matview `3-58/5`; backfill `2-59/3`). `:23` ×6 (`registry-conformance-canary` `23 * * * *` + 5). **Free in hour 00: only `:09`, `:39`, `:57`** | **F4** → **Q1** |
| P14 | Endpoints 200 | ✅ `algovault.com/api/merkle-batches` 200 · `api.algovault.com/api/merkle-batches` 200 · `algovault.com/verify` 200. SoT: `latest_batch_id 109`, `batch_count 109`, `batches\|length 100`, `total_signals 416284` | Confirmed + **F8** |
| P15 | ≥3 prior same-root-cause fixes | ✅ 5 distinct waves reference `latest_batch_at` / `VERIFY_LATEST_BATCH`: `OPS-VERIFY-COPY-REFRESH-W1` (×2), `OPS-WEBSITE-COPY-DRIFT-CLEANUP-W1`, `OPS-LANDING-AUTO-ALIGN-W1`, `OPS-LIVE-BIND-MIGRATION-W1`. **Well over the threshold — no HALT on P15** | Generator mandate **holds** |

### 2.1 P15 — the mis-attribution was already diagnosed once and never acted on

`Old Status/Status May 2026.md:3141`:

> `VERIFY_LATEST_BATCH_FRESH` … `OPS-VERIFY-COPY-REFRESH-W1` (**manifest names
> OPS-MERKLE-PUBLISH-INVESTIGATION-W1 but real fix is verify-page static-fallback refresh; SoT
> pipeline is healthy**)

The same conclusion this wave reaches was written down in May 2026, then dropped. That is a **6th**
data point and it strengthens, not weakens, the mandate for a **generator-level** fix: a lane-fix
was applied and the *manifest row was left mis-pointing*, so the next fire re-taught the same
lesson to a fresh operator.

---

## 3. The six fictional primitives

| # | Spec asserts | Live reality | Blast radius |
|---|---|---|---|
| **F1** | C1 gate runs `python3 website-drift-canary.py --self-test` | **No such flag.** The script has zero `argparse` / `sys.argv` parsing — it accepts no arguments at all | C1's Verification Gate cannot pass as written |
| **F2** | `sot_jq: '.batches[0].published_at \| fromdateiso8601 \| (now - .) / 86400'` | **Throws.** Live-reproduced: `jq: error (at <stdin>:0): date "2026-07-28T00:05:04.390Z" does not match format "%Y-%m-%dT%H:%M:%SZ"` — the payload carries fractional seconds | `MERKLE_PUBLISH_LIVENESS` would error on its first run. *Corroborates P3/P7: had this jq ever executed, it would have thrown — proof the field is dead config* |
| **F3** | `recommended_wave` is a hardcoded `W1`, "a direct violation of the codified rule" | **False.** Manifest `:280` = `OPS-MERKLE-PUBLISH-INVESTIGATION-W{NEXT}`; **all 28** rows are `W{NEXT}` | R1.1 bullet 4 and the whole P8 investigation lose their premise |
| **F4** | Injector at `00:13`, canary at `00:23` | **Both minutes occupied** (P13). Free set in hour 00 = `{:09, :39, :57}` | Every threshold in R1.2's `notes` is derived from `00:23` |
| **F6** | Served `/verify` shows `#100 / 2026-07-19`, **9 batches / 9 days** stale | **`#106 / 2026-07-25 00:05 UTC` — 3.13 days stale.** Cache-busted fetch, `cf-cache-status: DYNAMIC`, `last-modified: Sat, 25 Jul 2026 14:51:57 GMT` | C3's change-table "Now (served)" column is wrong; the public-copy-impact framing overstates 3× |
| **F8** | G2 inheritance #2: `merkle_batch_count` "increments daily by construction" | **False — frozen at 100.** Manifest accessor is `batches.length`; the API caps `batches` at 100 while `batch_count` = **109**. A daily re-bake changes nothing | Removes one of five named inheritors — **and exposes a live defect (§3.1)** |

### 3.1 F8 exposes a second, independent mis-measured alarm — same family as this wave's thesis

`/api/merkle-batches` returns `batch_count: 109` but caps `.batches` at **100**. Three manifest
rows read `accessor: batches.length` — `dtrf-merkle-batch-count` (index + how-it-works),
`dtrf-batch-count` (skills), `jsonld-merkle-batches` (4 pages).

⇒ **The public site claims "100 merkle batches" when there are 109** — including on `/verify`, the
verifiability page, and inside JSON-LD that LLM crawlers ingest.

The canary is **structurally blind** to it:

```
PASS: HOMEPAGE_MERKLE_COUNT_DTRF_EXACT :: page floor 100 vs SoT 100; floor HOLDS
PASS: HIW_MERKLE_DTRF_EXACT           :: page floor 100 vs SoT 100; floor HOLDS
```

Both sides read the **same capped array**, so the check can never fail. This is the wave's own
thesis — *an alarm measuring the wrong layer* — recurring in a second place. Fix is one line per
row (`batches.length` → `batch_count`) plus the matching canary `sot_jq`. **Outside the declared
Scope → Q4.**

---

## 4. Two live traps the spec does not account for

### 4.1 `DRY_RUN_TG=1` still writes the 24 h cooldown marker

`/opt/algovault-monitoring/send_telegram.sh:141-145`:

> `PATCH-A: DRY_RUN_TG gate — synthetic smokes + cred probes go through ALL gate logic but skip the
> actual TG POST. **Marker is still written** so cooldown-suppression smokes work.`

AC1.3, AC1.5, AC4.2 and AC4.3 all prescribe back-to-back dry runs. **The second run would be
cooldown-suppressed and read as a false green.** The correct lever is `ALGOVAULT_TG_TEST_INERT=1`
(`:96-104`), which suppresses **before** the cooldown gate and writes **no** marker — added
precisely because a spurious marker is the dangerous half of that failure mode. → **Q5**

**Upside — R1.3's assumption is now verified, not assumed.** The gates live in the wrapper, not in
the canary (`website-drift-canary.py:403` calls `[WRAPPER, alert_id, "CRITICAL_PERSISTENT", "-"]`):
severity must be `CRITICAL_PERSISTENT`, and `COOLDOWN_SEC=86400` per `alert_id`. **A weekly→daily
cadence change cannot cause alert spam.**

### 4.2 A second host job mutates the same git working tree

`scripts/commit-funnel-snapshot.sh:130` runs `git checkout -- .` before rebasing, deliberately
discarding the injector's working-tree edits — its comment reasons that the tree is disposable
because `deploy.yml` re-injects and Caddy serves a separate copy. That reasoning survives C2:

- It runs **weekly, Mon ~10:08Z** (`algovault-funnel-snapshot.timer`; last fire `2026-07-27
  10:12:25Z`) — it cannot collide with a `00:09` daily cron.
- The injector is **state-independent**: it regex-replaces span *contents*, so its output depends
  only on the SoT value, never on the prior literal.

⚠️ But C2's `flock` guards cron-vs-cron only. The deploy path does **not** take the lock, and
neither does the funnel job. This is recorded as understood-and-accepted, not as protection.

*(This also explains the otherwise-confusing host state: `/opt/crypto-quant-signal-mcp` is at
`7eff7bd` with a **clean** tree showing committed `#45 / 2026-05-25`, while the webroot copy carries
the injected `#106 / 2026-07-25`. The funnel job reset the tree on Jul 27; the webroot was last
written on Jul 25. Both are correct.)*

---

## 5. Items folded in without needing an architect ruling (flagged, not silent)

| Item | Disposition |
|---|---|
| Manifest claim count is **27**, not 26 | Prose correction; no behavioural change |
| R2.3 logrotate already shipped 2026-05-25 | Downgraded to **verify-only** (`logrotate -d` parse) |
| R3.3 `latest_batch{,_n,_at}` manifest rows already exist | **No-op** |
| R1.1 bullet 4 (`recommended_wave` lint) | Keep as a **regression guard**; its cited violation does not exist |
| `ops/cron/**` is not `paths-ignore`d | C2 commit body must state that the commit rebuilds + restarts prod |
| Injector has `--dry-run` but **no `--check`** | R2.4 builds `--check`; it is new, not a repair |
| `next_batch_in` browser hydration | **Live** — `verify.html` inlines `updateNextBatchCountdown()` + `setInterval(…, 60000)` (`render-jsx-static.mjs:1229`; `track-record-proxy.js` does **not** support it). The frozen `3h 41m` affects only no-JS readers and crawlers, as the spec says |

---

## 6. C0 Verification Gate

```
15 probe rows present (P1–P15) · zero writes outside audits/ · no state mutation on 204
```

All probes were read-only: `grep`, `sed -n`, `ls`, `cat`, `crontab -l`, `systemctl list-timers`,
`git show`, `gh run list`, `curl`. No `crontab -e`, no file writes on the host, no service restart,
no push.

---

## 7. 🛑 HALT — architect Q-block

```
OPS-FRESHNESS-SOURCE-TRUTH-W1 — Plan-Mode HALT (C0 complete, 6 fictional primitives). Thesis CONFIRMED
(website-drift-canary.py:346 `fires = page_value > tval` — FRESH never reads the SoT). Publisher healthy:
batch #109 @ 2026-07-28T00:05:04Z. Answer Q1-Q5 to unblock C1.

Q1 [F4 — cron minutes; blocks C1 R1.3 + C2 R2.2 + every threshold in R1.2 notes]
    Spec defaults 00:13 (injector) and 00:23 (canary) are BOTH occupied on 204.
    :13 = 3 jobs (webhook-delivery-canary 13,28,43,58 + funding matview + backfill).
    :23 = 6 jobs (registry-conformance-canary "23 * * * *" + 5 others).
    Only :09, :39, :57 are free in hour 00 UTC.
    Proposed: injector 00:09 (publish completes by 00:05:16 observed), canary 00:39.
    run_offset = 0.567h -> coherence band (0.0236, 1.0236) -> tolerance_value 0.5 still sits mid-band.
    Q1: ratify injector=09 0 * * *, canary=39 0 * * * ?  [YES / alternative minutes]

Q2 [F1+F2 — C1 gate + the new row's jq]
    (a) `website-drift-canary.py --self-test` does not exist (no argparse at all).
        Options: (i) build a real --self-test entrypoint as part of R1.4, and keep the gate;
                 (ii) drop --self-test from the C1 gate and assert via the vitest/pytest lint tests only.
    (b) `fromdateiso8601` THROWS on the live payload (fractional seconds ".390Z").
        Proposed sot_jq: '.batches[0].published_at | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601 | (now-.)/86400'
        (verified: .batches[0] IS the newest — id 109 first, id 10 last).
    Q2: pick (i) or (ii) for (a); ratify the corrected jq in (b)?

Q3 [F6 + P5/P10 — C3 is structurally a no-op as written]
    Served /verify is #106 / 2026-07-25 (3.13d stale), NOT #100 / 2026-07-19 (9d) as the spec states.
    More importantly: landing/verify.html is NOT in the Docker image; the committed literal (#45 /
    2026-05-25) is REWRITTEN host-side by the injector on every run. So C3 R3.1 "correct the three
    elements" cannot durably change anything -- C2's daily cron is the entire fix. The only durable
    C3 work is R3.2 (next_batch_in has NO manifest row and is a relative countdown that can never be
    correctly baked; browser hydration IS live via the inline updateNextBatchCountdown()+60s interval)
    and R3.4 (forward-stability test).
    Q3: reduce C3 to R3.2 + R3.4 + R3.5 (drop R3.1 hand-correction, drop R3.3 as already-present)?
        [YES / keep R3.1 as a cosmetic commit anyway]

Q4 [F8 — a SECOND mis-measured alarm, outside declared Scope]
    /api/merkle-batches returns batch_count=109 but caps .batches at 100. Three manifest rows use
    accessor "batches.length", so the public site claims 100 merkle batches when there are 109 -- on
    /verify itself. The canary is blind: page 100 vs SoT 100 (both read the capped array).
    Fix is one-line-per-row (accessor batches.length -> batch_count) + the matching canary sot_jq.
    Q4: (a) fold into this wave as C3.5 (it is the same "alarm measures the wrong layer" class), or
        (b) spin OPS-MERKLE-COUNT-CAP-TRUTH-W{NEXT}, or (c) leave and log in status.md only?

Q5 [test-harness trap, no spec coverage]
    send_telegram.sh writes the 24h cooldown marker even under DRY_RUN_TG=1 (:143-145). AC1.3/AC1.5/
    AC4.2/AC4.3 all use back-to-back dry runs -- the 2nd is cooldown-suppressed and reads as a FALSE
    GREEN. Correct lever is ALGOVAULT_TG_TEST_INERT=1 (pre-cooldown, writes no marker).
    Q5: ratify ALGOVAULT_TG_TEST_INERT=1 for all negative/positive gate runs, with an explicit
        marker-cleanup step before each live-fire assertion?  [YES / other]

Also folded in without needing a ruling (flagged, not silent):
  - manifest claim count is 27, not 26 (spec prose).
  - R2.3 logrotate already shipped 2026-05-25 (weekly/8/compress/copytruncate) -> no-op, verify only.
  - R3.3 latest_batch{,_n,_at} manifest rows already exist -> no-op.
  - R1.1 bullet 4 (recommended_wave lint) keeps value as a REGRESSION guard, but its cited violation
    does not exist -- all 28 rows are already W{NEXT}.
  - ops/cron/** is NOT paths-ignored -> the C2 commit WILL rebuild + restart prod (stated in commit body).
```

---

## 8. system-map edges touched by C0

**NONE — probe only.** (C1/C2 edges recorded in their chapters, written in C4.)
