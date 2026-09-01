#!/usr/bin/env node
// scripts/lib/strip-comments.mjs — the ONE comment stripper gate authors should reach for.
//
// OPS-SYSTEM-MAP-GATE-COMMENT-STRIP-W1.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
// "A mention in a comment is not an occurrence" is a law this repo has codified and then
// re-learned repeatedly, because there was nothing to import: measured 2026-08-12, `scripts/`
// held SIXTEEN independent comment-stripper implementations (seventeen functions) plus NINE more
// in tests/, in four mutually-incompatible shapes — and the gate that most needed one had none.
// So `check_system_map.sh` blocked PAY-RAIL-DASHBOARD-W1 on the comment
// "rides the existing 30s load() loop — adds NO setInterval": a sentence asserting the ABSENCE of
// the thing, read as its presence. The same gate had already blocked its own installer's comment
// block for the same reason (scripts/install_system_map_hook.sh:47-52).
//
// The absence of a shared stripper IS the recurrence mechanism. Consumer registry, and the
// migration follow-up for the existing sixteen: ops/strip-comments-consumers.md.
//
// ── DECLARED SEMANTICS (the existing sixteen disagree on exactly these two) ──────────────────
// 1. LANGUAGE-AWARE, dispatched on the file extension. Applying one syntax everywhere destroys
//    files: check-canaries-wired.mjs records a measured bug where the JS block-comment regex run
//    over YAML matched from a glob's "/**" to the next "*/" and swallowed the `run:` lines
//    between, reporting two correctly-wired gates as orphans.
// 2. OFFSET-PRESERVING. Comment CONTENT is replaced with spaces; every newline, every line
//    length and therefore every line/column offset survives. Callers that report positions
//    (this gate greps with -n) stay correct, which the line-dropping shapes cannot promise.
//
// These line comments are deliberate rather than a JSDoc block: the literal sequences this file
// must describe would close the block early. Same trap, one level up — as recorded in
// check-canaries-wired.mjs, whose language dispatch this combines with check-jq-truthiness.mjs's
// offset-preserving blanking.

/** Replace every non-newline character with a space: content gone, offsets intact. */
const blank = (s) => s.replace(/[^\n]/g, ' ');

// Comment syntax by extension. SQL is here and in neither reuse target, which matters: this
// gate's patterns include `CREATE TABLE` and `ALTER TABLE … ADD COLUMN`, migrations are `.sql`,
// and SQL comments with `--`. A migration commented "-- does NOT create table X" false-positives
// without it.
const LINE_COMMENT = {
  hash: /^(?:sh|bash|zsh|ya?ml|toml|conf|cfg|ini|properties|Dockerfile|gitignore)$/i,
  slash: /^(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|go|rs|java|c|h|cc|cpp|swift|kt|scala|php)$/i,
  dash: /^(?:sql|lua|hs|elm|ada)$/i,
  angle: /^(?:html|htm|xml|svg|vue|xhtml)$/i,
};

function familyFor(filePath) {
  const name = String(filePath || '');
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? name.split('/').pop() ?? '';
  if (LINE_COMMENT.hash.test(ext)) return 'hash';
  if (LINE_COMMENT.slash.test(ext)) return 'slash';
  if (LINE_COMMENT.dash.test(ext)) return 'dash';
  if (LINE_COMMENT.angle.test(ext)) return 'angle';
  return 'none'; // JSON, .md, .txt, unknown — no comment syntax we are willing to guess at.
}

/**
 * Blank comment CONTENT in `text`, using the comment syntax `filePath` implies.
 * Language-aware AND offset-preserving — see the declared semantics above.
 * Unknown extensions pass through untouched: guessing is how a stripper eats real code.
 */
export function stripComments(text, filePath) {
  const family = familyFor(filePath);
  if (family === 'none') return text;

  if (family === 'angle') {
    return String(text).replace(/<!--[\s\S]*?-->/g, blank); // HTML/XML have no line-comment form.
  }
  if (family === 'hash') {
    // No block-comment form, so a single per-line pass is exact. A '#' only opens a comment at
    // line start or after whitespace, so `a#b` and a URL fragment survive.
    return String(text)
      .split('\n')
      .map((line) => line.replace(/(^|\s)#.*$/, (m, keep = '') => keep + blank(m.slice(keep.length))))
      .join('\n');
  }
  return scanSlashLike(String(text), family === 'dash' ? '--' : '//');
}

/**
 * ONE left-to-right pass: whichever delimiter OPENS FIRST wins.
 *
 * ── WHY THIS IS A SCAN AND NOT TWO REGEX PASSES (OPS-STRIP-COMMENTS-ORDER-W1) ───────────────
 * Two passes are wrong in BOTH orders, and each order fails silently by eating real code:
 *
 *   block-first (what shipped):  `// route table for /api/thing/*`
 *                                `wiredCall();`
 *                                `/* an ordinary block comment *␘/`
 *     The `/*` inside the LINE comment opens a block that runs to the next `*␘/`, swallowing
 *     everything between. Measured on src/index.ts at d177425b: 77,158 characters of real code
 *     across 1,776 lines blanked, against a parser-derived ground truth.
 *
 *   line-first (the tempting fix):  `/* a // b *␘/ c();`
 *     The `//` INSIDE the block comment matches the line pattern and blanks the rest of the
 *     line — including the block's own terminator and `c()`. Swapping the passes therefore
 *     trades one silent over-strip for another.
 *
 * A single scan has neither failure, because a delimiter found inside an already-open comment is
 * just text. Offset-preserving: only non-whitespace comment characters become spaces, so every
 * newline, line length and column offset survives — callers grep with -n.
 */
function scanSlashLike(text, lineTok) {
  const out = text.split('');
  const n = text.length;
  const blankTo = (from, to) => { for (let i = from; i < to; i++) if (!/\s/.test(out[i])) out[i] = ' '; };
  let i = 0;
  while (i < n) {
    if (text.startsWith(lineTok, i) && lineOpensHere(text, i, lineTok)) {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      blankTo(i, j);
      i = j;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blankTo(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** The guards the two-pass regexes carried, preserved verbatim in meaning. */
function lineOpensHere(text, i, lineTok) {
  const prev = i === 0 ? '' : text[i - 1];
  // `//` — never after a colon, so `https://…` survives. Same rule the old /(^|[^:])\/\// carried.
  if (lineTok === '//') return prev !== ':';
  // `--` — only at line start or after whitespace, so `a--b` survives.
  return prev === '' || prev === '\n' || /\s/.test(prev);
}

// Diff-structure lines. `+++ b/<path>` is the one that matters: it begins with '+', so a gate
// anchoring patterns on ^\+ matches the FILENAME. Measured 2026-08-12: staging a file named
// `src/guards/setInterval-guard.ts` whose only added line was `export const y = 2;` blocked the
// commit. Excluded from matching entirely rather than stripped.
const DIFF_META = /^(diff --git |index |--- |\+\+\+ |@@ |new file mode |deleted file mode |old mode |new mode |similarity index |rename |Binary files |\\ No newline)/;

/**
 * Strip comments from a unified diff, per-hunk, in the language of the file each hunk belongs to.
 *
 * Contract:
 *  · the +/-/space prefix COLUMN is never altered — patterns anchor on it;
 *  · only `+` and context lines are stripped;
 *  · `-` lines are left untouched, because two of this gate's patterns deliberately match `^[+-]`;
 *  · diff metadata lines are blanked so they cannot match at all;
 *  · line COUNT is preserved, so `grep -n` offsets still point at the real diff line.
 */
export function stripCommentsFromDiff(diffText) {
  let current = '';
  return String(diffText ?? '')
    .split('\n')
    .map((line) => {
      const header = /^\+\+\+ b\/(.*)$/.exec(line);
      if (header) current = header[1];
      if (DIFF_META.test(line)) return blank(line);
      if (line.startsWith('-')) return line;
      if (line.startsWith('+') || line.startsWith(' ')) {
        return line[0] + stripComments(line.slice(1), current);
      }
      return line;
    })
    .join('\n');
}

/**
 * Anti-blind-spot guard, ported from check-webhook-idempotency.mjs:94.
 *
 * "Strip more aggressively" silently becomes "the gate stops working", and THAT direction fails
 * OPEN — an unmapped edge ships and nothing says so. So assert the stripper did not remove a line
 * the caller needed: a real call on a code line must still be there afterwards.
 */
export function strippingLostRealCalls(rawDiff, needle = /^\+.*setInterval\s*\(/m) {
  const stripped = stripCommentsFromDiff(rawDiff);
  const hadIt = rawDiff.split('\n').some((l) => needle.test(l) && !DIFF_META.test(l));
  const stillHasIt = stripped.split('\n').some((l) => needle.test(l));
  return hadIt && !stillHasIt;
}

// ── --self-test: hermetic, vacuity-guarded ──────────────────────────────────────────────────
function selfTest() {
  let checks = 0;
  let fails = 0;
  const ck = (label, got, want) => {
    checks += 1;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.log(`  x ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
      fails += 1;
    }
  };

  // ── language awareness: the SAME text, four languages, four outcomes ──
  ck('ts: // comment blanked', stripComments('const a = 1; // setInterval(x)', 'a.ts').trimEnd(), 'const a = 1;');
  ck('sh: # comment blanked', stripComments('run me   # crontab entry', 'a.sh').trimEnd(), 'run me');
  ck('sql: -- comment blanked', stripComments('SELECT 1;  -- CREATE TABLE t', 'a.sql').trimEnd(), 'SELECT 1;');
  ck('html: <!-- --> blanked', stripComments('<p>x</p><!-- app.get( -->', 'a.html').trimEnd(), '<p>x</p>');
  ck('json: passthrough (no comment syntax to guess at)',
    stripComments('{"a": "// not a comment"}', 'a.json'), '{"a": "// not a comment"}');
  // The measured YAML bug the language dispatch exists for: a JS block regex over YAML eats run:.
  ck('yaml: a glob is NOT a block comment',
    stripComments('paths: ops/scripts/**\nrun: npm test', 'deploy.yml'), 'paths: ops/scripts/**\nrun: npm test');
  ck('ts: https:// survives', stripComments('const u = "https://x.dev";', 'a.ts'), 'const u = "https://x.dev";');

  // ── OPS-STRIP-COMMENTS-ORDER-W1: whichever delimiter OPENS FIRST wins ──
  // Two regex passes are wrong in BOTH orders and each fails SILENTLY by eating real code, so
  // both directions are asserted. A lock that only checks the direction you just fixed is how
  // the second ordering ships as the fix for the first.
  ck('a "/*" inside a LINE comment does NOT open a block (block-first was the shipped defect)',
    stripComments('// routes /api/thing/*\nwiredCall();\n/* real */', 'a.ts').includes('wiredCall'), true);
  ck('a "//" inside a BLOCK comment does NOT eat the line (line-first would be the wrong fix)',
    stripComments('/* a // b */ keptCall();', 'a.ts').includes('keptCall'), true);
  ck('an ordinary block comment is still blanked',
    stripComments('/* darkSymbol */ keptCall();', 'a.ts').includes('darkSymbol'), false);
  ck('an unterminated block comment consumes to EOF, not silently nothing',
    stripComments('/* open\neaten();', 'a.ts').includes('eaten'), false);
  ck('offset preservation survives the scan', stripComments('// x\nconst a = 1;', 'a.ts').length,
    '// x\nconst a = 1;'.length);

  // ── KNOWN GAP, asserted so it is a RECORDED limitation and not a surprise ──
  // The scanner is not string-literal aware, so a comment delimiter inside a string still opens a
  // comment. Measured at d177425b over 1,007 JS/TS files against a TypeScript-parser ground truth:
  // this ordering fix took over-stripping 136,550 -> 85,342 chars (-37.5%) and under-stripping
  // 55 -> 0; every one of the 85,342 residual characters is inside a string, template or regex
  // literal. Closing it needs regex-vs-division grammar context, which is a parser, not a scan.
  // Owner: OPS-STRIP-COMMENTS-LITERALS-W{NEXT}. Both live consumers measured UNAFFECTED today.
  ck('KNOWN GAP: a delimiter inside a string still opens a comment',
    stripComments("const s = '//'; const b = 1;", 'a.ts').includes('const b = 1'), false);

  // ── offset preservation ──
  const src = 'line1 // c\nline2\n/* b\nb */\nline5';
  const out = stripComments(src, 'a.ts');
  ck('offset: line count preserved', out.split('\n').length, src.split('\n').length);
  ck('offset: every line length preserved',
    out.split('\n').map((l) => l.length), src.split('\n').map((l) => l.length));
  ck('offset: non-comment content untouched', out.split('\n')[4], 'line5');

  // ── diff semantics ──
  const diff = [
    'diff --git a/src/thing.ts b/src/thing.ts',
    '+++ b/src/thing.ts',
    '@@ -1,2 +1,3 @@',
    ' const x = 1;',
    '+// rides the existing loop — adds NO setInterval',
    '-const old = setInterval(f, 1);',
  ].join('\n');
  const sd = stripCommentsFromDiff(diff);
  ck('diff: comment on a + line is blanked', /^\+\s*$/m.test(sd.split('\n')[4]), true);
  ck('diff: the + prefix column survives', sd.split('\n')[4][0], '+');
  ck('diff: - lines are untouched (two patterns match ^[+-])', sd.split('\n')[5], '-const old = setInterval(f, 1);');
  ck('diff: line count preserved', sd.split('\n').length, diff.split('\n').length);
  // The filename false positive, measured live before the fix.
  const named = ['+++ b/src/guards/setInterval-guard.ts', '+export const y = 2;'].join('\n');
  ck('diff: a +++ header cannot match a pattern', /setInterval/.test(stripCommentsFromDiff(named)), false);

  // ── ANTI-BLIND-SPOT: the fail-OPEN direction, which is the dangerous one ──
  const realCall = ['+++ b/src/real.ts', '+export const t = setInterval(f, 1000);'].join('\n');
  ck('a REAL setInterval( on a code line SURVIVES stripping',
    /setInterval\s*\(/.test(stripCommentsFromDiff(realCall)), true);
  ck('strippingLostRealCalls says so when nothing was lost', strippingLostRealCalls(realCall), false);

  // ── vacuity: WE built these fixtures, so an empty corpus is a defect in the TEST ──
  checks += 1;
  if (checks < 18) {
    console.log('  x self-test asserted almost nothing');
    fails += 1;
  }

  if (fails !== 0) {
    console.log(`x strip-comments self-test: ${fails} of ${checks} check(s) FAILED`);
    console.log('STRIP_COMMENTS_VERDICT=FAIL');
    process.exit(1);
  }
  console.log(`✓ strip-comments self-test: ${checks} checks passed (4 languages, offset preservation, diff prefix/meta handling, anti-blind-spot)`);
  console.log('STRIP_COMMENTS_VERDICT=PASS');
  process.exit(0);
}

// ── CLI: `--diff` reads a unified diff on stdin and writes the stripped diff on stdout ──
if (process.argv[1] && process.argv[1].endsWith('strip-comments.mjs')) {
  if (process.argv.includes('--self-test')) selfTest();
  else if (process.argv.includes('--diff')) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { process.stdout.write(stripCommentsFromDiff(buf)); });
  } else {
    console.error('usage: strip-comments.mjs --diff < unified.diff | --self-test');
    process.exit(2);
  }
}
