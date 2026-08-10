// OPS-WORKTREE-ROOT-CONFINEMENT-W2 CH2 — unit tests for the 7th pre-push guard.
//
// These pin the BEHAVIOURS, not a hash of the script. The guard's own `--self-test` is
// hermetic and therefore blind to exactly what its seam replaces; these tests cover the two
// pure functions the seam bypasses (`parsePorcelain`, `isInside`) plus the SoT contract the
// guard reads, so a future edit that keeps the file parsing but breaks the meaning goes red.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
// @ts-expect-error — .mjs guard, exported pure fns; there is no .d.ts and none is wanted here.
import { parsePorcelain, isInside, evaluate } from "../../scripts/check-worktree-root.mjs";

const SOT = path.join(__dirname, "..", "..", "ops", "shared-worktree-state.json");
const sot = JSON.parse(readFileSync(SOT, "utf8"));
const wr = sot.worktree_roots;

describe("worktree_roots SoT contract", () => {
  it("declares one repo root, one worktree root, and a destination template", () => {
    expect(wr.repo_root.path).toBe("/Users/tank/code");
    expect(wr.worktree_root).toBe("/Users/tank/code/.worktrees");
    expect(wr.destination_template).toContain("<repo>/<task>");
  });

  it("every exempt path is ABSOLUTE — a tilde row matches nothing and is an exemption that does not exist", () => {
    for (const e of wr.exempt_paths) expect(e.path.startsWith("/")).toBe(true);
  });

  it("every exemption carries a reason ON THE ROW, never only in prose", () => {
    for (const e of wr.exempt_paths) {
      expect(typeof e.reason).toBe("string");
      expect(e.reason.length).toBeGreaterThan(20);
      expect(e.owner_wave).toBeTruthy();
      expect(e.expires).toBeTruthy();
    }
  });

  // These two tests ENCODED the retired convention, so OPS-WORKTREE-ROOT-R2-PROMOTE-W1 flips
  // them in the same commit that retires it. A criterion and the test that pins it are a pair:
  // leaving either half behind makes the test a lie or half-disables the guard.
  it("a criterion carries a DEADLINE, never a waiting period — `not_before` is banned outright", () => {
    const asJson = JSON.stringify(wr.assertions);
    // Prose may QUOTE the retired key (the history is deliberately kept visible); a KEY may not
    // exist. Walk for the key rather than grepping the serialised blob, or the correction note
    // that explains the ban would itself trip the ban.
    const keys: string[] = [];
    const walk = (o: any) => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { keys.push(k); walk(v); }
    };
    walk(wr.assertions);
    expect(keys).not.toContain("not_before");
    expect(asJson).toContain("not_before");   // ...and the history IS still readable in prose
  });

  it("an UNPROMOTED gated assertion carries max_violations AND a decide_by deadline", () => {
    const p = wr.assertions.R1_confinement.promotion;
    expect(wr.assertions.R1_confinement.mode).toBe("report");
    expect(p.max_violations).toBe(0);
    expect(p.decide_by).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.decide_by_reason).toMatch(/DEADLINE, NOT A DELAY/);
  });

  it("R1 appends its OBSERVED count each run, so the healing RATE is measured not guessed", () => {
    const obs = wr.assertions.R1_confinement.promotion.observed;
    expect(Array.isArray(obs)).toBe(true);
    expect(obs.length).toBeGreaterThanOrEqual(2);
    for (const o of obs) {
      expect(o.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof o.violations).toBe("number");
    }
    // A guard permanently stuck in REPORT is decoration; the series is what makes the deadline
    // decidable. This pins that the series actually MOVES rather than repeating one figure.
    expect(new Set(obs.map((o: any) => o.violations)).size).toBeGreaterThan(1);
  });

  it("a PROMOTED assertion records its evidence and its rollback, not just a mode string", () => {
    const r2 = wr.assertions.R2_nesting;
    expect(r2.mode).toBe("block");
    expect(r2.promoted.observed_violations).toBe(0);
    expect(r2.promoted.blast_radius).toBe(0);
    expect(r2.promoted.rollback).toMatch(/report/);
    // The promotion is only safe because the hook's fail-open no longer lands somewhere R2
    // refuses. Pin that the reasoning is recorded, so a revert of the hook re-reads as unsafe.
    expect(r2.mode_note).toMatch(/_failopen-/);
  });

  it("the payload floor is a declared value with a reason, never a literal in a predicate", () => {
    expect(wr.payload_floor_kb).toBe(1024);
    expect(wr.payload_floor_reason).toMatch(/above observed noise/);
    // The band exists because 15x below the smallest real payload is tighter than it looks.
    expect(wr.payload_report_band_kb.from).toBe(wr.payload_floor_kb);
    expect(wr.payload_report_band_kb.to).toBeGreaterThan(wr.payload_floor_kb);
  });
});

describe("parsePorcelain — the seam the hermetic self-test replaces", () => {
  it("keeps a path containing a space intact", () => {
    const r = parsePorcelain("worktree /Users/tank/My Drive/a b/wt\nHEAD x\nbranch refs/heads/z\n");
    expect(r[0].path).toBe("/Users/tank/My Drive/a b/wt");
    expect(r[0].branch).toBe("z");
  });

  it("parses an entry whose path does not exist on disk — the live stale-admin shape", () => {
    const r = parsePorcelain("worktree /gone/wt\nHEAD x\nbranch refs/heads/b\n");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("/gone/wt");
  });

  it("detects `locked` with and without a reason", () => {
    expect(parsePorcelain("worktree /a\nlocked\n")[0].locked).toBe(true);
    expect(parsePorcelain("worktree /a\nlocked holds a dataset\n")[0].locked).toBe(true);
  });

  it("a detached worktree has no branch and is still a row", () => {
    const r = parsePorcelain("worktree /a\nHEAD x\ndetached\n");
    expect(r[0].detached).toBe(true);
    expect(r[0].branch).toBeNull();
  });

  it("ignores leading noise rather than attributing it to a phantom worktree", () => {
    expect(parsePorcelain("HEAD orphaned\nbranch refs/heads/x\n")).toHaveLength(0);
  });
});

describe("isInside — path-boundary containment, not startsWith", () => {
  it("a sibling with a longer name is NOT inside", () => {
    // The prefix-vs-exact bug: `-wt-carry-digest` is not a child of `-wt-carry`.
    expect(isInside("/a/x-wt-carry-digest", "/a/x-wt-carry")).toBe(false);
  });
  it("a real child IS inside", () => expect(isInside("/a/x/inner", "/a/x")).toBe(true));
  it("a path is not inside itself", () => expect(isInside("/a/x", "/a/x")).toBe(false));
});

describe("evaluate — R1 and R2 are independent, and exemptions are excluded not forgiven", () => {
  const CFG = (over: Record<string, unknown> = {}) => ({
    worktree_roots: {
      worktree_root: "/r/.worktrees",
      assertions: { R1_confinement: { mode: "report" }, R2_nesting: { mode: "report" } },
      exempt_paths: [], ...over,
    },
  });
  const wt = (p: string) => ({ path: p, primary: "/r/repo", branch: "b", locked: false, detached: false });
  const ev = (o: Record<string, unknown>) =>
    evaluate({ primaries: ["/r/repo"], today: "2026-08-09", fixture: true, config: CFG(), ...o });

  it("R2 is not a subset of R1 — a nested worktree UNDER the root still violates R2", () => {
    const r = ev({ worktrees: [wt("/r/.worktrees/a"), wt("/r/.worktrees/a/inner")] });
    expect(r.r1).toHaveLength(0);
    expect(r.r2).toHaveLength(1);
  });

  it("an unexpired exemption is EXCLUDED from the count, so 'violations=0' and 'exactly the exempted set' agree", () => {
    const r = ev({ worktrees: [wt("/elsewhere/w")],
      config: CFG({ exempt_paths: [{ path: "/elsewhere/w", expires: "2099-01-01", reason: "x" }] }) });
    expect(r.r1).toHaveLength(0);
    expect(r.verdict).toBe("PASS");
  });

  it("an EXPIRED exemption stops excluding and is reported — never silently honoured forever", () => {
    const r = ev({ worktrees: [wt("/elsewhere/w")],
      config: CFG({ exempt_paths: [{ path: "/elsewhere/w", expires: "2020-01-01", reason: "x" }] }) });
    expect(r.r1).toHaveLength(1);
    expect(r.verdict).toBe("INDETERMINATE");
  });

  it("an empty self-test corpus REFUSES — we build it, so empty means the test built nothing", () => {
    expect(ev({ primaries: [], worktrees: [] }).verdict).toBe("INDETERMINATE");
  });

  it("a runtime primary with zero worktrees PASSES and says so — the world built that corpus", () => {
    const r = evaluate({ primaries: ["/r/repo"], worktrees: [], config: CFG(), today: "2026-08-09", fixture: false });
    expect(r.verdict).toBe("PASS");
    expect(r.positives.some((l: string) => l.includes("zero worktrees"))).toBe(true);
  });

  it("a config with zero assertions REFUSES — we author the config", () => {
    expect(ev({ worktrees: [wt("/r/.worktrees/repo/t")], config: CFG({ assertions: {} }) }).verdict)
      .toBe("INDETERMINATE");
  });
});

// ─── OPS-WORKTREE-ROOT-R2-PROMOTE-W1 ───────────────────────────────────────────────────────
describe("fail-open must not manufacture the condition the guard blocks on", () => {
  const HOOK = path.join(__dirname, "..", "..", "scripts", "worktree-create-hook.sh");
  const hook = readFileSync(HOOK, "utf8");

  // THE DRIFT CATCHER. The hook's literal is a CACHE; the SoT stays canonical. A fallback for
  // "cannot read the SoT" cannot live in the SoT, so the duplication is forced — but it is
  // caught HERE, at test time, instead of at fail-open time, which is the one moment nobody
  // is watching.
  it("HOOK_FAILOPEN_ROOT_LITERAL equals worktree_roots.worktree_root", () => {
    const m = hook.match(/^HOOK_FAILOPEN_ROOT_LITERAL="([^"]*)"/m);
    expect(m, "the literal must exist and be a plain assignment this test can read").toBeTruthy();
    expect(m![1]).toBe(wr.worktree_root);
  });

  it("the literal is absolute — a relative fallback resolves against an unknown cwd", () => {
    const m = hook.match(/^HOOK_FAILOPEN_ROOT_LITERAL="([^"]*)"/m);
    expect(m![1].startsWith("/")).toBe(true);
  });

  it("fail-open places under the declared root with the greppable _failopen- prefix", () => {
    expect(hook).toMatch(/_failopen-/);
    // The prefix separates "the hook degraded" from "someone bypassed the tool entirely" —
    // different problems, different fixes, and indistinguishable without it.
    expect(hook).toMatch(/\$froot\/\$\(basename "\$root"\)\/_failopen-\$name/);
  });

  it("the tool default survives ONLY as the declared last resort, and it LOGS", () => {
    const defaults = hook.split("\n").filter((l) => l.includes(".claude/worktrees/") && !l.trimStart().startsWith("#"));
    expect(defaults.length, "exactly one non-comment occurrence: the last resort").toBe(1);
    expect(hook).toMatch(/FAILOPEN_UNPLACED/);
    // It must say WHY a later push will be refused, or the operator meets an unexplained block.
    expect(hook).toMatch(/FAILOPEN_UNPLACED.*R2 nesting violation/s);
  });

  it("fail-open still exits 0 and still prints exactly one path", () => {
    // It changes WHERE it lands, never WHETHER it succeeds: a session that cannot create a
    // worktree is a worse outcome than one placed imperfectly.
    expect(hook).toMatch(/emit_path "\$def"/);
    expect(hook).toMatch(/emit_path\(\)\s*\{\s*printf '%s\\n' "\$1"; exit 0; \}/);
  });
});

describe("AC8 — every pre-push block is ENUMERATED from the live hook, never counted in prose", () => {
  // Build Rule 13: a safety property is a set relation, never a literal count. An AC that
  // hardcodes "7 blocks" goes stale the moment an 8th ships — which is exactly what happened.
  let hookPath = "";
  try {
    const top = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" }).trim();
    const configured = execFileSync("git", ["config", "--get", "core.hooksPath"],
      { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" }).trim();
    hookPath = path.join(configured || path.join(top, "hooks"), "pre-push");
  } catch { hookPath = ""; }

  const present = hookPath !== "" && existsSync(hookPath);

  // Absent is a FACT, not vacuity: CI has no local hook installed, and we did not build that
  // corpus. Report it; never fail on it.
  it.skipIf(!present)("each enumerated block declares a verdict token — zero silent blocks", () => {
    const src = readFileSync(hookPath, "utf8");
    const opens = [...src.matchAll(/^# >>> algovault ([a-z-]+)/gm)].map((m) => m[1]);
    const closes = [...src.matchAll(/^# <<< algovault ([a-z-]+)/gm)].map((m) => m[1]);
    expect(opens.length, "vacuity: a hook with zero blocks means the enumeration is broken").toBeGreaterThan(0);
    expect(closes).toEqual(opens);                       // every block is closed, in order
    for (const name of opens) {
      const body = src.split(`# >>> algovault ${name}`)[1].split(`# <<< algovault ${name}`)[0];
      // A block is NOT silent if it either prints a token itself or delegates to a checker that
      // does. Asserting the token string appears in the hook TEXT was wrong: every block here
      // delegates, and the token is emitted by the script it runs. Corrected to the property
      // that actually distinguishes a live block from a silent one.
      expect(body, `block '${name}' neither emits a token nor invokes a checker — a silent block`)
        .toMatch(/_VERDICT|VERDICT=|scripts\/[A-Za-z0-9_.-]+\.(mjs|sh)/);
    }
  });

  it.skipIf(present)("reports plainly when no hook is installed (CI), rather than passing silently", () => {
    expect(present).toBe(false);
  });
});
