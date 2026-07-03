#!/usr/bin/env bash
# check_mobile_nav_parity.sh — CI parity canary (mobile-nav-header wave).
#
# Invariant: every landing page that ships the DESKTOP nav-links container
#   (`hidden sm:flex items-center gap-6`) MUST also ship the mobile-nav
#   equivalent — a `data-mobile-nav-toggle` hamburger AND a `#mobile-menu`
#   (a.k.a. `data-mobile-nav-panel`) slide-down panel. This makes "shipped a
#   desktop nav without a mobile replacement" structurally impossible for any
#   FUTURE landing page: the check fails the build.
#
# Scope: RECURSIVE over landing/**/*.html — includes landing/integrations/*.html
#   (the exchange integration subpages carry the identical nav).
#
# Exit 0 = clean; exit 1 = ≥1 page has the desktop nav but no mobile nav.
#
# Standalone run:  bash scripts/check_mobile_nav_parity.sh
# Pre-commit-hook candidate: wire into scripts/install_*_hook.sh alongside the
#   system-map gate; the shared .git/hooks path governs every worktree, so it
#   installs once. Keep it fail-CLOSED here (build gate); a warn-only override
#   can be added if ever needed, mirroring ALGOVAULT_TEST_GATE=warn.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANDING="$ROOT/landing"
DESKTOP_SIG='hidden sm:flex items-center gap-6'
TOGGLE_SIG='data-mobile-nav-toggle'
PANEL_SIG_A='id="mobile-menu"'
PANEL_SIG_B='data-mobile-nav-panel'

if [ ! -d "$LANDING" ]; then
  echo "✗ landing/ not found at $LANDING" >&2
  exit 1
fi

fail=0
offenders=()

while IFS= read -r f; do
  # Only pages that actually ship the desktop nav are in scope.
  if grep -qaF "$DESKTOP_SIG" "$f"; then
    has_toggle=0
    has_panel=0
    if grep -qaF "$TOGGLE_SIG" "$f"; then has_toggle=1; fi
    if grep -qaF "$PANEL_SIG_A" "$f" || grep -qaF "$PANEL_SIG_B" "$f"; then has_panel=1; fi
    if [ "$has_toggle" -ne 1 ] || [ "$has_panel" -ne 1 ]; then
      miss=""
      [ "$has_toggle" -ne 1 ] && miss="${miss} [missing hamburger: ${TOGGLE_SIG}]"
      [ "$has_panel" -ne 1 ] && miss="${miss} [missing panel: ${PANEL_SIG_A} | ${PANEL_SIG_B}]"
      offenders+=("${f#"$ROOT"/} —${miss}")
      fail=1
    fi
  fi
done < <(find "$LANDING" -type f -name '*.html' | sort)

if [ "$fail" -ne 0 ]; then
  echo "✗ mobile-nav parity FAILED — desktop nav present, mobile nav missing:" >&2
  for o in "${offenders[@]}"; do echo "  - $o" >&2; done
  echo "" >&2
  echo "Fix: add the hamburger <button data-mobile-nav-toggle …> inside the nav's" >&2
  echo "     justify-between row + the <div id=\"mobile-menu\" data-mobile-nav-panel …>" >&2
  echo "     panel as the last child of <nav> + the shared controller <script> IIFE." >&2
  exit 1
fi

echo "✓ mobile-nav parity OK — every landing page with the desktop nav ships a mobile nav."
