import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURSOR_MANIFEST_KEYS,
  LOGO_PATH,
  deriveCursorManifest,
  derivationDrift,
  serializeCursorManifest,
} from '../../scripts/lib/cursor-manifest.mjs';
import { hasBakedVenueCount } from '../../scripts/lib/baked-venue-count.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * OPS-CURSOR-PLUGIN-MANIFESTS-W1 R4 — `plugin.json` joins the versioned-companion family, and
 * this is what stops it becoming the family's next drift class.
 *
 * ── WHY A UNIT TEST AND NOT JUST THE GATE ───────────────────────────────────
 * `scripts/check-plugin-manifests.mjs` is the richer instrument — it validates against the
 * vendor's LIVE schemas and probes the live origin. But it needs the network, and an invariant
 * only a networked gate can check is one a desync can land past on any day the network is
 * degraded. So the split is deliberate: everything assertable from committed bytes is asserted
 * HERE, where it runs in CI, in `deploy.yml` and in the `pre-push` test gate; the schema and
 * live-origin legs stay in the gate, where a transport failure is visible as a transport failure.
 *
 * That is the same reasoning `tests/unit/lobehub-manifest-lockstep.test.ts` records for comparing
 * against the repo rather than the network — a gate that fetches its decision input degrades to a
 * PASS exactly when the network is degraded, indistinguishably from clean.
 *
 * ── WHAT IT IS REALLY DEFENDING ─────────────────────────────────────────────
 * `Version-Bump-SOP.md` §4's companion arithmetic was a three-way equality
 * (`package.json` = `server.json` = `manifest.json`) and is now four-way. A new versioned file
 * that the release wave forgets to bump is exactly the drift class OPS-SMITHERY-PUBLISH-LANE-W1
 * spent a wave retiring on a different surface. Prose in an SOP has failed as a control here
 * before; this is the gate.
 *
 * It also defends TWO duplications this wave deliberately introduced, because an unasserted
 * duplicate is the drift generator, not the duplicate itself:
 *   1. `plugin.json.keywords` duplicates `package.json.keywords`.
 *   2. `.cursor-plugin/plugin.json` projects nine fields from `plugin.json`.
 *
 * ── AND ONE ABSENCE ─────────────────────────────────────────────────────────
 * `logo` and `mcpServers` must NEVER appear in root `plugin.json`. The Agent Plugins manifest
 * schema is closed (`additionalProperties: false`) and carries neither, so either one makes the
 * manifest invalid — and `mcpServers` additionally *"Overrides default `mcp.json` discovery"*,
 * which would make two files the source of one server declaration. Both are asserted absent here
 * so the offline suite catches a re-addition without waiting for a schema fetch.
 */

interface Json {
  [k: string]: unknown;
}

const read = (rel: string): Json => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')) as Json;

const pkg = read('package.json');
const plugin = read('plugin.json');
const mcp = read('mcp.json');
const CURSOR_PATH = '.cursor-plugin/plugin.json';

describe('plugin.json is in lockstep with package.json (the FOURTH versioned companion)', () => {
  it('the corpus is non-empty on BOTH sides (vacuity guard, at construction)', () => {
    // Zero on either side would make every assertion below pass having compared nothing — the
    // shape this repo has been bitten by more than once. A defect in the fixture, not a result.
    expect(Object.keys(pkg).length, 'package.json parsed to an empty object').toBeGreaterThan(0);
    expect(Object.keys(plugin).length, 'plugin.json parsed to an empty object').toBeGreaterThan(0);
    expect(typeof pkg.version, 'package.json has no version').toBe('string');
    expect(typeof plugin.version, 'plugin.json has no version').toBe('string');
  });

  it('plugin.json.version === package.json.version', () => {
    // Report BOTH values: "they differ" sends the reader to a diff, "1.30.0 vs 1.30.1" names it.
    expect(
      `plugin.json=${plugin.version as string}`,
      'a release bumped package.json and left plugin.json behind — Version-Bump-SOP.md §4 companion arithmetic is FOUR-way',
    ).toBe(`plugin.json=${pkg.version as string}`);
  });

  it('plugin.json.name === package.json.name, and satisfies the published name constraint', () => {
    expect(plugin.name).toBe(pkg.name);
    // 1–64 chars, lowercase ASCII letters/digits/hyphens/periods, alphanumeric at both ends, and
    // no `--` or `..` — the pattern from the live plugin.schema.json, not the looser prose form.
    const name = plugin.name as string;
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name), `"${name}" violates the Agent Plugins name constraint`).toBe(true);
  });

  it('plugin.json.keywords === package.json.keywords (an asserted duplicate, not a drifting one)', () => {
    expect(plugin.keywords, 'plugin.json.keywords has drifted from package.json — they are one discovery set').toEqual(pkg.keywords);
  });

  it('carries the exact $schema literal the published schema requires as a const', () => {
    expect(plugin.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(mcp.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  });
});

describe('root plugin.json carries neither field that would invalidate it', () => {
  it('has no `mcpServers` — mcp.json is the single source of truth for the server', () => {
    // Cursor's reference, verbatim: mcpServers "Overrides default mcp.json discovery." Declaring
    // the server in both files is not belt-and-braces, it is two sources that can disagree.
    expect('mcpServers' in plugin).toBe(false);
  });

  it('has no `logo` — the Agent Plugins manifest schema is CLOSED and has no such property', () => {
    // It lives in the derived Cursor manifest instead, which is also the only place any measured
    // consumer reads it from (cursor/community-plugins parse.ts:589).
    expect('logo' in plugin).toBe(false);
  });

  it('carries only properties the closed schema allows', () => {
    const allowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
    expect(Object.keys(plugin).filter((k) => !allowed.includes(k)), 'an unknown top-level field is a schema violation under additionalProperties:false').toEqual([]);
  });

  it('author is an OBJECT of name/email/url, not the npm string form', () => {
    // package.json's `author` is the string "AlgoVault Labs"; the Agent Plugins schema types it as
    // an object with additionalProperties:false. Copying package.json's shape across would be
    // invalid, so the shape difference is asserted rather than left to look like an inconsistency.
    expect(typeof plugin.author).toBe('object');
    expect(Object.keys(plugin.author as Json).filter((k) => !['name', 'email', 'url'].includes(k))).toEqual([]);
  });
});

describe('mcp.json declares exactly one keyless streamable-http server', () => {
  it('carries only the two top-level fields the schema permits', () => {
    expect(Object.keys(mcp).sort()).toEqual(['$schema', 'mcpServers']);
  });

  it('every server declares its transport explicitly', () => {
    // Agent Plugins "use the standard's schema and declare each server's transport" — only Cursor
    // Plugins infer it from `command`/`url`. A type-less entry matches none of the schema's oneOf.
    const servers = Object.entries(mcp.mcpServers as Record<string, Json>);
    expect(servers.length, 'mcp.json declares no servers').toBeGreaterThan(0);
    for (const [name, cfg] of servers) {
      expect(cfg.type, `mcpServers.${name} declares no transport`).toBe('streamable-http');
      expect(typeof cfg.url).toBe('string');
      expect((cfg.url as string).startsWith('https://'), 'a non-loopback endpoint must use HTTPS').toBe(true);
    }
  });

  it('declares no headers — configured headers are literal package data and must carry no secret', () => {
    for (const [name, cfg] of Object.entries(mcp.mcpServers as Record<string, Json>)) {
      expect('headers' in cfg, `mcpServers.${name} declares headers; tools/list on this origin is keyless`).toBe(false);
    }
  });
});

describe('.cursor-plugin/plugin.json is a GENERATED projection, never a second author', () => {
  it('exists — a missing derived manifest means `npm run cursor:manifest:sync` was never run', () => {
    expect(existsSync(resolve(ROOT, CURSOR_PATH)), `${CURSOR_PATH} is absent — run: npm run cursor:manifest:sync`).toBe(true);
  });

  it('is byte-identical to the derivation of plugin.json', () => {
    // Byte equality, not field equality: it also pins the formatting `--sync` emits, so a
    // hand-reformat is caught as loudly as a hand-edited value.
    const onDisk = readFileSync(resolve(ROOT, CURSOR_PATH), 'utf8');
    expect(onDisk, `${CURSOR_PATH} has drifted — run: npm run cursor:manifest:sync`).toBe(
      serializeCursorManifest(deriveCursorManifest(plugin as never)),
    );
  });

  it('reports the drifting FIELD, not just "they differ"', () => {
    // A positive assertion on the reporter itself: equality alone would stay green if
    // derivationDrift were ever neutered to return [] unconditionally.
    const tampered = { ...(read(CURSOR_PATH) as Json), description: 'hand-edited' };
    const drift = derivationDrift(plugin as never, tampered as never);
    expect(drift.some((d: string) => d.startsWith('description:'))).toBe(true);
  });

  it('projects exactly the declared key list', () => {
    expect(Object.keys(read(CURSOR_PATH))).toEqual(CURSOR_MANIFEST_KEYS);
  });

  it('carries the logo that root plugin.json cannot, and the file is committed', () => {
    // A relative logo path is rewritten to https://raw.githubusercontent.com/<owner>/<repo>/HEAD/…
    // so a path naming an uncommitted file is a broken image on the public listing, silently.
    expect(read(CURSOR_PATH).logo).toBe(LOGO_PATH);
    expect(existsSync(resolve(ROOT, LOGO_PATH)), `${LOGO_PATH} is not in the repo`).toBe(true);
  });

  it('shares name, version and description with root plugin.json, so client precedence cannot matter', () => {
    const derived = read(CURSOR_PATH);
    for (const k of ['name', 'version', 'description'] as const) {
      expect(derived[k], `${k} disagrees between the two manifests`).toEqual(plugin[k]);
    }
  });
});

describe('every shipped manifest reaches an npm consumer, and carries clean public copy', () => {
  it('package.json files[] names all three manifests', () => {
    const files = pkg.files as string[];
    expect(files.length, 'package.json declares no files[]').toBeGreaterThan(0);
    for (const f of ['plugin.json', 'mcp.json', CURSOR_PATH]) {
      expect(files, `${f} is absent from files[], so it never reaches an npm consumer`).toContain(f);
    }
  });

  it('plugin.json.description carries no baked venue count', () => {
    // Public copy: this string reaches the Cursor listing verbatim. Asserted through the SHARED
    // predicate, so it cannot diverge from the one the Smithery gate enforces.
    expect(typeof plugin.description).toBe('string');
    expect(hasBakedVenueCount(plugin.description as string), 'the HELD list forbids a hardcoded venue count on every surface').toBe(false);
  });

  it('the predicate is live (a must-fire direction, so a neutered regex cannot read as clean)', () => {
    expect(hasBakedVenueCount('across 5 perp venues')).toBe(true);
    expect(hasBakedVenueCount('cross-venue funding scans')).toBe(false);
  });
});
