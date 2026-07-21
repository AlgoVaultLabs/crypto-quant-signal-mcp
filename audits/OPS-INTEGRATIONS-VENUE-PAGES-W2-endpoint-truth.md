# OPS-INTEGRATIONS-VENUE-PAGES-W2 — endpoint truth

**Access date: 2026-07-21.** Re-probe of the two venues W1 deferred (Gate.io, MEXC), from two
networks against primary sources. **Result: `M = 1`** — Gate.io ships; MEXC is **closed**, not
deferred.

**Anchors:** cqsm `27d0dcb` · algovault-skills `1c845a8`.

---

## 1. Verdicts

| Venue | W1 verdict | W2 verdict | Outcome |
|---|---|---|---|
| **Gate.io** | `FULL — testnet DEGRADED` (deferred on a 502) | ✅ **FULL on `api-testnet.gateapi.io`** | **SHIPPED** — `/integrations/gateio` |
| **MEXC** | `NO-TESTNET` (deferred pending a demo-key check) | 🛑 **NO SANDBOX — structural** | **CLOSED for execution tutorials** |

---

## 2. Gate.io — the deferral was correct, my diagnosis was not

W1 deferred Gate because its testnet 502'd. That observation was accurate and reproducible; the
**conclusion drawn from it was wrong**. `fx-api-testnet.gateio.ws` is a **drained legacy host**, and
Gate's futures testnet is alive at a different address.

### What I originally measured (all true, all misleading)

~25 probes across two days and two network egresses, every futures market-data path on
`fx-api-testnet.gateio.ws` returning **502** (`usdt` · `btc` · `delivery` · `tickers` ·
`order_book` · single-contract), `server: openresty`. On the same host `/spot` and `/wallet`
returned **404** (router alive), the auth route returned a structured **400
`MISSING_REQUIRED_HEADER`** (app tier alive), and the prod host returned **200** throughout. No
alternative host resolved. Gate operates **no status page at any canonical address**
(`status.gate.{com,io,ws}` NXDOMAIN; statuspage.io tenants nonexistent).

**Why more probing could never have fixed this:** every additional 502 made the wrong conclusion
feel better supported. The failure was in the *address*, not the sample size.

### What actually resolved it

Gate's **own newest first-party tooling** — `gate/gate-cli` (pushed 2026-07-15) and `gate/gate-mcp`
— names `https://api-testnet.gateapi.io`, and **ccxt master has removed `fx-api-testnet` entirely**.

| Probe on `api-testnet.gateapi.io/api/v4` | Result |
|---|---|
| `/futures/usdt/contracts` | **200** — 63 USDT contracts |
| `/futures/usdt/contracts/BTC_USDT` — **the read that blocked the page** | **200** — `quanto_multiplier 0.0001`, `order_size_min 1`, `mark_price 66256.5` |
| `/futures/usdt/tickers` · `/futures/usdt/order_book` | **200** |
| `/futures/usdt/accounts` (unauth) | **400 `MISSING_REQUIRED_HEADER`** — real API |
| `fx-api-testnet.gateio.ws`, same moment | **502** |
| `fx-api-testnet.gateapi.io` (pattern-extrapolated guess) | **502** — do not use |

### Authored facts

- Testnet host **`https://api-testnet.gateapi.io/api/v4`**.
- Order endpoint `POST /api/v4/futures/{settle}/orders` (`settle` = `usdt` | `btc`).
- Auth **HMAC-SHA512**, headers `KEY` / `Timestamp` / `SIGN`; payload is 5 newline-joined fields
  `METHOD\nPATH\nQUERY\nSHA512_HEX(body)\nTIMESTAMP` — **body hashed even when empty**.
- `Timestamp` in **seconds**; `x-gate-exptime` in **milliseconds** (mixed units in one API).
- **`size` is a CONTRACT count, not coins** — 0.001 BTC = **10 contracts** at
  `quanto_multiplier 0.0001`. Direction is the **sign** of `size`; no `side` field exists.
- Official kit `gate-api` **7.2.100** on PyPI and npm, from the verified `gate` org.

### ⚠️ The caveat carried onto the public page

**`gate-api` 7.2.100 still ships the dead host as its SDK default** (Python *and* Go), and Gate
published no migration notice. A reader who accepts SDK defaults gets a 502 that reads like an
outage rather than a misconfiguration. The tutorial therefore names the working host explicitly,
shows the base-URL override, and does **not** call it "the official endpoint".

### Corrections to the W1 audit (§3 #6)

- The move was **User `gateio` → Organization `gate`**, not org→org (`api.github.com/orgs/gateio` → 404).
- "Archived the old SDK repos" is too broad: 6 were archived in a 26-minute batch on 2026-07-16, but
  `gateapi-php` / `csharp` / `java` / `js`, `rest-v4` and `WebSocket-API` were **not** — and
  `gate/rest-v4` does not exist at all.

---

## 3. MEXC — closed, on MEXC's own words

Verified first-hand from MEXC's API page, FAQ Q5:

> *"MEXC API connects directly to the live trading environment. We don't currently offer a sandbox or test environment."*

| Gating question | Answer | Evidence |
|---|---|---|
| Can a demo/testnet API key be minted? | **NO** | No API doc, changelog (22 entries 2021→2026), or announcement describes one. The futures integration guide names only `https://api.mexc.com`. |
| Is there a non-filling validation endpoint? | **NO** | All 38 documented Trade endpoints enumerated — none validates without placing. |

The asymmetry is deliberate, not a docs gap: MEXC **spot** ships `POST /api/v3/order/test`; futures
does not, and CCXT documents `params.test` as *"spot only"*. `futures.testnet.mexc.com` serves the
contract API (ping 200, 137 contracts, private routes 401) but appears in MEXC's **help-centre**
content only — **zero** API docs, **zero** hits in the `mexcdevelop` org. It is a UI-only retail
practice environment, not a developer sandbox.

**Why this closes rather than defers.** With neither a testnet nor a dry-run, a MEXC futures
execution tutorial could only instruct a reader to (a) place a **real, filling mainnet order with
real funds**, or (b) harvest a **browser session token** and replay MEXC's internal MD5 web-signing
scheme against an undocumented host — a technique whose entire third-party tooling ecosystem is
self-described "bypass" projects. Neither is publishable. Recorded with the verbatim statement so no
future wave re-probes a settled question.

*Note: my own probes could not decide this. All `/private/*` paths return an Akamai 403 from this
IP — including a deliberately bogus path — so endpoint existence is not probeable here. The verdict
rests on documentation, not on probe silence.*

MEXC's official SDK is **spot-only and abandoned** (last commit 2023-11-24, ~2.4 years before the
futures API launched; two still-open "does this support futures?" issues).

---

## 4. Probe log (verbatim, 2026-07-21)

```
api-testnet.gateapi.io/api/v4/futures/usdt/contracts?limit=1        HTTP:200
api-testnet.gateapi.io/api/v4/futures/usdt/contracts/BTC_USDT       HTTP:200  quanto_multiplier=0.0001 mark=66256.5
api-testnet.gateapi.io/api/v4/futures/usdt/tickers?contract=BTC_USDT HTTP:200
api-testnet.gateapi.io/api/v4/futures/usdt/order_book               HTTP:200
api-testnet.gateapi.io/api/v4/futures/usdt/accounts (unauth)        HTTP:400 MISSING_REQUIRED_HEADER
fx-api-testnet.gateio.ws/api/v4/futures/usdt/contracts   x4 + x6 burst + 2nd egress   HTTP:502 (all)
fx-api-testnet.gateio.ws/api/v4/{futures/btc,delivery/usdt}/contracts               HTTP:502
fx-api-testnet.gateio.ws/api/v4/{spot/currencies,wallet/total_balance}              HTTP:404 (router alive)
fx-api.gateio.ws/api/v4/futures/usdt/contracts (prod control)       HTTP:200
fx-api-testnet.gateapi.io (pattern guess)                           HTTP:502
api-testnet.gateio.ws · testnet.gateio.ws · *.gate.com              NXDOMAIN
status.gate.{com,io,ws}                                             NXDOMAIN
futures.testnet.mexc.com/api/v1/contract/ping                       HTTP:200
futures.testnet.mexc.com/api/v1/contract/detail                     HTTP:200  137 contracts, all apiAllowed
futures.testnet.mexc.com/api/v1/private/account/assets (unauth)     HTTP:401
contract.mexc.com/api/v1/private/order/*/test                       HTTP:403 Akamai (bogus path: identical 403)
contract.mexc.com/api/v1/contract/detail                            HTTP:200  1009 contracts, 989 apiAllowed
```

---

## 5. Follow-ups

| Item | State |
|---|---|
| Gate.io | **RESOLVED** — shipped this wave. Re-verify the host if the page is ever regenerated; Gate announced nothing and may migrate again. |
| MEXC | **CLOSED** for execution tutorials. A read-only market-data page or a **spot** tutorial (spot has a real dry-run) would be defensible if ever wanted — separate scope. |
| Phemex | **Operator decision still open** — ToS §7.2 commercial-API-use bar. Primitives verified in W1. |
| HTX | **Closed** on geography (US + UK + all EU + SG + HK barred from all services), not on primitives. |
