/**
 * scripts/lib/snapshot-sot.mjs — ONE derivation of "what does the live SoT say this claim is",
 * shared by the WRITE side and the READ side of the snapshot-injection lane.
 *
 * OPS-README-GIT-CHANNEL-PRODUCER-W1 CH2 (2026-09-10).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * CLAUDE.md's single-derivation rule, verbatim: "A write-side + a read-side/monitor that both
 * derive it → extract ONE shared pure fn imported by both + a byte-identical canary. Independent
 * re-derivations drift to contradiction/total-miss."
 *
 *   write side  scripts/snapshot-landing-data.mjs        — bakes the literal into README.md
 *   read side   scripts/check-readme-snapshot-freshness.mjs — asserts the baked literal is in band
 *
 * If the gate re-implemented `formatValue`, a change of `float_1dp` to two decimals would leave
 * the gate silently comparing against a differently-rounded number: a watcher that agrees with
 * its producer only by coincidence. Same reasoning, same shape and the same neighbouring
 * precedent as `scripts/lib/manifest-targets.mjs`, which the injector already shares with
 * `scripts/check-claim-coverage.mjs` for exactly this reason.
 *
 * The bodies below are a PURE MOVE out of snapshot-landing-data.mjs — unchanged, so the
 * extraction cannot alter a baked value. `tests/readme-snapshot-freshness.test.ts` pins the
 * formatter contract in both directions.
 *
 * Everything here is pure except `fetchSoT`, which is the one I/O boundary and is fail-soft by
 * contract: it returns `null` rather than throwing, because both consumers are fail-open on an
 * unreachable SoT.
 */

// ─────────── Accessors ───────────
// Accept a dot-path or a small DSL: 'totalCalls', 'overall.pfeWinRate*100',
// 'batches.length', 'batches.latest.published_at', 'totalCalls+totalHolds',
// 'asset_count_rounded_to_10'.

export function getNestedValue(obj, path) {
  return path.split(".").reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    if (key === "length") return acc.length;
    if (key === "latest" && Array.isArray(acc)) {
      // Return the array element with the most recent .published_at
      return acc
        .slice()
        .sort(
          (a, b) =>
            new Date(b.published_at).getTime() -
            new Date(a.published_at).getTime(),
        )[0];
    }
    return acc[key];
  }, obj);
}

export function evalAccessor(accessor, dataMap) {
  // Special derived accessors
  if (accessor === "totalCalls+totalHolds") {
    const tc = dataMap.performance?.totalCalls;
    const th = dataMap.performance?.totalHolds;
    if (typeof tc !== "number" || typeof th !== "number") return null;
    return tc + th;
  }
  if (accessor === "asset_count_rounded_to_10") {
    const v = dataMap.performance?.asset_count;
    if (typeof v !== "number") return null;
    return Math.floor(v / 10) * 10;
  }
  if (accessor === "overall.pfeWinRate*100") {
    const v = dataMap.performance?.overall?.pfeWinRate;
    if (typeof v !== "number") return null;
    return v * 100;
  }
  // Default: dot-path resolution against the SoT root (caller must pass right root)
  return null; // Handled by caller via getNestedValue + claim.sot
}

export function resolveValue(claim, dataMap) {
  // Try special accessors first
  const special = evalAccessor(claim.accessor, dataMap);
  if (special !== null && special !== undefined) return special;

  // Otherwise dot-path resolution against the SoT root
  const root = dataMap[claim.sot];
  if (!root) return null;
  return getNestedValue(root, claim.accessor);
}

// ─────────── Formatters ───────────

export function formatValue(value, format) {
  if (value === null || value === undefined) return null;
  switch (format) {
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return String(Math.floor(value));
    case "integer_with_commas":
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return Math.floor(value).toLocaleString("en-US");
    case "float_1dp":
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return value.toFixed(1);
    case "iso_to_human": {
      // "2026-05-25T00:05:07.733Z" -> "2026-05-25 00:05 UTC"
      if (typeof value !== "string") return null;
      const d = new Date(value);
      if (isNaN(d.getTime())) return null;
      const pad = (x) => (x < 10 ? `0${x}` : String(x));
      const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
      return `${ymd} ${hm}`;
    }
    default:
      return null;
  }
}

// ─────────── Fetch ───────────

/**
 * The ONE I/O boundary. Returns parsed JSON, or `null` on any failure — a timeout, a non-200, a
 * DNS miss, an unparseable body. `null` is a FIRST-CLASS OUTCOME here, not an error swallowed:
 * both consumers are fail-open on an unreachable SoT (the injector keeps the stale bake and
 * exits 0; the gate reports INDETERMINATE and exits 0), so a throw would force each of them to
 * re-derive that contract in a catch block.
 *
 * `onWarn` is how the caller gets the diagnostic without this module owning a log format — the
 * injector routes it through its own timestamped logger, the gate through its finding list.
 */
export async function fetchSoT(url, timeoutMs, onWarn = () => {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "algovault-snapshot-landing/1.0",
      },
    });
    if (!res.ok) {
      onWarn(`SoT_FETCH_NON_200: ${url} -> ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    onWarn(`SoT_FETCH_FAILED: ${url} -> ${err.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
