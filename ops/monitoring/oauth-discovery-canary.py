#!/usr/bin/env python3
"""
oauth-discovery-canary.py — GROWTH-AGENT-SIGNIN-OAUTH-W1 CH3 (+ W2: the ChatGPT leg).

Daily host-side canary for the OAuth sign-in surface of api.algovault.com: are the discovery
documents and the error contracts Claude's and ChatGPT's connector flows start from still being
SERVED?

WHY. Claude begins its OAuth flow only on an HTTP 401 that carries `WWW-Authenticate:
resource_metadata=…`, then walks protected-resource metadata -> authorization-server metadata ->
(client_id) -> /token. A break anywhere on that path is invisible to every other monitor: /mcp keeps
answering 200 and the quota wall keeps working, but nobody can sign in. This canary reads the same
documents the client reads, from the same origin, and compares them with the CONTRACT (the literals
below), not with the deployed code — an oracle derived from the code under test cannot disagree
with it. A deliberate copy edit of the sign-in challenge therefore updates the constants here in the
same commit.

THE FLAG. `MCP_OAUTH` unset = `off` is the one-value rollback lever and is today's state: every
OAuth path answers the app's own 404 by design. So the canary first reads the mode INSIDE the app
container through the deployed module (`resolveOAuthMode()` from dist/lib/oauth/mode.js — the one
resolver every consumer uses, never the env var directly):
    off          -> SKIPPED_FLAG_OFF (exit 0). No probe is made, nothing is paged. "Skipped" is NOT
                    "passed": the token says so, and the record carries the mode.
    optin|wall   -> the six checks below (the mode does not change what is expected here; the
                    wall changes WHO is challenged, never the shape of the documents).
    unreadable   -> INDETERMINATE (exit 3): docker, the container, the module or its output could
                    not be read, so there is nothing to verify against.

THE SIX CHECKS (each judged PASS / FAIL / INDETERMINATE on its own):
  prm               GET /.well-known/oauth-protected-resource/mcp -> 200 JSON; resource ==
                    https://api.algovault.com/mcp; authorization_servers == [issuer]; scopes_supported
                    contains mcp:tools
  prm_echo          the same document at …/mcp?src=docs: resource == https://api.algovault.com/mcp?src=docs
                    (our docs tell people to add ?src=docs; Claude compares `resource` with the URL
                    exactly as typed)
  as_metadata       GET /.well-known/oauth-authorization-server -> issuer, client_id_metadata_document
                    _supported, authorization_response_iss_parameter_supported, S256, auth method
                    `none`, and the token / registration endpoints this canary then exercises
  signin_challenge  anonymous JSON-RPC tools/call get_trade_call POSTed to /mcp?signin=1 -> exactly
                    401, the exact WWW-Authenticate, Cache-Control: no-store and the exact JSON body.
                    The server decides this before any emit or charge, so a correct run charges nothing.
  token_invalid_grant  POST /token (refresh_token grant, a bogus refresh token) -> 400 invalid_grant
  chatgpt_cimd      GET /authorize as ChatGPT (its stable CIMD client_id + redirect_uri) with
                    response_type=token -> exactly 302 to that redirect_uri carrying `error` and
                    `iss`=[issuer] once. Phase 1 (client + redirect) must ACCEPT ChatGPT's document,
                    Phase 2 then refuses the response type: no pending row, no cookie. A
                    400 invalid_client means ChatGPT's document is refused again -> FAIL.

THE client_id FOR THE LAST CHECK (the choice, stated). /token authenticates the client BEFORE it
looks at the grant: an unknown client_id answers `invalid_client`, never `invalid_grant`. So the check
needs a client the server knows. This canary OWNS one Dynamic Client Registration client — a public
client (`token_endpoint_auth_method: none`, so there is no secret to hold or leak), loopback redirect
http://127.0.0.1/callback — registered once with POST /register and persisted in
/var/lib/algovault-monitoring/oauth-discovery/state.json. It is re-registered only when /token answers
`invalid_client` for the STORED client (the server forgot it), at most once per run; a client that was
registered seconds earlier and is still rejected is a FAIL, not a retry loop. The server's DCR has no
delete, so the standing cost is one `oauth_clients` row for the life of the host (plus one per
re-registration; the record counts them). A CIMD client_id was rejected for this leg: it would make
our own server fetch a URL on every run. The chatgpt_cimd leg does exercise CIMD, because that fetch
is what it verifies; the server's 24 h document cache bounds it to one fetch of chatgpt.com a day. The refresh token is random per run and exists nowhere server-side; it and
the client id are never printed (the client id is public, but a log line has no use for it).

NETWORK FAILURE IS INDETERMINATE, NOT FAIL. A check that could not reach our own origin (DNS,
connect, TLS, timeout, a reset) or got a gateway/throttle answer (429, 502, 503, 504 — Caddy answers
502 for the seconds a deploy restarts the container) has verified nothing about the documents, and
the page's remedy ("dispatch the OAuth discovery wave") is wrong for an outage that the uptime and
deploy monitors already own. Same precedent as okx-ai-listing-canary.probe_listing ("network errors
are UNKNOWN, never ABSENT" -> INDETERMINATE, exit 3) and verification-gates' "exit 0 may never encode
both verified-clean and verified-nothing". A definite answer that is WRONG — including a 404 for a
document the mode says is mounted, or a 500 — is a FAIL. Across checks: any FAIL -> FAIL (a decisive
failure is real whatever else could not be read; the page names the legs it could not verify); else
any INDETERMINATE -> INDETERMINATE; else PASS. A run that produced no results, or fewer than the six,
is INDETERMINATE (a vacuity guard where the corpus is constructed), never PASS.

VERDICT TOKEN — callers gate on the TOKEN, never the bare exit code:
    OAUTH_DISCOVERY_VERDICT=PASS | FAIL | INDETERMINATE | SKIPPED_FLAG_OFF
    exit 0 PASS or SKIPPED_FLAG_OFF · exit 1 FAIL · exit 3 INDETERMINATE (the token-law default)

ALERT. `OAUTH_DISCOVERY_FAIL` (CRITICAL_PERSISTENT) on FAIL only, through /opt/algovault-monitoring/
send_telegram.sh. The wrapper owns the 24 h cooldown, the severity gate, the W{NEXT} resolver and the
test-inert levers (ALGOVAULT_TG_TEST_INERT=1, VITEST, NODE_TEST_CONTEXT — inherited by the wrapper
subprocess because this file never passes `env=`); consumers do not re-implement them. PASS calls
`--clear` (silent: the registry row has announce_resolution false). SKIPPED_FLAG_OFF calls `--clear`
only when the previous decisive verdict was FAIL — rolling the flag back IS the resolution, and a
marker left pinned would outlive it — and is otherwise silent. INDETERMINATE neither pages nor clears.

RECORD. One line per run via canary_result_log.append_result -> canary-results.jsonl
(CANARY_RESULT_LOG_PATH overrides the path); the vault-side pull makes it a file read.

Install (host): /opt/algovault-monitoring/oauth-discovery-canary.py  (SoT: repo ops/monitoring/)
Cron (daily, off-:00): 43 11 * * *   (11:43 UTC; signal-1 has no other entry in hour 11)

    oauth-discovery-canary.py --self-test   # hermetic: no docker, no network, no wrapper, no state, no record

Env:
  OAUTH_DISCOVERY_ORIGIN     default https://api.algovault.com (the expected documents are fixed to
                             that origin either way; the override exists to point a probe at a stand-in)
  OAUTH_DISCOVERY_STATE_DIR  default /var/lib/algovault-monitoring/oauth-discovery
  TG_WRAPPER                 default /opt/algovault-monitoring/send_telegram.sh
"""
from __future__ import annotations

import http.client
import json
import os
import re
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections import namedtuple
from datetime import datetime, timezone
from pathlib import Path

CANARY = "oauth-discovery-canary"
ALERT_ID = "OAUTH_DISCOVERY_FAIL"
SEVERITY = "CRITICAL_PERSISTENT"
RECOMMENDED_WAVE = "OPS-OAUTH-DISCOVERY-W{NEXT}"

PASS, FAIL, INDETERMINATE, SKIPPED = "PASS", "FAIL", "INDETERMINATE", "SKIPPED_FLAG_OFF"
EXIT_FOR = {PASS: 0, FAIL: 1, INDETERMINATE: 3, SKIPPED: 0}

# ── the contract (what a client is promised; NOT derived from the code under test) ──────────────
ISSUER = "https://api.algovault.com"
RESOURCE = ISSUER + "/mcp"
ECHO_RESOURCE = RESOURCE + "?src=docs"
SCOPE = "mcp:tools"
SIGNIN_DESCRIPTION = "Sign in free to keep using AlgoVault"
SIGNIN_MESSAGE = "Sign in to continue. It's free, no card."
SIGNIN_URL = ISSUER + "/welcome?src=stepup"
SIGNIN_BODY = {
    "error": "invalid_token",
    "error_description": SIGNIN_DESCRIPTION,
    "algovault": {"reason": "signin", "message": SIGNIN_MESSAGE, "sign_in_url": SIGNIN_URL},
}
PRM_PATH = "/.well-known/oauth-protected-resource/mcp"
AS_PATH = "/.well-known/oauth-authorization-server"
MCP_SIGNIN_PATH = "/mcp?signin=1"
MCP_CALL = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "get_trade_call", "arguments": {"coin": "BTC"}}}
# W2: ChatGPT's stable Client ID Metadata Document and its registered redirect (OpenAI's published
# contract). The Phase-2 probe: a response_type the server refuses AFTER accepting the client.
CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json"
CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"
CHATGPT_AUTHORIZE_PATH = "/authorize?" + urllib.parse.urlencode(
    {"response_type": "token", "client_id": CHATGPT_CLIENT_ID, "redirect_uri": CHATGPT_REDIRECT, "state": "x"})
REGISTER_BODY = {
    "redirect_uris": ["http://127.0.0.1/callback"],
    "token_endpoint_auth_method": "none",
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "client_name": "AlgoVault OAuth discovery canary",
}
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")

CHECKS = ("prm", "prm_echo", "as_metadata", "signin_challenge", "token_invalid_grant", "chatgpt_cimd")
LABEL = {
    "prm": "protected-resource metadata (/.well-known/oauth-protected-resource/mcp)",
    "prm_echo": "protected-resource metadata resource echo (…/mcp?src=docs)",
    "as_metadata": "authorization-server metadata (/.well-known/oauth-authorization-server)",
    "signin_challenge": "anonymous sign-in challenge (POST /mcp?signin=1)",
    "token_invalid_grant": "token endpoint refusal (POST /token, bogus refresh token)",
    "chatgpt_cimd": "ChatGPT client document accepted (GET /authorize as chatgpt.com -> 302 + iss)",
}
# 429 (our own limiter) and the gateway trio: the origin answered, but not with an answer about the
# documents. 500 is NOT here: a 500 on a discovery document is a defect.
UNAVAILABLE_STATUS = frozenset({429, 502, 503, 504})

APP_CONTAINER = "crypto-quant-signal-mcp-mcp-server-1"
MODE_MODULE = "/app/dist/lib/oauth/mode.js"
MODE_JS = ("const m = require(%s); process.stdout.write(JSON.stringify({ mode: m.resolveOAuthMode() }));"
           % json.dumps(MODE_MODULE))
MODES = ("off", "optin", "wall")

ORIGIN = os.environ.get("OAUTH_DISCOVERY_ORIGIN", ISSUER).rstrip("/")
STATE_DIR = os.environ.get("OAUTH_DISCOVERY_STATE_DIR", "/var/lib/algovault-monitoring/oauth-discovery")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
UA = "algovault-oauth-discovery-canary/1 (+https://algovault.com)"

HTTP_TIMEOUT_S = 15
DOCKER_TIMEOUT_S = 30
WRAPPER_TIMEOUT_S = 30
BODY_CAP = 65536
# Worst case by construction: every call below has an enforced timeout. 1 docker exec + 6 GETs/POSTs
# + 1 register + 1 token retry, then one wrapper call. Not a host measurement (see the registry row).
WORST_CASE_RUNTIME_S = DOCKER_TIMEOUT_S + 8 * HTTP_TIMEOUT_S + WRAPPER_TIMEOUT_S

R = namedtuple("R", "name state detail")
Resp = namedtuple("Resp", "status headers body")


class NetError(Exception):
    """The origin could not be reached or read (DNS, connect, TLS, timeout, reset, short read)."""


class ModeUnreadable(Exception):
    """The deployed mode resolver could not be read."""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"{now_iso()} [{CANARY}] {msg}", flush=True)


def short(v, n: int = 120) -> str:
    s = v if isinstance(v, str) else json.dumps(v, sort_keys=True, default=str)
    return re.sub(r"[\x00-\x1f\x7f]", " ", s)[:n]


# ── pure logic (what --self-test exercises) ──────────────────────────────────────────────────────


def signin_header() -> str:
    return ('Bearer error="invalid_token", error_description="%s", scope="%s", '
            'resource_metadata="%s%s?signin=1"' % (SIGNIN_DESCRIPTION, SCOPE, ISSUER, PRM_PATH))


def json_obj(resp):
    try:
        obj = json.loads(resp.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return obj if isinstance(obj, dict) else None


def differing_paths(want, got, prefix: str = "") -> list:
    """Dotted paths at which two JSON objects differ (key sets and values), order-insensitive."""
    out = []
    for k in sorted(set(want) | set(got)):
        p = prefix + k
        if k not in got:
            out.append(p + " (missing)")
        elif k not in want:
            out.append(p + " (unexpected)")
        elif isinstance(want[k], dict) and isinstance(got[k], dict):
            out += differing_paths(want[k], got[k], p + ".")
        elif want[k] != got[k]:
            out.append(p)
    return out


def validate_prm(resp, expect_resource: str) -> list:
    if resp.status != 200:
        return ["status %d (want 200)" % resp.status]
    d = json_obj(resp)
    if d is None:
        return ["body is not a JSON object"]
    p = []
    if d.get("resource") != expect_resource:
        p.append("resource %s (want %s)" % (short(d.get("resource")), expect_resource))
    if d.get("authorization_servers") != [ISSUER]:
        p.append("authorization_servers %s (want [%s])" % (short(d.get("authorization_servers")), ISSUER))
    sc = d.get("scopes_supported")
    if not (isinstance(sc, list) and SCOPE in sc):
        p.append("scopes_supported %s lacks %s" % (short(sc), SCOPE))
    return p


def validate_as(resp) -> list:
    if resp.status != 200:
        return ["status %d (want 200)" % resp.status]
    d = json_obj(resp)
    if d is None:
        return ["body is not a JSON object"]
    p = []
    if d.get("issuer") != ISSUER:
        p.append("issuer %s (want %s)" % (short(d.get("issuer")), ISSUER))
    if d.get("client_id_metadata_document_supported") is not True:
        p.append("client_id_metadata_document_supported is not true")
    if d.get("authorization_response_iss_parameter_supported") is not True:
        p.append("authorization_response_iss_parameter_supported is not true")
    cc = d.get("code_challenge_methods_supported")
    if not (isinstance(cc, list) and "S256" in cc):
        p.append("code_challenge_methods_supported lacks S256")
    am = d.get("token_endpoint_auth_methods_supported")
    if not (isinstance(am, list) and "none" in am):
        p.append("token_endpoint_auth_methods_supported lacks none")
    if d.get("token_endpoint") != ISSUER + "/token":
        p.append("token_endpoint %s (want %s/token)" % (short(d.get("token_endpoint")), ISSUER))
    if d.get("registration_endpoint") != ISSUER + "/register":
        p.append("registration_endpoint %s (want %s/register)" % (short(d.get("registration_endpoint")), ISSUER))
    return p


def validate_signin(resp) -> list:
    p = []
    if resp.status != 401:
        p.append("status %d (want 401)" % resp.status)
    if resp.headers.get("www-authenticate") != signin_header():
        p.append("WWW-Authenticate %s (want the sign-in challenge)" % short(resp.headers.get("www-authenticate", "<absent>"), 200))
    if resp.headers.get("cache-control", "").strip().lower() != "no-store":
        p.append("Cache-Control %s (want no-store)" % short(resp.headers.get("cache-control", "<absent>")))
    d = json_obj(resp)
    if d is None:
        p.append("body is not a JSON object")
    elif d != SIGNIN_BODY:
        p.append("body differs at %s" % ", ".join(differing_paths(SIGNIN_BODY, d)))
    return p


def oauth_error(resp):
    d = json_obj(resp)
    e = d.get("error") if d else None
    return e if isinstance(e, str) else None


def validate_token(resp) -> list:
    p = []
    if resp.status != 400:
        p.append("status %d (want 400)" % resp.status)
    err = oauth_error(resp)
    if err != "invalid_grant":
        p.append("error %s (want invalid_grant)" % short(err if err is not None else "<none>"))
    return p


def validate_chatgpt(resp) -> list:
    p = []
    if resp.status != 302:
        p.append("status %d (want 302)" % resp.status)
        if oauth_error(resp) == "invalid_client":
            p.append("ChatGPT's client document is refused (invalid_client)")
        return p
    loc = resp.headers.get("location", "")
    if not loc.startswith(CHATGPT_REDIRECT + "?"):
        p.append("Location %s (want ChatGPT's redirect_uri)" % short(loc or "<absent>"))
        return p
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(loc).query, keep_blank_values=True)
    if not q.get("error"):
        p.append("no error parameter on the redirect")
    if q.get("iss") != [ISSUER]:
        p.append("iss %s (want exactly one, %s)" % (short(q.get("iss", "<absent>")), ISSUER))
    return p


def parse_registration(resp):
    """-> (client_id | None, why). A secret in the answer is refused, never kept: a public client
    holds none, and this file must never store or print one."""
    if resp.status != 201:
        return None, "register answered %d (want 201)" % resp.status
    d = json_obj(resp)
    if d is None:
        return None, "register body is not a JSON object"
    cid = d.get("client_id")
    if not (isinstance(cid, str) and CLIENT_ID_RE.match(cid)):
        return None, "register answered no usable client_id"
    if "client_secret" in d:
        return None, "register answer carries a client_secret (a public client holds none)"
    return cid, ""


def judge(name: str, resp, validate) -> R:
    if resp.status in UNAVAILABLE_STATUS:
        return R(name, INDETERMINATE, "origin answered %d (unavailable or throttled)" % resp.status)
    problems = validate(resp)
    return R(name, FAIL, "; ".join(problems)) if problems else R(name, PASS, "ok")


def decide(results) -> tuple:
    """-> (verdict, exit_code, action) with action fire | clear | none."""
    if {r.name for r in results} != set(CHECKS):
        return INDETERMINATE, EXIT_FOR[INDETERMINATE], "none"     # fewer than the six = verified nothing
    states = [r.state for r in results]
    if FAIL in states:
        return FAIL, EXIT_FOR[FAIL], "fire"
    if INDETERMINATE in states:
        return INDETERMINATE, EXIT_FOR[INDETERMINATE], "none"
    return PASS, EXIT_FOR[PASS], "clear"


def parse_mode_output(stdout: str) -> str:
    lines = [ln for ln in (stdout or "").splitlines() if ln.strip()]
    if not lines:
        raise ModeUnreadable("the mode probe printed nothing")
    try:
        mode = json.loads(lines[-1]).get("mode")
    except (ValueError, AttributeError):
        raise ModeUnreadable("the mode probe output is not a JSON object")
    if mode not in MODES:
        raise ModeUnreadable("the mode probe returned %s, not one of %s" % (short(mode), "/".join(MODES)))
    return mode


def alert_body(mode: str, results) -> str:
    bad = [r for r in results if r.state == FAIL]
    open_legs = [r for r in results if r.state == INDETERMINATE]
    lines = [
        f"🛑 {ALERT_ID}",
        "OAuth sign-in discovery on api.algovault.com failed %d of %d checks (MCP_OAUTH=%s):"
        % (len(bad), len(CHECKS), mode),
    ]
    lines += ["- %s: %s" % (LABEL[r.name], short(r.detail, 220)) for r in bad]
    if open_legs:
        lines.append("Not verified this run (origin unreachable or throttled): "
                     + ", ".join(r.name for r in open_legs))
    lines += [
        "Claude's and ChatGPT's connectors cannot complete sign-in while any of these is wrong; "
        "MCP_OAUTH unset (off) is the one-value rollback.",
        f"Action: dispatch {RECOMMENDED_WAVE} via Cowork → Claude Code",
    ]
    return "\n".join(lines)


def metrics_for(mode, results, verdict, action, notes, alert_exit, state) -> dict:
    return {
        "mode": mode,
        "checks": {r.name: r.state for r in results},
        "failed": [r.name for r in results if r.state == FAIL],
        "indeterminate": [r.name for r in results if r.state == INDETERMINATE],
        "detail": {r.name: short(r.detail, 160) for r in results if r.state != PASS},
        "client_registered_this_run": notes.get("registered", 0),
        "client_registrations_total": int(state.get("registrations", 0) or 0),
        "state_saved": notes.get("state_saved", True),
        "action": action,
        "alert_exit": alert_exit,
    }


# ── I/O ──────────────────────────────────────────────────────────────────────────────────────────


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect on a discovery path is an answer to judge, never a hop to follow."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def real_fetch(method: str, path: str, headers=None, body=None) -> Resp:
    hdrs = {"User-Agent": UA}
    hdrs.update(headers or {})
    req = urllib.request.Request(ORIGIN + path, data=body, method=method, headers=hdrs)
    try:
        try:
            r = _OPENER.open(req, timeout=HTTP_TIMEOUT_S)
        except urllib.error.HTTPError as e:
            r = e
        with r:
            raw = r.read(BODY_CAP)
            status = r.status if hasattr(r, "status") else r.code
            h = {}
            for k, v in r.headers.items():
                k = k.lower()
                h[k] = v if k not in h else h[k] + ", " + v
        return Resp(status, h, raw)
    except (urllib.error.URLError, OSError, ssl.SSLError, socket.timeout, http.client.HTTPException) as e:
        raise NetError("%s: %s" % (type(e).__name__, str(e)[:120]))


def read_mode(run=None) -> str:
    try:
        proc = (run or subprocess.run)(["docker", "exec", APP_CONTAINER, "node", "-e", MODE_JS],
                                       capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as e:
        raise ModeUnreadable("docker exec failed: %s: %s" % (type(e).__name__, str(e)[:120]))
    if proc.returncode != 0:
        raise ModeUnreadable("docker exec exit %d: %s" % (proc.returncode, (proc.stderr or "").strip()[:160]))
    return parse_mode_output(proc.stdout)


def load_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:  # noqa: BLE001 — an unreadable state means "no client yet", never a crash
        log("state unreadable, starting fresh: %s" % str(e)[:120])
        return {}


def save_state(state: dict) -> bool:
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=STATE_DIR, prefix=".state.")
        with os.fdopen(fd, "w") as f:
            json.dump(state, f, sort_keys=True)
        os.replace(tmp, STATE_FILE)
        return True
    except OSError as e:
        log("STATE_WRITE_FAILED: %s" % str(e)[:160])
        return False


def fire(body: str):
    proc = subprocess.run([WRAPPER, ALERT_ID, SEVERITY, "-"], input=body,
                          capture_output=True, text=True, timeout=WRAPPER_TIMEOUT_S)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))
    return proc.returncode


def clear(reason: str):
    with open(os.devnull, "rb") as devnull:
        proc = subprocess.run([WRAPPER, "--clear", ALERT_ID, reason], stdin=devnull,
                              capture_output=True, text=True, timeout=WRAPPER_TIMEOUT_S)
    log("wrapper --clear exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))
    return proc.returncode


def record(verdict: str, exit_code: int, metrics: dict) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import canary_result_log  # noqa: E402 — lives beside this file on the host
        ok, detail = canary_result_log.append_result(CANARY, verdict, exit_code, metrics)
    except Exception as e:  # noqa: BLE001 — a recorder failure must never change the verdict
        ok, detail = False, "import/append raised: %s" % str(e)[:160]
    print("CANARY_RESULT_LOG=%s" % detail if ok else "CANARY_RESULT_LOG_FAILED=%s" % detail, flush=True)


def make_bogus() -> str:
    return "canary-bogus-" + secrets.token_urlsafe(24)


# ── orchestration ────────────────────────────────────────────────────────────────────────────────


def guarded(name: str, fn) -> R:
    try:
        return fn()
    except NetError as e:
        return R(name, INDETERMINATE, "origin unreachable: %s" % e)


def token_leg(d, state: dict, notes: dict) -> R:
    """POST /token with a bogus refresh token as the canary-owned DCR client -> 400 invalid_grant."""
    name = "token_invalid_grant"
    for attempt in (1, 2):
        fresh = False
        cid = state.get("client_id")
        if not cid:
            reg = d.fetch("POST", "/register", {"Content-Type": "application/json", "Accept": "application/json"},
                          json.dumps(REGISTER_BODY).encode())
            if reg.status in UNAVAILABLE_STATUS:
                return R(name, INDETERMINATE, "register answered %d (unavailable or throttled)" % reg.status)
            cid, why = parse_registration(reg)
            if cid is None:
                return R(name, FAIL, why)
            fresh = True
            state["client_id"] = cid
            state["client_registered_at"] = d.now()
            state["registrations"] = int(state.get("registrations", 0) or 0) + 1
            notes["registered"] = notes.get("registered", 0) + 1
            notes["state_saved"] = bool(d.save_state(state))
        body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": d.bogus(),
                                       "client_id": cid}).encode()
        resp = d.fetch("POST", "/token", {"Content-Type": "application/x-www-form-urlencoded",
                                          "Accept": "application/json"}, body)
        if oauth_error(resp) == "invalid_client" and not fresh and attempt == 1:
            state.pop("client_id", None)       # the server forgot the stored client: register once more
            continue
        if oauth_error(resp) == "invalid_client" and fresh:
            return R(name, FAIL, "a client registered moments ago is rejected as invalid_client")
        return judge(name, resp, validate_token)
    return R(name, FAIL, "no client could be established")     # unreachable by construction


def run_checks(d, state: dict, notes: dict) -> list:
    return [
        guarded("prm", lambda: judge("prm", d.fetch("GET", PRM_PATH), lambda r: validate_prm(r, RESOURCE))),
        guarded("prm_echo", lambda: judge("prm_echo", d.fetch("GET", PRM_PATH + "?src=docs"),
                                          lambda r: validate_prm(r, ECHO_RESOURCE))),
        guarded("as_metadata", lambda: judge("as_metadata", d.fetch("GET", AS_PATH), validate_as)),
        guarded("signin_challenge", lambda: judge(
            "signin_challenge",
            d.fetch("POST", MCP_SIGNIN_PATH,
                    {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
                    json.dumps(MCP_CALL).encode()),
            validate_signin)),
        guarded("token_invalid_grant", lambda: token_leg(d, state, notes)),
        guarded("chatgpt_cimd", lambda: judge("chatgpt_cimd", d.fetch("GET", CHATGPT_AUTHORIZE_PATH), validate_chatgpt)),
    ]


def safely(d, label: str, fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001 — the wrapper is the alert path, never the verdict
        d.log("%s failed (fail-open): %s" % (label, str(e)[:160]))
        return None


def run(d) -> tuple:
    """One canary run against injected dependencies -> (verdict, exit_code). Prints no token."""
    at = d.now()
    state = d.load_state()
    prior = state.get("last_decisive_verdict")
    notes: dict = {}
    try:
        mode = d.read_mode()
    except ModeUnreadable as e:
        d.log("mode unreadable -> INDETERMINATE: %s" % e)
        d.record(INDETERMINATE, EXIT_FOR[INDETERMINATE],
                 {"mode": None, "reason": short(str(e), 200), "checks": {}, "action": "none"})
        return INDETERMINATE, EXIT_FOR[INDETERMINATE]

    if mode == "off":
        action = "clear" if prior == FAIL else "none"
        d.log("MCP_OAUTH=off -> SKIPPED_FLAG_OFF (no probe made; the OAuth paths answer 404 by design)")
        state.update({"last_run_at": at, "last_decisive_verdict": SKIPPED})
        notes["state_saved"] = bool(d.save_state(state))
        alert_exit = None
        if action == "clear":
            alert_exit = safely(d, "wrapper --clear", d.clear, "MCP_OAUTH is off: the sign-in surface is rolled back")
        d.record(SKIPPED, EXIT_FOR[SKIPPED],
                 {"mode": mode, "checks": {}, "action": action, "alert_exit": alert_exit,
                  "state_saved": notes["state_saved"]})
        return SKIPPED, EXIT_FOR[SKIPPED]

    results = run_checks(d, state, notes)
    verdict, code, action = decide(results)
    for r in results:
        d.log("%-20s %s%s" % (r.name, r.state, "" if r.state == PASS else " — " + short(r.detail, 200)))
    state["last_run_at"] = at
    if verdict in (PASS, FAIL):
        state["last_decisive_verdict"] = verdict
    notes["state_saved"] = bool(d.save_state(state)) and notes.get("state_saved", True)
    alert_exit = None
    if action == "fire":
        alert_exit = safely(d, "wrapper", d.fire, alert_body(mode, results))
    elif action == "clear":
        alert_exit = safely(d, "wrapper --clear", d.clear, "OAuth sign-in discovery verified: all %d checks pass" % len(CHECKS))
    d.record(verdict, code, metrics_for(mode, results, verdict, action, notes, alert_exit, state))
    return verdict, code


class Deps:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def real_deps() -> Deps:
    return Deps(now=now_iso, log=log, read_mode=read_mode, fetch=real_fetch, load_state=load_state,
                save_state=save_state, fire=fire, clear=clear, record=record, bogus=make_bogus)


def main() -> int:
    verdict, code = run(real_deps())
    print(f"OAUTH_DISCOVERY_VERDICT={verdict}", flush=True)
    return code


# ── self-test ────────────────────────────────────────────────────────────────────────────────────

ASSERTION_COUNT = 139


def _resp(status, body=None, headers=None, raw=None):
    h = {"content-type": "application/json; charset=utf-8"}
    h.update(headers or {})
    return Resp(status, h, raw if raw is not None else json.dumps(body).encode())


def good_prm(resource=RESOURCE):
    return _resp(200, {"resource": resource, "authorization_servers": [ISSUER],
                       "scopes_supported": [SCOPE], "bearer_methods_supported": ["header"],
                       "resource_name": "AlgoVault"}, {"cache-control": "public, max-age=300"})


def good_as():
    return _resp(200, {"issuer": ISSUER, "authorization_endpoint": ISSUER + "/authorize",
                       "token_endpoint": ISSUER + "/token", "registration_endpoint": ISSUER + "/register",
                       "code_challenge_methods_supported": ["S256"],
                       "token_endpoint_auth_methods_supported": ["none"],
                       "client_id_metadata_document_supported": True,
                       "authorization_response_iss_parameter_supported": True,
                       "scopes_supported": [SCOPE, "offline_access"]}, {"cache-control": "public, max-age=300"})


def good_signin():
    return _resp(401, SIGNIN_BODY, {"www-authenticate": signin_header(), "cache-control": "no-store"})


def good_token():
    return _resp(400, {"error": "invalid_grant", "error_description": "The refresh token is invalid."},
                 {"cache-control": "no-store"})


def good_register(cid="11111111-2222-3333-4444-555555555555"):
    return _resp(201, {"client_id": cid, "redirect_uris": REGISTER_BODY["redirect_uris"],
                       "token_endpoint_auth_method": "none"}, {"cache-control": "no-store"})


def invalid_client():
    return _resp(400, {"error": "invalid_client", "error_description": "Invalid client_id"})


def chatgpt_302(query="error=invalid_request&error_description=Invalid+response_type&iss=" + urllib.parse.quote(ISSUER, safe=""),
                target=CHATGPT_REDIRECT):
    return Resp(302, {"location": target + "?" + query}, b"")


class Harness:
    """Fake dependencies: a routing table of (METHOD, path) -> Resp | NetError | [sequence]."""

    def __init__(self, mode="optin", routes=None, state=None, save_ok=True):
        self.mode = mode
        base = {("GET", PRM_PATH): good_prm(), ("GET", PRM_PATH + "?src=docs"): good_prm(ECHO_RESOURCE),
                ("GET", AS_PATH): good_as(), ("POST", MCP_SIGNIN_PATH): good_signin(),
                ("POST", "/token"): good_token(), ("POST", "/register"): good_register(),
                ("GET", CHATGPT_AUTHORIZE_PATH): chatgpt_302()}
        base.update(routes or {})
        self.routes = {k: (list(v) if isinstance(v, list) else [v]) for k, v in base.items()}
        self.state = dict(state if state is not None else {"client_id": "stored-client-0001"})
        self.save_ok = save_ok
        self.calls, self.logs, self.fired, self.cleared, self.records, self.saved = [], [], [], [], [], []
        self.token_bodies = []

    def fetch(self, method, path, headers=None, body=None):
        self.calls.append((method, path))
        if (method, path) == ("POST", "/token"):
            self.token_bodies.append(body)
        item = self.routes[(method, path)]
        r = item.pop(0) if len(item) > 1 else item[0]
        if isinstance(r, Exception):
            raise r
        return r

    def deps(self, mode_raises=None):
        def read_mode():
            if mode_raises:
                raise ModeUnreadable(mode_raises)
            return self.mode

        def save(state):
            self.saved.append(dict(state))
            return self.save_ok

        return Deps(now=lambda: "2026-10-28T11:43:00Z", log=self.logs.append, read_mode=read_mode,
                    fetch=self.fetch, load_state=lambda: dict(self.state), save_state=save,
                    fire=lambda body: (self.fired.append(body), 0)[1],
                    clear=lambda reason: (self.cleared.append(reason), 0)[1],
                    record=lambda v, c, m: self.records.append((v, c, m)),
                    bogus=lambda: "BOGUS-REFRESH-SENTINEL-7f3a")


def _raises(fn) -> bool:
    try:
        fn()
    except Exception:  # noqa: BLE001
        return True
    return False


def self_test() -> int:
    fails: list = []
    ran = 0

    def check(name, cond):
        nonlocal ran
        ran += 1
        try:
            ok = bool(cond() if callable(cond) else cond)
        except Exception as e:  # noqa: BLE001 — a raising assertion is a FAIL, never a crash
            ok, name = False, "%s (raised %s: %s)" % (name, type(e).__name__, e)
        print(("  ok   " if ok else "  FAIL ") + name, flush=True)
        if not ok:
            fails.append(name)

    def go(**kw):
        mode_raises = kw.pop("mode_raises", None)
        h = Harness(**kw)
        v, c = run(h.deps(mode_raises))
        return h, v, c

    # ── the contract literals, from an independent oracle (the wave brief), not from this file ──
    check("the sign-in WWW-Authenticate is byte-for-byte the contract",
          signin_header() == 'Bearer error="invalid_token", error_description="Sign in free to keep using AlgoVault", '
                             'scope="mcp:tools", resource_metadata="https://api.algovault.com/.well-known/'
                             'oauth-protected-resource/mcp?signin=1"')
    check("the sign-in body is exactly the contract",
          SIGNIN_BODY == {"error": "invalid_token", "error_description": "Sign in free to keep using AlgoVault",
                          "algovault": {"reason": "signin", "message": "Sign in to continue. It's free, no card.",
                                        "sign_in_url": "https://api.algovault.com/welcome?src=stepup"}})
    check("resource, echo resource, issuer", (RESOURCE, ECHO_RESOURCE, ISSUER) ==
          ("https://api.algovault.com/mcp", "https://api.algovault.com/mcp?src=docs", "https://api.algovault.com"))
    check("the verdict set and its exit codes", EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3, "SKIPPED_FLAG_OFF": 0})

    # ── validators, each assertion isolated by a fixture that violates only it ──
    check("prm: the good document passes", validate_prm(good_prm(), RESOURCE) == [])
    check("prm: 404 fails", validate_prm(_resp(404, {"error": "x"}), RESOURCE) != [])
    check("prm: a non-JSON 200 fails", validate_prm(_resp(200, raw=b"<html>"), RESOURCE) != [])
    check("prm: a JSON array is not an object", validate_prm(_resp(200, raw=b"[]"), RESOURCE) != [])
    check("prm: wrong resource fails", validate_prm(good_prm("https://api.algovault.com/other"), RESOURCE) != [])
    check("prm: wrong authorization_servers fails", validate_prm(
        _resp(200, {"resource": RESOURCE, "authorization_servers": [ISSUER + "/"], "scopes_supported": [SCOPE]}), RESOURCE) != [])
    check("prm: scopes_supported without mcp:tools fails", validate_prm(
        _resp(200, {"resource": RESOURCE, "authorization_servers": [ISSUER], "scopes_supported": ["x"]}), RESOURCE) != [])
    check("prm echo: the bare resource is NOT the echoed one", validate_prm(good_prm(RESOURCE), ECHO_RESOURCE) != [])
    check("prm echo: the echoed resource passes", validate_prm(good_prm(ECHO_RESOURCE), ECHO_RESOURCE) == [])

    def as_with(**over):
        d = json.loads(good_as().body)
        d.update(over)
        return _resp(200, d)

    check("as: the good document passes", validate_as(good_as()) == [])
    check("as: 404 fails", validate_as(_resp(404, {"error": "x"})) != [])
    check("as: wrong issuer fails", validate_as(as_with(issuer=ISSUER + "/")) != [])
    check("as: CIMD false fails", validate_as(as_with(client_id_metadata_document_supported=False)) != [])
    check("as: CIMD as a string 'true' fails (strictly true)", validate_as(as_with(client_id_metadata_document_supported="true")) != [])
    check("as: iss parameter false fails", validate_as(as_with(authorization_response_iss_parameter_supported=False)) != [])
    check("as: no S256 fails", validate_as(as_with(code_challenge_methods_supported=["plain"])) != [])
    check("as: no auth method none fails", validate_as(as_with(token_endpoint_auth_methods_supported=["client_secret_basic"])) != [])
    check("as: a different token_endpoint fails", validate_as(as_with(token_endpoint=ISSUER + "/oauth/token")) != [])
    check("as: a different registration_endpoint fails", validate_as(as_with(registration_endpoint=ISSUER + "/oauth/register")) != [])

    def signin_with(status=401, headers=None, body=SIGNIN_BODY):
        h = {"www-authenticate": signin_header(), "cache-control": "no-store"}
        h.update(headers or {})
        return _resp(status, body, h)

    check("signin: the good 401 passes", validate_signin(good_signin()) == [])
    check("signin: a 200 with the EXACT right headers and body still fails (status is its own assertion)",
          validate_signin(signin_with(status=200)) != [])
    check("signin: a 403 with the exact headers and body fails", validate_signin(signin_with(status=403)) != [])
    check("signin: a different description in the header fails", validate_signin(signin_with(
        headers={"www-authenticate": signin_header().replace("Sign in free", "Log in")})) != [])
    check("signin: a missing resource_metadata fails", validate_signin(signin_with(
        headers={"www-authenticate": 'Bearer error="invalid_token"'})) != [])
    check("signin: the PRM URL without the echoed ?signin=1 fails", validate_signin(signin_with(
        headers={"www-authenticate": signin_header().replace("?signin=1", "")})) != [])
    check("signin: no WWW-Authenticate at all fails", validate_signin(_resp(401, SIGNIN_BODY, {"cache-control": "no-store"})) != [])
    check("signin: Cache-Control public fails", validate_signin(signin_with(headers={"cache-control": "public, max-age=300"})) != [])
    check("signin: no Cache-Control fails", validate_signin(_resp(401, SIGNIN_BODY, {"www-authenticate": signin_header()})) != [])
    check("signin: Cache-Control NO-STORE (case) passes", validate_signin(signin_with(headers={"cache-control": "No-Store"})) == [])
    check("signin: body key ORDER does not matter", validate_signin(signin_with(body={
        "algovault": {"sign_in_url": SIGNIN_URL, "message": SIGNIN_MESSAGE, "reason": "signin"},
        "error_description": SIGNIN_DESCRIPTION, "error": "invalid_token"})) == [])
    check("signin: a wrong reason fails", validate_signin(signin_with(body={
        **SIGNIN_BODY, "algovault": {**SIGNIN_BODY["algovault"], "reason": "wall_month"}})) != [])
    check("signin: a wrong message fails", validate_signin(signin_with(body={
        **SIGNIN_BODY, "algovault": {**SIGNIN_BODY["algovault"], "message": "Please sign in."}})) != [])
    check("signin: a wrong sign_in_url fails", validate_signin(signin_with(body={
        **SIGNIN_BODY, "algovault": {**SIGNIN_BODY["algovault"], "sign_in_url": "https://example.com/"}})) != [])
    check("signin: a missing algovault object fails", validate_signin(signin_with(body={
        "error": "invalid_token", "error_description": SIGNIN_DESCRIPTION})) != [])
    check("signin: an unexpected extra key fails", validate_signin(signin_with(body={**SIGNIN_BODY, "extra": 1})) != [])
    check("signin: an SSE body (the tool was served) fails", validate_signin(_resp(200, raw=b"event: message\ndata: {}\n\n")) != [])
    check("token: 400 invalid_grant passes", validate_token(good_token()) == [])
    check("token: 400 invalid_client fails", validate_token(invalid_client()) != [])
    check("token: 400 invalid_request fails", validate_token(_resp(400, {"error": "invalid_request"})) != [])
    check("token: a 200 fails", validate_token(_resp(200, {"access_token": "x"})) != [])
    check("token: invalid_grant under a 500 fails", validate_token(_resp(500, {"error": "invalid_grant"})) != [])
    iss_q = "iss=" + urllib.parse.quote(ISSUER, safe="")
    check("chatgpt: 302 to its redirect with error + iss passes", validate_chatgpt(chatgpt_302()) == [])
    check("chatgpt: 400 invalid_client fails and says the document is refused",
          "ChatGPT's client document is refused (invalid_client)" in validate_chatgpt(invalid_client()))
    check("chatgpt: a 302 with no iss fails", validate_chatgpt(chatgpt_302("error=invalid_request")) != [])
    check("chatgpt: iss twice fails", validate_chatgpt(chatgpt_302("error=invalid_request&" + iss_q + "&" + iss_q)) != [])
    check("chatgpt: another issuer fails", validate_chatgpt(chatgpt_302("error=invalid_request&iss=https%3A%2F%2Fevil.example")) != [])
    check("chatgpt: a look-alike redirect path fails",
          validate_chatgpt(chatgpt_302(target=CHATGPT_REDIRECT + ".evil.example")) != [])
    check("chatgpt: a 302 with no error fails", validate_chatgpt(chatgpt_302("code=abc&" + iss_q)) != [])
    check("chatgpt: a 200 fails", validate_chatgpt(_resp(200, raw=b"<html>")) != [])
    check("register: 201 with a client_id parses", parse_registration(good_register()) == ("11111111-2222-3333-4444-555555555555", ""))
    check("register: a 200 is refused", parse_registration(_resp(200, {"client_id": "11111111-2222"}))[0] is None)
    check("register: no client_id is refused", parse_registration(_resp(201, {"redirect_uris": []}))[0] is None)
    check("register: a client_secret in the answer is refused", parse_registration(
        _resp(201, {"client_id": "11111111-2222", "client_secret": "S"}))[0] is None)
    check("register: a client_id with a space is refused", parse_registration(_resp(201, {"client_id": "bad id 123456"}))[0] is None)

    # ── the verdict rule ──
    mk = lambda **s: [R(n, s.get(n, PASS), "d") for n in CHECKS]
    check("decide: all pass -> PASS/0/clear", decide(mk()) == (PASS, 0, "clear"))
    check("decide: one FAIL -> FAIL/1/fire", decide(mk(prm=FAIL)) == (FAIL, 1, "fire"))
    check("decide: one INDETERMINATE -> INDETERMINATE/3/none", decide(mk(prm=INDETERMINATE)) == (INDETERMINATE, 3, "none"))
    check("decide: FAIL beats INDETERMINATE (a decisive failure is real)", decide(mk(prm=FAIL, as_metadata=INDETERMINATE)) == (FAIL, 1, "fire"))
    check("decide: an empty result set is INDETERMINATE, never PASS", decide([]) == (INDETERMINATE, 3, "none"))
    check("decide: five of six checks is INDETERMINATE, never PASS", decide(mk()[:5]) == (INDETERMINATE, 3, "none"))

    # ── the mode ──
    for m in MODES:
        check("mode output %s parses" % m, parse_mode_output('{"mode":"%s"}' % m) == m)
    check("mode: the last line wins over stray output", parse_mode_output('noise\n{"mode":"wall"}\n') == "wall")
    for bad in ("", "not json", '{"mode":"on"}', '{"mode":null}', "[1]"):
        check("mode: %r is unreadable" % bad, _raises(lambda b=bad: parse_mode_output(b)))

    # ── orchestration: the whole run against fakes ──
    h, v, c = go()
    check("run: everything good -> PASS/0", (v, c) == (PASS, 0))
    check("run: PASS probes all six and registers nothing for a stored client",
          sorted(h.calls) == sorted([("GET", PRM_PATH), ("GET", PRM_PATH + "?src=docs"), ("GET", AS_PATH),
                                     ("POST", MCP_SIGNIN_PATH), ("POST", "/token"), ("GET", CHATGPT_AUTHORIZE_PATH)]))
    check("run: PASS --clears and never pages", len(h.cleared) == 1 and h.fired == [])
    check("run: the record names all six checks, once", len(h.records) == 1 and
          set(h.records[0][2]["checks"]) == set(CHECKS))
    h, v, c = go(mode="wall")
    check("run: wall mode runs the same six checks -> PASS", (v, c) == (PASS, 0) and len(h.calls) == 6)

    h, v, c = go(mode="off")
    check("run: off -> SKIPPED_FLAG_OFF/0", (v, c) == (SKIPPED, 0))
    check("run: off makes NO request at all", h.calls == [])
    check("run: off never pages and (no prior FAIL) never clears", h.fired == [] and h.cleared == [])
    check("run: off is recorded as SKIPPED_FLAG_OFF with its mode", h.records[0][0] == SKIPPED and h.records[0][2]["mode"] == "off")
    h, v, c = go(mode="off", state={"last_decisive_verdict": FAIL})
    check("run: off after a paged FAIL --clears once (the rollback is the resolution)", (v, c) == (SKIPPED, 0) and len(h.cleared) == 1 and h.fired == [])
    check("run: …and remembers it, so the next off run is silent", h.saved[-1].get("last_decisive_verdict") == SKIPPED)

    h, v, c = go(mode_raises="docker exec exit 1: no such container")
    check("run: unreadable mode -> INDETERMINATE/3", (v, c) == (INDETERMINATE, 3))
    check("run: unreadable mode probes nothing and pages nothing", h.calls == [] and h.fired == [] and h.cleared == [])

    # each check failing alone pages exactly once and names the leg
    def fails_alone(route, resp, leg):
        h, v, c = go(routes={route: resp})
        return ((v, c) == (FAIL, 1) and len(h.fired) == 1 and h.cleared == []
                and ALERT_ID in h.fired[0] and LABEL[leg] in h.fired[0]
                and h.records[0][2]["failed"] == [leg])

    check("run: prm 404 -> FAIL naming prm (mounted-but-dark)", fails_alone(("GET", PRM_PATH), _resp(404, {"error": "x"}), "prm"))
    check("run: prm 500 -> FAIL (a 500 is a defect, not weather)", fails_alone(("GET", PRM_PATH), _resp(500, {"error": "x"}), "prm"))
    check("run: prm redirect -> FAIL (never followed)", fails_alone(("GET", PRM_PATH), Resp(301, {"location": "https://x/"}, b""), "prm"))
    check("run: echo dropped -> FAIL naming prm_echo only", fails_alone(("GET", PRM_PATH + "?src=docs"), good_prm(RESOURCE), "prm_echo"))
    check("run: AS metadata wrong issuer -> FAIL naming as_metadata", fails_alone(("GET", AS_PATH), _resp(200, {"issuer": "x"}), "as_metadata"))
    check("run: ?signin=1 served a 200 -> FAIL naming signin_challenge",
          fails_alone(("POST", MCP_SIGNIN_PATH), _resp(200, {"jsonrpc": "2.0", "id": 1, "result": {}}), "signin_challenge"))
    check("run: /token 200 -> FAIL naming token_invalid_grant", fails_alone(("POST", "/token"), _resp(200, {"access_token": "x"}), "token_invalid_grant"))
    check("run: ChatGPT's document refused (400 invalid_client) -> FAIL naming chatgpt_cimd",
          fails_alone(("GET", CHATGPT_AUTHORIZE_PATH), invalid_client(), "chatgpt_cimd"))

    # network failure and gateway answers are INDETERMINATE
    h, v, c = go(routes={("GET", AS_PATH): NetError("URLError: timed out")})
    check("run: a network failure on one leg -> INDETERMINATE/3, no page", (v, c) == (INDETERMINATE, 3) and h.fired == [] and h.cleared == [])
    check("run: …and the record names the leg it could not read", h.records[0][2]["indeterminate"] == ["as_metadata"])
    for st in sorted(UNAVAILABLE_STATUS):
        h, v, c = go(routes={("GET", PRM_PATH): _resp(st, {"error": "x"})})
        check("run: a %d on prm -> INDETERMINATE, no page" % st, (v, c) == (INDETERMINATE, 3) and h.fired == [])
    h, v, c = go(routes={("GET", PRM_PATH): _resp(404, {}), ("GET", AS_PATH): NetError("x")})
    check("run: FAIL + an unreachable leg -> FAIL, and the page lists the unverified leg",
          (v, c) == (FAIL, 1) and len(h.fired) == 1 and "Not verified this run" in h.fired[0] and "as_metadata" in h.fired[0])
    h, v, c = go(routes={("POST", MCP_SIGNIN_PATH): NetError("x")})
    check("run: an unreachable leg never --clears", (v, c) == (INDETERMINATE, 3) and h.cleared == [])

    # the DCR client: registered once, reused, re-registered once, never in a loop
    h, v, c = go(state={})
    check("dcr: no stored client -> registers once, then PASS", (v, c) == (PASS, 0) and h.calls.count(("POST", "/register")) == 1)
    check("dcr: …the client id is persisted before the next run", h.saved and h.saved[0].get("client_id") == "11111111-2222-3333-4444-555555555555")
    check("dcr: …and the token call carried that id", b"client_id=11111111-2222-3333-4444-555555555555" in h.token_bodies[0])
    check("dcr: …the record counts the registration", h.records[0][2]["client_registered_this_run"] == 1 and h.records[0][2]["client_registrations_total"] == 1)
    h, v, c = go(state={"client_id": "stored-client-0001", "registrations": 1})
    check("dcr: a stored client is reused with NO register call", h.calls.count(("POST", "/register")) == 0 and b"client_id=stored-client-0001" in h.token_bodies[0])
    h, v, c = go(routes={("POST", "/token"): [invalid_client(), good_token()]})
    check("dcr: the stored client rejected as invalid_client -> re-register once, then PASS",
          (v, c) == (PASS, 0) and h.calls.count(("POST", "/register")) == 1 and h.calls.count(("POST", "/token")) == 2)
    check("dcr: …and the NEW client id replaces the stored one", h.saved[0].get("client_id") == "11111111-2222-3333-4444-555555555555")
    h, v, c = go(state={}, routes={("POST", "/token"): invalid_client()})
    check("dcr: a client registered moments ago and rejected -> FAIL, one register, no loop",
          (v, c) == (FAIL, 1) and h.calls.count(("POST", "/register")) == 1 and h.calls.count(("POST", "/token")) == 1)
    h, v, c = go(routes={("POST", "/token"): invalid_client()})
    check("dcr: invalid_client on the re-registered client too -> FAIL, never a third attempt",
          (v, c) == (FAIL, 1) and h.calls.count(("POST", "/register")) == 1 and h.calls.count(("POST", "/token")) == 2)
    h, v, c = go(state={}, routes={("POST", "/register"): _resp(500, {"error": "server_error"})})
    check("dcr: register 500 -> FAIL naming the token leg", (v, c) == (FAIL, 1) and h.records[0][2]["failed"] == ["token_invalid_grant"])
    h, v, c = go(state={}, routes={("POST", "/register"): _resp(503, {})})
    check("dcr: register 503 -> INDETERMINATE", (v, c) == (INDETERMINATE, 3) and h.fired == [])
    h, v, c = go(state={}, save_ok=False)
    check("dcr: a state write failure is recorded, not hidden, and does not change the verdict",
          (v, c) == (PASS, 0) and h.records[0][2]["state_saved"] is False)

    # nothing secret is ever printed, stored or paged
    h, v, c = go(state={}, routes={("POST", "/register"): _resp(201, {"client_id": "11111111-2222-3333", "client_secret": "SECRET-SENTINEL-9d1"})})
    everything = json.dumps([h.logs, h.fired, h.records, h.saved, h.state])
    check("secrets: a server-sent client_secret is refused and appears nowhere", (v, c) == (FAIL, 1) and "SECRET-SENTINEL-9d1" not in everything)
    h, v, c = go(state={})
    everything = json.dumps([h.logs, h.fired, h.records, h.saved])
    check("secrets: the bogus refresh token reaches /token and nowhere else",
          b"BOGUS-REFRESH-SENTINEL-7f3a" in h.token_bodies[0] and "BOGUS-REFRESH-SENTINEL-7f3a" not in everything)
    check("secrets: the client id is not logged", "11111111-2222-3333-4444-555555555555" not in json.dumps(h.logs))
    check("secrets: the generated bogus token is random per run and never a real credential shape",
          make_bogus() != make_bogus() and make_bogus().startswith("canary-bogus-"))

    # the page
    body = alert_body("optin", [R("prm", FAIL, "status 404 (want 200)")] + [R(n, PASS, "ok") for n in CHECKS[1:]])
    check("alert: names the alert id, the mode, the failing leg and the count",
          ALERT_ID in body and "MCP_OAUTH=optin" in body and "1 of 6" in body and LABEL["prm"] in body)
    check("alert: carries the W{NEXT} template and never a literal wave number",
          "OPS-OAUTH-DISCOVERY-W{NEXT}" in body and not re.search(r"-W\d", body))
    check("alert: states the rollback lever", "MCP_OAUTH unset (off)" in body)

    # ── structural: what the seams replaced ──
    check("probe: the ChatGPT leg asks as the stable CIMD client, for a response_type the server refuses",
          CHATGPT_AUTHORIZE_PATH == "/authorize?response_type=token&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient.json"
                                    "&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector_platform_oauth_redirect&state=x")
    check("probe: the mode comes from the deployed module's own resolver, not the env var",
          "require(" in MODE_JS and MODE_MODULE == "/app/dist/lib/oauth/mode.js" and "resolveOAuthMode()" in MODE_JS
          and "process.env" not in MODE_JS)

    class _P:
        def __init__(s, rc=0, out='{"mode":"off"}', err=""):
            s.returncode, s.stdout, s.stderr = rc, out, err

    seen = []
    check("probe: read_mode runs docker exec on the app container and parses", read_mode(
        lambda *a, **k: (seen.append((a, k)), _P())[1]) == "off"
          and seen[0][0][0] == ["docker", "exec", APP_CONTAINER, "node", "-e", MODE_JS]
          and seen[0][1]["timeout"] == DOCKER_TIMEOUT_S)
    check("probe: a non-zero docker exit is unreadable", _raises(lambda: read_mode(lambda *a, **k: _P(rc=1, err="no such container"))))

    def _no_docker(*a, **k):
        raise FileNotFoundError("docker")

    def _timeout(*a, **k):
        raise subprocess.TimeoutExpired("docker", 30)

    check("probe: docker missing is unreadable (ModeUnreadable, not a crash)", _raises(lambda: read_mode(_no_docker)))
    check("probe: a docker timeout is unreadable", _raises(lambda: read_mode(_timeout)))
    try:
        read_mode(_no_docker)
    except ModeUnreadable:
        mode_exc = True
    except Exception:  # noqa: BLE001
        mode_exc = False
    check("probe: …and the exception is the typed ModeUnreadable run() catches", mode_exc)
    check("fetch: a redirect is never followed", _NoRedirect().redirect_request(None, None, 301, "m", {}, "https://x/") is None)
    check("fetch: the opener is built from the no-redirect handler",
          any(isinstance(hd, _NoRedirect) for hd in _OPENER.handlers))
    check("fetch: every call has an enforced timeout", HTTP_TIMEOUT_S > 0 and DOCKER_TIMEOUT_S > 0 and WRAPPER_TIMEOUT_S > 0)

    calls = []
    real_run = subprocess.run
    subprocess.run = lambda *a, **k: (calls.append((a, k)), _P(out="sent"))[1]
    try:
        fire("BODY")
        clear("REASON")
    finally:
        subprocess.run = real_run
    check("wrapper: fire is [wrapper, ALERT_ID, CRITICAL_PERSISTENT, -] with the body on stdin",
          calls[0][0][0] == [WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"] and calls[0][1]["input"] == "BODY")
    check("wrapper: --clear is [wrapper, --clear, ALERT_ID, reason]", calls[1][0][0] == [WRAPPER, "--clear", ALERT_ID, "REASON"])
    check("wrapper: env is INHERITED, so ALGOVAULT_TG_TEST_INERT reaches the wrapper's own gate",
          "env" not in calls[0][1] and "env" not in calls[1][1])
    check("wrapper: timeouts are enforced", calls[0][1]["timeout"] == WRAPPER_TIMEOUT_S and calls[1][1]["timeout"] == WRAPPER_TIMEOUT_S)
    check("wrapper: a raising wrapper cannot change the verdict (fail-open)", _wrapper_raises_is_failopen())

    # the record fits the recorder's contract (built by the real recorder, written nowhere)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import canary_result_log
        worst = metrics_for("optin", [R(n, FAIL, "x" * 400) for n in CHECKS], FAIL, "fire",
                            {"registered": 1, "state_saved": False}, 0, {"registrations": 99})
        line = canary_result_log.build_record(CANARY, FAIL, 1, worst)
        fits = len(line.encode("utf-8")) < canary_result_log.MAX_LINE_BYTES
        parsed = json.loads(line)
    except Exception as e:  # noqa: BLE001
        fits, parsed = False, {"err": str(e)}
    check("record: the worst-case metrics fit canary_result_log's line cap (built, not written)", fits)
    check("record: the line carries this canary's name and verdict", parsed.get("canary") == CANARY and parsed.get("verdict") == FAIL)
    check("schedule: the worst-case runtime is bounded by the enforced timeouts (%ds)" % WORST_CASE_RUNTIME_S,
          WORST_CASE_RUNTIME_S == DOCKER_TIMEOUT_S + 8 * HTTP_TIMEOUT_S + WRAPPER_TIMEOUT_S == 180)

    if ran == 0:
        print("SELF-TEST: FAIL (vacuous — no checks ran)")
        print("OAUTH_DISCOVERY_SELFTEST=FAIL")
        return 1
    if ran != ASSERTION_COUNT:
        fails.append("assertion count drifted: ran %d, expected %d" % (ran, ASSERTION_COUNT))
    if fails:
        print("SELF-TEST: FAIL (%d of %d)" % (len(fails), ran))
        for f in fails:
            print("  - " + f)
        print("OAUTH_DISCOVERY_SELFTEST=FAIL")
        return 1
    print("SELF-TEST: PASS (%d checks)" % ran)
    print("OAUTH_DISCOVERY_SELFTEST=PASS")
    return 0


def _wrapper_raises_is_failopen() -> bool:
    h = Harness(routes={("GET", PRM_PATH): _resp(404, {})})
    d = h.deps()

    def boom(_):
        raise OSError("wrapper missing")

    d.fire = boom
    v, c = run(d)
    return (v, c) == (FAIL, 1) and h.records and h.records[0][2]["alert_exit"] is None


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(self_test())
    sys.exit(main())
