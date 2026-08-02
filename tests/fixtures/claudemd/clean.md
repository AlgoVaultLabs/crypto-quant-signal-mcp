# fixture: all-true prescriptive claims — zero firings expected, and enough claims to defeat vacuity

The meta-canary `scripts/check-canaries-wired.mjs` is wired into `deploy.yml`.
Release preflight reads `package.json` and curates `README.md` before any publish.
The pre-push gate is `check_test_baseline.sh`.
⚠️ `lib/never-built-thing.mjs` DOES NOT EXIST — never built; do not cite it as a live gate.
