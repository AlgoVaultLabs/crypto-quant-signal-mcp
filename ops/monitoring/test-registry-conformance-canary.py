#!/usr/bin/env python3
"""Hermetic regression suite for registry-conformance-canary.py (OPS-REGISTRY-CONFORMANCE-CANARY-W1).

No real network / no real send_telegram.sh / no /var/log: a fake wrapper records
invocations, schemas are served via file:// fixtures, cache+log go to a temp dir.
Run with an interpreter that has `jsonschema`:  python3 test-registry-conformance-canary.py
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CANARY = os.path.join(HERE, "registry-conformance-canary.py")
PY = sys.executable

FIXTURE_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["name", "version"],
    "properties": {
        "name": {"type": "string"},
        "version": {"type": "string"},
        "description": {"type": "string", "maxLength": 100},
    },
}
GOOD_SERVER = {"name": "io.github.x/y", "version": "1.0.0", "description": "short and sweet"}
BAD_SERVER = {"name": "io.github.x/y", "version": "1.0.0", "description": "X" * 140}  # 140 > maxLength 100

_passed = 0
_failed = 0


def check(name, cond, detail=""):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  PASS  {name}")
    else:
        _failed += 1
        print(f"  FAIL  {name}  {detail}")


def _write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def run(tmp, *, server=GOOD_SERVER, schema=FIXTURE_SCHEMA, schema_url=None,
        seed_schema_cache=None, dry_run=False, server_path=None):
    """Run the canary under controlled env; return (rc, stdout, wrapper_record|None)."""
    d = tempfile.mkdtemp(dir=tmp)
    cache = os.path.join(d, "cache")
    os.makedirs(cache, exist_ok=True)
    log = os.path.join(d, "canary.log")
    record = os.path.join(d, "wrapper.record")

    # fake wrapper: records argv + DRY_RUN_TG + body, never sends.
    wrapper = os.path.join(d, "fake_wrapper.py")
    _write(wrapper,
           "#!/usr/bin/env python3\n"
           "import os,sys\n"
           "rec=os.environ['FAKE_WRAPPER_RECORD']\n"
           "body=sys.stdin.read()\n"
           "open(rec,'a').write('ARGV='+repr(sys.argv[1:])+'\\n'"
           "+'DRY_RUN_TG='+os.environ.get('DRY_RUN_TG','')+'\\n'+'BODY_START\\n'+body+'\\nBODY_END\\n')\n")
    os.chmod(wrapper, 0o755)

    if server_path is None:
        server_path = os.path.join(d, "server.json")
        _write(server_path, json.dumps(server))

    if schema_url is None:
        schema_path = os.path.join(d, "schema.json")
        _write(schema_path, json.dumps(schema))
        schema_url = "file://" + schema_path

    if seed_schema_cache is not None:
        # cache key must match the canary's: schema__<slug(url)>
        keep = "".join(c if (c.isalnum() or c in "._-") else "_" for c in schema_url)[-120:]
        _write(os.path.join(cache, f"schema__{keep}"), seed_schema_cache)

    env = dict(os.environ)
    env.update({
        "REGISTRY_CANARY_SERVER_JSON": server_path,
        "REGISTRY_CANARY_SCHEMA_URL": schema_url,
        "REGISTRY_CANARY_CACHE_DIR": cache,
        "REGISTRY_CANARY_LOG": log,
        "REGISTRY_CANARY_WRAPPER": wrapper,
        "REGISTRY_CANARY_OPENAPI_URL": "",   # disable network side-channels
        "REGISTRY_CANARY_SERVERS_URL": "",
        "FAKE_WRAPPER_RECORD": record,
        "DRY_RUN_CANARY": "1" if dry_run else "0",
    })
    proc = subprocess.run([PY, CANARY], env=env, capture_output=True, text=True, timeout=60)
    rec = open(record).read() if os.path.exists(record) else None
    return proc.returncode, proc.stdout + proc.stderr, rec, cache, schema_url


def main():
    tmp = tempfile.mkdtemp(prefix="regcanary-test-")

    # 1) Benign: valid server.json, schema bytes CHANGED vs cache -> no fire, CONFORM+CHANGED.
    old = json.dumps({**FIXTURE_SCHEMA, "title": "OLD"})
    rc, out, rec, cache, url = run(tmp, server=GOOD_SERVER, seed_schema_cache=old)
    check("benign: exit 0", rc == 0, f"rc={rc}")
    check("benign: no wrapper fire", rec is None, f"rec={rec!r}")
    check("benign: CONFORM logged", "CONFORM" in out, out)
    check("benign: schema CHANGED noted", "CHANGED" in out, out)

    # 2) Known-bad server.json (description > maxLength) -> CRITICAL fire naming the field.
    rc, out, rec, cache, url = run(tmp, server=BAD_SERVER)
    check("bad: exit 0 (fail-open envelope)", rc == 0, f"rc={rc}")
    check("bad: wrapper fired", rec is not None and "ARGV=" in (rec or ""), f"rec={rec!r}")
    check("bad: alert_id + severity", rec and "REGISTRY_SCHEMA_CONFORMANCE_BREAK" in rec and "CRITICAL_PERSISTENT" in rec, rec)
    check("bad: body names $.description", rec and "$.description" in rec, rec)
    check("bad: body names maxLength", rec and "maxLength" in rec, rec)
    check("bad: recommended-wave token", rec and "OPS-REGISTRY-CONFORMANCE-W{NEXT}" in rec, rec)
    check("bad: BREAK logged", "BREAK" in out, out)

    # 3) Diff attaches to the BREAK body (old schema differs from live).
    rc, out, rec, cache, url = run(tmp, server=BAD_SERVER, seed_schema_cache=old)
    check("diff: unified-diff header in body", rec and ("--- server.schema.json" in rec or "@@" in rec), rec)
    # cache advanced to NEW body
    keep = "".join(c if (c.isalnum() or c in "._-") else "_" for c in url)[-120:]
    cached_now = open(os.path.join(cache, f"schema__{keep}")).read()
    check("diff: cache advanced to live schema", json.loads(cached_now).get("title") is None, cached_now[:80])

    # 4) DRY_RUN: wrapper sees DRY_RUN_TG=1 and cache is NOT advanced (write skipped).
    rc, out, rec, cache, url = run(tmp, server=BAD_SERVER, seed_schema_cache=old, dry_run=True)
    check("dryrun: wrapper fired with DRY_RUN_TG=1", rec and "DRY_RUN_TG=1" in rec, rec)
    keep = "".join(c if (c.isalnum() or c in "._-") else "_" for c in url)[-120:]
    check("dryrun: cache still OLD (no write)", json.loads(open(os.path.join(cache, f"schema__{keep}")).read()).get("title") == "OLD", "cache advanced under dry-run")

    # 5) Fail-open on schema fetch failure -> no fire, baseline not advanced, exit 0.
    bad_url = "file://" + os.path.join(tmp, "does-not-exist-xyz.json")
    rc, out, rec, cache, url = run(tmp, server=GOOD_SERVER, schema_url=bad_url)
    check("failopen: exit 0", rc == 0, f"rc={rc}")
    check("failopen: no wrapper fire", rec is None, f"rec={rec!r}")
    check("failopen: FAIL_OPEN logged", "FAIL_OPEN schema fetch failed" in out, out)
    keep = "".join(c if (c.isalnum() or c in "._-") else "_" for c in bad_url)[-120:]
    check("failopen: baseline NOT advanced", not os.path.exists(os.path.join(cache, f"schema__{keep}")), "cache written on failed fetch")

    # 6) Benign, schema UNCHANGED vs cache -> no fire, 'unchanged'.
    same = json.dumps(FIXTURE_SCHEMA)
    rc, out, rec, cache, url = run(tmp, server=GOOD_SERVER, seed_schema_cache=same)
    check("unchanged: no fire", rec is None, f"rec={rec!r}")
    check("unchanged: 'unchanged' noted", "unchanged" in out, out)

    # 7) Artifact missing -> WARNING, no fire, exit 0.
    rc, out, rec, cache, url = run(tmp, server_path=os.path.join(tmp, "nope.json"))
    check("missing-artifact: exit 0", rc == 0, f"rc={rc}")
    check("missing-artifact: no fire", rec is None, f"rec={rec!r}")
    check("missing-artifact: WARNING logged", "WARNING artifact unreadable" in out, out)

    # 8) Degraded validator (malformed schema) -> fail-open, no fire.
    rc, out, rec, cache, url = run(tmp, server=GOOD_SERVER, schema={"type": 123})
    check("degraded: no fire", rec is None, f"rec={rec!r}")
    check("degraded: FAIL_OPEN validator degraded", "validator degraded" in out, out)

    print(f"\n{_passed} passed, {_failed} failed")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
