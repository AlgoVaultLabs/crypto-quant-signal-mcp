// OPS-WORKTREE-ROOT-CONFINEMENT-W2 CH2 — unit tests for the 7th pre-push guard.
//
// These pin the BEHAVIOURS, not a hash of the script. The guard's own `--self-test` is
// hermetic and therefore blind to exactly what its seam replaces; these tests cover the two
// pure functions the seam bypasses (`parsePorcelain`, `isInside`) plus the SoT contract the
// guard reads, so a future edit that keeps the file parsing but breaks the meaning goes red.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

  it("both gated assertions ship report-first with a promotion criterion carrying a count AND a date", () => {
    for (const k of ["R1_confinement", "R2_nesting"]) {
      expect(wr.assertions[k].mode).toBe("report");
      expect(wr.assertions[k].promotion.max_violations).toBe(0);
      // A criterion with no time bound can never fire if the population does not heal.
      expect(wr.assertions[k].promotion.not_before).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("R1 and R2 carry SEPARATE promotion dates — one criterion would hold the stricter hostage", () => {
    expect(wr.assertions.R1_confinement.promotion.not_before)
      .not.toBe(wr.assertions.R2_nesting.promotion.not_before);
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
