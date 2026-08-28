#!/usr/bin/env python3
"""client-claim-freshness.py — OPS-CLIENT-CLAIM-FRESHNESS-W1 (CH2)

A generic DECLARED-CLAIM vs LIVE-SOURCE prober. `verifiedAt` becomes an enforced expiry with a
live re-probe, not a frozen stamp.

── The bug class ────────────────────────────────────────────────────────────────────────────
`src/lib/integrations-data/mcp-clients.ts` carries 11 rows, each asserting a THIRD PARTY's MCP
capability via `kind`, with a `source` URL and a `verifiedAt` date. Nothing re-checked them, and
a third-party capability does not hold still.

Measured 2026-08-28, and it is why this file exists rather than a one-row edit: the `deepseek`
row renders on algovault.com stating verbatim

    "DeepSeek ships no MCP application of its own, and its API exposes no MCP parameter."

True when it was stamped `2026-08-05`. FALSE since `@deepseek-ai/dsh-mcp-client` was published
(npm `created` 2026-08-10, repo `github.com/deepseek-ai/deepseek-harness`, directory
`packages/mcp/mcp-client`, maintainer `tianyicui-deepseek`, dependency
`@modelcontextprotocol/sdk`). Its own README: "MCP client bridge plugin: connects to external
Model Context Protocol servers and registers their tools on `ctx.tools`". Worse,
`tests/unit/integrations-data.test.ts` LOCKS `deepseek.kind === 'byo-model'` with a comment
restating the false claim — so the Factuality gate was defending a Factuality violation.

Fixing the one row leaves the next Cursor / Codex / Kimi / GLM shift to be found by a customer.
This probes the whole corpus daily. The other 10 mcp-clients rows inherit it for free, and
`ai-agents.ts` (4 rows) + `exchange-kits.ts` (13 rows) share the same `IntegrationEntry`
interface and the same optional `source`/`verifiedAt`, so they extend it by ONE `CORPUS` line.

── WHY THE SOURCE URL ALONE CANNOT DECIDE, WHICH IS THE WHOLE DESIGN ────────────────────────
The commissioning spec said "fetch each row's `source` and apply the per-`kind` predicate".
MEASURED: that is structurally incapable of finding the defect that commissioned the wave. The
deepseek row's own source, `https://api-docs.deepseek.com/guides/anthropic_api`, returns 200 and
says `mcp_servers` -> "Ignored" and `mcp_tool_use` -> "Not Supported". It SUPPORTS the api-level
half of the claim. The half that is false — "ships no MCP application of its own" — is evidenced
only on npm and GitHub, which that page never mentions. A source-only predicate classifies
deepseek as CONFIRMS and this canary is dark on day one.

So a `byo-model` / `api-level` row takes a SECOND, independent input: the vendor's own npm scope,
probed for a first-party MCP client. The rows may not be edited by this wave, so the scope map is
DECLARED here, in `VENDOR_SCOPE`, with three states and a mandatory reason for the middle one:
  "@scope"        -> probe it
  None + reason   -> declared not-applicable; the reason is MANDATORY and lives on the entry,
                     never in prose, so a future wave enforcing the contract cannot "fix" it away
  absent entirely -> INDETERMINATE for that row. Adding a corpus module must not silently skip
                     the arm — a skipped row looks exactly like a healthy one.

── AGE THRESHOLD: 150 DAYS, AND WHY NOT THE SPEC'S 120 ──────────────────────────────────────
The commissioning spec offered 120d as a no-signal default, justified as "the smallest round
number above the observed 119-day maximum, so it fires on the next stamp that ages past today's
worst row rather than on the whole back catalogue at install."

CH1 measured the distribution and it gives signal, so the default does not apply. As of the
2026-08-28 run date: n=11, min 23d, median 23d, MAX 120d (6 rows stamped `2026-08-05` = 23d,
5 stamped `2026-04-30` = 120d). One day of drift since the spec was authored made the maximum
120, so a 120d threshold fires on FIVE rows on day one — precisely the outcome the spec's own
justification rules out, and it would bury the CONTRADICTION finding that is this wave's proof
of life under back-catalogue noise.

150d leaves the Apr-30 cohort 30 days of runway (first AGE fire 2026-09-27), still bounds any
vendor claim to <= 5 months, and keeps the first live FAIL attributable to the CONTRADICTION arm
alone. Widen it only with a measurement, never to quiet the alert — that is guard-blunting.

── Contract ─────────────────────────────────────────────────────────────────────────────────
Corpus: the `CORPUS` list below, in `ops/monitoring/declaration-sync.sh`'s pipe idiom. The host
has NO checkout, so each module is fetched from the committed SoT over HTTPS and parsed with a
regex over the row literals.

Two INDEPENDENT arms per row, each rendering one of
`ok` / `stale` / `contradicted` / `source unreachable` / `predicate indeterminate`:
  1. AGE           now - verifiedAt > AGE_THRESHOLD_DAYS
  2. CONTRADICTION the source must still evidence the declared `kind`; `byo-model`/`api-level`
                   additionally get the vendor npm-scope probe described above.

Row state = the strongest arm, in this precedence:
    contradicted > stale > (predicate indeterminate | source unreachable) > ok
A definite finding always beats an unknown. This is the direction the law requires: an
unavailable arm may never SILENCE the alert, so it never downgrades a FAIL — it only decides
what happens when nothing definite was found.

Aggregation:
  any contradicted                          -> FAIL
  else any stale                            -> FAIL
  else any indeterminate/unreachable        -> INDETERMINATE
  else                                      -> PASS
  parse yields < MIN_ROWS, or the row count moved by > ROW_COUNT_TOLERANCE vs the previous run
                                            -> INDETERMINATE
The third line closes a gap in the commissioning spec, which defined "all rows ok -> PASS" and
"EVERY row indeterminate -> INDETERMINATE" and left mixed ok/indeterminate undefined. Certifying
a partially-unverified corpus as PASS is exactly the fail-open the verdict-token law forbids.

Verdict token: exactly one terminal `CLIENT_CLAIM_FRESHNESS_VERDICT=PASS|FAIL|INDETERMINATE`.
Exit: 0 = evaluated (PASS, or FAIL with the alert dispatched) · 3 = INDETERMINATE (verified
NOTHING). 3 is the token-law default for a NEW gate. Callers gate on the TOKEN, never the bare
exit code — FAIL exits 0 because the alert IS the action.

── Two fetch behaviours that are corrections, not conveniences ──────────────────────────────
* REDIRECTS ARE FOLLOWED EXPLICITLY. Python's default redirect handler does not follow 308, and
  three of the eleven sources (cursor, cline, modelcontextprotocol.io) answer 308. Without this
  they read UNREACHABLE forever while `curl -L` gets 200 — an instrument structurally incapable
  of seeing its subject, returning a confident wrong answer. Caught in CH1 by cross-checking
  against curl; the fixture-driven self-test pins it.
* `www.npmjs.com/package/<pkg>` IS REWRITTEN TO `registry.npmjs.org/<pkg>`. The `smithery` row's
  source is an npmjs.com package page, which answers 403 to every headless fetch. This is the
  estate's existing law ("package readme verification via REGISTRY source, not CDN-protected
  page"), not a new exemption, and the rewrite is NAMED in that row's output line so it is a
  reported substitution rather than a silent one.

── Env / test seams ─────────────────────────────────────────────────────────────────────────
  CLIENT_CLAIM_LOG            log path            CLIENT_CLAIM_STATE      state file path
  CLIENT_CLAIM_TODAY          freeze "today" (YYYY-MM-DD)
  CLIENT_CLAIM_AGE_DAYS       threshold override — a DOCUMENTED TEST SEAM ONLY. Changing the
                              shipped threshold means editing AGE_THRESHOLD_DAYS above and
                              rewriting the justification, not setting this in a crontab.
  CLIENT_CLAIM_SELFTEST=1     short-circuits fire()/clear()
  TG_WRAPPER                  wrapper path
  ALGOVAULT_TG_TEST_INERT=1   suppresses BEFORE the wrapper's cooldown gate and writes no
                              marker. Use this for repeated gate runs — DRY_RUN_TG=1 is NOT
                              inert (send_telegram.sh writes the 24h marker on that path, so
                              back-to-back dry runs FALSE-GREEN on cooldown suppression).
  --self-test                 hermetic scenario suite; no network, no wrapper, no state file.

Cron: 17 2 * * * (canonical off-:00 minute per ops/monitoring/schedule-boundary-rule.json).
Daily, never hourly: vendor capability moves on a scale of weeks, and an hourly probe of eleven
third-party doc sites is rude and rate-limit bait.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ALERT_ID = "CLIENT_CLAIM_DRIFT"
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
LOG = os.environ.get("CLIENT_CLAIM_LOG", "/var/log/algovault-client-claim-freshness.log")
STATE = os.environ.get("CLIENT_CLAIM_STATE",
                       "/var/lib/algovault-monitoring/client-claim-freshness-state.json")

# See the AGE THRESHOLD paragraph in the module docstring. 150, derived from CH1's measured
# distribution (max 120d on 2026-08-28), not from a round number.
AGE_THRESHOLD_DAYS = max(1, int(os.environ.get("CLIENT_CLAIM_AGE_DAYS", "150")))

# Vacuity floor. WE construct this corpus by declaring modules, so a parse yielding almost
# nothing means the parser broke against a refactor, not that the claims vanished. mcp-clients
# ships 11; 8 is a truncation refusal, never a target.
MIN_ROWS = 8
# A corpus that moves by more than this between runs is a parser or a refactor event, not a
# content change, and an aggregate over it would be an aggregate over a truncated collection.
ROW_COUNT_TOLERANCE = 2

RAW_HOST = "https://raw.githubusercontent.com"
RAW_REPO = "AlgoVaultLabs/crypto-quant-signal-mcp"
# refs/heads/main AND /main/ share ONE 5-minute CDN TTL — the ref FORM is not a freshness
# control and never was. The control is the cache-buster below. (Measured twice; the "short-ref
# serves a stale edge" claim is false and is not re-litigated here.)
RAW_REF = "refs/heads/main"

# The declared corpus, in ops/monitoring/declaration-sync.sh's idiom: name|path|fields.
# Extending this canary to another claim-bearing module is ONE line.
CORPUS = [
    "mcp-clients|src/lib/integrations-data/mcp-clients.ts|kind,source,verifiedAt",
]

# Vendor npm scope per slug — the second, independent contradiction input. Three states; see the
# module docstring. An entry is REQUIRED for every byo-model/api-level row.
VENDOR_SCOPE = {
    "deepseek": "@deepseek-ai",
    "zai-api": None,
}
VENDOR_SCOPE_REASON = {
    "zai-api": ("no first-party npm scope located 2026-08-28 (probed @z-ai, @zai-org, @zhipuai, "
                "@zai — 0 in-scope packages each) AND the row's api-level claim asserts a "
                "PRESENCE, so a new Z.ai MCP client would EXTEND it rather than falsify it. "
                "Declare a scope here the day one appears."),
}

# Kinds whose claim can be falsified by the vendor shipping its own MCP client.
VENDOR_ARTIFACT_KINDS = ("byo-model", "api-level")

RECOMMENDED_WAVE = "LANDING-{VENDOR}-CLIENT-SURFACE-W{{NEXT}}"

ARM_OK = "ok"
ARM_STALE = "stale"
ARM_CONTRADICTED = "contradicted"
ARM_UNREACHABLE = "source unreachable"
ARM_INDETERMINATE = "predicate indeterminate"
# Strongest first. A definite finding beats an unknown; an unknown never silences a finding.
STATE_PRECEDENCE = (ARM_CONTRADICTED, ARM_STALE, ARM_INDETERMINATE, ARM_UNREACHABLE, ARM_OK)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

MCP_TOKEN_RE = re.compile(r"mcp", re.I)
MCP_CLIENT_RE = re.compile(r"\bclient\b|\bbridge\b|\bconnector\b", re.I)


class Indeterminate(Exception):
    """Raised where the run verified NOTHING it was supposed to verify. Never a silent skip."""


def log(msg):
    line = "[%s] %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    print(line, flush=True)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass  # the log is evidence, not the contract; the token is the contract


def today():
    frozen = os.environ.get("CLIENT_CLAIM_TODAY")
    return date.fromisoformat(frozen) if frozen else date.fromtimestamp(time.time())


# ── pure logic (fixture-drivable — this is what --self-test exercises) ────────────────────────

def parse_corpus_line(line):
    """`name|path|fields` -> dict. A malformed declaration is vacuity: WE wrote it."""
    parts = [p.strip() for p in line.split("|")]
    if len(parts) != 3 or not all(parts):
        raise Indeterminate("malformed CORPUS line %r — expected name|path|fields" % line)
    return {"name": parts[0], "path": parts[1], "fields": parts[2].split(",")}


def raw_url(path, buster):
    """The committed-SoT URL. The cache-buster is the freshness CONTROL — not the ref form.

    Asserted directly by --self-test: this is a seam the hermetic suite otherwise bypasses
    entirely, and a URL built wrong fails only in production.
    """
    return "%s/%s/%s/%s?cb=%s" % (RAW_HOST, RAW_REPO, RAW_REF, path.lstrip("/"), buster)


def rewrite_source(url):
    """(url, note). npmjs.com package pages 403 every headless fetch; the registry API does not.

    Returns the note so the substitution appears in the row's output line — a rewrite nobody
    sees is a rewrite that silently changes what was verified.
    """
    m = re.match(r"https?://(?:www\.)?npmjs\.com/package/(.+?)/?$", url)
    if m:
        return ("https://registry.npmjs.org/" + urllib.parse.quote(m.group(1), safe=""),
                "rewritten to registry.npmjs.org (npmjs.com/package 403s headless)")
    return url, ""


def parse_rows(text, module):
    """Regex over the row literals. The host has no checkout and no TypeScript toolchain.

    VACUITY GUARD sits here, where the corpus is CONSTRUCTED: a parser that silently matches
    zero rows is the failure this class of gate exists to prevent, and 'no claims found' would
    otherwise render as a clean PASS.
    """
    rows = []
    for m in re.finditer(r"slug:\s*'([^']+)'", text):
        chunk_start = m.end()
        nxt = text.find("slug:", chunk_start)
        chunk = text[chunk_start: nxt if nxt != -1 else len(text)]

        def field(k):
            hit = re.search(r"%s:\s*'([^']*)'" % k, chunk)
            return hit.group(1) if hit else None

        rows.append({"module": module, "slug": m.group(1), "kind": field("kind"),
                     "source": field("source"), "verifiedAt": field("verifiedAt"),
                     "text": chunk})
    if len(rows) < MIN_ROWS:
        raise Indeterminate(
            "parsed %d row(s) from %s, floor is %d — a parser matching almost nothing is a "
            "refactor event, not an empty claim set" % (len(rows), module, MIN_ROWS))
    return rows


def age_days(verified_at, ref_day):
    """None when the stamp is missing or unparseable — an unreadable date is not a fresh one."""
    if not verified_at:
        return None
    try:
        return (ref_day - date.fromisoformat(verified_at)).days
    except ValueError:
        return None


def age_arm(age, threshold=None):
    """(arm, evidence). A missing/unparseable stamp is INDETERMINATE, never implicitly fresh."""
    limit = AGE_THRESHOLD_DAYS if threshold is None else threshold
    if age is None:
        return ARM_INDETERMINATE, "verifiedAt missing or unparseable — age cannot be computed"
    if age > limit:
        return ARM_STALE, "age %dd exceeds the %dd threshold" % (age, limit)
    return ARM_OK, "age %dd within the %dd threshold" % (age, limit)


def scope_hits(packages, scope):
    """Names in `scope` that look like a first-party MCP CLIENT. `packages` is {name: desc}.

    Both halves are required: `mcp` alone matches an MCP *server* or a docs package, and
    `client` alone matches every SDK in the scope. The pair is what made this return exactly
    one hit across 241 in-scope @deepseek-ai packages with zero false positives.
    """
    prefix = scope + "/"
    out = []
    for name, desc in sorted(packages.items()):
        if not name.startswith(prefix):
            continue
        blob = "%s %s" % (name, desc or "")
        if MCP_TOKEN_RE.search(blob) and MCP_CLIENT_RE.search(blob):
            out.append(name)
    return out


def vendor_arm(row, scope_result):
    """(arm, evidence) for the vendor-artifact input. `scope_result` is
    (packages, exhausted) | None when the row declares no scope."""
    slug = row["slug"]
    if slug not in VENDOR_SCOPE:
        return (ARM_INDETERMINATE,
                "no VENDOR_SCOPE entry declared for %s — the vendor-artifact arm cannot run, and "
                "a skipped arm must never read as a healthy one" % slug)
    scope = VENDOR_SCOPE[slug]
    if scope is None:
        reason = VENDOR_SCOPE_REASON.get(slug)
        if not reason:
            return (ARM_INDETERMINATE,
                    "%s declares scope=None with NO reason — a not-applicable arm needs a stated "
                    "why, or it is indistinguishable from an oversight" % slug)
        return ARM_OK, "vendor-artifact arm N/A: %s" % reason
    packages, exhausted = scope_result
    if not exhausted:
        return (ARM_INDETERMINATE,
                "%s: could not prove scope exhaustion — never aggregate over a LIMIT-capped "
                "collection" % scope)
    hits = scope_hits(packages, scope)
    if hits:
        return (ARM_CONTRADICTED,
                "vendor ships a first-party MCP client: %s (%d in-scope packages scanned, "
                "exhausted)" % (", ".join(hits), len(packages)))
    return ARM_OK, "%s: %d in-scope packages, no first-party MCP client" % (scope, len(packages))


def source_arm(row, http, body):
    """(arm, evidence) for the row's own `source` URL."""
    if http != 200:
        return ARM_UNREACHABLE, "source http=%s" % http
    hits = len(MCP_TOKEN_RE.findall(body or ""))
    if hits == 0:
        return (ARM_CONTRADICTED,
                "source returned 200 but contains ZERO 'mcp' occurrences — the page no longer "
                "evidences the declared kind=%s" % row.get("kind"))
    return ARM_OK, "source evidences MCP (%d occurrences)" % hits


def combine(arms):
    """Row state = the strongest arm. Precedence is a DECLARED order, not max()/min() luck."""
    present = {a for a, _ in arms}
    for state in STATE_PRECEDENCE:
        if state in present:
            return state
    return ARM_OK


def classify_row(row, age, arms):
    """One row -> exactly one state, carrying every arm's own verdict for the output line."""
    return {"module": row["module"], "slug": row["slug"], "kind": row["kind"],
            "verifiedAt": row["verifiedAt"], "source": row["source"], "age_days": age,
            "arms": arms, "state": combine(arms)}


def render_row_line(v):
    """The POSITIVE per-row line. Every row evaluated appears here, healthy or not — a row
    silently skipped by a load error must never look identical to one that passed."""
    age = "n/a" if v["age_days"] is None else "%dd" % v["age_days"]
    arms = " ".join("%s=%s" % (name, arm) for name, (arm, _) in v["arms_by_name"].items()) \
        if v.get("arms_by_name") else ""
    return ("EVAL module=%s slug=%s kind=%s verifiedAt=%s age=%s state=%s %s"
            % (v["module"], v["slug"], v["kind"], v["verifiedAt"], age, v["state"], arms)).rstrip()


def render_evidence_lines(v):
    return ["    %s: %s" % (name, ev) for name, (_, ev) in (v.get("arms_by_name") or {}).items()]


def aggregate(verdicts, prev_count):
    """(token, reason). Never aggregates over a collection that moved under it."""
    if not verdicts:
        return "INDETERMINATE", "zero rows evaluated"
    if prev_count is not None and abs(len(verdicts) - prev_count) > ROW_COUNT_TOLERANCE:
        return ("INDETERMINATE",
                "row count moved %d -> %d, more than the tolerance of %d — a corpus that changed "
                "size by that much is a parser or refactor event, and an aggregate over it would "
                "be an aggregate over a truncated collection"
                % (prev_count, len(verdicts), ROW_COUNT_TOLERANCE))
    states = [v["state"] for v in verdicts]
    if ARM_CONTRADICTED in states:
        return "FAIL", "%d contradicted row(s)" % states.count(ARM_CONTRADICTED)
    if ARM_STALE in states:
        return "FAIL", "%d stale row(s)" % states.count(ARM_STALE)
    unknown = states.count(ARM_INDETERMINATE) + states.count(ARM_UNREACHABLE)
    if unknown:
        return ("INDETERMINATE",
                "%d of %d row(s) could not be verified — certifying a partially-unverified "
                "corpus as PASS is the fail-open the token law forbids" % (unknown, len(states)))
    return "PASS", "all %d row(s) fresh and confirming" % len(states)


def recommended_wave(slug):
    """Template form. A literal W<n> is forbidden: send_telegram.sh resolves {NEXT} at send
    time from status.md, and a hardcoded number ships a COMPLETED wave as the action."""
    return RECOMMENDED_WAVE.format(VENDOR=re.sub(r"[^A-Z0-9]+", "-", slug.upper()).strip("-"))


def build_body(findings):
    """Alert body. Entity ids carry their entity NOUN and are pluralised from the id COUNT; the
    count and the ids live on SEPARATE lines. A bare parenthesised number beside a count cost a
    real operator misread once (WEBHOOK_DELIVERY_DRIFT, 2026-08-01) and the rendered BODY is
    asserted in --self-test, not merely the action verdict."""
    noun = "claim" if len(findings) == 1 else "claims"
    lines = ["\U0001F6D1 %s" % ALERT_ID, ""]
    lines.append("%d vendor-capability %s no longer match their live source." % (len(findings), noun))
    lines.append("Affected row %s: %s"
                 % ("slug" if len(findings) == 1 else "slugs",
                    ", ".join(sorted(f["slug"] for f in findings))))
    lines.append("")
    for f in sorted(findings, key=lambda x: x["slug"]):
        age = "unknown" if f["age_days"] is None else "%dd" % f["age_days"]
        lines.append("  %s (%s) — declared kind=%s, verifiedAt=%s, age %s"
                     % (f["slug"], f["module"], f["kind"], f["verifiedAt"], age))
        lines.append("    state: %s" % f["state"])
        for name, (arm, ev) in (f.get("arms_by_name") or {}).items():
            if arm != ARM_OK:
                lines.append("    %s: %s" % (name, ev))
        lines.append("    source: %s" % f["source"])
    lines += ["",
              "The row is public copy: it renders on algovault.com/integrations and in the "
              "landing quickstart grid. A wrong capability claim is a Factuality violation, not "
              "a stale note.",
              "",
              "Action: dispatch %s via Cowork -> Claude Code"
              % recommended_wave(sorted(findings, key=lambda x: x["slug"])[0]["slug"]),
              "Source log: %s" % LOG]
    return "\n".join(lines)


def clear_reason(verdicts):
    return ("all %d declared vendor-capability claim(s) are fresh and confirmed against their "
            "live sources" % len(verdicts))


# ── effects ──────────────────────────────────────────────────────────────────────────────────

LAST_FIRE = {}
LAST_CLEAR = {}


def _selftest_mode():
    return os.environ.get("CLIENT_CLAIM_SELFTEST") == "1"


def fire(body):
    """Hand the body to the wrapper, which OWNS severity / cooldown / DRY_RUN / fail-open.
    This consumer re-implements none of those gates."""
    LAST_FIRE[ALERT_ID] = body
    if _selftest_mode():
        log("WOULD_FIRE: %s (self-test — wrapper skipped)" % ALERT_ID)
        return
    proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"],
                          input=body, capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))
    if os.environ.get("ALGOVAULT_TG_TEST_INERT") == "1":
        log("WOULD_FIRE: alert_id=%s severity=CRITICAL_PERSISTENT verdict=SUPPRESSED_TEST_INERT "
            "(no POST, no cooldown marker)" % ALERT_ID)
    elif os.environ.get("DRY_RUN_TG") == "1":
        log("WOULD_FIRE: alert_id=%s severity=CRITICAL_PERSISTENT verdict=DRY_RUN (no POST; 24h "
            "COOLDOWN MARKER WRITTEN — prefer ALGOVAULT_TG_TEST_INERT=1)" % ALERT_ID)


def clear(reason):
    """FIRING -> CLEAR. The wrapper decides whether the resolution is ANNOUNCED, from
    alert-registry.json's `announce_resolution` (unset/false = SILENT, which is this alert's
    setting: its resolution is a copy edit the operator already knows about).

    stdin is /dev/null on purpose — a wrapper left reading stdin hung a real cron run.
    """
    LAST_CLEAR[ALERT_ID] = reason
    if _selftest_mode():
        log("WOULD_CLEAR: %s (self-test — wrapper skipped)" % ALERT_ID)
        return
    with open(os.devnull, "rb") as devnull:
        proc = subprocess.run([WRAPPER, "--clear", ALERT_ID, reason],
                              stdin=devnull, capture_output=True, text=True, timeout=30)
    log("wrapper --clear exit=%d out=%s"
        % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def follows_redirect(code, location):
    """The shipped redirect predicate, extracted so --self-test asserts the BEHAVIOUR.

    It was first written inline and the self-test "proved" it by grepping this function's own
    prose for the string "308" — which the surrounding comment supplies, so deleting 308 from
    the tuple left the suite fully GREEN. That is an assertion reading its own documentation.
    A pure predicate is the only shape a fixture can actually drive.
    """
    return bool(location) and code in (301, 302, 303, 307, 308)


def fetch(url, timeout=30):
    """(http, body, note). Follows redirects EXPLICITLY — see the module docstring: urllib does
    not follow 308 and three of eleven sources answer 308."""
    url, note = rewrite_source(url)
    hops = 0
    for _ in range(8):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if hops:
                    note = (note + "; " if note else "") + "followed %d redirect(s)" % hops
                return r.status, r.read().decode("utf-8", "replace"), note
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location") if e.headers else None
            if follows_redirect(e.code, loc):
                url = urllib.parse.urljoin(url, loc)
                hops += 1
                continue
            return e.code, "", note or ("HTTPError %d" % e.code)
        except Exception as e:  # noqa: BLE001 — an unreachable source is REPORTED, never dropped
            return 0, "", note or ("%s: %s" % (type(e).__name__, e))
    return 0, "", note or "redirect loop"


def scope_packages(scope):
    """(packages, exhausted). Pages with `from=` until the scope's ranked block is exhausted.

    npm's search `size` caps at 250 and @deepseek-ai/* alone fills ~200 of one page, so a single
    unpaged request is a LIMIT-capped collection — aggregating over one is forbidden, and the
    honest answer when exhaustion cannot be proven is INDETERMINATE for that row.
    """
    out, frm, page = {}, 0, 250
    for _ in range(20):
        url = ("https://registry.npmjs.org/-/v1/search?text=%s&size=%d&from=%d"
               % (urllib.parse.quote(scope), page, frm))
        http, body, _note = fetch(url)
        if http != 200:
            return out, False
        try:
            objs = json.loads(body).get("objects", [])
        except ValueError:
            return out, False
        if not objs:
            return out, True
        in_scope = 0
        for o in objs:
            pkg = o.get("package") or {}
            name = pkg.get("name") or ""
            if name.startswith(scope + "/"):
                out[name] = pkg.get("description") or ""
                in_scope += 1
        frm += len(objs)
        # Relevance ranking clusters the scope's own packages first, so a page contributing none
        # means the scope's block is behind us.
        if len(objs) < page or in_scope == 0:
            return out, True
    return out, False


def read_state():
    try:
        return json.loads(Path(STATE).read_text())
    except (OSError, ValueError):
        return {}


def write_state(token, row_count):
    payload = {"verdict": token, "row_count": row_count,
               "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    try:
        Path(STATE).parent.mkdir(parents=True, exist_ok=True)
        Path(STATE).write_text(json.dumps(payload))
    except OSError as e:
        log("state file unwritable at %s: %s (verdict still reported)" % (STATE, e))


# ── orchestration ────────────────────────────────────────────────────────────────────────────

def evaluate(rows, ref_day, fetch_fn, scope_fn):
    """The whole shipped decision path, driven by injected effects so --self-test exercises IT
    rather than a re-implementation beside it."""
    verdicts = []
    for row in rows:
        arms = {}
        age = age_days(row["verifiedAt"], ref_day)
        arms["age"] = age_arm(age)

        if not row.get("source"):
            arms["source"] = (ARM_INDETERMINATE, "row declares no source URL")
        else:
            http, body, note = fetch_fn(row["source"])
            arm, ev = source_arm(row, http, body)
            arms["source"] = (arm, ev + ("; " + note if note else ""))

        if row.get("kind") in VENDOR_ARTIFACT_KINDS:
            scope = VENDOR_SCOPE.get(row["slug"], "__absent__")
            result = scope_fn(scope) if isinstance(scope, str) and scope != "__absent__" else None
            arms["vendor"] = vendor_arm(row, result)

        v = classify_row(row, age, list(arms.values()))
        v["arms_by_name"] = arms
        verdicts.append(v)
    return verdicts


def run(rows, ref_day, fetch_fn, scope_fn, prev_state):
    verdicts = evaluate(rows, ref_day, fetch_fn, scope_fn)
    for v in verdicts:
        log(render_row_line(v))
        for line in render_evidence_lines(v):
            log(line)
    counts = {s: sum(1 for v in verdicts if v["state"] == s) for s in STATE_PRECEDENCE}
    log("SUMMARY: %d claim(s) evaluated — %s"
        % (len(verdicts), ", ".join("%s=%d" % (s, n) for s, n in counts.items())))

    token, reason = aggregate(verdicts, (prev_state or {}).get("row_count"))
    log("AGGREGATE: %s — %s" % (token, reason))

    if token == "FAIL":
        findings = [v for v in verdicts if v["state"] in (ARM_CONTRADICTED, ARM_STALE)]
        fire(build_body(findings))
    elif token == "PASS" and (prev_state or {}).get("verdict") == "FAIL":
        clear(clear_reason(verdicts))
    return verdicts, token


def main():
    try:
        prev = read_state()
        buster = str(int(time.time()))
        rows = []
        for line in CORPUS:
            mod = parse_corpus_line(line)
            url = raw_url(mod["path"], buster)
            http, body, note = fetch(url)
            if http != 200:
                raise Indeterminate("SoT unreadable: %s -> http=%s %s" % (url, http, note))
            rows.extend(parse_rows(body, mod["name"]))
        log("START corpus=%d module(s) rows=%d threshold=%dd state=%s"
            % (len(CORPUS), len(rows), AGE_THRESHOLD_DAYS, STATE))
        verdicts, token = run(rows, today(), fetch, scope_packages, prev)
        write_state(token, len(verdicts))
        print("CLIENT_CLAIM_FRESHNESS_VERDICT=%s" % token)
        return _token_exit_map()[token]
    except Indeterminate as e:
        log("INDETERMINATE: %s" % e)
        print("CLIENT_CLAIM_FRESHNESS_VERDICT=INDETERMINATE")
        return _token_exit_map()["INDETERMINATE"]
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing either
        log("INDETERMINATE: %s: %s" % (type(e).__name__, e))
        print("CLIENT_CLAIM_FRESHNESS_VERDICT=INDETERMINATE")
        return _token_exit_map()["INDETERMINATE"]


def _token_exit_map():
    """The mapping main() deploys, in ONE place so the self-test asserts the shipped fact rather
    than a copy. Asserting tokens without their exit codes is how re-coding INDETERMINATE to 0
    once stayed fully green across an entire suite."""
    return {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3}


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

def self_test():
    """Hermetic scenarios — no network, no wrapper, no state file, temp log.

    A hermetic suite is structurally blind to exactly what its seam replaces, so the artifacts
    the seam bypasses are asserted DIRECTLY: the raw-SoT URL is built and checked, the
    npmjs->registry rewriter is driven with a real scoped package name, the redirect follower's
    status set is pinned, and the scope filter is run over a fixture page set including a
    truncated one. Assertions that would RAISE are wrapped — an assertion that aborts the suite
    is not an assertion, it is a crash that reads as "no output".
    """
    global LOG, STATE
    tmp = tempfile.mkdtemp(prefix="client-claim-selftest-")
    LOG = os.path.join(tmp, "selftest.log")
    STATE = os.path.join(tmp, "state.json")
    os.environ["CLIENT_CLAIM_SELFTEST"] = "1"
    os.environ["ALGOVAULT_TG_TEST_INERT"] = "1"

    failures, ran = [], []

    def check(name, fn):
        ran.append(name)
        try:
            ok = bool(fn())
        except Exception as e:  # noqa: BLE001 — a raising assertion must REPORT, never abort
            ok, name = False, "%s [raised %s: %s]" % (name, type(e).__name__, e)
        print("  [%s] %s" % ("PASS" if ok else "FAIL", name))
        if not ok:
            failures.append(name)

    DAY = date(2026, 8, 28)

    def row(slug="s1", kind="native", src_=None, verified="2026-08-05"):
        # The source URL carries the slug so a per-slug fetcher can target ONE row — a fixture
        # whose stub can never match is a scenario that silently tests nothing.
        return {"module": "m", "slug": slug, "kind": kind,
                "source": src_ or ("https://example.test/%s" % slug),
                "verifiedAt": verified, "text": ""}

    def corpus(n=11, **kw):
        return [row(slug="s%d" % i, **kw) for i in range(n)]

    def fetcher(status=200, body="mcp mcp mcp", per_slug=None):
        def f(url):
            if per_slug:
                for frag, resp in per_slug.items():
                    if frag in url:
                        return resp
            return status, body, ""
        return f

    def scoper(packages=None, exhausted=True):
        return lambda scope: (packages or {}, exhausted)

    def tok(rows_, ref=DAY, fetch_fn=None, scope_fn=None, prev=None):
        LAST_FIRE.clear(); LAST_CLEAR.clear()
        return run(rows_, ref, fetch_fn or fetcher(), scope_fn or scoper(), prev)[1]

    # ── bypassed seams: the artifacts a hermetic suite never otherwise touches ───────────────
    u = raw_url("src/lib/integrations-data/mcp-clients.ts", "123")
    check("raw SoT URL targets the committed ref with a CACHE-BUSTER (the freshness control)",
          lambda: u.startswith("https://raw.githubusercontent.com/AlgoVaultLabs/"
                               "crypto-quant-signal-mcp/refs/heads/main/")
          and u.endswith("src/lib/integrations-data/mcp-clients.ts?cb=123"))
    check("npmjs.com/package/<scoped pkg> is rewritten to the registry API",
          lambda: rewrite_source("https://www.npmjs.com/package/@smithery/cli")[0]
          == "https://registry.npmjs.org/%40smithery%2Fcli"
          and "403" in rewrite_source("https://www.npmjs.com/package/@smithery/cli")[1])
    check("a non-npmjs source is left untouched and carries no note",
          lambda: rewrite_source("https://cursor.com/docs/context/mcp")
          == ("https://cursor.com/docs/context/mcp", ""))
    check("the SHIPPED redirect predicate follows 308 (urllib's default handler does not)",
          lambda: follows_redirect(308, "https://x.test/y") is True
          and follows_redirect(307, "https://x.test/y") is True
          and follows_redirect(301, "https://x.test/y") is True)
    check("a redirect status with NO Location, and a non-redirect status, are not followed",
          lambda: follows_redirect(308, None) is False
          and follows_redirect(200, "https://x.test/y") is False
          and follows_redirect(403, "https://x.test/y") is False)
    check("CORPUS lines parse in declaration-sync.sh's name|path|fields idiom",
          lambda: parse_corpus_line(CORPUS[0])["path"]
          == "src/lib/integrations-data/mcp-clients.ts"
          and parse_corpus_line(CORPUS[0])["fields"] == ["kind", "source", "verifiedAt"])
    check("a malformed CORPUS line is vacuity, not a skip",
          lambda: _raises(Indeterminate, lambda: parse_corpus_line("only-two|parts")))
    check("the row parser reads a real TypeScript row literal",
          lambda: [r["slug"] for r in _parse_ok(_TS_FIXTURE)] [:2] == ["alpha", "bravo"]
          and _parse_ok(_TS_FIXTURE)[10]["kind"] == "byo-model")
    check("scope filter needs BOTH an mcp token and a client word",
          lambda: scope_hits({"@v/dsh-mcp-client": "MCP client bridge",
                              "@v/dsh-mcp-server": "an MCP server",
                              "@v/http-client": "a plain client",
                              "@other/mcp-client": "wrong scope"}, "@v")
          == ["@v/dsh-mcp-client"])

    # ── AGE arm ─────────────────────────────────────────────────────────────────────────────
    check("fresh stamp -> ok", lambda: age_arm(23)[0] == ARM_OK)
    check("stamp past the threshold -> stale", lambda: age_arm(151)[0] == ARM_STALE)
    check("exactly at the threshold is NOT stale (the comparison is strict)",
          lambda: age_arm(150)[0] == ARM_OK and age_arm(AGE_THRESHOLD_DAYS + 1)[0] == ARM_STALE)
    check("a missing verifiedAt is INDETERMINATE, never implicitly fresh",
          lambda: age_arm(None)[0] == ARM_INDETERMINATE
          and age_days("not-a-date", DAY) is None)
    check("age is computed from the stamp, not assumed",
          lambda: age_days("2026-04-30", DAY) == 120 and age_days("2026-08-05", DAY) == 23)

    # ── source arm ──────────────────────────────────────────────────────────────────────────
    check("200 evidencing MCP -> ok", lambda: source_arm(row(), 200, "mcp MCP")[0] == ARM_OK)
    check("200 with ZERO mcp mentions -> contradicted",
          lambda: source_arm(row(), 200, "nothing here")[0] == ARM_CONTRADICTED)
    check("non-200 -> source unreachable (reported, never dropped)",
          lambda: source_arm(row(), 404, "")[0] == ARM_UNREACHABLE
          and "404" in source_arm(row(), 404, "")[1])

    # ── vendor arm ──────────────────────────────────────────────────────────────────────────
    check("a first-party MCP client in the vendor scope -> contradicted",
          lambda: vendor_arm(row(slug="deepseek", kind="byo-model"),
                             ({"@deepseek-ai/dsh-mcp-client": "MCP client bridge"}, True))[0]
          == ARM_CONTRADICTED)
    check("…and the evidence NAMES the package",
          lambda: "@deepseek-ai/dsh-mcp-client" in vendor_arm(
              row(slug="deepseek", kind="byo-model"),
              ({"@deepseek-ai/dsh-mcp-client": "MCP client bridge"}, True))[1])
    check("a clean vendor scope -> ok",
          lambda: vendor_arm(row(slug="deepseek", kind="byo-model"),
                             ({"@deepseek-ai/dsh-fs": "filesystem"}, True))[0] == ARM_OK)
    check("unproven scope exhaustion -> predicate indeterminate (capped-collection law)",
          lambda: vendor_arm(row(slug="deepseek", kind="byo-model"), ({}, False))[0]
          == ARM_INDETERMINATE)
    check("a declared N/A scope WITH a reason -> ok, and the reason is rendered",
          lambda: vendor_arm(row(slug="zai-api", kind="api-level"), None)[0] == ARM_OK
          and "npm scope" in vendor_arm(row(slug="zai-api", kind="api-level"), None)[1])
    check("an UNDECLARED row -> predicate indeterminate, never a silent pass",
          lambda: vendor_arm(row(slug="brand-new", kind="byo-model"), None)[0]
          == ARM_INDETERMINATE)

    # ── precedence + aggregation ────────────────────────────────────────────────────────────
    check("a definite finding beats an unknown (unreachable never silences contradicted)",
          lambda: combine([(ARM_UNREACHABLE, ""), (ARM_CONTRADICTED, "")]) == ARM_CONTRADICTED
          and combine([(ARM_INDETERMINATE, ""), (ARM_STALE, "")]) == ARM_STALE)
    check("all-ok -> PASS", lambda: tok(corpus()) == "PASS")
    check("one stale row -> FAIL",
          lambda: tok(corpus(10) + [row(slug="old", verified="2026-01-01")]) == "FAIL")
    check("one contradicted row -> FAIL",
          lambda: tok(corpus(10) + [row(slug="gone")],
                      fetch_fn=fetcher(per_slug={"gone": (200, "no tokens here", "")})) == "FAIL")
    check("an unreachable source does NOT silently PASS the aggregate",
          lambda: tok(corpus(10) + [row(slug="dead")],
                      fetch_fn=fetcher(per_slug={"dead": (503, "", "")})) == "INDETERMINATE")
    check("mixed ok/indeterminate is INDETERMINATE, not PASS (the spec's undefined case)",
          lambda: aggregate([{"state": ARM_OK}] * 9 + [{"state": ARM_INDETERMINATE}], None)[0]
          == "INDETERMINATE")
    check("every row indeterminate -> INDETERMINATE",
          lambda: aggregate([{"state": ARM_INDETERMINATE}] * 11, None)[0] == "INDETERMINATE")
    check("a parse yielding 3 rows -> INDETERMINATE (vacuity guard at CONSTRUCTION)",
          lambda: _raises(Indeterminate, lambda: parse_rows(_TS_FIXTURE_SHORT, "m")))
    check("…and the guard's floor is the shipped MIN_ROWS, not a copy",
          lambda: MIN_ROWS == 8 and len(_parse_ok(_TS_FIXTURE)) >= MIN_ROWS)
    check("a collapsed row count -> INDETERMINATE even when every row is ok",
          lambda: aggregate([{"state": ARM_OK}] * 8, 11)[0] == "INDETERMINATE")
    check("a row count moving within tolerance is NOT indeterminate",
          lambda: aggregate([{"state": ARM_OK}] * 9, 11)[0] == "PASS")

    # ── rendered artifacts: body, per-row line, recommended wave ────────────────────────────
    LAST_FIRE.clear()
    tok(corpus(10) + [row(slug="deepseek", kind="byo-model", verified="2026-01-01")])
    body = LAST_FIRE.get(ALERT_ID, "")
    check("FAIL fires exactly one alert, with the drifting slug named",
          lambda: list(LAST_FIRE) == [ALERT_ID] and "deepseek" in body)
    check("the body keeps the COUNT and the IDS on separate lines (the '(new: 6)' misread class)",
          lambda: "1 vendor-capability claim" in body and "Affected row slug: deepseek" in body
          and "(1)" not in body)
    check("the body names the declared kind and the measured age, not just the slug",
          lambda: "declared kind=byo-model" in body and "age 239d" in body)
    check("the Action line is TEMPLATED W{NEXT}, never a literal wave number",
          lambda: "LANDING-DEEPSEEK-CLIENT-SURFACE-W{NEXT}" in body
          and not re.search(r"-W\d+\b", body))
    check("the recommended wave derives the VENDOR from the slug",
          lambda: recommended_wave("glm-zcode") == "LANDING-GLM-ZCODE-CLIENT-SURFACE-W{NEXT}")
    v0 = evaluate([row(slug="kimi", verified="2026-04-30")], DAY, fetcher(), scoper())[0]
    line = render_row_line(v0)
    check("the per-row line is POSITIVE — slug, kind, stamp, measured age and per-arm verdicts",
          lambda: "slug=kimi" in line and "kind=native" in line and "age=120d" in line
          and "age=ok" in line and "source=ok" in line and "state=ok" in line)
    check("a healthy row is rendered too (absence of an alert is not evidence)",
          lambda: "state=ok" in render_row_line(
              evaluate([row()], DAY, fetcher(), scoper())[0]))

    # ── recovery ────────────────────────────────────────────────────────────────────────────
    LAST_CLEAR.clear()
    tok(corpus(), prev={"verdict": "FAIL", "row_count": 11})
    check("FAIL -> PASS clears the alert exactly once",
          lambda: list(LAST_CLEAR) == [ALERT_ID] and "fresh" in LAST_CLEAR[ALERT_ID])
    LAST_CLEAR.clear()
    tok(corpus(), prev={"verdict": "PASS", "row_count": 11})
    check("PASS -> PASS clears NOTHING (recovery chatter stays silent)",
          lambda: not LAST_CLEAR)

    # ── token -> exit-code mapping ──────────────────────────────────────────────────────────
    check("INDETERMINATE maps to exit 3; PASS and FAIL to 0 (FAIL: the alert IS the action)",
          lambda: _token_exit_map() == {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3})
    src_text = Path(__file__).read_text()
    main_body = src_text.split("def main():")[1].split("\ndef ")[0]
    check("EVERY exit path of main() emits exactly one token — one print per return",
          lambda: main_body.count('print("CLIENT_CLAIM_FRESHNESS_VERDICT=')
          == main_body.count("        return ") == 3)
    check("the token is line-anchored — never embedded mid-line",
          lambda: all(not before.rstrip("\n").split("\n")[-1].strip().startswith(("log(", "#"))
                      for before in src_text.split('"CLIENT_CLAIM_FRESHNESS_VERDICT=')[:-1])
          and "CLIENT_CLAIM_FRESHNESS_VERDICT=" not in src_text.replace(
              '"CLIENT_CLAIM_FRESHNESS_VERDICT=', "").replace(
              "CLIENT_CLAIM_FRESHNESS_VERDICT=PASS|FAIL|INDETERMINATE", ""))
    check("ALERT_ID is a module-level literal (what makes it visible to check-alert-registry)",
          lambda: re.search(r'^ALERT_ID = "CLIENT_CLAIM_DRIFT"', src_text, re.M) is not None)

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: suite ran %d check(s), floor is %d — it verified less than it "
              "was built to" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    print("CLIENT_CLAIM_FRESHNESS_VERDICT=%s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def _raises(exc, fn):
    try:
        fn()
    except exc:
        return True
    except Exception:  # noqa: BLE001 — the WRONG exception is still a failure
        return False
    return False


def _parse_ok(text):
    return parse_rows(text, "m")


_TS_FIXTURE = "".join(
    """    {
      slug: '%s',
      kind: '%s',
      source: 'https://example.test/%s',
      verifiedAt: '2026-08-05',
    },
""" % (s, k, s)
    for s, k in [("alpha", "native"), ("bravo", "native"), ("charlie", "native"),
                 ("delta", "native"), ("echo", "native"), ("foxtrot", "native"),
                 ("golf", "native"), ("hotel", "native"), ("india", "native"),
                 ("juliet", "api-level"), ("kilo", "byo-model")])

_TS_FIXTURE_SHORT = "".join(
    "    {\n      slug: '%s',\n      kind: 'native',\n"
    "      source: 'https://example.test/%s',\n      verifiedAt: '2026-08-05',\n    },\n"
    % (s, s) for s in ("alpha", "bravo", "charlie"))

# Floor, not a target — set to the ACTUAL check count so removing any scenario trips it. Raise
# it when scenarios are added; it exists so a suite that stops running its scenarios cannot
# report a confident pass over nothing.
_SELF_TEST_MIN_CHECKS = 47


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="declared-claim vs live-source freshness canary")
    ap.add_argument("--self-test", action="store_true",
                    help="hermetic scenario suite; exit non-zero on failure")
    a = ap.parse_args()
    sys.exit(self_test() if a.self_test else main())
