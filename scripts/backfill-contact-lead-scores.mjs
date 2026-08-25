#!/usr/bin/env node
/**
 * One-shot backfill of `contact_leads.spam_score` / `spam_reasons` / `quarantined_at`
 * — CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH3.
 *
 * WHY THIS IS COMMITTED RATHER THAN RUN AS AN AD-HOC SNIPPET. It is the only thing that has ever
 * written a judgement onto historical rows of this table. A one-shot that touches production data
 * and then evaporates leaves the data unexplainable: six months from now `spam_reasons` on row 42
 * is either self-evident or it is a mystery, and the difference is whether the code that wrote it
 * can still be read. It is deliberately NOT wired into any schedule, gate or entry point.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT IMPORTS THE SHIPPED SCORER. `scoreLead` from dist/lib/contact-spam.js is the SAME function
 * the live request path calls — never a SQL re-implementation of the rule table. A second
 * derivation of "is this spam" would drift from the first, and then the historical record and the
 * live record would disagree about the same rows while both looking authoritative.
 *
 * THE LOOKBACK IS EVALUATED AS OF EACH ROW'S OWN `created_at`, NOT AS OF NOW. `identity-rotation`
 * and `ip-velocity` count what was visible in the 24h BEFORE a submission. Scoring a 2026-08-10
 * row against 2026-08-25 traffic would answer a different question under the same name, and the
 * answer would get more damning every day the table grew.
 *
 * IT NEVER DELETES AND NEVER REJECTS — `UPDATE` only, and only of the three quarantine columns.
 * Data Integrity LAW: these rows are the only forensic record of the 2026-08 campaign.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Usage (inside the app container, where dist/ and node_modules/ both resolve):
 *   node scripts/backfill-contact-lead-scores.mjs              # DRY RUN — prints the diff, writes nothing
 *   node scripts/backfill-contact-lead-scores.mjs --apply      # writes
 *
 * Dry run is the DEFAULT and `--apply` is explicit, because the inverse ordering is how a
 * one-shot becomes an accident.
 */
import pg from 'pg';
import { scoreLead, serializeReasons, LOOKBACK_HOURS, QUARANTINE_THRESHOLD } from '../dist/lib/contact-spam.js';

const APPLY = process.argv.includes('--apply');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function fmt(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

const rows = (await pool.query(
  `SELECT id, created_at, name, email, company, monthly_volume, message, src, ip_hash,
          spam_score, spam_reasons, quarantined_at
     FROM contact_leads ORDER BY id`,
)).rows;

const before = rows.length;
console.log(`[backfill] ${before} rows | threshold ${QUARANTINE_THRESHOLD} | lookback ${LOOKBACK_HOURS}h | mode ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log('[backfill] id | created (UTC) | name | current -> proposed | reasons | verdict');

let willMark = 0, unchanged = 0, alreadyScored = 0;
const plan = [];

for (const r of rows) {
  // As-of-row lookback, computed over the SAME table in plain JS so the window is visibly the
  // row's own — no SQL interval arithmetic to get subtly wrong per dialect.
  const at = new Date(r.created_at).getTime();
  const from = at - LOOKBACK_HOURS * 3600_000;
  const inWindow = rows.filter((p) => {
    const t = new Date(p.created_at).getTime();
    return t <= at && t > from;
  });
  const lc = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const identity = inWindow.filter((p) => lc(p.name) === lc(r.name) && lc(p.company) === lc(r.company));
  const lookback = {
    distinctEmailsForIdentity: new Set(identity.map((p) => lc(p.email))).size,
    leadsFromIpHash: r.ip_hash ? inWindow.filter((p) => p.ip_hash === r.ip_hash).length : 0,
  };

  const v = scoreLead(
    { name: r.name, company: r.company, monthlyVolume: r.monthly_volume, message: r.message, src: r.src },
    lookback,
  );
  const reasons = serializeReasons(v.reasons);

  if (r.quarantined_at !== null || r.spam_score > 0) { alreadyScored += 1; continue; }
  if (v.score === 0) { unchanged += 1; continue; }

  willMark += 1;
  plan.push({ id: r.id, score: v.score, reasons, quarantined: v.quarantined });
  console.log(
    `[backfill] ${String(r.id).padStart(3)} | ${fmt(r.created_at)} | ${String(r.name).slice(0, 18).padEnd(18)} | `
    + `${String(r.spam_score).padStart(3)} -> ${String(v.score).padStart(3)} | ${reasons} | ${v.quarantined ? 'QUARANTINE' : 'keep'}`,
  );
}

console.log(`[backfill] summary: ${before} rows | ${willMark} to mark | ${unchanged} score 0 (untouched) | ${alreadyScored} already scored by the live path`);
console.log(`[backfill] of the ${willMark} to mark, ${plan.filter((p) => p.quarantined).length} reach the threshold`);

if (!APPLY) {
  console.log('[backfill] DRY RUN — nothing written. Re-run with --apply.');
  await pool.end();
  process.exit(0);
}

for (const p of plan) {
  await pool.query(
    p.quarantined
      ? 'UPDATE contact_leads SET spam_score = $1, spam_reasons = $2, quarantined_at = NOW() WHERE id = $3'
      : 'UPDATE contact_leads SET spam_score = $1, spam_reasons = $2 WHERE id = $3',
    [p.score, p.reasons, p.id],
  );
}

const after = (await pool.query('SELECT count(*)::int AS n FROM contact_leads')).rows[0].n;
console.log(`[backfill] APPLIED ${plan.length} updates. Row count ${before} -> ${after}` + (before === after ? ' (IDENTICAL — nothing deleted)' : ' ⚠️ ROW COUNT CHANGED'));
if (before !== after) process.exit(1);
await pool.end();
