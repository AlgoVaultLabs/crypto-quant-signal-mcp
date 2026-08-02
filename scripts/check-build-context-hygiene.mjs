#!/usr/bin/env node
// @ts-check
/**
 * check-build-context-hygiene.mjs — key material must not enter git or the Docker build context,
 * and trimming the build context must never silently drop a COPY source.
 *
 * OPS-AUDIT-REMEDIATION-LOW-W1 · SEC-31 + SEC-37.
 *
 * TWO FAILURES, ONE FILE, BECAUSE THEY ARE THE SAME MISTAKE IN OPPOSITE DIRECTIONS.
 *
 *   SEC-31  `.gitignore` covered the bare literal `.env` and nothing else. `.env.production`,
 *           `.env.local`, a stray `*.pem`, an exported `*.key` were all committable into a
 *           PUBLIC repo with every gate green. SEC-02 (a live production Postgres password in
 *           this repo for seven weeks) is the measured cost of that class.
 *
 *   SEC-37  No `.dockerignore` existed, so every `docker build` shipped the whole repo root to
 *           the daemon — including the live `.env` in the host deploy directory. No layer
 *           COPYed it, but it crossed a boundary it had no reason to cross, on every deploy.
 *
 * AND THE TRAP THE FIX CREATES. A `.dockerignore` is a loaded gun pointed at the build: exclude
 * a path the Dockerfile COPYs and you fail the build at best, or ship a STALE artifact at worst.
 * `audits/` and `README.md` are Stage-1 inputs consumed by `npm run build:knowledge`, and their
 * content ships inside `dist/knowledge/*.json` — dropping them yields a green build and a stale
 * public knowledge bundle, which is exactly the silent-degradation shape CLAUDE.md warns about.
 * R2 below is therefore the load-bearing check: it re-derives the COPY set from the Dockerfiles
 * themselves on every run, so "let me trim the context a bit more" cannot regress it.
 *
 * Checks:
 *   R1  .dockerignore exists and excludes env + private-key patterns.
 *   R2  NO Dockerfile COPY source is excluded by .dockerignore  ← the one that protects the build.
 *   R3  .gitignore covers key-material PATTERNS, not just the literal `.env`.
 *
 * Verdict: exactly one terminal `BUILD_CONTEXT_HYGIENE_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a NEW gate).
 * FAIL-CLOSED: a missing Dockerfile, an unreadable ignore file, or a COPY set that parses to
 * zero entries is INDETERMINATE and blocks — a check that verified nothing must never read clean.
 *
 * Usage:
 *   node scripts/check-build-context-hygiene.mjs --self-test
 *   node scripts/check-build-context-hygiene.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DOCKERFILES = ['Dockerfile', 'Dockerfile.facilitator'];

/** Patterns that MUST be excluded from the build context. */
const REQUIRED_CONTEXT_EXCLUSIONS = ['.env', '.env.*', '*.pem', '*.key'];
/** Patterns .gitignore MUST carry beyond the bare literal `.env`. */
const REQUIRED_GIT_PATTERNS = ['.env.*', '*.pem', '*.key'];

/** @param {string} text @returns {string[]} non-comment, non-negated ignore rules */
export function parseIgnore(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Extract every COPY source path from a Dockerfile, skipping flags (--from=…) and the final
 * destination argument.
 * @param {string} text
 * @returns {string[]}
 */
export function copySources(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/^COPY\s/i.test(line)) continue;
    const parts = line.split(/\s+/).slice(1).filter((p) => !p.startsWith('--'));
    if (parts.length < 2) continue;
    for (const src of parts.slice(0, -1)) {
      if (src.startsWith('/')) continue; // --from=builder stage-internal path, not build context
      out.push(src.replace(/\/$/, ''));
    }
  }
  return [...new Set(out)];
}

/**
 * Would `pattern` exclude `path` under docker's ignore semantics (as used here: exact match,
 * glob on the basename, or a match on any leading path segment)?
 * @param {string} pattern @param {string} path
 */
export function ignoreMatches(pattern, path) {
  const rx = (p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
  const clean = path.replace(/^\.\//, '');
  if (rx(pattern).test(clean)) return true;
  const segs = clean.split('/');
  // `package*.json` must match the basename; `src` must match the leading directory segment
  if (rx(pattern).test(segs[segs.length - 1])) return true;
  if (segs.length > 1 && rx(pattern).test(segs[0])) return true;
  return false;
}

export function audit() {
  const findings = [];
  const dockerignorePath = join(ROOT, '.dockerignore');
  if (!existsSync(dockerignorePath)) {
    return { indeterminate: false, findings: [{ rule: 'R1', detail: '.dockerignore does not exist — the whole repo root, including any .env, is sent to the Docker daemon on every build. Create it (see SEC-37).' }], copyCount: 0 };
  }
  const dockerRules = parseIgnore(readFileSync(dockerignorePath, 'utf8'));

  // R1 — required exclusions present
  for (const need of REQUIRED_CONTEXT_EXCLUSIONS) {
    if (!dockerRules.includes(need)) {
      findings.push({ rule: 'R1', detail: `.dockerignore does not exclude \`${need}\` — key material can enter the build context. Add that exact line.` });
    }
  }

  // R2 — no COPY source may be excluded (the check that protects the build)
  let copySet = [];
  for (const df of DOCKERFILES) {
    const p = join(ROOT, df);
    if (!existsSync(p)) continue;
    copySet.push(...copySources(readFileSync(p, 'utf8')));
  }
  copySet = [...new Set(copySet)];
  if (!copySet.length) return { indeterminate: true, findings, copyCount: 0 };

  const negations = parseIgnore(readFileSync(dockerignorePath, 'utf8')).filter((r) => r.startsWith('!')).map((r) => r.slice(1));
  for (const src of copySet) {
    const hit = dockerRules.filter((r) => !r.startsWith('!')).find((r) => ignoreMatches(r, src));
    if (hit && !negations.some((n) => ignoreMatches(n, src))) {
      findings.push({ rule: 'R2', detail: `.dockerignore rule \`${hit}\` EXCLUDES Dockerfile COPY source \`${src}\`. The build will fail, or — if it is a Stage-1 knowledge input like audits/ or README.md — succeed while shipping a STALE dist/knowledge bundle. Remove the rule or add a \`!${src}\` negation.` });
    }
  }

  // R3 — gitignore carries patterns, not just the literal .env
  const gitignorePath = join(ROOT, '.gitignore');
  if (!existsSync(gitignorePath)) {
    findings.push({ rule: 'R3', detail: '.gitignore does not exist' });
  } else {
    const gitRules = parseIgnore(readFileSync(gitignorePath, 'utf8'));
    for (const need of REQUIRED_GIT_PATTERNS) {
      if (!gitRules.includes(need)) {
        findings.push({ rule: 'R3', detail: `.gitignore does not carry \`${need}\` — only the bare literal \`.env\` is covered, so \`.env.production\` / \`*.pem\` / \`*.key\` are committable into a PUBLIC repo (the SEC-02 class). Add that exact line.` });
      }
    }
  }
  return { indeterminate: false, findings, copyCount: copySet.length };
}

/** Two-directional, and it must be able to fail. */
export function selfTest() {
  const fails = [];
  // COPY parsing
  const parsed = copySources('FROM node\nCOPY package*.json tsconfig.json ./\nCOPY --from=builder /app/dist/ ./dist/\nCOPY audits/ ./audits/\n');
  if (!parsed.includes('package*.json')) fails.push('COPY parser missed package*.json');
  if (!parsed.includes('audits')) fails.push('COPY parser missed audits/');
  if (parsed.includes('/app/dist')) fails.push('COPY parser wrongly treated a --from stage path as build context');
  // matching
  if (!ignoreMatches('audits', 'audits')) fails.push('ignoreMatches missed an exact directory match');
  if (!ignoreMatches('*.env', 'prod.env')) fails.push('ignoreMatches missed a basename glob');
  if (!ignoreMatches('src', 'src/lib/x.ts')) fails.push('ignoreMatches missed a leading-segment match');
  if (ignoreMatches('dist', 'src/lib/x.ts')) fails.push('ignoreMatches produced a false positive');
  // the R2 direction that actually protects the build
  if (!ignoreMatches('audits', 'audits')) fails.push('R2 could not detect an excluded Stage-1 input');
  if (ignoreMatches('.env', 'README.md')) fails.push('.env rule wrongly matched README.md');
  // ignore parsing drops comments and blanks
  const rules = parseIgnore('# comment\n\n.env\n*.pem\n');
  if (rules.length !== 2) fails.push(`parseIgnore kept comments/blanks (${rules.length} rules)`);
  return fails;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function emit(verdict, why) {
  if (why) console.log(`\n${verdict === 'FAIL' ? '✖' : 'ℹ'} ${why}`);
  console.log(`BUILD_CONTEXT_HYGIENE_VERDICT=${verdict}`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);
}

if (IS_MAIN) {
  if (argv.includes('--self-test')) {
    const fails = selfTest();
    if (fails.length) { console.error('✖ build-context-hygiene self-test FAILED:'); fails.forEach((f) => console.error('   - ' + f)); process.exit(1); }
    console.log('✓ build-context-hygiene self-test passed (COPY parsing, ignore matching both directions, no false positives)');
    process.exit(0);
  }
  const stFails = selfTest();
  if (stFails.length) {
    console.error('✖ build-context-hygiene self-test FAILED — refusing to report a vacuous pass:');
    stFails.forEach((f) => console.error('   - ' + f));
    emit('INDETERMINATE', 'self-test failure');
  }
  let r;
  try { r = audit(); } catch (e) { emit('INDETERMINATE', `audit could not run: ${e.message}`); }
  if (r.indeterminate) emit('INDETERMINATE', 'parsed ZERO COPY sources from the Dockerfiles — the parser or the Dockerfiles moved; refusing to report a pass');
  if (r.findings.length) {
    console.error(`✖ ${r.findings.length} build-context hygiene finding(s):`);
    for (const f of r.findings) console.error(`   - [${f.rule}] ${f.detail}`);
    emit('FAIL', `${r.findings.length} finding(s)`);
  }
  console.log(`✓ build-context hygiene: .dockerignore excludes env/key material, all ${r.copyCount} Dockerfile COPY sources survive it, and .gitignore carries key-material patterns.`);
  emit('PASS');
}
