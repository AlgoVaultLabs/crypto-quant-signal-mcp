# FIXTURE: trend-mode trigger A, as PROCEDURE §4c would have read it on 2026-08-31

Not a registration (OPS-PREREG-IDENTIFIABILITY-GATE-W1). `SIGNAL-TREND-MODE-ENABLE-W1` declared a 3.0pp floor on the cross-arm excess delta "v2 vs v1". The v1 arm emitted SELL on 149 of 28,144 scored rows, a minority share of 0.0053, so its 2m bound is 1.06pp and it can never show a 3.0pp move. Read at declaration, the v1 row is `NOT_IDENTIFIABLE`. The v2 row binds nothing, because the narrower arm binds. The counts are the ones `ops/monitoring/population_comparison.py`'s self-test already carries. The gate's self-test also rewrites the v1 verdict to the naive `IDENTIFIABLE` it would have been declared with, and requires the gate to refuse that. The registry-surface twin is `trigger-a.site.json`.

## Identifiability

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| trigger A: v2 excess minus v1 excess | v1 (TREND_MODE off) | 0.0053, `count(*) FILTER (WHERE side = 'SELL') / count(*)` over the v1 arm's scored rows = 149 / 28,144 | 3.0 | 1.06 | NOT_IDENTIFIABLE → restated as the within-arm test of v2's daily excess over its own mix-matched null |
| trigger A: v2 excess minus v1 excess | v2 (TREND_MODE on) | 0.1946, the same probe over the v2 arm's scored rows = 2,826 / 14,519 | 3.0 | 38.92 | IDENTIFIABLE |

## After

Anything below the section is outside it.
