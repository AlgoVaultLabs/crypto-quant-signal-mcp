/**
 * rail-served-state.ts — OPS-A2MCP-SERVED-TRUTH-W1 CH1 R1.
 *
 * ONE runtime record, per paid rail, of what its MOUNT actually reported — served or dark —
 * as opposed to what its env predicate says it should be. Ruling R-1: "Env predicates decide
 * mounts; mounts decide everything downstream."
 *
 * WHY THIS EXISTS. The okx.ai A2MCP rail answered 404 on every `/a2mcp/<tool>` route for weeks
 * (boot log: `OKX getSupported failed: 401` → `LIVE mount failed — leaving a2mcp DARK`) while
 * `OKX_AI_ENABLED=true` and all four creds were set. Every consumer that asked the ENV whether
 * the rail was live got "yes": the quota-edge x402 nudge kept offering
 * `https://api.algovault.com/a2mcp/<tool>` to walled callers as `alternatives[0]` — a URL that
 * 404s. The mount knew, logged one line, and nothing downstream could read it.
 *
 * CONTRACT
 *   - `markServed(rail, detail)` / `markDark(rail, reason)` are called by the code that OWNS each
 *     mount (`mountOkxA2mcpRoutes`, `index.ts` for `mountX402HttpRoutes`, `startAcpSellerWorker`)
 *     at each outcome it already has. Nothing else writes here.
 *   - `servedState()` is the read side. A rail no mount has reported is `unreported`, and a
 *     consumer treats that exactly like `dark`: the safe default is "not served". A process that
 *     never mounts a rail (stdio transport, a test) therefore never advertises it.
 *   - One log line per TRANSITION — `[rail-served-state] <rail>=served|dark reason=…` — so the
 *     boot log carries the outcome in a greppable form and a repeated identical mark is silent.
 *
 * LEAF MODULE: no SDK import, no env read, no I/O beyond the transition log line. A type-only
 * import ties the rail names to the registry's channel keys, so renaming a channel breaks compile.
 */
import type { FeatureSpec } from './feature-registry.js';

/** The paid HTTP/agent rails, typed from the registry's channel keys. */
export type PaidRail = Extract<keyof FeatureSpec['channels'], 'httpX402' | 'a2mcp' | 'acp'>;

export const PAID_RAILS: readonly PaidRail[] = ['httpX402', 'a2mcp', 'acp'];

export type RailServedStatus = 'served' | 'dark' | 'unreported';

export interface RailServedEntry {
  status: RailServedStatus;
  /** Mount mode when served (e.g. `live` / `stub` / `cdp`); absent otherwise. */
  mode?: string;
  /** Why it is dark, or a short description of what was served. */
  reason: string;
  /** ISO time of the last transition (null while unreported). */
  since: string | null;
}

export type RailServedState = Readonly<Record<PaidRail, Readonly<RailServedEntry>>>;

export interface ServedDetail {
  mode?: string;
  routes?: number;
}

function unreported(): RailServedEntry {
  return { status: 'unreported', reason: 'no mount has reported', since: null };
}

/** Every paid rail, unreported — the record is built FROM `PAID_RAILS`, so the list cannot drift from it. */
function freshState(): Record<PaidRail, RailServedEntry> {
  return Object.fromEntries(PAID_RAILS.map((r) => [r, unreported()])) as Record<PaidRail, RailServedEntry>;
}

let state: Record<PaidRail, RailServedEntry> = freshState();

/** Replace the entry; log one line only when status or mode actually changed. */
function transition(rail: PaidRail, next: RailServedEntry): void {
  const prev = state[rail];
  const changed = prev.status !== next.status || prev.mode !== next.mode;
  state = { ...state, [rail]: next };
  if (changed) {
    console.log(`[rail-served-state] ${rail}=${next.status} reason=${next.reason}`);
  }
}

function describeServed(detail: ServedDetail | undefined): string {
  const parts = ['mounted'];
  if (detail?.mode) parts.push(`mode=${detail.mode}`);
  if (detail?.routes !== undefined) parts.push(`routes=${detail.routes}`);
  return parts.join(' ');
}

/** The rail's mount reported it SERVED. */
export function markServed(rail: PaidRail, detail?: ServedDetail): void {
  transition(rail, {
    status: 'served',
    ...(detail?.mode ? { mode: detail.mode } : {}),
    reason: describeServed(detail),
    since: new Date().toISOString(),
  });
}

/** The rail's mount reported it DARK (off, failed, empty). */
export function markDark(rail: PaidRail, reason: string): void {
  transition(rail, { status: 'dark', reason: reason || 'unspecified', since: new Date().toISOString() });
}

/** Snapshot of every paid rail's served state (a copy — callers cannot mutate the record). */
export function servedState(): RailServedState {
  return Object.fromEntries(PAID_RAILS.map((r) => [r, { ...state[r] }])) as Record<PaidRail, RailServedEntry>;
}

/**
 * The ONE served predicate every consumer uses: served, and (when `mode` is given) served in
 * that mode. `unreported` and `dark` are both "not served".
 */
export function isRailServed(s: RailServedState, rail: PaidRail, mode?: string): boolean {
  const e = s[rail];
  if (!e || e.status !== 'served') return false;
  return mode === undefined || e.mode === mode;
}

/** Test seam: forget every report (each rail back to `unreported`). */
export function _resetRailServedStateForTest(): void {
  state = freshState();
}
