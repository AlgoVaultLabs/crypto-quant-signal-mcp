/**
 * KnowledgeBundle interface + pure formatter — KNOWLEDGE-ARTIFACT-W1.
 *
 * The formatter is allow-list: only fields declared in `KnowledgeBundle` survive.
 * Used by both the build script (validate before write) AND the Express handler
 * (validate before serve). Throws on missing required fields.
 *
 * Public-shape contract — see `audits/knowledge-shape-snapshot-2026-05-18.json`
 * for `allowed_keys` / `forbidden_keys` / `drift_check_command`.
 */

export interface KnowledgeBundleTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface KnowledgeBundleResponseShape {
  endpoint: string;
  snapshot_date: string;
  allowed_keys: string[];
  forbidden_keys: string[];
  error_contract: Record<string, unknown>;
  cache_contract: Record<string, unknown>;
  consumers: string[];
  drift_check_command: string;
}

export interface KnowledgeBundleIntegration {
  framework: string;
  title: string;
  content_markdown: string;
  url: string;
}

export interface KnowledgeBundleExample {
  framework: string;
  file_path: string;
  code: string;
  readme: string;
}

export interface KnowledgeBundleDiscussion {
  url: string;
  title: string;
  body_markdown: string;
  created_at: string;
}

export interface KnowledgeBundleMeta {
  bundle_version: 1;
  generator: 'build-knowledge-json.mjs';
  repo: 'AlgoVaultLabs/crypto-quant-signal-mcp';
}

export interface KnowledgeBundle {
  version: string;
  generated_at: string;
  package_name: string;
  description: string;
  keywords: string[];
  whats_new: string;
  tools: KnowledgeBundleTool[];
  response_shapes: KnowledgeBundleResponseShape[];
  integrations: KnowledgeBundleIntegration[];
  examples: KnowledgeBundleExample[];
  discussions: KnowledgeBundleDiscussion[];
  _algovault: KnowledgeBundleMeta;
}

const REQUIRED_KEYS: ReadonlyArray<keyof KnowledgeBundle> = [
  'version',
  'generated_at',
  'package_name',
  'description',
  'keywords',
  'whats_new',
  'tools',
  'response_shapes',
  'integrations',
  'examples',
  'discussions',
  '_algovault',
];

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`KnowledgeBundle.${field}: expected string, got ${typeof value}`);
  }
  return value;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`KnowledgeBundle.${field}: expected array, got ${typeof value}`);
  }
  return value.map((item, idx) => assertString(item, `${field}[${idx}]`));
}

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`KnowledgeBundle.${field}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`KnowledgeBundle.${field}: expected array, got ${typeof value}`);
  }
  return value;
}

function formatTool(raw: unknown, idx: number): KnowledgeBundleTool {
  const obj = assertObject(raw, `tools[${idx}]`);
  return {
    name: assertString(obj.name, `tools[${idx}].name`),
    description: assertString(obj.description, `tools[${idx}].description`),
    parameters: assertObject(obj.parameters, `tools[${idx}].parameters`),
  };
}

function formatResponseShape(raw: unknown, idx: number): KnowledgeBundleResponseShape {
  const obj = assertObject(raw, `response_shapes[${idx}]`);
  return {
    endpoint: assertString(obj.endpoint, `response_shapes[${idx}].endpoint`),
    snapshot_date: assertString(obj.snapshot_date, `response_shapes[${idx}].snapshot_date`),
    allowed_keys: assertStringArray(obj.allowed_keys, `response_shapes[${idx}].allowed_keys`),
    forbidden_keys: assertStringArray(obj.forbidden_keys, `response_shapes[${idx}].forbidden_keys`),
    error_contract: assertObject(obj.error_contract, `response_shapes[${idx}].error_contract`),
    cache_contract: assertObject(obj.cache_contract, `response_shapes[${idx}].cache_contract`),
    consumers: assertStringArray(obj.consumers, `response_shapes[${idx}].consumers`),
    drift_check_command: assertString(obj.drift_check_command, `response_shapes[${idx}].drift_check_command`),
  };
}

function formatIntegration(raw: unknown, idx: number): KnowledgeBundleIntegration {
  const obj = assertObject(raw, `integrations[${idx}]`);
  return {
    framework: assertString(obj.framework, `integrations[${idx}].framework`),
    title: assertString(obj.title, `integrations[${idx}].title`),
    content_markdown: assertString(obj.content_markdown, `integrations[${idx}].content_markdown`),
    url: assertString(obj.url, `integrations[${idx}].url`),
  };
}

function formatExample(raw: unknown, idx: number): KnowledgeBundleExample {
  const obj = assertObject(raw, `examples[${idx}]`);
  return {
    framework: assertString(obj.framework, `examples[${idx}].framework`),
    file_path: assertString(obj.file_path, `examples[${idx}].file_path`),
    code: assertString(obj.code, `examples[${idx}].code`),
    readme: assertString(obj.readme, `examples[${idx}].readme`),
  };
}

function formatDiscussion(raw: unknown, idx: number): KnowledgeBundleDiscussion {
  const obj = assertObject(raw, `discussions[${idx}]`);
  return {
    url: assertString(obj.url, `discussions[${idx}].url`),
    title: assertString(obj.title, `discussions[${idx}].title`),
    body_markdown: assertString(obj.body_markdown, `discussions[${idx}].body_markdown`),
    created_at: assertString(obj.created_at, `discussions[${idx}].created_at`),
  };
}

function formatMeta(raw: unknown): KnowledgeBundleMeta {
  const obj = assertObject(raw, '_algovault');
  const bundleVersion = obj.bundle_version;
  if (bundleVersion !== 1) {
    throw new Error(`KnowledgeBundle._algovault.bundle_version: expected 1, got ${JSON.stringify(bundleVersion)}`);
  }
  const generator = assertString(obj.generator, '_algovault.generator');
  if (generator !== 'build-knowledge-json.mjs') {
    throw new Error(`KnowledgeBundle._algovault.generator: expected 'build-knowledge-json.mjs', got ${JSON.stringify(generator)}`);
  }
  const repo = assertString(obj.repo, '_algovault.repo');
  if (repo !== 'AlgoVaultLabs/crypto-quant-signal-mcp') {
    throw new Error(`KnowledgeBundle._algovault.repo: expected 'AlgoVaultLabs/crypto-quant-signal-mcp', got ${JSON.stringify(repo)}`);
  }
  return { bundle_version: 1, generator: 'build-knowledge-json.mjs', repo: 'AlgoVaultLabs/crypto-quant-signal-mcp' };
}

/**
 * Validate + reshape an arbitrary input into a typed KnowledgeBundle.
 *
 * Allow-list semantics: extra keys in `raw` are silently dropped (so a buggy
 * generator can never leak `outcome_return_pct` into the public surface — the
 * public shape is what this function returns, not what `raw` contains).
 *
 * Throws on missing required fields or type mismatches.
 */
export function formatKnowledgeBundle(raw: unknown): KnowledgeBundle {
  const obj = assertObject(raw, '<root>');

  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) {
      throw new Error(`KnowledgeBundle: missing required field '${String(key)}'`);
    }
  }

  return {
    version: assertString(obj.version, 'version'),
    generated_at: assertString(obj.generated_at, 'generated_at'),
    package_name: assertString(obj.package_name, 'package_name'),
    description: assertString(obj.description, 'description'),
    keywords: assertStringArray(obj.keywords, 'keywords'),
    whats_new: assertString(obj.whats_new, 'whats_new'),
    tools: assertArray(obj.tools, 'tools').map(formatTool),
    response_shapes: assertArray(obj.response_shapes, 'response_shapes').map(formatResponseShape),
    integrations: assertArray(obj.integrations, 'integrations').map(formatIntegration),
    examples: assertArray(obj.examples, 'examples').map(formatExample),
    discussions: assertArray(obj.discussions, 'discussions').map(formatDiscussion),
    _algovault: formatMeta(obj._algovault),
  };
}
