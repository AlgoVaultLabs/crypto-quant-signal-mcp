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
 * Consumers of `parseToolNames`:
 *   - scripts/check-smithery-sync.mjs        (SMITHERY_SYNC_VERDICT)
 *   - scripts/check-plugin-manifests.mjs     (PLUGIN_MANIFESTS_VERDICT)
 *   - scripts/check-primitive-resolution.mjs (judges ops/primitive-registry.json against live tools/list)
 *
 * THE SECOND READER — `listServerTools()` (OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1). The same list,
 * read IN-PROCESS: our own server factory (`createSandboxServer()` from `dist/index.js`) over the
 * SDK's `InMemoryTransport` + `Client`. No network, no port, no DB and no env beyond the caller's,
 * so it runs inside the Docker builder stage, which has none of them. The SDK builds the response,
 * so `inputSchema` is what a remote client is served (measured at R0: 9/9 names, descriptions and
 * inputSchemas byte-equal to live `POST /mcp tools/list`).
 *
 * ENV IS AN INPUT. Registration iterates `liveMcpToolNames(process.env)`, so this returns the list
 * the CALLER's env would serve — under an empty env, the public default set. A runtime-only flag flip
 * on a deployed container is invisible to a build-time reader by construction, and that is the
 * intended semantics for a published artifact: a dark tool stays out of public knowledge until its
 * default changes in code.
 *
 * `dist/index.js` is required LAZILY, inside the function: the parse consumers above run where no
 * build exists, and must stay that way.
 *
 * Consumers of `listServerTools` / `assertToolList`:
 *   - scripts/build-knowledge-json.mjs     (bundle.tools is this list, projected)
 *   - tests/unit/knowledge-bundle.test.ts  (fail-closed proof + the projection canary)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

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

/**
 * Every tool our server registers, read in-process through the real MCP `tools/list` handler,
 * every page (`nextCursor` followed to exhaustion). Throws when the build is missing or the
 * factory is not exported; never returns a partial list.
 *
 * @param {string} repoRoot checkout whose `dist/index.js` is read — run `npm run build` first
 * @returns {Promise<Array<{ name: string, description?: string, inputSchema: Record<string, unknown> }>>}
 */
export async function listServerTools(repoRoot) {
  const entry = path.join(repoRoot, 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`${entry} not found — run \`npm run build\` first`);
  // Resolve the SDK from the SAME checkout as the server, so both sides of the transport agree.
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const { createSandboxServer } = require(entry);
  if (typeof createSandboxServer !== 'function') {
    throw new Error(`${entry} does not export createSandboxServer() — the in-process tools/list seam is gone`);
  }
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');

  const server = createSandboxServer();
  const client = new Client({ name: 'algovault-tools-list-reader', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error(`tools/list repeated cursor ${JSON.stringify(cursor)} — refusing to loop`);
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return tools;
  } finally {
    // Both ends closed on EVERY path, so a short-lived build process exits on its own.
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/**
 * A tools/list a consumer may publish from, or a throw naming every defect. Fail-closed by design:
 * an empty list, a nameless or duplicated tool, a tool with no description, or a non-object
 * `inputSchema` means the reader saw something other than our server, and a consumer that ships
 * it ships a knowledge base that knows nothing (or, for a duplicate name, one whose BM25 index
 * throws at serve time on a repeated doc id).
 *
 * @template {{ name?: unknown, description?: unknown, inputSchema?: unknown }} T
 * @param {T[]} tools
 * @returns {T[]} the same array, when usable
 */
export function assertToolList(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('tools/list yielded 0 tools — refusing to publish an empty tool set');
  }
  const defects = [];
  const seen = new Set();
  tools.forEach((t, i) => {
    const label = typeof t?.name === 'string' && t.name ? t.name : `#${i}`;
    if (typeof t?.name !== 'string' || t.name.length === 0) defects.push(`${label}: no name`);
    else if (seen.has(t.name)) defects.push(`${label}: duplicate name`);
    else seen.add(t.name);
    if (typeof t?.description !== 'string' || t.description.trim().length === 0) defects.push(`${label}: no description`);
    if (t?.inputSchema === null || typeof t?.inputSchema !== 'object' || Array.isArray(t.inputSchema)) {
      defects.push(`${label}: inputSchema is not an object`);
    }
  });
  if (defects.length > 0) throw new Error(`tools/list is not publishable (${defects.length} defect(s)): ${defects.join('; ')}`);
  return tools;
}
