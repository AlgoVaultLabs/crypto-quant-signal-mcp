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
| `UNSERVABLE.json` | Pairs the served lookup calls native but the venue does not serve. Each has a reason, and the suite skips them. |
| `CONTROLS.json` | The venue's own history page anchored on the served step, for every window the adapter returned incomplete. It is what separates an adapter defect (C1) from a venue reach limit. |
| `VANTAGES.json` | For each scenario, the vantages whose replay of the same adapter requests agrees on served grid, phase and error class. |
| `MODEL-PROBES.json` | Raw boundary probes (off-grid `endTime`/`startTime`/`after`/`before`, Bitget's 90-day `/candles` window) plus the young coins' listing instants, used by the synthetic venue and its fidelity test. |
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

`capture-remote.js` covers a venue that the capture vantage cannot reach: the adapter builds the request dry, another host fetches the body, and the adapter parses it.

For a second vantage, build the request list with `vantage-list.js`, fetch it on the other host with `vantage-fetch.sh`, then run `vantage-compare.js`.

Only `measure.mts --write` rewrites `BASELINE.json` / `REACH.json`. Review its diff before committing it.
