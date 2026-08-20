/**
 * quota-surfaces.ts — OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH1. The registry of every surface
 * that may emit a quota fact, and the criterion each one is judged against.
 *
 * THE CLASS THIS RETIRES. Across eight waves this arc fixed the SAME defect eleven times: a
 * surface emits a quota fact while assuming the monthly meter. `bindingMeter()` (CH1 of
 * OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1) made the derivation SINGLE. It never made it
 * MANDATORY — measured at `cf9cbb5`, the identifier `bindingMeter` appears in `src/` and
 * `tests/` and in NO gate, manifest, canary or CI script anywhere in the repo. Nothing failed a
 * build when a surface emitted a quota fact without going through it, which is why instances 9,
 * 10 and 11 were found by reading PRODUCTION OUTPUT rather than by CI.
 *
 * CLAUDE.md: "Fix at the generator, not the lane. After the 3rd same-class fix the 4th MUST build
 * a gate making the bug class structurally impossible." This registry plus
 * `scripts/check-quota-surface-conformance.mjs` is that gate.
 *
 * WHY A REGISTRY AND NOT A SCAN ALONE. Two failure modes, and a source scan sees only the first:
 *   STRUCTURAL — a surface emits a quota fact without routing through the single derivation.
 *                Caught by the checker's orphan scan (check B): a call site no row covers FAILS.
 *   INERT      — the surface routes correctly but its INPUT is `undefined` at run time, so the
 *                field ships absent with a green suite. That is the R3 defect verbatim
 *                (`withQuotaState(..., { dailyUsed: (charged ?? quota).daily_used })` where
 *                `trackCall` returned no daily pair). Caught by the rendered-output assertion
 *                (check A) in `tests/unit/quota-surface-conformance.test.ts`, which drives the
 *                REAL exported tool path on a daily-walled caller — never a hand-built mirror of
 *                the throw site, because a mirror embeds the very bug it is meant to catch.
 *
 * WHAT THIS GATE CANNOT SEE, stated so nobody claims otherwise: a database column that failed to
 * materialise is invisible to both checks. The post-deploy live capture from a disposable bucket
 * remains a standing requirement.
 *
 * LEAF. This module imports TYPES ONLY, for the same load-bearing reason `binding-meter.ts`
 * documents: `license.ts` and `tier-warning.ts` are CONSUMERS of the modules named in these rows,
 * so a value import would close a cycle. Leafness is asserted against this file's own import list
 * by the conformance suite, so the property is checked rather than remembered.
 */
import type { QuotaWall } from '../types.js';

/**
 * THE CONFORMANCE CRITERION (ratified 2026-08-16, Q2).
 *
 * Stated here rather than in a wave document because a criterion that lives only in prose is what
 * lets the next reader widen it. Note carefully what it does NOT say: it does not say "every field
 * must be the binding meter's". `_algovault.quota.resets_at` is the MONTHLY meter's own reset,
 * sitting beside `quota.daily.resets_at` and a `binding` label naming which one governs — nothing
 * it emits is false, so it CONFORMS. Instances 9-12 are different in kind: a payload asserting the
 * wrong horizon for the wall that ACTUALLY refused.
 */
export const CONFORMANCE_CRITERION =
  'A surface CONFORMS when every fact it emits is true of the meter it names ' +
  'AND the binding meter is identified.';

/**
 * THE TWO WORKED READINGS — kept beside the rule because a criterion is only worth having if it
 * can be shown to REJECT something, and these two look superficially alike.
 *
 * ADMITTED — `_algovault.quota` (`tier-warning.ts`, Q2). A COMPOSITE: each sub-object belongs to
 * exactly one meter (`quota.used`/`total`/`remaining`/`resets_at` are all the MONTHLY meter's;
 * `quota.daily.*` are all the DAILY meter's) and `quota.binding` names which governs. Every fact is
 * true of the meter it names. CONFORMS.
 *   Residual, recorded rather than fixed: a naive consumer reading `resets_at` and ignoring
 *   `binding` still sees ~30 days. Real — but the alternative moves a live payload field and voids
 *   the predecessor wave's PROVEN byte-identity guarantee on those four keys. WIS, not a payload change.
 *
 * REJECTED — `scan_trade_calls`' refusal `quota` block (Q6, instance 13). One FLAT object holding
 * two meters' facts plus a false one: `used`/`total` are the MONTHLY pair, `resets_at` is the DAILY
 * instant mixed in beside them, and `remaining: 0` is FALSE of the pair it sits next to — that
 * caller still has monthly headroom. Nothing names which meter governs. VIOLATION.
 *   Note precisely why "remaining: 0 means refused, not monthly-remaining" does not rescue it:
 *   `remaining` means "remaining on THIS pair" everywhere else in the family
 *   (`_algovault.quota.remaining`, `quota.daily.remaining`). One name, two meanings, is the
 *   single-derivation violation this whole arc exists to retire.
 */
//
// Deliberately PROSE, not an exported constant. The first draft exported a
// `CRITERION_WORKED_EXAMPLES` object and `check-new-dark-exports.mjs` flagged it with zero consumers
// in src/ — correctly. Explaining it away in ops/dark-exports-config.json would have used the
// explained-entry mechanism to launder the exact "exported, tested, called by nothing" shape that
// mechanism exists to make visible. The two readings are documentation; a docblock carries them, and
// the rows below reference the surfaces by id, which was the only load-bearing link.

/**
 * The declared corpus boundary (ratified 2026-08-16, Q3).
 *
 * CALLER-FACING API/MCP PAYLOAD SURFACES. A corpus that also swept email, Telegram and the
 * dashboard could never go green and would be abandoned — and a gate expected to be red is a gate
 * nobody reads. Surfaces outside the boundary are recorded as `excluded` rows with a reason, never
 * dropped in silence.
 */
export const CORPUS_BOUNDARY = 'caller-facing API/MCP payload surfaces';

/**
 * The emitting primitives the orphan scan triggers on.
 *
 * DERIVED AT STEP 0 FROM REAL CALL SITES, never from a spec's list — the dispatching spec named
 * eleven instances and called that "a floor, not a ceiling", and the derived scan immediately
 * found a twelfth (`webhook-api.ts`) that no wave document mentions.
 *
 * `key:*` entries trigger on literal key CONSTRUCTION in an object literal. The checker
 * discriminates construction from TYPE DECLARATION structurally (`resets_at: string;` in
 * `types.ts` declares the contract, it does not emit), and discriminates a caller's quota block
 * from `feature-registry.ts`'s `quota: { unit, holdFree }` pricing descriptor by requiring the
 * object to name `used`. Both discriminations are proven by fixtures in `--self-test`, because a
 * structural rule nobody exercises is a structural rule that silently stops holding.
 */
export const QUOTA_PRIMITIVES = [
  'new TierLimitReachedError',
  'buildTierLimitPayload',
  'quotaNoticeFacts',
  'buildQuotaNoticeMessage',
  'withQuotaState',
  'bindingMeter',
  'monthResetAtMs',
  'utcDayResetAtMs',
  'buildSuggestedX402',
  'key:resets_at',
  'key:retry_after_days',
  'key:retry_after_hours',
  'key:quota',
] as const;

export type QuotaPrimitive = (typeof QUOTA_PRIMITIVES)[number];

/**
 * `conforming`          — meets `CONFORMANCE_CRITERION`.
 * `violation`           — emits a fact untrue of the meter that refused. The checker FAILS on these.
 * `exempt-monthly-only` — genuinely single-metered, so "monthly" is not an assumption but a fact.
 *                         A DECLARED exemption carrying a reason, never a silent omission.
 * `deferred`            — a real violation whose fix is owned by a NAMED wave because closing it
 *                         here would blow scope. Reported loudly on every run, and does NOT fail
 *                         the build: this gate is wired into `prepublishOnly`, so a permanently-red
 *                         verdict would block every publish — warn-mode by another name.
 * `excluded`            — outside `CORPUS_BOUNDARY`. Recorded so the boundary is a decision.
 */
export type QuotaSurfaceStatus =
  | 'conforming'
  | 'violation'
  | 'exempt-monthly-only'
  | 'deferred'
  | 'excluded';

export interface QuotaSurface {
  /** Stable id. Check A's renderer map is keyed on this, so a row with no renderer FAILS. */
  id: string;
  /** Repo-relative owning module. Check B's coverage key is (module, primitive). */
  module: string;
  /** Which primitives this surface is permitted to invoke. A call site outside any row's set fails. */
  primitives: readonly QuotaPrimitive[];
  /** The caller-visible fields this surface puts on the wire. */
  emits: readonly string[];
  status: QuotaSurfaceStatus;
  /**
   * Does this surface project its horizon/noun from the wall that actually refused?
   * `null` for rows that emit no horizon at all (the derivation and horizon primitives).
   */
  meterAware: boolean | null;
  /**
   * Fields that MUST be present and NOT `undefined` when this surface renders for a DAILY-binding
   * caller. Empty for rows check A does not drive. `undefined` and absent must BOTH fail — that is
   * the exact shape of the R3 inert defect, where the field was wired and the value was not.
   */
  dailyRequiredFields: readonly string[];
  /**
   * Fields whose VALUE must equal the DAILY reset instant when the daily meter binds. Presence and
   * correctness are different defects — instance 9's fields are all PRESENT and its horizon is
   * wrong, while instance 10's horizon is fine and its fields are ABSENT. A single list could not
   * express both, and collapsing them is how a gate ends up asserting the wrong thing about half
   * its rows.
   */
  wallDerivedFields?: readonly string[];
  /** Copy that must NOT appear on a daily wall (the x402 noun). `pattern` is a RegExp source. */
  dailyForbiddenPattern?: { field: string; pattern: string };
  /** REQUIRED on every non-`conforming` row. The checker refuses a config that omits it. */
  reason?: string;
  /** The wave that owes the fix. REQUIRED on `violation` and `deferred`. */
  ownerWave?: string;
  /**
   * REQUIRED on `deferred` (Q5-green, ratified 2026-08-16). The STRUCTURAL blocker that makes the
   * fix out of scope here, expressed as a probe the checker can re-run every time.
   *
   * This is what makes a deferral SELF-EXPIRING rather than warn-mode wearing a reason string. The
   * checker asserts `absentPattern` is still ABSENT from `symbol`'s body; the moment the blocker is
   * lifted the pattern appears, the excuse is void, and the gate turns RED. "A conditional approval
   * is a gate, not a preference" — so the condition is machine-checked, not remembered.
   */
  deferredBlocker?: { file: string; symbol: string; absentPattern: string; description: string };
  /**
   * REQUIRED on `deferred`. The field set this surface emits TODAY, sorted.
   *
   * A deferral is permission to leave a KNOWN shape unfixed — never permission for that shape to
   * drift. If the row's `quota` block gains or loses a key, the fingerprint moves and the gate
   * FAILS, forcing the deferral to be re-ratified against what the surface now actually emits.
   */
  emittedFingerprint?: readonly string[];
}

/**
 * The wall discriminator has THREE existing spellings across four sites, and this registry renames
 * none of them — a fourth spelling would be a second derivation of the thing this arc exists to
 * derive once:
 *
 *   TrackCallResult.limit      'daily'|'monthly'|null   src/lib/license.ts     — meter layer
 *   QuotaNoticeContext.wall    QuotaWall                src/lib/quota-notice.ts — notice ctx + ctor arg
 *   TierLimitPayload.limit     'daily'|'monthly'        src/lib/errors.ts      — wire payload
 *   _algovault.quota.binding   QuotaWall                src/lib/tier-warning.ts — success envelope
 *
 * `QuotaWall` is defined in `quota-notice.ts` and re-exported by `types.ts`; this module imports it
 * from `types.js` to match `binding-meter.ts`, the leaf it is modelled on. `import type` erases at
 * compile time, so neither path can form a cycle.
 */
export type QuotaSurfaceWall = QuotaWall;

export const QUOTA_SURFACES: readonly QuotaSurface[] = [
  // ── The single derivation and the two horizon primitives ────────────────────────────────────
  {
    id: 'derivation:binding-meter',
    module: 'src/lib/binding-meter.ts',
    primitives: ['bindingMeter'],
    emits: [],
    status: 'conforming',
    meterAware: null,
    dailyRequiredFields: [],
  },
  {
    id: 'horizon:utc-day',
    module: 'src/lib/utc-day.ts',
    primitives: ['utcDayResetAtMs'],
    emits: [],
    status: 'conforming',
    meterAware: null,
    dailyRequiredFields: [],
  },

  // ── Shared renderers: they already project from the wall they are handed ────────────────────
  {
    id: 'notice:quota-notice',
    module: 'src/lib/quota-notice.ts',
    primitives: ['quotaNoticeFacts', 'buildQuotaNoticeMessage', 'key:resets_at', 'key:retry_after_days', 'key:retry_after_hours'],
    emits: ['usage_display', 'resets_at', 'retry_after_days', 'retry_after_hours', 'limit', 'recommended_path'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: [],
  },
  {
    id: 'payload:tier-limit',
    module: 'src/lib/errors.ts',
    primitives: ['buildTierLimitPayload', 'quotaNoticeFacts', 'buildQuotaNoticeMessage', 'key:resets_at', 'key:retry_after_days', 'key:retry_after_hours'],
    emits: ['limit', 'resets_at', 'retry_after_days', 'retry_after_hours', 'daily_used', 'daily_limit'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: [],
  },
  {
    id: 'warning:tier-warning',
    module: 'src/lib/tier-warning.ts',
    primitives: ['withQuotaState', 'bindingMeter', 'buildSuggestedX402', 'key:resets_at', 'key:quota'],
    emits: ['quota.used', 'quota.total', 'quota.remaining', 'quota.resets_at', 'quota.daily', 'quota.binding'],
    status: 'conforming',
    meterAware: true,
    // Q2: the top-level `resets_at` is the MONTHLY meter's own reset and is TRUE of the meter it
    // names, with `daily` and `binding` beside it. Conforming, not instance 12.
    dailyRequiredFields: ['quota.daily', 'quota.binding', 'quota.daily.resets_at'],
  },
  {
    id: 'hint:upgrade-soft-nudge',
    module: 'src/lib/license.ts',
    primitives: ['bindingMeter', 'monthResetAtMs'],
    emits: ['upgrade_hint'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: [],
  },
  {
    id: 'serializer:tier-limit',
    module: 'src/index.ts',
    primitives: ['buildTierLimitPayload', 'buildSuggestedX402'],
    emits: ['suggested_x402'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: [],
  },

  // ── INSTANCE 13 — the scanner REFUSAL envelope's nested quota block ─────────────────────────
  //
  // This surface is the in-tree PRECEDENT for the instance-9 fix: its top-level horizon is
  // `resetAtMs: isDailyWall ? utcDayResetAtMs() : monthResetAtMs(license)`, which is exactly the
  // shape the four instance-9 sites must copy. That much is right, and it is why the dispatching
  // spec cites it approvingly.
  //
  // Its NESTED `quota:` block is not. `entry = checkQuota(license)`, so `entry.used`/`entry.total`
  // are the MONTHLY pair — and on a daily wall the block ships them beside `remaining: 0` and a
  // DAILY `resets_at`, naming no meter at all. `remaining: 0` is FALSE of the monthly meter the
  // pair names: that caller still has monthly headroom. Found by this gate's own detector, not by
  // any wave document — the second such finding after instance 12, and the reason the spec's
  // eleven were called a floor.
  {
    id: 'refusal:scan_trade_calls',
    module: 'src/tools/scan-trade-calls.ts',
    primitives: ['quotaNoticeFacts', 'buildQuotaNoticeMessage', 'monthResetAtMs', 'utcDayResetAtMs', 'buildSuggestedX402', 'key:resets_at', 'key:retry_after_days', 'key:quota', 'key:retry_after_hours'],
    emits: ['limit', 'retry_after_hours', 'resets_at', 'retry_after_days', 'usage_display', 'recommended_path', 'quota.used', 'quota.total', 'quota.remaining', 'quota.resets_at'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: ['limit', 'retry_after_hours', 'resets_at', 'retry_after_days', 'quota.binding'],
    wallDerivedFields: ['resets_at'],
    reason: 'Instance 13 (Q6) — FIXED. The refusal `quota` block is now a COMPOSITE matching `_algovault.quota`: one meter per sub-object, `remaining` true of the pair it sits beside, `binding` naming the governing wall.'
  },

  // ── INSTANCE 9 — the refusal path: correct discriminator, unconditional monthly horizon ─────
  {
    id: 'refusal:get_trade_call',
    module: 'src/tools/get-trade-call.ts',
    primitives: ['new TierLimitReachedError', 'withQuotaState', 'monthResetAtMs', 'utcDayResetAtMs'],
    emits: ['limit', 'resets_at', 'retry_after_days', 'retry_after_hours', 'daily_used', 'daily_limit'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: ['limit', 'resets_at', 'retry_after_hours', 'daily_used', 'daily_limit'],
    wallDerivedFields: ['resets_at'],
    reason: 'Instance 9 — FIXED (OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2). `isDailyWall` is read ONCE and drives both the `wall` noun and `resetAtMs`.'
  },
  {
    id: 'refusal:get_market_regime',
    module: 'src/tools/get-market-regime.ts',
    primitives: ['new TierLimitReachedError', 'withQuotaState', 'monthResetAtMs', 'utcDayResetAtMs'],
    emits: ['limit', 'resets_at', 'retry_after_days', 'retry_after_hours', 'daily_used', 'daily_limit'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: ['limit', 'resets_at', 'retry_after_hours', 'daily_used', 'daily_limit'],
    wallDerivedFields: ['resets_at'],
    reason: 'Instance 9 — FIXED. Same single-discriminator shape as get_trade_call.'
  },
  {
    id: 'refusal:scan_funding_arb',
    module: 'src/tools/scan-funding-arb.ts',
    primitives: ['new TierLimitReachedError', 'withQuotaState', 'monthResetAtMs', 'utcDayResetAtMs'],
    emits: ['limit', 'resets_at', 'retry_after_days', 'retry_after_hours', 'daily_used', 'daily_limit'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: ['limit', 'resets_at', 'retry_after_hours', 'daily_used', 'daily_limit'],
    wallDerivedFields: ['resets_at'],
    reason: 'Instance 9 — FIXED. Same single-discriminator shape as get_trade_call.'
  },
  {
    id: 'refusal:equity-tools',
    module: 'src/lib/equities/equity-tool-formatters.ts',
    primitives: ['new TierLimitReachedError', 'monthResetAtMs', 'utcDayResetAtMs'],
    emits: ['limit', 'resets_at', 'retry_after_days', 'retry_after_hours', 'daily_used', 'daily_limit'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: ['limit', 'resets_at', 'retry_after_hours', 'daily_used', 'daily_limit'],
    wallDerivedFields: ['resets_at'],
    reason: 'Instance 9 — FIXED in the shared `tierLimitError()`, so both equity tools inherit it if EQUITY_TOOLS_ENABLED ever flips.'
  },

  // ── INSTANCE 10 — the scanner success envelope ──────────────────────────────────────────────
  {
    id: 'envelope:scan_trade_calls',
    module: 'src/tools/scan-trade-calls.ts',
    primitives: ['monthResetAtMs', 'key:quota', 'key:resets_at', 'bindingMeter'],
    emits: ['quota.used', 'quota.total', 'quota.remaining', 'quota.resets_at'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: ['quota.daily', 'quota.binding', 'quota.daily.resets_at'],
    reason: 'Instance 10 — FIXED. The success envelope now emits the daily pair + `binding`, projected from `bindingMeter()`; `quota` reuses the shared `QuotaState` instead of a hand-copied twin.'
  },

  // ── INSTANCE 11 — the x402 nudge noun ───────────────────────────────────────────────────────
  {
    id: 'nudge:x402',
    module: 'src/lib/x402-nudge.ts',
    primitives: ['buildSuggestedX402'],
    emits: ['suggested_x402.instructions'],
    status: 'conforming',
    meterAware: true,
    dailyRequiredFields: ['suggested_x402.instructions'],
    dailyForbiddenPattern: { field: 'suggested_x402.instructions', pattern: 'monthly' },
    reason: "Instance 11 — FIXED. `buildSuggestedX402` takes a REQUIRED `wall`; the noun projects from `quota-notice.ts`'s own METER_COPY pair. All three call sites supply it from a value they already hold.",
  },

  // ── INSTANCE 12 — found by the DERIVED scan, named by no wave document. DEFERRED, self-expiring ──
  //
  // WHY THIS IS DEFERRED AND INSTANCE 11 WAS NOT (ratified 2026-08-16, Q5). Instance 11's cause was
  // ONE LINE in a file a spec had over-frozen — deferring that would have been an UNBOUNDED known
  // violation whose only blocker was a list saying "frozen", i.e. warn-mode. This one's cause is
  // STRUCTURAL and sits outside any ratified scope: `checkQuotaByKey` returns `limit: null` on the
  // ALLOWED path, so this surface cannot name its wall at all without the daily-pair plumbing that
  // OPS-WEBHOOK-QUOTA-METER-PARITY-W1 owns. Deferring a structurally-blocked row with a named owner
  // differs in KIND from deferring a one-line fix.
  //
  // And the deferral expires by itself: `deferredBlocker` is re-probed on every run, so the moment
  // `checkQuotaByKey` returns a daily pair the excuse is void and this gate turns RED.
  {
    id: 'envelope:webhook-api',
    module: 'src/lib/webhook-api.ts',
    primitives: ['key:quota'],
    emits: ['quota.used', 'quota.total', 'quota.remaining'],
    status: 'deferred',
    meterAware: false,
    dailyRequiredFields: ['quota.used', 'quota.total', 'quota.remaining'],
    reason: 'Instance 12, found by the Step-0 derived scan and named in no wave document — exactly what "the spec\'s eleven are a floor, not a ceiling" predicted. `/api/webhooks` POST and GET emit a 3-key `quota` block with NO `resets_at`, `daily` or `binding`, while `checkQuotaByKey` walls EVERY tier on the daily meter. Structurally blocked here: the surface reads the ALLOWED path, where `checkQuotaByKey` reports `limit: null`, so there is no wall to name and no daily pair to emit. CH2 deletes the false word "monthly" from the adjacent note; the missing FIELDS are the owner wave\'s.',
    ownerWave: 'OPS-WEBHOOK-QUOTA-METER-PARITY-W1',
    deferredBlocker: {
      file: 'src/lib/license.ts',
      symbol: 'checkQuotaByKey',
      absentPattern: 'daily_used',
      description: '`checkQuotaByKey` returns `limit: "daily"` when it refuses but NO `daily_used`/`daily_total` pair on any path, so a caller of the allowed path cannot render a daily meter. When this function starts returning `daily_used`, the blocker is lifted and this row must be fixed, not re-deferred.',
    },
    emittedFingerprint: ['remaining', 'total', 'used'],
  },

  // ── Declared monthly-only exemption ─────────────────────────────────────────────────────────
  {
    id: 'notice:chat-wall',
    module: 'src/lib/chat-rate-limit.ts',
    primitives: ['quotaNoticeFacts', 'buildQuotaNoticeMessage', 'key:resets_at', 'key:retry_after_days'],
    emits: ['message', 'retry_after_days', 'resets_at', 'suggested_action'],
    status: 'exempt-monthly-only',
    meterAware: null,
    dailyRequiredFields: [],
    reason: 'The chat meter is SINGLE — 10/month, no daily pacing cap — so `wall: "monthly"` is a fact about the tier rather than an assumption about the caller. `QuotaWall`\'s own docblock records that `"monthly"` is the only reachable value for `meter: "chat"`. This is a DECLARED exemption; if a daily chat cap is ever added, this row must flip to `violation` in the same wave.',
  },

  // ── Declared exclusion: outside CORPUS_BOUNDARY ─────────────────────────────────────────────
  {
    id: 'email:webhook-quota-paused',
    module: 'src/lib/email.ts',
    primitives: [],
    emits: ['subject', 'body'],
    status: 'excluded',
    meterAware: false,
    dailyRequiredFields: [],
    reason: 'Excluded pending meter plumbing. Outside CORPUS_BOUNDARY (email, not an API/MCP payload) — but the copy IS false on the daily path, measured: `checkQuotaByKey` returns `limit: "daily"` for every tier, `webhook-delivery.ts` fires the notify on `!quota.allowed` REGARDLESS of `quota.limit`, and the owner is then mailed "monthly limit reached … resumes next month". TWO surfaces are wrong on that path, not one — this email and `webhook-delivery.ts`\'s `suggested_action: "owner monthly quota exhausted … until reset"`.',
    ownerWave: 'OPS-WEBHOOK-QUOTA-METER-PARITY-W1',
  },
] as const;
