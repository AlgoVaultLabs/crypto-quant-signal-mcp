/**
 * Knowledge bundle in-memory store — KNOWLEDGE-ARTIFACT-W1.
 *
 * Lazy-loads `dist/knowledge/*.json` on first read; caches forever (until
 * container restart, which is the deploy-boundary cache invalidation per
 * audits/knowledge-shape-snapshot-2026-05-18.json cache_contract).
 *
 * Shared between Express handlers (`src/index.ts` /knowledge/* routes) and
 * MCP resource handlers (algovault://knowledge/* URIs). One source of truth.
 *
 * Path resolution: in compiled CJS at `dist/lib/knowledge-store.js`, the
 * resolved `dist/knowledge/` directory is `path.resolve(__dirname, '..',
 * 'knowledge')`. Override at runtime via `KNOWLEDGE_DIR` env var (for tests).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatKnowledgeBundle, type KnowledgeBundle } from './knowledge-formatter.js';

const VERSION_SLUG_REGEX = /^v\d+\.\d+\.\d+$/;

export interface KnowledgeIndex {
  latest: string;
  available_versions: string[];
  bundle_count: number;
  generator: string;
}

interface CacheState {
  bundles: Map<string, KnowledgeBundle>; // keys: 'latest' + 'v1.14.0' + …
  index: KnowledgeIndex | null;
  loaded: boolean;
}

const state: CacheState = {
  bundles: new Map(),
  index: null,
  loaded: false,
};

function resolveKnowledgeDir(): string {
  if (process.env.KNOWLEDGE_DIR) return process.env.KNOWLEDGE_DIR;
  // __dirname for compiled dist/lib/knowledge-store.js → resolves to dist/knowledge.
  return path.resolve(__dirname, '..', 'knowledge');
}

function load(): void {
  if (state.loaded) return;
  const dir = resolveKnowledgeDir();
  if (!fs.existsSync(dir)) {
    state.loaded = true;
    return; // no knowledge bundles produced yet — handlers will 404
  }
  const files = fs.readdirSync(dir);

  // Load index.json first (if present) for the available_versions listing.
  const indexPath = path.join(dir, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (raw && typeof raw === 'object') {
        state.index = {
          latest: typeof raw.latest === 'string' ? raw.latest : '',
          available_versions: Array.isArray(raw.available_versions) ? raw.available_versions.map(String) : [],
          bundle_count: Number(raw.bundle_count) || 0,
          generator: typeof raw.generator === 'string' ? raw.generator : 'build-knowledge-json.mjs',
        };
      }
    } catch {
      state.index = null;
    }
  }

  // Load every algovault-knowledge-v*.json + latest.json. Validate via
  // formatKnowledgeBundle so a corrupted file fails fast at server boot
  // rather than silently serving an invalid shape.
  for (const file of files) {
    if (file === 'index.json') continue;
    if (!file.endsWith('.json')) continue;
    const full = path.join(dir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      const bundle = formatKnowledgeBundle(raw);
      if (file === 'latest.json') {
        state.bundles.set('latest', bundle);
      } else {
        const m = file.match(/^algovault-knowledge-(v\d+\.\d+\.\d+)\.json$/);
        if (m) {
          state.bundles.set(m[1], bundle);
        }
      }
    } catch (err) {
      // Surface but do not crash; corrupted file is silently skipped, the
      // operator can re-run `npm run build:knowledge` to regenerate.
      console.error(`[knowledge-store] failed to load ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  state.loaded = true;
}

export function getKnowledgeBundle(slug: string): KnowledgeBundle | null {
  load();
  // Accept both 'latest' and version slugs (vX.Y.Z).
  if (slug !== 'latest' && !VERSION_SLUG_REGEX.test(slug)) {
    return null;
  }
  return state.bundles.get(slug) ?? null;
}

export function getKnowledgeIndex(): KnowledgeIndex | null {
  load();
  return state.index;
}

export function listKnowledgeResources(): Array<{ uri: string; name: string; description: string }> {
  load();
  const out: Array<{ uri: string; name: string; description: string }> = [];
  // 'latest' first (canonical entry point for agents).
  if (state.bundles.has('latest')) {
    out.push({
      uri: 'algovault://knowledge/latest',
      name: 'algovault-knowledge-latest',
      description:
        'AlgoVault knowledge bundle (latest version) — every MCP tool description, response shape, integration tutorial, and code example, indexed for LLM consumption.',
    });
  }
  for (const slug of [...state.bundles.keys()].sort()) {
    if (slug === 'latest') continue;
    out.push({
      uri: `algovault://knowledge/algovault-knowledge-${slug}`,
      name: `algovault-knowledge-${slug}`,
      description: `AlgoVault knowledge bundle for ${slug} (version-pinned).`,
    });
  }
  return out;
}

/**
 * Test-seam: clear the in-memory cache. ONLY used by vitest / dev tooling;
 * never called from production code paths.
 */
export function _resetKnowledgeStoreForTests(): void {
  state.bundles.clear();
  state.index = null;
  state.loaded = false;
}

export { VERSION_SLUG_REGEX };
