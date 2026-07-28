#!/usr/bin/env python3
"""OPS-REGISTRY-CONFORMANCE-CANARY-W1 — registry-schema conformance canary.

Host-side (Hetzner /opt/algovault-monitoring/) canary that answers the ONLY
operator-actionable question about the upstream MCP Registry schema:

    "Does OUR published server.json still VALIDATE against the schema it declares?"

This REPLACES the retired `REGISTRY_SCHEMA_CHANGE` tripwire in
`/opt/algovault-mcp/automation/mcp-intelligence/components/launch_triggers.py`,
which sha256-hashed the upstream registry's `openapi.yaml` (the registry
SERVICE's REST contract — the WRONG artifact) and fired a CRITICAL page on ANY
byte change, including cosmetic ones that never affected our conformance. The
2026-07-13 fire (`60cca7b36667 → 57991492d630`) is the poster child: our
v1.23.1 server.json published clean a day later, so the page required NO action.

Generator fix (per CLAUDE.md "fix at the generator, not the lane"): a CRITICAL
page is gated on a real `validate()` verdict, NEVER on a byte change. An upstream
byte change is only a trigger to re-validate. This makes the whole class of
"upstream bytes changed but we still conform" false-positives structurally
impossible, while a genuine break (e.g. the 2026-04-29 `description` 202 chars >
schema `maxLength:100`) still fires — now naming the exact failing field, with
the schema diff attached.

Severity map (all four contract severities assigned at design time —
`Claude files/monitoring-runbook.md`):
  * server.json FAILS its declared schema     -> CRITICAL_PERSISTENT (TG page)
  * upstream schema/openapi bytes changed but
    server.json still validates                -> INFO  (silent log — the killed FP)
  * a NEWER dated upstream schema would fail us
    (declared schema still passes)             -> WARNING (log-only early warning)
  * fetch failed / 404 / validator degraded    -> fail-open, log, NO fire, NO baseline advance

Gate delegation (consumers MUST NOT re-implement gates — monitoring-runbook.md):
severity-gate (CRITICAL_PERSISTENT only) + 24h cooldown per alert_id + DRY_RUN_TG
+ fail-open + `OPS-<CLASS>-W{NEXT}` resolution all live in send_telegram.sh. A
conformance break is DETERMINISTIC (not noisy), so no consecutive-cycle counter
is needed; the wrapper's 24h cooldown gives the desired "re-alert until fixed"
cadence. This canary owns ONLY the domain logic: read artifact + fetch schema +
validate + diff + fail-open.

Validation choice: `jsonschema.validators.validator_for(schema)` AUTO-DETECTS the
dialect (the live registry schema declares draft-07 despite its 2025-12-11 date)
— never hardcode a draft. The CRITICAL gate validates STRUCTURALLY (no
format-checker): it catches the real break classes (maxLength / required / type /
enum / pattern) with minimal false-positive risk. Format-aware validation is the
authoritative `mcp-publisher validate` gate wired into repo `prepublishOnly`.

Install (host): /opt/algovault-monitoring/registry-conformance-canary.py
  (SoT: repo ops/monitoring/registry-conformance-canary.py — deploy via SSH;
   ops/monitoring/** is paths-ignored in deploy.yml so it needs no image rebuild)
Runtime dep: `jsonschema` (add to the interpreter that runs this canary).
Cron (off-:00): 23 * * * *   (hourly at :23 — conformance rarely changes; off-:00
  per the snapshot-sampler boundary convention).

Env (config + test seams):
  REGISTRY_CANARY_SERVER_JSON   artifact to validate (default /opt/crypto-quant-signal-mcp/server.json)
  REGISTRY_CANARY_SCHEMA_URL    override the schema URL (default: server.json's own $schema)
  REGISTRY_CANARY_OPENAPI_URL   informational openapi change-detector ("" disables)
  REGISTRY_CANARY_SERVERS_URL   newest-schema discovery for the WARNING lane ("" disables)
  REGISTRY_CANARY_CACHE_DIR     body cache for diffs (default /opt/algovault-monitoring/.registry-schema-cache)
  REGISTRY_CANARY_LOG           log path (default /var/log/registry-conformance-canary.log)
  REGISTRY_CANARY_WRAPPER       send_telegram.sh path (override for hermetic tests)
  DRY_RUN_CANARY=1              smoke: no cache writes; sets DRY_RUN_TG for the wrapper
"""
import difflib
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

ALERT_ID = "REGISTRY_SCHEMA_CONFORMANCE_BREAK"
SEVERITY = "CRITICAL_PERSISTENT"
RECOMMENDED_WAVE = "OPS-REGISTRY-CONFORMANCE-W{NEXT}"
AUDIT_DOC = "audits/OPS-REGISTRY-CONFORMANCE-CANARY-W1-endpoint-truth.md"

SERVER_JSON_PATH = os.environ.get("REGISTRY_CANARY_SERVER_JSON", "/opt/crypto-quant-signal-mcp/server.json")
SCHEMA_URL_OVERRIDE = os.environ.get("REGISTRY_CANARY_SCHEMA_URL")  # None => use server.json $schema
OPENAPI_URL = os.environ.get("REGISTRY_CANARY_OPENAPI_URL", "https://registry.modelcontextprotocol.io/openapi.yaml")
SERVERS_URL = os.environ.get("REGISTRY_CANARY_SERVERS_URL", "https://registry.modelcontextprotocol.io/v0/servers?limit=1")
CACHE_DIR = os.environ.get("REGISTRY_CANARY_CACHE_DIR", "/opt/algovault-monitoring/.registry-schema-cache")
LOG = os.environ.get("REGISTRY_CANARY_LOG", "/var/log/registry-conformance-canary.log")
WRAPPER = os.environ.get("REGISTRY_CANARY_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
DRY_RUN = os.environ.get("DRY_RUN_CANARY", "0") == "1"

_FETCH_TIMEOUT = 30


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    line = f"{now()} [registry-conformance-canary] {msg}"
    print(line, flush=True)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def _slug(url: str) -> str:
    keep = [c if (c.isalnum() or c in "._-") else "_" for c in url]
    return "".join(keep)[-120:]


def fetch_text(url: str):
    """(ok, text). ok=False on ANY error => fail-open (never a false conformance verdict)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "algovault-registry-conformance-canary/1.0",
                                                    "accept": "application/json, application/yaml, */*"})
        with urllib.request.urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
            return True, resp.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 — any fetch failure is fail-open
        log(f"FETCH_ERROR {url}: {e!r}")
        return False, None


def read_cache(key: str):
    try:
        with open(os.path.join(CACHE_DIR, key), encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def write_cache(key: str, text: str) -> None:
    """Persist NEW body AFTER the OLD has been read for diffing. Skipped under DRY_RUN."""
    if DRY_RUN:
        return
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        path = os.path.join(CACHE_DIR, key)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except OSError as e:
        log(f"WARN cache write {key}: {e}")


def diff_excerpt(old: str, new: str, label: str, max_lines: int = 24) -> str:
    if old is None:
        return f"(no cached {label} baseline — first observation; diff will attach next change)"
    if old == new:
        return f"({label} unchanged since last run)"
    lines = list(difflib.unified_diff(old.splitlines(), new.splitlines(),
                                      fromfile=f"{label}~cached", tofile=f"{label}~live", lineterm=""))
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"... (+{len(lines) - max_lines} more diff lines; see {LOG})"]
    return "\n".join(lines)


def validate_conformance(server_doc: dict, schema: dict):
    """Return ('OK', []) | ('BREAK', [error,...]) | ('DEGRADED', reason).

    BREAK  = server.json violates a real schema constraint (the CRITICAL signal).
    DEGRADED = validator infrastructure problem ($ref won't resolve, schema
               malformed) — fail-OPEN, never a false page.
    Structural only (no format-checker) — see module docstring.
    """
    try:
        from jsonschema.validators import validator_for
    except ImportError as e:
        return "DEGRADED", f"jsonschema not installed: {e}"
    try:
        cls = validator_for(schema)
        cls.check_schema(schema)
        validator = cls(schema)
        errors = sorted(validator.iter_errors(server_doc), key=lambda e: list(e.absolute_path))
    except Exception as e:  # noqa: BLE001 — schema/$ref/infra failure => degraded, fail-open
        return "DEGRADED", f"{type(e).__name__}: {e}"
    return ("BREAK", errors) if errors else ("OK", [])


def _json_path(err) -> str:
    out = "$"
    for p in err.absolute_path:
        out += f".{p}" if isinstance(p, str) else f"[{p}]"
    return out


def build_body(err, schema_url: str, schema_diff: str) -> str:
    jp = _json_path(err)
    val = err.validator_value
    val_s = json.dumps(val) if not isinstance(val, (dict, list)) else f"{type(val).__name__}(...)"
    msg = (err.message or "").strip()
    if len(msg) > 200:
        msg = msg[:200] + "…"
    return "\n".join([
        f"\U0001F6D1 {ALERT_ID}",
        f"server.json fails the registry schema it declares.",
        f"Failing field: {jp} — {err.validator}={val_s}",
        f"  {msg}",
        f"Schema: {schema_url}",
        f"Artifact: {SERVER_JSON_PATH}",
        f"Schema change since last run:\n{schema_diff}",
        f"Action: dispatch {RECOMMENDED_WAVE} via Cowork → Claude Code",
        f"Audit shape: {AUDIT_DOC}",
        f"Source log: {LOG}",
    ])


def fire(body: str) -> None:
    """Delegate to the wrapper (owns severity + 24h cooldown + DRY_RUN_TG + fail-open)."""
    env = dict(os.environ)
    if DRY_RUN:
        env["DRY_RUN_TG"] = "1"
    try:
        proc = subprocess.run([WRAPPER, ALERT_ID, SEVERITY, "-"], input=body, text=True,
                              env=env, capture_output=True, timeout=30)
        log(f"wrapper exit={proc.returncode} out={(proc.stdout or proc.stderr).strip()[:160]}")
    except Exception as e:  # noqa: BLE001 — wrapper missing/err must never crash the canary
        log(f"WRAPPER_ERROR (fail-open): {e!r}")


def newer_schema_warning(server_doc: dict, declared_url: str) -> None:
    """WARNING lane: if the registry now advertises a NEWER dated schema our server.json
    would FAIL (declared schema still passes), log an early forward-incompat warning.
    Never pages. Fixes the launch_triggers discovery bug: read servers[].server.$schema."""
    if not SERVERS_URL:
        return
    ok, text = fetch_text(SERVERS_URL)
    if not ok:
        return
    try:
        servers = (json.loads(text) or {}).get("servers") or []
        advertised = None
        for item in servers:
            advertised = ((item or {}).get("server") or {}).get("$schema")
            if advertised:
                break
    except Exception as e:  # noqa: BLE001
        log(f"WARN newer-schema discovery parse: {e}")
        return
    if not advertised or advertised == declared_url:
        return
    ok, sch_text = fetch_text(advertised)
    if not ok:
        return
    try:
        verdict, errors = validate_conformance(server_doc, json.loads(sch_text))
    except Exception as e:  # noqa: BLE001
        log(f"WARN newer-schema validate: {e}")
        return
    if verdict == "BREAK":
        first = errors[0]
        log(f"WARNING FORWARD_INCOMPAT: registry now advertises {advertised} (declared {declared_url}); "
            f"server.json would FAIL it at {_json_path(first)} [{first.validator}]. "
            f"Not a break yet (declared schema still passes); surface at next release. NO page.")
    else:
        log(f"INFO newer schema advertised ({advertised}) — server.json already valid against it.")


def openapi_change_detector() -> None:
    """Forensic-only: the retired openapi.yaml watch, demoted to a silent INFO change log.
    NEVER pages (openapi.yaml is the registry service's REST contract, not our schema)."""
    if not OPENAPI_URL:
        return
    ok, text = fetch_text(OPENAPI_URL)
    if not ok:
        return
    old = read_cache("openapi.yaml")
    if old is not None and old != text:
        log("INFO openapi.yaml changed upstream (forensic only — not a conformance signal):\n"
            + diff_excerpt(old, text, "openapi.yaml"))
    write_cache("openapi.yaml", text)


def main() -> int:
    try:
        # 1) Read OUR artifact. Missing/unreadable => WARNING log, fail-open, NOT "conformant".
        try:
            with open(SERVER_JSON_PATH, encoding="utf-8") as fh:
                server_doc = json.load(fh)
        except (OSError, ValueError) as e:
            log(f"WARNING artifact unreadable at {SERVER_JSON_PATH}: {e} — fail-open, no verdict")
            return 0

        # 2) Resolve + fetch the schema our server.json declares. Failed fetch => fail-open,
        #    no baseline advance, no fire.
        schema_url = SCHEMA_URL_OVERRIDE or server_doc.get("$schema")
        if not schema_url:
            log("WARNING server.json has no $schema and no override — fail-open, no verdict")
            return 0
        ok, schema_text = fetch_text(schema_url)
        if not ok:
            log(f"FAIL_OPEN schema fetch failed ({schema_url}); baseline NOT advanced, no fire")
            return 0
        try:
            schema = json.loads(schema_text)
        except ValueError as e:
            log(f"DEGRADED schema is not valid JSON ({schema_url}): {e} — fail-open, no fire")
            return 0

        # 3) Diff vs cached schema body (read OLD before overwrite), then advance the cache.
        schema_key = f"schema__{_slug(schema_url)}"
        old_schema = read_cache(schema_key)
        schema_diff = diff_excerpt(old_schema, schema_text, "server.schema.json")
        write_cache(schema_key, schema_text)

        # 4) THE GATE: validate our server.json against its declared schema.
        verdict, errors = validate_conformance(server_doc, schema)
        if verdict == "DEGRADED":
            log(f"FAIL_OPEN validator degraded ({errors}); no fire")
        elif verdict == "BREAK":
            first = errors[0]
            log(f"BREAK server.json FAILS {schema_url} at {_json_path(first)} "
                f"[{first.validator}] ({len(errors)} error(s)) — firing wrapper "
                f"({'DRY_RUN_TG' if DRY_RUN else 'live'})")
            fire(build_body(first, schema_url, schema_diff))
        else:
            changed = old_schema is not None and old_schema != schema_text
            log(f"CONFORM server.json valid against {schema_url} "
                f"(schema bytes {'CHANGED' if changed else 'unchanged'} — INFO, no page)")

        # 5) Best-effort side channels (never page): forward-incompat WARNING + openapi forensic log.
        try:
            newer_schema_warning(server_doc, schema_url)
        except Exception as e:  # noqa: BLE001
            log(f"WARN newer-schema lane: {e}")
        try:
            openapi_change_detector()
        except Exception as e:  # noqa: BLE001
            log(f"WARN openapi detector: {e}")
        return 0
    except Exception as e:  # noqa: BLE001 — fail-open is the contract
        log(f"FAIL_OPEN {type(e).__name__}: {e}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
