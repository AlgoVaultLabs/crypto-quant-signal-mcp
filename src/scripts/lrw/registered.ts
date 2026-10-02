// lrw/registered.ts — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3: the identifiers the registration fixes, derived ONCE.
// The relabel writer, the annotation, the read session, the completeness checks, the disagreement table and the
// CH3 gate all import these; none of them takes the value from a flag, so two consumers can never run on two
// different T_CUTs, two different adapter-pending cells or two different worklists. Identifiers and hashes only —
// no figure (the code repo is public).

/** T_CUT (registration §3): the `StartedAt` of the first `crypto-quant-signal-mcp-mcp-server-1` container on the
 *  CH2 generator commit `c553578c` — 2026-09-30T07:54:54.743475Z, recorded in the vault at deploy. `-v1` rows
 *  computed before it are the defective-cache rows the study measures; the relabel's population ends here too
 *  (rows created after it are the fixed nightly's, which writes their `-v2` itself). */
export const T_CUT_EPOCH = 1790754894.743475;

/** The registration's BITGET 2h / 8h cell (§3, E5; ruling LRW-Q10 = B), as AMENDED 2026-10-01 by
 *  OPS-ADAPTER-HISTORY-ANCHOR-W1 (ruling OAH-Q8, appended to the registration in the landing that emptied
 *  ADAPTER_PENDING_CELLS below). Fixed by the registration: a row whose `-v2` row was written at or after
 *  T_ADAPTER is "reached via adapter fix" — its own cell, never pooled with any other; a row whose `-v2` row was
 *  written before T_ADAPTER keeps "unreachable pending OPS-ADAPTER-HISTORY-ANCHOR-W1" and is counted, never
 *  compared. T_ADAPTER is ADS-1's single pin (`src/scripts/ads1/spec.ts`). */
export const ADAPTER_CELL: ReadonlySet<string> = new Set(['BITGET:2h', 'BITGET:8h']);

/** The cells the relabel counts `unreachable:adapter-pending` WITHOUT fetching — "not yet reachable", so the set
 *  SHRINKS when the relabel can reach them (ADS-1 relies on that meaning: `ADAPTER_SPLIT_CELLS` in
 *  src/scripts/ads1/spec.ts is a different, fixed set and is never aliased to this one). EMPTY since T_ADAPTER: the
 *  Bitget history path is anchored on the served grid (`2ee8212d`), so the relabel attempts BITGET 2h / 8h
 *  (registration amendment 2026-10-01, OAH-Q8). */
export const ADAPTER_PENDING_CELLS: ReadonlySet<string> = new Set<string>([]);

/** The sha256 of every off-DB stratum the study joins (registration §3.2; the delta replay's recorded in CH3
 *  before any pull). A file whose hash is not its pin is refused by every reader — the annotation writes once
 *  (NULL only), so an unpinned file's values could never be replaced by the pinned ones. */
export const PINNED_SHA256 = {
  worklist: '58dcff766db9d120aa64b6ef8486fdd9742e304521447f1beced7a67e1df6022',
  crossed: '9b36df47d0abf8429b3055939ba273ad67b0c57c8799f00e0dc5b8022282848e',
  retiredUc: '227fdbd62094ad62a17a6a1e06c9be8bd59d2f36e335bf2d6efc2a7d4a6a4aca',
  delta: 'acc28843ad81187448f29191c13cf788d6cebb0b745e7311cccf923548156c84',
  /** BITGET 2h / 8h `-v2` rows written before T_ADAPTER (`completeness.ts` ADAPTER_V2_BEFORE; a closed set, taken
   *  2026-10-02 read-only, vault `audits/EDGE-LABELER-RACE-WINDOW-V2-W1-ch3/adapter-v2-before-t_adapter.csv`). */
  adapterBefore: 'fee970e828a494e3f386917e84345692568c6303a72104eb7a9c2cea0e71f87e',
} as const;

/** The two files the `race_gap_candles` annotation may write from (ruling LRW-Q3: the canonical replay + the
 *  delta replay), by hash. */
export const ANNOTATION_SOURCE_SHA256: ReadonlySet<string> = new Set([PINNED_SHA256.worklist, PINNED_SHA256.delta]);

/** The manifest classes the registration names (§3, §3.2). Every eligible signal the relabel visits and cannot
 *  write is ONE `LRW_MANIFEST <signal_id> <class>` line with one of these. */
export const MANIFEST_CLASSES = [
  'deferred',
  'refused:short', 'refused:anchor', 'refused:gap',
  'unreachable:depth', 'unreachable:history', 'unreachable:retired', 'unreachable:adapter-pending',
] as const;
export type ManifestClass = (typeof MANIFEST_CLASSES)[number];
