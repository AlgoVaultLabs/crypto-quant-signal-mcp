# KERNEL_STALENESS — 2026-10-22 audit (OPS-HOST-KERNEL-REBOOT-W6 CH2)

Kernel versions and hostnames only. Measured read-only on both hosts, 2026-10-22 08:53–08:59Z,
against `origin/main` `e3d722c6`.

## 1. The alert, verbatim (signal-1, received 2026-10-22 before 08:13Z)

```
Host <b>AlgoVault-MCP</b> is running an out-of-date kernel.

running:   6.8.0-142-generic
installed: 6.8.0-147-generic
pending:   8 days

The newer kernel is installed but not running, so every security fix between the two is on disk and
inactive. A local privilege-escalation there also un-bounds the least-privilege work elsewhere in
the stack, which assumes the app cannot become root.

Action: this host IS inside the unattended reboot harness — ops/monitoring/kernel-auto-reboot.sh
is scheduled here hourly and should already have rebooted it. A page from a covered host therefore
means a GATE REFUSED, not that nobody has looked. Read /var/log/algovault-kernel-auto-reboot.log
for the AUTO_REBOOT_GATE line that stopped it and fix THAT cause; a hand-run reboot here would
paper over a harness defect and reset the delta that proves it.

Boot survival is asserted continuously by ops/monitoring/boot-contract-canary.sh, scheduled per
host (signal-1 08:09 UTC, aoe-1 08:37 UTC), which checks this box against the declared contract.
scripts/check-boot-readiness.mjs is the BUILD-TIME gate: it proves the contract is internally
coherent and never that a host matches it.

recommended_wave: OPS-HOST-KERNEL-REBOOT-W6
```

`AlgoVault-MCP` is the hostname of **signal-1**. The page never says so.

## 2. Hypotheses, and the survivor

The question: why had signal-1 not rebooted since its BREACH (2026-10-21T06:09:04Z)?

| H | Signature looked for | Result |
|---|---|---|
| H1 registry / population lag | `in_flight DEFERRED live population has unclassified job(s)` | **SURVIVED.** 13 of 14 in-window runs. Two signal-1 crontab lines had no REBOOT row on any ref: `verdict-rule-gate.py` and `directional-labels-race-integrity.py`. The lag-mechanism premise was false; the fix was to classify the two jobs (CH1) |
| H2 in-flight collision / hung job | the same no-safe-kill row aborting every run | refuted: no ABORT in the window |
| H3 peer coupling | `peer_busy` / `arm` DEFERRED | refuted as a cause: 1 run, aoe-1's own legitimate cycle (REBOOTED 07:07:03Z, `post_boot PASS`); the arm path pre-flights OK |
| H4 harness not deciding | records missing, or blocks ending before `finish` | refuted: one record per hour; installed sha = inventory on both hosts |
| H5 measurement artifact | already on `-147`, or `-147` not bootable | refuted: running `-142`; `-147` is `install ok installed`, with vmlinuz and initrd present |
| H6 another gate | `contract` ABORT, or a false `deploy_in_flight` | refuted: contract OK, no deploy signature live |

The page itself was a second, independent defect, found while answering the question above. That
defect is what this chapter fixes.

## 3. Probes — claim / reality / resolution

| Claim | Reality | Resolution |
|---|---|---|
| a covered host's page "means a GATE REFUSED" | signal-1 `FIRED` 10-21T06:16:02Z and 10-22T07:16:02Z: each sent by the harness's `:16` run from its `due` gate, before any later gate ran | the page is sent by the cron path only, and projects the record |
| aoe-1's page reported a refusal | `FIRED` 10-21T07:07:01Z ("pending: 7 days"); the SAME run issued `/sbin/reboot` at 07:07:03Z and `post_boot` passed (-142 → -147) | the harness's call to the canary is `--decide`, which never pages |
| the canary's own daily cron pages a stale covered host | every `23 7` / `37 7` run in the window logged `SUPPRESSED_COOLDOWN`: the harness had already spent the 24 h cooldown | the cron is now hourly and is the only paging path |
| "this log names the gate" (harness header :61-62) | the log is host-only; the record carried `decided_by` and no gate line, streak or installed kernel | the record carries `detail`, `streak_count`, `streak_since`, `kernel_installed`, `staleness` |
| the page names the host | it named `hostname -s`, which appears in no inventory, ssh config or cloud label | the estate label chain, with the hostname beside it |
| `staleness_verdict()` reads the decision | an unanchored `grep -oE 'VERDICT=(…)'` would accept any `*_VERDICT=` token | an anchored `^KERNEL_STALENESS_DECISION=` line |
| the suites would have caught it | on `e3d722c6` all four passed. The harness self-test replaces the canary with an `echo` stub, so the real canary paging from inside `due` sat behind the seam | `tests/unit/kernel-staleness-canary.test.ts` runs the REAL pair |

## 4. Bug class, and the three priors in this one body

**A page that states what ANOTHER producer did, derived from that producer's schedule or a
constant instead of its record, will mis-route.** It fires before the decision exists, it cannot
name the decision, and it cannot tell "refused" from "never ran".

| # | Wave | What the body claimed about another producer |
|---|---|---|
| 1 | OPS-HOST-KERNEL-REBOOT-W3 | "boot survival is asserted continuously by check-boot-readiness.mjs" — no scheduled run existed |
| 2 | OPS-HOST-KERNEL-REBOOT-W4 | a constant Action told the operator to hand-reboot a host that reboots itself |
| 3 | OPS-HOST-AUTO-REBOOT-SIGNAL1-PROMOTE-W1 | a basename match read a dry-run soak as coverage |
| 4 | **this** | "a GATE REFUSED", from crontab text, sent from inside the harness before any gate decided |

Each fix moved the derivation one step closer to reality: constant → crontab → crontab `--apply`.
This one moves it to the record.

## 5. The fix — rank 2, and why nothing higher

**Rank 2: single derivation.** The harness's record IS the decision, the page projects it, and the
harness consumes a verdict that has no side effects.

- **`--decide`** prints ONE line:
  `KERNEL_STALENESS_DECISION=<V> running=<r> installed=<i> age_days=<n> breach_at=<epoch|none>`.
  It writes no log, sends no page and reads no crontab. The harness matches it anchored; a foreign
  `FOO_VERDICT=` or the pre-W6 log line is INDETERMINATE.
- **The record** carries `detail` (the deciding gate's own `AUTO_REBOOT_GATE=` line, ≤400 chars),
  `kernel_installed`, `staleness`, `streak_count` and `streak_since`.
- **Coverage** is read from the harness's newest record for this host. The canary locates it with
  `canary_result_log.py --show-path` and bounds it with `decision_record {canary, max_age_s}` on the
  KERNEL_STALENESS registry row:

  | State | Meaning | Page |
  |---|---|---|
  | UNKNOWN | crontab unreadable | yes — establish coverage by hand |
  | UNCOVERED | no active `--apply` line | yes — the hand-run procedure |
  | COVERED_SILENT | no record, or the newest is older than `max_age_s` (7200 s) | yes — the harness is dead, or dies before deciding |
  | COVERED_UNDECIDED | newest record predates `breach_at`; or NOT_DUE by `window`; or the FIRST `peer_busy` deferral | **no** — a REPORT log line |
  | COVERED_REFUSING | anything else after `breach_at` | yes — quotes the gate, its line and the streak |

  The two "waiting" cases of UNDECIDED go beyond the spec's literal R2.4: the harness waiting by its
  own design is not a refusal. On 10-21 both hosts crossed BREACH together, and that day's one
  `peer_busy` deferral was aoe-1's own legitimate cycle.
- **Cadence:** the canary's cron is now hourly on both hosts (`23 *` / `37 *`). The 24 h wrapper
  cooldown keeps it at one page per day per host.

**Rank 5 on top:** `scripts/check-alert-copy-claims.mjs` makes `decision_record` MANDATORY on every
`related_automation` entry, and requires its canary to equal the artifact's own `RESULT_CANARY=`.
Missing, malformed or mismatched is INDETERMINATE.

**Why not rank 1.** Rank 1 would make cross-producer claims unrepresentable across the estate. That
needs a record-templating layer over ~100 heredoc alert bodies; only one alert row declares
`related_automation` today. So the gate is a forward guard, and the other bodies are untouched.

## 6. Dependency envelope

| Artifact | Change | Consumer updated in the same commit |
|---|---|---|
| `ops/monitoring/kernel-staleness-canary.sh` | `--decide`, coverage from the record, label chain, seams | harness (`--decide`), vitest, inventory sha |
| `ops/monitoring/kernel-auto-reboot.sh` | anchored `--decide` parse, richer record, streak | canary (reads the record), vitest, inventory sha |
| `ops/monitoring/alert-registry.json` | `decision_record` on KERNEL_STALENESS | canary (on the host, via declaration-sync), copy-claims gate |
| `scripts/check-alert-copy-claims.mjs` | `decision_record` mandatory and matched | its self-test, `tests/unit/alert-copy-claims.test.ts` |
| `ops/monitoring/monitoring-inventory.json` / `ops/scripts/cron-interlock-registry.json` | hourly cadence, sha re-stamps | the host crontabs (one line each) |

## 7. Inheritors

1. Every future kernel cycle on both hosts: a refusal pages with its gate, line and streak, with no
   SSH needed.
2. Every healthy cycle: the false "a GATE REFUSED" page at the first BREACH observation is gone.
3. A harness that is scheduled but dead: `COVERED_SILENT` instead of a false refusal.
4. A crontab line installed with no REBOOT row: the deferring gate's own line, which names that
   line, now reaches the page.
5. The next alert row that declares `related_automation`: the copy gate demands its
   `decision_record`.

## 8. Tokens

| Token | Producer | Values |
|---|---|---|
| `KERNEL_STALENESS_DECISION=` | `kernel-staleness-canary.sh --decide` | OK · REPORT · BREACH · INDETERMINATE |
| `AUTO_REBOOT_COVERAGE=` | `kernel-staleness-canary.sh --print-coverage` | UNKNOWN · UNCOVERED · COVERED_SILENT · COVERED_UNDECIDED · COVERED_REFUSING |
| `VERDICT=` (cron log) | `kernel-staleness-canary.sh` live path | unchanged; `check-boot-readiness.mjs` reads it |
| `AUTO_REBOOT_VERDICT=` | `kernel-auto-reboot.sh` | unchanged |
| `SELF_TEST_VERDICT=` | both scripts | canary floor 70 (73 run); harness floor 125 |
| `ALERT_COPY_VERDICT=` | `check-alert-copy-claims.mjs` | OK · DRIFT · INDETERMINATE (0/1/3); self-test floor 50 |

## 9. Proof

- `tests/unit/kernel-staleness-canary.test.ts` runs the REAL harness and canary through the REAL
  `canary_result_log.py`, stubbing only the OS, the wrapper and the destructive primitives.
  - **Pre-fix bytes** (`e3d722c6`, pinned as `tests/fixtures/*.pre-w6.sh.txt` by their live sha256,
    because CI checks out shallow): a page is sent from inside `due` saying "a GATE REFUSED", and
    the run still reboots.
  - **Post-fix**: 0 pages, and `REBOOTED` is still issued.
  - A second consecutive deferral by the same gate yields one page quoting the harness.
- Deliberate breaks, each red in its self-test AND that vitest, each restored byte-identical:
  - (a) `--decide` calls `fire()`;
  - (b) `detail` is dropped from the record;
  - (c) COVERED is derived from crontab text only;
  - (d) the parse is unanchored.
