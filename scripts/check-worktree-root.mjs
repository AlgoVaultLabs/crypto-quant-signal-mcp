#!/usr/bin/env node
// check-worktree-root.mjs — the 7th guarded pre-push block.
// OPS-WORKTREE-ROOT-CONFINEMENT-W2 CH2 (R2d/R2e/R2f).
//
// ─── WHAT THIS GUARDS ──────────────────────────────────────────────────────────────────────
// Worktree placement was the last EMERGENT shared resource on this machine. It is CWD-derived
// and tool-version-dependent: three distinct placements were measured inside one 24h window
// (`~/code`, `<repo>/.claude/worktrees`, `~/code/.worktrees`), and the generator produced two
// fresh violations while the fix for it was being planned. A convention that mutable cannot be
// documented — only DECLARED, in a file the tooling reads.
//
// TWO INDEPENDENT ASSERTIONS, ONE TOKEN, COUNTED SEPARATELY:
//   R1 CONFINEMENT — every worktree lives under the declared worktree_root
//   R2 NON-NESTING — no worktree lives inside any primary's or any other worktree's tree
// They are separate because they clear on different timelines: R2 reaches zero in CH4/CH6,
// R1 has a long tail. One shared criterion would hold the stricter assertion hostage.
// R2 is not a subset of R1: `<repo>/.claude/worktrees/x` is *under* ~/code yet nested, which
// is the exact shape behind the vitest-discovery pathology (1779 discovered files vs 298 real).
//
// ─── WHY IT ENUMERATES, NEVER SCANS NAMES ──────────────────────────────────────────────────
// `git worktree list --porcelain` per structurally-discovered primary is authoritative. A
// directory NAME is not a worktree (4 orphans on this machine carry a `.git` file and appear
// in no list), and a worktree is not always a recognisable name. Both directions are wrong.
//
// ─── MODE ──────────────────────────────────────────────────────────────────────────────────
// Ships `report`: violations are counted and printed, the verdict stays PASS. Promotion to
// blocking carries BOTH a count and a date, per assertion, in the SoT — a criterion with no
// time bound can never fire if the population does not heal on its own.
//
// ALGOVAULT_WORKTREE_ROOT_GATE=warn downgrades the EXIT CODE, never the TOKEN.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(SELF, "..", "ops", "shared-worktree-state.json");
const TOKEN = "WORKTREE_ROOT_VERDICT";
const PASS = "PASS", FAIL = "FAIL", INDET = "INDETERMINATE";
// INDETERMINATE = 3: the token-law default for a NEW gate. check_test_baseline.sh uses 2 only
// because it already deployed 2; that divergence is deliberate and must not be "aligned".
const CODE = { [PASS]: 0, [FAIL]: 1, [INDET]: 3 };

// ─── R2f: the parser is a PURE FUNCTION, exported and fixture-tested ───────────────────────
// A hermetic self-test is structurally blind to exactly what its seam replaces. The seam here
// is `git worktree list --porcelain`, so the parser is extracted and driven by real fixtures:
// a path containing a SPACE (this machine has `My Drive`) and an entry whose path does not
// exist on disk (the live stale-admin shape — 5 of them). Both are real, neither is hypothetical.
export function parsePorcelain(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length), branch: null, locked: false, detached: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.detached = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      cur.locked = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// `a` is inside `b`'s tree — strict prefix on a PATH BOUNDARY. A bare startsWith would make
// `…-wt-carry-digest` a child of `…-wt-carry`, which is the prefix-vs-exact bug that R2a's
// "strict set membership" rule exists to prevent.
export function isInside(a, b) {
  return a !== b && a.startsWith(b.endsWith("/") ? b : b + "/");
}

// ─── R2d: evaluation is PURE — every input passed in, nothing read from disk ───────────────
export function evaluate({ primaries, worktrees, config, today, fixture = false }) {
  const problems = [];   // INDETERMINATE-class: we cannot meaningfully check
  const positives = [];  // AC2: positive per-row output, never absence-of-alert

  const wr = config && config.worktree_roots;
  if (!wr) return { verdict: INDET, problems: ["config has no worktree_roots block"], positives, r1: [], r2: [], r3: [] };

  // Vacuity — we author the config, so an empty declaration is OUR defect, never a pass.
  if (!wr.worktree_root) problems.push("config declares no worktree_root");
  const assertions = wr.assertions || {};
  if (!Object.keys(assertions).length) problems.push("config declares zero assertions");

  // Vacuity — in --self-test WE build the corpus, so empty means the test built nothing.
  // At runtime the WORLD builds it, so empty is a FACT and the correct verdict is PASS with an
  // explicit positive line. Empty-vs-unparseable is the line, not empty-vs-non-empty.
  if (fixture && !primaries.length) problems.push("self-test corpus is empty — the test built nothing");

  const root = wr.worktree_root || "";
  const exempt = new Map();
  for (const e of wr.exempt_paths || []) {
    if (typeof e.path !== "string" || !e.path.startsWith("/")) {
      // A tilde or relative row matches nothing resolved from --porcelain: an exemption that
      // silently does not exist. Never a skip.
      problems.push(`exempt_paths entry is not an absolute path: ${JSON.stringify(e.path)}`);
      continue;
    }
    exempt.set(e.path, e);
  }

  const allPaths = new Set([...primaries, ...worktrees.map((w) => w.path)]);
  const r1 = [], r2 = [], r3 = [];
  const shape = new RegExp("^" + root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/[^/]+/[^/]+$");

  for (const w of worktrees) {
    const isExempt = exempt.has(w.path);
    const expired = isExempt && exempt.get(w.path).expires && exempt.get(w.path).expires !== "never"
                    && exempt.get(w.path).expires < today;
    if (expired) problems.push(`exemption EXPIRED ${exempt.get(w.path).expires}: ${w.path}`);
    // An exempt path is EXCLUDED from the violation count, not counted-then-forgiven, so the
    // "violations = 0" and "the exempted set and no more" acceptance criteria cannot contradict.
    if (isExempt && !expired) continue;
    if (!w.path.startsWith(root + "/")) r1.push(w.path);
    const host = [...allPaths].find((q) => isInside(w.path, q));
    if (host) r2.push(`${w.path}  (inside ${host})`);
    if (!shape.test(w.path)) r3.push(w.path);
  }

  // F7: an exemption whose path no longer exists is a silent no-op. REPORT it — never FAIL,
  // because a legitimately-deleted worktree leaves a stale row and blocking wedges the guard.
  const stale = [...exempt.values()].filter((e) => !fixture && !fs.existsSync(e.path));
  for (const e of stale) positives.push(`stale exemption (path absent) ${e.path} owner=${e.owner_wave} expires=${e.expires}`);

  for (const p of primaries) {
    const n = worktrees.filter((w) => w.primary === p).length;
    // A primary with zero worktrees is the world's fact, not our omission: PASS, said out loud.
    if (n === 0) positives.push(`primary has zero worktrees (a fact, not a gap): ${p}`);
  }

  const verdict = problems.length ? INDET : PASS;  // mode=report: violations never FAIL
  return { verdict, problems, positives, r1, r2, r3, exemptCount: exempt.size, staleExempt: stale.length };
}

// ─── live collection ───────────────────────────────────────────────────────────────────────
function discoverPrimaries() {
  const HOME = os.homedir();
  const prune = ["Library", "My Drive", "Google Drive", ".Trash", ".cache"];
  const args = [HOME];
  for (const d of prune) args.push("-path", path.join(HOME, d), "-prune", "-o");
  args.push("-name", "node_modules", "-prune", "-o",
            "-maxdepth", "4", "-name", ".git", "-type", "d", "-print");
  let out = "";
  try { out = execFileSync("find", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) { out = e.stdout ? String(e.stdout) : ""; }   // find exits non-zero on any unreadable dir
  return [...new Set(out.split("\n").filter((l) => l.endsWith("/.git")).map((l) => l.slice(0, -5)))].sort();
}

function collectWorktrees(primaries) {
  const rows = [];
  for (const p of primaries) {
    let out = "";
    try {
      out = execFileSync("git", ["-c", "safe.directory=*", "-C", p, "worktree", "list", "--porcelain"],
                         { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch { continue; }
    for (const w of parsePorcelain(out)) if (w.path !== p) rows.push({ ...w, primary: p });
  }
  return rows;
}

function emit(verdict, lines, warnMode) {
  for (const l of lines) console.log(l);
  console.log(`${TOKEN}=${verdict}`);      // exactly one terminal token, always
  const code = CODE[verdict];
  if (warnMode && code !== 0) {
    console.log(`[worktree-root] ALGOVAULT_WORKTREE_ROOT_GATE=warn — exit code downgraded ${code}->0; the token above is unchanged.`);
    process.exit(0);
  }
  process.exit(code);
}

// ─── R2e: two-way self-test, vacuity-guarded, provable ─────────────────────────────────────
const CFG = (over = {}) => ({ worktree_roots: {
  worktree_root: "/r/.worktrees",
  assertions: { R1_confinement: { mode: "report" }, R2_nesting: { mode: "report" } },
  exempt_paths: [], ...over } });
const WT = (p, primary = "/r/repo") => ({ path: p, primary, branch: "b", locked: false, detached: false });

function selfTest() {
  const T = "2026-08-09";
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  SELF-TEST FAIL: ${name}`); } };
  const ev = (o) => evaluate({ today: T, fixture: true, ...o });

  // ---- must-fire (a violation is DETECTED and counted; mode=report keeps the verdict PASS)
  const outside = ev({ primaries: ["/r/repo"], worktrees: [WT("/elsewhere/w")], config: CFG() });
  check("must-fire: worktree outside the root -> R1", outside.r1.length === 1);
  const inPrim = ev({ primaries: ["/r/repo"], worktrees: [WT("/r/repo/.claude/worktrees/x")], config: CFG() });
  check("must-fire: nested inside a PRIMARY's tree -> R2", inPrim.r2.length === 1);
  const inWt = ev({ primaries: ["/r/repo"], worktrees: [WT("/r/.worktrees/a"), WT("/r/.worktrees/a/inner")], config: CFG() });
  check("must-fire: nested inside another WORKTREE's tree -> R2", inWt.r2.length === 1);
  const expired = ev({ primaries: ["/r/repo"], worktrees: [WT("/elsewhere/w")],
    config: CFG({ exempt_paths: [{ path: "/elsewhere/w", expires: "2020-01-01", reason: "old" }] }) });
  check("must-fire: expired exemption -> INDETERMINATE", expired.verdict === INDET);
  check("must-fire: expired exemption is NOT silently honoured", expired.r1.length === 1);
  const noAssert = ev({ primaries: ["/r/repo"], worktrees: [WT("/r/.worktrees/repo/t")], config: CFG({ assertions: {} }) });
  check("must-fire: config with zero assertions -> INDETERMINATE", noAssert.verdict === INDET);
  const tilde = ev({ primaries: ["/r/repo"], worktrees: [WT("/r/.worktrees/repo/t")],
    config: CFG({ exempt_paths: [{ path: "~/x", reason: "tilde" }] }) });
  check("must-fire: non-absolute exemption -> INDETERMINATE", tilde.verdict === INDET);
  check("must-fire: EMPTY self-test corpus refuses (we built it)",
        ev({ primaries: [], worktrees: [], config: CFG() }).verdict === INDET);

  // ---- must-not-fire
  const good = ev({ primaries: ["/r/repo"], worktrees: [WT("/r/.worktrees/repo/t")], config: CFG() });
  check("must-not-fire: worktree at the declared destination", good.r1.length === 0 && good.r2.length === 0 && good.verdict === PASS);
  check("must-not-fire: and it matches the R3 shape", good.r3.length === 0);
  const unexpired = ev({ primaries: ["/r/repo"], worktrees: [WT("/elsewhere/w")],
    config: CFG({ exempt_paths: [{ path: "/elsewhere/w", expires: "2099-01-01", reason: "ok" }] }) });
  check("must-not-fire: unexpired exemption excluded from R1", unexpired.r1.length === 0 && unexpired.verdict === PASS);
  const empty = ev({ primaries: ["/r/repo"], worktrees: [], config: CFG() });
  check("must-not-fire: a primary with zero worktrees PASSES", empty.verdict === PASS);
  check("...and says so with a positive line, never silence", empty.positives.some((l) => l.includes("zero worktrees")));

  // ---- must-map: token -> exit code
  check("must-map: PASS->0", CODE[PASS] === 0);
  check("must-map: FAIL->1", CODE[FAIL] === 1);
  check("must-map: INDETERMINATE->3", CODE[INDET] === 3);

  // ---- R2f: the BYPASSED artefact. The seam the fixtures replace is the porcelain parser.
  const fixture = [
    "worktree /Users/tank/My Drive/space path/wt", "HEAD abc", "branch refs/heads/spaced", "",
    "worktree /Users/tank/algovault-bot-wt-scan-rankby", "HEAD def", "branch refs/heads/gone", "",
    "worktree /Users/tank/autonomous-optimizer-wt-bdir25", "HEAD 123", "branch refs/heads/d", "locked holds data", "",
    "worktree /r/detached", "HEAD 999", "detached", "",
  ].join("\n");
  const parsed = parsePorcelain(fixture);
  check("R2f: parser reads 4 entries", parsed.length === 4);
  check("R2f: a path containing a SPACE survives", parsed[0].path === "/Users/tank/My Drive/space path/wt");
  check("R2f: an entry whose path does not exist still parses", parsed[1].path.endsWith("scan-rankby"));
  check("R2f: `locked` with a reason is detected", parsed[2].locked === true);
  check("R2f: `detached` carries no branch", parsed[3].detached === true && parsed[3].branch === null);
  check("R2f: boundary-safe nesting — -wt-carry-digest is NOT inside -wt-carry",
        isInside("/a/x-wt-carry-digest", "/a/x-wt-carry") === false);
  check("R2f: real nesting still detected", isInside("/a/x/inner", "/a/x") === true);

  // ---- PROVE THE SUITE CAN FAIL. Not ceremony: it has caught a self-test that asserted tokens
  // but never the token->code mapping, and a fixture that made every assertion vacuous.
  if (process.env.ALGOVAULT_WORKTREE_ROOT_PROVE === "1") {
    const brokenNesting = isInside("/a/x-wt-carry-digest", "/a/x-wt-carry") === true;
    const brokenR1 = ev({ primaries: ["/r/repo"], worktrees: [WT("/elsewhere/w")], config: CFG() }).r1.length === 0;
    console.log(`  PROVE: deliberately-inverted assertions report failure = ${!brokenNesting && !brokenR1}`);
    console.log(`  PROVE: (if either flipped true, the suite would be asserting nothing)`);
  }

  console.log(`  self-test: ${pass} passed, ${fail} failed.`);
  return fail === 0;
}

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────
// Guarded so the module is TEST-IMPORTABLE. Without this, importing `parsePorcelain` runs
// `--check` and calls process.exit during collection — the suite dies before a single test
// runs. Same law as `if (require.main === module)` for CJS entrypoints; the ESM spelling is a
// comparison against argv[1]. Caught by the unit tests on their first run, which is the point
// of having them exercise the real module rather than a copy of its logic.
const IS_MAIN = process.argv[1] &&
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);

function main() {
const warnMode = process.env.ALGOVAULT_WORKTREE_ROOT_GATE === "warn";
const mode = process.argv[2] || "--check";

if (mode === "--self-test") {
  const ok = selfTest();
  emit(ok ? PASS : FAIL, [], warnMode);
} else if (mode === "--check") {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));   // handed to us; unparseable = INDETERMINATE
  } catch (e) {
    emit(INDET, [`[worktree-root] cannot read/parse ${CONFIG}: ${e.message}`], warnMode);
  }
  const today = new Date().toISOString().slice(0, 10);
  const primaries = discoverPrimaries();
  const worktrees = collectWorktrees(primaries);
  const r = evaluate({ primaries, worktrees, config, today, fixture: false });
  const lines = [
    `[worktree-root] primaries=${primaries.length} worktrees=${worktrees.length} exempt_rows=${r.exemptCount ?? 0}`,
    `[worktree-root] root=${config.worktree_roots?.worktree_root}`,
    `R1_violations=${r.r1.length}`,
    `R2_violations=${r.r2.length}`,
    `R3_shape_violations=${r.r3?.length ?? 0}`,
  ];
  for (const p of r.positives) lines.push(`  [report] ${p}`);
  for (const v of r.r1.slice(0, 12)) lines.push(`  R1 outside root: ${v}`);
  if (r.r1.length > 12) lines.push(`  R1 … ${r.r1.length - 12} more (not truncated silently: full count above)`);
  for (const v of r.r2) lines.push(`  R2 nested: ${v}`);
  for (const p of r.problems) lines.push(`  PROBLEM: ${p}`);
  lines.push(`[worktree-root] mode=report — violations are counted, not blocked. Promotion carries a count AND a date, per assertion, in ${path.basename(CONFIG)}.`);
  emit(r.verdict, lines, warnMode);
} else {
  emit(INDET, [`[worktree-root] unknown mode ${mode} (expected --check or --self-test)`], warnMode);
}
}

if (IS_MAIN) main();
