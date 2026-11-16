# FIXTURE: a registration that does not declare a served-rule study

Not a registration (OPS-PREREG-SERVED-RULE-GATE-W1). It discusses the regime rule in `src/lib/market-regime-core.ts` and even names MARKET_REGIME_RULE_VERSION = 2 in prose, but it carries no line that STARTS with the declaration. The trigger is declared, never sniffed: a mention such as "this is not a SERVED_RULE_STUDY: it reads a cardinality only" sits mid-line, so PROCEDURE §4d does not apply and the gate must return `applies: false` although neither §4d section is present.

## 1. Corpus

A cardinality probe only; no served rule is scored.

## 2. Next section
