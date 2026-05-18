/**
 * KnowledgeIndex — AV-CHAT-MCP-W1 (C1).
 *
 * Builds an in-memory BM25 index over the auto-generated KnowledgeBundle JSON
 * shipped by KNOWLEDGE-ARTIFACT-W1 at `/app/dist/knowledge/latest.json`.
 *
 * Watches the bundle file via `fs.watchFile` (poll every 30s — chokidar is
 * overkill for a single file). On change → rebuild index in background →
 * atomic swap into `_engine` / `_docs` / `_bundle` (Node single-threaded
 * event loop guarantees no torn reads between the three fields when set
 * in the same synchronous block).
 *
 * Field weights (per spec): name=3, title=3, description=2, content_markdown=1.
 *
 * No external NLP deps: a minimal prepTask (lowercase + ASCII tokenize, drop
 * tokens <2 chars) is sufficient for AlgoVault's knowledge-bundle content
 * (mostly tool names, parameter names, framework names, English prose).
 */
import * as fs from 'node:fs';
import { formatKnowledgeBundle, type KnowledgeBundle } from './knowledge-formatter.js';
import bm25, { type WinkBM25Index } from 'wink-bm25-text-search';

export type { WinkBM25Index };

const FIELD_WEIGHTS = { name: 3, title: 3, description: 2, content_markdown: 1 };
const POLL_INTERVAL_MS = 30000;

// Minimal stemming-free prepTask: lowercase + ASCII alphanumeric tokenization,
// drop tokens shorter than 2 chars. Adequate for AlgoVault knowledge content.
function prepTask(text: string | undefined | null): string[] {
  if (!text) return [];
  return text.toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
}

export type KnowledgeDocSourceType =
  | 'tool'
  | 'response_shape'
  | 'integration'
  | 'example'
  | 'discussion';

export interface KnowledgeDoc {
  // Searchable fields (match FIELD_WEIGHTS keys)
  name: string;
  title: string;
  description: string;
  content_markdown: string;
  // Out-of-vocab metadata (retained for excerpt + citation, not indexed)
  _source_type: KnowledgeDocSourceType;
  _source_url: string;
  _excerpt_source: string;
}

export class KnowledgeIndex {
  private readonly bundlePath: string;
  private _engine: WinkBM25Index | null = null;
  private _docs: Map<string, KnowledgeDoc> = new Map();
  private _bundle: KnowledgeBundle | null = null;
  private _watching = false;

  constructor(bundlePath: string) {
    this.bundlePath = bundlePath;
    // Set up file watcher: poll every 30s, atomic rebuild on change.
    // No throw if file doesn't exist yet — watcher fires once file appears.
    fs.watchFile(bundlePath, { interval: POLL_INTERVAL_MS }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return; // no change
      this.rebuild().catch((err) => {
        console.error(
          `[knowledge-index] rebuild failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    });
    this._watching = true;
  }

  async build(): Promise<void> {
    if (!fs.existsSync(this.bundlePath)) {
      console.warn(
        `[knowledge-index] bundle not found at ${this.bundlePath} — index will be empty until file appears`,
      );
      this._engine = null;
      this._docs = new Map();
      this._bundle = null;
      return;
    }

    const raw = JSON.parse(fs.readFileSync(this.bundlePath, 'utf8'));
    const bundle = formatKnowledgeBundle(raw);

    const engine = bm25();
    engine.defineConfig({ fldWeights: FIELD_WEIGHTS });
    engine.definePrepTasks([prepTask]);

    const docs = new Map<string, KnowledgeDoc>();

    // Tools — 1 doc per bundle.tools[i]
    for (const t of bundle.tools) {
      const id = `tool:${t.name}`;
      const paramSummary = Object.keys(t.parameters || {}).join(', ');
      const doc: KnowledgeDoc = {
        name: t.name,
        title: t.name,
        description: t.description,
        content_markdown: `${t.description}\n\nParameters: ${paramSummary}`,
        _source_type: 'tool',
        _source_url: 'https://api.algovault.com/mcp',
        _excerpt_source: t.description,
      };
      docs.set(id, doc);
      engine.addDoc(
        {
          name: doc.name,
          title: doc.title,
          description: doc.description,
          content_markdown: doc.content_markdown,
        },
        id,
      );
    }

    // Response shapes — 1 doc per bundle.response_shapes[i]
    for (const rs of bundle.response_shapes) {
      const id = `response_shape:${rs.endpoint}`;
      const summary = `endpoint ${rs.endpoint} allowed_keys ${rs.allowed_keys.join(' ')} consumers ${rs.consumers.join(' ')}`;
      // Derive a stable github URL for the audit snapshot
      const sourceUrl = `https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/tree/main/audits`;
      const doc: KnowledgeDoc = {
        name: rs.endpoint,
        title: `Response shape: ${rs.endpoint}`,
        description: `Public-shape contract for ${rs.endpoint} (snapshot ${rs.snapshot_date}).`,
        content_markdown: summary,
        _source_type: 'response_shape',
        _source_url: sourceUrl,
        _excerpt_source: summary,
      };
      docs.set(id, doc);
      engine.addDoc(
        {
          name: doc.name,
          title: doc.title,
          description: doc.description,
          content_markdown: doc.content_markdown,
        },
        id,
      );
    }

    // Integrations — 1 doc per bundle.integrations[i]
    for (const it of bundle.integrations) {
      const id = `integration:${it.framework}`;
      const doc: KnowledgeDoc = {
        name: it.framework,
        title: it.title,
        description: it.title,
        content_markdown: it.content_markdown,
        _source_type: 'integration',
        _source_url: it.url,
        _excerpt_source: it.content_markdown,
      };
      docs.set(id, doc);
      engine.addDoc(
        {
          name: doc.name,
          title: doc.title,
          description: doc.description,
          content_markdown: doc.content_markdown,
        },
        id,
      );
    }

    // Examples — empty in v1.14.x; handled gracefully when present in future
    for (const ex of bundle.examples) {
      const id = `example:${ex.framework}:${ex.file_path}`;
      const doc: KnowledgeDoc = {
        name: ex.framework,
        title: `Example: ${ex.framework} / ${ex.file_path}`,
        description: ex.readme || ex.file_path,
        content_markdown: ex.code,
        _source_type: 'example',
        _source_url: '',
        _excerpt_source: ex.readme || ex.code,
      };
      docs.set(id, doc);
      engine.addDoc(
        {
          name: doc.name,
          title: doc.title,
          description: doc.description,
          content_markdown: doc.content_markdown,
        },
        id,
      );
    }

    // Discussions — empty unless GH_TOKEN present in build context
    for (const d of bundle.discussions) {
      const id = `discussion:${d.url}`;
      const doc: KnowledgeDoc = {
        name: d.title,
        title: d.title,
        description: d.title,
        content_markdown: d.body_markdown,
        _source_type: 'discussion',
        _source_url: d.url,
        _excerpt_source: d.body_markdown,
      };
      docs.set(id, doc);
      engine.addDoc(
        {
          name: doc.name,
          title: doc.title,
          description: doc.description,
          content_markdown: doc.content_markdown,
        },
        id,
      );
    }

    // wink-bm25 requires consolidate() before search() — only if at least one doc
    if (docs.size > 0) {
      engine.consolidate();
    }

    // Atomic swap: assign all three fields in one synchronous block. Node's
    // single-threaded event loop guarantees no SearchEngine.query() can
    // interleave between the three assignments.
    this._engine = docs.size > 0 ? engine : null;
    this._docs = docs;
    this._bundle = bundle;
  }

  async rebuild(): Promise<void> {
    try {
      await this.build();
    } catch (err) {
      console.error(
        `[knowledge-index] rebuild failed, keeping previous index: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  getBM25Index(): WinkBM25Index | null {
    return this._engine;
  }

  getDoc(id: string): KnowledgeDoc | undefined {
    return this._docs.get(id);
  }

  getBundle(): KnowledgeBundle | null {
    return this._bundle;
  }

  /** Test-seam: stop the file watcher (used by vitest teardown). */
  stopWatching(): void {
    if (this._watching) {
      fs.unwatchFile(this.bundlePath);
      this._watching = false;
    }
  }
}
