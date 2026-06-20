# TG-REFERRAL-W1 — Step-0 Endpoint-Truth (Plan-Mode)

Probed on `origin/main` of both repos, 2026-06-20. **0 fictional primitives.**
Cross-repo wave: C1 = signal-MCP (engine machine API + TG identity lane); C2/C3 = algovault-bot (`/referral` surface + deep-link + share + referee bonus + compounding loop).

| Probe | Reality (verified) | Resolution |
|---|---|---|
| Both repos clean | signal-MCP `origin/main 0c404bf` (REFERRAL-LIGHT-W1 engine live); bot `origin/main 96eabea`; prod bot == branch `feat/tg-watch-adoption-broadcast-w1 (f0115fe)` byte-for-byte (clean FF descendant of origin/main) | C1 → worktree `feat/tg-referral-w1` off signal-MCP origin/main; bot work rebases A5 onto `f0115fe` (the live base), builds C2/C3 on that lineage |
| Machine referral API | **NONE** — only HTML `/account/referrals`, `/referral-terms`, `/admin/referrals*` | C1 adds `GET /api/referral/code` + `POST /api/referral/attribute` (JSON, internal-key auth) |
| Bot↔server auth | `checkInternalBypass` (license.ts:132): two-flag `BOT_INTERNAL_BYPASS_ENABLED=true` + `X-AlgoVault-Internal-Key`==`ALGOVAULT_INTERNAL_BYPASS_KEY`; bot→loopback `127.0.0.1:3000` via httpx (capabilities.py) | export `checkInternalBypass`; C1 routes 401 unless it passes. C2 calls via `referral_client.py` (httpx + the internal-key header) |
| Attribution channel enum | `'paid_checkout'\|'free_signup'` — TS `ReferralChannel` (referral-store.ts:87) + inline CHECK (referral-store.ts:45 in-code DDL + migrations/015:30, PG constraint `referral_attributions_channel_check`) | add `'tg'`: TS type + in-code DDL CHECK (fresh/test DBs) + **migration 016** `DROP CONSTRAINT IF EXISTS … ADD CONSTRAINT … CHECK (… ,'tg')` (PG prod, pre-applied via SSH) |
| TG identity bridge | engine codes derive from apiKey/email (`deriveUserCode`); TG users = `chat_id` only | `tgIdentity(chat_id)` = `tg:` + HMAC-SHA256(salt, chat_id) base64url[:22] → `ensureUserCode(identity)` (kind=`user`, owner_key=`tg:<hash>`); attribution `referee_email = tgIdentity` → one-grant-per-tg via the existing `referee_email UNIQUE`. **No new kind, no new table.** |
| Dual-quota | server `referral_bonus`/`quota_usage` (web); bot `consume_quota` 100/mo `subscribers` (quota.py) — `QuotaState.exhausted = used>=total` gates free users, paid tiers unlimited; **no bonus column** | TG referee +500 → **new bot-side `subscribers.referral_bonus_remaining`** (C2; mirrors server `freeMeterCharge` — persistent pool consumed after the monthly 100). Commission stays the web `invoice.paid`→30% path (unchanged). C1's attribute returns `bonus_calls` so the bot grant amount is SoT-derived, not hardcoded. |
| `/start` payload | `_start` parses `auth_<apiKey>` (BOT-W2, handlers.py:1007); CallbackQueryHandler infra present | C2 extends `_start` with a `ref_<CODE>` branch (alongside `auth_`) |
| Deep-link / share | bot **@algovaultofficialbot** (getMe verified, token valid); **PTB 22.7** (url InlineKeyboardButton supported) | `t.me/algovaultofficialbot?start=ref_<CODE>`; Share = url button `t.me/share/url?url=<reflink>&text=<framing>` |
| SoT / grant amount | `REFERRAL_TERMS` (referral-constants.ts): BONUS_CALLS=500, COMMISSION_RATE 0.30, COMMISSION_MONTHS 12, CODE_RE `^[A-Z0-9]{6,16}$` | C1's API returns `terms{bonus_calls,commission_pct,commission_months}` → the bot renders + grants WITHOUT hardcoding (single-SoT) |
| Identifier diff | code `^[A-Z0-9]{6,16}$` (deriveUserCode emits 8 base32 ∈ A-Z0-9 ✓); payload prefix `ref_` (new, alongside `auth_`); grant 500 = BONUS_CALLS; routes `/api/referral/{code,attribute}` | no conflicts |
| A5 coordination | A5 (`feat/unlock-x-follow-deprecate`) edits unlock.py + handlers.py *unlock* regions; this wave edits `/referral` + `_start` + new modules | rebase A5 onto `f0115fe`; build TG-REFERRAL on that lineage → handlers.py carries adoption + A5 + referral, no region overlap; they deploy together |

## Self-referral / abuse model
- One grant per TG referee: `recordAttribution` `referee_email = tgIdentity(chat_id)` (UNIQUE) → idempotent (`already_attributed`).
- Self-referral refused: the referrer code's `owner_key` == the referee's `tgIdentity` → `self_referral`.
- The bot ALSO guards (referrer chat_id != referee chat_id) before calling (defense-in-depth).
- Cross-surface: a TG `tg:<hash>` identity never collides with a web email (no `@`, `tg:` prefix); a user active on both surfaces could earn a tg-bonus AND a web-bonus (different quota systems) — acceptable, not double-spend.

## Deploy (operator-chosen: FULL DEPLOY BOTH REPOS)
- C1 → deploy-direct.sh (clean; migration 016 pre-applied via SSH); the API is dormant (internal-key-gated) until the bot ships.
- Bot → rebase A5 onto `f0115fe`, build C2/C3, rsync union → prod + restart; **adoption broadcast go-live stays HELD (Mr.1 review) — preserved, never triggered**; merge lineage → main so git==prod.
