# OPS-INTEGRATIONS-VENUE-PAGES-W1 — endpoint truth

**Access date: 2026-07-21** (host UTC agreed with an independent HTTP `Date` header).
**Anchors:** `crypto-quant-signal-mcp` @ `c1197fc` · `algovault-skills` @ `e45c185`.
**Method:** per venue, official developer docs cross-referenced ≥2 ways, then every load-bearing
primitive **re-probed live from this box**. Verdicts are `FULL` / `TESTNET-REST` / `NO-TESTNET` /
`UNVERIFIED`. A venue without an honest testnet does not get an execution tutorial — it is HALTed,
never papered over with a fabricated host.

---

## 1. Verdict table

| # | Venue | Testnet host | My live probe | Order endpoint | Auth | Official kit | VERDICT | Shipped? |
|---|---|---|---|---|---|---|---|---|
| 1 | Hyperliquid | `api.hyperliquid-testnet.xyz` | `/info` **405**, `POST /exchange` **422** (alive, rejects unsigned) | `POST /exchange` | EIP-712, `chainId 1337`, phantom-agent `source` a/b | ✅ `hyperliquid-python-sdk` **0.24.0**, 1,758★ (PyPI) | **FULL** | ✅ with precondition note |
| 2 | Aster | `fapi.asterdex-testnet.com` | `/fapi/v1/ping` **200**; `/fapi/v3/order` **400 `-1102 nonce`** (route alive) | `POST /fapi/v3/order` | EIP-712, `chainId` **714** test / 1666 main | ❌ none published — `pip install aster-connector-python` → **PyPI 404** | **TESTNET-REST** | ✅ git-install only |
| 3 | BingX | `open-api-vst.bingx.com` | contracts **200**, 855 contracts | `POST /openApi/swap/v2/trade/order` (+ `/order/test`) | HMAC-SHA256, `X-BX-APIKEY`, ms | ❌ none (org ships an AI-skills bundle, not an SDK) | **TESTNET-REST** | ✅ |
| 4 | KuCoin | — sandbox **retired 2023-07-10** | `api-sandbox-futures` + `api-sandbox` **NXDOMAIN** (`dig`) | `POST /api/v1/orders` · dry-run `POST /api/v1/orders/test` | `KC-API-*`, HMAC'd passphrase, `KEY-VERSION: 3` | ✅ `kucoin-universal-sdk` **1.3.1** (npm + PyPI) | 🛑 **NO-TESTNET** | ✅ **adapted** — validation-only page |
| 5 | Gate.io | `fx-api-testnet.gateio.ws/api/v4` | **502 on every public read**, 6 probes over 25 min, 2 networks; prod **200** | `POST /api/v4/futures/{settle}/orders` | HMAC-**SHA512**, 5-line payload, **seconds** | ✅ `gate-api` **7.2.100** (PyPI + npm) | **FULL — testnet DEGRADED** | ⏸️ deferred |
| 6 | Phemex | `testnet-api.phemex.com` | `/public/products` **200**, `/g-orders` **401** (auth-gated, alive) | `PUT /g-orders/create` (linear) | `x-phemex-access-token` + HMAC-SHA256 | ✅ `phemex-cli` 2.0.0 (npm; 0★) | **TESTNET-REST** | 🛑 skipped — ToS |
| 7 | HTX | — docs section titled **"Testnet (Stopped)"** | — | `POST /linear-swap-api/v1/swap_order` | query-string `HmacSHA256`, `SignatureVersion=2` | GitHub-only, derivatives repos stale | 🛑 **NO-TESTNET** | 🛑 skipped — geo |
| 8 | MEXC | — none documented | `contract.mexc.com` **200**; `/private/order/submit` **403** (Akamai) | `POST /api/v1/private/order/create` on `api.mexc.com` | HMAC-SHA256, `ApiKey`/`Request-Time`/`Signature` | ❌ official SDK is **spot-only** | 🛑 **NO-TESTNET** | ⏸️ deferred |

**Shipped N = 4** (hyperliquid, aster, bingx, kucoin). Architect-resolved 2026-07-21.

---

## 2. Why each non-shipped venue was HALTed

- **HTX — skipped.** Its own docs carry a section headed *"Testnet (Stopped)"*. Independently, HTX's
  Platform User Agreement §1.2 bars **the US, UK, every EU member state, Singapore, Hong Kong and
  mainland China** from *all services* — I fetched and verified that list verbatim. A page whose entire
  addressable readership is prohibited is a discovery liability, not an asset.
- **Phemex — skipped.** Testnet is genuinely live (I probed it). But ToS §7.2 reads: *"You agree to not
  use the API or data provided through the API for any other commercial purpose."* AlgoVault is a
  commercial product; §1.26 additionally restricts the US, UK and Australia. Publishing a tutorial that
  routes commercial usage into that API is a licensing judgment, and it was escalated rather than taken
  unilaterally.
- **MEXC — deferred.** Notably its reputation has **inverted**: mainnet futures order placement, closed
  since 2022, **re-opened 2026-03-31** (989 of 1009 contracts carry `apiAllowed: true`). But no MEXC doc
  names a testnet API host. An undocumented host (`futures.testnet.mexc.com`) does serve the API and
  401s on private routes, so a demo key *may* be mintable — that check is the deferral.
- **Gate.io — deferred.** The only venue held for a purely operational reason. Its testnet market-data
  plane returned 502/504 on every public read across 6 probes spanning 25 minutes and two separate
  networks, while the order-routing plane answered normally. A Gate tutorial must read
  `quanto_multiplier` (Gate sizes orders in **contracts**, not coins) from exactly the endpoint that is
  down. Re-probe before authoring.

---

## 3. Corrections this verification produced

Facts that were wrong in circulation and are now pinned:

1. **`pip install aster-connector-python` does not work** — PyPI returns 404, though Aster's own README
   prints that command. Install is git-only.
2. **Aster V1 API-key creation closed 2026-03-25.** A new reader cannot obtain the simple HMAC
   credentials at all, so any V1-based tutorial is unfollowable. The page targets V3 EIP-712.
3. **`aster.exchange` does not resolve.** The canonical domain is `asterdex.com`.
4. **Hyperliquid's testnet faucet requires a prior mainnet deposit** from the same address — a clean
   wallet cannot self-fund, which quietly breaks the usual "start from zero" tutorial promise.
5. **Hyperliquid ToS §1.6** (updated 2026-06-15) names the US and Ontario as Restricted Persons barred
   from the Interface — and the faucet lives on the Interface. §1.9 forbids location-disguising, so no
   VPN workaround may be suggested.
6. **Gate.io migrated its GitHub org `gateio` → `gate` and archived the old SDK repos on 2026-07-16.**
   Star counts now mislead: the archived Python SDK shows 345★ against the live one's 23★. PyPI/npm
   `gate-api` already point at the new org.
7. **Every legacy per-language KuCoin SDK is archived**, several with more stars than the live
   `kucoin-universal-sdk`. Sorting by popularity picks dead code.
8. **BingX VST symbols are normal** (`BTC-USDT`), not `-VST`-suffixed — and the VST universe is a strict
   subset of live (855 vs 910), so a symbol can exist live and not in demo.

---

## 4. Repo-side blockers found and fixed in the same wave

- **A regen would have reverted the previous wave.** `_template.md` and all 11 tutorial sources still
  carried `89.4%` / `56,375` / the dead `data-tr-field="signal_count"` hook, and
  `render-integrations.mjs` passes body content through raw. Running the generator — which this wave
  had to do — would have re-introduced exactly what OPS-INTEGRATIONS-LIVE-SOT-W1 removed and turned its
  drift canary red. Fixed at both ends: sources corrected upstream, and `normaliseTrackRecordBody()`
  makes the generator the single normalisation point so no future upstream edit can re-leak the class.
- **Every demo in `algovault-skills` was broken.** Verified by running them, not grepping them.
  (a) The shared helper threw on a missing `mcp-session-id` header, which a **stateless** transport
  never sends — so every demo died at its first AlgoVault call. (b) The verdict's direction field is
  `call` on the wire; the helper read `parsed.signal`, always `undefined`, so every demo's
  `signal === 'BUY'` policy check was permanently false and no demo could reach its execution branch.
  Both are now fixed and locked by regression tests.
- **Public copy used a deprecated alias.** Templates called `get_trade_signal`; canonical is
  `get_trade_call`.

---

## 5. Live probe log (verbatim, 2026-07-21)

```
https://api.hyperliquid-testnet.xyz/info                       HTTP:405
POST https://api.hyperliquid-testnet.xyz/exchange (unsigned)   HTTP:422
https://fapi.asterdex-testnet.com/fapi/v1/ping                 HTTP:200
https://fapi.asterdex-testnet.com/fapi/v3/order  {"code":-1102,"msg":"Mandatory parameter 'nonce' ..."}  HTTP:400
https://pypi.org/pypi/aster-connector-python/json              HTTP:404   <- official README's install command
https://aster.exchange                                         HTTP:000   <- does not resolve
https://open-api-vst.bingx.com/openApi/swap/v2/quote/contracts HTTP:200   (855 contracts)
dig api-sandbox-futures.kucoin.com                             NXDOMAIN
dig api-sandbox.kucoin.com                                     NXDOMAIN
https://api-futures.kucoin.com/api/v1/timestamp                HTTP:200
https://fx-api-testnet.gateio.ws/api/v4/futures/usdt/contracts  HTTP:502  (x6 over 25 min, 2 networks)
https://fx-api.gateio.ws/api/v4/futures/usdt/contracts          HTTP:200  (prod control)
https://testnet-api.phemex.com/public/products                 HTTP:200
https://testnet-api.phemex.com/g-orders (unauth)               HTTP:401
https://contract.mexc.com/api/v1/contract/detail               HTTP:200
https://api.hbdm.com/linear-swap-api/v1/swap_contract_info      HTTP:200
github.com/gateio/gateapi-python                               archived=True  stars=345
github.com/gate/gateapi-python                                 archived=False stars=23
pypi gate-api 7.2.100 · npm gate-api 7.2.100 · npm kucoin-universal-sdk 1.3.1
pypi hyperliquid-python-sdk 0.24.0
```

---

## 6. Follow-ups

| Wave | Scope |
|---|---|
| `OPS-INTEGRATIONS-VENUE-PAGES-W2` | Gate.io (re-probe testnet first) + MEXC (confirm a demo API key can be minted against `futures.testnet.mexc.com`). |
| operator decision | Phemex — whether a reader-run educational tutorial constitutes "commercial purpose" under ToS §7.2. |
| — | HTX: no action. Skipped on geography, not on primitives. |
