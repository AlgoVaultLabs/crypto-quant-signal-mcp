#!/usr/bin/env bash
# shellcheck shell=bash
# scripts/lib/system-map-path.sh — the ONE definition of WHERE system-map.md lives.
# SYSTEM-MAP-SHAPE-GATE-W1.
#
# ─── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
# Two gates now read the same out-of-repo file for two different properties:
#
#   scripts/check_system_map.sh   FRESHNESS — was the map touched alongside an edge mutation?
#   scripts/check_map_shape.sh    SHAPE     — is the map still a map, or has it become a log?
#
# Two copies of one absolute string can disagree about WHICH file. After a vault move that
# disagreement does not surface as an error: one gate keeps guarding a file nobody edits any
# more and reports PASS forever, which is the dark-guard class this repo has already paid for
# four times. Single-derivation is therefore a correctness property here, not tidiness — compute
# the path ONCE, and let every consumer project from that one value.
#
# ─── WHY IT IS DECLARED RATHER THAN DERIVED ─────────────────────────────────────────────────
# Measured 2026-08-21: the Obsidian vault is NOT a git repository (`git -C "<vault>" rev-parse`
# → `fatal: not a git repository`; no `.git` on the real filesystem, not merely on a restricted
# mount). So this path cannot be derived from git, from a submodule, or from a checkout — it
# must be declared. That is also why `system-map.md` can never be staged in a repo commit, and
# why the sibling gate's "auto-exempt if staged" branch is permanently unreachable.
#
# ─── THE OVERRIDE IS LOAD-BEARING AND PREDATES THIS FILE ────────────────────────────────────
# $SYSTEM_MAP_PATH is how the existing test-suite points the freshness gate at a tmp fixture
# (tests/unit/check-system-map.test.ts). It is preserved EXACTLY, including its precedence, so
# extracting this expression is a pure move: every caller that set it keeps working unchanged.
#
# Sourced, never executed. Defines one variable and nothing else.

ALGOVAULT_SYSTEM_MAP_PATH="${SYSTEM_MAP_PATH:-/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/system-map.md}"
