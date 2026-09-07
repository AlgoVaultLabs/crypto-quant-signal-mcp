#!/usr/bin/env node
/**
 * OPS-VALIDATE-KEY-INDETERMINATE-W1 CH5 L1 — `subscriptions.list({status:'active'})` may only
 * appear where it has been DECLARED correct.
 *
 * ── WHY A GATE AND NOT A THIRD DOCSTRING ──────────────────────────────────────────────────────
 * This defect has now been diagnosed and fixed TWICE, on two different call sites, for the SAME
 * customer class — a card that failed, a subscription that went `past_due`, and a boolean that
 * could only ever learn "active or nothing":
 *
 *   2026-08-25  `resolveCustomerByApiKey`  billing portal + owner email  (cus_UuBrP1otU51OBm)
 *   2026-09-04  `validateApiKey`           bot entitlement + link lifecycle
 *   2026-09-04  `getCustomerByEmail`       API-key recovery by email
 *
 * The first fix wrote an excellent docstring naming the exact taxonomy ("can we email this
 * person? reachability — active-only is WRONG"). Nine days later the function that answers
 * precisely that question was still listing `status:'active'`, because prose addressed to
 * whoever happens to read it is not a control. CLAUDE.md: after the 3rd same-class fix the 4th
 * MUST build a gate making the bug class structurally impossible.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
 * Every `subscriptions.list(...)` narrowed to `status: 'active'` must carry a
 * `STATUS-SOT-EXEMPT: <reason>` comment within the 8 lines above it. The exemption is a
 * DECLARATION, not a suppression: it forces whoever writes one to answer "which of the three
 * questions is this?" in the diff, where a reviewer can see it.
 *
 * Sites that classify a customer route through `classifyCustomerSubscriptions` on a
 * `status: 'all'` list instead, and need no exemption.
 *
 * CONTRACT: exactly one terminal `SUBSCRIPTION_STATUS_SOT_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Callers gate on the TOKEN, never the exit code. Exit 0=PASS, 1=FAIL, 3=INDETERMINATE — 3 being
 * the token-law default for a NEW gate.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const EXEMPT_MARKER = 'STATUS-SOT-EXEMPT:';
/** How far above the call an exemption may sit. Wide enough for a real paragraph, narrow enough
 *  that it cannot be inherited from an unrelated comment further up the file. */
const EXEMPT_LOOKBEHIND = 8;

/**
 * Blank out comment CONTENT while preserving every newline, so line numbers survive.
 *
 * 🛑 NOT OPTIONAL, AND CAUGHT BY THIS GATE'S OWN FIRST LIVE RUN. `resolveCustomerByApiKey`'s
 * docstring QUOTES the defect it fixed — `subscriptions.list({status:'active'})` — as prose. A
 * scanner that reads comments flags the very docstring that documents the correct behaviour, and
 * the "fix" would be to delete the explanation. `tests/unit/indeterminate-auth.test.ts` carries
 * the same helper with the note "twice now a text op has mistaken a comment for code"; this is
 * the third.
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const keepNewlines = (chunk) => chunk.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += keepNewlines(source.slice(i, stop));
      i = stop;
    } else if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += keepNewlines(source.slice(i, stop));
      i = stop;
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

export function listTsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) out.push(p);
  }
  return out.sort();
}

/**
 * Every `subscriptions.list(` call in `source`, with its argument text and 1-based line.
 *
 * Balanced-paren scan rather than a regex over the whole call: the argument object spans lines
 * and contains its own braces, and a `[^)]*` regex silently truncates at the first `)` inside a
 * nested call — which would read `status:'active'` as absent and PASS a real violation.
 */
export function findSubscriptionListCalls(source) {
  const calls = [];
  const needle = 'subscriptions.list(';
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
    let depth = 0;
    let end = -1;
    for (let j = i + needle.length - 1; j < source.length; j++) {
      if (source[j] === '(') depth++;
      else if (source[j] === ')' && --depth === 0) { end = j; break; }
    }
    if (end === -1) continue; // unbalanced — cannot parse; counted as a call with empty args
    calls.push({
      index: i,
      line: source.slice(0, i).split('\n').length,
      args: source.slice(i + needle.length, end),
    });
  }
  return calls;
}

/** `status: 'active'` / `status: "active"`, tolerant of whitespace. */
export function narrowsToActive(args) {
  return /status\s*:\s*['"]active['"]/.test(args);
}

/** Is there an exemption declaration within the lookbehind window above `line` (1-based)? */
export function hasExemption(source, line) {
  const lines = source.split('\n');
  const from = Math.max(0, line - 1 - EXEMPT_LOOKBEHIND);
  return lines.slice(from, line).some((l) => l.includes(EXEMPT_MARKER));
}

/**
 * ── RULE 2: THE WRITE SIDE ────────────────────────────────────────────────────────────────────
 * OPS-SUBSCRIBER-STATUS-SOT-W1. The rule above governs how we ASK Stripe. It was structurally
 * blind to how we WRITE the answer down, and all three defects that wave fixed lived on the
 * write side — including `status: 'active'` sitting four lines from a sibling contract that said
 * in prose "Read from the event's own status, never a literal we invent."
 *
 * Prose addressed to whoever happens to read it is not a control. These are the three shapes:
 *
 *  (a) INVENTED LITERAL — a `status:` property assigned a Stripe status string. The status must
 *      come from the event, or from the ONE named constant that declares itself an inference.
 *  (b) BARE CLOBBER — `status = EXCLUDED.status` in an upsert, which let any completed checkout
 *      rewrite a measured `past_due` to `active` and silence the revenue floor.
 *  (c) UNPROVENANCED UPDATE — a statement that SETs `status` on subscriber_profiles without also
 *      setting `status_updated_at`, i.e. a write that leaves the row unable to order the NEXT one.
 *
 * Each is exemptible by the same declaration marker as rule 1: the point is to force the author
 * to answer for it in the diff, not to forbid it outright.
 */
const STRIPE_STATUS_WORDS = [
  'incomplete_expired', 'incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused',
];
/** `status: 'active'` as an object property. Not `status === 'active'`, which is a READ. */
const INVENTED_STATUS_RE = new RegExp(`\\bstatus\\s*:\\s*['"](${STRIPE_STATUS_WORDS.join('|')})['"]`, 'g');
const BARE_EXCLUDED_STATUS_RE = /\bstatus\s*=\s*EXCLUDED\.status\b/g;

/** Every `UPDATE subscriber_profiles … ;`-ish statement, as a {index,line,text} span. */
export function findProfileUpdates(source) {
  const out = [];
  const needle = 'UPDATE subscriber_profiles';
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
    // The statement ends at the closing backtick of the template literal it lives in, or at the
    // next semicolon — whichever comes first. Either bound contains the whole SET…WHERE clause.
    let end = source.length;
    for (const ch of ['`', ';']) {
      const j = source.indexOf(ch, i);
      if (j !== -1 && j < end) end = j;
    }
    out.push({ index: i, line: source.slice(0, i).split('\n').length, text: source.slice(i, end) });
  }
  return out;
}

export function scanWriteSide(files, read) {
  const violations = [];
  let sites = 0;
  for (const f of files) {
    const src = read(f);
    const codeOnly = stripComments(src);
    for (const m of codeOnly.matchAll(INVENTED_STATUS_RE)) {
      sites++;
      const line = codeOnly.slice(0, m.index).split('\n').length;
      if (hasExemption(src, line)) continue;
      violations.push({ file: f, line, rule: 'invented-literal', detail: m[0] });
    }
    for (const m of codeOnly.matchAll(BARE_EXCLUDED_STATUS_RE)) {
      sites++;
      const line = codeOnly.slice(0, m.index).split('\n').length;
      if (hasExemption(src, line)) continue;
      violations.push({ file: f, line, rule: 'bare-clobber', detail: m[0] });
    }
    for (const u of findProfileUpdates(codeOnly)) {
      if (!/\bstatus\s*=\s*\?/.test(u.text)) continue;
      sites++;
      if (/status_updated_at/.test(u.text)) continue;
      if (hasExemption(src, u.line)) continue;
      violations.push({ file: f, line: u.line, rule: 'unprovenanced-update', detail: 'SET status without status_updated_at' });
    }
  }
  return { sites, violations };
}

export function scan(files, read) {
  const violations = [];
  let calls = 0;
  let exempt = 0;
  for (const f of files) {
    const src = read(f);
    // Calls are found in the STRIPPED source (line numbers preserved); the exemption is looked up
    // in the ORIGINAL, because the marker lives inside a comment by construction.
    const codeOnly = stripComments(src);
    for (const c of findSubscriptionListCalls(codeOnly)) {
      calls++;
      if (!narrowsToActive(c.args)) continue;
      if (hasExemption(src, c.line)) { exempt++; continue; }
      violations.push({ file: f, line: c.line });
    }
  }
  return { calls, exempt, violations };
}

function run() {
  let files;
  try {
    files = listTsFiles(SRC);
  } catch (err) {
    // Input we were HANDED and could not read is INDETERMINATE, always.
    console.error(`[status-sot] cannot read ${SRC}: ${err.message}`);
    console.log('SUBSCRIPTION_STATUS_SOT_VERDICT=INDETERMINATE');
    return 3;
  }

  const r = scan(files, (f) => readFileSync(f, 'utf8'));
  const w = scanWriteSide(files, (f) => readFileSync(f, 'utf8'));

  // VACUITY GUARD, at the site where the corpus is CONSTRUCTED. Zero call sites means the SDK
  // call moved or was renamed — the gate is then verifying nothing while reporting PASS, which is
  // exactly the dark-guard shape this estate has already shipped once.
  if (r.calls === 0) {
    console.error('[status-sot] found ZERO `subscriptions.list(` call sites — the pattern moved; this gate is checking nothing.');
    console.log('SUBSCRIPTION_STATUS_SOT_VERDICT=INDETERMINATE');
    return 3;
  }

  // The write-side corpus has its OWN vacuity guard: the two rules count different things, and a
  // zero here would mean the WRITE patterns moved even while the read patterns are healthy.
  if (w.sites === 0) {
    console.error('[status-sot] found ZERO status WRITE sites — the write patterns moved; rule 2 is checking nothing.');
    console.log('SUBSCRIPTION_STATUS_SOT_VERDICT=INDETERMINATE');
    return 3;
  }

  console.log(`[status-sot] ${r.calls} subscriptions.list() call site(s); ${r.exempt} declared exempt; ${r.violations.length} undeclared.`);
  console.log(`[status-sot] ${w.sites} status WRITE site(s) scanned; ${w.violations.length} undeclared.`);
  for (const v of w.violations) {
    console.error(`  ✖ ${relative(ROOT, v.file)}:${v.line}  [${v.rule}] ${v.detail}`);
    console.error(`     Read the status from the event, or declare why not: // ${EXEMPT_MARKER} <reason>`);
  }
  for (const v of r.violations) {
    console.error(`  ✖ ${relative(ROOT, v.file)}:${v.line}  status:'active' with no ${EXEMPT_MARKER} declaration`);
    console.error("     Either classify via `classifyCustomerSubscriptions` on a status:'all' list,");
    console.error(`     or declare why active-only is right here: // ${EXEMPT_MARKER} <reason>`);
  }
  const total = r.violations.length + w.violations.length;
  console.log(`SUBSCRIPTION_STATUS_SOT_VERDICT=${total === 0 ? 'PASS' : 'FAIL'}`);
  return total === 0 ? 0 : 1;
}

// ── self-test ────────────────────────────────────────────────────────────────
// TWO-WAY BY CONSTRUCTION. A self-test that only proves a clean corpus passes would pass just as
// happily against `scan = () => ({violations: []})`, so every clean case is paired with a dirty
// one that MUST be caught.
function selfTest() {
  const cases = [];
  const t = (name, ok) => cases.push([name, ok]);

  const dirty = `const s = await stripe.subscriptions.list({\n  customer: c.id,\n  status: 'active',\n  limit: 10,\n});`;
  const clean = `const s = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 10 });`;
  const declared = `// STATUS-SOT-EXEMPT: a census of active subscriptions is the question.\n${dirty}`;
  const farAway = `// STATUS-SOT-EXEMPT: too far to count\n${'\n'.repeat(EXEMPT_LOOKBEHIND + 2)}${dirty}`;
  const nested = `const s = await stripe.subscriptions.list({ customer: pick(a, b), status: 'active', limit: 10 });`;

  const one = (src) => scan(['x.ts'], () => src);

  t('an undeclared active-only list is CAUGHT', one(dirty).violations.length === 1);
  t("a status:'all' list is clean", one(clean).violations.length === 0);
  t('a declared exemption passes', one(declared).violations.length === 0);
  t('an exemption too far above does NOT reach the call', one(farAway).violations.length === 1);
  t('a nested call in the args does not truncate the scan', one(nested).violations.length === 1);
  t('double quotes are caught too', one(dirty.replace(/'active'/, '"active"')).violations.length === 1);
  t('a file with no list call contributes no violation', one('const x = 1;').violations.length === 0);
  t('call counting is what the vacuity guard reads', one(dirty).calls === 1);

  // ── RULE 2, the WRITE side. Same two-way discipline: every clean case has a dirty twin. ──
  const w = (src) => scanWriteSide(['x.ts'], () => src);
  const invented = `return { customerId, status: 'active', tier };`;
  const fromEvent = `return { customerId, status: asSubscriptionStatus(event.status), tier };`;
  const namedConst = `return { customerId, status: CHECKOUT_IMPLIED_STATUS, tier };`;
  const bareClobber = 'const q = `INSERT INTO t VALUES (?) ON CONFLICT (c) DO UPDATE SET status = EXCLUDED.status, x = 1`;';
  const guardedClobber = "const q = `… DO UPDATE SET status = CASE WHEN t.status IN ('past_due') THEN t.status ELSE EXCLUDED.status END`;";
  const unprovenanced = 'const q = `UPDATE subscriber_profiles SET tier = ?, status = ? WHERE customer_id = ?`;';
  const provenanced = 'const q = `UPDATE subscriber_profiles SET status = ?, status_updated_at = ? WHERE customer_id = ?`;';

  t('an INVENTED status literal is CAUGHT', w(invented).violations.length === 1);
  t('…and it is named as the invented-literal rule', w(invented).violations[0].rule === 'invented-literal');
  t('a status read FROM THE EVENT is clean', w(fromEvent).violations.length === 0);
  t('a status from the ONE named constant is clean', w(namedConst).violations.length === 0);
  t('a BARE `status = EXCLUDED.status` clobber is CAUGHT', w(bareClobber).violations.length === 1);
  t('…and it is named as the bare-clobber rule', w(bareClobber).violations[0].rule === 'bare-clobber');
  t('a CASE-guarded upsert status is clean', w(guardedClobber).violations.length === 0);
  t('an UPDATE setting status with no provenance is CAUGHT', w(unprovenanced).violations.length === 1);
  t('…and it is named as the unprovenanced-update rule', w(unprovenanced).violations[0].rule === 'unprovenanced-update');
  t('an UPDATE carrying status_updated_at is clean', w(provenanced).violations.length === 0);
  t('a declared exemption clears a write-side violation',
    w(`// ${EXEMPT_MARKER} the census owns this one\n${invented}`).violations.length === 0);
  t('a write-side literal QUOTED IN A COMMENT is not a write',
    w(`// once wrote status: 'active' here\nconst x = 1;`).violations.length === 0);
  t('a status COMPARISON is a read, not a write', w(`if (s.status === 'active') return 1;`).violations.length === 0);
  t('write-site counting is what rule 2 vacuity reads', w(invented).sites === 1);
  t('every Stripe status word is matchable, not just active',
    STRIPE_STATUS_WORDS.every((k) => w(`const o = { status: '${k}' };`).violations.length === 1));

  // THE REGRESSION THIS GATE'S OWN FIRST RUN PRODUCED. Prose describing the defect must not BE
  // the defect — otherwise the only way to green the gate is to delete the documentation.
  const inBlockComment = `/**\n * Once listed subscriptions.list({ status: 'active', limit: 10 }) and threw the record away.\n */\nconst s = 1;`;
  const inLineComment = `// old: stripe.subscriptions.list({ customer: c, status: 'active' })\nconst s = 1;`;
  t('a status-active list QUOTED IN A BLOCK COMMENT is not a call', one(inBlockComment).violations.length === 0);
  t('…nor in a line comment', one(inLineComment).violations.length === 0);
  t('…and neither is counted toward the vacuity denominator', one(inBlockComment).calls === 0);
  t('stripping preserves line numbers', stripComments('/* a\nb */\nx').split('\n').length === 3);
  // The other direction: stripping must not blind the scanner to real code on the same line.
  t('real code after a line comment is still scanned',
    one(`// note\nstripe.subscriptions.list({ status: 'active' });`).violations.length === 1);

  // Vacuity guard at the CONSTRUCTION site: in --self-test WE build the corpus, so an empty one
  // is a broken test, not a clean repo.
  if (cases.length === 0) {
    console.error('[status-sot] self-test built ZERO cases');
    console.log('SUBSCRIPTION_STATUS_SOT_VERDICT=INDETERMINATE');
    return 3;
  }

  let failed = 0;
  for (const [name, ok] of cases) {
    console.log(`  ${ok ? '✓' : '✖'} ${name}`);
    if (!ok) failed++;
  }
  console.log(`[status-sot] self-test: ${cases.length - failed}/${cases.length} passed.`);
  console.log(`SUBSCRIPTION_STATUS_SOT_VERDICT=${failed === 0 ? 'PASS' : 'FAIL'}`);
  return failed === 0 ? 0 : 1;
}

// ── entrypoint guard ─────────────────────────────────────────────────────────
// 🛑 REQUIRED, and caught by CH5 L2's own first run. This module is IMPORTED by
// `check-entitlement-state-collapse.mjs` for its comment-stripping helper, and a top-level
// `process.exit(...)` runs the whole gate — and exits the importing process — at import time.
// L2 printed L1's verdict and stopped. A shared helper must not be an entrypoint side effect.
const isMain = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();
if (isMain) process.exit(process.argv.includes('--self-test') ? selfTest() : run());
