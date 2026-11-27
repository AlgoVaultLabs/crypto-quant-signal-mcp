// tests/fixtures/regime-15m/closure.ts — EDGE-REGIME-15M-BACKTEST-W1: the runtime import closure of a source file.
//
// Every repository file a module loads when it runs: relative `import … from`, `export … from`, `import('…')` and
// `require('…')` specifiers, followed recursively, `.js` resolved to the `.ts` beside it. Type-only imports and
// re-exports (`import type`, `export type`) load nothing at run time and are not followed. Package imports
// (`node:*`, bare names) are outside the repository and are not followed. A file under a `stop` prefix is listed
// and not opened: the suites never walk a directory other waves edit (src/lib), only reach it.
import fs from 'node:fs';
import path from 'node:path';

const SPEC = /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Repository-relative paths of every file `entry` loads at run time, `entry` included, sorted; `stop` files are not opened. */
export function runtimeClosure(repo: string, entry: string, stop: readonly string[] = []): string[] {
  const seen = new Set<string>(), todo = [entry];
  while (todo.length) {
    const rel = todo.pop() as string;
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (stop.some((p) => rel.startsWith(p))) continue;
    const src = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(SPEC)) {
      if (m[1]) continue;
      const spec = m[2] ?? m[3] ?? m[4];
      if (!spec || !spec.startsWith('.')) continue;
      let to = path.normalize(path.join(path.dirname(rel), spec));
      if (to.endsWith('.js') && fs.existsSync(path.join(repo, to.replace(/\.js$/, '.ts')))) to = to.replace(/\.js$/, '.ts');
      else if (!path.extname(to) && fs.existsSync(path.join(repo, `${to}.ts`))) to = `${to}.ts`;
      if (!fs.existsSync(path.join(repo, to))) throw new Error(`${rel} imports ${spec}, which does not resolve`);
      todo.push(to);
    }
  }
  return [...seen].sort();
}
