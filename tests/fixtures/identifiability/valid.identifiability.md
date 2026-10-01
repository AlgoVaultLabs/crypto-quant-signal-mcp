# FIXTURE: a valid §4c section

Not a registration (OPS-PREREG-IDENTIFIABILITY-GATE-W1). It declares the same 3.0pp floor as `trigger-a.identifiability.md`, sized against an arm whose minority side carries 20% of its rows. 2m = 40.0pp, so the floor is reachable and the gate must accept the section. The registry-surface twin is `valid.site.json`.

## 6. Identifiability (PROCEDURE §4c)

| comparison | arm | minority-side share m (cardinality, with probe) | declared floor (pp) | bound 2m (pp) | verdict |
|---|---|---|---|---|---|
| within-arm excess over the mix-matched null | the arm under test | 0.2, `count(*) FILTER (WHERE side = 'SELL') / count(*)` over the arm's scored rows | 3.0 | 40.0 | IDENTIFIABLE |

## 7. Next section
