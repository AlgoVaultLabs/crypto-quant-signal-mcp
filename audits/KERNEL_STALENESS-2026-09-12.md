# KERNEL_STALENESS — 2026-09-12 — OPS-HOST-KERNEL-REBOOT-W4

## Alert, verbatim

    Host <b>AlgoVault-MCP</b> is running an out-of-date kernel.
    running:   6.8.0-138-generic
    installed: 6.8.0-139-generic
    pending:   7 days
    ...
    Action: schedule a reboot. The procedure is validated end-to-end by OPS-HOST-KERNEL-REBOOT-W1
    (verify Hetzner console access first, rehearse on aoe-1, then signal-1).
    ...
    recommended_wave: OPS-HOST-KERNEL-REBOOT-W{NEXT}

Source: `ops/monitoring/kernel-staleness-canary.sh` `fire()`, verbatim match.
`AlgoVault-MCP` is `hostname` on signal-1 (204.168.185.24); `/etc/algovault-host-label` = `signal-1`.

## Hypotheses

| H | Claim | Probe | Survived |
|---|---|---|---|
| H1 | canary threshold/logic defect | `/var/log/kernel-staleness-canary.log` 09-01→12 | NO — `OK`→`REPORT`x6→`BREACH` at exactly `age_days=7`, as designed |
| H2 | harness failed on this host | `crontab -l` signal-1; `EXPECTED_HOST="aoe-1"` | NO — refusal BY DESIGN, not a defect |
| H3 | harness broken on aoe-1 | `/var/log/algovault-kernel-auto-reboot.log` | NO — aoe-1 rebooted ITSELF 07:07:02Z, 4/4 gates PASS |
| H4 | alert copy stale | `git log` — `b9488a68` never touched the canary | **YES** |
| H5 | measurement artifact (DEFAULT) | `reboot-required=YES`, `uname -r`=138, newest=139 | NO — the exposure is real |

H5 is the mandated default and is FALSIFIED here: the condition was found live, not healed, and the
number is sound. `age_days` is computed from the NEWEST kernel's `.list` mtime, which the canary's own
header records as the one trustworthy case.

## Probes — claim / reality / resolution

1. "boot survival asserted by boot-contract-canary.sh, signal-1 08:09 / aoe-1 08:37" → **TRUE**
   (`crontab -l` both hosts: `9 8 * * *`, `37 8 * * *`). Confirmed.
2. "check-boot-readiness.mjs is BUILD-TIME only" → **TRUE** (`deploy.yml:771-772`). Confirmed.
3. "rehearse on aoe-1, then signal-1" → **SUPERSEDED**. aoe-1 self-reboots on `7 * * * * --apply`.
   OVERRIDDEN — this is the defect.
4. "does the copy gate catch it?" → `node scripts/check-alert-copy-claims.mjs` ⇒ `ALERT_COPY_VERDICT=OK`
   on the tree carrying the live defect. **The gate was blind.**
5. Hetzner console preflight → `hcloud` context `algovault-mcp` lists `AlgoVault-MCP` id `125906315`
   running. Recovery path available: `hcloud server request-console 125906315`.

## Bug Class Statement

> Any reconciliation that runs in ONE direction only — here, alert copy validated citation→reality but
> never reality→citation — goes silently stale the moment the world gains a component the copy never
> named.

Priors by ROOT CAUSE ("alert copy asserts a world that moved"), grepped over `status.md`,
`Old Status/*.md` and `audits/`:

1. `OPS-HOST-KERNEL-REBOOT-W2` (2026-08-14) — body claimed a continuous boot-survival assertion by a
   build-time-only gate. W2 fixed the script HEADER and left the ALERT BODY.
2. `OPS-HOST-KERNEL-REBOOT-W3` CH3 (2026-08-28, `352ceb4c`) — rewrote the body and shipped
   `scripts/check-alert-copy-claims.mjs`.
3. **This** — the Action paragraph, structurally invisible to that gate.

Third instance, and a gate already existed. Structural, not a lane fix.

## What the gate's corpus could not contain

Direction 1's rule is: a CONTINUITY_VERB in the same sentence as a cited repo path whose reality is not
SCHEDULED ⇒ DRIFT. `PATH_RE` matches only `scripts/|ops/…` paths. The stale sentence cites **no repo
path** — only a wave id and a prose procedure — so it was outside the corpus entirely. The gate
validated citations against reality and had no reality-against-citations leg.

`scripts/data/boot-critical-units.json` already states the general law for containers:
*"a one-way acknowledged list becomes a stale copy of a world that moved"*, which is why
`boot-contract-canary.sh` reports `acknowledged_but_absent`. This is that law in a second substrate.

## Why the stale copy was HARMFUL, not cosmetic

"rehearse on aoe-1" instructs a hand reboot of aoe-1. A hand reboot resets the running-vs-installed
delta — the one fact only a real reboot resets — so `kernel-auto-reboot.sh` gate 2 returns `NOT_DUE`
and an unattended cycle never happens. The ratified promotion condition for signal-1 (recorded in
`kernel-auto-reboot.sh`'s header) is TWO clean unattended aoe-1 cycles plus a live peer watchdog.
**The alert instructed the operator to destroy the evidence that would retire the alert.**

## Generator fix — rank 5, both-directions reconciliation

| Rank | Considered | Outcome |
|---|---|---|
| 1 | make the prose unrepresentable | unreachable — prose |
| 2 | derive the Action from `EXPECTED_HOST` | **REFUSED by name** in `kernel-auto-reboot.sh`'s header: "a configurable firewall is not a firewall". Reading the constant would make a second copy of a firewall |
| 5 | declared `related_automation[]` + direction 2 in the copy gate | **SHIPPED** |

Also shipped, and it is a rank-2 *derivation* rather than a second firewall: `decide_action()` in the
canary derives its Action paragraph from `auto_reboot_coverage()`, which reads THIS host's crontab —
consuming the live schedule, never re-deriving `EXPECTED_HOST`. Three branches
(COVERED / UNCOVERED / UNKNOWN); UNKNOWN is a real third state because a crontab that cannot be read is
not evidence of absence.

**HONEST SCOPE.** Direction 2 is an ALLOW-LIST. It polices DECLARED relationships only; automation
nobody declares is invisible to it. That gap fails toward NOISE, not silence: every run prints the
declared/undeclared split (`1/83 declare … 82 declare none`), so an empty declaration set can never
read as a clean one. A declaration missing its mandatory `reason` is INDETERMINATE, never a pass.

## Dependency envelope

**BACKWARD — what had to already be true:**

| Item | State |
|---|---|
| `alert-registry.json` is the SoT for alert_id → owner/hosts | MET (`b9488a68` extended it) |
| `monitoring-inventory.json` `installed_at[].schedule` is the SoT for "scheduled" | MET |
| `check-canaries-wired.mjs` is the ONE authority on "wired" | MET — already imported, not re-derived |
| the boot contract is coherent on signal-1 before any reboot | MET — `BOOT_CONTRACT_VERDICT=OK` |

**FORWARD — every consumer, ENUMERATED not detected:**

| Consumer | Handling |
|---|---|
| `kernel-staleness-canary.sh` installed on BOTH hosts | re-install required; HASH_DRIFT would page otherwise |
| `monitoring-inventory.json` sha256 for the canary | updated same commit |
| `monitoring-inventory.json` sha256 for `alert-registry.json` | updated same commit (it carries its own row) |
| `audits/alert-copy-baseline.json` ratchet | unchanged — `UNCITED` keys use the same `<file>::<cited>::<reality>` shape |
| `tests/unit/alert-copy-claims.test.ts` | updated same commit (+123 lines) |
| `deploy.yml` + `prepublishOnly` (`&&` chain) | unchanged — exit 1 and 3 both still break it |
| `check-alert-registry.mjs`, `check-canaries-wired.mjs`, `check-alert-recommended-wave.mjs` | re-run, all PASS |
| `system-map.md` registry row | edited same commit; `Last touched:` overwritten in place |

**UNREACHABLE / NOT COVERED:** the `monitoring/aoe-host/` vendored copy in the autonomous-optimizer
repo is a separate consumer registry and was not touched by this wave.

## Inheritors

1. Any future automation that supersedes part of a manual runbook named in another alert's body.
2. Alerts whose bodies name hand-run recovery the automation-first-recovery law is progressively
   automating (`WEBHOOK_*`, `REVENUE_METER_*`, `BOOK_LIVENESS`).
3. Every future aoe-1 → signal-1 promotion: host-scoped coverage with a hardcoded-host firewall is a
   recurring shape, and the body must always say which hosts it covers.
4. The registry's `adopted:false` rows — each is a body a future `OPS-ALERT-ADOPT-*` wave will rewrite,
   and each is an opportunity to reintroduce the same one-way drift.

## Proof

| Check | Result | Evidence |
|---|---|---|
| pre-fix body ⇒ DRIFT | PASS | `origin/main` canary verbatim ⇒ `ALERT_COPY_VERDICT=DRIFT`, exit 1, correct UNCITED message |
| post-fix body ⇒ OK | PASS | `ALERT_COPY_VERDICT=OK`, exit 0 |
| gate self-test | PASS | 45 assertions (13 new, fixture-tree driven) |
| gate self-test CAN fail | PASS | break 1 (drop mandatory `reason`) ⇒ FAIL; break 2 (no-op direction 2) ⇒ 3 failures |
| canary self-test | PASS | 20 assertions, floor 20 |
| canary self-test CAN fail | PASS | stripping the citation from ONE branch ⇒ `SELF_TEST_VERDICT=FAIL`, exit 1 |
| vitest | PASS | 30/30 in `alert-copy-claims.test.ts` |
| hash parity canary | PASS | 12/12 `monitoring-primitive-parity.test.mjs` |

A first draft of the reproduction FAILED to fail: reverting only the interpolation left
`decide_action`'s heredocs in the file, and `operatorFacingBlocks` extracts every heredoc in a `.sh`,
so the citation was still present and the gate correctly said OK. The honest reproduction restores the
whole `origin/main` file. Recorded because a vacuous reproduction reads exactly like a real one.
