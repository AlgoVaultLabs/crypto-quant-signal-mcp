# Comment-stripper consumer registry

**Owner**: `scripts/lib/strip-comments.mjs` (OPS-SYSTEM-MAP-GATE-COMMENT-STRIP-W1)
**Migration follow-up**: `OPS-STRIPCOMMENTS-CONSUMER-MIGRATION-W{NEXT}` — **not this wave.**

## Why this file exists

Detection is strictly weaker than enumeration. "A mention in a comment is not an occurrence" is a
law this repo codified and then re-learned repeatedly, because there was nothing to import — so
every gate author wrote their own stripper and some skipped it entirely. The gate that most needed
one (`scripts/check_system_map.sh`, installed into the **shared** `pre-commit` hook) had none, and
blocked `PAY-RAIL-DASHBOARD-W1` on the comment *"rides the existing 30s load() loop — adds NO
setInterval"*.

Without this registry the next author writes an eighteenth. With it, there is one obvious thing to
import and a list of what still needs migrating.

## Correction to the dispatching count

The wave spec stated **12** implementations in `scripts/` and **8** test-local copies. Measured
2026-08-12 at `origin/main`: **16 files / 17 functions** in `scripts/`, and **9** test-local. The
spec's raw grep over `strip*` names was noisy in both directions — it swept in `stripTags`,
`stripAnsi`, `stripHtml`, `stripTLDRSection` and even `stripeGet` (a Stripe API helper), while
missing four genuine `stripComments` implementations. The registry below is the measured set.

## The four shapes, and why a caller cannot currently tell which it got

| Shape | Behaviour | Consequence for a caller |
|---|---|---|
| `language-aware` | dispatches on file extension | safe across a mixed corpus |
| `whole-line` | blanks or drops a line that *starts* with a comment | misses trailing `code // comment` |
| `character-walker` | scans char by char, string-literal aware | most accurate, most code |
| `regex` | one or more `String.replace` passes | collapses lines ⇒ **loses line offsets** |

The shared module declares **language-aware + offset-preserving** in its docblock precisely because
these disagree, and a gate that reports line numbers cannot use an offset-losing stripper.

## `scripts/` — 16 files, 17 functions

| # | Location | Shape |
|---|---|---|
| 1 | `scripts/check-adapter-numeric-guard.mjs:59` | regex |
| 2 | `scripts/check-alert-recommended-wave.mjs:53` | regex (drops lines — loses offsets) |
| 3 | `scripts/check-canaries-wired.mjs:69` | **language-aware** (a reuse target; its docblock records the YAML/glob bug) |
| 4 | `scripts/check-claim-coverage.mjs:62` | regex (offset-preserving) |
| 5 | `scripts/check-delivery-assertion.mjs:44` | character-walker |
| 6 | `scripts/check-entrypoint-guards.mjs:81` | regex |
| 7 | `scripts/check-hold-billing-claims.mjs:116` | regex |
| 8 | `scripts/check-iphash-keyed.mjs:35` | regex |
| 9 | `scripts/check-jq-truthiness.mjs:58` | whole-line, **offset-preserving** (the other reuse target) |
| 10 | `scripts/check-live-numeric-claims.mjs:126` | regex (HTML flavour) |
| 11 | `scripts/check-mcp-client-copy.mjs:118` | language-aware |
| 12 | `scripts/check-mcp-client-copy.mjs:149` | language-aware (`stripCodeCommentsOnly`, 2nd in the same file) |
| 13 | `scripts/check-new-dark-exports.mjs:51` | regex |
| 14 | `scripts/check-paid-route-validation.mjs:44` | character-walker |
| 15 | `scripts/check-secret-log-redaction.mjs:59` | character-walker |
| 16 | `scripts/check-token-resolution.mjs:112` | regex (arrow const) |
| 17 | `scripts/check-webhook-idempotency.mjs:60` | character-walker — also ships `strippingLostCaseLabels()` at `:94`, the anti-blind-spot guard the shared module ports |

`scripts/check-secret-log-redaction.mjs:57` and `scripts/check-webhook-idempotency.mjs:58` already
name `OPS-SHARED-STRIPCOMMENTS-EXTRACTION` in comments — proposed, never shipped, until now.

## `tests/` — 9 test-local copies

`tests/plans.test.ts` · `tests/unit/capped-collection-guard.test.ts` ·
`tests/unit/design_w11_consistency.test.mjs` · `tests/unit/geo-rates.test.ts` ·
`tests/unit/no-free-hold-promise.test.ts` · `tests/unit/payment-rail-topology.test.ts` ·
`tests/unit/referral-existence-guard.test.ts` · `tests/unit/served-region-check.test.ts` ·
`tests/unit/tool-license-wiring.test.ts`

## Shell-side — a correction worth keeping

The dispatching spec asserted *"no shell-side stripper exists anywhere"*. **That is false.** Shell
comment stripping exists in the exact form CLAUDE.md prescribes — `grep -vE '^[[:space:]]*#'` — at
`scripts/check_test_baseline.sh:890`, `ops/scripts/host-deploy.sh:61`,
`ops/cron/checkout-parity.sh:60,68,74` and `ops/cron/bot-deploy-parity.sh:49`.

The prohibition on a bash-native stripper **stands anyway, on better grounds**: that form is
`#`-only, whole-line, and diff-unaware. It cannot preserve a `+`/`-` prefix column, cannot switch
language per hunk, and cannot see `//`, `/* */` or SQL `--`. It is insufficient here, not merely
unprecedented.

## Migration rules for the follow-up

- **One consumer per commit.** Migrating 16 working gates at once is how you break 16 gates at once.
- Each migration must keep the consumer's tests green **without editing them** — if a test needs
  changing, the semantics differ and that difference is the finding.
- A consumer that relies on line offsets (anything using `grep -n` or reporting positions) must
  move to the shared module first; the offset-losing `regex` shapes are the risky ones.
- `check-webhook-idempotency.mjs:94`'s anti-blind-spot guard is already ported to the shared module
  as `strippingLostRealCalls()`; a migrating consumer should drop its local copy, not keep both.
