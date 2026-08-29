/**
 * get_track_record — DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2.
 *
 * The track record, on the TOOLS channel.
 *
 * WHY A TOOL AT ALL. Three of our tool descriptions cite `performance://signal-performance`
 * as the evidence behind their trust claim. DeepSeek Harness — and every other client that
 * implements a subset of MCP — bridges tools and nothing else; its own README says so
 * verbatim: "Tools are the only bridged MCP capability — Resources and Prompts have no
 * harness consumer mechanism and are deferred." So inside those harnesses the citation is a
 * dead pointer in the one place the moat is supposed to be provable. The generator-level
 * rule this settles: a capability whose value IS the proof it carries must be reachable from
 * the tools channel, because tools are the only capability every client implements.
 *
 * NO SECOND DERIVATION. This module computes NOTHING. It reads the one producer
 * (`getSignalPerformance`) and projects it through the one public formatter
 * (`formatPublicPerformance`) that `performance://signal-performance` and
 * `GET /api/performance-public` also call. Two code paths computing a win rate is how two
 * different win rates ship.
 *
 * WHY THE `include` PARAM. The full aggregate is ~1.1 MB — roughly 300k tokens — because
 * `byExchange` carries a per-asset breakdown for every venue. Returning that from a tool
 * would exceed most context windows in a single call, which is a strange way to serve the
 * harness this tool exists for. So the default is the compact head and the heavy sections
 * are opt-in. `include` widens the SECTIONS returned; it never widens the ROWS disclosed —
 * `byExchange` and `recentSignals` pass the same allow-list whether or not they were asked
 * for by name.
 */
import { getSignalPerformance } from '../resources/signal-performance.js';
import {
  PUBLIC_PERF_SECTIONS,
  formatPublicPerformance,
  resolvePublicPerformanceAllowList,
  type PublicPerfSection,
  type PublicPerformance,
} from '../lib/public-performance-formatter.js';
import { buildPublicCtaBlock, type PublicCtaBlock } from '../lib/public-cta.js';
import { PKG_VERSION } from '../lib/pkg-version.js';

/** The sections a caller may request by name. Re-exported so index.ts builds ONE enum. */
export const TRACK_RECORD_SECTIONS = PUBLIC_PERF_SECTIONS;

export interface TrackRecordResponse extends PublicPerformance {
  _algovault: PublicCtaBlock & {
    tool: 'get_track_record';
    version: string;
    /** Which optional sections this response carries — echoed so the caller need not infer. */
    included_sections: PublicPerfSection[];
    /** The resource serving the identical aggregate, for clients that can read resources. */
    signal_performance: string;
  };
}

/** A refusal. A guard on a live serving path REFUSES; it does not throw. */
export interface TrackRecordRefusal {
  error: string;
  error_code: 'INVALID_INCLUDE' | 'VENUE_BREAKDOWN_UNAVAILABLE';
  message: string;
  allowed_sections: readonly PublicPerfSection[];
  suggested_include: PublicPerfSection[];
}

export interface TrackRecordOutcome {
  payload: TrackRecordResponse | TrackRecordRefusal;
  isError: boolean;
}

const isSection = (s: string): s is PublicPerfSection =>
  (PUBLIC_PERF_SECTIONS as readonly string[]).includes(s);

/**
 * Run the tool.
 *
 * Exported and free of any `server.tool` closure so it is unit-testable and reusable by a
 * future channel — the entrypoint rule in CLAUDE.md's build rules. `index.ts` keeps only the
 * thin shell (license, caller tagging, request log).
 */
export async function runGetTrackRecord(
  params: { include?: readonly string[] } = {},
): Promise<TrackRecordOutcome> {
  // Validated here as well as in the Zod schema, deliberately. The schema protects the MCP
  // path; this protects every direct caller, and it is the assertion a unit test can reach.
  const requested = params.include ?? [];
  const unknown = requested.filter((s) => !isSection(s));
  if (unknown.length > 0) {
    return {
      isError: true,
      payload: {
        error: 'INVALID_INCLUDE',
        error_code: 'INVALID_INCLUDE',
        message:
          `Unknown include section(s): ${unknown.join(', ')}. `
          + `Allowed: ${PUBLIC_PERF_SECTIONS.join(', ')}. Omit include for the compact aggregate.`,
        allowed_sections: PUBLIC_PERF_SECTIONS,
        suggested_include: requested.filter(isSection),
      },
    };
  }
  const include = requested.filter(isSection);

  const [stats, allow] = await Promise.all([
    getSignalPerformance(),
    resolvePublicPerformanceAllowList(),
  ]);

  // Refuse rather than serve a silently-empty breakdown. An empty venue allow-list means the
  // venues table was unreadable or held no promoted rows; either way `byExchange: {}` is
  // indistinguishable from "no venues have signals", and a caller that ASKED for the venue
  // breakdown deserves to know the difference. The compact aggregate is unaffected, so this
  // never refuses a default call.
  if (include.includes('byExchange') && allow.venues.size === 0) {
    return {
      isError: true,
      payload: {
        error: 'VENUE_BREAKDOWN_UNAVAILABLE',
        error_code: 'VENUE_BREAKDOWN_UNAVAILABLE',
        message: allow.degraded
          ? 'The per-venue breakdown is temporarily unavailable (venue registry unreadable). Every other section is unaffected — retry, or call without byExchange.'
          : 'No venues are currently listed for public per-venue reporting. Every other section is unaffected — call without byExchange.',
        allowed_sections: PUBLIC_PERF_SECTIONS,
        suggested_include: include.filter((s) => s !== 'byExchange'),
      },
    };
  }

  const projected = formatPublicPerformance(stats, allow, { include });
  return {
    isError: false,
    payload: {
      ...projected,
      _algovault: {
        ...buildPublicCtaBlock(),
        tool: 'get_track_record',
        version: PKG_VERSION,
        included_sections: include,
        signal_performance: 'performance://signal-performance',
      },
    },
  };
}
