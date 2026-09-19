/**
 * Parse a `tools/list` response body from our own MCP origin — ONE derivation, two gates.
 *
 * WHY IT MOVED HERE. Authored inside `scripts/check-smithery-sync.mjs` by
 * `OPS-SMITHERY-PUBLISH-LANE-W1`; extracted by `OPS-CURSOR-PLUGIN-MANIFESTS-W1` when a second gate
 * needed the same parse. That file runs `main()` at module scope, so it cannot be imported without
 * executing the live gate, and re-implementing a response parser is how two readers of one wire
 * format come to disagree about it. Same reasoning as `scripts/lib/baked-venue-count.mjs`.
 *
 * WHAT IT HANDLES, AND WHY EACH BRANCH EXISTS. The remote transport runs STATELESS
 * (`sessionIdGenerator: undefined`), so there is no `Mcp-Session-Id` and its absence is CORRECT —
 * this reader never asserts on one. What it must handle is the FRAMING: a
 * `content-type: text/event-stream` body arrives as `event: message\ndata: {…}`, and an
 * `application/json` body arrives bare. Branch on the shape, never on an assumption.
 *
 * `null` means "handed something I could not parse", which every caller maps to INDETERMINATE —
 * never to a clean result, and never to FAIL. Empty-vs-unparseable is the line.
 *
 * Consumers:
 *   - scripts/check-smithery-sync.mjs   (SMITHERY_SYNC_VERDICT)
 *   - scripts/check-plugin-manifests.mjs (PLUGIN_MANIFESTS_VERDICT)
 */

/** SSE-framed or bare JSON-RPC body → sorted tool names, or null. */
export function parseToolNames(body) {
  const raw = String(body ?? '');
  let json = raw;
  if (/^data: /m.test(raw)) {
    const frames = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    if (frames.length === 0) return null;
    json = frames[0];
  }
  try {
    const tools = JSON.parse(json)?.result?.tools;
    if (!Array.isArray(tools)) return null;
    const names = tools.map((t) => t?.name).filter((n) => typeof n === 'string');
    return names.length === tools.length ? names.slice().sort() : null;
  } catch {
    return null;
  }
}
