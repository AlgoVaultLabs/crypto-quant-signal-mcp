#!/usr/bin/env python3
"""client-claim-freshness.py — v2: confirm every rendered claim against the live page that makes it true.

Built by OPS-CLIENT-CLAIM-FRESHNESS-W1 (v1, 2026-08-28); arms rebuilt by OPS-CLIENT-CLAIM-EVIDENCE-W1 CH2.

── What v1 measured, and why its arms are gone ──────────────────────────────────────────────
v1 aged a hand-typed `verifiedAt` (AGE arm) and counted the token `mcp` on each row's `source`
page (SOURCE arm). On the page this rewrite answers (2026-09-29) it:
  * paged five rows `stale` on age ALONE — claude-code, cline and cursor were fully true;
  * scored `ok` on claude-desktop and codex, whose own sources now CONTRADICT what we render;
  * headlined "no longer match their live source" when no arm had compared anything.
Precision 2/5, recall 2/4. Every measured drift in this class happened INSIDE the 150-day window
(DeepSeek 5 d after its stamp, Codex and Claude Desktop within 55 d), so an age arm cannot catch it
in time, and it pages rows that are still true. A token count cannot see a claim at all.

── What v2 measures ─────────────────────────────────────────────────────────────────────────
The corpus is src/lib/integrations-data/claim-evidence.json, GENERATED from mcp-clients.ts by
scripts/emit-claim-evidence.mjs (lockstep asserted in CI, tests/unit/claim-evidence.test.ts R5).
Every row carries evidence entries: {claim, source, expect[], reject[]?, npmScopeAbsence?}.

  EVIDENCE — per anchor. Each distinct URL is fetched ONCE per run. An anchor is `confirmed` iff
    every `expect` string is present and no `reject` string is present in the page's MATCH SPACE:
        whitespace-collapsed raw body
      ∪ whitespace-collapsed html.unescape(body with every tag replaced by a SPACE)
      ∪ (when the body parses as JSON) each whitespace-collapsed string leaf.
    Case-SENSITIVE — measured: the Claude support page carries "Organization settings > Connectors",
    so a case-insensitive match would CONFIRM the false "Settings > Connectors". Tags become
    SPACES — measured: "mcp_servers Ignored" exists only across a </td><td> boundary.
    A non-200 is `unreachable`. A final URL on a different host + path (ignoring a trailing `/`,
    the query and the fragment) is a `moved` NOTE — reported, never a finding on its own.
    Row evidence: any contradicted -> contradicted; else any unreachable -> unreachable; else
    confirmed. A row is confirmed only when EVERY one of its anchors confirms.

  VENDOR — re-keyed from the row's `kind` to the CLAIM. It runs only for an anchor that declares
    `npmScopeAbsence` (the claim asserts the vendor ships NO first-party MCP client in that npm
    scope), paging the scope to exhaustion. v1 keyed it on `kind` and so had to be switched off by
    hand for a correct row (`OPS-CLIENT-CLAIM-PREDICATE-CLAIMTEXT-W{NEXT}` — closed here). Zero rows
    declare it today: dormant BY DECLARATION, and it re-arms itself the day a row asserts an absence.

  AGE — from the last CONFIRMATION, not from the hand-typed date:
        age = today − max(verifiedAt, last machine confirmation whose evidence_sha matches)
    `verifiedAt` is the last HUMAN review. A row confirmed today is age 0 and can never be stale. A
    row whose sources go unreachable ages from its last confirmation and turns stale after the
    threshold — an unreachable source fails toward NOISE, never toward silence. Editing a row's
    evidence changes its evidence_sha, so a confirmation of the OLD anchors is never credited to
    the new ones.

── AGE THRESHOLD: 150 DAYS, AND WHY NOT THE SPEC'S 120 ──────────────────────────────────────
Derived by v1 from the measured stamp distribution on 2026-08-28 (n=11, max 120 d): 120 would have
fired on five rows at install and buried the first contradiction; 150 still bounds any vendor
claim to <= 5 months. Unchanged here. In v2 it bounds how long a row may go UNCONFIRMED, not how
old a human's date may be. Widen it only with a measurement, never to quiet the alert.

── Contract ─────────────────────────────────────────────────────────────────────────────────
Row state = the strongest of: evidence (contradicted | unreachable | indeterminate | confirmed)
and age (stale), in this precedence:
    contradicted > stale > (predicate indeterminate | source unreachable) > confirmed
Aggregation:
  any contradicted -> FAIL · else any stale -> FAIL · else any unknown -> INDETERMINATE · else PASS
  plus, at CONSTRUCTION (vacuity guards — WE build this corpus): an unreadable SoT, a document that
  is not JSON, schema_version != 1, a corpus name that is not the declared one, rows below that
  corpus's floor, a row with zero evidence or a malformed anchor -> INDETERMINATE; and a row count
  that moved by more than ROW_COUNT_TOLERANCE since the last run -> INDETERMINATE.
The row floor is PER CORPUS, declared on its CORPUS line. v1's single global MIN_ROWS = 8 would
have raised INDETERMINATE for the WHOLE run the day the 4-row ai-agents module joined, blinding the
12 mcp-clients rows with it.

Verdict token: exactly one terminal `CLIENT_CLAIM_FRESHNESS_VERDICT=PASS|FAIL|INDETERMINATE`.
Exit: 0 = evaluated (PASS, or FAIL with the alert dispatched) · 3 = INDETERMINATE (verified
NOTHING it could stand behind). Callers gate on the TOKEN — FAIL exits 0 because the alert IS the
action.

The page states only what was measured: "contradicted" appears only when an anchor was
contradicted; an age finding says "not confirmed … for more than 150 days", never "no longer
match". Unverifiable rows and moved sources are listed as housekeeping, never as findings.

── Fetch behaviours kept from v1 (corrections, not conveniences) ────────────────────────────
* Redirects are followed EXPLICITLY — urllib does not follow 308.
* `www.npmjs.com/package/<pkg>` is rewritten to `registry.npmjs.org/<pkg>` — the page 403s every
  headless fetch; the substitution is named in the output line.
* The committed SoT is read from refs/heads/main WITH A CACHE-BUSTER — both ref forms share one
  5-minute CDN TTL; the buster is the freshness control, the ref form is not.

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

Cron: 17 2 * * * (canonical off-:00 minute per ops/monitoring/schedule-boundary-rule.json). Daily,
never hourly: vendor docs move on a scale of weeks, and an hourly probe of a dozen third-party doc
sites is rude and rate-limit bait.
"""
import argparse
import hashlib
import html
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
from datetime import date
from pathlib import Path

ALERT_ID = "CLIENT_CLAIM_DRIFT"
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
LOG = os.environ.get("CLIENT_CLAIM_LOG", "/var/log/algovault-client-claim-freshness.log")
STATE = os.environ.get("CLIENT_CLAIM_STATE",
                       "/var/lib/algovault-monitoring/client-claim-freshness-state.json")

# See the AGE THRESHOLD paragraph in the module docstring.
AGE_THRESHOLD_DAYS = max(1, int(os.environ.get("CLIENT_CLAIM_AGE_DAYS", "150")))

# A corpus that moves by more than this between runs is a parser or refactor event, not a content
# change, and an aggregate over it would be an aggregate over a truncated collection.
ROW_COUNT_TOLERANCE = 2

RAW_HOST = "https://raw.githubusercontent.com"
RAW_REPO = "AlgoVaultLabs/crypto-quant-signal-mcp"
# refs/heads/main AND /main/ share ONE 5-minute CDN TTL — the ref FORM is not a freshness control
# and never was. The control is the cache-buster in raw_url().
RAW_REF = "refs/heads/main"

CORPUS_SCHEMA_VERSION = 1
STATE_SCHEMA = 2

# The declared corpus: name|path|required row fields|row floor. The floor is PER CORPUS (see the
# Contract paragraph). Extending the canary to another evidenced module is ONE line — and the module
# leaves UNCOVERED_CLAIM_MODULES in src/lib/integrations-data/claim-evidence.ts in the same change.
CORPUS = [
    "mcp-clients|src/lib/integrations-data/claim-evidence.json|slug,kind,verifiedAt,evidence|8",
]

# Ships VERBATIM: send_telegram.sh's resolve_template() substitutes OPS-<CLASS>-W{NEXT} only, so
# the operator sees the placeholder — which is honest, and never a completed wave's number.
RECOMMENDED_WAVE = "LANDING-{CORPUS}-CLAIMS-W{{NEXT}}"

# Row states. Strongest first: a definite finding beats an unknown; an unknown never silences one.
ST_CONTRADICTED = "contradicted"
ST_STALE = "stale"
ST_INDETERMINATE = "predicate indeterminate"
ST_UNREACHABLE = "source unreachable"
ST_CONFIRMED = "confirmed"
STATE_PRECEDENCE = (ST_CONTRADICTED, ST_STALE, ST_INDETERMINATE, ST_UNREACHABLE, ST_CONFIRMED)

# Anchor verdicts.
AN_CONFIRMED = "confirmed"
AN_CONTRADICTED = "contradicted"
AN_UNREACHABLE = "unreachable"
AN_INDETERMINATE = "indeterminate"
ANCHOR_PRECEDENCE = (AN_CONTRADICTED, AN_INDETERMINATE, AN_UNREACHABLE, AN_CONFIRMED)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# The vendor arm's first-party-client detector (both halves required — see scope_hits()).
MCP_TOKEN_RE = re.compile(r"mcp", re.I)
MCP_CLIENT_RE = re.compile(r"\bclient\b|\bbridge\b|\bconnector\b", re.I)

_WS_RE = re.compile(r"\s+")
_TAG_RE = re.compile(r"<[^>]+>")


class Indeterminate(Exception):
    """Raised where the run verified NOTHING it was supposed to verify. Never a silent skip."""


def _fd_is_file(fd, path):
    """True when file descriptor `fd` IS `path` (same device + inode)."""
    try:
        a, b = os.fstat(fd), os.stat(path)
        return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)
    except (OSError, ValueError):
        return False


def log(msg):
    """Print, and append to LOG — unless stdout already IS the log.

    The cron line appends stdout to the same file, and v1 appended from here as well, so every v1
    log line exists TWICE (measured on signal-1: two copies of every EVAL and AGGREGATE line, one
    of the token). Detected by inode rather than by an env flag, so a manual run still logs.
    """
    line = "[%s] %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    print(line, flush=True)
    try:
        stdout_fd = sys.stdout.fileno()
    except (AttributeError, OSError, ValueError):
        stdout_fd = -1
    if stdout_fd >= 0 and _fd_is_file(stdout_fd, LOG):
        return
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
    """`name|path|fields|floor` -> dict. A malformed declaration is vacuity: WE wrote it."""
    parts = [p.strip() for p in line.split("|")]
    if len(parts) != 4 or not all(parts):
        raise Indeterminate("malformed CORPUS line %r — expected name|path|fields|floor" % line)
    try:
        floor = int(parts[3])
    except ValueError:
        raise Indeterminate("CORPUS line %r: floor %r is not an integer" % (line, parts[3]))
    if floor < 1:
        raise Indeterminate("CORPUS line %r: floor must be >= 1" % line)
    return {"name": parts[0], "path": parts[1], "fields": parts[2].split(","), "min_rows": floor}


def raw_url(path, buster):
    """The committed-SoT URL. The cache-buster is the freshness CONTROL — not the ref form."""
    return "%s/%s/%s/%s?cb=%s" % (RAW_HOST, RAW_REPO, RAW_REF, path.lstrip("/"), buster)


def rewrite_source(url):
    """(url, note). npmjs.com package pages 403 every headless fetch; the registry API does not."""
    m = re.match(r"https?://(?:www\.)?npmjs\.com/package/(.+?)/?$", url)
    if m:
        return ("https://registry.npmjs.org/" + urllib.parse.quote(m.group(1), safe=""),
                "rewritten to registry.npmjs.org (npmjs.com/package 403s headless)")
    return url, ""


def parse_corpus(text, mod):
    """The generated JSON corpus -> rows. VACUITY GUARDS sit here, where the corpus is CONSTRUCTED."""
    try:
        doc = json.loads(text)
    except ValueError as e:
        raise Indeterminate("%s is not JSON (%s)" % (mod["path"], e))
    if not isinstance(doc, dict) or doc.get("schema_version") != CORPUS_SCHEMA_VERSION:
        raise Indeterminate("%s: schema_version %r, expected %d"
                            % (mod["path"], doc.get("schema_version") if isinstance(doc, dict) else None,
                               CORPUS_SCHEMA_VERSION))
    if doc.get("corpus") != mod["name"]:
        raise Indeterminate("%s declares corpus %r, the CORPUS line says %r"
                            % (mod["path"], doc.get("corpus"), mod["name"]))
    rows_in = doc.get("rows")
    if not isinstance(rows_in, list):
        raise Indeterminate("%s carries no rows array" % mod["path"])
    if len(rows_in) < mod["min_rows"]:
        raise Indeterminate("%s: %d row(s), floor is %d — a corpus that shrank below its floor is a "
                            "generator or refactor event, not an empty claim set"
                            % (mod["name"], len(rows_in), mod["min_rows"]))
    rows = []
    for r in rows_in:
        if not isinstance(r, dict):
            raise Indeterminate("%s: a row is not an object" % mod["name"])
        missing = [f for f in mod["fields"] if f not in r]
        if missing:
            raise Indeterminate("%s row %r lacks %s" % (mod["name"], r.get("slug"), ", ".join(missing)))
        ev = r.get("evidence")
        if not isinstance(ev, list) or not ev:
            raise Indeterminate("%s row %r carries ZERO evidence — nothing to confirm is not a "
                                "confirmation" % (mod["name"], r.get("slug")))
        for a in ev:
            if (not isinstance(a, dict) or not isinstance(a.get("source"), str) or not a["source"]
                    or not isinstance(a.get("expect"), list) or not a["expect"]
                    or not all(isinstance(t, str) and t for t in a["expect"])
                    or not all(isinstance(t, str) and t for t in (a.get("reject") or []))):
                raise Indeterminate("%s row %r carries a malformed anchor" % (mod["name"], r.get("slug")))
        rows.append({"module": mod["name"], "slug": r["slug"], "kind": r.get("kind"),
                     "verifiedAt": r.get("verifiedAt"), "source": r.get("source"),
                     "evidence": ev})
    return rows


def collapse(s):
    return _WS_RE.sub(" ", s).strip()


def _json_strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _json_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _json_strings(v)


def match_space(body):
    """Every rendering of the page an anchor may match in (see the module docstring)."""
    spaces = [collapse(body), collapse(html.unescape(_TAG_RE.sub(" ", body)))]
    try:
        doc = json.loads(body)
    except ValueError:
        doc = None
    if doc is not None:
        spaces.extend(collapse(s) for s in _json_strings(doc))
    return spaces


def present(token, spaces):
    """Case-SENSITIVE substring membership in any rendering. See the module docstring for why."""
    return any(token in s for s in spaces)


def _url_key(u):
    p = urllib.parse.urlsplit(u)
    return (p.hostname or "").lower(), urllib.parse.unquote(p.path).rstrip("/")


def moved_to(declared, final):
    """The final URL when the page now lives at a different host + path, else None."""
    if not final:
        return None
    requested = rewrite_source(declared)[0]
    return final if _url_key(requested) != _url_key(final) else None


def scope_hits(packages, scope):
    """Names in `scope` that look like a first-party MCP CLIENT. `packages` is {name: desc}.

    Both halves are required: `mcp` alone matches an MCP *server* or a docs package, and `client`
    alone matches every SDK in the scope.
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


def evidence_sha(evidence):
    """sha256 of the row's canonical evidence JSON — what a confirmation is a confirmation OF."""
    canon = json.dumps(evidence, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def strongest(values, precedence):
    present_ = set(values)
    for v in precedence:
        if v in present_:
            return v
    return precedence[-1]


def evaluate_anchor(anchor, page, scope_fn):
    """One anchor -> {verdict, …}. `page` = {http, spaces, note, final} for anchor["source"]."""
    out = {"claim": anchor.get("claim", ""), "source": anchor["source"], "note": page.get("note", ""),
           "moved": moved_to(anchor["source"], page.get("final")) if page["http"] == 200 else None}
    parts = []
    if page["http"] != 200:
        parts.append(AN_UNREACHABLE)
        out["why"] = "source http=%s%s" % (page["http"], "; " + page["note"] if page.get("note") else "")
    else:
        missing = next((t for t in anchor["expect"] if not present(t, page["spaces"])), None)
        rejected = next((t for t in (anchor.get("reject") or []) if present(t, page["spaces"])), None)
        if missing is not None:
            parts.append(AN_CONTRADICTED)
            out["missing"] = missing
        elif rejected is not None:
            parts.append(AN_CONTRADICTED)
            out["rejected"] = rejected
        else:
            parts.append(AN_CONFIRMED)
    scope = anchor.get("npmScopeAbsence")
    if scope:
        packages, exhausted = scope_fn(scope)
        if not exhausted:
            parts.append(AN_INDETERMINATE)
            out["why"] = ("%s: could not prove scope exhaustion — never aggregate over a "
                          "LIMIT-capped collection" % scope)
        else:
            hits = scope_hits(packages, scope)
            if hits:
                parts.append(AN_CONTRADICTED)
                out["vendor"] = hits
            else:
                parts.append(AN_CONFIRMED)
    out["verdict"] = strongest(parts, ANCHOR_PRECEDENCE)
    return out


def age_days(verified_at, confirmed_on, ref_day):
    """Days since max(verifiedAt, confirmation). None when neither date is usable."""
    points = []
    if verified_at:
        try:
            points.append(date.fromisoformat(verified_at))
        except ValueError:
            pass
    if confirmed_on is not None:
        points.append(confirmed_on)
    return (ref_day - max(points)).days if points else None


def evaluate_row(row, pages, ref_day, prior, scope_fn, threshold=None):
    """One row -> (verdict dict, confirmation record to persist or None)."""
    limit = AGE_THRESHOLD_DAYS if threshold is None else threshold
    anchors = [evaluate_anchor(a, pages[a["source"]], scope_fn) for a in row["evidence"]]
    ev_state = {AN_CONTRADICTED: ST_CONTRADICTED, AN_INDETERMINATE: ST_INDETERMINATE,
                AN_UNREACHABLE: ST_UNREACHABLE, AN_CONFIRMED: ST_CONFIRMED}[
        strongest([a["verdict"] for a in anchors], ANCHOR_PRECEDENCE)]
    sha = evidence_sha(row["evidence"])
    prior_ok = (isinstance(prior, dict) and prior.get("evidence_sha") == sha
                and isinstance(prior.get("date"), str))
    confirmed_on = None
    if ev_state == ST_CONFIRMED:
        confirmed_on = ref_day
        record = {"date": ref_day.isoformat(), "evidence_sha": sha}
    else:
        record = prior if isinstance(prior, dict) else None
        if prior_ok:
            try:
                confirmed_on = date.fromisoformat(prior["date"])
            except ValueError:
                confirmed_on = None
    age = age_days(row.get("verifiedAt"), confirmed_on, ref_day)
    if ev_state == ST_CONTRADICTED:
        state = ST_CONTRADICTED
    elif age is not None and age > limit:
        state = ST_STALE
    elif age is None:
        state = ST_INDETERMINATE
    else:
        state = ev_state
    v = {"module": row["module"], "slug": row["slug"], "kind": row.get("kind"),
         "verifiedAt": row.get("verifiedAt"), "source": row.get("source"), "age_days": age,
         "confirmed": confirmed_on.isoformat() if confirmed_on else None,
         "evidence_state": ev_state, "anchors": anchors, "state": state}
    return v, record


def aggregate(verdicts, prev_count):
    """(token, reason). Never aggregates over a collection that moved under it."""
    if not verdicts:
        return "INDETERMINATE", "zero rows evaluated"
    if prev_count is not None and abs(len(verdicts) - prev_count) > ROW_COUNT_TOLERANCE:
        return ("INDETERMINATE",
                "row count moved %d -> %d, more than the tolerance of %d — a corpus that changed "
                "size by that much is a generator or refactor event, and an aggregate over it would "
                "be an aggregate over a truncated collection"
                % (prev_count, len(verdicts), ROW_COUNT_TOLERANCE))
    states = [v["state"] for v in verdicts]
    if ST_CONTRADICTED in states:
        return "FAIL", "%d contradicted row(s)" % states.count(ST_CONTRADICTED)
    if ST_STALE in states:
        return "FAIL", "%d stale row(s)" % states.count(ST_STALE)
    unknown = states.count(ST_INDETERMINATE) + states.count(ST_UNREACHABLE)
    if unknown:
        return ("INDETERMINATE",
                "%d of %d row(s) could not be verified — certifying a partially-unverified corpus "
                "as PASS is the fail-open the token law forbids" % (unknown, len(states)))
    return "PASS", "all %d row(s) confirmed against their live sources" % len(states)


def recommended_wave(corpus):
    """Template form. A literal W<n> is forbidden — it would ship a COMPLETED wave as the action."""
    return RECOMMENDED_WAVE.format(CORPUS=re.sub(r"[^A-Z0-9]+", "-", corpus.upper()).strip("-"))


def _plural(n, one, many):
    return one if n == 1 else many


def _anchor_lines(a):
    lines = ['    claim: "%s"' % a["claim"]]
    if a.get("missing") is not None:
        lines.append('    missing on source: "%s"' % a["missing"])
    if a.get("rejected") is not None:
        lines.append('    present on source (contradicts the claim): "%s"' % a["rejected"])
    if a.get("vendor"):
        lines.append("    vendor ships a first-party MCP client: %s" % ", ".join(a["vendor"]))
    if a.get("why"):
        lines.append("    unverifiable today: %s" % a["why"])
    lines.append("    source: %s%s" % (a["source"], " (moved → %s)" % a["moved"] if a.get("moved") else ""))
    return lines


def build_body(verdicts):
    """Alert body. States ONLY what the arms measured. Counts and ids live on SEPARATE lines, ids
    carry their entity noun (the '(new: 6)' misread class), and the rendered body is asserted in
    --self-test, not merely the verdict."""
    contra = sorted((v for v in verdicts if v["state"] == ST_CONTRADICTED), key=lambda v: v["slug"])
    stale = sorted((v for v in verdicts if v["state"] == ST_STALE), key=lambda v: v["slug"])
    findings = sorted(contra + stale, key=lambda v: v["slug"])
    n_contra = sum(1 for v in contra for a in v["anchors"] if a["verdict"] == AN_CONTRADICTED)
    n_stale = sum(1 for v in stale for a in v["anchors"] if a["verdict"] != AN_CONFIRMED)
    lines = ["\U0001F6D1 %s" % ALERT_ID, ""]
    if contra:
        lines.append("%d public integration %s contradicted by %s live source."
                     % (n_contra, _plural(n_contra, "claim", "claims"), _plural(n_contra, "its", "their")))
    if stale:
        lines.append("%d public integration %s not confirmed against %s live source for more than "
                     "%d days." % (n_stale, _plural(n_stale, "claim", "claims"),
                                   _plural(n_stale, "its", "their"), AGE_THRESHOLD_DAYS))
    lines.append("Affected row %s: %s" % (_plural(len(findings), "slug", "slugs"),
                                          ", ".join(v["slug"] for v in findings)))
    lines.append("")
    for v in findings:
        lines.append("  %s (%s) — kind=%s, human-verified %s, last machine confirmation %s"
                     % (v["slug"], v["module"], v["kind"], v["verifiedAt"], v["confirmed"] or "never"))
        lines.append("    state: %s" % v["state"])
        for a in v["anchors"]:
            if a["verdict"] == AN_CONFIRMED:
                continue
            if v["state"] == ST_CONTRADICTED and a["verdict"] != AN_CONTRADICTED:
                continue
            lines.extend(_anchor_lines(a))
    unverifiable = sorted((v for v in verdicts if v["state"] in (ST_UNREACHABLE, ST_INDETERMINATE)),
                          key=lambda v: v["slug"])
    if unverifiable:
        lines.append("")
        for v in unverifiable:
            why = next((a["why"] for a in v["anchors"] if a.get("why")), v["state"])
            lines.append("Also unverifiable today (not a finding): %s — %s" % (v["slug"], why))
    moved = sorted({(v["slug"], a["moved"]) for v in verdicts for a in v["anchors"]
                    if a.get("moved") and a["verdict"] == AN_CONFIRMED})
    if moved:
        lines.append("")
        for slug, final in moved:
            lines.append("Evidence source moved (claim still evidenced — update the URL): %s → %s"
                         % (slug, final))
    lines += ["",
              "These rows are public copy: they render on algovault.com/docs, /mcp, /integrations "
              "and the landing quickstart grid.",
              "",
              "Action: dispatch %s via Cowork -> Claude Code" % recommended_wave(findings[0]["module"]
                                                                            if findings else "unknown"),
              "Source log: %s" % LOG]
    return "\n".join(lines)


def clear_reason(verdicts):
    n = sum(len(v["anchors"]) for v in verdicts)
    return ("all %d declared public integration claim(s) across %d row(s) are confirmed against "
            "their live sources" % (n, len(verdicts)))


def render_row_line(v):
    """The POSITIVE per-row line — every row evaluated appears, healthy or not."""
    age = "n/a" if v["age_days"] is None else "%dd" % v["age_days"]
    ok = sum(1 for a in v["anchors"] if a["verdict"] == AN_CONFIRMED)
    per = " ".join("a%d=%s" % (i + 1, a["verdict"]) for i, a in enumerate(v["anchors"]))
    return ("EVAL module=%s slug=%s kind=%s verifiedAt=%s confirmed=%s age=%s state=%s evidence=%s "
            "anchors=%d/%d %s" % (v["module"], v["slug"], v["kind"], v["verifiedAt"],
                                  v["confirmed"] or "never", age, v["state"], v["evidence_state"],
                                  ok, len(v["anchors"]), per)).rstrip()


def render_evidence_lines(v):
    out = []
    for i, a in enumerate(v["anchors"]):
        if a["verdict"] == AN_CONFIRMED:
            detail = "every expect string present, no reject present"
        elif a.get("missing") is not None:
            detail = 'missing on source: "%s"' % a["missing"]
        elif a.get("rejected") is not None:
            detail = 'present on source (contradicts the claim): "%s"' % a["rejected"]
        elif a.get("vendor"):
            detail = "vendor ships a first-party MCP client: %s" % ", ".join(a["vendor"])
        else:
            detail = a.get("why") or a["verdict"]
        extra = "".join(["; moved → %s" % a["moved"] if a.get("moved") else "",
                         "; %s" % a["note"] if a.get("note") else ""])
        out.append('    a%d %s: "%s" — %s (%s%s)' % (i + 1, a["verdict"], a["claim"], detail,
                                                    a["source"], extra))
    return out


# ── effects ──────────────────────────────────────────────────────────────────────────────────

LAST_FIRE = {}
LAST_CLEAR = {}


def _selftest_mode():
    return os.environ.get("CLIENT_CLAIM_SELFTEST") == "1"


def fire(body):
    """Hand the body to the wrapper, which OWNS severity / cooldown / DRY_RUN / fail-open."""
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
    """The shipped redirect predicate, extracted so --self-test asserts the BEHAVIOUR (an assertion
    that grepped this function's prose for "308" once stayed green with 308 deleted)."""
    return bool(location) and code in (301, 302, 303, 307, 308)


def fetch(url, timeout=30):
    """(http, body, note, final_url). Follows redirects EXPLICITLY — urllib does not follow 308.
    The final URL is what `moved` is measured from."""
    url, note = rewrite_source(url)
    hops = 0
    for _ in range(8):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if hops:
                    note = (note + "; " if note else "") + "followed %d redirect(s)" % hops
                return r.status, r.read().decode("utf-8", "replace"), note, (r.geturl() or url)
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location") if e.headers else None
            if follows_redirect(e.code, loc):
                url = urllib.parse.urljoin(url, loc)
                hops += 1
                continue
            return e.code, "", note or ("HTTPError %d" % e.code), url
        except Exception as e:  # noqa: BLE001 — an unreachable source is REPORTED, never dropped
            return 0, "", note or ("%s: %s" % (type(e).__name__, e)), url
    return 0, "", note or "redirect loop", url


def scope_packages(scope):
    """(packages, exhausted). Pages with `from=` until the scope's ranked block is exhausted —
    npm search caps `size` at 250, so a single unpaged request is a LIMIT-capped collection."""
    out, frm, page = {}, 0, 250
    for _ in range(20):
        url = ("https://registry.npmjs.org/-/v1/search?text=%s&size=%d&from=%d"
               % (urllib.parse.quote(scope), page, frm))
        http, body, _note, _final = fetch(url)
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
        if len(objs) < page or in_scope == 0:
            return out, True
    return out, False


def read_state():
    try:
        return json.loads(Path(STATE).read_text())
    except (OSError, ValueError):
        return {}


def prior_confirmations(prev_state):
    """A v1 state (no `confirmations`) or a malformed one reads as NO confirmations — never as a
    confirmation of anything."""
    c = (prev_state or {}).get("confirmations")
    return c if isinstance(c, dict) else {}


def write_state(token, row_count, confirmations):
    payload = {"schema": STATE_SCHEMA, "verdict": token, "row_count": row_count,
               "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "confirmations": confirmations}
    try:
        Path(STATE).parent.mkdir(parents=True, exist_ok=True)
        Path(STATE).write_text(json.dumps(payload, sort_keys=True))
    except OSError as e:
        log("state file unwritable at %s: %s (verdict still reported)" % (STATE, e))


# ── orchestration ────────────────────────────────────────────────────────────────────────────

def evaluate(rows, ref_day, fetch_fn, scope_fn, prior):
    """The whole shipped decision path, driven by injected effects so --self-test exercises IT.
    Returns (verdicts, confirmations to persist)."""
    pages = {}
    for row in rows:
        for a in row["evidence"]:
            if a["source"] not in pages:
                http, body, note, final = fetch_fn(a["source"])
                pages[a["source"]] = {"http": http, "note": note, "final": final,
                                      "spaces": match_space(body) if http == 200 else []}
    verdicts, confirmations = [], {}
    for row in rows:
        key = "%s/%s" % (row["module"], row["slug"])
        v, record = evaluate_row(row, pages, ref_day, prior.get(key), scope_fn)
        verdicts.append(v)
        if record is not None:
            confirmations[key] = record
    return verdicts, confirmations


def run(rows, ref_day, fetch_fn, scope_fn, prev_state):
    verdicts, confirmations = evaluate(rows, ref_day, fetch_fn, scope_fn,
                                       prior_confirmations(prev_state))
    for v in verdicts:
        log(render_row_line(v))
        for line in render_evidence_lines(v):
            log(line)
    counts = {s: sum(1 for v in verdicts if v["state"] == s) for s in STATE_PRECEDENCE}
    an = [a["verdict"] for v in verdicts for a in v["anchors"]]
    log("SUMMARY: %d row(s), %d anchor(s) evaluated — rows: %s — anchors: %s — moved=%d"
        % (len(verdicts), len(an), ", ".join("%s=%d" % (s, n) for s, n in counts.items()),
           ", ".join("%s=%d" % (s, an.count(s)) for s in ANCHOR_PRECEDENCE),
           sum(1 for v in verdicts for a in v["anchors"] if a.get("moved"))))

    token, reason = aggregate(verdicts, (prev_state or {}).get("row_count"))
    log("AGGREGATE: %s — %s" % (token, reason))

    if token == "FAIL":
        fire(build_body(verdicts))
    elif token == "PASS" and (prev_state or {}).get("verdict") == "FAIL":
        clear(clear_reason(verdicts))
    return verdicts, token, confirmations


def main():
    try:
        prev = read_state()
        buster = str(int(time.time()))
        rows = []
        for line in CORPUS:
            mod = parse_corpus_line(line)
            url = raw_url(mod["path"], buster)
            http, body, note, _final = fetch(url)
            if http != 200:
                raise Indeterminate("SoT unreadable: %s -> http=%s %s" % (url, http, note))
            rows.extend(parse_corpus(body, mod))
        log("START corpus=%d module(s) rows=%d anchors=%d threshold=%dd state=%s"
            % (len(CORPUS), len(rows), sum(len(r["evidence"]) for r in rows), AGE_THRESHOLD_DAYS, STATE))
        verdicts, token, confirmations = run(rows, today(), fetch, scope_packages, prev)
        write_state(token, len(verdicts), confirmations)
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
    """The mapping main() deploys, in ONE place so the self-test asserts the shipped fact."""
    return {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3}


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

def self_test():
    """Hermetic scenarios — no network, no wrapper, no state file, temp log.

    A hermetic suite is structurally blind to exactly what its seam replaces, so the artifacts the
    seam bypasses are asserted DIRECTLY: the raw-SoT URL, the npmjs rewrite, the redirect predicate,
    the corpus parser over real JSON text, the match space over real HTML/JSON fragments. Assertions
    that would RAISE are wrapped — an assertion that aborts the suite is a crash, not an assertion.
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

    DAY = date(2026, 9, 29)
    MOD = {"name": "mcp-clients", "path": "src/lib/integrations-data/claim-evidence.json",
           "fields": ["slug", "kind", "verifiedAt", "evidence"], "min_rows": 8}

    def anchor(src="https://v.example/docs", expect=("fixture add",), reject=(), claim="fixture add",
               scope=None):
        a = {"claim": claim, "source": src, "expect": list(expect)}
        if reject:
            a["reject"] = list(reject)
        if scope:
            a["npmScopeAbsence"] = scope
        return a

    def row(slug="s1", verified="2026-08-05", evidence=None, kind="native"):
        return {"module": "mcp-clients", "slug": slug, "kind": kind, "verifiedAt": verified,
                "source": "https://v.example/%s" % slug,
                "evidence": evidence or [anchor(src="https://v.example/%s" % slug)]}

    def corpus(n=12, **kw):
        return [row(slug="s%d" % i, **kw) for i in range(n)]

    def fetcher(default=(200, "<p>fixture add</p>"), per_url=None):
        def f(url):
            for frag, resp in (per_url or {}).items():
                if frag in url:
                    status, body = resp[0], resp[1]
                    final = resp[2] if len(resp) > 2 else url
                    return status, body, "", final
            return default[0], default[1], "", url
        return f

    def scoper(packages=None, exhausted=True, calls=None):
        def s(scope):
            if calls is not None:
                calls.append(scope)
            return packages or {}, exhausted
        return s

    def page(body, http=200, final=None):
        return {"http": http, "note": "", "final": final, "spaces": match_space(body) if http == 200 else []}

    def tok(rows_, fetch_fn=None, scope_fn=None, prev=None, ref=DAY):
        LAST_FIRE.clear(); LAST_CLEAR.clear()
        return run(rows_, ref, fetch_fn or fetcher(), scope_fn or scoper(), prev)

    def doc(rows_n=12, **over):
        d = {"_generated_by": "x", "schema_version": 1, "corpus": "mcp-clients",
             "rows": [{"slug": "r%d" % i, "kind": "native", "verifiedAt": "2026-08-05",
                       "source": "https://v.example/r%d" % i,
                       "evidence": [anchor(src="https://v.example/r%d" % i)]} for i in range(rows_n)]}
        d.update(over)
        return json.dumps(d)

    # ── bypassed seams ──────────────────────────────────────────────────────────────────────
    u = raw_url("src/lib/integrations-data/claim-evidence.json", "123")
    check("raw SoT URL targets the committed ref with a CACHE-BUSTER (the freshness control)",
          lambda: u.startswith("https://raw.githubusercontent.com/AlgoVaultLabs/"
                               "crypto-quant-signal-mcp/refs/heads/main/")
          and u.endswith("src/lib/integrations-data/claim-evidence.json?cb=123"))
    check("npmjs.com/package/<scoped pkg> is rewritten to the registry API, and says so",
          lambda: rewrite_source("https://www.npmjs.com/package/@smithery/cli")[0]
          == "https://registry.npmjs.org/%40smithery%2Fcli"
          and "403" in rewrite_source("https://www.npmjs.com/package/@smithery/cli")[1])
    check("a non-npmjs source is left untouched and carries no note",
          lambda: rewrite_source("https://cursor.com/docs/mcp") == ("https://cursor.com/docs/mcp", ""))
    check("the SHIPPED redirect predicate follows 308 (urllib's default handler does not)",
          lambda: follows_redirect(308, "https://x.test/y") is True
          and follows_redirect(301, "https://x.test/y") is True)
    check("a redirect with NO Location, and a non-redirect status, are not followed",
          lambda: follows_redirect(308, None) is False and follows_redirect(200, "https://x.test/y") is False)

    # ── corpus declaration + construction-time vacuity ──────────────────────────────────────
    check("the shipped CORPUS line parses: JSON path, required fields, per-corpus floor 8",
          lambda: parse_corpus_line(CORPUS[0]) == {
              "name": "mcp-clients", "path": "src/lib/integrations-data/claim-evidence.json",
              "fields": ["slug", "kind", "verifiedAt", "evidence"], "min_rows": 8})
    check("a 3-field CORPUS line (no floor) is vacuity, not a skip",
          lambda: _raises(Indeterminate, lambda: parse_corpus_line("a|b|c")))
    check("a non-integer floor is vacuity",
          lambda: _raises(Indeterminate, lambda: parse_corpus_line("a|b|c|eight")))
    check("a valid JSON corpus parses into rows carrying their evidence",
          lambda: [r["slug"] for r in parse_corpus(doc(), MOD)][:2] == ["r0", "r1"]
          and parse_corpus(doc(), MOD)[0]["evidence"][0]["expect"] == ["fixture add"])
    check("a body that is not JSON -> INDETERMINATE",
          lambda: _raises(Indeterminate, lambda: parse_corpus("export const x = 1;", MOD)))
    check("schema_version != 1 -> INDETERMINATE",
          lambda: _raises(Indeterminate, lambda: parse_corpus(doc(schema_version=2), MOD)))
    check("a document for a different corpus -> INDETERMINATE",
          lambda: _raises(Indeterminate, lambda: parse_corpus(doc(corpus="ai-agents"), MOD)))
    check("rows below the corpus floor -> INDETERMINATE",
          lambda: _raises(Indeterminate, lambda: parse_corpus(doc(rows_n=3), MOD)))
    # Through parse_corpus_line, never a hand-built dict: a floor the self-test constructs itself is
    # exactly the seam that let a hardcoded global floor survive the first break-proof run.
    ai_line = parse_corpus_line("ai-agents|src/lib/integrations-data/claim-evidence-ai.json|"
                                "slug,kind,verifiedAt,evidence|4")
    check("the floor is PER CORPUS, read from its own CORPUS line: a 4-row corpus declaring 4 passes "
          "(v1's global 8 blinded the whole run)",
          lambda: ai_line["min_rows"] == 4
          and len(parse_corpus(json.dumps(dict(json.loads(doc(rows_n=4)), corpus="ai-agents")), ai_line)) == 4)
    d_empty = json.loads(doc()); d_empty["rows"][5]["evidence"] = []
    check("a row with ZERO evidence -> INDETERMINATE (nothing to confirm is not a confirmation)",
          lambda: _raises(Indeterminate, lambda: parse_corpus(json.dumps(d_empty), MOD)))
    d_bad = json.loads(doc()); d_bad["rows"][2]["evidence"][0]["expect"] = []
    check("an anchor with no expect strings -> INDETERMINATE",
          lambda: _raises(Indeterminate, lambda: parse_corpus(json.dumps(d_bad), MOD)))
    d_missing = json.loads(doc()); del d_missing["rows"][0]["verifiedAt"]
    check("a row missing a declared field -> INDETERMINATE (the fields column has a consumer)",
          lambda: _raises(Indeterminate, lambda: parse_corpus(json.dumps(d_missing), MOD)))

    # ── the match space ─────────────────────────────────────────────────────────────────────
    check("raw-body match", lambda: present("fixture add", match_space("<p>fixture add</p>")))
    check("entity-unescaped match: &gt; in HTML confirms '>' in an anchor",
          lambda: present("Customize > Connectors", match_space("<li>Customize &gt; Connectors</li>")))
    check("tags become SPACES: a table cell boundary still reads as one phrase",
          lambda: present("mcp_servers Ignored",
                          match_space("<td><code>mcp_servers</code></td><td>Ignored</td>")))
    check("JSON string leaves are matched decoded (an escaped quote does not hide the claim)",
          lambda: present('"hi" --header', match_space(json.dumps({"readme": 'say "hi" --header'})))
          and not present('"hi" --header', [collapse(json.dumps({"readme": 'say "hi" --header'}))]))
    check("matching is CASE-SENSITIVE: 'Organization settings > Connectors' never confirms "
          "'Settings > Connectors'",
          lambda: not present("Settings > Connectors",
                              match_space("<p>Organization settings &gt; Connectors</p>")))

    # ── the evidence arm, per anchor ────────────────────────────────────────────────────────
    ok_page = page("<p>claude mcp add --transport http --scope project --header</p>")
    check("every expect present, no reject -> confirmed",
          lambda: evaluate_anchor(anchor(expect=("claude mcp add --transport http", "--header")),
                                  ok_page, scoper())["verdict"] == AN_CONFIRMED)
    miss = evaluate_anchor(anchor(expect=("--header", "Settings > Connectors")), ok_page, scoper())
    check("one expect missing -> contradicted, and the MISSING string is named",
          lambda: miss["verdict"] == AN_CONTRADICTED and miss["missing"] == "Settings > Connectors")
    rej = evaluate_anchor(anchor(expect=("--header",), reject=("--scope project",)), ok_page, scoper())
    check("a reject string present -> contradicted, and the PRESENT string is named",
          lambda: rej["verdict"] == AN_CONTRADICTED and rej["rejected"] == "--scope project")
    un = evaluate_anchor(anchor(), page("", http=400), scoper())
    check("a non-200 -> unreachable, carrying the http code",
          lambda: un["verdict"] == AN_UNREACHABLE and "400" in un["why"])
    mv = evaluate_anchor(anchor(src="https://v.example/old/path"),
                         page("<p>fixture add</p>", final="https://v.example/new/path"), scoper())
    check("a cross-path redirect -> still CONFIRMED, plus a `moved` note naming the final URL",
          lambda: mv["verdict"] == AN_CONFIRMED and mv["moved"] == "https://v.example/new/path")
    check("a trailing slash, a query or a fragment is NOT a move",
          lambda: moved_to("https://v.example/a/b", "https://v.example/a/b/") is None
          and moved_to("https://v.example/a/b", "https://v.example/a/b?x=1#y") is None
          and moved_to("https://www.npmjs.com/package/@s/cli", "https://registry.npmjs.org/%40s%2Fcli") is None)

    # ── the re-keyed vendor arm ─────────────────────────────────────────────────────────────
    hit = evaluate_anchor(anchor(scope="@selftest"), page("<p>fixture add</p>"),
                          scoper({"@selftest/dsh-mcp-client": "MCP client bridge"}))
    check("npmScopeAbsence + a first-party MCP client in that scope -> contradicted, naming it",
          lambda: hit["verdict"] == AN_CONTRADICTED and hit["vendor"] == ["@selftest/dsh-mcp-client"])
    calls = []
    plain = evaluate_anchor(anchor(), page("<p>fixture add</p>"), scoper(calls=calls))
    check("no npmScopeAbsence declared -> the arm is ABSENT (confirmed, scope never probed), "
          "never indeterminate",
          lambda: plain["verdict"] == AN_CONFIRMED and calls == [])
    check("npmScopeAbsence with unproven exhaustion -> indeterminate (capped-collection law)",
          lambda: evaluate_anchor(anchor(scope="@selftest"), page("<p>fixture add</p>"),
                                  scoper(exhausted=False))["verdict"] == AN_INDETERMINATE)
    check("scope filter needs BOTH an mcp token and a client word",
          lambda: scope_hits({"@v/dsh-mcp-client": "MCP client bridge", "@v/dsh-mcp-server": "an MCP server",
                              "@v/http-client": "a plain client", "@o/mcp-client": "wrong scope"}, "@v")
          == ["@v/dsh-mcp-client"])

    # ── rows: confirmation state and age ────────────────────────────────────────────────────
    r_old = row(slug="s1", verified="2020-01-01")
    sha_old = evidence_sha(r_old["evidence"])
    pages_ok = {"https://v.example/s1": page("<p>fixture add</p>")}
    pages_dead = {"https://v.example/s1": page("", http=503)}
    v_ok, rec_ok = evaluate_row(r_old, pages_ok, DAY, None, scoper())
    check("a row confirmed TODAY is age 0 and never stale, whatever its verifiedAt",
          lambda: v_ok["state"] == ST_CONFIRMED and v_ok["age_days"] == 0
          and rec_ok == {"date": "2026-09-29", "evidence_sha": sha_old})
    v10, _ = evaluate_row(r_old, pages_dead, DAY, {"date": "2026-09-19", "evidence_sha": sha_old}, scoper())
    check("confirmed 10 d ago (sha matches) + unreachable today -> NOT stale; state unreachable",
          lambda: v10["state"] == ST_UNREACHABLE and v10["age_days"] == 10
          and v10["confirmed"] == "2026-09-19")
    check("…and that aggregates INDETERMINATE, never PASS",
          lambda: aggregate([v10] + [dict(v_ok, slug="x%d" % i) for i in range(11)], 12)[0] == "INDETERMINATE")
    vmis, _ = evaluate_row(r_old, pages_dead, DAY, {"date": "2026-09-19", "evidence_sha": "0" * 64}, scoper())
    check("a confirmation of DIFFERENT evidence (sha mismatch) is ignored -> age from verifiedAt -> stale",
          lambda: vmis["state"] == ST_STALE and vmis["confirmed"] is None)
    vlong, _ = evaluate_row(r_old, pages_dead, DAY, {"date": "2026-03-01", "evidence_sha": sha_old}, scoper())
    check("last confirmation > 150 d + unreachable -> stale",
          lambda: vlong["state"] == ST_STALE and vlong["age_days"] == 212)
    vnone, _ = evaluate_row(row(verified="not-a-date"), {"https://v.example/s1": page("", http=503)},
                            DAY, None, scoper())
    check("no usable date and never confirmed -> predicate indeterminate (never implicitly fresh)",
          lambda: vnone["state"] == ST_INDETERMINATE and vnone["age_days"] is None)
    two = row(evidence=[anchor(src="https://v.example/a"),
                        anchor(src="https://v.example/b", expect=("gone phrase",))])
    vtwo, rtwo = evaluate_row(two, {"https://v.example/a": page("<p>fixture add</p>"),
                                    "https://v.example/b": page("<p>fixture add</p>")}, DAY, None, scoper())
    check("a row is confirmed only when EVERY anchor confirms (one contradicted -> row contradicted)",
          lambda: vtwo["state"] == ST_CONTRADICTED and rtwo is None)
    check("a v1 state (no confirmations key) and a malformed one read as NO confirmations",
          lambda: prior_confirmations({"verdict": "FAIL", "row_count": 12}) == {}
          and prior_confirmations({"confirmations": ["x"]}) == {})
    _, tok_c, conf_c = tok([row(slug="s%d" % i) for i in range(12)])
    check("a confirmed run persists one confirmation per row, keyed module/slug",
          lambda: tok_c == "PASS" and sorted(conf_c) == sorted("mcp-clients/s%d" % i for i in range(12)))

    # ── aggregation ─────────────────────────────────────────────────────────────────────────
    check("precedence: a definite finding beats an unknown",
          lambda: strongest([AN_UNREACHABLE, AN_CONTRADICTED], ANCHOR_PRECEDENCE) == AN_CONTRADICTED)
    check("all confirmed -> PASS", lambda: tok(corpus())[1] == "PASS")
    check("one contradicted row -> FAIL",
          lambda: tok(corpus(11) + [row(slug="gone")],
                      fetcher(per_url={"gone": (200, "<p>nothing</p>")}))[1] == "FAIL")
    check("one stale row -> FAIL",
          lambda: tok(corpus(11) + [row(slug="old", verified="2020-01-01")],
                      fetcher(per_url={"old": (503, "")}))[1] == "FAIL")
    check("an unreachable source does NOT silently PASS the aggregate",
          lambda: tok(corpus(11) + [row(slug="dead")],
                      fetcher(per_url={"dead": (503, "")}))[1] == "INDETERMINATE")
    check("zero rows -> INDETERMINATE", lambda: aggregate([], None)[0] == "INDETERMINATE")
    check("a row count that moved beyond tolerance -> INDETERMINATE even when every row confirms",
          lambda: aggregate([{"state": ST_CONFIRMED}] * 8, 12)[0] == "INDETERMINATE")
    check("a row count moving within tolerance is NOT indeterminate",
          lambda: aggregate([{"state": ST_CONFIRMED}] * 10, 12)[0] == "PASS")
    check("each distinct evidence URL is fetched ONCE per run",
          lambda: _count_fetches([row(slug="a", evidence=[anchor(src="https://v.example/same")] * 3),
                                  row(slug="b", evidence=[anchor(src="https://v.example/same")])]) == 1)

    # ── rendered artifacts ──────────────────────────────────────────────────────────────────
    tok(corpus(11) + [row(slug="stale-row", verified="2020-01-01")], fetcher(per_url={"stale-row": (503, "")}))
    body_stale = LAST_FIRE.get(ALERT_ID, "")
    check("a stale-only body says 'not confirmed … for more than 150 days' and NEVER 'contradicted' "
          "or 'no longer match'",
          lambda: "1 public integration claim not confirmed against its live source for more than 150 days."
          in body_stale and "contradict" not in body_stale and "no longer match" not in body_stale)
    tok(corpus(10) + [row(slug="codex", evidence=[anchor(src="https://v.example/codex", claim="only stdio",
                                                          expect=("codex mcp add",), reject=("--url",))]),
                      row(slug="dead")],
        fetcher(per_url={"codex": (200, "<p>codex mcp add example --url https://m.example</p>"),
                         "dead": (503, "")}))
    body_c = LAST_FIRE.get(ALERT_ID, "")
    check("a contradicted body headlines it, and names claim / present string / source",
          lambda: "1 public integration claim contradicted by its live source." in body_c
          and '    claim: "only stdio"' in body_c
          and '    present on source (contradicts the claim): "--url"' in body_c
          and "    source: https://v.example/codex" in body_c
          and "not confirmed against" not in body_c)
    check("the COUNT and the SLUGS are on separate lines (the '(new: 6)' misread class)",
          lambda: "Affected row slug: codex" in body_c and "(1)" not in body_c)
    check("an unreachable row is housekeeping, never a finding",
          lambda: "Also unverifiable today (not a finding): dead — source http=503" in body_c
          and "Affected row slug: codex" in body_c)
    check("the Action line is TEMPLATED W{NEXT} from the corpus, never a literal wave number",
          lambda: "Action: dispatch LANDING-MCP-CLIENTS-CLAIMS-W{NEXT} via Cowork -> Claude Code" in body_c
          and not re.search(r"-W\d+\b", body_c) and not re.search(r"-W\d+\b", body_stale))
    check("the body names where the rows render",
          lambda: "algovault.com/docs, /mcp, /integrations and the landing quickstart grid" in body_c)
    tok(corpus(11) + [row(slug="gone")],
        fetcher(per_url={"gone": (200, "<p>nothing</p>"),
                         "s3": (200, "<p>fixture add</p>", "https://v.example/elsewhere")}))
    body_m = LAST_FIRE.get(ALERT_ID, "")
    check("a moved-but-confirmed source is listed as housekeeping with its final URL",
          lambda: "Evidence source moved (claim still evidenced — update the URL): s3 → "
                  "https://v.example/elsewhere" in body_m)
    check("…and the housekeeping sections are ABSENT when empty",
          lambda: "Evidence source moved" not in body_c and "Also unverifiable" not in body_stale)
    line = render_row_line(v10)
    check("the per-row line is POSITIVE: slug, kind, stamp, confirmation, age, state, per-anchor verdicts",
          lambda: "slug=s1" in line and "kind=native" in line and "verifiedAt=2020-01-01" in line
          and "confirmed=2026-09-19" in line and "age=10d" in line
          and "state=source unreachable" in line and "a1=unreachable" in line)
    check("a never-confirmed row says confirmed=never", lambda: "confirmed=never" in render_row_line(vmis))

    # ── recovery ────────────────────────────────────────────────────────────────────────────
    LAST_CLEAR.clear()
    tok(corpus(), prev={"verdict": "FAIL", "row_count": 12})
    check("FAIL -> PASS clears the alert exactly once",
          lambda: list(LAST_CLEAR) == [ALERT_ID] and "confirmed" in LAST_CLEAR[ALERT_ID])
    LAST_CLEAR.clear()
    tok(corpus(), prev={"verdict": "PASS", "row_count": 12})
    check("PASS -> PASS clears NOTHING (recovery chatter stays silent)", lambda: not LAST_CLEAR)

    # ── the log is written once ─────────────────────────────────────────────────────────────
    probe_a, probe_b = os.path.join(tmp, "a.log"), os.path.join(tmp, "b.log")
    Path(probe_a).write_text(""); Path(probe_b).write_text("")
    with open(probe_a, "a") as fh:
        same, other = _fd_is_file(fh.fileno(), probe_a), _fd_is_file(fh.fileno(), probe_b)
    check("stdout-is-the-log detection: same inode -> skip the second append; different -> append",
          lambda: same is True and other is False and _fd_is_file(-1, probe_a) is False)

    # ── token -> exit-code mapping, and the token's shape ───────────────────────────────────
    check("INDETERMINATE maps to exit 3; PASS and FAIL to 0 (FAIL: the alert IS the action)",
          lambda: _token_exit_map() == {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3})
    src_text = Path(__file__).read_text()
    main_body = src_text.split("def main():")[1].split("\ndef ")[0]
    check("EVERY exit path of main() emits exactly one token — one print per return",
          lambda: main_body.count('print("CLIENT_CLAIM_FRESHNESS_VERDICT=')
          == main_body.count("        return ") == 3)
    check("the token is line-anchored — never embedded mid-line",
          lambda: all(not before.rstrip("\n").split("\n")[-1].strip().startswith(("log(", "#"))
                      for before in src_text.split('"CLIENT_CLAIM_FRESHNESS_VERDICT=')[:-1]))
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


def _count_fetches(rows):
    seen = []

    def f(url):
        seen.append(url)
        return 200, "<p>fixture add</p>", "", url
    evaluate(rows, date(2026, 9, 29), f, lambda s: ({}, True), {})
    return len(seen)


def _raises(exc, fn):
    try:
        fn()
    except exc:
        return True
    except Exception:  # noqa: BLE001 — the WRONG exception is still a failure
        return False
    return False


# Floor, not a target — set to the ACTUAL check count so removing any scenario trips it. Raise it
# when scenarios are added; it exists so a suite that stops running its scenarios cannot report a
# confident pass over nothing.
_SELF_TEST_MIN_CHECKS = 67


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="rendered-claim vs live-evidence canary")
    ap.add_argument("--self-test", action="store_true",
                    help="hermetic scenario suite; exit non-zero on failure")
    a = ap.parse_args()
    sys.exit(self_test() if a.self_test else main())
