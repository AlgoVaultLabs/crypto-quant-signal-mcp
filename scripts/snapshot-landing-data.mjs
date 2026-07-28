#!/usr/bin/env node
/**
 * scripts/snapshot-landing-data.mjs — OPS-LANDING-AUTO-ALIGN-W1 (2026-05-25)
 *
 * Build-time SoT snapshot injection for landing/*.html fallbacks. Architect
 * ratified at Plan-Mode R1 ("Manifest + tolerance approved — proceed to R2").
 *
 * Runs on Hetzner inside .github/workflows/deploy.yml SSH step, AFTER git pull
 * BEFORE `cp landing/*.html /var/www/algovault/` (so Caddy serves the refreshed
 * files immediately) AND BEFORE `docker compose up -d` (so any future container-
 * served route also sees fresh files).
 *
 * Reads scripts/snapshot-landing-manifest.json; fetches /api/performance-public
 * and /api/merkle-batches once each; per claim row applies a regex-replace on
 * the target file(s); writes file back ONLY if content changed (idempotent).
 *
 * Properties:
 *   - Idempotent: running 2x in a row produces byte-identical files.
 *   - Fail-open: SoT fetch failure → log warning + exit 0 (deploy continues
 *     with stale fallbacks; canary catches eventually).
 *   - Catastrophic-failure escalation: if >=50% of claims fail to match (e.g.
 *     someone renamed all data-tr-field keys), exit 1 (GHA deploy red).
 *   - --dry-run flag: log what WOULD change, write nothing.
 *
 * Zero npm deps (uses Node 20+ native fetch + AbortController + JSON.parse).
 *
 * Log path: /var/log/algovault-snapshot-landing.log (Hetzner) OR stdout (local).
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(__dirname, "..");
const MANIFEST_PATH = pathResolve(__dirname, "snapshot-landing-manifest.json");

const args = process.argv.slice(2);
// OPS-FRESHNESS-SOURCE-TRUTH-W1 (2026-07-28): --check is --dry-run plus a MEANINGFUL EXIT
// CODE — 0 when every managed literal already matches the SoT, 1 when a run WOULD change
// something. That is what lets `ops/cron/snapshot-landing-daily.sh --check` gate on "the
// bake is current" without mutating a file. --check implies --dry-run (never writes).
// NOTE: --check deliberately keeps the fail-OPEN contract for an unreachable SoT (exit 0,
// "cannot tell" is not "drifted") — only a CONFIRMED would-change returns 1.
const CHECK = args.includes("--check");
const DRY_RUN = args.includes("--dry-run") || CHECK;
const VERBOSE = args.includes("--verbose") || DRY_RUN;

// --only=<substr>[,<substr>...] restricts the run to claims whose id contains one of the
// substrings. Exists because an UNFILTERED --check can never be clean: the manifest mixes
// cadence classes, and `call_count` (SoT .totalCalls) grows every few minutes — measured
// 417,673 baked vs 417,687 live two minutes after a successful re-bake. So "the bake is
// current" is only globally true for seconds, which makes an unfiltered --check useless as a
// standing gate while still being a fine "is a run due?" signal.
// Gating therefore scopes the check to claims whose PRODUCER cadence makes staleness
// meaningful — e.g. `--only=batch` covers the daily merkle claims this wave is about.
// Same principle as the canary's per-metric-class tolerance contract: continuously-growing
// counters are FLOOR-tolerant, scheduled values are exact.
const ONLY = (args.find((a) => a.startsWith("--only=")) || "")
  .replace("--only=", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  // Always to stdout; deploy.yml redirects stdout+stderr to /var/log/...
  console.log(line);
}

function logInfo(msg) {
  log("INFO", msg);
}
function logWarn(msg) {
  log("WARN", msg);
}
function logError(msg) {
  log("ERROR", msg);
}
function logDebug(msg) {
  if (VERBOSE) log("DEBUG", msg);
}

// ─────────── Accessors ───────────
// Accept a dot-path or a small DSL: 'totalCalls', 'overall.pfeWinRate*100',
// 'batches.length', 'batches.latest.published_at', 'totalCalls+totalHolds',
// 'asset_count_rounded_to_10'.

function getNestedValue(obj, path) {
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

function evalAccessor(accessor, dataMap) {
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

function resolveValue(claim, dataMap) {
  // Try special accessors first
  const special = evalAccessor(claim.accessor, dataMap);
  if (special !== null && special !== undefined) return special;

  // Otherwise dot-path resolution against the SoT root
  const root = dataMap[claim.sot];
  if (!root) return null;
  return getNestedValue(root, claim.accessor);
}

// ─────────── Formatters ───────────

function formatValue(value, format) {
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

async function fetchSoT(url, timeoutMs) {
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
      logWarn(`SoT_FETCH_NON_200: ${url} -> ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    logWarn(`SoT_FETCH_FAILED: ${url} -> ${err.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────── Replacement ───────────

function buildReplacement(template, capturedGroups, value) {
  // Template uses $1, $2, ..., $9 for captured groups and {value} for the SoT value.
  let out = template;
  for (let i = 1; i <= 9; i++) {
    out = out.split(`$${i}`).join(capturedGroups[i] ?? "");
  }
  out = out.split("{value}").join(String(value));
  return out;
}

function applyClaimToContent(content, claim, value) {
  let count = 0;
  const flags = claim.replace_all ? "g" : "";
  const re = new RegExp(claim.find_pattern, flags);
  const newContent = content.replace(re, (...args) => {
    count++;
    // args = [match, ...captures, offset, string]
    // Pull captures 1..N
    const captures = args.slice(0, -2); // drop offset + string
    // captures[0] is the full match; we want captures[1..]
    const captureGroups = [
      captures[0],
      ...captures.slice(1).map((c) => c ?? ""),
    ];
    return buildReplacement(claim.replace_template, captureGroups, value);
  });
  return { newContent, count };
}

// ─────────── Main ───────────

async function main() {
  const startTime = Date.now();
  const mode = CHECK ? "CHECK" : DRY_RUN ? "DRY_RUN" : "LIVE";
  logInfo(`START algovault-snapshot-landing mode=${mode} manifest=${MANIFEST_PATH}`);

  // Load manifest
  let manifest;
  try {
    const raw = await readFile(MANIFEST_PATH, "utf-8");
    manifest = JSON.parse(raw);
  } catch (err) {
    logError(`MANIFEST_LOAD_FAILED: ${err.message}`);
    process.exit(0); // fail-open: deploy continues
  }
  logInfo(`MANIFEST_LOADED claims=${manifest.claims.length}`);

  // Fetch SoT endpoints in parallel
  const dataMap = {};
  const fetchPromises = Object.entries(manifest.sot_endpoints).map(
    async ([name, url]) => {
      const data = await fetchSoT(url, manifest.fetch_timeout_ms || 10000);
      if (data) dataMap[name] = data;
    },
  );
  await Promise.all(fetchPromises);

  const fetchedKeys = Object.keys(dataMap);
  if (fetchedKeys.length === 0) {
    logWarn("ALL_SOT_FETCHES_FAILED: deploy continues with stale fallbacks");
    process.exit(0); // fail-open
  }
  logInfo(`SOT_FETCHED endpoints=${fetchedKeys.join(",")}`);

  // Group claims by file to minimize file I/O
  const claimsByFile = new Map(); // path -> [{claim, value, ...}, ...]
  let claimsResolved = 0;
  let claimsSkipped = 0;
  for (const claim of manifest.claims) {
    if (ONLY.length && !ONLY.some((f) => claim.id.includes(f))) {
      logDebug(`CLAIM_FILTERED id=${claim.id} reason=not_in_--only`);
      continue;
    }
    if (!dataMap[claim.sot]) {
      logWarn(
        `CLAIM_SKIPPED id=${claim.id} reason=sot_${claim.sot}_not_fetched`,
      );
      claimsSkipped++;
      continue;
    }
    const rawValue = resolveValue(claim, dataMap);
    const formatted = formatValue(rawValue, claim.format);
    if (formatted === null) {
      logWarn(
        `CLAIM_SKIPPED id=${claim.id} reason=value_resolution_failed raw=${JSON.stringify(rawValue)} format=${claim.format}`,
      );
      claimsSkipped++;
      continue;
    }
    claimsResolved++;
    for (const file of claim.apply_to_files) {
      if (!claimsByFile.has(file)) claimsByFile.set(file, []);
      claimsByFile.get(file).push({ claim, value: formatted });
    }
  }
  logInfo(
    `CLAIMS_RESOLVED resolved=${claimsResolved} skipped=${claimsSkipped} total=${manifest.claims.length}`,
  );

  // Apply per file
  let filesTouched = 0;
  let filesUnchanged = 0;
  let totalReplacements = 0;
  let totalClaimMatchesZero = 0;

  for (const [filePath, fileClaims] of claimsByFile) {
    const absPath = pathResolve(REPO_ROOT, filePath);
    let content;
    try {
      content = await readFile(absPath, "utf-8");
    } catch (err) {
      logWarn(`FILE_READ_FAILED path=${filePath} err=${err.message}`);
      continue;
    }
    const original = content;
    let perFileReplacements = 0;
    for (const { claim, value } of fileClaims) {
      const { newContent, count } = applyClaimToContent(content, claim, value);
      if (count === 0) {
        logDebug(
          `CLAIM_MATCHED_ZERO file=${filePath} id=${claim.id} pattern=${claim.find_pattern}`,
        );
        totalClaimMatchesZero++;
      }
      content = newContent;
      perFileReplacements += count;
    }
    if (content === original) {
      logDebug(`FILE_UNCHANGED path=${filePath}`);
      filesUnchanged++;
      continue;
    }
    if (DRY_RUN) {
      logInfo(
        `DRY_RUN_WOULD_WRITE path=${filePath} replacements=${perFileReplacements}`,
      );
    } else {
      try {
        await writeFile(absPath, content, "utf-8");
        logInfo(
          `FILE_WRITTEN path=${filePath} replacements=${perFileReplacements}`,
        );
      } catch (err) {
        logError(`FILE_WRITE_FAILED path=${filePath} err=${err.message}`);
        continue;
      }
    }
    filesTouched++;
    totalReplacements += perFileReplacements;
  }

  // Catastrophic-failure escalation: if >=50% of resolved claims matched zero across all their files, exit 1
  const totalClaimApplications = Array.from(claimsByFile.values()).reduce(
    (sum, claims) => sum + claims.length,
    0,
  );
  const matchedClaimApplications = totalClaimApplications - totalClaimMatchesZero;
  const elapsedMs = Date.now() - startTime;

  if (
    totalClaimApplications > 0 &&
    matchedClaimApplications < totalClaimApplications / 2
  ) {
    logError(
      `CATASTROPHIC_PATTERN_DRIFT matched=${matchedClaimApplications} total=${totalClaimApplications} elapsed_ms=${elapsedMs}`,
    );
    logError(
      `>50% of claim applications matched zero literals. Manifest likely out of sync with landing/* shapes. EXIT_CODE=1`,
    );
    process.exit(1);
  }

  logInfo(
    `END mode=${mode} files_touched=${filesTouched} files_unchanged=${filesUnchanged} total_replacements=${totalReplacements} elapsed_ms=${elapsedMs}`,
  );
  if (CHECK) {
    // filesTouched under --check counts files that WOULD have been written.
    if (filesTouched > 0) {
      logWarn(
        `CHECK_DRIFT files_would_change=${filesTouched} replacements=${totalReplacements} — the baked literals are STALE vs the live SoT; a run is due. EXIT_CODE=1`,
      );
      process.exit(1);
    }
    logInfo(`CHECK_CLEAN files_unchanged=${filesUnchanged} — every managed literal already matches the SoT`);
  }
  process.exit(0);
}

main().catch((err) => {
  logError(`UNHANDLED_EXCEPTION: ${err.stack || err.message || err}`);
  process.exit(0); // fail-open per contract
});
