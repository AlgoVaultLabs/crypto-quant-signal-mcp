# FIXTURE: a declaration that names no rule source path

Not a registration (OPS-PREREG-SERVED-RULE-GATE-W1). It is `compliant.md` with ONE defect: its declaration names no rule source path ending .ts or .py, so the gate must fail the declaration. Every key, dial and floor is illustrative and carries no figure from any corpus.

SERVED_RULE_STUDY: the market regime rule · MARKET_REGIME_RULE_VERSION = 2

## 5. Answer-key ceiling (PROCEDURE §4d)

| key | role | construction | reading if it fails |
|---|---|---|---|
| A | CEILING | the true regime, dated in hindsight from the bars on both sides of each call | NO_ROOM: nothing to find, so no change to the rule can beat its baselines |
| B | NO_LAG | the served rule's own inputs on a window centred on the call, so it sees bars after the call | INPUTS: the ceiling wins and the inputs cannot reach it, so the inputs are the defect |
| S | SERVED | the label the caller received, at the rule version declared above | LAG: the centred inputs win and the live label does not, so the lag is the defect |

Diagnoses: `NO_ROOM` (CEILING fails), `INPUTS` (CEILING wins, NO_LAG fails), `LAG` (NO_LAG wins, SERVED fails).

## 6. Component map (PROCEDURE §4d)

| slice | dial | works | broken | too little data |
|---|---|---|---|---|
| calls labelled trending | `EXAMPLE_TREND_DIAL` | beats every registered baseline on the slice | loses to the best registered baseline on the slice | fewer than 20 independent days on the slice |
| calls labelled volatile | the `'EXAMPLE_VOLATILE'` literal | beats every registered baseline on the slice | loses to the best registered baseline on the slice | fewer than 20 independent days on the slice |

## 7. Next section
