# SECURITY-AUDIT-RECENT-FEATURES-W1 — Area 2: Webhook Delivery Surface (R2)

**Auditor:** WEBHOOK-AUDITOR (teammate 2/5) · **Type:** READ-ONLY forensic · **Date:** 2026-06-07
**Clone:** `~/code/crypto-quant-signal-mcp` @ `aec4175` (`origin/main`, clean tree). All `file:line` refs are this clone.
**Headline issue:** SSRF / DNS-rebind on the reusable egress guard (`OPS-WEBHOOK-SSRF-IP-PIN-W1`).
**Read-only integrity:** no `src/` edits; writes confined to `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/area2-webhook.md` + `poc/*.mjs`. PoCs are self-contained (no `src/` import); they fire only at a local loopback sink, never at prod.

---

## 1. Summary

**The rebind is REAL and exploitable — and there is a second, strictly-easier SSRF bypass that needs no rebind at all.**

| Severity | Count | IDs |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 2 | WH-01 (DNS-rebind TOCTOU), WH-02 (hex IPv4-mapped-IPv6 literal SSRF) |
| MEDIUM | 3 | WH-03 (`/api/webhooks` + `:id/test` unrate-limited → SSRF/DoS amplification), WH-04 (HMAC omits timestamp → replay), WH-05 (NAT64 `64:ff9b::/96` egress not blocked) |
| LOW | 1 | WH-06 (`assertEgressAllowed` registration check is bypassable, defense-in-depth only) |
| INFO | 2 | WH-07 (`/api/verify-signal` no rate-limit; input-validation otherwise solid), WH-08 (PASS notes consolidated) |

**Rebind exploitability verdict (R2.1 / AC3): YES.** A registered webhook whose hostname is backed by attacker-controlled DNS (low TTL, public→internal flip) reaches `169.254.169.254` (cloud metadata), `127.0.0.1` (admin/loopback), `10.x`/`172.16.x`/`192.168.x`, the Postgres port — anything routable from the MCP container. PROVEN by `poc/rebind-poc.mjs` (exfiltrates a stand-in secret from a loopback sink). `redirect:'error'` does NOT mitigate (the FIRST connection rebinds). **WH-02 makes it even cheaper**: a literal `https://[::ffff:7f00:1]/` (= `127.0.0.1` in hex IPv4-mapped form) passes the guard with no DNS at all — single request, no timing.

**Headline blast radius (generator-level):** `webhook-ssrf.ts` is documented (file header L1-25) as *"the reusable allowlist for ALL outbound HTTP to user-supplied URLs (webhook delivery today; P0-3 adapters / any future fetch-to-user-URL tomorrow)."* The rebind hole is therefore inherited by **every future consumer** that follows the `resolveAndAssertEgress(url)` → `fetch(url)` pattern. Fixing it in the guard (pin the validated IP) closes it for all of them — confirmed by `poc/fix-pins-ip.mjs`.

**What's solid (real PASSes, not assumed):** IPv4 alternate encodings (decimal/octal/hex → all blocked via WHATWG-URL normalization), embedded-creds rejection, https-only, non-http scheme rejection, NXDOMAIN fail-closed, dotted IPv4-mapped-IPv6, owner-scoped IDOR protection on delete/test, CSPRNG secret (192-bit), secret-shown-once + never-on-list, dark-ship worker boot-gate (double-guarded), allow-list payload shape, `/api/verify-signal` strict-regex input validation + parameterized query (no SQLi, no enumeration). Detail in §3.

---

## 2. Findings

Schema: `ID · severity · area · file:line · exploit · evidence · GENERATOR-LEVEL fix · follow-up wave`.

---

### WH-01 — DNS-rebind / resolve→connect TOCTOU (the headline) · **HIGH** (CRITICAL if metadata creds harvested)

- **Area:** R2.1 · outbound webhook egress.
- **File:line:**
  - `src/lib/webhook-delivery.ts:208` — `await resolveAndAssertEgress(sub.url, { lookup: deps.lookup })` (the check: resolves + validates IP, **returns `void` — discards the validated address**).
  - `src/lib/webhook-delivery.ts:262` — `postWithTimeout(fetchImpl, sub.url, …)` (the use: passes the **hostname** `sub.url` to `fetch`).
  - `src/lib/webhook-delivery.ts:171` — `fetchImpl(url, { … redirect:'error' })` — no `dispatcher`/`agent`, so Node `fetch` (undici 6.24.1) **re-resolves the hostname at connect time**.
  - `src/lib/webhook-ssrf.ts:160-182` — `resolveAndAssertEgress` validates then returns `void`; it never hands the caller an IP to pin.
- **Exploit scenario:** Attacker registers a webhook `https://rebind.attacker.example/x` (passes the sync registration check — it's a hostname, not a literal IP). They run authoritative DNS for that host with a ~0-second TTL. When `deliverOne` calls `resolveAndAssertEgress` (lookup #1) the resolver returns a PUBLIC A record → IP-class check passes → guard returns `void`. Microseconds later, `fetch(sub.url)` performs its own connect-time resolution (lookup #2); the attacker's resolver now answers `169.254.169.254` (or `127.0.0.1`/`10.x`). undici connects to the internal IP. The signed POST body is delivered to the internal endpoint, and (for GET-style metadata IMDSv1) the response is observable to the attacker via timing/side effects; for any internal HTTP service that accepts a POST, this is a full SSRF write. The `Host` header carries the attacker hostname, which many internal services ignore.
- **Evidence (PoC):** `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/rebind-poc.mjs` — exit 0, VULNERABLE. Output excerpt:
  ```
  [dns] lookup #1 rebind.attacker.example -> 93.184.216.34   [PUBLIC (check passes)]
         validate 93.184.216.34 -> allowed (public)
         => guard PASSED. Note: it threw the validated IP away and returns void.
  [dns] lookup #2 rebind.attacker.example -> 127.0.0.1   [INTERNAL (connect rebinds)]
  [internal-sink] !!! RECEIVED POST /latest/meta-data/iam/security-credentials/ — guard BYPASSED
  DNS lookups performed: 2  (1 = check, 2 = connect → re-resolution confirmed)
  VERDICT: VULNERABLE ✅ — exfiltrated: "IAM_ROLE_CREDENTIALS=ASIA...{leaked-by-SSRF}"
  ```
  Corroborating in-repo: the existing test `tests/webhook-ssrf.test.ts:166` ("postWithTimeout sets redirect:'error'") captures the outbound `init` and asserts only `redirect`; the captured `init` has **no dispatcher** — i.e. the test itself documents that the real fetch is unpinned. The injected `lookup` only gates the *check*, never the *connection*.
- **Why `redirect:'error'` doesn't save it:** that only blocks a 3xx→internal *after* a first successful connect. The rebind subverts the FIRST connect, so no redirect is involved.
- **GENERATOR-LEVEL fix:** change `resolveAndAssertEgress` to RETURN the validated address(es), and route every outbound send through a shared helper that PINS that IP to the connection — an undici `Agent`/`Dispatcher` with a custom `connect.lookup` (or `connect`) that returns ONLY the pre-validated IP, so undici cannot re-resolve. (Equivalent: connect-to-IP + set the `Host`/SNI to the original hostname.) Apply this in `webhook-ssrf.ts` as the single egress primitive so every consumer (webhooks + P0-3 adapters + any future fetch-to-user-URL) inherits the pin. Confirmed closed by `poc/fix-pins-ip.mjs` (exit 0: internal-sink hits=0, pinned-public-sink hits=1 — connection honored the pinned IP, rebind ignored).
- **Follow-up wave:** **`OPS-WEBHOOK-SSRF-IP-PIN-W1`** (already named by Mr.1). Fold WH-02/WH-05 into the same wave (same primitive).

---

### WH-02 — Hex IPv4-mapped-IPv6 literal bypasses the IP-class block (no rebind needed) · **HIGH**

- **Area:** R2.2 · `src/lib/webhook-ssrf.ts:77-87` (`classifyIpv6`).
- **File:line:** `src/lib/webhook-ssrf.ts:79` — `const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);`. The regex only matches the **dotted-decimal** suffix of an IPv4-mapped address. The equally-valid **hex** form (`::ffff:7f00:0001`, `::ffff:a00:1`) is not matched, falls through, and returns `{ blocked: false, reason: 'public' }`.
- **Exploit scenario:** Register `https://[::ffff:7f00:1]/x` (= `127.0.0.1`) or `https://[::ffff:a00:1]/x` (= `10.0.0.1`). `assertEgressAllowed` extracts `host = ::ffff:7f00:1`, `net.isIP` returns 6, `classifyIpv6` returns "public" → **sync guard passes at registration**. At delivery, `resolveAndAssertEgress` sees `classifyIp(host)` is non-null and **returns early without DNS** (`webhook-ssrf.ts:165`), so it ALSO passes. `fetch` connects the literal; the OS maps it to loopback. No DNS, no rebind, no timing — a single deterministic request. **Worse:** WHATWG `URL` *normalizes the dotted form to hex* — `new URL('https://[::ffff:127.0.0.1]/').hostname === '::ffff:7f00:1'` — so the dotted-form regex is effectively **dead for any host that arrives via `URL`** (which is every host, since `assertEgressAllowed` always does `new URL(rawUrl)`).
- **Evidence (PoC):** `poc/v6-bypass` run captured in this wave (`/tmp/v6exploit.mjs`, logic reproduced below — re-runnable):
  ```
  https://[::ffff:7f00:1]/x      host=::ffff:7f00:1   *** ALLOWED (sync guard PASSES) ***
  https://[::ffff:a00:1]/x       host=::ffff:a00:1    *** ALLOWED (sync guard PASSES) ***
  https://[::ffff:127.0.0.1]/x   host=::ffff:7f00:1   *** ALLOWED (sync guard PASSES) ***   (URL normalized dotted→hex)
  [socket] connected to [::ffff:7f00:1]:PORT -> remoteAddress=::ffff:127.0.0.1   (OS routes to loopback)
  ```
  The existing test `tests/webhook-ssrf.test.ts:51` only checks the **dotted** form `::ffff:10.0.0.1` (which passes), so this blind spot ships green.
- **GENERATOR-LEVEL fix:** in `classifyIpv6`, canonicalize the mapped suffix from the parsed 16-byte representation rather than string-matching dotted decimal — e.g. detect any `::ffff:0:0/96` address (last 32 bits = embedded IPv4, regardless of textual form) and run those 32 bits through `classifyIpv4`. Equivalently, reject **all** IPv4-mapped (`::ffff:*`) and IPv4-compatible (`::*`) and NAT64 (`64:ff9b::/96`, see WH-05) literals outright unless their embedded IPv4 is provably public. Belt-and-suspenders once WH-01's IP-pinning lands (the pinned-IP path would re-classify the connect target). Add hex-form + URL-normalized fixtures to `webhook-ssrf.test.ts`.
- **Follow-up wave:** **`OPS-WEBHOOK-SSRF-IP-PIN-W1`** (bundle with WH-01 — same file, same primitive).

---

### WH-03 — Webhook REST routes are NOT rate-limited (limiter on wrong prefix) → `:id/test` SSRF/DoS amplification · **MEDIUM**

- **Area:** R2.5 / R2.4 · `src/index.ts:936` vs `src/lib/webhook-api.ts:119/180/198/218`.
- **File:line:** `src/index.ts:936` — `app.use('/webhooks', rateLimit({ windowMs: 60_000, max: 20, … }))`. The webhook subscription routes are mounted at **`/api/webhooks`** (`webhook-api.ts:119,180,198,218`). Express prefix matching: `app.use('/webhooks', …)` matches `/webhooks`, `/webhooks/...` — **NOT** `/api/webhooks/...`. The only handler under bare `/webhooks` is the inbound Stripe webhook (`src/index.ts:1068` `/webhooks/stripe`). So the limiter guards the *inbound Stripe* path and leaves the *outbound subscription API* entirely unthrottled.
- **Exploit scenario:** Any holder of a free API key (signup is open) can call `POST /api/webhooks/:id/test` (`webhook-api.ts:218`) with no rate limit. Each call invokes `deliverOne` → the SSRF egress path → an outbound POST with up to `WEBHOOK_MAX_ATTEMPTS=5` retries (`webhook-delivery.ts:258`). This is a **request-amplification / SSRF-probe primitive**: hammer `:id/test` to (a) port-scan/probe internal targets via the WH-01/WH-02 SSRF (timing oracle), (b) use AlgoVault's egress IP as a DoS reflector against a third party, (c) burn server outbound capacity. `POST/GET/DELETE /api/webhooks` are likewise unthrottled (subscription-spam / enumeration of one's own ids). Auth is required (good — see WH-08), so this is authed-abuse, hence MEDIUM not HIGH.
- **Evidence:** live probe — `GET https://api.algovault.com/api/webhooks` returns `401 auth_required` with **no `RateLimit-*` response headers** (the limiter sets `standardHeaders:true`, so their absence proves it isn't applied). The `/mcp` and `/analytics` siblings on the same `app.use` block do emit those headers. Route-path grep:
  ```
  webhook-api.ts:218:  app.post('/api/webhooks/:id/test', …)
  index.ts:936:        app.use('/webhooks', rateLimit(... max:20 ...))   ← matches /webhooks/* only
  index.ts:1068:       app.post('/webhooks/stripe', …)                  ← the only /webhooks/* route
  ```
- **GENERATOR-LEVEL fix:** correct the prefix to `app.use('/api/webhooks', rateLimit(...))`, and additionally apply a tighter per-key limiter to `:id/test` specifically (e.g. max 5/min/key) since it triggers real outbound traffic. Add a route-coverage canary that asserts every mounted `/api/webhooks*` route is behind a limiter (prevents prefix drift recurring). This is the "missing-rate-limit" bug class for the whole HTTP surface — a generator-level canary (every state-mutating or egress-triggering public route must declare a limiter) retires it.
- **Follow-up wave:** **`OPS-WEBHOOK-RATELIMIT-PREFIX-FIX-W1`** (fast hardening; can ride with the IP-pin wave).

---

### WH-04 — HMAC signature omits the timestamp from the signed bytes → replay window · **MEDIUM**

- **Area:** R2.3 · `src/lib/webhook-delivery.ts:101-114, 253`.
- **File:line:** `webhook-delivery.ts:102` — `crypto.createHmac('sha256', secret).update(body).digest('hex')` signs the **body only**. `webhook-delivery.ts:112` sends `X-AlgoVault-Timestamp` as a header, but the timestamp is **not** part of the signed input. `webhook-delivery.ts:253` signs once before the retry loop.
- **Exploit scenario:** A subscriber verifying `HMAC(body) == X-AlgoVault-Signature` accepts a captured `(body, signature)` pair forever — there is no signed timestamp to enforce a freshness window (cf. Stripe's `t=<ts>,v1=<sig>` scheme where the signed string is `"{t}.{body}"`). An attacker who captures one delivery (e.g. via a logging proxy, or the WH-01/WH-02 SSRF replaying to a victim's endpoint) can replay it indefinitely. Practical impact is bounded because the body embeds `created_at` and a unique `delivery_id` (a careful consumer can dedup), so this is a hardening gap, not a forgery — **MEDIUM**.
- **Evidence:** `grep -n "createHmac|X-AlgoVault-Timestamp|signPayload(body" src/lib/webhook-delivery.ts` → sign at L102 over `body`; timestamp only at header L112. Confirmed no second `.update()`.
- **GENERATOR-LEVEL fix:** sign `"{timestamp}.{body}"` (the documented webhook-signature convention) and document the verification recipe in `docs/WEBHOOKS.md` (reject if `|now - t| > tolerance`). One signing helper; all events inherit replay-resistance.
- **Follow-up wave:** **`OPS-WEBHOOK-HMAC-TIMESTAMP-W1`** (note: changes the public signature contract → must ship a versioned signature-scheme notice to subscribers; coordinate with a RELEASE wave, not a silent code wave).

---

### WH-05 — NAT64 `64:ff9b::/96` egress is not blocked · **MEDIUM** (LOW on Hetzner today)

- **Area:** R2.2 · `src/lib/webhook-ssrf.ts:77-87`.
- **File:line:** `classifyIpv6` has no case for the NAT64 well-known prefix `64:ff9b::/96`. `64:ff9b::10.0.0.1` (= the NAT64 representation of `10.0.0.1`) classifies as "public".
- **Exploit scenario:** On any host/network with a NAT64 gateway, a webhook to `https://[64:ff9b::a00:1]/` egresses to internal `10.0.0.1` via NAT64. The current Hetzner deployment has no NAT64 in the container path, so today this is latent (LOW), but the egress guard is explicitly the reusable primitive for future consumers/hosts → flagged MEDIUM for the guard's correctness.
- **Evidence:** `/tmp/v6map.mjs` run this wave: `64:ff9b::10.0.0.1  isIP=6 => ***ALLOWED*** (public-or-UNMATCHED)`.
- **GENERATOR-LEVEL fix:** in the same `classifyIpv6` rewrite (WH-02), treat `64:ff9b::/96` as embedded-IPv4 and classify the embedded address; or reject NAT64 outright.
- **Follow-up wave:** **`OPS-WEBHOOK-SSRF-IP-PIN-W1`** (bundle).

---

### WH-06 — Sync registration guard (`assertEgressAllowed`) is not a security boundary on its own · **LOW**

- **Area:** R2.2 · `src/lib/webhook-api.ts:59-68, 126`.
- **Note:** `POST /api/webhooks` calls `assertEgressAllowed` (sync) at registration. This correctly rejects literal internal IPs + embedded creds at create time, but it CANNOT catch rebind (a benign-resolving hostname registers fine and rebinds at delivery — by design, per `webhook-ssrf.ts:11-13`). That's acceptable *provided* the delivery-time guard is sound — but WH-01/WH-02 show it isn't. Logged LOW to record that the registration check is defense-in-depth, and the real boundary must be the (fixed) delivery-time pin. No separate fix beyond WH-01/02.

---

### WH-07 — `/api/verify-signal` has no rate limit (but input validation is solid) · **INFO**

- **Area:** R2.6 · `src/index.ts:1600-1660`, `src/lib/performance-db.ts:1247`.
- **Note:** The spec's `/verify?hash=` resolves to two things: (a) the public HTML page at root `algovault.com/verify` (static, 97 KB, harmless), and (b) the JSON API `GET /api/verify-signal?hash=` (the form baked into webhook `verify_url`, `webhook-delivery.ts:84`). The API is **not** behind any limiter (same `/api/*` gap as WH-03), so logged as INFO. Everything else is a PASS: hash is validated by `/^0x[0-9a-fA-F]{64}$/` (`index.ts:1605`) **before** any DB call (rejects SQLi/garbage at 400); `getSignalByHash` (`performance-db.ts:1247-1263`) is fully **parameterized** (`WHERE s.signal_hash = ?` on both PG and SQLite); the response signal shape is a hand-picked **public allow-list** (`id, coin, call, direction, confidence, timeframe, exchange, regime, price_at_call, hash, batch metadata`) — **no `outcome_return_pct`/`outcome_price`/Phase-E key**; 404 for unknown hash leaks nothing enumerable.
- **Evidence (live):** `?hash=test` → `400 {"error":"invalid hash (expected 0x + 64 hex chars)"}`; `?hash=0x'%20OR%201=1--` → `400` (rejected pre-DB); `?hash=0x000…000` (valid shape, no match) → `404 {"error":"Signal not found", …}`; valid-shape responses carry only allow-listed keys.
- **Follow-up:** add `/api/verify-signal` to the `/api/*` limiter (rolled into WH-03's `OPS-WEBHOOK-RATELIMIT-PREFIX-FIX-W1`).

---

### WH-08 — Consolidated PASS evidence (no action) · **INFO**

See §3 — every R2 sub-item's PASS/FAIL with evidence.

---

## 3. Verification evidence — PASS/FAIL per R2.1–R2.7

### R2.1 — resolve→connect rebind: **FAIL (VULNERABLE)** — see WH-01.
- Code path: `deliverOne` validates via `resolveAndAssertEgress(sub.url)` (returns `void`, drops the IP) → sends via `fetch(sub.url)` by hostname with no dispatcher → undici re-resolves at connect.
- PoC `poc/rebind-poc.mjs` exit 0: lookup #1 PUBLIC (check passes), lookup #2 INTERNAL (connect), internal-sink hit, secret exfiltrated.
- Reaches: `169.254.169.254` (metadata), `127.0.0.1` (admin/loopback), `10.x`/`172.16.x`/`192.168.x`, Postgres port — anything routable from the container.
- Fix confirmed: `poc/fix-pins-ip.mjs` exit 0 — pinning the validated IP via undici `Agent.connect.lookup` blocks the rebind (internal-sink hits=0). Generator-level: closes it for every `webhook-ssrf` consumer.

### R2.2 — SSRF block-class completeness: **PARTIAL** (strong on IPv4 + dotted v6; FAILS on hex IPv4-mapped + NAT64).
| Class | Result | Evidence |
|---|---|---|
| `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (AWS/GCP metadata), `0.0.0.0`, `100.64/10` CGNAT | **PASS** | `classifyIpv4` (`webhook-ssrf.ts:58-74`); test L33; live encoding test all BLOCKED |
| `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), `::` | **PASS** | `classifyIpv6` (L77-87); `/tmp/v6map.mjs` |
| IPv4-mapped IPv6 **dotted** (`::ffff:10.0.0.1`) | **PASS** | regex L79; test L51 |
| IPv4-mapped IPv6 **hex** (`::ffff:a00:1`, `::ffff:7f00:1`) | **FAIL → WH-02** | `/tmp/v6exploit.mjs`: ALLOWED + connects to loopback; URL normalizes dotted→hex so the regex is dead for URL-sourced hosts |
| NAT64 `64:ff9b::/96` | **FAIL → WH-05** | `/tmp/v6map.mjs`: ALLOWED |
| Alternate IPv4 encodings: decimal `2130706433`, hex `0x7f000001`/`0x7f.0.0.1`, octal `017700000001`/`0177.0.0.1` | **PASS** | `/tmp/enc-test.mjs`: WHATWG `URL` normalizes to dotted-quad → `classifyIpv4` BLOCKS all. (Notably robust — the guard delegates normalization to WHATWG URL correctly.) |
| https-only; http only under loopback seam | **PASS** | `assertEgressAllowed` L136-142; test L61-63 |
| Reject non-http(s) (`ftp:`, `file:`) | **PASS** | L140-142; test L66-69 |
| Reject embedded creds `user:pass@` | **PASS** | L127-129; test L71-73 |
| NXDOMAIN / resolver error → fail-closed | **PASS** | `resolveAndAssertEgress` L171-174; test L108-111 |
| Resolved-to-no-addresses → fail-closed | **PASS** | L175-177 |
| Redirect to internal AFTER check (`redirect:'error'`) | **PASS** (for 3xx) but **does not mitigate WH-01** | `postWithTimeout` L171; test L166-177. Note: blocks post-connect 3xx→internal, but the rebind subverts the first connect, so this is necessary-not-sufficient |

### R2.3 — HMAC + secrets: **PASS except timestamp (WH-04).**
| Check | Result | Evidence |
|---|---|---|
| Secret via CSPRNG, sufficient entropy | **PASS** | `webhooks-store.ts:152` `whsec_${crypto.randomBytes(24).toString('hex')}` = 192-bit, `crypto.randomBytes` not `Math.random` |
| `whsec_` prefix | **PASS** | `webhooks-store.ts:153` |
| Signature = HMAC-SHA256 over body | **PASS** | `webhook-delivery.ts:102` |
| Signature binds **timestamp** (replay resistance) | **FAIL → WH-04** | timestamp is a header only (L112), not in `update()` |
| Secret shown only once (create), never on list | **PASS** | `webhook-api.ts:113` (`includeSecret` true only on create path L168); `serializeSubscription` omits it on GET L188 |
| Secret stored… plaintext vs hashed | **NOTE (acceptable):** stored as-is in `webhook_subscriptions.secret` (`webhooks-store.ts:172`) because the server must re-compute HMAC per delivery (a hash would prevent signing) — this is the standard webhook model (Stripe/GitHub store the signing secret too). Mitigation that matters: it's never echoed after create and never logged. Not a finding; flagged for completeness. |

### R2.4 — Authn/z + tenant isolation: **PASS.**
| Check | Result | Evidence |
|---|---|---|
| API key required on all `/api/webhooks*` | **PASS** | every handler calls `resolveOwner` then `if (!ownerKey) return authRequired(res)` (`webhook-api.ts:122,183,201,221`); live `GET/POST /api/webhooks` → `401 auth_required` |
| IDOR on DELETE `:id` | **PASS** | `deleteSubscription(id, ownerKey)` scopes `WHERE id=? AND owner_key=?` (`webhooks-store.ts:217-227`); key A cannot delete key B's row (returns 404) |
| IDOR on `:id/test` | **PASS** | `getSubscription(id)` then explicit `if (!sub || sub.owner_key !== ownerKey) return 404` (`webhook-api.ts:227`) — owner re-checked before any send |
| IDOR on GET (list) | **PASS** | `listSubscriptions(ownerKey)` scoped `WHERE owner_key=?` (`webhooks-store.ts:189-199`) |
| `owner_key` never echoed | **PASS** | `serializeSubscription` never includes it (`webhook-api.ts:99-115`) |
| Quota enforced | **PASS** | delivery draws the owner's monthly quota (`webhook-delivery.ts:228-238` PAUSE on exhaustion); create reports quota (`webhook-api.ts:164`) |
| Rate-limit on the routes | **FAIL → WH-03** | limiter on `/webhooks`, routes at `/api/webhooks` |

### R2.5 — Delivery worker: **PASS except `:id/test` amplification (WH-03).**
| Check | Result | Evidence |
|---|---|---|
| `tryClaimDelivery` race / double-send | **PASS** | the atomic claim is `enqueueDelivery` — `INSERT … ON CONFLICT (subscription_id, event_id) DO NOTHING RETURNING id` (`webhooks-store.ts:243-253`) backed by a UNIQUE constraint → at-most-once enqueue even under concurrent fan-out. `tryClaimDelivery` (L260-266) is a **pure read** (documented as such), not the lock — correct; the DB UNIQUE is the real guard. Drain query `pendingDeliveries` is `status='pending'` + ORDER + LIMIT; a delivery transitions out of pending on first attempt, so concurrent workers re-selecting the same row would re-send — but prod runs a single in-process worker (`setInterval`, `webhook-delivery.ts:328`), and `enqueue` dedup prevents duplicate *rows*. Multi-worker double-send of the SAME pending row is a latent risk if the worker is ever horizontally scaled; noted, not a finding at current single-instance topology. |
| Retry budget bounded | **PASS** | `for i in 0..maxAttempts` (default 5), exp backoff `baseBackoffMs * 2**i` (`webhook-delivery.ts:258-277`) |
| Auto-disable after N failures | **PASS** | `bumpFailureAndMaybeDisable(sub.id, disableAfter)` default 20 (`webhook-delivery.ts:281`, `webhooks-store.ts:305-323`); silent recovery (log only, no TG) per alert contract |
| `:id/test` SSRF/DoS amplification | **FAIL → WH-03** | unthrottled; triggers full outbound delivery incl. retries |
| Blocked egress → no quota/retry burn | **PASS** | egress block marks `dead`, 0 attempts, 0 quota (`webhook-delivery.ts:210-221`; test L150-164) |

### R2.6 — `/verify?hash=`: **PASS** (rate-limit gap = INFO WH-07).
| Check | Result | Evidence |
|---|---|---|
| Public-only shape (no Phase-E/`outcome_return_pct`) | **PASS** | `/api/verify-signal` returns allow-listed signal fields only (`index.ts:1618-1640`); no outcome/pfe/mae key |
| No SQLi in `hash` | **PASS** | regex-gated `^0x[0-9a-fA-F]{64}$` pre-DB (`index.ts:1605`) + parameterized `getSignalByHash` (`performance-db.ts:1256` `WHERE s.signal_hash = ?`); live `0x' OR 1=1--` → 400 |
| No enumeration leak | **PASS** | 404 returns only the echoed hash + generic hint; no count/range disclosure |
| Rate-limited | **FAIL (minor) → WH-07** | no limiter on `/api/verify-signal` |

### R2.7 — Payload + dark-ship: **PASS.**
| Check | Result | Evidence |
|---|---|---|
| Outbound payload allow-list-shaped (no internal fields) | **PASS** | `buildPayload` (`webhook-delivery.ts:72-98`) emits a fixed `WebhookPayloadData` allow-list (`type,coin,timeframe,exchange,call,confidence,regime,[prior_regime],price_at_call,signal_hash,verify_url`) + `_algovault` block; input is itself the allow-listed `WebhookEventData` snapshot stored at enqueue (`webhooks-store.ts:36-48`), which never reads `signals`/Phase-E — forbidden keys are structurally impossible (documented L66-71, `webhook-events.ts:103-122`). `_algovault` metadata block present (R-build rule). |
| `WEBHOOK_DELIVERY_ENABLED` unset ⇒ worker does NOT boot | **PASS** | `index.ts:2231` `if (process.env.WEBHOOK_DELIVERY_ENABLED === 'true') startDeliveryWorker()` — strict `=== 'true'`, default off. **Double-guarded:** the event-detection hook `onSignalRecorded` also early-returns unless the flag is `'true'` (`webhook-events.ts:241`). Registration routes stay mounted (intentional pre-register), but nothing is delivered. Step-0 confirms `WEBHOOK_DELIVERY_ENABLED` default false (dark-ship). |

---

## 4. PoC inventory (all under `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/`)

| File | Proves | Exit | Self-contained |
|---|---|---|---|
| `rebind-poc.mjs` | WH-01: resolve→connect rebind exploitable; webhook POST reaches internal loopback sink, exfiltrates secret | 0 = VULNERABLE | yes (no `src/` import; loopback only) |
| `fix-pins-ip.mjs` | WH-01 fix: pinning the validated IP via undici `Agent.connect.lookup` blocks the rebind (internal-sink untouched) | 0 = FIX WORKS | yes |

Ad-hoc validator-logic probes (`/tmp/enc-test.mjs`, `/tmp/v6map.mjs`, `/tmp/v6exploit.mjs`) reproduced the verbatim `classifyIpv4`/`classifyIpv6`/host-extraction logic to test encodings/IPv4-mapped; their logic + output are inlined under WH-02/WH-05/R2.2 so the findings are reproducible without those temp files.

## 5. Read-only integrity

- No edits to `src/`, `landing/`, `Design/`, `deploy/`, `Dockerfile`, `.github/`. No `npm install`, no `git add/commit/push`, no deploy, no prod/DB/env mutation. No webhook fired at any prod/internal IP — the rebind is proven via local loopback PoC only.
- `npx vitest run tests/webhook-ssrf.test.ts` (read-only execution) → 16/16 pass — confirms the existing suite is green WHILE WH-01/WH-02 holes exist (the suite covers dotted-form `::ffff:10.0.0.1` and injected-lookup rebind-CHECK, but not the unpinned CONNECT path nor hex-mapped form — exactly the blind spots). The lead owns the full `npm test` baseline (`15 fail / ~1805 pass`).
- Writes confined to `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/area2-webhook.md` + `poc/rebind-poc.mjs` + `poc/fix-pins-ip.mjs`.

## 6. Hand-off to LEAD (R5)

- **Authn/z matrix (R5.4) rows for area 2:** `/api/webhooks` (POST/GET/DELETE) — auth ✅ / rate-limit ❌ (WH-03) / quota ✅ / IDOR-safe ✅. `/api/webhooks/:id/test` — auth ✅ / rate-limit ❌ (WH-03, amplification) / IDOR-safe ✅. `/api/verify-signal` — public-by-design / rate-limit ❌ (WH-07) / input-validated ✅.
- **Output-shape allow-list (R5.3):** webhook payload has an EXPORTED pure formatter (`buildPayload`, `webhook-delivery.ts:72`) + structural allow-list — **PASS**; flag: no `audits/*-shape-snapshot` JSON exists for the webhook payload or for `/api/verify-signal` (recommend adding both).
- **Severity backlog priority:** WH-01 + WH-02 → P0 (`OPS-WEBHOOK-SSRF-IP-PIN-W1`, bundle WH-05). WH-03 → P1 (`OPS-WEBHOOK-RATELIMIT-PREFIX-FIX-W1`, includes WH-07). WH-04 → P2 (`OPS-WEBHOOK-HMAC-TIMESTAMP-W1`, needs subscriber-facing signature-scheme notice → RELEASE-coordinated).
- **Note for the master report:** the egress guard is generator-level (file header L1-25). The IP-pin fix is the single highest-leverage remediation in the wave — it closes the SSRF class for webhooks AND every future fetch-to-user-URL consumer (P0-3 adapters).
