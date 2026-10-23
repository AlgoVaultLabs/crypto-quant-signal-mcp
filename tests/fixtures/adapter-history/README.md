# Adapter history fixtures (OPS-ADAPTER-HISTORY-ANCHOR-W1)

These fixtures feed `tests/unit/adapter-history-contract.test.ts`. Candles are not labels. Every scenario was captured **through the shipped adapter**: the adapter built its own request URLs and parsed the venue's own bodies. On replay, `tests/harness/adapter-history-model.ts` serves those bodies back to the same requests.

Bitget and OKX work differently since CH2. CH2 re-anchors their history request, so a captured body no longer answers it. Those two venues are answered by the parametric venue in `tests/harness/adapter-history-synthetic.ts`. The model is trusted only because it reproduces **every** captured Bitget/OKX page: `tests/unit/adapter-history-synthetic-fidelity.test.ts`. `retired/` pins the pre-CH2 Bitget/OKX `getCandles` bodies verbatim for the differential and budget suites.

## Files

| File | What it is |
|---|---|
| `<VENUE>.json` | One file per promoted venue. For every cron timeframe it holds two scenarios. **R** is the recent page: `from = now − (2W+1)·s`, no `endTime`, as serving calls it. **D** is a deep window: `from = now − (200+2W+6)·s`, `to = from + 2W·s`, beyond every venue's recent reach. `s` is the adapter's served step and `W` is `EVAL_CANDLES[tf]`. The BITGET and OKX files add `extras`: **E** is a young coin's pre-listing window (C3), and **D2** is a deeper window (BITGET 2h/8h). |
| `UNIVERSE.json` | The contract universe (OAH-Q9): promoted venues × faithful cron timeframes, plus the served≠requested pairs outside it. The promoted set is read from the `venues` table and pinned here. |
| `BASELINE.json` | The measured EDIT-class violations (OAH-Q1): C1 with disposition `fix`, C3 with disposition `report`. CH1 pinned them (BITGET 2h/8h C1, BITGET/OKX C3). CH2 emptied the list: the anchor now uses the served step, and the substitution is reported through the page's `meta`. |
| `REACH.json` | The measured REPORT-class page facts per pair and scenario: front gap, holes, head gap, out-of-range, off-grid. **If a venue changes its reach, the suite goes red. Update this file consciously; never absorb the change.** It is also the LIVE canary's expectation set: `ops/monitoring/adapter-history-contiguity-canary.sh` reads it (with `UNSERVABLE.json`) from the deployed checkout every night, so a change here changes what the canary pages on. |
| `UNSERVABLE.json` | Empty since OPS-SERVED-CANDLE-TRUTH-W1 CH2. It held the two pairs the served lookup called native but the venue did not serve (OKX/8h, BYBIT/8h). They left their adapters' interval maps, so the adapter now refuses them with `TimeframeUnservedError` before any request, and their R/D, vantage and S scenarios left these fixtures (last held at `809301a8`). A pair a venue will not serve is removed from the adapter's map, never declared here: the contract suite's served-map truth test fails on any mapped timeframe without captured evidence. The file stays because the live canary reads it. |
| `CONTROLS.json` | The venue's own history page anchored on the served step, for every window the adapter returned incomplete. It is what separates an adapter defect (C1) from a venue reach limit. |
| `VANTAGES.json` | For each scenario, the vantages whose replay of the same adapter requests agrees on served grid, phase and error class. |
| `MODEL-PROBES.json` | Raw boundary probes (off-grid `endTime`/`startTime`/`after`/`before`, Bitget's 90-day `/candles` window) plus the young coins' listing instants, used by the synthetic venue and its fidelity test. |
| `SERVING.json` | Contract-suite scenario **S** (OPS-SERVED-CANDLE-TRUTH-W1 CH1): every serving window `SERVING_WINDOWS` declares (`src/lib/serving-windows.ts`), on every faithful (venue, tf) of the 13 replay venues, read through the adapter with no `endTime`: `from = now − window`, one scenario per distinct window span. BITGET and OKX run S on the synthetic venue. The suite re-derives the window set from the registry, so a window change reddens S until every venue is recaptured for it. |
| `PHEMEX-LIVE-PRICE.json` | OPS-SERVED-CANDLE-TRUTH-W1 CH3a (Cowork Q8): PHEMEX is the declared closed-only kline venue (`CLOSED_ONLY_KLINE_VENUES`, `src/lib/live-price.ts`). Its 1h kline page and its 24hr ticker, read back to back: the page ends on forming − 1, the ticker is fresh, and `livePriceOf` prices the call at the ticker's `closeRp`, never the last close. Contract-suite S replays it. Recapture: `node tests/fixtures/adapter-history/tools/capture-phemex-live.js tests/fixtures/adapter-history/PHEMEX-LIVE-PRICE.json`. |
| `retired/*.ts` | The pre-CH2 Bitget/OKX `getCandles`, pasted verbatim. Never edit these. |
| `SHA256SUMS` | Pins every file in this directory. The chapter gate checks it with `sha256sum -c` or `shasum -a 256 -c`. |

## How the bodies are sanitized

Bodies stay venue-shaped, because the replay feeds each adapter its own parser. Candle rows older than `from − 2·s` are dropped, since no adapter can return them.

A scenario is kept trimmed only if replaying the trimmed bodies reproduces the recorded adapter output exactly. Otherwise it stays untrimmed and `sanitize.js` says so.

A transport failure that `upstreamFetch` retried is collapsed to the retry, because the replay stands in for `upstreamFetch`. The collapsed count is kept in `transportRetries`.

`replayToleranceMs` is the only slack a clock-derived time parameter gets on replay. An anchor the adapter derives from `from` or `to` has to match exactly.

## Recapturing (read-only public klines, paced)

Run from a checkout whose `dist/` is built from the code under test:

```sh
node tests/fixtures/adapter-history/tools/capture.js "$PWD" /tmp/ah/raw          # R + D, every promoted venue × cron tf
node tests/fixtures/adapter-history/tools/capture-extras.js "$PWD" /tmp/ah/raw   # E, D2, CONTROLS, MODEL probes
node tests/fixtures/adapter-history/tools/sanitize.js "$PWD" /tmp/ah/raw tests/fixtures/adapter-history "$(git rev-parse HEAD)"
node tests/fixtures/adapter-history/tools/assemble.js "$PWD" /tmp/ah/raw tests/fixtures/adapter-history <venues-read-at>
npm run build && npx tsx tests/fixtures/adapter-history/tools/measure.mts                            # print the measurement
```

Scenario S has its own capture, sanitized by the same rule (`sanitize.js`) once every scenario is captured:

```sh
node tests/fixtures/adapter-history/tools/capture-serving.js "$PWD" tests/fixtures/adapter-history "$(git rev-parse HEAD)"              # SERVING.json, ~23 min
node tests/fixtures/adapter-history/tools/capture-serving.js "$PWD" tests/fixtures/adapter-history "$(git rev-parse HEAD)" WEEX --merge # recapture one venue into it
```

`--merge` replaces only the named venues' scenarios and records the recapture in the file's `recaptures` header; every other venue stays byte-for-byte. A scenario that errored at capture (a timeout, a rate limit) reddens S, so recapture that venue rather than editing the file.

`capture-remote.js` covers a venue that the capture vantage cannot reach: the adapter builds the request dry, another host fetches the body, and the adapter parses it.

For a second vantage, build the request list with `vantage-list.js`, fetch it on the other host with `vantage-fetch.sh`, then run `vantage-compare.js`.

Only `measure.mts --write` rewrites `BASELINE.json` / `REACH.json`. Review its diff before committing it.
