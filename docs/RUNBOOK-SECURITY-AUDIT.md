# RUNBOOK — Security Audit & Continuous Canary

**Owner:** AlgoVault Labs · **Origin:** `SECURITY-AUDIT-RECENT-FEATURES-W1` (2026-06-07). **Audience:** META / internal ops.
Turns the one-off security audit into a repeatable one-command posture check. Pairs with `scripts/security-canary.mjs` and the audit dir `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/`.

---

## 1. One-command posture check (run anytime, read-only)

```bash
cd ~/code/crypto-quant-signal-mcp
npm ci                 # ensure node_modules matches the lockfile (audit gate reads it)
rm -rf dist && npm run build   # the SSRF gate imports the REAL compiled guard at dist/lib/webhook-ssrf.js
node scripts/security-canary.mjs        # all 3 gates
```

Exit codes: **0** = all gates pass · **1** = a gate FAILED (a real finding) · **2** = inconclusive (e.g. `dist/` not built).
Flags: `--check=audit|pii|ssrf` (one gate) · `--diff` (PII gate scans `git diff HEAD` only — use as a pre-commit/PR gate) · `--json` (machine-readable).

### The three gates (each retires a bug CLASS from the audit)
| Gate | What it asserts | Fails when |
|---|---|---|
| **A · npm-audit** | No High/Critical advisory in the x402 payment-dep family (`@coinbase/x402`, `@x402/*`, `x402`); `@x402/svm` absent or ≥2.6.0 (GHSA-qr2g-p6q7-w82m) | a payment dep goes vulnerable, or the Solana verifier is added unpatched |
| **B · PII/secret leak** | No `outcome_return_pct`/`outcome_price`/Phase-E as a serialized **value** (`/"outcome_return_pct":\s*[-\d.]/`), and no `whsec_`/CDP/Databento/PEM/bearer literal, in any builder or `git diff` | a public response builder serializes an internal field, or a secret literal lands in tracked source |
| **C · SSRF egress matrix** | The real `webhook-ssrf` guard rejects the full block-class matrix (metadata, loopback, RFC1918, CGNAT, IPv6 ULA/link-local, **IPv4-mapped IPv6**, embedded creds, non-https) | a block class regresses. Hostnames + alt-encodings are reported as *defer-to-resolve* (async layer's job), not failures |

> **Expected state today (until `OPS-WEBHOOK-SSRF-IP-PIN-W1` lands):** Gate C is **RED on `IPv4-mapped IPv6`** (finding WH-02) and notes the DNS-rebind class (WH-01). This is intentional — the canary already encodes the desired end-state and flips GREEN when the fix ships. Do **not** wire it to a blocking CI step before then (see §3).

---

## 2. Full forensic audit (the deeper, periodic pass)

Cadence (per CLAUDE.md): before any payment-path release · after each new exchange adapter · monthly during active dev · quarterly otherwise. Run as a READ-ONLY agent team (one auditor per area + a lead), writing ONLY under `audits/<WAVE>/`:

1. **Step 0** — confirm canonical clone at `origin/main`; existence-probe every scope file (`ls`+`grep`); live read-probe reachability; write `endpoint-truth.md`. HALT only if ≥3 scope files are fictional or a probe can't be read-only.
2. **Per-area auditors** (parallel, independent): x402 payment path · webhook/SSRF egress · equities data-integrity · shadow-venue + adapters. Each: read code, `git log -p -S` for secrets, live-probe, build self-contained PoCs under `poc/` (never import-mutate `src/`), write `areaN-*.md`.
3. **Lead/consolidate:** full-tree `npm audit` + onchain-blocklist transitive check; full-history secret sweep; `npm test` baseline (currently **16 fail / 1808 pass / 6 skip** at HEAD — *artifact baseline*, treat any NEW failure as wave-caused); output-shape + authn/z matrices; consolidate into `<WAVE>.md` with a severity matrix + P0→Reject backlog (a follow-up wave ID per finding).

### Severity rubric
CRITICAL = unauth → fund loss / RCE / internal-network reach / secret disclosure / public leak of internal data (`outcome_return_pct`/Phase-E). HIGH = exploitable w/ conditions (payment bypass, SSRF-to-internal, authz/IDOR, key-in-logs). MEDIUM = needs chaining (DoS, info leak, missing rate-limit). LOW = hardening. INFO = note.

### Prod read-only probes (authorized, run as root on Hetzner)
```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
  'docker exec crypto-quant-signal-mcp-mcp-server-1 cat /proc/1/environ | tr "\0" "\n" | grep -E "CDP_API_KEY|DATABENTO"'   # present in env…
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
  'docker logs crypto-quant-signal-mcp-mcp-server-1 2>&1 | grep -ciE "CDP_API_KEY|DATABENTO|whsec_|Bearer "'                # …absent from logs (expect 0)
```
Containers: `…-mcp-server-1` (CDP+Databento env), `…-postgres-1`, `…-facilitator-1` (x402 facilitator).

---

## 3. Wiring the canary into CI (follow-up `OPS-SECURITY-CANARY-CI-WIRE-W1`)

After the P0 webhook fix lands (so Gate C is GREEN), add a step to `.github/workflows/deploy.yml` (mind `paths-ignore`):
```yaml
      - name: Security canary
        run: |
          npm run build
          node scripts/security-canary.mjs
```
Until then, run it manually / in a non-blocking job. **The PII gate (`--diff`) is safe to wire as a blocking pre-merge check now** — it is GREEN today and catches the data-integrity leak class on every diff.

## 4. Adding a new gate / block-class
- **New forbidden public field** → add to the `LEAK_VALUE` regex in `security-canary.mjs` (Gate B) + a `forbidden_keys` row in the endpoint's `audits/*-shape-snapshot`.
- **New SSRF class** → add a row to `MUST_BLOCK` (sync-owned: literal IPs/schemes/creds) or `DEFER_TO_RESOLVE` (hostnames/alt-encodings) in Gate C.
- **New payment dep** → add to `X402_FAMILY` in Gate A.
- Always pair a new gate with a finding + a follow-up wave ID, per the audit schema.
```
ID · severity · area · file:line · exploit scenario · evidence (probe/PoC) · generator-level fix · follow-up wave ID
```
