# REFERRAL-FREE-KEY-SIGNUP-W1 — Plan-Mode Step-0 endpoint-truth

Probed against `origin/main` @ `b4615d6` (the spec pinned `e7f7928`; re-probed per the
"vault lags origin/main" rule). **Zero drift** on this wave's files since `e7f7928`.
Mr.1 ratified Q1–Q6 (universal mint · +500 referral-exclusive · scoped apex proxy ·
disposable+MX validation · /referral form + /account link · copy).

| # | Spec primitive / claim | Reality (re-probed) | Resolution |
|---|---|---|---|
| 1 | `mintFreeKey(email, refCode?)` idempotent, `av_free_` | ✅ `src/lib/free-keys-store.ts`; `mintFreeKey(email)` works with no refCode (no bonus/attribution); `FREE_KEY_PREFIX='av_free_'`, +24 hex | non-referred mint = `mintFreeKey(email)` |
| 2 | signup-email mints only `if (referral.applied)` | ✅ `src/index.ts:2358`; `key` only in the applied branch; non-referred → opt-in + generic email + NO key | lift the gate → always mint |
| 3 | code/link derivation | `ensureUserCode(apiKey, ownerEmail?)` (`referral-store.ts:213`, persists owner) + `shareLink(code)` (`referral-constants.ts:57` → `api.algovault.com/signup?ref=CODE`); `/account` already uses this | inline link = `shareLink(ensureUserCode(key, email))` |
| 4 | `av_free_` keyed quota; keyless preserved | ✅ `license.ts:290` av_free_→`{tier:'free',key}`; **`:285` `if(!key) return {tier:'free',key:null}`** (keyless untouched) | D5 ✓; keyless byte-identical by construction |
| 5 | `signupEmailLimiter` per-IP | ✅ `src/index.ts:2351` `rateLimit({...})` | keep |
| 6 | `/referral` apex POST | ⚠️ `/api/signup-email` is **POST-only, api-only** (apex 404); **CORS allows ONLY `api.algovault.com`** (`index.ts:1081`) → cross-origin POST from apex CORS-blocked | **scoped apex Caddy `handle /api/signup-email`** → form POSTs same-origin relative (Q3) |
| 7 | disposable-email lib (Step-0 picks; confirm maintained) | ⚠️ **`disposable-email-domains@1.0.62` last published 2022-09-28 — STALE (~4y)**; fails "confirm maintained". Maintained alts: `mailchecker@6.0.20` (2026-03-06), `disposable-email-detector@3.0.1` (2026-04) | **SWAP → `mailchecker@6.0.20`** (battle-tested; `isValid(email)`→bool; bundles a fresh disposable list; CJS, untyped → ambient `.d.ts`). Verified: blocks mailinator/guerrillamail/10minutemail; allows gmail/outlook/proton/.io/.co.uk |
| 8 | MX check | Node built-in `dns.promises.resolveMx` (no dep) | reject on confirmed no-MX; **fail-OPEN on transient DNS error** (Q4) |
| 9 | syntax | `EMAIL_RE` imported from `./lib/stripe.js` (`index.ts:45`), used `:2365` | reuse (layer 1) |
| 10 | reuse `sendReferredFreeKeyEmail` | ⚠️ it's **bonus-framed** ("with 500 bonus calls") — wrong for non-referred AND for welcome-paywall (at-limit; key is an account, NOT a quota bump per Q1) | add generic `sendFreeKeyEmail` (account/link-framed, no bonus, no quota-bump implication) |
| 11 | consent gate | ⚠️ `index.ts` requires `optin_consent` (400 if absent) | Q1 → lift the 400; mint+email key for EVERY signup (transactional); record marketing opt-in separately only when checked. Affects ALL callers (welcome-paywall now mints a key too — ratified correct) |
| 12 | entry scope | `/account` "Referrals" tab is a paste-key dead-end for non-keyed users | Q5 → `/referral` reusable form (primary) + a one-line `/account` no-key→`/referral` link |

## Identifier diff
- `{BONUS_CALLS}`→`bonusCallsLabel()`="500"; `{commissionPct()}`="30%"; `{COMMISSION_MONTHS}`→`commissionMonthsLabel()`="12 months" (drop draft's trailing "months"); `{LINK}`→`shareLink(ensureUserCode(key,email))`.
- key prefix `av_free_` ✓; route POST `/api/signup-email` (reuse, + scoped apex proxy) — no new route.
- response: `{key, referral_code, referral_link}` now ALWAYS (was `key` only-if-applied); `{referral_applied, bonus_calls}` only if referred (additive).

## Invariants asserted
- Keyless `get_trade_call` (no key → `free:${ipHash}`) byte-identical (license.ts:285 untouched).
- Homepage `#quickstart` "no signup needed" byte-identical (D3/R4).
- `_algovault` tool envelope unchanged (key/code surfaced via the form/HTTP response, NOT the tool output).
- No `outcome_*` on any new surface.
