/**
 * Shared helper: exports the package version loaded from package.json at
 * module load time. Replaces the previously-scattered `version: '1.x.x'`
 * literals across tool `_algovault` envelopes and HTTP health endpoints.
 *
 * Resolution strategy: the compiled file lives at `dist/lib/pkg-version.js`
 * and resolves `../../package.json` to the repo-root package.json, which
 * NPM always includes in published packages.
 *
 * Uses `readFileSync` + `__dirname` (CJS) rather than `import.meta.url`
 * because this package compiles to CommonJS (no `"type": "module"` in
 * package.json), matching the existing CJS pattern used in other lib files.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkgJsonPath = resolve(__dirname, '..', '..', 'package.json');
const pkgJson: { version: string } = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

export const PKG_VERSION: string = pkgJson.version;
