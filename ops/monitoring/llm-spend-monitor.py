#!/usr/bin/env python3
# OPS-LLM-SPEND-MONITOR-W1 — weekly rolling-30d LLM spend guardrail.
#
# Computes spend-to-date per LLM provider from AlgoVault's OWN telemetry (no provider
# billing API — those inference keys can't read balance; see status.md 2026-06-02), and
# alerts via /opt/algovault-monitoring/send_telegram.sh ONLY if a provider's rolling-30d
# spend exceeds THRESHOLD_USD. Reads (SELECT-only, role algovault_autopilot via host
# 127.0.0.1:5432):
#   - chat spend: EXACT, SUM(cost_usd_e6)/1e6 from chat_analytics_events (already priced).
#   - GEO spend:  ESTIMATE, COUNT(*) per model from geo_query_runs × a flat per-call $ table
#                 (dominated by the web_search/grounding per-call fee; token cost folded in).
#
# Contract (CLAUDE.md ## Automation-first recovery → Operator-action-required alert contract):
#   severity=CRITICAL_PERSISTENT, 24h cooldown per alert_id (wrapper-enforced), fail-open exit 0,
#   recommended_wave template OPS-LLM-SPEND-MONITOR-W{NEXT} (resolved by the wrapper from status.md).
#   Spend is ALWAYS logged (forensic); TG only on threshold breach. NO completion TG.
#
# Flags: --dry-run (DRY_RUN_TG=1 for the wrapper — safe manual run / synthetic verify);
#        --threshold <usd> (override THRESHOLD_USD, e.g. to exercise the alert path in a smoke).
import os
import sys
import subprocess
from collections import defaultdict

WINDOW_DAYS = 30
THRESHOLD_USD = 10.0  # per provider, rolling 30d
CREDS = "/opt/algovault-monitoring/autopilot-pg-creds"  # PGPASSWORD=... (role algovault_autopilot)
PG_ROLE = "algovault_autopilot"
PG_DB = "signal_performance"
WRAPPER = "/opt/algovault-monitoring/send_telegram.sh"
ALERT_ID = "LLM_SPEND_OVER_THRESHOLD"
LOG = "/var/log/llm-spend-monitor.log"

# Flat per-call USD estimate keyed by the model string written to geo_query_runs.model.
# Dominated by each engine's web_search / grounding per-call fee + a small token component.
# Adjust here as vendor pricing changes (manifest-style — no other code change).
GEO_CALL_USD = {
    "claude-haiku-4-5-20251001": 0.012,  # Anthropic web_search ~$0.01/search + haiku tokens
    "sonar": 0.006,                      # Perplexity ~$5/1K requests + tokens
    "gpt-4.1-mini": 0.011,               # OpenAI web_search $0.01 + gpt-4.1-mini tokens
    "gemini-2.5-flash": 0.014,           # Gemini grounding ~$14/1K (conservative; free tier may be $0)
}
# Every GEO retrieval call (any engine) triggers one Anthropic Haiku judge/extractor call.
JUDGE_USD_PER_GEO_CALL = 0.001

ANTHROPIC = "Claude (Anthropic)"


def provider_of(model: str) -> str:
    m = (model or "").lower()
    if m.startswith("claude"):
        return ANTHROPIC
    if m.startswith("sonar") or "perplexity" in m:
        return "Perplexity"
    if m.startswith("gpt") or m.startswith("o1") or m.startswith("o3") or m.startswith("chatgpt"):
        return "OpenAI (ChatGPT)"
    if m.startswith("gemini"):
        return "Gemini"
    return "unknown:" + model


def now_iso() -> str:
    return subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip()


def log(msg: str) -> None:
    line = f"{now_iso()} [{ALERT_ID}] {msg}\n"
    try:
        with open(LOG, "a") as f:
            f.write(line)
    except OSError:
        pass
    print(line, end="")


def pgpassword() -> str:
    with open(CREDS) as f:
        for ln in f:
            if ln.startswith("PGPASSWORD="):
                return ln.split("=", 1)[1].strip()
    raise RuntimeError("PGPASSWORD not found in creds")


def psql(sql: str, pw: str) -> str:
    env = dict(os.environ, PGPASSWORD=pw)
    r = subprocess.run(
        ["psql", "-h", "127.0.0.1", "-p", "5432", "-U", PG_ROLE, "-d", PG_DB, "-tAc", sql],
        capture_output=True, text=True, env=env, timeout=30,
    )
    if r.returncode != 0:
        raise RuntimeError(f"psql rc={r.returncode}: {r.stderr.strip()[:200]}")
    return r.stdout.strip()


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    threshold = THRESHOLD_USD
    if "--threshold" in sys.argv:
        try:
            threshold = float(sys.argv[sys.argv.index("--threshold") + 1])
        except (ValueError, IndexError):
            pass

    try:
        pw = pgpassword()
        chat_usd = float(psql(
            f"SELECT COALESCE(SUM(cost_usd_e6)/1000000.0, 0) FROM chat_analytics_events "
            f"WHERE recorded_at > now() - interval '{WINDOW_DAYS} days';", pw) or "0")
        geo_rows = psql(
            f"SELECT model, count(*) FROM geo_query_runs "
            f"WHERE ran_at > now() - interval '{WINDOW_DAYS} days' GROUP BY model;", pw)
    except Exception as e:  # fail-open: never break the cron
        log(f"FRAMEWORK_ERROR (fail-open exit 0): {e}")
        return 0

    spend = defaultdict(float)
    breakdown = defaultdict(list)
    total_geo_calls = 0
    for ln in [l for l in geo_rows.splitlines() if l.strip()]:
        try:
            model, cnt_s = ln.split("|")
            cnt = int(cnt_s)
        except ValueError:
            continue
        total_geo_calls += cnt
        per_call = GEO_CALL_USD.get(model)
        prov = provider_of(model)
        if per_call is None:
            log(f"UNKNOWN_GEO_MODEL (priced $0): {model} ({cnt} calls)")
            per_call = 0.0
        spend[prov] += cnt * per_call
        breakdown[prov].append(f"{cnt}×{model}@${per_call:.3f}")

    # Anthropic also bears: exact chat cost + the judge/extractor call per GEO call.
    judge_usd = total_geo_calls * JUDGE_USD_PER_GEO_CALL
    spend[ANTHROPIC] += chat_usd + judge_usd
    breakdown[ANTHROPIC].append(f"chat ${chat_usd:.4f}")
    breakdown[ANTHROPIC].append(f"judge {total_geo_calls}×${JUDGE_USD_PER_GEO_CALL:.3f}")

    summary = " | ".join(f"{p}=${spend[p]:.4f}" for p in sorted(spend))
    log(f"SPEND_30D ({WINDOW_DAYS}d, threshold ${threshold:.2f}/provider): {summary}")

    over = {p: v for p, v in spend.items() if v > threshold}
    if not over:
        log(f"OK — all providers under ${threshold:.2f}/30d; no alert.")
        return 0

    # Threshold breach -> build contract body + feed to wrapper (severity + cooldown + DRY_RUN gated there).
    body_lines = [
        f"🛑 {ALERT_ID} [rolling-{WINDOW_DAYS}d LLM spend over ${threshold:.0f}/provider]",
        "",
    ]
    for p in sorted(over):
        body_lines.append(f"{p}: ${spend[p]:.2f} / {WINDOW_DAYS}d (threshold ${threshold:.0f}) — {', '.join(breakdown[p])}")
    body_lines += [
        "",
        "All providers (30d): " + summary,
        "",
        "Action: investigate the runaway, then dispatch OPS-LLM-SPEND-MONITOR-W{NEXT} via Cowork → Claude Code",
        "Audit shape: audits/OPS-LLM-SPEND-MONITOR-W1-endpoint-truth.md",
        f"Source log: {LOG}",
    ]
    body = "\n".join(body_lines)
    env = dict(os.environ)
    if dry_run:
        env["DRY_RUN_TG"] = "1"
    try:
        proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"],
                              input=body, text=True, env=env, timeout=30)
        log(f"ALERT over-threshold providers={list(over)} wrapper_rc={proc.returncode} dry_run={dry_run}")
    except Exception as e:
        log(f"WRAPPER_ERROR (fail-open exit 0): {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
