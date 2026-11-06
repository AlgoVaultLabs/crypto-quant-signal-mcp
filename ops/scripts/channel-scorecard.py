#!/usr/bin/env python3
"""channel-scorecard.py — OPS-AUTOPUB-DEVTO-DECOUPLE-W1 CH2. What does each publishing channel earn? Read-only.

Mr.1 decides dev.to's future on 2026-12-04 from this scorecard. It reads three stores, writes none of them, and
prints one Markdown report on stdout (the audit file is that report, verbatim). Its last line is

    CHANNEL_SCORECARD_VERDICT=KEEP|RETIRE|INDETERMINATE

  (a) GEO probe history. Source: the signal-1 Postgres behind the Monday digest, as `aoe_readonly` in ONE
      repeatable-read READ ONLY transaction. Tables: geo_mentions (one row per successful query × engine × sample;
      mention_found = the answer names AlgoVault) and geo_source_citations (one row per source an answer cited).
      Shown per engine × week. Each cited URL is bucketed by exact host and path, never by the probe's name-based
      `attributed_to`, which also credits lookalike brands (algovault.io, algovaults.com, …):
        dev.to/algovaultlabs · github (ours: AlgoVaultLabs, AlgoVaultFi) · algovault.com and its subdomains ·
        medium (the probe tied the page to AlgoVault) · other pages the probe tied to AlgoVault
  (b) Plausible CE (site algovault.com). Read from its own ClickHouse store (`clickhouse-client --readonly=1`); no
      Stats API key exists and none is created. Visitors (uniqExact over pageviews) by month and referrer channel
      since 2026-05-01. The site was added 2026-07-14, so earlier months are INDETERMINATE. Plausible records no
      completed signup: the `Signup Click` CTA goal is shown under its own name, and signups stay INDETERMINATE.
  (c) dev.to: GET https://dev.to/api/articles/me/all, live and unpublished. The key is read from
      /etc/algovault-editorial/env and never printed. Shows page_views_count, public_reactions_count and
      comments_count per article.

The pre-registered 2026-12-04 rule, computed at the end:
  KEEP dev.to  if (a) any engine cited a dev.to/algovaultlabs URL for a buyer query, or (b) dev.to referred more
               visitors than github.com over the months both were live.
  RETIRE       if both legs are evaluated and false.
  INDETERMINATE if neither leg is true and at least one could not be evaluated.
"Buyer query": the spec says "the 15 buyer queries", but the query SoT holds 20, and 15 was its W1 size. So leg (a)
is computed under each defensible reading of the current SoT, and the report says whether the readings agree.

Two runs over the same --as-of print identical bytes (the GEO and Plausible reads stop at the cutoff). The dev.to
counters are live, so a view landing between two runs is reported as a difference, never smoothed.

    channel-scorecard.py --as-of 2026-11-06T00:00:00Z      # on signal-1, e.g. `ssh … python3 - --as-of … < this`
    channel-scorecard.py --self-test                        # hermetic, in the repo
"""
from __future__ import annotations

import argparse
import calendar
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WAVE = "OPS-AUTOPUB-DEVTO-DECOUPLE-W1"

# ── Pre-registered reference data. The 12-04 rule decides on these; they are baked here, never fetched. ──
# landing/Prompt/geo-objective.yaml target_set (GEO-TARGET-DIGEST-REDESIGN-W1, 2026-07-15) without the
# measure_only presence probe. The self-test asserts this equals the repo files.
TARGET_QUERIES = {
    "composite-quant-signal": "A", "verifiable-track-record": "A", "market-regime-detection": "A",
    "crewai-trading-tools": "A", "claude-trading-stack": "A", "trade-call-not-data": "A",
    "verifiable-winrate-api": "A", "altfins-alternative": "A", "x402-signal-api": "A", "signal-api-pricing": "A",
    "retail-signals-verifiable": "A",
    "ai-agent-trade-signals": "B", "mcp-server-discovery": "B", "build-crypto-agent": "B", "cross-venue-funding": "B",
    "langchain-crypto-integration": "B", "llamaindex-quant-stack": "B",
    "best-mcp-trading": "contested", "agent-signal-api": "contested",
}
PRESENCE_PROBE = "algovault-exists"
# geo-queries.yaml: "the 6 buyer-intent queries" (GEO-TARGET-DIGEST-REDESIGN-W1).
BUYER_INTENT_6 = ("trade-call-not-data", "verifiable-winrate-api", "altfins-alternative", "x402-signal-api",
                  "signal-api-pricing", "retail-signals-verifiable")
READINGS = (
    ("every target query (19: tiers A, B and contested)", tuple(sorted(TARGET_QUERIES))),
    ("Tier A, conversion (11)", tuple(sorted(q for q, t in TARGET_QUERIES.items() if t == "A"))),
    ("the 6 buyer-intent queries", tuple(sorted(BUYER_INTENT_6))),
)
GEO_BUCKETS = ("devto", "github", "algovault", "medium", "other")
GEO_BUCKET_LABEL = {"devto": "dev.to/algovaultlabs", "github": "github (ours)", "algovault": "algovault.com",
                    "medium": "medium (tied to AlgoVault)", "other": "other tied to AlgoVault"}
GITHUB_OWNERS = ("algovaultlabs", "algovaultfi")   # the org that holds our repos, and the account the spec named

PLAUSIBLE_SITE_ID = 1                              # sites.id 1 = algovault.com (plausible_db, read 2026-11-06)
PLAUSIBLE_SITE_ADDED = "2026-07-14"
PLAUSIBLE_SINCE = "2026-05-01"
SIGNUP_PROXY_GOAL = "Signup Click"
CHANNELS = ("dev.to", "github.com", "medium.com", "ai_engines", "search", "direct", "other")
AI_HOSTS = ("chatgpt.com", "chat.openai.com", "openai.com", "claude.ai", "perplexity.ai", "www.perplexity.ai",
            "gemini.google.com", "bard.google.com", "copilot.microsoft.com", "poe.com", "you.com",
            "chat.deepseek.com", "grok.com", "meta.ai", "chat.mistral.ai", "phind.com")
SEARCH_SOURCES = ("Google", "Bing", "DuckDuckGo", "Yahoo!", "Baidu", "Yandex", "Brave", "Ecosia", "Startpage",
                  "Qwant", "Naver", "Seznam", "Sogou", "Ask", "AOL")

GEO_PSQL = ("docker", "exec", "-i", "crypto-quant-signal-mcp-postgres-1", "psql", "-X", "-U", "aoe_readonly",
            "-d", "signal_performance", "-q", "-tA", "-F", "\x1f", "-v", "ON_ERROR_STOP=1")
CLICKHOUSE = ("docker", "exec", "plausible-ce-plausible_events_db-1", "clickhouse-client", "--readonly=1")
DEVTO_ENV_FILE = "/etc/algovault-editorial/env"
DEVTO_KEY_NAME = "DEVTO_API_KEY"
DEVTO_ME_ALL = "https://dev.to/api/articles/me/all"
DEVTO_UA = "algovault-channel-scorecard/1 (+https://algovault.com)"
SUBPROCESS_TIMEOUT_S = 240
STATEMENT_TIMEOUT = "120s"
AS_OF_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
VERDICT_TOKEN = "CHANNEL_SCORECARD_VERDICT="
EXIT_FOR = {"KEEP": 0, "RETIRE": 0, "INDETERMINATE": 3}
SEP = "\x1f"


def epoch(iso):
    return calendar.timegm(time.strptime(iso, "%Y-%m-%dT%H:%M:%SZ"))


def month_of(iso_date):
    return iso_date[:7]


def months_between(first, last):
    """['YYYY-MM', …] from first to last inclusive."""
    y, m = int(first[:4]), int(first[5:7])
    out = []
    while "%04d-%02d" % (y, m) <= last:
        out.append("%04d-%02d" % (y, m))
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


# ── (a) the GEO store ────────────────────────────────────────────────────────────────────────

def geo_bucket(url, attributed_to):
    """A cited URL -> one of GEO_BUCKETS, or None (not ours and not tied to AlgoVault). Owned buckets match by exact
    host and path; medium and other count only pages the probe itself tied to AlgoVault."""
    try:
        p = urllib.parse.urlsplit((url or "").strip())
    except ValueError:
        return None
    host = (p.hostname or "").lower()
    seg = [s for s in p.path.lower().split("/") if s]
    if host in ("dev.to", "www.dev.to") and seg[:1] == ["algovaultlabs"]:
        return "devto"
    if host in ("github.com", "www.github.com") and seg[:1] and seg[0] in GITHUB_OWNERS:
        return "github"
    if host == "algovault.com" or host.endswith(".algovault.com"):
        return "algovault"
    if attributed_to == "algovault":
        return "medium" if host == "medium.com" or host.endswith(".medium.com") else "other"
    return None


def geo_sql(as_of):
    cut = "'%s'::timestamptz" % as_of
    owned = r"source_url ~* '(dev\.to/|github\.com/|algovault\.com|medium\.com)' OR attributed_to = 'algovault'"
    return "\n".join([
        "\\set ON_ERROR_STOP on",
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
        "SET LOCAL statement_timeout = '%s';" % STATEMENT_TIMEOUT,
        "SELECT 'MARK' || chr(31) || 'ro' || chr(31) || current_setting('transaction_read_only');",
        "SELECT 'MARK' || chr(31) || 'sec' || chr(31) || 'answers';",
        "SELECT model, to_char(date_trunc('week', ran_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'), count(*), count(*) FILTER (WHERE mention_found) "
        "FROM geo_mentions WHERE ran_at < %s GROUP BY 1, 2 ORDER BY 1, 2;" % cut,
        "SELECT 'MARK' || chr(31) || 'sec' || chr(31) || 'cites';",
        "SELECT model, to_char(date_trunc('week', ran_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'), query_id, run_id, sample_idx_or_rank, "
        "replace(replace(source_url, chr(31), ''), chr(10), ''), coalesce(attributed_to, '') FROM ("
        "SELECT model, ran_at, coalesce(query_id, '') AS query_id, coalesce(run_id::text, '') AS run_id, "
        "coalesce(rank, 0) AS sample_idx_or_rank, source_url, attributed_to FROM geo_source_citations "
        "WHERE ran_at < %s AND source_url IS NOT NULL AND (%s)) c ORDER BY 1, 2, 3, 6, 4, 5;" % (cut, owned),
        "SELECT 'MARK' || chr(31) || 'sec' || chr(31) || 'coverage';",
        "SELECT model, to_char(min(ran_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD'), to_char(max(ran_at) AT TIME ZONE 'UTC', "
        "'YYYY-MM-DD'), count(DISTINCT run_id) FROM geo_mentions WHERE ran_at < %s GROUP BY 1 ORDER BY 1;" % cut,
        "SELECT 'MARK' || chr(31) || 'sec' || chr(31) || 'url_kept';",
        "SELECT count(*), count(source_url) FROM geo_source_citations WHERE ran_at < %s;" % cut,
        "SELECT 'MARK' || chr(31) || 'end';",
        "COMMIT;",
    ]) + "\n"


GEO_SECTIONS = {"answers": 4, "cites": 7, "coverage": 4, "url_kept": 2}


def parse_geo(stdout):
    """-> (dict of sections, None) or (None, reason). Read-only flag, every section, MARK|end — else a reason."""
    b = {"ro": None, "end": False}
    b.update({k: [] for k in GEO_SECTIONS})
    sec = None
    for ln in (stdout or "").splitlines():
        if not ln:
            continue
        f = ln.split(SEP)
        if f[0] == "MARK":
            if len(f) >= 3 and f[1] == "ro":
                b["ro"] = f[2]
            elif len(f) >= 3 and f[1] == "sec":
                sec = f[2]
            elif len(f) == 2 and f[1] == "end":
                b["end"] = True
                sec = None
            continue
        if sec not in GEO_SECTIONS:
            return None, "a GEO line outside any section: %r" % ln[:80]
        if len(f) != GEO_SECTIONS[sec]:
            return None, "a GEO %s line has %d fields, not %d" % (sec, len(f), GEO_SECTIONS[sec])
        b[sec].append(f)
    if b["ro"] != "on":
        return None, "the GEO snapshot was not read-only (transaction_read_only=%r)" % b["ro"]
    if not b["end"]:
        return None, "the GEO bundle ended before its end mark (short read)"
    if len(b["url_kept"]) != 1:
        return None, "the GEO url-kept section returned %d lines" % len(b["url_kept"])
    return b, None


def score_geo(b):
    """The (a) tables and leg, from a parsed bundle. Pure."""
    rows = {}
    for model, week, n, named in b["answers"]:
        rows[(model, week)] = {"answers": int(n), "named": int(named), **{k: 0 for k in GEO_BUCKETS}}
    channel = {k: {"citations": 0, "answers": set(), "engines": set(), "queries": set(), "first": None, "last": None}
               for k in GEO_BUCKETS}
    devto_q = {}
    other_domains = {}
    for model, week, qid, run_id, rank, url, attributed in b["cites"]:
        k = geo_bucket(url, attributed)
        if k is None:
            continue
        r = rows.setdefault((model, week), {"answers": 0, "named": 0, **{x: 0 for x in GEO_BUCKETS}})
        r[k] += 1
        c = channel[k]
        c["citations"] += 1
        c["answers"].add((model, week, qid, run_id))
        c["engines"].add(model)
        c["queries"].add(qid)
        c["first"] = week if c["first"] is None or week < c["first"] else c["first"]
        c["last"] = week if c["last"] is None or week > c["last"] else c["last"]
        if k == "devto":
            d = devto_q.setdefault((qid, model), {"citations": 0, "first": week, "last": week})
            d["citations"] += 1
            d["first"], d["last"] = min(d["first"], week), max(d["last"], week)
        if k == "other":
            host = (urllib.parse.urlsplit(url).hostname or "?").lower()
            other_domains[host] = other_domains.get(host, 0) + 1
    total, kept = (int(x) for x in b["url_kept"][0])
    legs = []
    for name, qset in READINGS:
        hits = sorted({q for (q, _m) in devto_q if q in qset})
        legs.append({"reading": name, "true": bool(hits), "queries": hits})
    return {"rows": rows, "channel": channel, "devto_q": devto_q, "other_domains": other_domains,
            "coverage": b["coverage"], "citations_total": total, "citations_url_kept": kept, "legs": legs}


# ── (b) Plausible CE ─────────────────────────────────────────────────────────────────────────

def _sql_list(xs):
    return ", ".join("'%s'" % x.replace("'", "") for x in xs)


def channel_expr():
    """ClickHouse multiIf: one referrer channel per event, first match wins (the order is the definition)."""
    d = "domain(referrer)"
    return ("multiIf("
            "%s IN ('dev.to', 'www.dev.to') OR referrer_source IN ('DEV Community', 'dev.to', 'DEV'), 'dev.to', "
            "%s IN ('github.com', 'www.github.com') OR referrer_source = 'GitHub', 'github.com', "
            "%s = 'medium.com' OR endsWith(%s, '.medium.com') OR referrer_source = 'Medium', 'medium.com', "
            "%s IN (%s) OR referrer_source IN (%s), 'ai_engines', "
            "referrer_source IN (%s), 'search', "
            "referrer_source = '' AND referrer = '', 'direct', "
            "'other')" % (d, d, d, d, d, _sql_list(AI_HOSTS), _sql_list(AI_HOSTS), _sql_list(SEARCH_SOURCES)))


def plausible_sql(as_of, kind, window_start=None):
    ts_end = as_of.replace("T", " ").replace("Z", "")
    base = "FROM plausible_events_db.events_v2 WHERE site_id = %d AND timestamp < toDateTime('%s', 'UTC')" % (
        PLAUSIBLE_SITE_ID, ts_end)
    if kind == "first":
        return "SELECT toString(toDate(min(timestamp))), count() %s FORMAT TSV" % base
    if kind == "visitors":
        return ("SELECT toString(toStartOfMonth(timestamp)), %s AS ch, uniqExact(user_id), count() %s AND name = 'pageview' "
                "AND timestamp >= toDateTime('%s 00:00:00', 'UTC') GROUP BY 1, 2 ORDER BY 1, 2 FORMAT TSV"
                % (channel_expr(), base, PLAUSIBLE_SINCE))
    if kind == "signup_clicks":
        return ("SELECT toString(toStartOfMonth(timestamp)), %s AS ch, count(), uniqExact(user_id) %s AND name = '%s' "
                "AND timestamp >= toDateTime('%s 00:00:00', 'UTC') GROUP BY 1, 2 ORDER BY 1, 2 FORMAT TSV"
                % (channel_expr(), base, SIGNUP_PROXY_GOAL, PLAUSIBLE_SINCE))
    if kind == "window":
        return ("SELECT %s AS ch, uniqExact(user_id) %s AND name = 'pageview' AND timestamp >= toDateTime('%s 00:00:00', "
                "'UTC') GROUP BY 1 ORDER BY 1 FORMAT TSV" % (channel_expr(), base, window_start))
    raise ValueError(kind)


def parse_tsv(stdout, cols):
    out = []
    for ln in (stdout or "").splitlines():
        if not ln:
            continue
        f = ln.split("\t")
        if len(f) != cols:
            raise ValueError("a TSV line has %d fields, not %d" % (len(f), cols))
        out.append(f)
    return out


# ── (c) dev.to ───────────────────────────────────────────────────────────────────────────────

def read_devto_key(path=DEVTO_ENV_FILE):
    """The one key, read as data from the env file. Returns (key, None) or (None, reason); the key is never printed."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            for ln in f:
                if ln.startswith(DEVTO_KEY_NAME + "="):
                    v = ln[len(DEVTO_KEY_NAME) + 1:].strip().strip('"').strip("'")
                    return (v, None) if v else (None, "%s is empty in the env file" % DEVTO_KEY_NAME)
    except OSError as e:
        return None, "the env file is unreadable: %s" % type(e).__name__
    return None, "no %s line in the env file" % DEVTO_KEY_NAME


def fetch_devto(key, opener=None):
    """GET me/all, every page. -> (articles, None) or (None, reason). The reason never carries the key."""
    opener = opener or urllib.request.urlopen
    out = []
    for page in range(1, 11):
        url = "%s?per_page=1000&page=%d" % (DEVTO_ME_ALL, page)
        req = urllib.request.Request(url, headers={"api-key": key, "Accept": "application/vnd.forem.api-v1+json",
                                                   "User-Agent": DEVTO_UA})
        try:
            with opener(req, timeout=30) as r:
                body = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return None, "me/all page %d: HTTP %d" % (page, e.code)
        except (urllib.error.URLError, OSError, ValueError) as e:
            return None, "me/all page %d: %s" % (page, type(e).__name__)
        if not isinstance(body, list):
            return None, "me/all page %d is not a JSON list" % page
        if not body:
            return out, None
        out.extend(body)
    return None, "me/all did not end within 10 pages"


def score_devto(articles):
    rows = []
    for a in articles:
        rows.append({"id": int(a["id"]), "live": bool(a.get("published")),
                     "published_at": (a.get("published_at") or "")[:10] or "-",
                     "views": int(a.get("page_views_count") or 0), "reactions": int(a.get("public_reactions_count") or 0),
                     "comments": int(a.get("comments_count") or 0),
                     "title": re.sub(r"[|\n\r]", " ", str(a.get("title") or ""))[:90]})
    rows.sort(key=lambda r: r["id"])
    first_live = min((r["published_at"] for r in rows if r["published_at"] != "-"), default=None)
    return rows, first_live


# ── the report ───────────────────────────────────────────────────────────────────────────────

def decide(geo, plausible_leg):
    """The 12-04 rule. geo: score_geo() result or None; plausible_leg: {'true': bool, …} or None. -> verdict, why."""
    if geo is None:
        a = None
    else:
        agree = len({l["true"] for l in geo["legs"]}) == 1
        a = geo["legs"][0]["true"] if agree else None
    b = None if plausible_leg is None else plausible_leg["true"]
    if a is True or b is True:
        return "KEEP", "leg (a) true" if a is True else "leg (b) true"
    if a is False and b is False:
        return "RETIRE", "both legs evaluated false"
    return "INDETERMINATE", "no leg is true, and leg %s could not be evaluated" % ("(a)" if a is None else "(b)")


def render(as_of, geo, geo_err, pl, pl_err, dv, dv_err):
    """The whole report. Pure: same inputs, same bytes."""
    L = []
    w = L.append
    w("# GEO channel scorecard — 2026-11")
    w("")
    w("Wave: %s CH2. Report: `ops/scripts/channel-scorecard.py --as-of %s` (read-only). The GEO store and Plausible "
      "are read up to the cutoff %s (exclusive). The dev.to counters are live at fetch time." % (WAVE, as_of, as_of))
    w("")
    # (a)
    w("## (a) GEO probe — per engine × week")
    w("")
    if geo is None:
        w("**INDETERMINATE**: %s." % geo_err)
    else:
        w("Instrument: signal-1 Postgres `signal_performance` as `aoe_readonly`, in one REPEATABLE READ READ ONLY "
          "transaction. Answers = `geo_mentions` rows (one per successful query × engine × sample). Name AlgoVault = "
          "`mention_found`. Bucket columns = `geo_source_citations` rows whose `source_url` falls in the bucket. "
          "%d of %d citation rows keep their URL." % (geo["citations_url_kept"], geo["citations_total"]))
        w("")
        w("| Engine | Week | Answers | Name AlgoVault | %s |" % " | ".join(GEO_BUCKET_LABEL[k] for k in GEO_BUCKETS))
        w("|---|---|---:|---:|%s" % ("---:|" * len(GEO_BUCKETS)))
        for (model, week) in sorted(geo["rows"]):
            r = geo["rows"][(model, week)]
            w("| %s | %s | %d | %d | %s |" % (model, week, r["answers"], r["named"], " | ".join(str(r[k]) for k in GEO_BUCKETS)))
        w("")
        w("Coverage, from the same instrument (first and last probe day, distinct runs):")
        w("")
        w("| Engine | First | Last | Runs |")
        w("|---|---|---|---:|")
        for model, first, last, runs in geo["coverage"]:
            w("| %s | %s | %s | %s |" % (model, first, last, runs))
        w("")
        w("### (a) one row per channel")
        w("")
        w("Instrument: as above. Answers citing it = distinct (engine, week, query, run).")
        w("")
        w("| Channel | Citations | Answers citing it | Engines | Queries | First week | Last week |")
        w("|---|---:|---:|---:|---:|---|---|")
        for k in GEO_BUCKETS:
            c = geo["channel"][k]
            w("| %s | %d | %d | %d | %d | %s | %s |" % (GEO_BUCKET_LABEL[k], c["citations"], len(c["answers"]),
                                                      len(c["engines"]), len(c["queries"]), c["first"] or "-", c["last"] or "-"))
        w("")
        w("Bucket rules (exact host and path):")
        w("- dev.to/algovaultlabs: host dev.to, and the first path segment is `algovaultlabs`.")
        w("- github (ours): host github.com, and the first segment is `AlgoVaultLabs` (the org that holds our repos) "
          "or `AlgoVaultFi` (the account the spec named; it holds none of our repos). Case-insensitive.")
        w("- algovault.com: that host or any of its subdomains. Lookalike domains such as algovault.io and "
          "algovaults.com are not ours.")
        w("- medium and other: pages the probe itself tied to AlgoVault (`attributed_to='algovault'`) and that are "
          "outside the owned buckets. That tie is name-based, so lookalike brands land in other.")
        top = sorted(geo["other_domains"].items(), key=lambda kv: (-kv[1], kv[0]))[:10]
        if top:
            w("- The other bucket's top domains: %s." % ", ".join("%s (%d)" % kv for kv in top))
        w("")
        w("### dev.to/algovaultlabs citations by query")
        w("")
        w("Instrument: as above. Tier = `landing/Prompt/geo-objective.yaml` target_set.")
        w("")
        w("| Query | Tier | Engine | Citations | First week | Last week |")
        w("|---|---|---|---:|---|---|")
        for (qid, model) in sorted(geo["devto_q"]):
            d = geo["devto_q"][(qid, model)]
            tier = TARGET_QUERIES.get(qid, "presence probe" if qid == PRESENCE_PROBE else "not in the SoT")
            w("| %s | %s | %s | %d | %s | %s |" % (qid, tier, model, d["citations"], d["first"], d["last"]))
        if not geo["devto_q"]:
            w("| (none) | | | 0 | | |")
    w("")
    # (b)
    w("## (b) Plausible CE — visitors by month × referrer channel")
    w("")
    if pl is None:
        w("**INDETERMINATE**: %s." % pl_err)
    else:
        w("Instrument: Plausible CE ClickHouse `plausible_events_db.events_v2`, site_id %d (algovault.com), read with "
          "`clickhouse-client --readonly=1`. Visitors = `uniqExact(user_id)` over pageview events in the month. "
          "Plausible salts user_id daily, so a visitor who returns on another day counts again (Plausible's own "
          "definition). Channel = the first matching rule below." % PLAUSIBLE_SITE_ID)
        w("")
        w("| Month | %s | Coverage |" % " | ".join(CHANNELS))
        w("|---|%s---|" % ("---:|" * len(CHANNELS)))
        for mo in months_between(month_of(PLAUSIBLE_SINCE), month_of(as_of)):
            if mo < month_of(pl["first_event"]):
                w("| %s | %s | INDETERMINATE: no instrument (the site was added %s) |" % (
                    mo, " | ".join("—" for _ in CHANNELS), PLAUSIBLE_SITE_ADDED))
                continue
            cells = [str(pl["visitors"].get((mo, ch), 0)) for ch in CHANNELS]
            note = "partial: from %s" % pl["first_event"] if mo == month_of(pl["first_event"]) else (
                "partial: to %s" % as_of[:10] if mo == month_of(as_of) else "full month")
            w("| %s | %s | %s |" % (mo, " | ".join(cells), note))
        w("")
        w("Channel rules, in order: dev.to (referrer host dev.to, or source DEV Community) · github.com (host "
          "github.com, or source GitHub) · medium.com (host medium.com or *.medium.com, or source Medium) · "
          "ai_engines (host or source in: %s) · search (source in: %s) · direct (no source, no referrer) · other." % (
              ", ".join(AI_HOSTS), ", ".join(SEARCH_SOURCES)))
        w("")
        w("### Signups")
        w("")
        w("**INDETERMINATE**: Plausible records no completed-signup event, so signups by referrer are not "
          "measured here. The nearest goal is `%s`, a client-side click on a signup call-to-action. It is not a "
          "verified signup. Shown below under its own name." % SIGNUP_PROXY_GOAL)
        w("")
        w("Instrument: as above, events named `%s`, as events (visitors)." % SIGNUP_PROXY_GOAL)
        w("")
        w("| Month | %s |" % " | ".join(CHANNELS))
        w("|---|%s" % ("---:|" * len(CHANNELS)))
        for mo in months_between(month_of(pl["first_event"]), month_of(as_of)):
            w("| %s | %s |" % (mo, " | ".join("%d (%d)" % pl["signup_clicks"].get((mo, ch), (0, 0)) for ch in CHANNELS)))
    w("")
    # (c)
    w("## (c) dev.to — articles (me/all)")
    w("")
    if dv is None:
        w("**INDETERMINATE**: %s." % dv_err)
    else:
        rows, first_live = dv
        w("Instrument: `GET %s`, authenticated with the editorial host's key (never printed). Every article, live "
          "and unpublished, with DEV's own counters at fetch time." % DEVTO_ME_ALL)
        w("")
        w("| Article id | Status | Published | Views | Reactions | Comments | Title |")
        w("|---:|---|---|---:|---:|---:|---|")
        for r in rows:
            w("| %d | %s | %s | %d | %d | %d | %s |" % (r["id"], "live" if r["live"] else "unpublished", r["published_at"],
                                                      r["views"], r["reactions"], r["comments"], r["title"]))
        for label, sel in (("live", True), ("unpublished", False)):
            sub = [r for r in rows if r["live"] is sel]
            w("| **%s total** | %d articles | | %d | %d | %d | |" % (label, len(sub), sum(r["views"] for r in sub),
                                                                 sum(r["reactions"] for r in sub), sum(r["comments"] for r in sub)))
        w("")
        w("First published article: %s." % (first_live or "none"))
    w("")
    # the rule
    w("## The 2026-12-04 rule, computed")
    w("")
    w("Pre-registered: **KEEP dev.to** if (a) any engine cited a dev.to/algovaultlabs URL for any buyer query, or "
      "(b) dev.to referred more visitors than github.com over the months both were live. **Otherwise RETIRE.**")
    w("")
    if geo is None:
        w("- (a): **INDETERMINATE**: %s." % geo_err)
    else:
        w("- (a): the spec says \"the 15 buyer queries\". The SoT (`landing/Prompt/geo-queries.yaml`) holds 20, "
          "19 targets and 1 presence probe; 15 was its W1 size. Leg (a) under each defensible reading:")
        for leg in geo["legs"]:
            w("  - %s: **%s**%s" % (leg["reading"], "true" if leg["true"] else "false",
                                    " (%s)" % ", ".join(leg["queries"]) if leg["queries"] else ""))
        agree = len({l["true"] for l in geo["legs"]}) == 1
        w("  - The readings %s." % ("agree" if agree else "DISAGREE, so leg (a) is INDETERMINATE until Mr.1 names the set"))
    if pl is None or dv is None:
        w("- (b): **INDETERMINATE**: %s." % (pl_err if pl is None else dv_err))
    else:
        leg = pl["leg"]
        w("- (b): window %s to %s. Both channels live means dev.to's first published article (%s) and Plausible's "
          "first event (%s), whichever is later. Visitors = uniqExact(user_id) over the window: dev.to **%d**, "
          "github.com **%d**, so dev.to referred %s." % (
              leg["start"], as_of[:10], dv[1] or "none", pl["first_event"], leg["devto"], leg["github"],
              "more" if leg["true"] else "not more"))
    pl_leg = None if (pl is None or dv is None) else pl["leg"]
    verdict, why = decide(geo, pl_leg)
    w("")
    w("**Verdict: %s** (%s)." % (verdict, why))
    w("")
    w(VERDICT_TOKEN + verdict)
    return "\n".join(L) + "\n", verdict


# ── IO (read-only) ───────────────────────────────────────────────────────────────────────────

def run_cmd(argv, input_text=None):
    try:
        p = subprocess.run(list(argv), input=input_text, capture_output=True, encoding="utf-8", errors="replace",
                           timeout=SUBPROCESS_TIMEOUT_S, stdin=None if input_text is not None else subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        return None, "%s could not run: %s" % (argv[0], type(e).__name__)
    if p.returncode != 0:
        return None, "%s rc=%d: %s" % (" ".join(argv[:4]), p.returncode, p.stderr.strip()[:200])
    return p.stdout, None


def collect(as_of):
    geo, geo_err = None, None
    out, err = run_cmd(GEO_PSQL, geo_sql(as_of))
    if err:
        geo_err = "the GEO store could not be read (%s)" % err
    else:
        b, why = parse_geo(out)
        if why:
            geo_err = why
        else:
            geo = score_geo(b)
            if not geo["citations_url_kept"]:
                geo, geo_err = None, "the GEO store keeps no cited URLs"

    dv, dv_err = None, None
    key, why = read_devto_key()
    if why:
        dv_err = "the dev.to key could not be read (%s)" % why
    else:
        arts, why = fetch_devto(key)
        key = None
        if why:
            dv_err = "dev.to me/all could not be read (%s)" % why
        else:
            dv = score_devto(arts)

    pl, pl_err = None, None
    try:
        f_out, err = run_cmd(CLICKHOUSE + ("--query", plausible_sql(as_of, "first")))
        if err:
            raise RuntimeError(err)
        first = parse_tsv(f_out, 2)
        if not first or first[0][1] == "0":
            raise RuntimeError("the Plausible store holds no event for site %d" % PLAUSIBLE_SITE_ID)
        v_out, err = run_cmd(CLICKHOUSE + ("--query", plausible_sql(as_of, "visitors")))
        if err:
            raise RuntimeError(err)
        s_out, err = run_cmd(CLICKHOUSE + ("--query", plausible_sql(as_of, "signup_clicks")))
        if err:
            raise RuntimeError(err)
        pl = {"first_event": first[0][0],
              "visitors": {(r[0][:7], r[1]): int(r[2]) for r in parse_tsv(v_out, 4)},
              "signup_clicks": {(r[0][:7], r[1]): (int(r[2]), int(r[3])) for r in parse_tsv(s_out, 4)}}
        if dv is not None:
            start = max(x for x in (dv[1], pl["first_event"]) if x)
            w_out, err = run_cmd(CLICKHOUSE + ("--query", plausible_sql(as_of, "window", start)))
            if err:
                raise RuntimeError(err)
            win = {r[0]: int(r[1]) for r in parse_tsv(w_out, 2)}
            pl["leg"] = {"start": start, "devto": win.get("dev.to", 0), "github": win.get("github.com", 0),
                         "true": win.get("dev.to", 0) > win.get("github.com", 0)}
    except (RuntimeError, ValueError) as e:
        pl, pl_err = None, "the Plausible store could not be read (%s)" % str(e)[:200]
    return geo, geo_err, pl, pl_err, dv, dv_err


def main(argv=None):
    ap = argparse.ArgumentParser(description="channel scorecard (read-only)")
    ap.add_argument("--as-of")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)
    if a.self_test:
        return self_test()
    if not a.as_of or not AS_OF_RE.match(a.as_of):
        ap.error("--as-of YYYY-MM-DDTHH:MM:SSZ is required (the reads stop there, so two runs agree)")
    try:
        report, verdict = render(a.as_of, *collect(a.as_of))
    except Exception as e:  # noqa: BLE001 — an unexpected fault computed nothing
        report, verdict = "# GEO channel scorecard — fault\n\n%s: %s\n\n%sINDETERMINATE\n" % (
            type(e).__name__, str(e)[:200], VERDICT_TOKEN), "INDETERMINATE"
    sys.stdout.write(report)
    return EXIT_FOR[verdict]


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

_SELF_TEST_MIN_CHECKS = 35


def self_test():
    failures, ran = [], []

    def check(name, fn):
        ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001 — an assertion that raises is a crash, not a verdict
            failures.append(name)
            print("  [FAIL] %s (raised %s: %s)" % (name, type(e).__name__, str(e)[:160]))
            return
        if not ok:
            failures.append(name)
        print("  [%s] %s" % ("ok" if ok else "FAIL", name))

    S = SEP
    AS_OF = "2026-11-06T00:00:00Z"

    def geo_out(cites, answers=None, ro="on", end=True, kept=(100, 100)):
        answers = answers if answers is not None else [("sonar", "2026-10-05", "10", "2"), ("gpt-4.1-mini", "2026-10-05", "9", "1")]
        lines = ["MARK%sro%s%s" % (S, S, ro), "MARK%ssec%sanswers" % (S, S)] + [S.join(a) for a in answers]
        lines += ["MARK%ssec%scites" % (S, S)] + [S.join(c) for c in cites]
        lines += ["MARK%ssec%scoverage" % (S, S), S.join(("sonar", "2026-06-08", "2026-11-02", "22")),
                  "MARK%ssec%surl_kept" % (S, S), S.join(str(x) for x in kept)]
        if end:
            lines.append("MARK%send" % S)
        return "\n".join(lines) + "\n"

    def cite(url, q="trade-call-not-data", model="sonar", week="2026-10-05", att="neutral", run="r1", rank="1"):
        return (model, week, q, run, rank, url, att)

    DEV = "https://dev.to/algovaultlabs/one-verdict-per-call-1abc"
    # ── bucket rules ──
    check("dev.to/algovaultlabs: exact host + first segment; another dev.to author is not ours",
          lambda: geo_bucket(DEV, "neutral") == "devto" and geo_bucket("https://dev.to/someoneelse/x", "neutral") is None
          and geo_bucket("https://dev.to/algovaultlabsx/y", "neutral") is None)
    check("github: the AlgoVaultLabs org and the AlgoVaultFi account, case-insensitive; gist and others are not",
          lambda: geo_bucket("https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp", "neutral") == "github"
          and geo_bucket("https://github.com/algovaultlabs/x", "neutral") == "github"
          and geo_bucket("https://github.com/AlgoVaultFi", "neutral") == "github"
          and geo_bucket("https://github.com/someone/algovault", "neutral") is None
          and geo_bucket("https://gist.github.com/AlgoVaultLabs/x", "neutral") is None)
    check("algovault.com and its subdomains; lookalike registrable domains are not ours, even when the probe ties them",
          lambda: geo_bucket("https://algovault.com/x", "neutral") == "algovault"
          and geo_bucket("https://blog.algovault.com/y", "neutral") == "algovault"
          and geo_bucket("https://algovault.io/", "neutral") is None
          and geo_bucket("https://algovault.io/", "algovault") == "other"
          and geo_bucket("https://www.algovaults.com/", "algovault") == "other"
          and geo_bucket("https://notalgovault.com/", "neutral") is None)
    check("medium counts only pages the probe tied to AlgoVault",
          lambda: geo_bucket("https://medium.com/@x/post", "algovault") == "medium"
          and geo_bucket("https://someone.medium.com/post", "algovault") == "medium"
          and geo_bucket("https://medium.com/@x/post", "neutral") is None)
    check("a malformed URL is no bucket, never a crash", lambda: geo_bucket("http://[::1", "algovault") is None)
    # ── parsing ──
    b, why = parse_geo(geo_out([cite(DEV)]))
    check("a well-formed GEO bundle parses", lambda: why is None and len(b["cites"]) == 1)
    check("a bundle that was not read-only is refused", lambda: parse_geo(geo_out([], ro="off"))[0] is None)
    check("a short read (no end mark) is refused", lambda: parse_geo(geo_out([], end=False))[0] is None)
    check("a line with the wrong field count is refused",
          lambda: parse_geo(geo_out([("a", "b")]))[0] is None)
    # ── leg (a) ──
    g = score_geo(parse_geo(geo_out([cite(DEV), cite(DEV, q="algovault-exists"), cite(DEV, q="cross-venue-funding")]))[0])
    check("leg (a) true under every reading when a Tier-A buyer-intent query cites dev.to",
          lambda: all(l["true"] for l in g["legs"]))
    g2 = score_geo(parse_geo(geo_out([cite(DEV, q="algovault-exists")]))[0])
    check("the presence probe never makes leg (a) true", lambda: not any(l["true"] for l in g2["legs"]))
    g3 = score_geo(parse_geo(geo_out([cite(DEV, q="cross-venue-funding")]))[0])
    check("a Tier-B-only citation splits the readings (true for all targets, false for Tier A and the 6)",
          lambda: [l["true"] for l in g3["legs"]] == [True, False, False])
    check("decide: split readings with leg (b) false -> INDETERMINATE, never RETIRE",
          lambda: decide(g3, {"true": False})[0] == "INDETERMINATE")
    check("decide: KEEP when (a) is true under every reading", lambda: decide(g, {"true": False})[0] == "KEEP")
    check("decide: KEEP when (b) alone is true", lambda: decide(g2, {"true": True})[0] == "KEEP")
    check("decide: RETIRE only when both legs are evaluated false", lambda: decide(g2, {"true": False})[0] == "RETIRE")
    check("decide: an unreadable GEO store with (b) false is INDETERMINATE", lambda: decide(None, {"true": False})[0] == "INDETERMINATE")
    check("decide: (a) false with (b) unreadable is INDETERMINATE", lambda: decide(g2, None)[0] == "INDETERMINATE")
    check("per-week rows count each bucket; answers with no citation still show",
          lambda: g["rows"][("sonar", "2026-10-05")]["devto"] == 3 and g["rows"][("gpt-4.1-mini", "2026-10-05")]["answers"] == 9)
    check("answers citing a channel are distinct (engine, week, query, run)",
          lambda: len(score_geo(parse_geo(geo_out([cite(DEV, rank="1"), cite(DEV + "2", rank="2")]))[0])["channel"]["devto"]["answers"]) == 1)
    # ── reference data ──
    check("19 targets (11 A, 6 B, 2 contested); the presence probe is not one; the 6 buyer-intent are Tier A",
          lambda: len(TARGET_QUERIES) == 19 and sum(1 for t in TARGET_QUERIES.values() if t == "A") == 11
          and PRESENCE_PROBE not in TARGET_QUERIES and all(TARGET_QUERIES[q] == "A" for q in BUYER_INTENT_6))
    check("the baked target set equals landing/Prompt/geo-objective.yaml and geo-queries.yaml in this repo",
          lambda: repo_target_set() == (dict(TARGET_QUERIES), PRESENCE_PROBE))
    # ── (b) and (c) ──
    check("the ClickHouse reads are SELECTs bounded by the cutoff, through --readonly=1",
          lambda: "--readonly=1" in CLICKHOUSE and all(plausible_sql(AS_OF, k, "2026-07-14").startswith("SELECT")
                                                       and "2026-11-06 00:00:00" in plausible_sql(AS_OF, k, "2026-07-14")
                                                       for k in ("first", "visitors", "signup_clicks", "window")))
    check("the GEO bundle is one REPEATABLE READ READ ONLY transaction with no write verb, cut at --as-of",
          lambda: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" in geo_sql(AS_OF) and "'2026-11-06T00:00:00Z'::timestamptz" in geo_sql(AS_OF)
          and not re.search(r"\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b", geo_sql(AS_OF).upper()))
    check("the dev.to key is read as data from KEY=value, and an absent key is a reason, never a value",
          lambda: _key_roundtrip())
    check("a dev.to HTTP error names the status and never the key", lambda: _devto_error_hides_key())
    check("me/all pages until an empty page", lambda: _devto_pages())
    # ── the report ──
    pl = {"first_event": "2026-07-14", "visitors": {("2026-07", "github.com"): 5, ("2026-08", "dev.to"): 2},
          "signup_clicks": {("2026-08", "direct"): (3, 2)}, "leg": {"start": "2026-07-14", "devto": 2, "github": 5, "true": False}}
    dv = ([{"id": 3, "live": True, "published_at": "2026-05-01", "views": 40, "reactions": 2, "comments": 0, "title": "t"},
           {"id": 1, "live": False, "published_at": "2026-04-01", "views": 7, "reactions": 0, "comments": 1, "title": "u"}], "2026-04-01")
    r1, v1 = render(AS_OF, g, None, pl, None, dv, None)
    r2, _ = render(AS_OF, g, None, pl, None, dv, None)
    check("render is deterministic (same inputs, same bytes)", lambda: r1 == r2)
    check("the report ends with exactly one verdict token", lambda: r1.rstrip("\n").splitlines()[-1] == VERDICT_TOKEN + "KEEP"
          and r1.count(VERDICT_TOKEN) == 1 and v1 == "KEEP")
    check("every table names its instrument (an Instrument line precedes each table)", lambda: _every_table_has_instrument(r1))
    check("every table is rectangular (header, separator and every row carry the same cell count)",
          lambda: _tables_are_rectangular(r1) and not _tables_are_rectangular("| a | b |\n|---|---|---|\n| 1 | 2 |\n"))
    check("months before the site existed are INDETERMINATE rows, named",
          lambda: "| 2026-05 |" in r1 and "INDETERMINATE: no instrument (the site was added 2026-07-14)" in r1
          and "| 2026-06 |" in r1)
    check("signups are INDETERMINATE and the CTA goal is shown under its own name",
          lambda: "### Signups" in r1 and "Plausible records no completed-signup event" in r1 and "`Signup Click`" in r1)
    check("an unreadable source renders as a named INDETERMINATE section, and the verdict follows the rule",
          lambda: render(AS_OF, None, "the GEO store could not be read (boom)", pl, None, dv, None)[1] == "INDETERMINATE"
          and "**INDETERMINATE**: the GEO store could not be read (boom)." in render(AS_OF, None, "the GEO store could not be read (boom)", pl, None, dv, None)[0])
    check("dev.to rows sort by id and carry live and unpublished totals",
          lambda: "| **live total** | 1 articles | | 40 | 2 | 0 | |" in r1 and "| **unpublished total** | 1 articles | | 7 | 0 | 1 | |" in r1)

    print("self-test: %d checks, %d failed" % (len(ran), len(failures)))
    if len(ran) < _SELF_TEST_MIN_CHECKS:
        print("self-test: FAIL — only %d checks ran (floor %d)" % (len(ran), _SELF_TEST_MIN_CHECKS))
        return 1
    return 1 if failures else 0


def repo_target_set():
    """(target_set without measure_only, the presence probe) read from the repo's YAML files, which have to sit at
    ../../landing/Prompt relative to this file. No YAML library: the two files use one fixed line shape."""
    here = os.path.dirname(os.path.abspath(__file__))
    prompt = os.path.join(here, "..", "..", "landing", "Prompt")
    obj = open(os.path.join(prompt, "geo-objective.yaml"), encoding="utf-8").read()
    rows = re.findall(r"^  ([a-z0-9-]+):\s*\{\s*tier:\s*([A-Za-z_]+)\s*,", obj, re.M)
    targets = {q: t for q, t in rows if t != "measure_only"}
    presence = [q for q, t in rows if t == "measure_only"]
    ids = re.findall(r"^\s*-\s*id:\s*([a-z0-9-]+)\s*$", open(os.path.join(prompt, "geo-queries.yaml"), encoding="utf-8").read(), re.M)
    if sorted(ids) != sorted(list(targets) + presence) or len(presence) != 1:
        return None
    return targets, presence[0]


def _key_roundtrip():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "env")
        with open(p, "w") as f:
            f.write("OTHER=1\n%s=\"abc123\"\nX=2\n" % DEVTO_KEY_NAME)
        ok1 = read_devto_key(p) == ("abc123", None)
        with open(p, "w") as f:
            f.write("OTHER=1\n")
        k, why = read_devto_key(p)
        return ok1 and k is None and DEVTO_KEY_NAME in why and read_devto_key(p + ".gone")[0] is None


def _devto_error_hides_key():
    def opener(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)
    arts, why = fetch_devto("SECRET-KEY-VALUE", opener)
    return arts is None and "401" in why and "SECRET" not in why


def _devto_pages():
    pages = [[{"id": 2}], [{"id": 1}], []]
    seen = []

    class R:
        def __init__(self, body):
            self.body = body

        def read(self):
            return json.dumps(self.body).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def opener(req, timeout):
        seen.append(req.full_url)
        assert req.get_header("Api-key") == "k"
        return R(pages[len(seen) - 1])
    arts, why = fetch_devto("k", opener)
    return why is None and [a["id"] for a in arts] == [2, 1] and len(seen) == 3 and seen[0].endswith("page=1")


def _tables_are_rectangular(report):
    """Every run of consecutive `|` lines (a table) has one cell count throughout."""
    width = None
    for ln in report.splitlines() + [""]:
        if ln.startswith("|"):
            n = len(ln.strip().strip("|").split("|"))
            if width is None:
                width = n
            elif n != width:
                return False
        else:
            width = None
    return True


def _every_table_has_instrument(report):
    lines = report.splitlines()
    for i, ln in enumerate(lines):
        if ln.startswith("|---") or ln.startswith("|---:"):
            head = i - 1
            j = head - 1
            while j >= 0 and not lines[j].startswith("#"):
                if lines[j].startswith("Instrument:") or lines[j].startswith("Coverage, from the same instrument"):
                    break
                j -= 1
            if j < 0 or lines[j].startswith("#"):
                return False
    return True


if __name__ == "__main__":
    sys.exit(main())
